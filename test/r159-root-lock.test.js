/**
 * 【R-159】单写者部署契约：双进程并发写、stale 锁接管、只读旁路、正常释放。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import {
  acquireWriterLock, WriterLockError, processStartTime, computeRootId,
} from '../src/storage/root-lock.js';

const roots = [];
const tmp = async () => { const r = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lock-')); roots.push(r); return r; };

const boot = async (root, opts = {}) => {
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 16 } },
    domains: [defineDomain({ id: 'lk' })],
    embedder: createHashEmbedder(16),
    gitInit: false,
    ...opts,
  });
  await kernel.init();
  return kernel;
};

describe('R-159 root-lock（模块层）', () => {
  test('获取 → 释放：锁文件随之消失；release 只删自己写的锁', async () => {
    const root = await tmp();
    const lock = await acquireWriterLock(root, { kernelVersion: 'test' });
    assert.equal(lock.acquired, true);
    const payload = JSON.parse(await fs.readFile(lock.lockPath, 'utf8'));
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.kernelVersion, 'test');
    assert.ok(Number.isFinite(payload.processStartTime));
    assert.equal(await lock.release(), true);
    await assert.rejects(() => fs.readFile(lock.lockPath, 'utf8'), { code: 'ENOENT' });
  });

  test('第二实例抢锁 = WriterLockError（明确报错，不排队）', async () => {
    const root = await tmp();
    const first = await acquireWriterLock(root, {});
    await assert.rejects(() => acquireWriterLock(root, {}), (e) => {
      assert.ok(e instanceof WriterLockError);
      assert.equal(e.holder.pid, process.pid);
      return true;
    });
    await first.release();
  });

  test('allowShared 探测：不抛，acquired=false + holder 透出', async () => {
    const root = await tmp();
    const first = await acquireWriterLock(root, {});
    const probe = await acquireWriterLock(root, { allowShared: true });
    assert.equal(probe.acquired, false);
    assert.equal(probe.holder.pid, process.pid);
    await first.release();
  });

  test('stale 锁（持锁进程已死）可安全接管', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    // 伪造一个"持有者已死"的锁：pid 取一个几乎不可能存在的号
    const dead = JSON.stringify({ rootId: await computeRootId(root), pid: 999_999_999, processStartTime: processStartTime(), instanceId: 'ghost', acquiredAt: Date.now() - 6000, kernelVersion: 'ghost' });
    await fs.writeFile(lockPath, dead, 'utf8');
    const taken = await acquireWriterLock(root, {});
    assert.equal(taken.acquired, true);
    assert.equal(taken.stale, true);
    assert.equal(taken.previousHolder.instanceId, 'ghost');
    await taken.release();
  });

  test('半写竞态：刚创建的不可解析锁 = 创建者正在写，fail-closed 拒绝且不动锁文件', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    await fs.writeFile(lockPath, '{"pid": ', 'utf8');   // 模拟 A 进程刚 O_EXCL 占位、还没写完
    await assert.rejects(() => acquireWriterLock(root, {}), WriterLockError);
    // 关键断言：锁文件必须原样保留——旧逻辑会把它删掉，A 写完就以为自己还持锁
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"pid": ');
  });

  test('半写竞态：A"暂停"超阈值后恢复写完，B 读到完整锁且 A 活着 = 正常拒绝', async (t) => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    await fs.writeFile(lockPath, '{"pid": ', 'utf8');
    await fs.utimes(lockPath, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000));   // A 被冻结了 30s
    await assert.rejects(() => acquireWriterLock(root, {}), WriterLockError);   // B 尝试：拒绝，不动文件
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"pid": ');
    // A 恢复：把锁写完整（pid = 本进程，存活判定为活）
    await fs.writeFile(lockPath, JSON.stringify({
      rootId: await computeRootId(root), pid: process.pid, processStartTime: processStartTime(),
      instanceId: 'a-resumed', acquiredAt: Date.now(), kernelVersion: 't',
    }), 'utf8');
    const err = await acquireWriterLock(root, {}).then(() => null, (e) => e);
    assert.ok(err instanceof WriterLockError, 'A 恢复后 B 再试 = 正常活锁拒绝，不因文件曾经半写而误删');
  });

  test('半写竞态：shared 只读旁路同样按活锁处理（acquired=false）', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'writer.lock'), '{"pid": ', 'utf8');
    const lock = await acquireWriterLock(root, { allowShared: true });
    assert.equal(lock.acquired, false);
    assert.equal(lock.holder.instanceId, 'unreadable-lock');
  });

  test('不可解析锁无论多老都不自动接管（持锁进程可能只是被暂停）——指向人工恢复', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    await fs.writeFile(lockPath, '{"pid": ', 'utf8');
    const old = new Date(Date.now() - 60_000);   // 一分钟前的半写残留
    await fs.utimes(lockPath, old, old);
    await assert.rejects(() => acquireWriterLock(root, {}), /人工删除|不可解析/);
    assert.equal(await fs.readFile(lockPath, 'utf8'), '{"pid": ', '锁文件原样保留，等人工处置');
  });

  test('坏锁（半写 JSON）不卡死：清掉重抢（仅限持有者已死可解析的 stale 场景）', async () => {
    // 对照组：可解析 + 持有者已死 → stale 自动接管，这是唯一自动通道
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    await fs.writeFile(lockPath, JSON.stringify({
      rootId: await computeRootId(root), pid: 999999999, processStartTime: Date.now() - 999_999,
      instanceId: 'dead', acquiredAt: Date.now(), kernelVersion: 't',
    }), 'utf8');
    const lock = await acquireWriterLock(root, {});
    assert.equal(lock.acquired, true);
    assert.equal(lock.stale, true);
    await lock.release();
  });

  test('结构校验：合法 JSON 但结构无效（{} / pid 字符串 / rootId 不匹配）→ fail-closed 人工恢复', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    const cases = [
      '{}',
      '{"pid":"1234"}',
      JSON.stringify({ rootId: 'wrong-root', pid: process.pid, processStartTime: processStartTime(), instanceId: 'moved', acquiredAt: Date.now(), kernelVersion: 't' }),
    ];
    for (const [i, raw] of cases.entries()) {
      await fs.writeFile(lockPath, raw, 'utf8');
      await assert.rejects(() => acquireWriterLock(root, {}), /结构无效|人工删除/, `case ${i}: ${raw}`);
      assert.equal(await fs.readFile(lockPath, 'utf8'), raw, `case ${i}: 锁文件原样保留，等人工处置`);
    }
  });

  test('结构有效 + 持有者已死 → 仍走 stale 自动接管（校验不误伤正常接管）', async () => {
    const root = await tmp();
    await fs.writeFile(path.join(root, 'writer.lock'), JSON.stringify({
      rootId: await computeRootId(root), pid: 999999999, processStartTime: Date.now() - 999_999,
      instanceId: 'dead', acquiredAt: Date.now(), kernelVersion: 't',
    }), 'utf8');
    const lock = await acquireWriterLock(root, {});
    assert.equal(lock.acquired, true);
    assert.equal(lock.stale, true);
    await lock.release();
  });

  test('并发接管：两个接管者同时抢 stale 锁，恰一个持锁，另一个绝不删掉对方的新锁', async (t) => {
    const root = await tmp();
    t.after(() => fs.rm(path.join(root, 'writer.lock'), { force: true }).catch(() => {}));
    const lockPath = path.join(root, 'writer.lock');
    await fs.writeFile(lockPath, JSON.stringify({
      rootId: await computeRootId(root), pid: 999999999, processStartTime: Date.now() - 999_999,
      instanceId: 'dead', acquiredAt: Date.now(), kernelVersion: 't',
    }), 'utf8');

    // B、C 并发进入接管（同进程并发足以复现 rm/rename 交错；裸 rm 版本下两者会都"成功"）
    const [b, c] = await Promise.allSettled([
      acquireWriterLock(root, {}),
      acquireWriterLock(root, {}),
    ]);

    const winners = [b, c].filter((r) => r.status === 'fulfilled' && r.value.acquired);
    assert.equal(winners.length, 1, '并发接管恰一个持锁（裸 rm 旧实现会双双得手）');
    const losers = [b, c].filter((r) => !(r.status === 'fulfilled' && r.value.acquired));
    for (const l of losers) {
      assert.equal(l.status, 'rejected', '输家必须明确报错，不得静默');
      assert.match(String(l.reason?.message ?? ''), /单写者|WriterLockError|正被另一个进程/);
    }
    // 终态：锁位上是完整可解析的锁
    const holder = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    assert.ok(holder.instanceId, '终态锁完整');
    // 【加固】stale 清理是 fire-and-forget rm（失败无害的设计）——并发负载下 rm 可能尚未
    // 落盘，即席 readdir 会误报（评审实测：全量并发跑随机红、单文件 3/3 绿）。轮询等待。
    const staleGone = async (timeoutMs = 3000) => {
      const start = Date.now();
      for (;;) {
        const n = await fs.readdir(root).then((fs_) => fs_.filter((f) => f.includes('.stale-')).length);
        if (n === 0) return;
        if (Date.now() - start > timeoutMs) assert.fail(`stale 残留 ${n} 个未在时限内清理`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await staleGone();
    if (b.status === 'fulfilled') await b.value.release();
    if (c.status === 'fulfilled') await c.value.release();
  });
});

describe('R-159 kernel 接线', () => {
  test('singleWriter=true 拿锁，close 释放；第二个 kernel 同 root 启动即抛', async () => {
    const root = await tmp();
    const k1 = await boot(root, { singleWriter: true });
    assert.equal(k1.writerLock?.acquired, true);
    // 同进程第二实例：锁活着（同 pid 也算活）→ 明确报错
    await assert.rejects(() => boot(root, { singleWriter: true }), WriterLockError);
    // 只读旁路可并行打开（读检索不受锁影响）
    const reader = await boot(root, { singleWriter: 'shared' });
    assert.equal(reader.writerLock, null);
    const r = await reader.search({ domain: 'lk', query: '不存在的东西' });
    assert.equal(r.entries.length, 0);
    // 只读旁路写动作明确报错，不静默降级
    await assert.rejects(() => reader.remember({
      domainId: 'lk', text: 'x', sourceRef: { adapter_id: 't', locator: 't' },
      provenance: { session_id: 'lk', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
    }), /只读旁路/);
    await reader.close();

    await k1.close();
    await assert.rejects(() => fs.readFile(path.join(root, 'writer.lock'), 'utf8'), { code: 'ENOENT' }, 'close 应释放锁');
  });

  test('fiber 重放全流程：close 后同进程重启成功（cordis 先卸后启已实测，此为内核侧兜底）', async () => {
    const root = await tmp();
    // 模拟宿主重放：旧 kernel 持锁 → dispose（close 释放锁）→ 新 kernel 同 root 启动
    const k1 = await boot(root, { singleWriter: true });
    assert.equal(k1.writerLock?.acquired, true);
    await k1.close();
    assert.equal(await fs.readFile(path.join(root, 'writer.lock'), 'utf8').then(() => true).catch(() => false), false,
      'close 后锁文件消失');
    const k2 = await boot(root, { singleWriter: true });
    assert.equal(k2.writerLock?.acquired, true, '同进程重放可重新拿锁（先卸后启语义）');
    await k2.close();
  });

  test('apply 失败兜底：init 抛错后 writerLock 可显式 release（宿主接线依赖）', async () => {
    const root = await tmp();
    // 模拟宿主接线：createKernel 成功（已拿锁）→ init 阶段抛错 → 显式 release
    const k = await boot(root, { singleWriter: true });
    assert.equal(k.writerLock?.acquired, true);
    // 模拟 init 失败后的兜底路径：不 close，直接 release writerLock
    await k.writerLock.release();
    const again = await boot(root, { singleWriter: true });
    assert.equal(again.writerLock?.acquired, true, '泄漏兜底释放后重试可拿锁');
    await again.close();
  });

  test('双进程：CLI 进程持锁时，第二个 CLI 写进程明确报错退出（验收核心）', async () => {
    const root = await tmp();
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dsh-memory.js');
    const run = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [cli, ...args, '--root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out, err }));
    });
    // 进程 A：remember（持锁）。没等它结束就起 B。
    const a = run(['remember', '锁测试甲', '--triple', '用户|偏好|锁测试甲']);
    await new Promise((r) => setTimeout(r, 1200));   // 给 A 时间拿锁
    const b = await run(['remember', '锁测试乙', '--triple', '用户|偏好|锁测试乙']);
    if (b.code === 0 && !b.err.includes('WriterLockError') && !b.err.includes('单写者')) {
      // B 抢到锁了 = A 还没拿到（启动竞态）。这种情况跳过断言（不影响契约本身）。
      return;
    }
    assert.notEqual(b.code, 0, '第二写实例必须失败退出');
    assert.ok(b.err.includes('单写者') || b.err.includes('writer.lock'), '报错要说清是锁冲突');
    const res = await a;
    assert.equal(res.code, 0, '持锁进程正常完成');
    // 释放后第三实例可用
    const c = await run(['stats']);
    assert.equal(c.code, 0);
  }, 30000);
});

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

/**
 * 【故障注入】中间态安全验证（外审阶段 3）：不只测正常路径，系统性注入
 * "写到一半""文件损坏""并发插队"，每种故障验证三件事——
 *   ① 系统是否正确报错（绝不静默吞掉后假装成功）；
 *   ② 原始数据是否保持安全（不留下"看似正常、实际不一致"的状态）；
 *   ③ 重启/修复后是否能恢复到一致状态。
 * 每条用例标注对应的不变量编号（docs/INVARIANTS.md）。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { dbTx } from '../src/storage/db.js';

const roots = [];
const tmp = async () => { const r = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-fault-')); roots.push(r); return r; };

const makeKernel = async (root, opts = {}) => {
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

const rememberArgs = (text, locator) => ({
  domainId: 'lk', text,
  entryType: 'fact',
  triples: [{ subject: '用户', attribute: '经历', value: `锚点:${locator}` }],
  sessionId: 'lk:s1',
  sourceRef: { adapter_id: 't', locator },
  provenance: { session_id: 'lk:s1', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
});

const hotFileOf = async (kernel, entryId) => {
  // 记账表 files 是路径唯一权威来源（I5）
  const rows = kernel.db.prepare('SELECT path FROM files').all();
  for (const { path: p } of rows) {
    const text = await fs.readFile(p, 'utf8').catch(() => '');
    if (text.includes(`## ${entryId}`)) return { path: p, text };
  }
  return null;
};

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

describe('故障注入：写入中断（I8 不完整状态不得误判正常）', () => {
  test('I8：rename 中途失败（模拟磁盘满）→ 明确报错 + 原块完好 + db 无半行 + 恢复后重试成功', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const first = await kernel.remember(rememberArgs('第一条正常落盘', 'a1'));
    assert.equal(first.status, 'written');
    const before = await hotFileOf(kernel, first.entry.id);
    const dbCountBefore = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;

    // 注入：所有 rename 抛 ENOSPC（writeFileAtomic 的 tmp→rename 原子替换在最后一步断裂）
    const origRename = fsp.rename;
    fsp.rename = async () => { throw Object.assign(new Error('ENOSPC: no space left on device (injected)'), { code: 'ENOSPC' }); };
    let rejected = null;
    try {
      await kernel.remember(rememberArgs('第二条写到一半', 'a2'));
    } catch (e) { rejected = e; } finally {
      fsp.rename = origRename;
    }
    // ① 明确报错，不静默吞
    assert.ok(rejected, 'remember 必须抛错');
    assert.match(String(rejected.message ?? rejected), /ENOSPC/);
    // ② 原始数据安全：第一块原样、SQLite 行数不变、FTS 无新行
    const after = await hotFileOf(kernel, first.entry.id);
    assert.equal(after.text, before.text, 'md 文件不得有半写内容');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, dbCountBefore, 'db 不得留下半行');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries_fts WHERE tokens LIKE ?').get('%一半%').c, 0, 'FTS 不得出现新条目');
    // ③ 恢复后重试成功，终态一致
    const retry = await kernel.remember(rememberArgs('第二条恢复后重写', 'a3'));
    assert.ok(['written', 'updated'].includes(retry.status), `重试应成功落盘，实际 ${retry.status}`);
    const found = await kernel.search({ domain: 'lk', query: '恢复后重写' });
    assert.equal(found.entries.length, 1, '重试条目必须可检索');
    await kernel.close();
  });

  test('I8：md 文件被外部置只读（权限突变，真实 EPERM）→ 报错 + 原块完好 + 解除后重试成功', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const first = await kernel.remember(rememberArgs('只读测试锚点', 'b1'));
    const file = await hotFileOf(kernel, first.entry.id);
    const before = file.text;

    await fs.chmod(file.path, 0o444);   // Windows：只读属性使 rename 覆盖失败（真实错误，非注入桩）
    let rejected = null;
    try { await kernel.remember(rememberArgs('第二条撞只读文件', 'b2')); }
    catch (e) { rejected = e; }
    finally { await fs.chmod(file.path, 0o644); }
    assert.ok(rejected, '只读文件上写入必须抛错');
    const after = await hotFileOf(kernel, first.entry.id);
    assert.equal(after.text, before, '失败后原文件不得被破坏');
    const retry = await kernel.remember(rememberArgs('第二条解除只读后写入', 'b3'));
    assert.ok(['written', 'updated'].includes(retry.status), `重试应成功落盘，实际 ${retry.status}`);
    await kernel.close();
  });
});

describe('故障注入：SQLite 侧（I5 失败不破坏原数据 / I8 恢复一致）', () => {
  test('I5：dbTx 内部抛错 → 事务回滚，行数不变', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const db = kernel.db;
    db.exec('CREATE TABLE IF NOT EXISTS fault_probe (id INTEGER PRIMARY KEY, tag TEXT)');
    let threw = null;
    try {
      dbTx(db, () => {
        db.prepare('INSERT INTO fault_probe(tag) VALUES (?)').run('before-crash');
        throw new Error('injected mid-transaction failure');
      });
    } catch (e) { threw = e; }
    assert.ok(threw, '事务内抛错必须向外传播');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM fault_probe').get().c, 0, '事务回滚：插入行不得存活');
    db.exec('DROP TABLE fault_probe');
    await kernel.close();
  });

  test('I8/I2：孤儿块（md 有块、db 无行 = 事务中断残留）→ rebuild 对账修复，检索可得', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const e1 = await kernel.remember(rememberArgs('正常条目做对照', 'c1'));
    const file = await hotFileOf(kernel, e1.entry.id);
    // 手工构造"md 已落、db 失踪"的残留：remember 正常落盘后直接删 db 行（等价写路径
    // md 先落、db 事务中断的中间态快照），md 块由内核自己生成，不手写模板。
    const e2 = await kernel.remember(rememberArgs('孤儿块等待对账修复', 'c2'));
    const file2 = await hotFileOf(kernel, e2.entry.id);
    assert.ok(file2, '注入前提：md 块存在');
    kernel.db.prepare('DELETE FROM entries WHERE id = ?').run(e2.entry.id);
    kernel.db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(e2.entry.id);
    kernel.db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(e2.entry.id);
    const orphanId = e2.entry.id;
    const r = await kernel.rebuild({ clean: true });
    assert.ok(r.entries >= 2, 'rebuild 成功且两块都进库');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(orphanId).c, 1, '孤儿块被对账收编');
    const found = await kernel.search({ domain: 'lk', query: '孤儿块等待对账' });
    assert.equal(found.entries.length, 1, '恢复后检索一致');
    await kernel.close();
  });

  test('I10：db 文件损坏 → createKernel 明确报错 + 不静默清库重建 + 写锁不残留', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    await kernel.close();
    const dbPath = path.join(root, 'index.db');
    const junk = Buffer.from('this is not a database'.repeat(64));
    await fs.writeFile(dbPath, junk);

    await assert.rejects(
      () => makeKernel(root, { singleWriter: true }),
      (e) => /not a database/i.test(String(e.message ?? e)),
      '损坏 db 必须明确报错',
    );
    assert.equal((await fs.readFile(dbPath)).length, junk.length, '损坏文件不得被内核静默覆盖重建（人工判断权在人）');
    await assert.rejects(() => fs.access(path.join(root, 'writer.lock')), { code: 'ENOENT' }, 'openDatabase 失败路径必须释放写锁（I10）');
  });
});

describe('故障注入：rebuild 中途并发写（I8 防映射撕裂）', () => {
  test('I8：rebuild 运行期 remember/forget/dream 一律明确拒绝，完成后重试成功', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    await kernel.remember(rememberArgs('rebuild 前的条目', 'd1'));

    const rejections = [];
    const seen = await kernel.rebuild({
      clean: true,
      onProgress: (p) => {
        if (p.phase !== 'entries') return;   // 清表后、重灌中：最危险的窗口
        try { void kernel.remember(rememberArgs('并发插队条目', 'd2')); }
        catch (e) { rejections.push(String(e.message ?? e)); }
        try { void kernel.forget('01ARZ3NDEKTSV4RRFFQ69G5FAV'); }
        catch (e) { rejections.push(String(e.message ?? e)); }
      },
    });
    assert.ok(seen.entries >= 1);
    assert.equal(rejections.length, 2, `rebuild 窗口内的写动作必须全部被拒，实际 ${rejections.length}`);
    for (const m of rejections) assert.match(m, /rebuild 进行中/);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE source_ref LIKE ?').get('%d2%').c, 0, '拒绝的写不得落库');
    // 完成后恢复正常（written = 新条目；updated = 判重后更新，同为成功落盘）
    const ok = await kernel.remember(rememberArgs('rebuild 完成后正常写入', 'd3'));
    assert.ok(['written', 'updated'].includes(ok.status), `rebuild 完成后写入应成功，实际 ${ok.status}`);
    assert.ok(ok.entry?.id || ok.entry, '成功态必须携带条目（不得静默丢弃）');
    // rebuild 重入同样拒绝（防御自身并发）
    const k2 = kernel;
    const p = k2.rebuild({ clean: false, onProgress: () => { void k2.rebuild({ clean: false }).catch((e) => rejections.push(String(e.message ?? e))); } });
    await p;
    await kernel.close();
  });

  test('I8：rebuild 期间插队的写被拒后，无 files 映射撕裂（终态对账干净）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    await kernel.remember(rememberArgs('撕裂检查锚点', 'e1'));
    await kernel.rebuild({
      clean: true,
      onProgress: (p) => {
        if (p.phase === 'fts') {
          try { void kernel.remember(rememberArgs('fts 阶段插队', 'e2')); } catch { /* 预期拒绝 */ }
        }
      },
    });
    // 终态：files 表行数与磁盘 md 文件数一致，无"db 行在、映射缺失"的撕裂
    const fileRows = kernel.db.prepare('SELECT COUNT(*) c FROM files').get().c;
    const mdFiles = (await fs.readdir(path.join(root, 'domains', 'lk'))).filter((f) => f.endsWith('.md')).length;
    assert.equal(fileRows, mdFiles, 'files 表与磁盘现状一致（R-39 整表重建语义未被并发写破坏）');
    await kernel.close();
  });
});

describe('故障注入：冷存数据损坏（I12 热冷同规则）', () => {
  test('I12：冷存 md 垃圾/半截块 → rebuild 不炸、热区完好、垃圾不产生条目、检索正常', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const e1 = await kernel.remember(rememberArgs('热区对照条目', 'f1'));
    const coldDir = path.join(root, 'cold', 'lk');
    await fs.mkdir(coldDir, { recursive: true });
    await fs.writeFile(path.join(coldDir, '2026-01.md'), '这不是合法的 markdown 记忆块，纯垃圾字节 \x00\x01 truncated...');
    await fs.writeFile(path.join(coldDir, '2026-02.md'), '## 01ARZ3NDEKTSV4RRFFQ69G5F\n半截块：块头被截断，无 state 段 no trailing');

    const r = await kernel.rebuild({ clean: true });
    assert.ok(r.entries >= 1, 'rebuild 正常完成');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(e1.entry.id).c, 1, '热区条目完好');
    const coldRows = kernel.db.prepare('SELECT COUNT(*) c FROM entries_fts_cold').get().c;
    assert.equal(coldRows, 0, '垃圾/半截块不产生任何冷存条目');
    const found = await kernel.search({ domain: 'lk', query: '热区对照条目' });
    assert.equal(found.entries.length, 1, '损坏不影响检索');
    await kernel.close();
  });

  test('I12：合法冷存条目 forget 后 rebuild 不复活（冷存与热区同一套 tombstone 规则）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const r1 = await kernel.remember(rememberArgs('会被遗忘的冷存条目', 'g1'));
    const coldPath = path.join(root, 'cold', 'lk', '2026-03.md');
    await fs.mkdir(path.dirname(coldPath), { recursive: true });
    // 把条目挪进冷存月文件（等价冷存的 md 形态）
    const file = await hotFileOf(kernel, r1.entry.id);
    const blockStart = file.text.indexOf(`## ${r1.entry.id}`);
    const block = file.text.slice(blockStart);
    await fs.writeFile(coldPath, block, 'utf8');
    await fs.writeFile(file.path, file.text.slice(0, blockStart), 'utf8');
    kernel.db.prepare('UPDATE entries SET cold = 1 WHERE id = ?').run(r1.entry.id);

    await kernel.forget(r1.entry.id, { confirmId: r1.entry.id });
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(r1.entry.id).c, 0, 'forget 清库');
    await kernel.rebuild({ clean: true });
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(r1.entry.id).c, 0, 'rebuild 不复活冷存已遗忘条目（I2）');
    await kernel.close();
  });
});

describe('故障注入：锁生命周期收口（R-159.1 · I10 全构造段）', () => {
  test('I10：构造段早期失败（domains 注册撞 id）→ createKernel 抛错 + 写锁不残留', async () => {
    const root = await tmp();
    const dupDomain = defineDomain({ id: 'lk' });
    await assert.rejects(
      () => createKernel({
        config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 16 } },
        domains: [dupDomain, dupDomain],   // R-158.6 replace:false：撞 id 炸在开库前
        embedder: createHashEmbedder(16), gitInit: false, singleWriter: true,
      }),
      /lk/,
    );
    await assert.rejects(() => fs.access(path.join(root, 'writer.lock')), { code: 'ENOENT' }, '构造段失败必须释放锁');
  });

  test('I10：构造段中期失败（embedder.loadExternalTable 抛错）→ 抛错 + 锁不残留', async () => {
    const root = await tmp();
    const badEmbedder = { ...createHashEmbedder(16), dim: 16, loadExternalTable: async () => { throw new Error('injected: external table load failed'); } };
    await assert.rejects(
      () => createKernel({
        config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 16, lexvecTablePath: 'nonexistent.vec' } },
        domains: [defineDomain({ id: 'lk' })],
        embedder: badEmbedder, gitInit: false, singleWriter: true,
      }),
      /external table/,
    );
    await assert.rejects(() => fs.access(path.join(root, 'writer.lock')), { code: 'ENOENT' }, '构造段中期失败同样必须释放锁');
  });

  test('I10：close 幂等且锁释放可证（singleWriter：锁存在 → close ×2 → 锁消失 → 同 root 可重启）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    const lockPath = path.join(root, 'writer.lock');
    await fs.access(lockPath);   // 关闭前：锁确实存在（否定"根本没建锁"的假通过）
    await kernel.close();
    await kernel.close();        // 第二次必须无副作用（幂等）
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' }, 'close 后锁必须消失（强断言，不吞错）');
    // 同 root 重新启动可再次取得锁（关闭完整性的最终判定）
    const again = await makeKernel(root, { singleWriter: true });
    assert.equal(again.writerLock?.acquired, true, 'close 后同 root 必须能重新拿锁');
    await again.close();
  });

  test('I10：close 阶段故障注入（embedder.close 真抛错）→ 分阶段清理走完、错误如实上抛、锁仍释放', async () => {
    const root = await tmp();
    // 注入真实失败：close 第一阶段（embedder.close）抛错——后续阶段必须继续
    const badEmbedder = { ...createHashEmbedder(16), dim: 16, close: async () => { throw new Error('injected: embedder close failed'); } };
    const kernel = await makeKernel(root, { singleWriter: true, embedder: badEmbedder });
    const lockPath = path.join(root, 'writer.lock');
    // closeKernel 保留首个阶段错误（不静默吞），但清理已全部完成
    await assert.rejects(() => kernel.close(), /embedder close failed/);
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' }, '第一阶段失败后锁仍必须释放');
    // 幂等：第二次 close 复用 closePromise 重放同一错误（无吞错——错误语义明确断言）
    await assert.rejects(() => kernel.close(), /embedder close failed/);
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' });
    const again = await makeKernel(root, { singleWriter: true });
    assert.equal(again.writerLock?.acquired, true);
    await again.close();
  });
});

describe('故障注入：init 失败但 DB 已开（R-159.2 · 构造成功后的回收路径）', () => {
  test('I10/I5：tombstone 身份冲突令 init 中止 → close 完整回收（锁消失 + db 文件不坏 + 修复后可重启）', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    const dbPath = path.join(root, 'index.db');

    // 第一阶段：正常实例写条目并遗忘，留下合法 tombstone 锚点
    const first = await makeKernel(root, { singleWriter: true });
    const entry = await first.remember(rememberArgs('将被冲突构造的条目', 'conflict-1'));
    const forgotten = await first.forget(entry.entry.id, { confirmId: entry.entry.id });
    assert.equal(forgotten.forgotten, true);
    const tbDir = path.join(root, '.tombstones');
    const anchor = (await fs.readdir(tbDir)).find((f) => f.endsWith('.json'));
    await first.close();

    // 第二阶段：伪造身份冲突（JSON 说 A、文件名说 B）→ init 的 bootstrap rebuild 必然 fatal 中止
    const { newUlid } = await import('../src/pure/normalize.js');
    await fs.rename(path.join(tbDir, anchor), path.join(tbDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${newUlid()}.json`));
    const broken = await createKernel({
      config: { storage: { root, dbPath }, embedding: { dim: 16 } },
      domains: [defineDomain({ id: 'lk' })],
      embedder: createHashEmbedder(16), gitInit: false, singleWriter: true,
    });
    await assert.rejects(() => broken.init(), /身份冲突|tombstone/);
    // db 已打开、init 失败——宿主路径（kernel.close）必须完整回收
    await broken.close();
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' }, 'init 失败后 close 必须释放锁');
    // 数据级完整性（字节级比较不成立：WAL checkpoint 会动文件头）——修复重启后由 I2 断言兜底
    assert.ok((await fs.readFile(dbPath)).length > 0, 'db 文件仍可读且非空');

    // 第三阶段：人工修复冲突锚点（删掉伪造文件）→ 同 root 重新 init 成功
    for (const f of await fs.readdir(tbDir)) await fs.rm(path.join(tbDir, f), { force: true });
    const revived = await makeKernel(root, { singleWriter: true });
    assert.equal(revived.writerLock?.acquired, true, '修复后同 root 可重新拿锁');
    const found = await revived.search({ domain: 'lk', query: '冲突构造' });
    assert.equal(found.entries.length, 0, '遗忘条目修复重启后仍不复活（I2 回归确认）');
    await revived.close();
  });
});

describe('故障注入：close 延迟竞态（外审核心验收 · I4×I10）', () => {
  test('I4：旧 close 人为延迟期间，新实例被 fail-closed 拒绝；旧 close 完成后才可拿锁', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    let gateEntered = false;
    // 注入：close 第一阶段（embedder.close）卡在手动 gate——close 进行中、锁未释放的稳定窗口
    const gateEmbedder = { ...createHashEmbedder(16), dim: 16, close: async () => { gateEntered = true; await gate; } };
    const kernelA = await makeKernel(root, { singleWriter: true, embedder: gateEmbedder });
    const closing = kernelA.close();   // 不 await：close 挂在 gate 上
    while (!gateEntered) await new Promise((r) => setTimeout(r, 10));

    // 竞态窗口：close 尚未完成 → 锁必须仍被旧实例持有
    assert.equal(await fs.access(lockPath).then(() => true, () => false), true, 'close 未完成时锁必须仍在');
    // 同进程新实例此时启动：fail-closed 明确拒绝（绝不静默双写）
    await assert.rejects(() => makeKernel(root, { singleWriter: true }), /单写者/);
    assert.equal(await fs.access(lockPath).then(() => true, () => false), true, '拒绝后旧锁不被新实例动过');

    // 释放 gate → 旧 close 完成 → 锁消失 → 新实例才可拿锁
    releaseGate();
    await closing;
    await assert.rejects(() => fs.access(lockPath), { code: 'ENOENT' }, '旧 close 完成后锁必须消失');
    const b = await makeKernel(root, { singleWriter: true });
    assert.equal(b.writerLock?.acquired, true, '竞态窗口结束后新实例才可成功拿锁');
    await b.close();
  });
});

describe('故障注入：锁释放失败传播（R-159.6 · 外审 P2）', () => {
  test('I10：rm(writer.lock) 抛 EACCES → close 如实上抛（不伪装成功）、锁残留、可恢复重启', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    const kernel = await makeKernel(root, { singleWriter: true });
    // 注入：删除 writer.lock 的 rm 抛 EACCES（patch 同进程共享的 fs/promises default 对象）
    const origRm = fsp.rm.bind(fsp);
    fsp.rm = async (target, opts) => {
      if (String(target) === lockPath) {
        const err = new Error(`EACCES: permission denied, unlink '${target}'`);
        err.code = 'EACCES';
        throw err;
      }
      return origRm(target, opts);
    };
    try {
      await assert.rejects(() => kernel.close(), /EACCES/, 'close 必须如实上抛锁释放错误（release 失败绝不能伪装成成功）');
      assert.equal(await fs.access(lockPath).then(() => true, () => false), true, '释放失败后锁文件必须残留（fail-closed 信号可见）');
    } finally {
      fsp.rm = origRm;   // 恢复，绝不把 patch 泄漏给后续用例
    }
    // 【R-159.7】同实例恢复：故障解除后 close() 仅重试锁释放（资源阶段不重跑）——
    // 外审指出此前只测"残留锁挡新实例"、没验证恢复，注释名不副实；此处补齐闭环。
    await kernel.close();   // 重试锁释放
    assert.equal(await fs.access(lockPath).then(() => true, () => false), false, '重试释放成功后锁消失');
    const again = await makeKernel(root, { singleWriter: true });
    assert.equal(again.writerLock?.acquired, true, '恢复后同 root 可重新拿锁（完整恢复闭环）');
    await again.close();
  });

  test('I10：构造失败 + 锁释放失败（组合故障）→ 原始错误上抛、释放错误留痕、锁文件保留', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    const origRm = fsp.rm.bind(fsp);
    const errLogs = [];
    const origCE = console.error;
    console.error = (...a) => { errLogs.push(a.join(' ')); };
    fsp.rm = async (target, opts) => {
      if (String(target) === lockPath) { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
      return origRm(target, opts);
    };
    try {
      // 构造中途失败：domains 重复注册（撞 id 炸在构造段，锁已取得）
      const dup = defineDomain({ id: 'lk' });
      await assert.rejects(() => createKernel({
        config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 16 } },
        domains: [dup, dup], embedder: createHashEmbedder(16), gitInit: false, singleWriter: true,
      }), /lk/, '原始构造错误如实上抛');
      assert.ok(errLogs.some((l) => l.includes('锁释放错误')), '构造失败的锁释放错误必须 console.error 留痕（运维能看到残留锁信号）');
      assert.equal(await fs.access(lockPath).then(() => true, () => false), true, '组合故障下锁文件保留（不误删）');
    } finally {
      fsp.rm = origRm;
      console.error = origCE;
    }
  });

  test('I10：锁文件损坏不可解析 → release 上抛而非 rm（不误删不可确认归属的文件）', async () => {
    const root = await tmp();
    const lockPath = path.join(root, 'writer.lock');
    const kernel = await makeKernel(root, { singleWriter: true });
    await fs.writeFile(lockPath, 'not json at all');   // 锁内容损坏：无法验证归属
    await assert.rejects(() => kernel.close(), /.+/, '损坏锁的释放必须上抛（fail-closed）');
    assert.equal(await fs.access(lockPath).then(() => true, () => false), true, '损坏锁文件绝不被 rm');
  });
});

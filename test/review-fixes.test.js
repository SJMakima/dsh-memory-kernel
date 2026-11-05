/**
 * 【人工评审修复回归】v4.31.19 三个真 bug 的钉子：
 *   Bug1 跨月冷存 forget md 残留（dream 用归档月、forget 兜底用记录月）；
 *   Bug2 rebuild 向量清零（parseEntryBlock 无 embedding_pending → 补嵌扫永远扫不到）；
 *   Bug3 remember 缺 sourceRef/provenance 崩 TypeError（改可读参数错误）。
 * 用例名标注对应不变量（docs/INVARIANTS.md）。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { serializeEntryBlock, upsertBlock, removeBlock, readFileSafe, writeFileAtomic } from '../src/storage/md.js';

const roots = [];
const tmp = async () => { const r = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-review-')); roots.push(r); return r; };
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
const exists = async (p) => fs.access(p).then(() => true, () => false);
const samePath = (a, b) => path.resolve(a) === path.resolve(b);

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

describe('评审修复：跨月冷存 forget（I3 遗忘闭环 · Bug1）', () => {
  test('I3：冷块在"归档月"冷文件（≠记录月）→ forget 必须删掉 md 原文', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    const r = await kernel.remember(rememberArgs('跨月冷存的秘密内容', 'cold-x1'));
    const id = r.entry.id;

    // 手工复现 dream step8 的跨月归档：块从热区挪到"归档时刻月"冷文件（比记录晚 100 天，必跨月）
    const hotPath = await kernel.files.locateEntryPath({ id, domain_id: 'lk', recorded_at: r.entry.recorded_at });
    const hotText = await readFileSafe(hotPath);
    const archiveTs = r.entry.recorded_at + 100 * 86400e3;
    const coldPath = kernel.files.coldPathOf('lk', archiveTs);
    await fs.mkdir(path.dirname(coldPath), { recursive: true });
    await writeFileAtomic(coldPath, upsertBlock(await readFileSafe(coldPath), { ...r.entry, cold: true, last_decay_at: archiveTs }));
    await writeFileAtomic(hotPath, removeBlock(hotText, id));
    // db 侧同步冷态（与 dream step8 一致：cold=1、last_decay_at=归档时刻）
    kernel.db.prepare('UPDATE entries SET cold = 1, last_decay_at = ? WHERE id = ?').run(archiveTs, id);

    // forget：修复前兜底只试 recorded_at 月 → not-found，md 原文永留冷文件
    const fr = await kernel.forget(id, { confirmId: id });
    assert.equal(fr.forgotten, true);
    assert.ok(samePath(fr.positions.md, coldPath), 'forget 必须定位到归档月的冷文件');
    assert.equal(await exists(coldPath), false, '冷文件内块已删且文件清空后应被移除');
    await kernel.close();
  });

  test('I3：候选月全部错位（recorded_at/last_decay_at 都不在归档月）→ 整目录兜底扫描仍能删', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    const r = await kernel.remember(rememberArgs('目录兜底扫描的内容', 'cold-x2'));
    const id = r.entry.id;
    const hotPath = await kernel.files.locateEntryPath({ id, domain_id: 'lk', recorded_at: r.entry.recorded_at });
    const hotText = await readFileSafe(hotPath);
    // 冷文件放在与 recorded_at / last_decay_at 都不同的月份（+40 天且再挪 -200 天也不对齐的构造：
    // 直接用未来 800 天，任何字段月份都对不上）
    const archiveTs = r.entry.recorded_at + 800 * 86400e3;
    const coldPath = kernel.files.coldPathOf('lk', archiveTs);
    await fs.mkdir(path.dirname(coldPath), { recursive: true });
    await writeFileAtomic(coldPath, upsertBlock(await readFileSafe(coldPath), { ...r.entry, cold: true, last_decay_at: r.entry.recorded_at }));
    await writeFileAtomic(hotPath, removeBlock(hotText, id));
    kernel.db.prepare('UPDATE entries SET cold = 1, last_decay_at = ? WHERE id = ?').run(r.entry.recorded_at, id);

    const fr = await kernel.forget(id, { confirmId: id });
    assert.equal(fr.forgotten, true);
    assert.ok(samePath(fr.positions.md, coldPath), '目录兜底扫描必须找到归档月的冷块');
    assert.equal(await exists(coldPath), false);
    await kernel.close();
  });
});

describe('评审修复：rebuild 向量 pending（I12/I8 · Bug2）', () => {
  test('I8：模型不可用时 rebuild → 热区 embedding_pending 全部为 1（补嵌扫得到，不再永久降级）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    await kernel.remember(rememberArgs('待重建一', 'vec-r1'));
    await kernel.remember(rememberArgs('待重建二', 'vec-r2'));
    await kernel.close();

    // enableVec:false = 模型不可用场景（修复前：rebuild 后 pending 全 0，向量路永久降级）
    const k2 = await createKernel({
      config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 16 } },
      domains: [defineDomain({ id: 'lk' })], embedder: createHashEmbedder(16),
      gitInit: false, enableVec: false,
    });
    await k2.init();
    const r2 = await k2.rebuild({ clean: true });
    assert.ok(r2.entries >= 2);
    const pending = k2.db.prepare('SELECT COUNT(*) AS c FROM entries WHERE cold = 0 AND embedding_pending = 1').get().c;
    assert.equal(pending, r2.entries, 'vec 不可用时热区必须全部标 pending=1（补嵌扫描可兜底）');
    await k2.close();

    // 模型恢复后重建：成功嵌入的条目 pending 归 0
    const k3 = await makeKernel(root);
    const r3 = await k3.rebuild({ clean: true });
    assert.ok(r3.embedded >= 2, 'vec 可用时 rebuild 应完成嵌入');
    const stillPending = k3.db.prepare('SELECT COUNT(*) AS c FROM entries WHERE cold = 0 AND embedding_pending = 1').get().c;
    assert.equal(stillPending, 0, '成功嵌入后 pending 必须清 0');
    await k3.close();
  });
});

describe('评审修复：remember 参数可读性（I9 · Bug3）', () => {
  test('I9：缺 sourceRef / provenance → 可读参数错误（不是深层 TypeError）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const base = rememberArgs('缺出身', 'no-ref');
    await assert.rejects(
      () => kernel.remember({ ...base, sourceRef: undefined }),
      (e) => e instanceof TypeError === false && /sourceRef/.test(e.message),
      'sourceRef 缺失必须是可读参数错误',
    );
    await assert.rejects(
      () => kernel.remember({ ...base, provenance: undefined }),
      (e) => e instanceof TypeError === false && /provenance/.test(e.message),
      'provenance 缺失必须是可读参数错误',
    );
    await assert.rejects(
      () => kernel.remember({ ...base, sourceRef: 'not-an-object' }),
      /sourceRef/,
    );
    await kernel.close();
  });
});

describe('评审修复：遗忘报告诚实性（I3 · 外审）', () => {
  test('I3：md 块无法确认删除（条目在库但真相源块失踪）→ degraded=true + positions.md 明确标记', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const r = await kernel.remember(rememberArgs('真相源将被人为抹掉', 'ghost-x1'));
    const id = r.entry.id;
    // 注入：md 块被手工抹掉（模拟磁盘异常/手改），db 行还在——forget 必须如实报告而非假装删净
    const hotPath = await kernel.files.locateEntryPath({ id, domain_id: 'lk', recorded_at: r.entry.recorded_at });
    await writeFileAtomic(hotPath, removeBlock(await readFileSafe(hotPath), id));
    const fr = await kernel.forget(id, { confirmId: id });
    assert.equal(fr.forgotten, true);
    assert.equal(fr.degraded, true, 'md 块失踪必须如实标 degraded');
    assert.ok(fr.positions.md === 'not-found' || String(fr.positions.md).startsWith('unverifiable:'), `positions.md 须明确标记，实际 ${fr.positions.md}`);
    await kernel.close();
  });

  test('I3：冷目录 readdir 失败 → positions.md = unverifiable（区分 I/O 异常与确认不存在）', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    const r = await kernel.remember(rememberArgs('冷区不可读场景', 'ghost-x2'));
    const id = r.entry.id;
    const hotPath = await kernel.files.locateEntryPath({ id, domain_id: 'lk', recorded_at: r.entry.recorded_at });
    const hotText = await readFileSafe(hotPath);
    const archiveTs = r.entry.recorded_at + 100 * 86400e3;
    const coldPath = kernel.files.coldPathOf('lk', archiveTs);
    await fs.mkdir(path.dirname(coldPath), { recursive: true });
    await writeFileAtomic(coldPath, upsertBlock(await readFileSafe(coldPath), { ...r.entry, cold: true, last_decay_at: archiveTs }));
    await writeFileAtomic(hotPath, removeBlock(hotText, id));
    // db 侧 last_decay_at 保持记录时刻（≠归档月）——候选月全部错位，逼出 readdir 兜底路径
    kernel.db.prepare('UPDATE entries SET cold = 1, last_decay_at = ? WHERE id = ?').run(r.entry.recorded_at, id);
    // 注入：冷目录 readdir 抛 EACCES（patch 共享 fs/promises）
    const origReaddir = fs.readdir.bind(fs);
    fs.readdir = async (target, opts) => {
      // coldPathOf 产 posix 风格路径——匹配前归一化分隔符（调试实证：'cold\\lk' 匹配不到 'cold/lk'）
      if (String(target).replace(/\\/g, '/').includes('cold/lk')) {
        const e = new Error('EACCES: permission denied, scandir'); e.code = 'EACCES'; throw e;
      }
      return origReaddir(target, opts);
    };
    try {
      const fr = await kernel.forget(id, { confirmId: id });
      assert.equal(fr.forgotten, true);
      assert.equal(fr.degraded, true, 'I/O 无法确认必须 degraded');
      assert.match(String(fr.positions.md), /^unverifiable: .*EACCES/, 'I/O 异常必须标记 unverifiable 而非 not-found');
    } finally {
      fs.readdir = origReaddir;
    }
    await kernel.close();
  });
});

describe('评审修复：remember 字段级校验（I9 · 外审）', () => {
  test('I9：sourceRef 缺 adapter_id/locator、provenance 缺 session_id → 可读错误', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const base = rememberArgs('字段校验', 'field-x1');
    await assert.rejects(() => kernel.remember({ ...base, sourceRef: { adapter_id: '', locator: 'x' } }), /adapter_id/);
    await assert.rejects(() => kernel.remember({ ...base, sourceRef: { adapter_id: 't' } }), /locator/);
    await assert.rejects(() => kernel.remember({ ...base, provenance: { ...base.provenance, session_id: 123 } }), /session_id/);
    // 空字符串 session_id 是合法 fail-closed 出身（identity-trust 契约：无宿主身份写空）
    const noId = await kernel.remember({ ...base, provenance: { ...base.provenance, session_id: '' } });
    assert.ok(['written', 'updated'].includes(noId.status), '空 session_id（无宿主身份裁定）必须照常落库');
    // 合法对象不受影响（换独立内容避开前序写入的判重/更新路径）
    const ok = await kernel.remember({ ...base, text: '字段校验-合法路径', triples: [{ subject: '用户', attribute: '经历', value: '锚点:field-ok' }], sourceRef: { ...base.sourceRef, locator: 'field-ok' } });
    assert.ok(['written', 'updated'].includes(ok.status));
    await kernel.close();
  });
});

describe('评审修复：forget 报告顺序回归（I3 · 外审）', () => {
  test('I3：正常删除 → degraded=false、positions.md 真实路径、无 md-not-removed audit', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root);
    const r = await kernel.remember(rememberArgs('正常遗忘回归内容', 'normal-x1'));
    const fr = await kernel.forget(r.entry.id, { confirmId: r.entry.id });
    assert.equal(fr.forgotten, true);
    assert.equal(fr.degraded, false, '正常删除绝不能标 degraded（外审断言）');
    assert.ok(fr.positions.md && fr.positions.md !== 'not-found' && !String(fr.positions.md).startsWith('unverifiable'),
      `positions.md 应为真实路径，实际 ${fr.positions.md}`);
    await kernel.close();
    const auditLog = await fs.readFile(path.join(root, 'audit', 'forget.log'), 'utf8').catch(() => '');
    assert.ok(!auditLog.includes('md-not-removed'), '正常遗忘不得产生 md-not-removed 审计事件');
  });

  test('I3：冷候选文件读取 EACCES → unverifiable + 清理继续（tombstone 兜底）+ 恢复后幂等', async () => {
    const root = await tmp();
    const kernel = await makeKernel(root, { singleWriter: true });
    const r = await kernel.remember(rememberArgs('冷读失败场景内容', 'coldread-x1'));
    const id = r.entry.id;
    const hotPath = await kernel.files.locateEntryPath({ id, domain_id: 'lk', recorded_at: r.entry.recorded_at });
    const hotText = await readFileSafe(hotPath);
    const archiveTs = r.entry.recorded_at + 100 * 86400e3;
    const coldPath = kernel.files.coldPathOf('lk', archiveTs);
    await fs.mkdir(path.dirname(coldPath), { recursive: true });
    await writeFileAtomic(coldPath, upsertBlock(await readFileSafe(coldPath), { ...r.entry, cold: true, last_decay_at: archiveTs }));
    await writeFileAtomic(hotPath, removeBlock(hotText, id));
    kernel.db.prepare('UPDATE entries SET cold = 1, last_decay_at = ? WHERE id = ?').run(archiveTs, id);
    // 注入：冷区 md 文件 readFile → EACCES（readFileSafe 对 ENOENT 返回空、EACCES 上抛——外审点名的边界）
    const origRead = fs.readFile.bind(fs);
    fs.readFile = async (target, enc) => {
      if (String(target).replace(/\\/g, '/').includes('cold/lk') && String(target).endsWith('.md')) {
        const e = new Error('EACCES: permission denied, read'); e.code = 'EACCES'; throw e;
      }
      return origRead(target, enc);
    };
    try {
      const fr = await kernel.forget(id, { confirmId: id });
      assert.equal(fr.forgotten, true);
      assert.equal(fr.degraded, true, '无法确认 md 删除必须 degraded');
      assert.match(String(fr.positions.md), /^unverifiable: .*EACCES/, '读 I/O 异常必须 unverifiable 而非炸流程/误判不存在');
      assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM entries WHERE id = ?').get(id).c, 0, '读错误不阻断 SQLite 清理（tombstone 已兜底防复活）');
    } finally {
      fs.readFile = origRead;
    }
    // 恢复后幂等：行已删 → forget 返回 not-found（不假装删了，残留 md 由 tombstone+rebuild 收敛）
    const again = await kernel.forget(id, { confirmId: id });
    assert.equal(again.forgotten, false);
    await kernel.close();
  });
});

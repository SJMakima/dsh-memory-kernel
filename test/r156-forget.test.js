/**
 * 【R-156】forget 遗忘闭环：六位置一次清 + tombstone 防复活。
 * 验收核心是"forget 后全量 rebuild 不复活"——对"重建不丢状态"老契约的反向验收。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { rebuildAll } from '../src/core/rebuild.js';
import { newUlid } from '../src/pure/normalize.js';

const roots = [];
const root_of = (kernel) => kernel.cfg.storage.root;

async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-forget-'));
  roots.push(root);
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 32 },
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'fg', dir: path.join(root, 'd') })],
    embedder: createHashEmbedder(32),
    gitInit: false,
  });
  await kernel.init();
  return kernel;
}

async function seed(kernel, text, { cold = false } = {}) {
  const r = await kernel.remember({
    domainId: 'fg',
    text,
    entryType: 'fact',
    triples: [{ subject: '用户', attribute: '偏好', value: text.slice(0, 6) }],
    sessionId: 'fg:s1',
    sourceRef: { adapter_id: 'test', locator: `t:${text}` },
    provenance: { session_id: 'fg:s1', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
  });
  if (cold) {
    kernel.db.prepare('UPDATE entries SET cold = 1 WHERE id = ?').run(r.entry.id);
    kernel.db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(r.entry.id);
    kernel.db.prepare('INSERT INTO entries_fts_cold(tokens, entry_id, domain_id) VALUES (?, ?, ?)')
      .run('coldtest', r.entry.id, 'fg');
  }
  return r.entry;
}

describe('R-156 forget 六位置闭环', () => {
  test('confirmId 不匹配 = 拒绝执行（误删防护）', async () => {
    const kernel = await boot();
    const e = await seed(kernel, '用户喜欢喝拿铁');
    await assert.rejects(
      () => kernel.forget(e.id, { confirmId: 'wrong' }),
      /二次确认/,
    );
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(e.id).c, 1);
    await kernel.close();
  });

  test('正常遗忘：md/SQLite/FTS/向量/links/tombstone 全清', async () => {
    const kernel = await boot();
    const a = await seed(kernel, '用户喜欢喝美式');
    const b = await seed(kernel, '用户喜欢喝摩卡');
    // 连锁边：a -> b（声明边）
    kernel.db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at)
                       VALUES (?, ?, 'support', 'extract', ?)`).run(a.id, b.id, Date.now());

    const r = await kernel.forget(a.id, { confirmId: a.id, reason: 'test' });
    assert.equal(r.forgotten, true);

    // ① md 块没了
    const mdOnDisk = await fs.readdir(path.join(kernel.cfg.storage.root, 'domains', 'fg'))
      .then((fs_) => Promise.all(fs_.filter((f) => f.endsWith('.md')).map((f) => fs.readFile(path.join(kernel.cfg.storage.root, 'domains', 'fg', f), 'utf8'))));
    assert.ok(mdOnDisk.every((t) => !t.includes(`## ${a.id}`)), 'md 块应被删除');
    // ② SQLite + FTS
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(a.id).c, 0);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries_fts WHERE entry_id = ?').get(a.id).c, 0);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries_fts_cold WHERE entry_id = ?').get(a.id).c, 0);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entry_triples WHERE entry_id = ?').get(a.id).c, 0);
    // ③ 向量
    if (kernel.vec.enabled) assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries_vec WHERE entry_id = ?').get(a.id).c, 0);
    // ④ links 双侧
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entry_links WHERE entry_id = ? OR linked_id = ?').get(a.id, a.id).c, 0);
    // ⑥ tombstone 文件 + 幂等集合
    assert.ok(r.tombstone, 'tombstone 应落盘');
    assert.ok((await kernel.tombstonedIds()).has(a.id));
    // audit 留痕
    const forgetLog = await fs.readFile(path.join(kernel.cfg.storage.root, 'audit', 'forget.log'), 'utf8');
    assert.ok(forgetLog.includes('"event":"forgotten"'));
    await kernel.close();
  });

  test('验收核心：forget 后全量 rebuild 不复活（含冷存条目）', async () => {
    const kernel = await boot();
    const hot = await seed(kernel, '用户养了仓鼠');
    const cold = await seed(kernel, '用户去过兰州', { cold: true });

    await kernel.forget(hot.id, { confirmId: hot.id });
    await kernel.forget(cold.id, { confirmId: cold.id });

    // 模拟"旧快照回到 md"：把已删除的块手写回去（备份恢复场景）
    const mdPath = path.join(kernel.cfg.storage.root, 'domains', 'fg', 'resurrect.md');
    await fs.writeFile(mdPath, `## ${hot.id}\ntype: fact\nobserved_at: null\nrecorded_at: ${new Date().toISOString()}\ntopic_tags: []\ntriples: []\nevidence: []\nsource: test / "r"\nstate:\n  persistence: 0.5\n  persistence_init: 0.5\n  last_decay_at: null\n  gamma_multiplier: 1\n  activation_count: 0\n  last_activated_at: null\n  cold: false\n  importance: 0.5\n  trust_prior_logit: 0\n  trust_posterior_logit: 0\n  superseded_by: null\n  supersedes: []\ntext: |\n  用户养了仓鼠\n\n`, 'utf8');

    await kernel.rebuild();
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(hot.id).c, 0, 'tombstone 条目 rebuild 后不得复活');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(cold.id).c, 0);
    assert.ok(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c >= 0);
    await kernel.close();
  });

  test('幂等：重复 forget 同一条不报错、如实返回 forgotten:false', async () => {
    const kernel = await boot();
    const e = await seed(kernel, '用户怕挤地铁');
    await kernel.forget(e.id, { confirmId: e.id });
    const again = await kernel.forget(e.id, { confirmId: e.id });
    assert.equal(again.forgotten, false);
    await kernel.close();
  });

  test('tombstone 写失败 = 直接中止，数据一个不动（旧顺序会先删再报成功）', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '中止语义测试条目');
    // 注入：把 .tombstones 占位成文件 → mkdir recursive 必失败
    await fs.writeFile(path.join(root_of(kernel), '.tombstones'), 'blocked', 'utf8');
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, false, '闸没关上绝不动数据');
    assert.equal(r.error, 'tombstone-failed');
    // 数据完好：SQLite 行还在、md 块还在
    assert.ok(kernel.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entry.id), 'SQLite 行必须还在');
    await kernel.close();
  });

  test('中止后修复注入，重跑 forget 幂等成功（锚点语义的恢复路径）', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '幂等重试测试条目');
    const root = root_of(kernel);
    await fs.writeFile(path.join(root, '.tombstones'), 'blocked', 'utf8');
    const blocked = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(blocked.forgotten, false);

    await fs.rm(path.join(root, '.tombstones'), { force: true });   // 解除注入
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);
    assert.ok(r.tombstone, '重试成功后 tombstone 落盘');
    assert.ok(kernel.lifecycle.tombstonedIds && (await kernel.lifecycle.tombstonedIds()).has(entry.id));
    await kernel.close();
  });

  test('端到端：forget 后 md 块被塞回（模拟备份恢复），rebuild 仍不复活', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '端到端复活测试条目');
    const root = root_of(kernel);
    // 备份真相源 md（模拟旧快照里有这条）
    const mdDir = path.join(root, 'domains', 'fg');
    const mdFile = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'))[0];
    const mdPath = path.join(mdDir, mdFile);
    const snapshot = await fs.readFile(mdPath, 'utf8');
    assert.match(snapshot, /端到端复活测试条目/);

    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);

    // 模拟备份恢复：把旧 md 原样塞回
    await fs.writeFile(mdPath, snapshot, 'utf8');

    const rb = await kernel.lifecycle.rebuild();
    const still = kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(entry.id).c;
    assert.equal(still, 0, 'tombstone 感知下备份恢复不复活');
    assert.ok(rb.tombstoned >= 1, 'rebuild 结果如实报告跳过数');
    await kernel.close();
  });

  test('损坏 tombstone：JSON 烂但文件名完好 → rebuild 按文件名恢复 ID 照常排除 + corrupt 留痕', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '损坏锚点恢复测试条目');
    const root = root_of(kernel);
    const mdDir = path.join(root, 'domains', 'fg');
    const mdFile = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'))[0];
    const mdPath = path.join(mdDir, mdFile);
    const snapshot = await fs.readFile(mdPath, 'utf8');
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);

    // 把 tombstone 内容弄烂（模拟半写/磁盘损坏），文件名保留——entryId 就在名字里
    const tombFile = path.basename(r.tombstone);
    assert.match(tombFile, new RegExp(`${entry.id}\\.json$`), '命名规则必须包含 entryId');
    await fs.writeFile(r.tombstone, '{"entryId": ', 'utf8');

    await fs.writeFile(mdPath, snapshot, 'utf8');   // 备份恢复
    const rb = await kernel.lifecycle.rebuild();
    const still = kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(entry.id).c;
    assert.equal(still, 0, '内容损坏但文件名完好：按文件名恢复 ID，仍不复活');
    assert.ok(Array.isArray(rb.tombstoneCorrupt) && rb.tombstoneCorrupt.some((c) => c.recoveredId === entry.id),
      'corrupt 清单如实记录且标注已恢复的 ID');
    await kernel.close();
  });

  test('四态之三：JSON 与文件名均烂（恢复不出 ID）→ rebuild 中止 fail-closed，不静默放行', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    await fs.mkdir(path.join(root, '.tombstones'), { recursive: true });
    await fs.writeFile(path.join(root, '.tombstones', 'zzz-broken-name.json'), '{"entryId": ', 'utf8');
    // rebuild 必须拒绝：unknown 锚点保护的记忆可能复活，"报警后继续"不够
    await assert.rejects(
      () => kernel.lifecycle.rebuild(),
      /无法恢复条目 ID.*中止|zzz-broken-name\.json/,
    );
    await kernel.close();
  });

  test('四态之四：.tombstones 读取故障（目录位被文件占用 = 非 ENOENT）→ rebuild 中止，SQLite 原数据不被清空', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    const entry = await seed(kernel, '读故障中止测试条目');
    await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    // 注入：删掉真目录，放一个同名文件 → readdir 报 ENOTDIR（权限/I/O 故障同款非 ENOENT 路径）
    await fs.rm(path.join(root, '.tombstones'), { recursive: true, force: true });
    await fs.writeFile(path.join(root, '.tombstones'), 'not-a-dir', 'utf8');
    const before = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    await assert.rejects(() => kernel.lifecycle.rebuild());
    // 关键：rebuild 中止后派生层没被清空——锚点读不到时绝不"当没锚点边清边赌"
    const after = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    assert.equal(after, before, '中止时原数据库完好');
    // 恢复注入后重建正常，tombstone 排除仍然生效
    await fs.rm(path.join(root, '.tombstones'), { force: true });
    await kernel.lifecycle.rebuild();
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(entry.id).c, 0);
    await kernel.close();
  });

  test('tombstone 持久化承诺分级：内容 fsync 硬承诺；目录项 Windows 降级留痕', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '目录项持久化测试条目');
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);
    assert.ok(r.positions.tombstone);
    if (process.platform === 'win32') {
      assert.match(r.positions.tombstoneDirSync ?? '', /^degraded:/, 'Windows 无目录 fsync：如实标注降级');
    } else {
      assert.equal(r.positions.tombstoneDirSync, 'synced');
    }
    await kernel.close();
  });

  test('改名绕过封堵：tombstone 改名 .bak 后 rebuild 必须可靠排除（旧逻辑会静默跳过 → 复活）', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '改名绕过测试条目');
    const root = root_of(kernel);
    const mdDir = path.join(root, 'domains', 'fg');
    const mdFile = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'))[0];
    const mdPath = path.join(mdDir, mdFile);
    const snapshot = await fs.readFile(mdPath, 'utf8');

    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);
    // 模拟攻击/事故：把锚点改名 .bak（扩展名不再是 .json）
    await fs.rename(r.tombstone, `${r.tombstone}.bak`);
    await fs.writeFile(mdPath, snapshot, 'utf8');   // 备份恢复

    const rb = await kernel.lifecycle.rebuild();
    const still = kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(entry.id).c;
    assert.equal(still, 0, '改名 .bak 的锚点仍须认出来（扩展名不参与识别）');
    // 改名不改内容：JSON 仍完好 → 正常解析分支，不该进 corrupt
    assert.ok(!rb.tombstoneCorrupt.some((c) => c.recoveredId === entry.id),
      '内容完好的改名锚点走正常解析，不是 corrupt');
    await kernel.close();
  });

  test('边界：非 json 文件名且恢复不出 ID（broken.bak）→ rebuild 中止 fail-closed', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    await fs.mkdir(path.join(root, '.tombstones'), { recursive: true });
    await fs.writeFile(path.join(root, '.tombstones', 'broken.bak'), 'whatever', 'utf8');
    const before = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    await assert.rejects(() => kernel.lifecycle.rebuild(), /无法恢复条目 ID|broken\.bak/);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, before, '中止时原数据完好');
    await kernel.close();
  });

  test('边界：.tombstones 里的子目录 + 未知文件 → fail-closed（可恢复的排除，恢复不出的中止）', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    const tbDir = path.join(root, '.tombstones');
    await fs.mkdir(path.join(tbDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${newUlid()}`), { recursive: true });   // 子目录但名字可恢复
    await fs.writeFile(path.join(tbDir, 'unknown-thing'), 'x', 'utf8');   // 普通文件但名字烂 → 中止
    const before = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    await assert.rejects(() => kernel.lifecycle.rebuild(), /无法恢复条目 ID|unknown-thing/,
      '可恢复的子目录被排除，但 unknown-thing 恢复不出 → 中止');
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, before, '中止时原数据完好');
    await kernel.close();
  });

  test('边界：junction 指向目录 → 同样 fail-closed（名字可恢复则排除）', async (t) => {
    const kernel = await boot();
    const root = root_of(kernel);
    const tbDir = path.join(root, '.tombstones');
    await fs.mkdir(tbDir, { recursive: true });
    const target = path.join(root, 'junction-target');
    await fs.mkdir(target, { recursive: true });
    const uid = newUlid();
    const linkPath = path.join(tbDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${uid}`);
    try {
      await fs.symlink(target, linkPath, 'junction');
    } catch {
      t.skip('当前环境无权限创建 junction，跳过');
      return;
    }
    const ids = await kernel.lifecycle.tombstonedIds();
    assert.ok(ids.has(uid), 'junction 名字可恢复 → 照常进排除集（宁可多删不复活）');
    await kernel.close();
  });

  test('真 ULID 改名：newUlid 生成的锚点改名 .json.bak → rebuild 照常排除', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, '真 ULID 改名测试条目');
    const root = root_of(kernel);
    const mdDir = path.join(root, 'domains', 'fg');
    const mdFile = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'))[0];
    const mdPath = path.join(mdDir, mdFile);
    const snapshot = await fs.readFile(mdPath, 'utf8');
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    // 改名 + 内容也弄坏（双坏：走名字恢复路径，而恢复必须吃真 ULID）
    await fs.rename(r.tombstone, `${r.tombstone}.bak`);
    await fs.writeFile(`${r.tombstone}.bak`, 'not json at all', 'utf8');
    await fs.writeFile(mdPath, snapshot, 'utf8');
    const rb = await kernel.lifecycle.rebuild();
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE id = ?').get(entry.id).c, 0,
      '真 ULID 从文件名恢复，双坏也不复活');
    assert.ok(rb.tombstoneCorrupt.some((c) => c.recoveredId === entry.id),
      'corrupt 清单标注 recoveredId（恢复路径可见）');
    await kernel.close();
  });

  test('恢复函数形态矩阵：后缀残片/非 ULID 一律 null，不把 .bak/.json 当 ID（F-08 回归）', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    const tbDir = path.join(root, '.tombstones');
    await fs.mkdir(tbDir, { recursive: true });
    const U = newUlid();
    // 全部内容垃圾，逼走文件名恢复路径
    for (const f of [
      `2026-10-31T00-00-00-000Z-.bak`,
      `2026-10-31T00-00-00-000Z-.corrupt`,
      `2026-10-31T00-00-00-000Z-.json`,
      `2026-10-31T00-00-00-000Z-.`,
      `2026-10-31T00-00-00-000Z-entry123.bak`,
      `2026-10-31T00-00-00-000Z-entry123.json.bak`,
    ]) await fs.writeFile(path.join(tbDir, f), 'x', 'utf8');
    // 合法锚点混在里面必须照常工作
    await fs.writeFile(path.join(tbDir, `2026-10-31T00-00-00-000Z-${U}.json`), JSON.stringify({ entryId: U }), 'utf8');
    const ids = await kernel.lifecycle.tombstonedIds();
    assert.deepEqual([...ids], [U], '只有合法 ULID 进集合；六种垃圾形态全部 null（连带 rebuild 将中止）');
    // F-08 矩阵直接 rebuild：垃圾形态 fatal → 中止，SQLite 原数据不变
    const before = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    await assert.rejects(() => kernel.lifecycle.rebuild(), /锚点异常.*中止|无法恢复条目 ID/);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, before, '中止时原数据完好');
    await kernel.close();
  });

  test('F-09 一致：有效 JSON + 文件名一致 → 正常排除（双来源基线）', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, 'F-09 一致基线条目');
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);
    // forget 写出的 tombstone 天然双来源一致：tombstonedIds 正常收录
    const ids = await kernel.lifecycle.tombstonedIds();
    assert.ok(ids.has(entry.id));
    await kernel.close();
  });

  test('F-09 冲突：JSON entryId 与文件名 ULID 不一致 → rebuild 清表前中止，SQLite 不变', async () => {
    const kernel = await boot();
    const entry = await seed(kernel, 'F-09 身份冲突测试条目');
    const root = root_of(kernel);
    const r = await kernel.lifecycle.forget(entry.id, { confirmId: entry.id });
    assert.equal(r.forgotten, true);
    // 把锚点改名为"另一个合法 ULID"——JSON 说 A、文件名说 B，两边都合法却各说各话
    const forged = `${new Date().toISOString().replace(/[:.]/g, '-')}-${newUlid()}.json`;
    await fs.rename(r.tombstone, path.join(root, '.tombstones', forged));
    const before = kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c;
    await assert.rejects(() => kernel.lifecycle.rebuild(), /身份冲突/);
    assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, before, '中止时原数据完好');
    await kernel.close();
  });

  test('F-09 JSON entryId 非法（非空但非 ULID）→ 不作锚点，走文件名恢复', async () => {
    const kernel = await boot();
    const root = root_of(kernel);
    const tbDir = path.join(root, '.tombstones');
    await fs.mkdir(tbDir, { recursive: true });
    const U = newUlid();
    // JSON 说 "entry123"（非 ULID），文件名是真 ULID → 不信任 JSON，按文件名恢复
    await fs.writeFile(path.join(tbDir, `2026-10-31T00-00-00-000Z-${U}.json`), JSON.stringify({ entryId: 'entry123' }), 'utf8');
    const ids = await kernel.lifecycle.tombstonedIds();
    assert.deepEqual([...ids], [U], '非法 JSON entryId 被拒，文件名恢复生效');
    assert.ok(!ids.has('entry123'));
    await kernel.close();
  });

  test('F-09 边界固化：JSON 有效 + 文件名无法恢复 → 信任 JSON（唯一可用身份来源）', async () => {
    // 复核建议固化的策略：文件名没有可比较的有效 ID 时，JSON 是唯一身份来源，不中止。
    // （与"两边都在且不一致必须中止"不矛盾——那时有两个互相矛盾的证据，现在只有一个。）
    const kernel = await boot();
    const root = root_of(kernel);
    const tbDir = path.join(root, '.tombstones');
    await fs.mkdir(tbDir, { recursive: true });
    const U = newUlid();
    await fs.writeFile(path.join(tbDir, 'renamed-beyond-recognition'), JSON.stringify({ entryId: U }), 'utf8');
    const ids = await kernel.lifecycle.tombstonedIds();
    assert.deepEqual([...ids], [U], 'JSON 唯一身份来源时正常排除，不触发中止');
    await kernel.close();
  });
});

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

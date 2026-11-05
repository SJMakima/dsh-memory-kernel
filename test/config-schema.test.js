/**
 * 配置层的三条机器纪律（设置页 Phase 1 的地基，见 docs/host-compat-matrix.md）：
 *   ① 分类穷举：DEFAULTS 全叶必须有 hot/structural/restart 归属，无 undefined；
 *   ② 幽灵键双向拦截：OVERRIDES / UI_SCHEMA / CONFIG_ONLY 里的每条路径都必须真实存在；
 *   ③ UI 覆盖完备：每个叶子要么在设置页（UI_SCHEMA），要么显式标进 CONFIG_ONLY。
 * 加新配置键没分类 / schema 写错路径 / 白名单漏覆盖，这里直接红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULTS, loadConfig } from '../src/config.js';
import { SECTION_CLASS, OVERRIDES, classifyConfigKey, applyConfigPatch } from '../src/config-classes.js';
import { UI_SCHEMA, CONFIG_ONLY } from '../src/config-schema.js';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const leafPaths = (node, prefix = '') => Object.entries(node ?? {}).flatMap(([k, v]) => {
  const path = prefix ? `${prefix}.${k}` : k;
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) return leafPaths(v, path);
  return [path];
});

const resolveExists = (path) => {
  let node = DEFAULTS;
  for (const seg of path.split('.')) {
    if (!node || typeof node !== 'object' || !(seg in node)) return false;
    node = node[seg];
  }
  return true;
};
// schema 字段允许"map 型"（widget 以 map 开头）：dailyQuotaPerDomain 这类用户键值对，
// 它在 DEFAULTS 里是对象但语义上是一个叶子单元，不该按分支拆开暴露
const isLeaf = (path) => {
  let node = DEFAULTS;
  for (const seg of path.split('.')) {
    if (!node || typeof node !== 'object' || !(seg in node)) return false;
    node = node[seg];
  }
  return !(node && typeof node === 'object' && Object.keys(node).length);
};

/* ── ① 分类穷举 ── */

test('classifyConfigKey：DEFAULTS 全叶有归属，分区表覆盖全部分区', () => {
  for (const p of leafPaths(DEFAULTS)) {
    const cls = classifyConfigKey(p);
    assert.ok(cls === 'hot' || cls === 'structural' || cls === 'restart', `${p} → ${cls}（未注册）`);
  }
  for (const section of Object.keys(DEFAULTS)) {
    assert.ok(section in SECTION_CLASS, `分区 ${section} 没有默认分类`);
  }
});

test('OVERRIDES：每条路径都必须真实存在（幽灵键检查）', () => {
  for (const p of Object.keys(OVERRIDES)) {
    assert.ok(resolveExists(p), `OVERRIDES 里的 ${p} 在 DEFAULTS 中不存在——表单发明出来的键？`);
  }
});

/* ── ② schema 双向一致性 ── */

test('UI_SCHEMA：每个字段都是 DEFAULTS 里的真实节点（map 型允许整体暴露）', () => {
  assert.ok(UI_SCHEMA.length >= 8, 'Phase 1+2 的字段一个都不能少');
  for (const f of UI_SCHEMA) {
    assert.ok(resolveExists(f.path), `UI_SCHEMA 的 ${f.path} 在 DEFAULTS 中不存在`);
    if (!f.widget.startsWith('map')) {
      assert.ok(isLeaf(f.path), `UI_SCHEMA 的 ${f.path} 不是叶子（不该暴露整棵分支）`);
    }
  }
});

test('CONFIG_ONLY：每条都能解析到真实路径，且与 UI_SCHEMA 无交集', () => {
  for (const entry of CONFIG_ONLY) {
    const base = entry.endsWith('.*') ? entry.slice(0, -2) : entry;
    assert.ok(resolveExists(base), `CONFIG_ONLY 的 ${entry} 解析不到 DEFAULTS 路径`);
  }
  const covers = (entry, path) => {
    const base = entry.endsWith('.*') ? entry.slice(0, -2) : entry;
    return path === base || path.startsWith(`${base}.`) || (entry.endsWith('.*') && path.startsWith(`${base}.`));
  };
  for (const f of UI_SCHEMA) {
    assert.ok(!CONFIG_ONLY.some((e) => covers(e, f.path)), `${f.path} 同时在 UI 和 CONFIG_ONLY 里`);
  }
});

test('双向覆盖：每个 DEFAULTS 叶子要么在 UI（含其子树），要么显式进 CONFIG_ONLY', () => {
  const covers = (entry, path) => {
    const base = entry.endsWith('.*') ? entry.slice(0, -2) : entry;
    return path === base || path.startsWith(`${base}.`) || (entry.endsWith('.*') && path.startsWith(`${base}.`));
  };
  const uncovered = leafPaths(DEFAULTS).filter((p) => {
    if (UI_SCHEMA.some((f) => covers(f.path, p))) return false;
    return !CONFIG_ONLY.some((e) => covers(e, p));
  });
  assert.deepEqual(uncovered, [], '这些键既不在设置页也不在白名单——加进 CONFIG_ONLY 或 UI_SCHEMA');
});

/* ── ③ applyConfigPatch 行为 ── */

test('hot 值：活引用上生效；map 扩域合法；幽灵键拒绝', () => {
  const cfg = loadConfig({});
  const r = applyConfigPatch(cfg, { write: { updateGamma: 5, dailyQuotaPerDomain: { 'newdom': 7 }, intentK: 5 } }, { defaults: DEFAULTS });
  assert.deepEqual(r.rejected, [{ path: 'write.intentK', reason: 'ghost-key (DEFAULTS 中不存在；用户 map 请整块发送)' }]);
  assert.equal(cfg.write.updateGamma, 5, 'hot 标量直接生效');
  assert.equal(cfg.write.dailyQuotaPerDomain.newdom, 7, '扁平 map 允许扩域');
  assert.equal(cfg.write.dailyQuotaPerDomain['qq-group'], 15, '扩域不丢原有键');
  assert.equal(cfg.write.intentK, undefined, '幽灵键绝不落盘');
});

test('per-key 分类：同一条补丁里 restart 拒、hot 应用', () => {
  const cfg = loadConfig({});
  const r = applyConfigPatch(cfg, { embedding: { model: 'other', batchSize: 32 }, storage: { root: '/x', maxEntriesPerFile: 100 } }, { defaults: DEFAULTS });
  assert.ok(r.rejected.some((x) => x.path === 'embedding.model' && x.reason === 'restart-required'));
  assert.ok(r.rejected.some((x) => x.path === 'storage.root' && x.reason === 'restart-required'));
  assert.ok(r.applied.includes('embedding.batchSize'), 'batchSize 是 OVERRIDES 里的 hot 例外');
  assert.ok(r.applied.includes('storage.maxEntriesPerFile'));
  assert.equal(cfg.embedding.model, 'bge-m3-q8', 'restart 键的值纹丝不动');
  assert.equal(cfg.embedding.batchSize, 32);
  assert.equal(cfg.storage.maxEntriesPerFile, 100);
});

test('structural：照常应用 + 单独归架；hot 对象整块发走浅合并不丢键', () => {
  const cfg = loadConfig({});
  // structural 单独归架（embedding.backend：换后端 = 向量语义全变，须 rebuild）
  const r1 = applyConfigPatch(cfg, { embedding: { backend: 'lexvec' } }, { defaults: DEFAULTS });
  assert.deepEqual(r1.structural, ['embedding.backend']);
  assert.equal(cfg.embedding.backend, 'lexvec', 'structural 也写进活引用（rebuild 前按旧语义跑）');

  // hot：memIndex 整块作为单元浅合并，partial 补丁不能把 enabled 洗掉
  const r2 = applyConfigPatch(cfg, { retrieve: { memIndex: { maxVectors: 5000 } } }, { defaults: DEFAULTS });
  assert.deepEqual(r2.applied, ['retrieve.memIndex']);
  assert.equal(cfg.retrieve.memIndex.maxVectors, 5000);
  assert.equal(cfg.retrieve.memIndex.enabled, true, 'partial 补丁不丢同组其他键');
});

test('restart 键绝不动 cfg；未注册分区整个拒绝', () => {
  const cfg = loadConfig({});
  const before = JSON.stringify(cfg.embedding);
  const r = applyConfigPatch(cfg, { embedding: { dim: 128 }, bogus: { x: 1 } }, { defaults: DEFAULTS });
  assert.equal(JSON.stringify(cfg.embedding), before);
  assert.ok(r.rejected.some((x) => x.path === 'embedding.dim'));
  assert.ok(r.rejected.some((x) => x.path === 'bogus' && x.reason === 'unclassified'), '未知分区在入口就被拒，不下钻');
});

/* ── ④ kernel 接线冒烟：热键补丁直接进活引用，不重算任何表级状态 ── */

test('kernel.applyConfigPatch：memIndex 是热键（R-137 之后向量配置不再烧在建表子句里）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cfgpatch-'));
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 64 } },
    domains: [defineDomain({ id: 'qq-group', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(64),
    gitInit: false,
  });
  await kernel.init();

  const r = kernel.applyConfigPatch({ retrieve: { memIndex: { enabled: false } } });
  assert.deepEqual(r.applied, ['retrieve.memIndex'], '热键：不需要 rebuild');
  assert.deepEqual(r.structural, []);
  assert.equal(kernel.cfg.retrieve.memIndex.enabled, false, '值已进活引用');
  assert.equal(kernel.cfg.retrieve.memIndex.maxVectors, 200_000, '同组其他键不丢');
  assert.notEqual(kernel.vectorMode('qq-group'), 'mem-exact', '关掉之后下一次判定就得回落（不是点了没反应的死开关）');
  assert.notEqual(kernel.vectorMode('qq-group'), 'mem-lazy');

  await kernel.audit.flush();
  const log = await fs.readFile(path.join(root, 'audit', 'config-patch.log'), 'utf8');
  assert.match(log, /retrieve\.memIndex/, '审计行含补丁结果（文件名即频道，行内是 payload）');
});

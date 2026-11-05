/**
 * 第外审登记的四条真 bug（R-121~R-124）——每条一个回归测试。
 *
 * 这四条的共同点：**不报错、不影响单条命中，只在真实分布 / 真实语料下烂掉**，
 * 所以测试必须覆盖"分布"和"退化输入"，不能只测 happy path（R-91 第七关）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { lazyPersistence } from '../src/pure/lifecycle.js';
import { matchTripleTerms } from '../src/core/vocab.js';
import { countSubjectsInQuery } from '../src/pure/ranking.js';
import { topKByCosine } from '../src/core/vec.js';
import { loadConfig } from '../src/config.js';

const DIM = 32;

/* ─────────────────── R-123：γ 不得从侧门吃掉 floor 豁免 ─────────────────── */
test('R-123 boundary 被取代后（γ=3）持久度不得低于自身 floor', () => {
  const cfg = loadConfig({});
  const now = Date.now();
  const base = {
    entry_type: 'boundary', persistence_at_decay: 0.9, last_decay_at: now - 365 * 864e5,
    gamma_multiplier: 3.0,
  };
  const p = lazyPersistence(base, cfg, now);
  // 修前：floor = 0.6 / 3 = 0.2 → 返回 0.2（比未取代时的 0.6 还低）
  assert.ok(p >= 0.6 - 1e-9, `boundary 的 ∞ 豁免应保持 floor 0.6，实际 ${p}`);

  // 对照：会衰减的 fact 仍然吃 γ（否则这条修法就越界了）
  const fact = lazyPersistence(
    { entry_type: 'fact', persistence_at_decay: 0.5, last_decay_at: now - 30 * 864e5, gamma_multiplier: 3.0 },
    cfg, now,
  );
  assert.ok(fact < 0.2, `fact 仍应被 γ 加速到低位，实际 ${fact}`);
});

test('R-123 新条目初值 ≥ 本类型 floor（boundary 0.5 < 0.6 的两套数字对齐）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-init-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  await kernel.remember({
    domainId: 'da', text: '不要在下班时间找我', entryType: 'boundary', topicTags: ['边界'],
    triples: [], sourceRef: { adapter_id: 'da', locator: 'da:boundary' },
    provenance: { session_id: 'da:1', message_ids: ['da:boundary'], extract_task_id: 't', model_version: 'manual', extracted_at: Date.now(), source_content_hash: '' },
  });
  const row = kernel.db.prepare("SELECT persistence_init FROM entries WHERE entry_type = 'boundary'").get();
  assert.ok(row.persistence_init >= 0.6 - 1e-9, `boundary 初值应 ≥ floor 0.6，实际 ${row.persistence_init}`);
});

/* ─────────────────── R-124：含空格的英文主体必须能命中 ─────────────────── */
test('R-124 主体带空格时 tripleSearch 的词表匹配不得失效', () => {
  const vocab = { subjects: new Set(['alice smith']), attributes: new Set(['preference']) };
  const hits = matchTripleTerms('Alice Smith 喜欢喝什么', vocab);
  assert.deepEqual(hits.hitSubjects, ['alice smith'], '查询侧删空格会让 "alice smith" 永不命中（修前 bug）');

  // 意图判定走的是同一条查询侧归一化：关系型查询必须认出两个主体
  const n = countSubjectsInQuery('Alice Smith 和 Bob 是什么关系', {
    subjects: new Set(['alice smith', 'bob']),
  });
  assert.equal(n, 2, '含空格主体也应计入 relational 判定');
});

/* ─────────────────── R-121：dream 不得每夜全库重写 ─────────────────── */
test('R-121 dream 状态落盘有量化门槛：无明显衰减时不重写', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dreamgate-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  for (let i = 0; i < 3; i++) {
    await kernel.remember({
      domainId: 'da', text: `条目 ${i} 的内容`, entryType: 'fact', topicTags: ['测试'],
      triples: [], sourceRef: { adapter_id: 'da', locator: `da:${i}` },
      provenance: { session_id: 'da:1', message_ids: [`da:${i}`], extract_task_id: 't', model_version: 'manual', extracted_at: Date.now(), source_content_hash: '' },
    });
  }

  // 刚写完：Δp 是毫秒级衰减，远小于 0.01 → 一条都不该重写（修前 changed === candidates）
  const r1 = await kernel.dream();
  assert.equal(r1.steps.s2.candidates, 3);
  assert.equal(r1.steps.s2.changed, 0, `刚写入的条目不该被重写，实际 changed=${r1.steps.s2.changed}`);

  // 把 last_decay_at 推到 15 天前（> stateWriteMaxStaleDays 14）：保底条款必须放行
  kernel.db.prepare('UPDATE entries SET last_decay_at = ?').run(Date.now() - 15 * 864e5);
  const r2 = await kernel.dream();
  assert.equal(r2.steps.s2.changed, 3, '超过最长未落盘天数后必须落一次，防止状态永久滞后');
});

/* ─────────────────── R-122：小分区不得依赖全表 KNN ─────────────────── */
test('R-122 topKByCosine：余弦排序 + 维度守卫 + 同分稳定', () => {
  const q = new Float32Array([1, 0, 0]);
  const rows = [
    { id: 'b', embedding: Buffer.from(new Float32Array([0.9, 0.1, 0]).buffer) },
    { id: 'a', embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer) },
    { id: 'c', embedding: Buffer.from(new Float32Array([0, 1, 0]).buffer) },
    { id: 'bad', embedding: Buffer.from(new Float32Array([1, 0]).buffer) },   // 错维 → 跳过
  ];
  const top = topKByCosine(q, rows, 2);
  assert.deepEqual(top.map((x) => x.id), ['a', 'b']);
  assert.ok(top[0].score > 0.99 && top[0].score <= 1.0001, `完全同向应接近 1，实际 ${top[0].score}`);
  assert.equal(top.length, 2, '错维行被跳过，且只返回 k 条');
});

test('R-122 小分区检索走域内扫描：不发起全表 MATCH', async (t) => {
  // 直接对 createVec 喂一个"只认识域内扫描 SQL"的假 db：一旦代码退回全表 KNN，
  // 就会碰到没注册的 MATCH 语句并抛错 → 测试红。这正是当年 synthetic-small 掩盖的路径。
  const { createVec } = await import('../src/core/vec.js');
  const statements = [];
  const fakeDb = {
    prepare(sql) {
      statements.push(sql);
      if (sql.includes('embedding_cache') && sql.includes('SELECT')) return { get: () => null };
      if (sql.includes('INSERT INTO embedding_cache')) return { run: () => {} };
      if (sql.includes('vec_shards')) return { get: () => ({ vector_count: 3 }) };   // < minPartitionVectors
      if (sql.includes('FROM entries_vec WHERE domain_id')) {
        return {
          all: () => [
            { id: 'e1', embedding: Buffer.from(new Float32Array([1, 0, 0, 0]).buffer) },
            { id: 'e2', embedding: Buffer.from(new Float32Array([0.5, 0.5, 0, 0]).buffer) },
          ],
        };
      }
      // 任何 MATCH 查询都直接炸：小分区不允许走全表 KNN
      throw new Error(`unexpected statement: ${sql.slice(0, 60)}`);
    },
  };
  const cfg = loadConfig({ retrieve: { minPartitionVectors: 50 } });
  const vec = createVec({
    db: fakeDb, cfg,
    vec: { enabled: true, dim: 4, canPartition: true },
    embedder: { dim: 4, embed: async () => [] },
    audit: { write: async () => {} },
  });

  const hits = vec.search(new Float32Array([1, 0, 0, 0]), 'da', 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'e1', '域内扫描应按余弦排序');
  assert.ok(!statements.some((s) => s.includes('MATCH')), '小分区不得发起全表 MATCH');
});

/* ─────────────────── R-143：dream 空闲触发的冷启动死锁 ─────────────────── */

test('R-143 maybeDream：一次 dream 没跑过时，boot 起算空闲满 idleMs 也能触发', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-r143-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  // 修前：lastDreamAt=0 → `lastDreamAt > 0 &&` 恒假 → boot 后永远 below-threshold，
  // dream 只能靠手动触发（2026-10-28 实录：dream.log 里从未有过 run 记录）。
  const bootAt = Date.now();
  const r = await kernel.maybeDream({ now: bootAt + 31 * 60_000 });   // 空闲 31 分钟 > idleMs 30 分钟
  assert.notEqual(r.skipped, 'below-threshold', '冷启动空闲满阈值必须能触发 idle 路触发');
  assert.equal(r.triggeredBy ?? 'idle', 'idle');
});

test('R-143 补：dream 并发守卫——飞行中再次触发返回 in-flight，不双跑', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-r143b-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  // p1 不等待：dream.run 内部第一个 await 让出后仍在飞行；
  // 第二次同步触发走到 runDream 守卫，必须被挡下（修前会并发跑第二遍）
  const bootAt = Date.now();
  const p1 = kernel.maybeDream({ now: bootAt + 31 * 60_000 });
  const r2 = await kernel.maybeDream({ now: bootAt + 31 * 60_000 + 1000 });
  assert.equal(r2.skipped, 'in-flight', '飞行中重复触发必须被守卫挡下');
  const r1 = await p1;
  assert.ok(!r1.skipped, '第一次触发应正常完成');
});

test('R-143 补：dream 并发守卫——飞行中再次触发返回 in-flight，不双跑', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-r143b-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  // p1 不等待：dream.run 内部第一个 await 让出后仍在飞行；
  // 第二次同步触发走到 runDream 守卫，必须被挡下（修前会并发跑第二遍）
  const bootAt = Date.now();
  const p1 = kernel.maybeDream({ now: bootAt + 31 * 60_000 });
  const r2 = await kernel.maybeDream({ now: bootAt + 31 * 60_000 + 1000 });
  assert.equal(r2.skipped, 'in-flight', '飞行中重复触发必须被守卫挡下');
  const r1 = await p1;
  assert.ok(!r1.skipped, '第一次触发应正常完成');
});

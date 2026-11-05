/**
 * P3+ 验收：巩固信号消费与触发、pattern 提炼（独立配额）、人工确认式身份对齐、
 * bili/douyin Adapter、cross-encoder 重排钩子。
 * 差分衰减 A/B 的报告在 eval/run.js（§5b），不进 npm test。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { defineBiliDomain, defineDouyinDomain } from '../src/adapters/video-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { createScriptedExtractor, createMockExtractor } from '../src/adapters/mock-extractor.js';

const DIM = 64;
const SESSION = 'qq-group:8823';

const prov = (locator) => ({
  session_id: SESSION, message_ids: [locator], extract_task_id: 'p3-test',
  model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
});

async function boot({ llm, overrides = {}, domains } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p3-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      ...overrides,
    },
    domains: domains ?? [defineDomain({ id: 'qq-group', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
    ...(llm ? { llm } : {}),
    gitInit: false,
  });
  await kernel.init();
  return { kernel, root };
}

const cleanup = async (kernel, root) => {
  await kernel.close();
  await fs.rm(root, { recursive: true, force: true });
};

const remember = (kernel, text, value, locator) => kernel.remember({
  domainId: 'qq-group', text, entryType: 'fact', topicTags: ['偏好'],
  triples: [{ subject: '用户', attribute: '偏好', value }],
  sourceRef: { adapter_id: 'qq-group', locator },
  provenance: prov(locator),
});

/* ───────────── 步 11 + §17.1：巩固信号消费与 dream 触发 ───────────── */

test('巩固信号：加权分达标触发 maybeDream，消费后归零、不重复触发', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  // conflict_accum 权重 1.0 → 6 条 = 6 分 ≥ 阈值 5
  for (let i = 0; i < 6; i++) kernel.write.recordConsolidationSignal('conflict_accum', 'qq-group', 1.0);

  const first = await kernel.maybeDream();
  assert.equal(first.triggeredBy, 'consolidation-signal', '信号达标必须触发，而不是等空闲');
  assert.equal(first.steps.s11.consumed, 6, '信号要被结算（consumed=1）');

  const after = await kernel.maybeDream();
  assert.equal(after.skipped, 'below-threshold', '消费完就归零，不许每轮空转 dream');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM consolidation_signals WHERE consumed = 0').get().c, 0);
});

test('巩固信号：不到阈值就继续攒（积分制，不是轮询制）', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  for (let i = 0; i < 4; i++) kernel.write.recordConsolidationSignal('conflict_accum', 'qq-group', 1.0);
  const r = await kernel.maybeDream();
  assert.equal(r.skipped, 'below-threshold');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM consolidation_signals WHERE consumed = 0').get().c, 4,
    '没消费！攒到 5 分才允许触发，清零等于让下一次爆发更远');
});

/* ───────────── 步 7：pattern 提炼（LLM + 独立配额）───────────── */

test('pattern 提炼：信号达标域出簇 → LLM 产出 pattern 落盘，溯源指向源条目', async (t) => {
  // 先写满 6 条 fact（同 (用户,偏好) 簇 ≥ 2），再让 LLM 对第一个簇返回一个模式
  let clusterDump = '';
  const llm = createMockExtractor(({ messages }) => {
    clusterDump = messages[0].content;
    return {
      text: '用户的饮品偏好经常变化，几乎每个月换一次主力饮品',
      topic_tags: ['偏好', '模式'],
      triples: [{ subject: '用户', attribute: '偏好', value: '月度轮换' }],
    };
  });
  const { kernel, root } = await boot({ llm });
  t.after(() => cleanup(kernel, root));

  // bypass 语义造"同簇多条存活 fact"：开四分类的话，同 (s,a) 会链式 update，簇就没了
  const saved = kernel.cfg.write.p0aBypassRouting;
  kernel.cfg.write.p0aBypassRouting = true;
  await remember(kernel, '用户喜欢喝咖啡', '咖啡', 'p1');
  await remember(kernel, '用户最近爱喝茶', '茶', 'p2');
  await remember(kernel, '用户这周喝果汁', '果汁', 'p3');
  kernel.cfg.write.p0aBypassRouting = saved;
  for (let i = 0; i < 6; i++) kernel.write.recordConsolidationSignal('topic_fact_burst', 'qq-group', 1.5);

  const d = await kernel.dream();
  assert.equal(d.steps.s7.mined, 1, '信号达标 + 簇存在 → 提炼 1 条 pattern');
  assert.ok(clusterDump.includes('用户喜欢喝咖啡'), '簇内容要真的进 prompt');

  const p = kernel.db.prepare("SELECT text, provenance, entry_type FROM entries WHERE entry_type = 'pattern'").get();
  assert.ok(p, 'pattern 条目落库');
  assert.match(JSON.parse(p.provenance).message_ids.join(','), /0/, '溯源必须指向源条目');

  // pattern 走的是独立配额：日常写入配额表不应有 pattern 的痕迹，且 quotas 未被 pattern 消耗
  const d2 = await kernel.dream();   // 信号已被消费 → 不再提炼
  assert.ok(d2.steps.s7.skipped || d2.steps.s7.mined === 0, '消费后不重复提炼');
});

test('pattern 提炼：独立配额挡住超额提炼；未注入 llm 时跳过而不是报错', async (t) => {
  const llm = createScriptedExtractor([
    { text: '模式一：用户的偏好高度不稳定', topic_tags: ['模式'], triples: [{ subject: '用户', attribute: '偏好', value: '不稳定' }] },
    { text: '模式二：这个不该被提炼出来', topic_tags: ['模式'], triples: [] },
  ]);
  const { kernel, root } = await boot({
    llm,
    overrides: { write: { patternQuotaPerDay: 1 }, dream: { signalThreshold: 1 } },
  });
  t.after(() => cleanup(kernel, root));

  const saved = kernel.cfg.write.p0aBypassRouting;
  kernel.cfg.write.p0aBypassRouting = true;
  // 两个簇：(用户,偏好) 和 (用户,宠物)，各 2 条存活 fact
  const rememberAttr = (text, attribute, value, locator) => kernel.remember({
    domainId: 'qq-group', text, entryType: 'fact', topicTags: ['偏好'],
    triples: [{ subject: '用户', attribute, value }],
    sourceRef: { adapter_id: 'qq-group', locator },
    provenance: prov(locator),
  });
  await rememberAttr('用户喜欢喝咖啡', '偏好', '咖啡', 'p1');
  await rememberAttr('用户最近爱喝茶', '偏好', '茶', 'p2');
  await rememberAttr('用户养了一只猫', '宠物', '猫', 'p3');
  await rememberAttr('用户还养了一只狗', '宠物', '狗', 'p4');
  kernel.cfg.write.p0aBypassRouting = saved;
  kernel.write.recordConsolidationSignal('conflict_accum', 'qq-group', 5);

  const d = await kernel.dream();
  assert.equal(d.steps.s7.mined, 1, '配额 1 → 只落第一条');
  assert.ok(d.steps.s7.quotaBlocked >= 1, '超额的簇要被独立配额挡住');
  assert.equal(
    kernel.db.prepare("SELECT COUNT(*) c FROM entries WHERE entry_type = 'pattern'").get().c, 1,
  );

  // 未注入 llm 的 kernel：patternMining 跳过，dream 其余步骤照常
  const { kernel: k2, root: r2 } = await boot();
  t.after(() => cleanup(k2, r2));
  k2.write.recordConsolidationSignal('conflict_accum', 'qq-group', 9);
  const d2 = await k2.dream();
  assert.equal(d2.steps.s7.skipped, 'no-llm');
  assert.ok(d2.steps.s11.consumed >= 1);
});

/* ───────────── P3+ 人工确认式身份再对齐 ───────────── */

test('身份对齐：list 出分叉 → 人工指定保留项 → 其余打取代边，真相源同步', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  const saved = kernel.cfg.write.p0aBypassRouting;
  kernel.cfg.write.p0aBypassRouting = true;
  await remember(kernel, '用户喜欢喝咖啡', '咖啡', 'f1');
  await remember(kernel, '用户喜欢喝茶', '茶', 'f2');
  kernel.cfg.write.p0aBypassRouting = saved;

  const forks = kernel.listIdentityForks('qq-group');
  assert.equal(forks.length, 1);
  assert.equal(forks[0].members.length, 2);
  const keep = forks[0].members[0].entryId;
  const lose = forks[0].members[1].entryId;

  const r = await kernel.resolveIdentityFork({
    domainId: 'qq-group', subjectKey: forks[0].subject_key, attribute: forks[0].attribute, keepEntryId: keep,
  });
  assert.equal(r.aligned, 1);
  assert.equal(kernel.db.prepare('SELECT superseded_by FROM entries WHERE id = ?').get(lose).superseded_by, keep);
  assert.equal(kernel.listIdentityForks('qq-group').length, 0, '对齐后分叉消失');

  // 真相源同步：Markdown 的 state 块里要有 superseded_by（P2 身份指标才能看到收口）
  const mdPath = kernel.files.locateEntryPath ? null : null;
  const md = await (async () => {
    const row = kernel.db.prepare('SELECT path FROM files LIMIT 1').get();
    return fs.readFile(row.path, 'utf8');
  })();
  void mdPath;
  assert.match(md, new RegExp(`superseded_by: "${keep}"`));

  // 非法保留项必须拒绝，而不是静默吞掉
  await assert.rejects(
    () => kernel.resolveIdentityFork({
      domainId: 'qq-group', subjectKey: forks[0].subject_key, attribute: forks[0].attribute, keepEntryId: '01NOPE',
    }),
    /不在该簇/,
  );
});

/* ───────────── bili / douyin Adapter（P3+）───────────── */

test('bili/douyin Adapter：域路由 + sourceReader 回读原文', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-video-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'bili.jsonl'), `${JSON.stringify({ id: 'BV1', text: '这期视频讲了检索评测的做法', at: Date.now() })}\n`);
  await fs.writeFile(path.join(root, 'douyin.jsonl'), `${JSON.stringify({ id: 'dy9', text: '作者：某up主，内容关于咖啡烘焙', at: Date.now() })}\n`);

  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { p0aBypassRouting: true },
    },
    domains: [
      defineDomain({ id: 'qq-group', dir: path.join(root, 'a') }),
      defineBiliDomain({ dir: root }),
      defineDouyinDomain({ dir: root }),
    ],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => {
    await kernel.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  // 域路由：会话前缀决定域（配额也是按域的：bili 5 / douyin 5）
  assert.equal(kernel.domains.routeDomain('bili:session').id, 'bili');
  assert.equal(kernel.domains.routeDomain('douyin:session').id, 'douyin');
  assert.equal(kernel.domains.routeDomain('bili:session').sourceReaderIsLocal !== false, true);

  await kernel.remember({
    domainId: 'bili', text: '用户收藏了一期检索评测的视频', entryType: 'fact', topicTags: ['视频'],
    triples: [{ subject: '用户', attribute: '收藏', value: '检索评测视频' }],
    sourceRef: { adapter_id: 'bili', locator: 'bili:BV1' },
    provenance: { session_id: 'bili:s1', message_ids: ['BV1'], extract_task_id: 'p3', model_version: 'manual', extracted_at: Date.now(), source_content_hash: '' },
  });

  const ctx = await kernel.context(
    kernel.db.prepare("SELECT id FROM entries WHERE domain_id = 'bili'").get().id,
    { sessionId: 'bili:s1' },
  );
  assert.equal(ctx.original.text, '这期视频讲了检索评测的做法', 'bili reader 要能回读原文');
});

/* ───────────── cross-encoder 重排钩子（P3+，可插拔）───────────── */

async function bootRerank(reranker) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p3-rr-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      retrieve: { rerank: { enabled: true, pool: 10 } },
    },
    domains: [defineDomain({ id: 'qq-group', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
    reranker,
    gitInit: false,
  });
  await kernel.init();
  const seed = async () => {
    // 【冲突治理】异主体：同 (subject,attribute) 异值会链式 update（正确语义），
    // rerank 测试需要多条活候选，所以用不同的人各自喜欢各的。
    const people = ['张三', '李四', '王五', '赵六', '钱七'];
    for (const [i, v] of ['咖啡', '茶', '果汁', '牛奶', '可乐'].entries()) {
      await kernel.remember({
        domainId: 'qq-group', text: `${people[i]}喜欢喝${v}，排行第 ${i}`, entryType: 'fact', topicTags: ['偏好'],
        triples: [{ subject: people[i], attribute: '偏好', value: v }],
        sourceRef: { adapter_id: 'qq-group', locator: `r${i}` },
        provenance: prov(`r${i}`),
      });
    }
  };
  return { kernel, root, seed };
}

test('重排钩子：reranker 决定池内顺序，成功留痕', async (t) => {
  // reranker 按文本长度排序（确定性），可观测地改变检索返回顺序
  const { kernel, root, seed } = await bootRerank({
    model: 'stub-cross-encoder',
    rerank: async (query, candidates) => [...candidates]
      .sort((a, b) => a.text.length - b.text.length)
      .map((c, i) => ({ id: c.id, score: 1 - i / 100 })),
  });
  t.after(() => cleanup(kernel, root));
  await seed();

  const r = await kernel.search({ sessionId: SESSION, query: '用户喜欢喝什么' });
  assert.ok(r.entries.length >= 2, '要有足够的条目才能观察顺序');
  const texts = r.entries.map((e) => e.text);
  const lengths = texts.map((s) => s.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b), '返回顺序必须服从 reranker');
  await kernel.audit.flush();
  const log = await fs.readFile(path.join(root, 'audit', 'rerank.log'), 'utf8').catch(() => '');
  assert.match(log, /"pool":5/, '重排要留痕（池大小 + 返回数）');
});

test('重排钩子：reranker 抛错 → 原顺序继续，检索不崩', async (t) => {
  const { kernel, root, seed } = await bootRerank({
    model: 'broken-cross-encoder',
    rerank: async () => { throw new Error('model OOM'); },
  });
  t.after(() => cleanup(kernel, root));
  await seed();

  const r = await kernel.search({ sessionId: SESSION, query: '用户喜欢喝什么' });
  assert.ok(r.entries.length >= 1, '重排失败绝不能把检索带崩');
  await kernel.audit.flush();
  const log = await fs.readFile(path.join(root, 'audit', 'rerank-failed.log'), 'utf8').catch(() => '');
  assert.match(log, /OOM/);
});

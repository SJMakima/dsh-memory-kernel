/**
 * P0b 验收（§7）：接 LLM 抽取 + 四分类 + 配额 + pending。
 *
 * 抽取器用脚本替身（与真 LLM 同一 `complete()` 接口，走完整的 JSON 解析 → 清洗 →
 * 四分类 → 落盘链路）；真模型的 transport（OpenAI 兼容）单独有 adapter，不进单测。
 *
 * 这里断言的是验收表那几条：
 *   消息进入后 Markdown 与 SQLite 均可见；重复消息被 redundant 拦下（不新增条目）；
 *   配额满 → pending → 恢复后消费；坏输出不崩、留 audit。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { createMockExtractor } from '../src/adapters/mock-extractor.js';
import { parseCandidatesJson, sanitizeCandidates } from '../src/core/extract.js';
import { sha256 } from '../src/pure/normalize.js';

const DIM = 64;
const SESSION = 'qq-group:8823';

async function boot({ llmOutputs, quota, bypass } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-extract-'));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive, { recursive: true });
  const domain = defineDomain({ id: 'qq-group', dir: archive });

  let calls = 0;
  const llm = createMockExtractor(() => {
    calls++;
    return llmOutputs?.length ? llmOutputs.shift() : [];
  });

  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: {
        ...(quota ? { dailyQuotaPerDomain: { 'qq-group': quota, default: 20 } } : {}),
        ...(bypass !== undefined ? { p0aBypassRouting: bypass } : {}),
      },
    },
    domains: [domain],
    embedder: createHashEmbedder(DIM),
    llm,
    gitInit: false,
  });
  await kernel.init();
  return { kernel, root, archive, llm, calls: () => calls };
}

const cleanup = async (kernel, root) => {
  await kernel.close();
  await fs.rm(root, { recursive: true, force: true });
};

const readAudit = async (root, name) =>
  fs.readFile(path.join(root, 'audit', name), 'utf8').catch(() => '');

const cand = (over = {}) => JSON.stringify([{
  text: '用户喜欢喝咖啡，每天两杯',
  entry_type: 'fact',
  topic_tags: ['偏好'],
  triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }],
  ...over,
}]);

/* ─────────────────── 1. 消息 → Markdown 与 SQLite 均可见 ─────────────────── */

test('抽取：消息进入后 Markdown 与 SQLite 均可见，provenance 指向抽取任务', async (t) => {
  const { kernel, root } = await boot({ llmOutputs: [cand()] });
  t.after(() => cleanup(kernel, root));

  const r = await kernel.extract({ sessionId: SESSION, text: '我跟你说我喜欢喝咖啡', messageId: 'msg:100' });
  assert.equal(r.candidates, 1);
  assert.equal(r.results[0].status, 'written');
  const entryId = r.results[0].entry.id;

  // SQLite 侧
  const row = kernel.db.prepare('SELECT id, text, provenance, source_ref FROM entries WHERE id = ?').get(entryId);
  assert.equal(row.text, '用户喜欢喝咖啡，每天两杯');
  const prov = JSON.parse(row.provenance);
  assert.deepEqual(prov.message_ids, ['msg:100'], '溯源必须指向原始消息，不是抽取任务');
  assert.ok(prov.extract_task_id, 'extract_task_id 要有（审计用）');
  assert.ok(JSON.parse(row.source_ref).locator === 'msg:100');

  // Markdown 侧（真相源）
  const md = await fs.readFile(r.results[0].path, 'utf8');
  assert.match(md, new RegExp(entryId));
  assert.match(md, /用户喜欢喝咖啡/);

  // prefetchEmbedding：四分类前上下文向量必须已在缓存里（R-79 的"必须就绪"）
  const hash = sha256('我跟你说我喜欢喝咖啡');
  assert.ok(
    kernel.db.prepare('SELECT 1 FROM embedding_cache WHERE text_hash = ?').get(hash),
    '上下文向量应该由 prefetch 预热进缓存',
  );
});

/* ─────────────────── 2. redundant：重复消息不新增条目 ─────────────────── */

test('四分类：同一偏好说两遍 → 第二次 redundant，不新增条目', async (t) => {
  const { kernel, root } = await boot({ llmOutputs: [cand(), cand()] });
  t.after(() => cleanup(kernel, root));

  const r1 = await kernel.extract({ sessionId: SESSION, text: '我喜欢喝咖啡', messageId: 'msg:1' });
  assert.equal(r1.results[0].status, 'written');

  const r2 = await kernel.extract({ sessionId: SESSION, text: '真的，我只喝咖啡', messageId: 'msg:2' });
  assert.equal(r2.results[0].status, 'redundant', '同 (subject, attribute, value) 必须走查表命中');
  assert.equal(r2.results[0].existingId, r1.results[0].entry.id);

  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, 1, '重复消息不许新增条目');

  // reinforce 的正确姿势：只记激活事件，等 dream 发奖励（不得直接改 persistence_at_decay）
  const before = kernel.db.prepare('SELECT persistence_at_decay p FROM entries').get().p;
  assert.equal(
    kernel.db.prepare(`SELECT COUNT(*) c FROM activation_events WHERE kind = 'reinforce'`).get().c,
    1,
  );
  await kernel.dream();
  const after = kernel.db.prepare('SELECT persistence_at_decay p, activation_count a FROM entries').get();
  assert.ok(after.p > before, 'dream 结算后 reinforce 要兑现成 persistence');
  assert.equal(after.a, 1);
});

test('四分类：同 (subject, attribute) 换了值 → update，取代边落盘', async (t) => {
  const { kernel, root } = await boot({
    llmOutputs: [
      cand({ text: '用户喜欢喝咖啡，每天两杯' }),
      cand({ text: '用户现在改喝茶了，不喝咖啡', triples: [{ subject: '用户', attribute: '偏好', value: '茶' }] }),
    ],
  });
  t.after(() => cleanup(kernel, root));

  const r1 = await kernel.extract({ sessionId: SESSION, text: '我喜欢喝咖啡', messageId: 'msg:1' });
  const r2 = await kernel.extract({ sessionId: SESSION, text: '我现在改喝茶了', messageId: 'msg:2' });
  assert.equal(r2.results[0].status, 'updated');

  const oldRow = kernel.db.prepare('SELECT superseded_by, gamma_multiplier FROM entries WHERE id = ?')
    .get(r1.results[0].entry.id);
  assert.equal(oldRow.superseded_by, r2.results[0].entry.id, '旧条目必须被新值取代（持久边）');
  assert.equal(oldRow.gamma_multiplier, 3.0);
});

/* ─────────────────── 3. 配额满 → pending → 恢复后消费 ─────────────────── */

test('配额：满额进 pending，恢复后消费（消费的候选同样过四分类）', async (t) => {
  const { kernel, root } = await boot({
    quota: 1,
    llmOutputs: [
      cand({ text: '用户喜欢喝咖啡', triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }] }),
      cand({ text: '用户住在杭州', triples: [{ subject: '用户', attribute: '居住地', value: '杭州' }] }),
      cand({ text: '用户养了一只猫', triples: [{ subject: '用户', attribute: '宠物', value: '猫' }] }),
    ],
  });
  t.after(() => cleanup(kernel, root));

  const r1 = await kernel.extract({ sessionId: SESSION, text: '我喜欢喝咖啡', messageId: 'msg:1' });
  assert.equal(r1.results[0].status, 'written');
  const r2 = await kernel.extract({ sessionId: SESSION, text: '我住在杭州', messageId: 'msg:2' });
  assert.equal(r2.results[0].status, 'pending', '第二条撞配额，必须进暂存而不是硬写');

  // 配额没恢复：drain 一次也不该写（满了就停，不越权）
  const blocked = await kernel.drainPending('qq-group');
  assert.equal(blocked['qq-group'].blocked, true);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, 1);

  // 跨日（配额按本地日切）→ 恢复 → FIFO 消费
  kernel.db.prepare('DELETE FROM quotas').run();
  const drained = await kernel.drainPending('qq-group');
  assert.equal(drained['qq-group'].consumed, 1);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, 2);
  const texts = kernel.db.prepare('SELECT text FROM entries ORDER BY text').all().map((x) => x.text);
  assert.ok(texts.includes('用户住在杭州'), '消费的候选要真的落盘');
});

/* ─────────────────── 4. 低效用与坏输出 ─────────────────── */

test('isUseful：闲聊候选进 stash 留审计，不落 Markdown', async (t) => {
  const { kernel, root } = await boot({ llmOutputs: [JSON.stringify([{ text: '哈哈哈', entry_type: 'fact' }])] });
  t.after(() => cleanup(kernel, root));

  const r = await kernel.extract({ sessionId: SESSION, text: '哈哈哈', messageId: 'msg:1' });
  assert.equal(r.results[0].status, 'low-utility');
  assert.equal(r.results[0].reason, 'too-short');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, 0);
  assert.match(await readAudit(root, 'low-utility.log'), /too-short/);
});

test('LLM 输出坏 JSON：重试一次后放弃，写 audit，不崩、不落库', async (t) => {
  const { kernel, root, calls } = await boot({ llmOutputs: ['抱歉我不能输出 JSON', '还是不行'] });
  t.after(() => cleanup(kernel, root));

  const r = await kernel.extract({ sessionId: SESSION, text: '我喜欢喝咖啡', messageId: 'msg:1' });
  assert.equal(r.candidates, 0);
  assert.deepEqual(r.results, []);
  assert.equal(calls(), 2, '恰好重试一次，不能无限重试');
  assert.match(await readAudit(root, 'extract-failed.log'), /extract-failed|error/i);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) c FROM entries').get().c, 0);
});

test('未注入 llm 时 extract 给出可落地的报错，remember 不受影响', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-nollm-'));
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'qq-group', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  t.after(async () => {
    await kernel.close();                     // 先关库再删目录（Windows 句柄）
    await fs.rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => kernel.extract({ sessionId: SESSION, text: 'x' }),
    /需要先打开 LLM 接入|需要注入 LLM/,
    '报错要告诉调用方两条路：打开 LLM 接入（或注入 llm），或改用 remember',
  );

  const r = await kernel.remember({
    domainId: 'qq-group', text: '用户喜欢喝咖啡，每天两杯', entryType: 'fact', topicTags: ['偏好'],
    triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }],
    sourceRef: { adapter_id: 'qq-group', locator: 'msg:m' },
    provenance: { session_id: SESSION, message_ids: ['msg:m'], extract_task_id: 'p0a-manual', model_version: 'manual', extracted_at: Date.now(), source_content_hash: '' },
  });
  assert.equal(r.status, 'written');
});

/* ─────────────────── 5. 解析与清洗（单元）─────────────────── */

test('解析：剥围栏、容忍前后废话与裸对象', () => {
  assert.deepEqual(
    parseCandidatesJson('```json\n[{"text":"a"}]\n```'),
    [{ text: 'a' }],
  );
  assert.deepEqual(
    parseCandidatesJson('好的，以下是抽取结果：\n[{"text":"a"},{"text":"b"}]\n希望有帮助'),
    [{ text: 'a' }, { text: 'b' }],
  );
  assert.deepEqual(parseCandidatesJson('{"text":"a"}'), [{ text: 'a' }]);
  assert.throws(() => parseCandidatesJson('我说不好'), /没有 JSON/);
  assert.throws(() => parseCandidatesJson('[{"text":'), /不完整|JSON/);
});

test('清洗：非法字段丢弃、entryType 归位 fact、坏 triple 剔除、数量封顶', () => {
  const raw = [
    null,                                                    // 非对象 → 丢
    '我是字符串',                                             // → 丢
    { text: '  合法候选  ', entry_type: 'gossip', topic_tags: ['a', 3, 'b'], triples: '不是数组' },
    { text: '', triples: [] },                               // 空 text → 丢
    {
      text: '带坏三元组的候选',
      triples: [
        { subject: 's', attribute: 'a' },                    // 缺 value → 丢
        { subject: 's', attribute: 'a', value: 'v' },        // 合法
        '垃圾',                                               // → 丢
      ],
    },
  ];
  // 塞满到超限：只取前 MAX_CANDIDATES 条合法的
  for (let i = 0; i < 20; i++) raw.push({ text: `填充 ${i}` });

  const out = sanitizeCandidates(raw);
  assert.equal(out.length <= 8, true, '单任务候选必须有上限');
  const first = out[0];
  assert.equal(first.text, '合法候选');
  assert.equal(first.entryType, 'fact', '非法 entry_type 归位 fact，而不是丢掉整条');
  assert.deepEqual(first.topicTags, ['a', 'b'], '非字符串标签剔除');
  assert.deepEqual(first.triples, [], 'triples 不是数组 → 空');
  const bad = out.find((x) => x.text === '带坏三元组的候选');
  assert.deepEqual(bad.triples, [{ subject: 's', attribute: 'a', value: 'v' }]);
});

/* ─────────────────── 6. uncertain 阈值路由（桩掉向量路）─────────────────── */

test('四分类：向量兜底的相似度落在 (uncertain, redundant) 之间 → uncertain 挂起', async (t) => {
  const { kernel, root } = await boot({ llmOutputs: [cand({ triples: [] })] });  // 无三元组 → 只能走向量兜底
  t.after(() => cleanup(kernel, root));

  const target = '01AAAAAAAAAAAAAAAAAAAAAAAAAA';
  kernel.db.prepare(`INSERT INTO entries(id, domain_id, entry_type, text, topic_tags, triples, evidence_links,
                      source_ref, provenance, observed_at, recorded_at, persistence_init, last_decay_at,
                      persistence_at_decay, gamma_multiplier, activation_count, trust_prior_logit,
                      trust_posterior_logit, trust_updated_at, identity_scope, sensitivity)
                      SELECT ?, 'qq-group', 'fact', '用户喜欢喝咖啡，晚上也经常睡不着', '[]', '[]', '[]', '{}', '{}', 1, 1, 0.5, 1, 0.5, 1, 0, 0, 0, 1, 'domain', 'normal'`)
    .run(target);
  // 桩掉向量检索：相似度卡在两档之间（0.80 < 0.85 < 0.92）
  kernel.vec.search = () => [{ id: target, score: 0.85 }];

  const route = await kernel.write.classifyNovelty(
    { text: '用户喜欢喝咖啡', triples: [], topicTags: [] },
    kernel.domains.get('qq-group'),
  );
  assert.equal(route.kind, 'uncertain');
  assert.equal(route.existingId, target);

  const r = await kernel.extract({ sessionId: SESSION, text: '我喜欢喝咖啡', messageId: 'msg:9' });
  assert.equal(r.results[0].status, 'uncertain');
  assert.ok(
    kernel.db.prepare(`SELECT 1 FROM consolidation_signals WHERE kind = 'uncertain_merge'`).get(),
    'uncertain 要留巩固信号（P3+ 的 merge 队列以此为输入）',
  );
  assert.ok(
    kernel.db.prepare(`SELECT 1 FROM pending_candidates WHERE payload LIKE '%用户喜欢喝咖啡%'`).get(),
    '候选进暂存保留，不丢',
  );
});

/* ─────────────────── 待定池对账（死水防波堤）───────────────────
 * 真实事故：待定池躺着"芝麻开门是暗号"（正确理解，pending），另一会话写
 * "想吃芝麻开门"畅通进正库顶掉真计划——pending 不入索引，后续写入撞不见它。
 * 修法：向量路由前逐条对账——高相似提升删除；疑似冲突（实体重叠）双发+标记。
 * 绝不自动覆盖任何一方（"想吃鱼"与"芝麻开门是暗号"可能同时成立，裁决权在人与 Agent）。
 */
function insertPending(kernel, domainId, text) {
  kernel.db.prepare(`INSERT INTO pending_candidates(domain_id, payload, enqueued_at, expire_at)
                     VALUES (?, ?, ?, ?)`).run(domainId, JSON.stringify({ domainId, text }), Date.now(), Date.now() + 864e5);
}

test('待定池对账：高相似 → 提升（删除待定行），不再死水', async (t) => {
  const { kernel, root } = await boot({});
  t.after(() => cleanup(kernel, root));
  insertPending(kernel, 'qq-group', '用户想吃火锅，点名某火锅店（2026-10-27 傍晚）。');

  // 桩嵌入：候选与 pending 同向量 → sim=1 > redundant → 提升分支
  const vSame = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
  kernel.vec.embedTexts = async (texts) => texts.map(() => vSame.slice());
  kernel.vec.search = () => [];

  const route = await kernel.write.classifyNovelty(
    { text: '想吃某火锅店火锅', triples: [], topicTags: [] },
    kernel.domains.get('qq-group'),
  );
  assert.equal(route.kind, 'new');
  assert.ok(!kernel.db.prepare(`SELECT 1 FROM pending_candidates WHERE payload LIKE '%某火锅店%'`).get(),
    '高相似的 pending 应被提升删除（其事实由新候选正式入库）');
});

test('待定池对账：疑似冲突 → 双发 + pending-conflict 标记，绝不自动覆盖', async (t) => {
  const { kernel, root } = await boot({});
  t.after(() => cleanup(kernel, root));
  insertPending(kernel, 'qq-group', '用户想吃芝麻开门，某火锅店那类。');

  // 桩嵌入：候选(含"暗号")与 pending 夹角 0.85 ∈ (uncertain, redundant) → 冲突分支
  const vA = Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
  const vB = Array.from({ length: DIM }, (_, i) => (i === 1 ? 0.53 : 0));
  vB[0] = 0.85;   // cos(vA, vB) ≈ 0.85
  kernel.vec.embedTexts = async (texts) => texts.map((tx) => (tx.includes('暗号') ? vB.slice() : vA.slice()));
  kernel.vec.search = () => [];

  const route = await kernel.write.classifyNovelty(
    { text: '芝麻开门是用户和助手的暗号', triples: [], topicTags: [] },
    kernel.domains.get('qq-group'),
  );
  assert.equal(route.kind, 'new', '冲突场景不改变路由（双发，新候选照常走分类）');
  assert.ok(kernel.db.prepare(`SELECT 1 FROM pending_candidates WHERE payload LIKE '%芝麻开门%'`).get(),
    '疑似冲突时 pending 必须保留（不自动覆盖任何一方）');
  assert.ok(kernel.db.prepare(`SELECT 1 FROM consolidation_signals WHERE kind = 'pending-conflict'`).get(),
    '冲突要留信号（dream/组装层以此为输入提示裁决）');
});

/**
 * P2 代码项验收：FTS optimize 触发条件、身份分叉采集、verified 链路上线、
 * detectVerified 的否定守卫（评测发现的最小修正）。
 *
 * 评测 harness 本体在 eval/run.js（产出 eval/report.md），不进 npm test；
 * 这里只验代码行为，每个用例秒级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { detectVerified } from '../src/core/security.js';
import { loadConfig } from '../src/config.js';

const DIM = 64;
const SESSION = 'qq-group:8823';

const prov = (locator) => ({
  session_id: SESSION, message_ids: [locator], extract_task_id: 'p2-test',
  model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
});

async function boot(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-p2-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      ...overrides,
    },
    domains: [defineDomain({ id: 'qq-group', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM),
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

/* ───────────── 9a：FTS optimize 有触发条件，不是每轮都跑 ───────────── */

test('FTS optimize：删改攒够才跑，跑完清零；没删改就跳过', async (t) => {
  const { kernel, root } = await boot({
    dream: { steps: { ftsOptimize: true }, ftsOptimizeEveryDeletes: 1 },
  });
  t.after(() => cleanup(kernel, root));

  // 三次"换值更新" = 三次 FTS 删改（update 路径重写旧条目的 FTS 行）
  await remember(kernel, '用户喜欢喝咖啡', '咖啡', 'm1');
  await remember(kernel, '用户改喝茶了', '茶', 'm2');
  await remember(kernel, '用户改喝牛奶了', '牛奶', 'm3');

  const d1 = await kernel.dream();
  assert.equal(d1.steps.s9a.optimized, true, '删改 > 阈值 → 本轮必须 optimize');
  assert.ok(d1.steps.s9a.deletesSinceLast >= 2);

  const d2 = await kernel.dream();
  assert.equal(d2.steps.s9a.skipped, 'no-need', '刚 optimize 完、无新增删改 → 不许空转');

  // 再攒两次删改 → 重新触发（间隔条件的另一侧由 lastOptimizeAt 置位保证，不靠假时钟）
  await remember(kernel, '用户改喝果汁了', '果汁', 'm4');
  await remember(kernel, '用户改喝气泡水了', '气泡水', 'm5');
  const d3 = await kernel.dream();
  assert.equal(d3.steps.s9a.optimized, true);
});

/* ───────────── 第 10 步：身份分叉采集（P2 采集告警，P3+ 人工对齐）───────────── */

test('身份指标：同 (subject, attribute) 存活多个值 → 分叉告警；被取代后消失', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  // 默认配置下四分类开着：两条同 (s,a) 不同值，第一条本会被 update 取代。
  // 这里直接绕过四分类造"两个活值"的分叉现场（bypass 语义）。
  const savedBypass = kernel.cfg.write.p0aBypassRouting;
  kernel.cfg.write.p0aBypassRouting = true;
  await remember(kernel, '用户喜欢喝咖啡', '咖啡', 'f1');
  await remember(kernel, '用户喜欢喝茶', '茶', 'f2');
  kernel.cfg.write.p0aBypassRouting = savedBypass;

  const d1 = await kernel.dream();
  assert.equal(d1.steps.s10.skipped, undefined, 'P2 默认开启');
  assert.ok(d1.steps.s10.forkedGroups >= 1, '两个活值必须被判为分叉');

  const row = kernel.db.prepare('SELECT domain_id, alert, metrics FROM identity_metrics').get();
  assert.equal(row.alert, 1);
  const metrics = JSON.parse(row.metrics);
  assert.ok(metrics.forkedGroups >= 1 && metrics.worst.values_cnt >= 2);

  // 被取代的旧值不算分叉：制造取代边（update 路径的真实产物）
  const newest = kernel.db.prepare(
    "SELECT id FROM entries WHERE superseded_by IS NULL ORDER BY recorded_at DESC LIMIT 1",
  ).get();
  kernel.db.prepare('UPDATE entries SET superseded_by = ? WHERE id != ? AND domain_id = ?')
    .run(newest.id, newest.id, 'qq-group');
  const d2 = await kernel.dream();
  // 注意：没有分叉的轮次**不写新行**（identity_metrics 只在有告警时落），所以要读本轮的步结果
  assert.equal(d2.steps.s10.forkedGroups, 0, '取代边收口后，分叉必须消失');
  assert.equal(d2.steps.s10.domains, 0);
});

/* ───────────── verified 链路（P2 打开）：trust 后验真的会动 ───────────── */

test('verified：确认语句推高 trust，窗口内最多计 3 次，命中不推 trust（ADR-11）', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  await remember(kernel, '用户喜欢喝咖啡，每天两杯', '咖啡', 'm1');

  const prior = kernel.db.prepare('SELECT trust_prior_logit p, trust_posterior_logit post FROM entries').get();
  assert.equal(prior.post, prior.p, '写入后后验恒等于先验');

  const r = await kernel.search({ sessionId: SESSION, query: '咖啡' });
  assert.ok(r.entries.length >= 1);
  const beforeActs = kernel.db.prepare(
    "SELECT COUNT(*) c FROM activation_events WHERE kind = 'retrieval'",
  ).get().c;

  for (let i = 1; i <= 4; i++) {
    await kernel.postStep({ sessionId: SESSION, requestId: r.requestId, userMessage: '对，就是这条' });
  }

  const after = kernel.db.prepare('SELECT trust_posterior_logit post FROM entries').get();
  assert.ok(after.post > prior.post, 'verified 必须把后验推过先验');
  assert.equal(
    kernel.db.prepare("SELECT COUNT(*) c FROM activation_events WHERE kind = 'verified'").get().c,
    3, '同一窗口最多 3 次（防口头禅式反复确认）',
  );
  assert.equal(
    kernel.db.prepare("SELECT COUNT(*) c FROM activation_events WHERE kind = 'retrieval'").get().c,
    beforeActs, 'search 本身只记 retrieval，postStep 不额外发奖励',
  );
  // retrieval_log 现在有读者了（verifiedEnabled=true → 写入侧门打开）
  assert.ok(kernel.db.prepare('SELECT COUNT(*) c FROM retrieval_log').get().c >= 1);
});

/* ───────────── detectVerified 的否定守卫（P2 评测修正）───────────── */

test('detectVerified：否定用法不算确认（评测发现的裸"对"误报）', () => {
  const cfg = loadConfig({});
  // 正例（要触发）
  for (const m of ['对，就是这个', '是的，没错，就是上次说的', '你说的对，就是这条']) {
    assert.equal(detectVerified(m, cfg), true, m);
  }
  // 负例（绝不能触发，尤其前四条：裸"对/没错"的否定用法）
  for (const m of ['这个不对', '你说的不对', '这条不对吧', '不是这个', '这个不是',
    '好的', '嗯嗯', '这个怎么用？', '上面那个对吗？', '今天天气不错']) {
    assert.equal(detectVerified(m, cfg), false, m);
  }
});

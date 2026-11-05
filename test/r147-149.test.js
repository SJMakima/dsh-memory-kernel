/**
 * 【R-147 / R-148 / R-149】时间范围召回 + 组装层冲突提示 + 候选确认池。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseTimeRange } from '../src/pure/dayparse.js';
import { classifyIntent, PLANS } from '../src/pure/ranking.js';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const DIM = 32;

async function boot(t, { confirmGate = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-r147-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true, confirmGate: { enabled: confirmGate } },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

const mk = (kernel, text, daysAgo = 0) => {
  const at = (() => { const d = new Date(Date.now() - daysAgo * 864e5); d.setHours(12, 0, 0, 0); return d.getTime(); })();
  return kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'], observedAt: at,
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: at, source_content_hash: '' },
  });
};

/* ── R-147：parseTimeRange ── */

test('parseTimeRange：显式时间词解析出区间；"上次说的"不认', (t) => {
  const now = new Date('2026-10-29T15:00:00').getTime();   // 周四
  const r1 = parseTimeRange('上周说的那个事', now);
  assert.ok(r1 && r1.end - r1.start === 7 * 864e5, `上周区间 7 天，got ${JSON.stringify(r1)}`);
  const r2 = parseTimeRange('上个月干了什么', now);
  assert.ok(r2 && r2.matched.includes('上个月'), '上个月命中');
  assert.equal(new Date(r2.start).getDate(), 1, '上个月从 1 号起');
  const r3 = parseTimeRange('最近三天吃了什么', now);
  assert.ok(r3 && Math.round((r3.end - r3.start) / 864e5) >= 3, '最近三天');
  const r4 = parseTimeRange('三天前那天说了什么', now);
  assert.ok(r4 && r4.end - r4.start === 864e5, '三天前是单日');
  assert.equal(parseTimeRange('上次说的那个事', now), null, '上次不算显式时间词');
  assert.equal(parseTimeRange('后来那次呢', now), null, '后来那次不认');
});

test('R-147：temporal 意图判定 + 区间外条目被滤、区间内不足时放宽', async (t) => {
  const { kernel } = await boot(t);
  await mk(kernel, '上周一项目开了 kickoff 会', 9);   // 9 天前（上周附近）
  await mk(kernel, '今天刚改完测试报告', 0);          // 今天（区间外，若查上周）
  const intent = classifyIntent('上周说了哪些事', { subjects: [] });
  assert.equal(intent, 'temporal', '显式时间词 + 区间可解析 → temporal');
  assert.ok(PLANS.temporal, 'temporal plan 存在');

  const r = await kernel.search({ sessionId: 'da:s1', query: '上周说了哪些事' });
  assert.equal(r.intent, 'temporal');
  assert.ok(r.timeRange, '结果带 timeRange');
  const texts = (r.entries ?? []).map((e) => e.text);
  assert.ok(texts.some((x) => x.includes('kickoff')), '区间内条目命中');
  // 今天那条 observed_at 在区间外：若区间内条目 ≥ k(8) 会滤掉——这里总数 2 < 8 → 放宽保留
  assert.ok(texts.some((x) => x.includes('测试报告')), '区间内不足 k 时放宽，不清空');
});

test('R-147：区间内足够多时，区间外被硬滤', async (t) => {
  const { kernel } = await boot(t);
  for (let i = 0; i < 9; i++) await mk(kernel, `本周条目 ${i} 的内容记录`, i * 0.2);   // 全在本周内
  await mk(kernel, '很早以前的一条旧记录', 60);
  const r = await kernel.search({ sessionId: 'da:s1', query: '本周都干了什么' });
  const texts = (r.entries ?? []).map((e) => e.text);
  assert.ok(texts.some((x) => x.includes('本周条目')), '区间内命中');
  assert.ok(!texts.some((x) => x.includes('很早以前')), '区间外被硬滤（区间内已足够）');
});

/* ── R-148：组装层冲突提示 ── */

test('R-148：conflict 信号带明细、组装动态段出现提示、s11 不吞提示型信号', async (t) => {
  const { kernel } = await boot(t);
  // 模拟 s14 产物
  kernel.write.recordConsolidationSignal('cross-entry-conflict', 'da', 1.0, {
    aText: '用户喜欢蓝色', bText: '用户讨厌蓝色', note: '对颜色偏好互斥',
  });
  const r = await kernel.search({ sessionId: 'da:s1', query: '我喜欢什么颜色' });
  const dyn = typeof r === 'object' ? null : null;
  // 动态段经 preStep 组装——直接调
  const pre = await kernel.preStep({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '我喜欢什么颜色' }],
  });
  if (pre.skipped) assert.fail(`preStep 被跳过：${pre.skipped}`);
  assert.ok(pre.dynamic.includes('记忆冲突提示'), '动态段含冲突提示标题');
  assert.ok(pre.dynamic.includes('用户喜欢蓝色'), '提示带明细 A');
  assert.ok(pre.dynamic.includes('用户讨厌蓝色'), '提示带明细 B');

  // s11 消费不吞提示型：跑 dream 后信号仍在（供下外审提示）
  await kernel.dream();
  const left = kernel.db.prepare("SELECT COUNT(*) c FROM consolidation_signals WHERE kind = 'cross-entry-conflict' AND consumed = 0").get().c;
  assert.equal(left, 1, '提示型信号不被 s11 吞掉');
});

/* ── R-149：候选确认池 ── */

test('R-149：闸门关 = 老双发行为；闸门开 = uncertain 只进确认池不落库', async (t) => {
  const { kernel: kOff } = await boot(t, { confirmGate: false });
  const { kernel: kOn } = await boot(t, { confirmGate: true });
  const candidate = (k, text = '一条拿不准的候选：可能与旧账冲突的内容') => ({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  // 闸门关：uncertain 路由会走 handleUncertain——直接调 write 管线模拟（routes 由 classifyNovelty 决定，
  // 这里为了确定性直接验证 handleUncertain 的行为面：确认池表 reason 字段）
  const routeUncertain = { kind: 'uncertain', existingId: 'whatever' };
  const off = await kOff.write.handleUncertain(candidate(kOff), routeUncertain, kOff.domains.get('da'));
  assert.equal(off.status, 'uncertain', '关闸 = 老行为');
  const on = await kOn.write.handleUncertain(candidate(kOn), routeUncertain, kOn.domains.get('da'));
  assert.equal(on.status, 'pending-confirm', '开闸 = 进确认池');
  assert.ok(!kOn.db.prepare("SELECT COUNT(*) c FROM entries WHERE text LIKE '%拿不准的候选%'").get().c, '开闸时没有直写 entries');

  const queue = kOn.write.confirmQueue();
  assert.equal(queue.length, 1, '确认队列有一条');
  assert.equal(queue[0].reason ?? 'confirm', 'confirm');

  // 确认 → 落库 + reinforce 激活
  const ap = await kOn.write.confirmApprove(queue[0].id);
  assert.equal(ap.ok, true, '确认成功');
  const row = kOn.db.prepare('SELECT id FROM entries WHERE text LIKE ?').get('%拿不准的候选%');
  assert.ok(row, '确认后正式入库');
  const act = kOn.db.prepare("SELECT COUNT(*) c FROM activation_events WHERE entry_id = ? AND kind = 'reinforce'").get(row.id).c;
  assert.equal(act, 1, '确认写 reinforce 激活（不对称持久化）');
  assert.equal(kOn.write.confirmQueue().length, 0, '队列清空');

  // 拒绝 → 删 + audit，不落库
  const cand2 = candidate(kOn, '第二条拿不准的候选：换一个文本便于断言');
  await kOn.write.handleUncertain(cand2, routeUncertain, kOn.domains.get('da'));
  const q2 = kOn.write.confirmQueue();
  const rj = await kOn.write.confirmReject(q2[0].id, '用户说不用记');
  assert.equal(rj.ok, true);
  assert.ok(!kOn.db.prepare('SELECT id FROM entries WHERE text LIKE ?').get('%第二条拿不准%'), '拒绝不落库');
  assert.equal(kOn.write.confirmQueue().length, 0);
});

test('R-149：drainPending 不消化 confirm 池（闸门不白装）', async (t) => {
  const { kernel } = await boot(t, { confirmGate: true });
  await kernel.write.handleUncertain(
    { domainId: 'da', text: '待确认的候选内容，足够长避免低效用', entryType: 'fact', topicTags: ['测试'], sourceRef: { adapter_id: 'da', locator: 't' }, provenance: { session_id: 's', message_ids: [], extract_task_id: 'x', model_version: 't', extracted_at: Date.now(), source_content_hash: '' } },
    { kind: 'uncertain', existingId: 'x' }, kernel.domains.get('da'),
  );
  const r = await kernel.write.drainPending(kernel.domains.get('da'));
  assert.equal(r.consumed, 0, 'confirm 行不被 drain 吃掉');
  assert.equal(kernel.write.confirmQueue().length, 1, '仍在队列等人裁决');
});

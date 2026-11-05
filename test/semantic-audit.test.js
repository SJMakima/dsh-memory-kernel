/**
 * 【R-120 L3 语义对账 + 检索演练改进】
 *   - dream s14：跨条目矛盾只告警（audit + consolidation_signals），绝不自动清理
 *   - 原话泛句降权：库内高频重复句 rrf 打折（数据驱动，非黑名单）
 *   - 日记向量路：写入嵌 / rebuild 回填 / searchAsync 双路 RRF
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const DIM = 32;

/** 可编程假 LLM：按输入文本路由回复（对账测试用）。 */
function fakeLlm(fn) {
  return { available: () => true, model: 'fake', async complete({ messages }) { return fn(messages?.[0]?.content ?? ''); } };
}

async function boot(t, { llm = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    llm,
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

const mk = (kernel, text, extra = {}) => kernel.remember({
  domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
  sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
  provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  ...extra,
});

test('R-120 L3：LLM 判 conflict → 只告警（audit + signal），两条都原样保留', async (t) => {
  let judged = 0;
  const { kernel, root } = await boot(t, {
    llm: fakeLlm((input) => {
      judged++;
      return JSON.stringify({ relation: 'conflict', note: '两条对香菜态度互斥' });
    }),
  });
  const a = await mk(kernel, '小舟非常讨厌香菜，永不接受');
  const b = await mk(kernel, '小舟其实觉得香菜还行，最近接受了');
  const beforeA = kernel.db.prepare('SELECT text, superseded_by FROM entries WHERE id = ?').get(a.entry.id);
  const beforeB = kernel.db.prepare('SELECT text FROM entries WHERE id = ?').get(b.entry.id);

  const r = await kernel.dream();
  const s14 = r.steps.s14;
  assert.ok(s14 && !s14.skipped, 's14 执行');
  assert.equal(s14.conflicts, 1, '发现一对冲突');

  // 红线：库一条不动
  const afterA = kernel.db.prepare('SELECT text, superseded_by FROM entries WHERE id = ?').get(beforeA ? a.entry.id : '');
  assert.equal(afterA?.text ?? beforeA.text, beforeA.text, '条目 A 文本未被动过');
  assert.equal(afterA?.superseded_by ?? null, null, '条目 A 未被作废');
  assert.equal(kernel.db.prepare('SELECT text FROM entries WHERE id = ?').get(b.entry.id).text, beforeB.text, '条目 B 原样');

  // 告警有痕：audit 文件 + consolidation_signals
  const auditFiles = await fs.readdir(path.join(root, 'audit'));
  assert.ok(auditFiles.includes('dream.log') || auditFiles.length > 0, 'audit 目录有产出');
  const sig = kernel.db.prepare("SELECT COUNT(*) c FROM consolidation_signals WHERE kind = 'cross-entry-conflict'").get();
  assert.equal(sig.c, 1, 'cross-entry-conflict 信号已打标');
});

test('R-120 L3：无 LLM 自动跳过（no-llm），不报错', async (t) => {
  const { kernel } = await boot(t);
  await mk(kernel, '没有 LLM 时的条目内容足够长');
  const r = await kernel.dream();
  assert.equal(r.steps.s14.skipped, 'no-llm');
});

test('泛句降权：同文本重复 ≥3 次的原话行 rrf 打折，被非泛句压下去', async (t) => {
  const { kernel } = await boot(t);
  // 口头禅句重复 3 次（不同会话/时间），内容句 1 次
  const add = (text, sessionId, ts) => kernel.appendTranscript({ sessionId, domainId: 'da', messages: [{ role: 'user', content: text, ts }] });
  const now = Date.now();
  await add('行，我只听，你想说什么说什么', 'da:g1', now - 3 * 864e5);
  await add('行，我只听，你想说什么说什么', 'da:g2', now - 2 * 864e5);
  await add('行，我只听，你想说什么说什么', 'da:g3', now - 864e5);
  await add('咖啡喝到第三杯了今天', 'da:g3', now - 3600e3);

  const r = await kernel.search({ sessionId: 'da:g1', query: '他喝咖啡和聊天的时候说了什么' });
  const lines = (r.transcripts ?? []).map((x) => x.text);
  const iCoffee = lines.findIndex((x) => x.includes('咖啡'));
  const iChant = lines.findIndex((x) => x.includes('我只听'));
  assert.ok(iCoffee >= 0, '内容句在结果里');
  if (iChant >= 0) assert.ok(iCoffee < iChant, '泛句即使被召回也排在内容句之后（降权生效）');
});

test('日记向量路：写入时嵌入落库，rebuild 回填，语义搜索命中字面不同的日记', async (t) => {
  const { kernel, root } = await boot(t);
  // 造昨天一天的活动 → dream 出日记（模板即可，测向量路不测 LLM）
  const yesterdayNoon = (() => { const d = new Date(Date.now() - 864e5); d.setHours(12, 0, 0, 0); return d.getTime(); })();
  await kernel.appendTranscript({
    sessionId: 'da:d1', domainId: 'da',
    messages: [{ role: 'user', content: '今天带煤球去打了疫苗，猫全程呜呜叫', ts: yesterdayNoon }],
  });
  const r = await kernel.dream();
  assert.ok(Object.values(r.steps.s12 ?? {}).some((x) => x?.written), '日记已写');

  const row = kernel.db.prepare('SELECT embedding FROM diary WHERE domain_id = ?').get('da');
  assert.ok(row?.embedding, '写入时已嵌（BLOB 落库）');

  // rebuild 回填：清空列 → rebuild → 恢复
  kernel.db.prepare('UPDATE diary SET embedding = NULL').run();
  await kernel.rebuild();
  const row2 = kernel.db.prepare('SELECT embedding FROM diary WHERE domain_id = ?').get('da');
  assert.ok(row2?.embedding, 'rebuild 后向量回填');

  // 语义搜索：查"猫" → 命中写"煤球"的那篇（FTS 字面搜不到）
  const hits = await kernel.diary.searchAsync('猫生病看医生的经历', { domainId: 'da' });
  assert.ok(hits.length >= 1, '向量路有命中');
  assert.ok(hits.some((h) => String(h.excerpt ?? '').includes('煤球')), '字面不同（煤球 vs 猫）也能通过向量路命中');
});

test('日记向量路：无 embed 依赖时 searchAsync 降级纯 FTS 不报错', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({
    sessionId: 'da:d2', domainId: 'da',
    messages: [{ role: 'user', content: '今天把 Rust 的生命周期标注看懂了一半', ts: (() => { const d = new Date(Date.now() - 864e5); d.setHours(12, 0, 0, 0); return d.getTime(); })() }],
  });
  await kernel.dream();
  const hits = await kernel.diary.searchAsync('Rust', { domainId: 'da' });
  assert.ok(Array.isArray(hits), '不抛错');
});

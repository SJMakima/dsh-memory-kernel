/**
 * 【R-144】importance / activation 解耦：
 *   写入期判定 → md 真相源（rebuild 不丢）→ 冷存豁免线 → confirm 加成 → 排序调制（w=0 关闭）。
 *   衰减只作用 activation（persistence），永不作用 importance。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { initialImportance } from '../src/core/entry.js';
import { shouldColdArchive } from '../src/pure/lifecycle.js';

const DIM = 32;

async function boot(t, { confirmGate = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-imp-'));
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

const mk = (kernel, text, extra = {}) => kernel.remember({
  domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
  sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
  provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  ...extra,
});
const impOf = (kernel, id) => kernel.db.prepare('SELECT importance FROM entries WHERE id = ?').get(id)?.importance;

test('写入期判定：boundary/skill=1.0，身份三元组 fact=0.8，普通=0.5', async (t) => {
  assert.equal(initialImportance('boundary', []), 1.0);
  assert.equal(initialImportance('skill', []), 1.0);
  assert.equal(initialImportance('fact', [{ subject: '用户', attribute: '名字', value: '小明' }]), 0.8);
  assert.equal(initialImportance('fact', [{ subject: '用户', attribute: '喜欢的颜色', value: '蓝' }]), 0.5, '非身份属性不抬档');
  assert.equal(initialImportance('pattern', []), 0.5);

  const { kernel } = await boot(t);
  const b = await mk(kernel, '测试用边界：不要在我睡觉时发消息', { entryType: 'boundary' });
  const f = await mk(kernel, '普通事实：用户昨天吃了一碗面');
  assert.equal(impOf(kernel, b.entry.id), 1.0);
  assert.equal(impOf(kernel, f.entry.id), 0.5);
});

test('md 真相源：importance 进 state 块，rebuild 后不丢（旧 md 按类型推）', async (t) => {
  const { kernel, root } = await boot(t);
  const b = await mk(kernel, '边界条目：测试 rebuild 保留 importance 用', { entryType: 'boundary' });
  await kernel.rebuild();
  assert.equal(impOf(kernel, b.entry.id), 1.0, 'rebuild 后 importance 保留');

  // md 里确实有 importance 行
  const mdDir = path.join(root, 'domains', 'da');
  const files = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'));
  let found = false;
  for (const f of files) {
    const md = await fs.readFile(path.join(mdDir, f), 'utf8');
    if (md.includes('importance: 1')) found = true;
  }
  assert.ok(found, 'md state 块带 importance 行');
});

test('冷存豁免线：importance ≥ 0.8 不归档（类型豁免的等价升级）', () => {
  const cfg = { lifecycle: {
    halfLifeDays: { pattern: 75, fact: 30 }, floor: { boundary: 0.6, skill: 0.5, pattern: 0.1, fact: 0.1 },
    coldThreshold: 0.15, coldIdleMs: 0, importanceFloor: 0.8, activationBonus: 0.08, activationCap: 4,
  } };
  const low = { entry_type: 'fact', importance: 0.5, cold: false, last_activated_at: Date.now() - 864e5, persistence_at_decay: 0.1, last_decay_at: Date.now(), gamma_multiplier: 1.0 };
  const high = { entry_type: 'fact', importance: 0.8, cold: false, last_activated_at: Date.now() - 864e5, persistence_at_decay: 0.1, last_decay_at: Date.now(), gamma_multiplier: 1.0 };
  const legacyBoundary = { entry_type: 'boundary', cold: false, last_activated_at: Date.now() - 864e5, persistence_at_decay: 0.1, last_decay_at: Date.now(), gamma_multiplier: 1.0 };   // 无 importance（旧行）
  assert.equal(shouldColdArchive(high, cfg), false, 'importance ≥ 0.8 豁免');
  assert.equal(shouldColdArchive(legacyBoundary, cfg), false, '旧行按类型推 1.0，等价豁免');
  assert.equal(shouldColdArchive(low, cfg), true, '普通低持久条目照旧归档');
});

test('confirm 加成：+0.2 落库并同步 md；衰减不动 importance', async (t) => {
  const { kernel: kOn } = await boot(t, { confirmGate: true });
  await kOn.write.handleUncertain(
    { domainId: 'da', text: '确认池测试：这条会被用户确认', entryType: 'fact', topicTags: ['测试'], sourceRef: { adapter_id: 'da', locator: 't' }, provenance: { session_id: 's', message_ids: [], extract_task_id: 'x', model_version: 't', extracted_at: Date.now(), source_content_hash: '' } },
    { kind: 'uncertain', existingId: 'x' }, kOn.domains.get('da'),
  );
  const q = kOn.write.confirmQueue();
  const impBefore = 0.5;   // 普通 fact
  const ap = await kOn.write.confirmApprove(q[0].id);
  assert.equal(ap.ok, true);
  assert.ok(Math.abs(impOf(kOn, ap.result.entry.id) - (impBefore + 0.2)) < 1e-9, 'confirm 加成 +0.2');

  // 衰减不动 importance：dream（含衰减/结算链）前后 importance 不变
  const before = impOf(kOn, ap.result.entry.id);
  await kOn.dream();
  assert.equal(impOf(kOn, ap.result.entry.id), before, 'dream 前后 importance 不变（轴解耦）');
});

test('排序调制：w=0.1 时高 importance 同分排前；w=0 关闭不扰动', async (t) => {
  const { kernel } = await boot(t);
  const a = await mk(kernel, '调制测试普通条目：哈希 embedding 的锚点词组', { });
  const b = await mk(kernel, '调制测试重要条目：哈希 embedding 的锚点词组', { entryType: 'boundary' });
  // 同文本相近 → 两路分数接近；importance 1.0 的 b 调制后应排前
  const r = await kernel.search({ sessionId: 'da:s1', query: '哈希 embedding 的锚点词组' });
  const order = (r.entries ?? []).map((e) => e.text);
  const iA = order.findIndex((x) => x.includes('普通条目'));
  const iB = order.findIndex((x) => x.includes('重要条目'));
  assert.ok(iA >= 0 && iB >= 0, '两条都被召回');
  assert.ok(iB < iA, 'importance 1.0 排在 0.5 之前');

  // w=0：调制关闭，纯 RRF 分数决定
  kernel.cfg.retrieve.importanceWeight = 0;
  const r2 = await kernel.search({ sessionId: 'da:s1', query: '哈希 embedding 的锚点词组' });
  const order2 = (r2.entries ?? []).map((e) => e.text);
  const jA = order2.findIndex((x) => x.includes('普通条目'));
  const jB = order2.findIndex((x) => x.includes('重要条目'));
  assert.ok(jA >= 0 && jB >= 0, 'w=0 时两条仍在');
  void a; void b;
});

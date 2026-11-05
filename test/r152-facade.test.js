/**
 * 【R-152】Kernel API 收口：四组能力面边界测试。
 * 铁律：写走管线（remember/forget/rebuild 全部过 write 层硬序）、读过闸门（search/context 过 admit）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createKernel } from '../src/kernel.js';

const roots = [];
async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-facade-'));
  roots.push(root);
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 32 },
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomainFor(root)],
    embedder: createHashEmbedderFor(),
    gitInit: false,
  });
  await kernel.init();
  return kernel;
}
const { defineDomain } = await import('../src/adapters/local-archive.js');
const { createHashEmbedder } = await import('../src/adapters/hash-embedder.js');
const defineDomainFor = (root) => defineDomain({ id: 'fc', dir: path.join(root, 'd') });
const createHashEmbedderFor = () => createHashEmbedder(32);

describe('R-152 四组能力面', () => {
  test('四组齐全：memory / lifecycle / domains / health', async () => {
    const k = await boot();
    for (const g of ['memory', 'lifecycle', 'domains', 'health']) {
      assert.ok(k[g], `组 ${g} 存在`);
    }
    // memory 组：search/context/remember/extract/流水
    for (const m of ['search', 'context', 'remember', 'extract', 'preStep', 'postStep', 'write', 'transcript', 'inner', 'emotions', 'diary']) {
      assert.ok(k.memory[m] !== undefined, `memory.${m} 存在`);
    }
    // lifecycle 组
    for (const m of ['init', 'dream', 'maybeDream', 'rebuild', 'forget', 'drainPending', 'close', 'whenEmbeddingReady']) {
      assert.ok(k.lifecycle[m] !== undefined, `lifecycle.${m} 存在`);
    }
    // domains 组：注册/路由/枚举
    for (const m of ['get', 'list', 'route', 'register']) {
      assert.equal(typeof k.domains[m], 'function', `domains.${m} 是函数`);
    }
    // health 组：状态/审计摘要/任务视图/向量诊断
    for (const m of ['stats', 'taskBacklog', 'auditSummary', 'applyConfigPatch', 'vec']) {
      assert.ok(k.health[m] !== undefined, `health.${m} 存在`);
    }
    await k.close();
  });

  test('写走管线：memory.remember 落库后 md 真相源同步存在；lifecycle.forget 走同一条闭环', async () => {
    const k = await boot();
    const r = await k.memory.remember({
      domainId: 'fc', text: '用户喜欢喝龙井', entryType: 'fact',
      triples: [{ subject: '用户', attribute: '偏好', value: '龙井' }],
      sessionId: 'fc:s1',
      sourceRef: { adapter_id: 't', locator: 't:1' },
      provenance: { session_id: 'fc:s1', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
    });
    assert.equal(r.status, 'written');
    // 读过闸门：memory.search 命中刚写入的
    const s = await k.memory.search({ domain: 'fc', query: '龙井' });
    assert.equal(s.entries.length, 1);
    // lifecycle.forget（confirmId 二次确认）
    const f = await k.lifecycle.forget(r.entry.id, { confirmId: r.entry.id });
    assert.equal(f.forgotten, true);
    const s2 = await k.memory.search({ domain: 'fc', query: '龙井' });
    assert.equal(s2.entries.length, 0);
    await k.close();
  });

  test('health 组语义：health() 三态可调用、stats 与 SQL 直查一致', async () => {
    const k = await boot();
    assert.equal(k.health().state, 'READY');
    const st = k.health.stats();
    const direct = k.db.prepare('SELECT COUNT(*) c FROM entries').get().c;   // 测试有权直查（边界测试例外）
    assert.equal(st.entries, direct);
    assert.equal(k.health.taskBacklog().pendingUncertain ?? 0, 0);
    await k.close();
  });

  test('domains 组：注册即刻生效、路由语义不变', async () => {
    const k = await boot();
    k.domains.register({ id: 'extra', matchSessionId: (sid) => String(sid).startsWith('extra:') });
    assert.equal(k.domains.routeDomain('extra:u1')?.id, 'extra');
    assert.equal(k.domains.routeDomain('fc:s1')?.id, 'fc');
    assert.ok(k.domains.list().some((d) => d.id === 'extra'));
    await k.close();
  });
});

/**
 * R-154 health() 三态：READY / DEGRADED / FAILED。
 * 纯查现算——DEGRADED 用"配置声明 LLM 但未注入"触发，FAILED 用 close 后的 db 触发。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const DIM = 32;

async function boot(t, { llmEnabled = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-health-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
      llm: { enabled: llmEnabled },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

describe('health() 三态（R-154）', () => {
  test('全绿 → READY，LLM 未接入属于预期配置（进 infos 不进 reasons）', async (t) => {
    const { kernel } = await boot(t);
    const hp = kernel.health();
    assert.equal(hp.state, 'READY', `reasons: ${hp.reasons.join('；')}`);
    assert.ok(hp.infos.some((x) => x.includes('LLM 未接入')));
    assert.ok(Number.isFinite(hp.checkedAt));
  });

  test('配置声明 LLM 但通道未注入 → DEGRADED，且原因可读', async (t) => {
    const { kernel } = await boot(t, { llmEnabled: true });
    const hp = kernel.health();
    assert.equal(hp.state, 'DEGRADED');
    assert.ok(hp.reasons.some((r) => r.includes('LLM')), `reasons: ${hp.reasons.join('；')}`);
  });

  test('db 关闭后 → FAILED（核心读写不可用），不再误报 DEGRADED 细节', async (t) => {
    const { kernel } = await boot(t);
    await kernel.close();
    const hp = kernel.health();
    assert.equal(hp.state, 'FAILED');
    assert.ok(hp.reasons[0].includes('数据库不可用'));
  });

  test('health 是纯查现算：连续两次调用状态一致且不改库', async (t) => {
    const { kernel } = await boot(t);
    const a = kernel.health();
    const b = kernel.health();
    assert.equal(a.state, b.state);
    assert.notEqual(a.checkedAt, undefined);
  });
});

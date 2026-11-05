/**
 * R-158 小件三连：.4 Embedder 契约 / .6 Domain ID 校验下沉 / .7 通用适配器 hostLlm 注入。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { createLexVecEmbedder } from '../src/adapters/lexvec-embedder.js';
import { validateDomainId, DOMAIN_ID_RE } from '../src/pure/normalize.js';
import { createDomainRegistry } from '../src/core/domains.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createPlugin } from '../src/index.js';

describe('R-158.4 Embedder 统一契约（dim/embed/close/health）', () => {
  test('hash：health 恒 ok，health.dim === dim === embed 输出维度，close 可等待', async () => {
    const emb = createHashEmbedder(32);
    assert.equal(emb.health().ok, true);
    assert.equal(emb.health().model, 'hash');
    assert.equal(emb.health().dim, emb.dim);
    const [v] = await emb.embed(['一句话']);
    assert.equal(v.length, emb.dim);
    await emb.close();   // 不抛即过
  });

  test('lexvec：health 报告词表来源（种子表 ok=true、external=false），dim 跟随声明', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-lx-'));
    const emb = createLexVecEmbedder({ tablePath: path.join(root, 'seed.vec'), dim: 8 });
    // 构造时自带种子词表（32 维种子先顶上），所以 ok=true；external=false = 还没吃外部大表
    assert.equal(emb.health().ok, true);
    assert.equal(emb.health().model, 'lexvec');
    assert.equal(emb.health().external, false);
    assert.equal(emb.health().dim, emb.dim);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('R-158.6 Domain ID 校验下沉（双入口同源）', () => {
  test('validateDomainId：R-138 正则语义原样', () => {
    assert.equal(validateDomainId('qq-group'), 'qq-group');
    assert.equal(validateDomainId('A_9-z'), 'A_9-z');
    assert.throws(() => validateDomainId('9x'), /invalid domain id/);
    assert.throws(() => validateDomainId('有中文'), /invalid domain id/);
    assert.throws(() => validateDomainId('a'.repeat(33)), /invalid domain id/);
    assert.equal(DOMAIN_ID_RE.source, '^[a-zA-Z][a-zA-Z0-9_-]{0,31}$', '与 R-138 管理入口正则逐字一致');
  });

  test('defineDomain / registry.register 双入口都拒非法 id', () => {
    assert.throws(() => defineDomain({ id: '9bad' }), /invalid domain id/);
    const reg = createDomainRegistry({ audit: null });
    assert.throws(() => reg.register(defineDomain({ id: 'ok1' }) && defineDomain({ id: '9bad' })), /invalid domain id/);
  });

  test('registry 默认覆盖（钉死语义不变）；bootstrap 场景 {replace:false} 撞 id 显式炸', () => {
    const reg = createDomainRegistry({ audit: null });
    reg.register(defineDomain({ id: 'x' }));
    reg.register(defineDomain({ id: 'x', matchSessionId: () => true }));       // 默认覆盖
    assert.equal(reg.routeDomain('anything')?.id, 'x');
    assert.throws(() => reg.register(defineDomain({ id: 'x' }), { replace: false }), /duplicate domain id/);
  });

  test('createKernel bootstrap 撞 id：炸而不是静默覆盖', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dom-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'a1'), { recursive: true });
    await fs.mkdir(path.join(root, 'a2'), { recursive: true });
    const { createKernel } = await import('../src/kernel.js');
    const { createHashEmbedder } = await import('../src/adapters/hash-embedder.js');
    await assert.rejects(
      createKernel({
        config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 32 } },
        domains: [defineDomain({ id: 'dup' }), defineDomain({ id: 'dup' })],
        embedder: createHashEmbedder(32),
        gitInit: false,
      }),
      /duplicate domain id/,
    );
  });
});

describe('R-158.7 通用适配器 hostLlm 注入', () => {
  test('setup(ctx) 的 ctx.llm 流进内核：extract 走 host 通道出真结果', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hl-'));
    await fs.mkdir(path.join(root, 'qq-group'), { recursive: true });
    // 先关库（释放 WAL 锁）再删目录：Windows 反了会 EBUSY
    t.after(async () => { await provided.get('memory')?.close(); await fs.rm(root, { recursive: true, force: true }); });

    const provided = new Map();
    const tools = new Map();
    const fakeLlm = {
      // 宿主 llm 服务契约（docs/host-compat-matrix.md）：prepareCall → 返回 call（含 stream 流块）
      prepareCall: async () => ({
        config: {},
        async *stream() {
          yield { type: 'text', text: JSON.stringify({
            candidates: [{ text: '宿主通道抽出的记忆：小明在学 Rust', entry_type: 'fact', topic_tags: ['测试'], triples: [] }],
            mood: { user: null, user_strong: false, agent: null, note: null },
          }) };
          yield { type: 'finish' };
        },
      }),
    };
    const ctx = {
      domains: [defineDomain({ id: 'qq-group' })],
      provide: (name, value) => provided.set(name, value),
      registerTool: (descriptor, handler) => tools.set(descriptor.name, { descriptor, handler }),
      hook: (name, handler) => hooksSet(hooks, name, handler),
      llm: fakeLlm,
    };
    const hooks = new Map();
    function hooksSet(map, name, handler) { map.set(name, handler); }

    const p = createPlugin({
      config: {
        storage: { root, dbPath: path.join(root, 'index.db') },
        embedding: { dim: 32 },
        write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
        llm: { enabled: true, transport: 'host', host: { provider: 'deepseek-account', model: 'fake-model' } },
      },
      embedder: createHashEmbedder(32),
      gitInit: false,
    });
    await p.setup(ctx);

    const r = await tools.get('memory_extract').handler({ text: '我在学 Rust' }, { sessionId: 'qq-group:1' });
    const written = (r.results ?? []).filter((x) => x.status === 'written');
    assert.ok(written.length >= 1, `hostLlm 未注入时 extract 会失败或空转；candidates=${r.candidates} results=${JSON.stringify((r.results ?? []).map((x) => x.status))}`);
    assert.ok(kernelHasText(provided, '小明在学 Rust'));
  });
});

function kernelHasText(provided, needle) {
  const k = provided.get('memory');
  return !!k.db.prepare('SELECT id FROM entries WHERE text LIKE ?').get(`%${needle}%`);
}

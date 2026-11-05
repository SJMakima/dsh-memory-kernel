/**
 * 【R-158】工具生态与宿主适配契约：Host Adapter / Manifest 自动生成 / apiVersion+capabilities。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createPlugin, createTools, HOOKS, CAPABILITIES, API_VERSION } from '../src/index.js';
import { createHostAdapter } from '../src/adapters/host-adapter.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const DIM = 32;

describe('R-158.1 Host Adapter', () => {
  test('args 式宿主（三参）：按 (name, parameters, handler) 注册', () => {
    const calls = [];
    const ctx = { registerTool: (name, parameters, handler) => calls.push([name, parameters, handler]) };
    const host = createHostAdapter(ctx, { toolStyle: 'args' });
    const ok = host.registerTool({ name: 't1', parameters: { type: 'object' } }, () => {});
    assert.ok(ok);
    assert.equal(calls[0][0], 't1');
    assert.deepEqual(calls[0][1], { type: 'object' });
    assert.equal(typeof calls[0][2], 'function');
  });

  test('descriptor 式宿主：原样透传', () => {
    const calls = [];
    const ctx = { registerTool: (descriptor, handler) => calls.push([descriptor, handler]) };
    const host = createHostAdapter(ctx, { toolStyle: 'descriptor' });
    host.registerTool({ name: 't2', parameters: {} }, () => {});
    assert.equal(calls[0][0].name, 't2');
  });

  test('包装过的 registerTool（.length 被破坏）不再被误判——显式声明优先', () => {
    const calls = [];
    // rest 参数：fn.length === 0，旧启发式必错判成 descriptor
    const wrapped = (...args) => calls.push(args);
    const ctx = { registerTool: wrapped };
    const host = createHostAdapter(ctx, { toolStyle: 'args' });
    host.registerTool({ name: 't3', parameters: { type: 'object' } }, () => {});
    assert.equal(calls[0][0], 't3');
  });

  test('能力探测：listTools+unregisterTool 齐备时验证 descriptor 式并注销探针', () => {
    const registered = {};
    const ctx = {
      registerTool: (d, h) => { registered[d.name] = h; },   // descriptor 式
      listTools: () => Object.keys(registered).map((n) => ({ name: n })),
      unregisterTool: (n) => { delete registered[n]; },
    };
    const host = createHostAdapter(ctx);
    assert.equal(host.toolStyle, 'descriptor');
    assert.ok(!('__dsh_host_probe__' in registered), '探针验完必须注销');
  });

  test('无工具通道（headless）：注册静默跳过不抛', () => {
    const host = createHostAdapter({});
    assert.equal(host.registerTool({ name: 't4' }, () => {}), false);
    assert.equal(host.hook('x', () => {}), false);
    assert.equal(host.provide('y', 1), false);
  });
});

describe('R-158.2/.3 Manifest 单一生成源 + apiVersion/capabilities', () => {
  test('manifest.tools 与 createTools 实际键恒等（setup 前后一致）', async () => {
    const plugin = createPlugin();
    // setup 前：kernel 未启动也能枚举（handler 惰性引用）
    const before = plugin.manifest.tools.slice().sort();
    assert.deepEqual(before, Object.keys(createTools(null)).slice().sort());
    // getter 每次现算：两次访问一致（无隐藏状态漂移）
    assert.deepEqual(plugin.manifest.tools.slice().sort(), before);
  });

  test('setup 后 registered 与 manifest.tools 相等（声明了没注册 = 结构上消失）', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-158b-'));
    const plugin = createPlugin({
      config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
      domains: [defineDomain({ id: 'mf' })],
      embedder: createHashEmbedder(DIM),
      gitInit: false,
    });
    const registered = {};
    const hooks = {};
    await plugin.setup({
      registerTool: (d, h) => { registered[d.name] = h; },
      hook: (n, f) => { hooks[n] = f; },
      provide: () => {},
    });
    t.after(async () => { await plugin.kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

    assert.deepEqual(Object.keys(registered).sort(), plugin.manifest.tools.slice().sort());
    // 钩子单一源：setup 注册的 = HOOKS 声明的
    assert.deepEqual(Object.keys(hooks).sort(), HOOKS.slice().sort());
  });

  test('apiVersion 与 capabilities 枚举进测试（breaking change 必改版本号的抓手）', () => {
    const m = createPlugin().manifest;
    assert.equal(m.apiVersion, API_VERSION);
    assert.equal(typeof API_VERSION, 'string');
    assert.deepEqual(m.capabilities, CAPABILITIES);
    for (const c of CAPABILITIES) {
      assert.match(c, /^memory\.[a-z]+$/, 'capability 命名规范：memory.<域>');
    }
  });
});

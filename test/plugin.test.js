/**
 * 插件接线测试：宿主只依赖 provide / registerTool / hook 三个口子。
 * 这里用一个假宿主把四个工具和三个钩子都跑一遍——测的是"接线对不对"，
 * 与"逻辑对不对"（baseline/e2e）分开，正是 P0-0 / P0a 分档的目的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import plugin, { createPlugin, createTools } from '../src/index.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

async function fakeHost() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-plugin-'));
  const provided = new Map();
  const tools = new Map();
  const hooks = new Map();

  const ctx = {
    domains: [defineDomain({ id: 'qq-group' })],
    provide: (name, value) => provided.set(name, value),
    registerTool: (descriptor, handler) => tools.set(descriptor.name, { descriptor, handler }),
    hook: (name, handler) => hooks.set(name, handler),
  };

  const options = {
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 32 } },
    embedder: createHashEmbedder(32),
    gitInit: false,
  };

  const p = createPlugin(options);
  const boot = await p.setup(ctx);
  return { p, ctx, provided, tools, hooks, boot, root, options };
}

test('plugin.setup：注册 4 个工具、3 个钩子，并 provide memory 实例', async () => {
  const { provided, tools, hooks, boot, p, root } = await fakeHost();

  assert.ok(provided.get('memory'), '必须 provide memory');
  for (const name of ['memory_search', 'memory_context', 'memory_remember', 'memory_dream']) {
    assert.ok(tools.has(name), `缺少工具 ${name}`);
    assert.equal(typeof tools.get(name).handler, 'function');
    assert.ok(tools.get(name).descriptor.parameters, `${name} 必须有 parameters`);
  }
  for (const name of ['agent/pre-step', 'agent/post-step', 'kernel/idle']) {
    assert.ok(hooks.has(name), `缺少钩子 ${name}`);
  }
  assert.deepEqual(boot.vec.enabled, true);
  assert.equal(p.kernel.ready, true);

  await p.kernel.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('工具串联：remember → search → context → dream', async () => {
  const { tools, hooks, p, root } = await fakeHost();

  const write = await tools.get('memory_remember').handler({
    text: '用户喜欢喝咖啡，每天两杯',
    type: 'fact',
    topic_tags: ['偏好'],
    triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }],
    source: { adapter_id: 'qq-group', locator: 'msg:42' },
  }, { sessionId: 'qq-group:8823' });
  assert.equal(write.status, 'written');
  assert.match(write.path, /domains\/qq-group\/\d{4}-\d{2}-\d{2}(\.part-\d{2})?\.md$/);

  const found = await tools.get('memory_search').handler({ query: '咖啡' }, { sessionId: 'qq-group:8823' });
  assert.equal(found.results[0].id, write.entry_id);
  assert.equal(found.ops_query, false);
  assert.equal(typeof found.elapsed_ms, 'number');

  const ctx = await tools.get('memory_context').handler({ entry_id: write.entry_id }, { sessionId: 'qq-group:8823' });
  assert.equal(ctx.found, true, 'v4.29 起 context 要求宿主注入的可信 sessionId');
  assert.equal(ctx.entry.text, '用户喜欢喝咖啡，每天两杯');
  assert.equal(ctx.source_text, null);      // 该域没有 sourceReader（未声明 dir）

  const pre = await hooks.get('agent/pre-step')({
    sessionId: 'qq-group:8823',
    messages: [{ role: 'user', content: '我喝什么？' }],
  });
  assert.equal(pre.skipped, null);
  assert.match(pre.messages.at(-1).content, /咖啡/);

  const dream = await tools.get('memory_dream').handler();
  assert.ok(dream.steps.s4.landed >= 1);

  await p.kernel.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('createTools 可单独使用（宿主自己接工具注册）', async () => {
  const { p, root } = await fakeHost();
  const tools = createTools(p.kernel);
  assert.equal(Object.keys(tools).length, 8);
  const res = await tools.memory_search.handler({ query: '不存在的词' }, { sessionId: 'qq-group:8823' });
  assert.ok(Array.isArray(res.results));
  await p.kernel.close();
  await fs.rm(root, { recursive: true, force: true });
});

test('default export 是可复用的插件描述符', () => {
  assert.equal(typeof plugin.setup, 'function');
  assert.equal(plugin.name, 'dsh-memory-kernel');
  assert.ok(plugin.manifest.tools.includes('memory_search'));
});

test('audit：同一文件的并发追加必须串行（Windows 下并发 appendFile 会 EPERM）', async () => {
  const { createAudit } = await import('../src/storage/audit.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-audit-'));
  const audit = createAudit(root);

  // 检索路径上 `Promise.all(pool.map(...))` 就是这样并发写同一个文件的
  await Promise.all(Array.from({ length: 20 }, (_, i) => audit.rereadShadow({ i })));
  await audit.flush();

  const text = await fs.readFile(path.join(root, 'audit', 'reread-shadow.log'), 'utf8');
  const rows = text.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 20);
  // 新格式：每行 {ts, channel, payload}——频道名落行内，顺序由串行链保证
  assert.deepEqual(rows.map((r) => r.payload.i), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(rows.every((r) => r.channel === 'reread-shadow' && typeof r.ts === 'string'));

  await fs.rm(root, { recursive: true, force: true });
});

/**
 * 【身份可信纪律，外审 P1】通用适配器的会话身份只信宿主 ctx.sessionId。
 * 修复前：`ctx.sessionId ?? args.domain` / `?? args.sessionId` —— Agent 伪造 args
 * 就能配对出 private 条目的可见性（隐私边界交给不可信输入）。
 * 修复后：无可信身份 fail-closed——写出身空、读身份 null；trustSessionArgs 显式恢复旧回退。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createPlugin } from '../src/index.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const roots = [];
const tmp = async () => { const r = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-idtrust-')); roots.push(r); return r; };

async function boot(root, pluginOpts = {}) {
  const plugin = createPlugin({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 32 },
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'idt' })],
    embedder: createHashEmbedder(32),
    gitInit: false,
    ...pluginOpts,
  });
  const registered = {};
  const bootInfo = await plugin.setup({
    hostToolStyle: 'descriptor',
    registerTool: (d, h) => { registered[d.name] = h; },
    hook: () => {}, provide: () => {},
  });
  return { plugin, registered, bootInfo };
}

const REMEMBER_ARGS = (text) => ({
  text, domain: 'idt',
  triples: [{ subject: '用户', attribute: '偏好', value: text.slice(0, 6) }],
  source: { adapter_id: 't', locator: `t:${text}` },
});

describe('通用适配器身份可信纪律', () => {
  test('无宿主身份：写路径记空出身（条目照常落库，隐私往安全侧失败）', async (t) => {
    const root = await tmp();
    t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
    const { plugin, registered } = await boot(root);

    const r = await registered.memory_remember(REMEMBER_ARGS('无身份写入测试'), {});
    assert.equal(r.status, 'written');
    const prov = JSON.parse(plugin.kernel.db.prepare('SELECT provenance p FROM entries WHERE id = ?').get(r.entry_id).p);
    assert.equal(prov.session_id, '', 'args.domain 不得伪装成出身会话');

    await plugin.kernel.close();
  });

  test('伪造 args.sessionId 配对不出 private 可见性（修复前可利用的攻击面）', async (t) => {
    const root = await tmp();
    t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
    const { plugin, registered } = await boot(root);

    // 造一条 private 条目，出身会话恰好是 Agent 也能猜到的 'fake-session'
    const r = await registered.memory_remember(REMEMBER_ARGS('私密：伪造身份攻击测试'), { sessionId: 'idt:fake-session' });
    plugin.kernel.db.prepare(`UPDATE entries SET sensitivity = 'private' WHERE id = ?`).run(r.entry_id);

    // Agent 带 args.sessionId='fake-session' 调检索（无宿主身份）→ 必须看不见
    const s = await registered.memory_search({ query: '伪造身份攻击', domain: 'idt', sessionId: 'fake-session' }, {});
    assert.equal(s.results.length, 0, '无可信身份时 args.sessionId 必须被忽略（fail-closed）');

    // 宿主给真身份才能看见
    const s2 = await registered.memory_search({ query: '伪造身份攻击', domain: 'idt' }, { sessionId: 'idt:fake-session' });
    assert.equal(s2.results.length, 1, 'ctx.sessionId 可信时正常配对可见');

    await plugin.kernel.close();
  });

  test('ctx.sessionId 恒优先于 args（宿主身份不可被工具参数覆盖）', async (t) => {
    const root = await tmp();
    t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
    const { plugin, registered } = await boot(root);

    const r = await registered.memory_remember(
      { ...REMEMBER_ARGS('宿主优先测试'), sessionId: 'args-fake' },
      { sessionId: 'idt:real' },
    );
    const prov = JSON.parse(plugin.kernel.db.prepare('SELECT provenance p FROM entries WHERE id = ?').get(r.entry_id).p);
    assert.equal(prov.session_id, 'idt:real');

    await plugin.kernel.close();
  });

  test('trustSessionArgs: true 显式恢复参数回退（无隐私要求场景的逃生口）', async (t) => {
    const root = await tmp();
    t.after(() => fs.rm(root, { recursive: true, force: true }).catch(() => {}));
    const { plugin, registered } = await boot(root, { trustSessionArgs: true });

    const r = await registered.memory_remember(REMEMBER_ARGS('显式信任参数测试'), { sessionId: 'idt:explicit' });
    const prov = JSON.parse(plugin.kernel.db.prepare('SELECT provenance p FROM entries WHERE id = ?').get(r.entry_id).p);
    assert.equal(prov.session_id, 'idt:explicit', '显式开关下 args.sessionId 回到回退链');

    await plugin.kernel.close();
  });
});

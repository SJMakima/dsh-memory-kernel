/**
 * R-153 Access Gate：单文件强制入口。
 * - 单元：pairVisible fail-closed 语义 + admitContext 守卫链（铁律②）
 * - 静态：全库只有 gate 定义 pairVisible；检索与 context 都经 gate；dsh 工具传可信会话
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccessGate } from '../src/core/access-gate.js';

const cfg = (over = {}) => ({ privacy: { ownerIds: [], ...over } });
const entry = (over = {}) => ({
  id: 'e1', domain_id: 'da', text: 't', entry_type: 'fact', triples: [],
  sensitivity: 'normal', cold: false, superseded_by: null,
  provenance: { session_id: 's1' },
  ...over,
});
const stubs = (over = {}) => ({
  domains: { routeDomain: (sid) => ({ id: String(sid).split(':')[0] }), get: () => ({ id: 'da', trustedSource: true }) },
  security: { verifyEntrySignature: () => true },
  loadEntry: () => entry(),
  ...over,
});

describe('gate.pairVisible（铁律①：没有 includePrivate 这条通道）', () => {
  const gate = createAccessGate({ cfg: cfg() });

  test('normal 档不受 origin 管控（全域检索带出身标注）', () => {
    assert.equal(gate.pairVisible(entry({ provenance: null }), { sessionId: 's9' }), true);
  });

  test('private：同会话可见 / 跨会话拒绝 / 缺 provenance 拒绝', () => {
    const e = entry({ sensitivity: 'private' });
    assert.equal(gate.pairVisible(e, { sessionId: 's1' }), true);
    assert.equal(gate.pairVisible(e, { sessionId: 's2' }), false);
    assert.equal(gate.pairVisible(entry({ sensitivity: 'private', provenance: null }), { sessionId: 's1' }), false);
  });

  test('ownerIds 配了但缺 viewer → 拒绝（fail-closed）；请求里的 includePrivate 字段被无视', () => {
    const g2 = createAccessGate({ cfg: cfg({ ownerIds: ['dad'] }) });
    const e = entry({ sensitivity: 'private' });
    assert.equal(g2.pairVisible(e, { sessionId: 's1' }), false, '缺 viewer 不是 owner');
    assert.equal(g2.pairVisible(e, { sessionId: 's1', viewer: 'dad' }), true);
    // 铁律①：传 includePrivate=true 也改变不了结果
    assert.equal(g2.pairVisible(e, { sessionId: 's2', includePrivate: true }), false);
  });
});

describe('gate.admitContext（铁律②：context 不许绕过准入）', () => {
  const gate = createAccessGate({ cfg: cfg() });

  test('守卫链：sessionId 必填 → 域路由 → 隐私 → 被取代/冷存排除 → 验签', () => {
    const s = stubs();
    const ok = gate.admitContext({ entryId: 'e1', request: { sessionId: 'da:s1' }, ...s });
    assert.equal(ok.entry.id, 'e1');

    assert.equal(gate.admitContext({ entryId: 'e1', request: {}, ...s }), null, '缺可信 sessionId');
    assert.equal(gate.admitContext({ entryId: 'e1', request: { sessionId: 'da:s1' }, ...s, loadEntry: () => null }), null, '条目不存在');
    assert.equal(gate.admitContext({ entryId: 'e1', request: { sessionId: 'da:s1' }, ...s, loadEntry: () => entry({ superseded_by: 'e2' }) }), null, '被取代不单取');
    assert.equal(gate.admitContext({ entryId: 'e1', request: { sessionId: 'da:s1' }, ...s, loadEntry: () => entry({ cold: true }) }), null, '冷存不单取');
    assert.equal(gate.admitContext({
      entryId: 'e1', request: { sessionId: 'da:s1' }, ...s,
      loadEntry: () => entry({ sensitivity: 'private', provenance: { session_id: 's9' } }),
    }), null, '跨会话 private 拒绝');
    assert.equal(gate.admitContext({
      entryId: 'e1', request: { sessionId: 'da:s1' }, ...s,
      security: { verifyEntrySignature: () => false },
    }), null, '验签不过拒绝');
  });
});

describe('R-153 静态断言：gate 是唯一强制点', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

  test('全库只有 access-gate.js 定义 pairVisible；retrieve 是薄委托；context 走 admitContext', async () => {
    const files = [];
    const walk = async (dir) => {
      for (const f of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) await walk(p);
        else if (f.name.endsWith('.js')) files.push(p);
      }
    };
    await walk(path.join(root, 'src'));
    const definers = [];
    for (const f of files) {
      const src = await fs.readFile(f, 'utf8');
      if (/function pairVisible/.test(src)) definers.push(path.relative(root, f));
    }
    assert.deepEqual(definers, [path.join('src', 'core', 'access-gate.js')], 'pairVisible 只允许在 gate 定义');

    const retrieveSrc = await fs.readFile(path.join(root, 'src', 'core', 'retrieve.js'), 'utf8');
    assert.match(retrieveSrc, /gate\.pairVisible\(e, req\)/, 'retrieve 必须委托 gate');

    const kernelSrc = await fs.readFile(path.join(root, 'src', 'kernel.js'), 'utf8');
    assert.match(kernelSrc, /gate\.admitContext\(/, 'kernel.context 必须走 gate 准入链');
    assert.doesNotMatch(kernelSrc, /retrieve\.admit\(e, viewerDomain/, 'context 不再自带一份准入实现');
  });

  test('dsh 工具侧：memory_context 传宿主常量 SESSION（Agent 不可控）', async () => {
    const libSrc = await fs.readFile(path.join(root, 'dsh', 'lib-index.js'), 'utf8');
    // 【R-152】消费面切到分组 API 后，context 走 kernel.memory.context——身份来源语义不变
    assert.match(libSrc, /kernel\.memory\.context\(args\.entry_id, \{ sessionId: SESSION \}\)/);
    const clientOk = await fs.readFile(path.join(root, 'src', 'index.js'), 'utf8');
    assert.match(clientOk, /sessionId: ctx\.sessionId/, '通用适配器从宿主 ctx 取身份');
  });
});

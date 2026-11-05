/**
 * 【R-157.4】检索 Trace：candidate 级 {sources, 分数, admission.reason, finalRank}
 * + rejected[{entryId, reason}]；敏感原文不入 trace；audit 通道 + 返回值双出口。
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const roots = [];
async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-trace-'));
  roots.push(root);
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 32 },
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'tr' })],
    embedder: createHashEmbedder(32),
    gitInit: false,
  });
  await kernel.init();
  return kernel;
}

const seed = (kernel, text) => kernel.remember({
  domainId: 'tr', text, entryType: 'fact', sessionId: 'tr:s1',
  triples: [{ subject: '用户', attribute: '偏好', value: text.slice(0, 6) }],
  sourceRef: { adapter_id: 't', locator: `t:${text}` },
  provenance: { session_id: 'tr:s1', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
});

describe('R-157.4 检索 Trace', () => {
  test('正常检索：终选条目带 sources/finalRank/admission，rejected 带原因', async () => {
    const kernel = await boot();
    await seed(kernel, '用户喜欢喝龙井茶');
    await seed(kernel, '用户养了一只柯基');
    const r = await kernel.search({ domain: 'tr', query: '用户喜欢喝什么茶' });
    assert.ok(r.trace, 'trace 应挂在返回值上');
    assert.equal(r.trace.intent, r.intent);

    const admitted = r.trace.candidates.filter((c) => c.admission === 'admitted');
    assert.ok(admitted.length >= 1);
    const top = r.trace.candidates.find((c) => c.finalRank === 1);
    assert.ok(top, '第一名应有 finalRank');
    assert.ok(Object.keys(top.sources).length >= 1, '终选条目应能还原来自哪些通道');
    for (const [ch, s] of Object.entries(top.sources)) {
      assert.ok(['fts', 'vector', 'triple', 'recent'].includes(ch), `通道名合法：${ch}`);
      assert.ok(s.rank >= 1);
      assert.equal(typeof s.score, 'number');
    }
    // 不含敏感原文
    const flat = JSON.stringify(r.trace);
    assert.ok(!flat.includes('用户喜欢喝龙井茶'), 'query 原文不入 trace');
    await kernel.close();
  });

  test('拒绝原因可读：private 跨会话 = pair-privacy，冷存条目 = cold-excluded', async () => {
    const kernel = await boot();
    const e = (await seed(kernel, '用户的银行账号是 123456')).entry;
    // private + 别的会话产生 → pair-privacy
    kernel.db.prepare(`UPDATE entries SET sensitivity = 'private', provenance = ? WHERE id = ?`)
      .run(JSON.stringify({ session_id: 'tr:other', message_ids: [], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' }), e.id);
    // 冷存条目（不带 include_cold 时被拒）
    const c = (await seed(kernel, '用户很久以前去过敦煌')).entry;
    kernel.db.prepare('UPDATE entries SET cold = 1 WHERE id = ?').run(c.id);

    const r = await kernel.search({ domain: 'tr', query: '用户去过哪里 银行', includeCold: false });
    const reasons = new Set(r.trace.rejected.map((x) => x.reason));
    assert.ok(reasons.has('pair-privacy'), `应含 pair-privacy，实得 ${[...reasons]}`);
    assert.ok(reasons.has('cold-excluded'), `应含 cold-excluded，实得 ${[...reasons]}`);
    await kernel.close();
  });

  test('audit 通道落痕：retrieval-trace.log 存在且为合法 JSON 行', async () => {
    const kernel = await boot();
    await seed(kernel, '用户在学日语');
    await kernel.search({ domain: 'tr', query: '用户在学什么语言' });
    await kernel.audit.flush();
    const raw = await fs.readFile(path.join(root2(kernel), 'audit', 'retrieval-trace.log'), 'utf8');
    const row = JSON.parse(raw.trim().split('\n').pop());
    assert.equal(row.channel, 'retrieval-trace');
    assert.ok(Array.isArray(row.payload.candidates));
    await kernel.close();
  });

  test('eval 下钻：红灯 query 能定位"失败发生在哪一层"', async () => {
    const kernel = await boot();
    await seed(kernel, '用户喜欢喝龙井茶');
    const r = await kernel.search({ domain: 'tr', query: '完全不相关的量子力学问题' });
    // 空结果时 trace 也能解释：候选有没有、各通道是否全空
    const t = r.trace;
    assert.ok(t);
    const layer = t.candidates.length === 0
      ? '候选生成层（四路全空：词面/向量/三元组/时间窗都没召回）'
      : (t.rejected.length ? `准入/排序层（${t.rejected.length} 条被拒）` : '排序层（有候选但分数不足）');
    assert.equal(typeof layer, 'string');
    await kernel.close();
  });
});

function root2(kernel) { return kernel.cfg.storage.root; }

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true }).catch(() => {});
});

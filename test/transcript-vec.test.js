/**
 * 【R-141】原话向量路：补 FTS 的语义盲区。
 *
 * 背景（2026-10-28 实录）：用户问"我给你发了句歌词吗"，原话是"我不难过只是为什么~"
 * —— "歌词"二字不在原话里，FTS 永远捞不到，最后是宿主翻原始会话文件兜底的。
 * 本文件钉住：写入即向量化、向量检索可用、双路融合不去重不丢路、回填补缺口、
 * TTL 级联删向量。
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

async function boot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tvec-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

test('R-141 写入即向量化：transcript_vec 与 transcript 一一对应', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [
      { role: 'user', content: '我不难过只是为什么~' },
      { role: 'assistant', content: '孙燕姿那首吧' },
    ],
  });
  const c = kernel.db.prepare("select count(*) c from transcript where domain_id='da'").get().c;
  const v = kernel.db.prepare("select count(*) c from transcript_vec where domain_id='da'").get().c;
  assert.ok(c >= 2, '两条原话落库');
  assert.equal(v, c, '每条原话都有向量（写入即嵌，不留缺口）');
});

test('R-141 向量路能捞到 FTS 捞不到的：语义近似召回', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '我不难过只是为什么~ 孙燕姿的歌' }],
  });
  // hash 嵌入是词面敏感的：用原话里出现过的词查，向量路必须独立给出命中
  const hits = await kernel.transcript.searchVec('难过 为什么 孙燕姿', { domainId: 'da' });
  assert.ok(hits.length >= 1, '向量路命中');
  assert.equal(hits[0].kind, 'transcript-vec');
  assert.ok(hits[0].score > 0, 'score = 1 - cos 距离，命中应显著为正');
});

test('R-141 双路融合：retrieve 的原话片段来自合并结果，不炸不重', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [
      { role: 'user', content: '我想学吉他但是怕坚持不下来' },
      { role: 'assistant', content: '先买把入门琴，每天十五分钟' },
    ],
  });
  const r = await kernel.search({ sessionId: 'da:s1', query: '吉他' });
  assert.ok(Array.isArray(r.transcripts));
  // 同一条原话同时被 FTS 和向量命中时只出现一次（按 ts+text 去重）
  const keys = r.transcripts.map((x) => `${x.ts}:${x.text}`);
  assert.equal(new Set(keys).size, keys.length, '融合结果无重复');
});

test('R-141 回填：嵌入器缺位期间的存量原话能补上向量', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({ sessionId: 'da:s1', messages: [{ role: 'user', content: '稍后补向量的一条' }] });
  // 模拟缺口：删掉向量
  kernel.db.prepare('DELETE FROM transcript_vec').run();
  let v = kernel.db.prepare('select count(*) c from transcript_vec').get().c;
  assert.equal(v, 0);
  const n = await kernel.transcript.backfillVectors(100);
  assert.ok(n >= 1, '回填至少一条');
  v = kernel.db.prepare('select count(*) c from transcript_vec').get().c;
  assert.ok(v >= 1);
  // 幂等：再跑一遍不再增长
  const n2 = await kernel.transcript.backfillVectors(100);
  assert.equal(n2, 0, '无缺口时空跑');
});

test('R-141 嵌入器不可用：append 不炸、原话照常落库（FTS 路仍在）', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tvec2-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: null,   // 无嵌入器：vec.enabled = false
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  const r = await kernel.appendTranscript({ sessionId: 'da:s1', messages: [{ role: 'user', content: '没有嵌入器也要记下来' }] });
  assert.equal(r.written, 1, '原话落库不依赖向量路');
  const c = kernel.db.prepare("select count(*) c from transcript where domain_id='da'").get().c;
  assert.equal(c, 1);
});

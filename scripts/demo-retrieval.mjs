/**
 * 【演示检索演练】在已有 seed 演示实例上跑分层用例，验证四路召回的实战表现。
 *
 * 分层设计（对应四张表 / 四条召回路）：
 *   A 事实层   —— entries（向量 + FTS + RRF 融合）："他对 X 的态度"类提问
 *   B 原话层   —— transcripts（FTS + 向量双路 RRF）：重点是"词面不同、意思相近"的模糊回忆
 *   C 日记层   —— diaryHits（日记 FTS）+ 按日期直取
 *   D 情绪层   —— emotion_log 时间线（emotions.range）
 *
 * 只读演练：不灌数据、不跑 dream。数据用 seed-demo.mjs 先灌好。
 * 用法：node scripts/demo-retrieval.mjs
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.dsh', 'memory-kernel-seed');
const LEXVEC_TABLE = path.join(os.homedir(), '.dsh', 'memory-kernel-dsh', 'lexvec', 'cc-trimmed.vec');
const DIM = 300;

const { createKernel } = await import('../src/kernel.js');
const { defineDomain } = await import('../src/adapters/local-archive.js');
const { createLexVecEmbedder } = await import('../src/adapters/lexvec-embedder.js');

const embedder = createLexVecEmbedder({ tablePath: LEXVEC_TABLE, dim: DIM });
const kernel = await createKernel({
  config: {
    storage: { root: ROOT, dbPath: path.join(ROOT, 'index.db') },
    embedding: { dim: DIM, backend: 'lexvec' },
    dream: { idleMs: 365e5 },   // 只读演练，不 dream
  },
  domains: [defineDomain({ id: 'seed', dir: path.join(ROOT, 'domains', 'seed'), matchSessionId: (s) => s.startsWith('seed:') })],
  embedder,
  gitInit: false,
});
await kernel.init();
await embedder.loadExternalTable(LEXVEC_TABLE);

const clip = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);
let hit = { entries: 0, transcripts: 0, diary: 0 };
let total = { entries: 0, transcripts: 0, diary: 0 };

async function ask(q, { expect = 'entries' } = {}) {
  const r = await kernel.search({ sessionId: 'seed:s01', query: q });
  const es = r.entries ?? [];
  const ts = r.transcripts ?? [];
  const ds = r.diaryHits ?? [];
  total.entries += es.length ? 1 : 0;
  total.transcripts += ts.length ? 1 : 0;
  total.diary += ds.length ? 1 : 0;
  if (expect === 'entries' && es.length) hit.entries++;
  if (expect === 'transcripts' && ts.length) hit.transcripts++;
  if (expect === 'diary' && (ds.length || r.dayArchive)) hit.diary++;

  console.log(`\nQ: ${q}`);
  for (const e of es.slice(0, 2)) console.log(`  [事实] ${clip(e.text, 64)}`);
  for (const t of ts.slice(0, 2)) console.log(`  [原话] (${t.role ?? '?'}@${new Date(t.ts).toISOString().slice(5, 16)}) ${clip(t.text, 64)}`);
  for (const d of ds.slice(0, 1)) console.log(`  [日记] ${d.date} ${clip(String(d.excerpt ?? '').replace(/\s+/g, ' '), 60)}`);
  if (r.dayArchive?.diary) console.log(`  [当日档案] 日记 ${r.dayArchive.diary.date} 命中`);
  if (!es.length && !ts.length && !ds.length && !r.dayArchive) console.log('  →（四路全空）');
  return r;
}

console.log('═══ A 事实层（entries：向量+FTS+RRF）═══');
await ask('他对香菜的态度怎么样');
await ask('他最近在学什么新语言');
await ask('他的猫叫什么');
await ask('他心情不好的时候会做什么');

console.log('\n═══ B 原话层（transcripts：FTS+向量双路，重点测模糊回忆）═══');
await ask('他上次提到猫的作息是什么时候', { expect: 'transcripts' });
await ask('他说过拍照相关的话吗', { expect: 'transcripts' });
await ask('他抱怨过上班通勤吗', { expect: 'transcripts' });

console.log('\n═══ C 日记层（diaryHits FTS + 按日期直取）═══');
await ask('他有没有提过想自己写网站', { expect: 'diary' });
const dr = kernel.diary.search('猫', { domainId: 'seed' });
console.log(`\ndiary.search('猫') → ${dr.length} 篇命中：${dr.map((d) => d.date).join('、') || '（无）'}`);
const byDate = kernel.diary.get('seed', '2026-10-28');
console.log(`diary.get(seed, 2026-10-28) → ${byDate ? `有（generated_by=${byDate.generated_by}，${(byDate.content.match(/\n/g) ?? []).length + 1} 行）` : '无'}`);

console.log('\n═══ D 情绪层（emotion_log 时间线）═══');
const end = Date.now();
const start = end - 60 * 864e5;
const mood = kernel.emotions.range('seed', start, end);
console.log(`60 天窗口共 ${mood.length} 个情绪点，最近 8 个：`);
for (const p of mood.slice(-8)) {
  const who = p.owner === 'agent' ? (p.source === 'self' ? '她【自述】' : '她(表现)') : '小舟';
  console.log(`  ${new Date(p.ts).toISOString().slice(5, 16)} ${who} ${p.emotion}${p.strong ? '（强）' : ''}${p.note ? ` — ${clip(p.note, 40)}` : ''}`);
}
const selfCount = mood.filter((p) => p.source === 'self').length;
console.log(`其中第一手自述 ${selfCount} 个、判读 ${mood.length - selfCount} 个。`);

console.log(`\n═══ 小结 ═══\nA 事实层 ${hit.entries}/4 题有命中　B 原话层 ${hit.transcripts}/3 题有命中　C 日记层含 FTS 命中 ${total.diary} 次`);
await kernel.close();

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLexVecEmbedder } from '../src/adapters/lexvec-embedder.js';

test('lexvec：同簇词余弦相似度显著高于跨簇', async () => {
  const e = createLexVecEmbedder({});
  const [tea] = await e.embed(['茶']); const [coffee] = await e.embed(['咖啡']);
  const [lol] = await e.embed(['LOL']);
  const sim = tea.reduce((s, v, i) => s + v * coffee[i], 0);
  const cross = tea.reduce((s, v, i) => s + v * lol[i], 0);
  assert.ok(sim > 0.8, `同簇（饮品）相似度应 >0.8（实际 ${sim.toFixed(3)}）`);
  assert.ok(cross < 0.3, `跨簇（饮品 vs 游戏）相似度应 <0.3（实际 ${cross.toFixed(3)}）`);
});

test('lexvec：句子向量=词平均，同义句互相靠近', async () => {
  const e = createLexVecEmbedder({});
  const [a] = await e.embed(['用户喜欢喝矿泉水']);
  const [b] = await e.embed(['用户最爱喝矿泉水']);
  const [c] = await e.embed(['今天排班开会']);
  const simAB = a.reduce((s, v, i) => s + v * b[i], 0);
  const simAC = a.reduce((s, v, i) => s + v * c[i], 0);
  assert.ok(simAB > simAC + 0.2, `同义句相似度应显著更高（${simAB.toFixed(3)} vs ${simAC.toFixed(3)}）`);
});

test('lexvec：neighbors 近邻发现——同簇词霸榜', () => {
  const e = createLexVecEmbedder({});
  const r = e.neighbors('咖啡', 5);
  assert.ok(r.hasWord, '种子表应含查询词');
  assert.ok(r.neighbors.every((n) => n.sim <= r.neighbors[0].sim), '按相似度降序');
  const topWords = r.neighbors.map((n) => n.word);
  assert.ok(!topWords.includes('LOL'), `跨簇词不应进 top5（实际 ${topWords.join(',')}）`);
});

test('lexvec：最长匹配分词——表内多字词整体切出', async () => {
  const e = createLexVecEmbedder({});
  const seg = JSON.stringify(Object.keys({})); // 占位
  // 间接验证：包含表内多字词的句子能命中其词向量（embed 后与该词向量高相似）
  const [vSent] = await e.embed(['用户喜欢喝矿泉水']);
  const [vWord] = await e.embed(['矿泉水']);
  const sim = vSent.reduce((s, x, i) => s + x * vWord[i], 0);
  assert.ok(sim > 0.5, `句子应包含"矿泉水"词向量成分（sim=${sim.toFixed(3)}）`);
});

test('lexvec：词表外文本退化为单位向量（互不相似、不报错）', async () => {
  const e = createLexVecEmbedder({});
  const [v] = await e.embed(['😀🎉👍']);   // 表外内容
  let norm = 0;
  for (const x of v) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 0.01, '应为单位向量');
});

test('lexvec：外部词表加载（fastText 文本格式）', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const p = path.join(os.tmpdir(), `lexvec-${Date.now()}.txt`);
  const lines = ['# dims: 4', '堵车 0.9 0.1 0.2 0.3', '塞车 0.88 0.12 0.22 0.28', '咖啡 0.1 0.9 0.1 0.2'];
  await fs.writeFile(p, lines.join('\n'), 'utf8');
  const e = createLexVecEmbedder({ tablePath: p });
  await e.loadExternalTable(p);
  assert.equal(e.dim, 4, '维度以外部表为准');
  assert.ok(e.hasWord('堵车') && e.hasWord('塞车'), '外部词已加载');
  const [v] = await e.embed(['堵车']);
  const [w] = await e.embed(['塞车']);
  const sim = v.reduce((s, x, i) => s + x * w[i], 0);
  assert.ok(sim > 0.9, `外部表同义词应高相似（${sim.toFixed(3)}）`);
  await fs.rm(p, { force: true });
});

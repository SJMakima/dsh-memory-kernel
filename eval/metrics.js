/**
 * 评测指标（P2）。全部纯函数：输入名次数组 + 相关度表，输出分数。
 * NDCG 用 graded relevance（3 = 直接命中 / 1 = 相关），
 * MRR / Recall@k 用二值相关（grade > 0 即相关）。
 */

export function ndcgAtK(rankedIds, relMap, k = 5) {
  const dcg = rankedIds.slice(0, k)
    .reduce((s, id, i) => s + (relMap[id] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(relMap).filter((g) => g > 0)
    .sort((a, b) => b - a).slice(0, k);
  const idcg = ideal.reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return idcg > 0 ? dcg / idcg : 0;
}

export function mrr(rankedIds, relMap) {
  const first = rankedIds.findIndex((id) => (relMap[id] ?? 0) > 0);
  return first < 0 ? 0 : 1 / (first + 1);
}

export function recallAtK(rankedIds, relMap, k = 5) {
  const rel = Object.entries(relMap).filter(([, g]) => g > 0).map(([id]) => id);
  if (!rel.length) return 0;
  const hit = new Set(rankedIds.slice(0, k).filter((id) => (relMap[id] ?? 0) > 0));
  return hit.size / rel.length;
}

/** 一组 query 的汇总。 */
export function summarize(runs, k = 5) {
  const n = runs.length || 1;
  return {
    n,
    ndcgAtK: r(runs.map((x) => x.ndcg).reduce((a, b) => a + b, 0) / n),
    mrr: r(runs.map((x) => x.mrr).reduce((a, b) => a + b, 0) / n),
    recallAtK: r(runs.map((x) => x.recall).reduce((a, b) => a + b, 0) / n),
  };
}

const r = (x) => Math.round(x * 10000) / 10000;

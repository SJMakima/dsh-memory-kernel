/**
 * P2 评测与校准报告生成器（§7 P2 / §20）。
 *
 *   node eval/run.js                     # 合成评测集（构造相关，60 query 级别）
 *   node eval/run.js --dataset x.jsonl   # 真实标注集（{"query","intent","relevant":{entryId:grade}}）
 *   node eval/run.js --root <已有库>      # 在真实语料上只跑 query 侧
 *
 * 产出 eval/report.json + eval/report.md：
 *   ① 加权 RRF vs 等权 vs 纯向量（NDCG@5 / MRR / Recall@5）
 *   ② 单参数敏感度扫描：rrfK / alpha / 各意图各路权重（±50%，**不做网格搜索** §20）
 *   ③ classifyIntent 判定准确率
 *   ④ 路径 B 的 over-fetch 放大代价 → minPartitionVectors 取值建议
 *   ⑤ detectVerified 误报率（< 5% 才允许 verifiedEnabled=true，§16.2）
 *
 * 两条铁律：单变量——每次扫描只动一个数，跑完立刻恢复；
 * 相关度由构造保证——合成集的"相关"来自 query 与条目同源，不是模型判断。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { PLANS, classifyIntent } from '../src/pure/ranking.js';
import { dbTx } from '../src/storage/db.js';
import { detectVerified } from '../src/core/security.js';
import { loadConfig } from '../src/config.js';
import { CORPUS, QUERIES, VERIFIED_SET, loadDataset } from './dataset.js';
import { ndcgAtK, mrr, recallAtK, summarize } from './metrics.js';
import { extractEval, conflictEval, privacyEval } from './security-eval.js';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const OUT_DIR = path.resolve(flag('out', 'eval'));
const K = 5;

/* ───────────────────────── 语料与查询 ───────────────────────── */

async function bootCorpus() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-eval-'));
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 64 },
      // 语料是标定过的：全部按 new 写入，四分类的判重不该在这里掺和
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'eval', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(64),
    gitInit: false,
  });
  await kernel.init();

  const idByKey = {};
  for (const item of CORPUS) {
    const r = await kernel.remember({
      domainId: 'eval',
      text: item.text,
      entryType: item.type,
      topicTags: item.tags,
      triples: [{ subject: item.triple[0], attribute: item.triple[1], value: item.triple[2] }],
      sourceRef: { adapter_id: 'eval', locator: `eval:${item.key}` },
      provenance: {
        session_id: 'eval:1', message_ids: [`eval:${item.key}`], extract_task_id: 'p2-eval',
        model_version: 'synthetic', extracted_at: Date.now(), source_content_hash: '',
      },
    });
    idByKey[item.key] = r.entry.id;
  }
  return { kernel, idByKey, root };
}

async function buildQueries(idByKey) {
  const dsFile = flag('dataset', null);
  if (dsFile) return loadDataset(path.resolve(dsFile));
  return QUERIES.map((q) => ({
    query: q.q,
    intent: q.intent,
    relevant: Object.fromEntries(q.rel.map((k) => [idByKey[k], 3])),
  }));
}

/* ───────────────────────── 运行一组配置 ───────────────────────── */

/** 每次只动一个数的补丁，用完即还。 */
function patch(obj, key, value) {
  const old = obj[key];
  obj[key] = value;
  return () => { obj[key] = old; };
}

async function runConfig(kernel, queries, { label, patchers = [] }) {
  const undos = patchers.map((p) => p());
  const runs = [];
  try {
    for (const item of queries) {
      const predicted = kernel.intentOf(item.query, 'eval:1');
      const r = await kernel.search({ sessionId: 'eval:1', query: item.query, intent: predicted });
      const ids = r.entries.map((e) => e.id);
      runs.push({
        query: item.query,
        labelIntent: item.intent,
        predictedIntent: predicted,
        ndcg: ndcgAtK(ids, item.relevant, K),
        mrr: mrr(ids, item.relevant),
        recall: recallAtK(ids, item.relevant, K),
      });
    }
  } finally {
    for (const u of undos) u();
  }
  return { label, ...summarize(runs), runs };
}

/** 意图书每个分量 ±factor（单变量），返回 NDCG 相对基线的变化。 */
async function scanRouteWeights(kernel, queries, baselineNdcg, factor) {
  const out = [];
  for (const [intent, plan] of Object.entries(PLANS)) {
    for (const route of Object.keys(plan.weights)) {
      const undo = patch(plan.weights, route, Math.round(plan.weights[route] * factor * 100) / 100);
      try {
        const r = await runConfig(kernel, queries, { label: `${intent}.${route}×${factor}` });
        out.push({ intent, route, factor, ndcg: r.ndcgAtK, delta: round(r.ndcgAtK - baselineNdcg) });
      } finally { undo(); }
    }
  }
  return out;
}

const round = (x) => Math.round(x * 10000) / 10000;

/* ───────────────────────── 主评测（检索质量）───────────────────────── */

async function retrievalEval(report) {
  const { kernel, idByKey, root } = await bootCorpus();
  try {
    const queries = await buildQueries(idByKey);

    // classifyIntent 判定准确率（R-58 的纯规则实现，P2 校准对象之一）
    let agree = 0;
    const confusion = {};
    for (const q of queries) {
      const predicted = classifyIntent(q.query, null);   // 无词表 → 纯线索词判定
      confusion[`${q.intent}→${predicted}`] = (confusion[`${q.intent}→${predicted}`] ?? 0) + 1;
      if (predicted === q.intent) agree++;
    }
    report.intent = { n: queries.length, accuracy: round(agree / queries.length), confusion };

    const baseline = await runConfig(kernel, queries, { label: 'weighted-default（文档起步值）' });
    report.baseline = baseline;

    const equal = await runConfig(kernel, queries, {
      label: 'equal-weight（四路等权）',
      patchers: [() => {
        const undos = Object.values(PLANS).map((p) => patch(p, 'weights', { vector: 1, fts: 1, triple: 1, recent: 1 }));
        return () => undos.forEach((u) => u());
      }],
    });
    const vecOnly = await runConfig(kernel, queries, {
      label: 'vector-only（纯向量）',
      patchers: [() => {
        const undos = Object.values(PLANS).map((p) => patch(p, 'weights', { vector: 1, fts: 0, triple: 0, recent: 0 }));
        return () => undos.forEach((u) => u());
      }],
    });
    report.comparison = [baseline, equal, vecOnly].map(({ label, n, ndcgAtK, mrr, recallAtK }) =>
      ({ label, n, ndcgAtK, mrr, recallAtK }));

    // rrfK 只扫 5 个点（§20：曲线通常平，取平台区中点）
    report.rrfK = [];
    for (const k of [20, 40, 60, 80, 100]) {
      const r = await runConfig(kernel, queries, { label: `rrfK=${k}`, patchers: [() => patch(kernel.cfg.retrieve, 'rrfK', k)] });
      report.rrfK.push({ rrfK: k, ndcgAtK: r.ndcgAtK, mrr: r.mrr, recallAtK: r.recallAtK });
    }

    // alpha 扫描（衰减在排序里的配比）
    report.alpha = [];
    for (const a of [0, 0.15, 0.25, 0.4, 0.6]) {
      const undos = Object.values(PLANS).map((p) => patch(p, 'alpha', a));
      try {
        const r = await runConfig(kernel, queries, { label: `alpha=${a}` });
        report.alpha.push({ alpha: a, ndcgAtK: r.ndcgAtK, mrr: r.mrr, recallAtK: r.recallAtK });
      } finally { undos.forEach((u) => u()); }
    }

    // 各意图各路权重单变量 ±50%
    report.routeWeights = {
      halved: await scanRouteWeights(kernel, queries, baseline.ndcgAtK, 0.5),
      doubled: await scanRouteWeights(kernel, queries, baseline.ndcgAtK, 2),
    };

    // 差分衰减 A/B（P3+）：把一半语料回填成 40 天前，再对比半衰期档位。
    // 不回填的话全部条目都"很新"，衰减参数根本不可观测——那是假 A/B。
    const keys = Object.keys(idByKey);
    const aged = keys.filter((_, i) => i % 2 === 0);
    const ageMs = 40 * 864e5;
    dbTx(kernel.db, () => {
      for (const k of aged) {
        kernel.db.prepare(`UPDATE entries SET recorded_at = recorded_at - ?, last_decay_at = last_decay_at - ?,
                           persistence_at_decay = 0.5 WHERE id = ?`).run(ageMs, ageMs, idByKey[k]);
      }
    });
    report.decayAB = [];
    for (const [label, halfLifeDays] of [
      ['fact=15d/pattern=75d', { pattern: 75, fact: 15 }],
      ['fact=30d/pattern=75d（默认）', { pattern: 75, fact: 30 }],
      ['fact=60d/pattern=75d', { pattern: 75, fact: 60 }],
      ['fact=30d/pattern=40d', { pattern: 40, fact: 30 }],
      ['fact=30d/pattern=120d', { pattern: 120, fact: 30 }],
    ]) {
      const undo = patch(kernel.cfg.lifecycle, 'halfLifeDays', halfLifeDays);
      try {
        const r = await runConfig(kernel, queries, { label: `decay ${label}` });
        report.decayAB.push({ label, ndcgAtK: r.ndcgAtK, mrr: r.mrr, recallAtK: r.recallAtK });
      } finally { undo(); }
    }
  } finally {
    await kernel.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/* ───────────────── 路径 B 的 over-fetch 放大代价（§7 P2）───────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthVec(seed, dim) {
  const rnd = mulberry32(seed);
  const v = new Float32Array(dim);
  let n = 0;
  for (let i = 0; i < dim; i++) { v[i] = rnd() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

async function overfetchEval(report) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-eval-vec-'));
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 16 },
      retrieve: { minPartitionVectors: 10_000 },   // 强制全部走路径 B
    },
    domains: ['da', 'db', 'dc'].map((id) => defineDomain({ id, dir: path.join(root, id) })),
    embedder: createHashEmbedder(16),
    gitInit: false,
  });
  await kernel.init();

  const counts = { da: 10, db: 30, dc: 80 };
  let seed = 1;
  for (const [domain, n] of Object.entries(counts)) {
    const d = kernel.domains.get(domain);
    for (let i = 0; i < n; i++) {
      kernel.db.prepare(`INSERT INTO entries(id, domain_id, entry_type, text, topic_tags, triples, evidence_links,
                          source_ref, provenance, observed_at, recorded_at, persistence_init, last_decay_at,
                          persistence_at_decay, gamma_multiplier, activation_count, trust_prior_logit,
                          trust_posterior_logit, trust_updated_at, identity_scope, sensitivity, embedding_pending)
                          SELECT ?, ?, 'fact', 'x', '[]', '[]', '[]', '{}', '{}', 1, 1, 0.5, 1, 0.5, 1, 0, 0, 0, 1, 'domain', 'normal', 0`)
        .run(`${domain}:${i}`, domain);
      kernel.vec.upsert({ id: `${domain}:${i}`, domain_id: domain, cold: false }, synthVec(seed++, 16));
      kernel.write.bumpShardCount(domain, 'inserted');
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const rows = [];
  for (const [domain, count] of Object.entries(counts)) {
    for (const k of [3, 5, 8]) {
      // 完整复刻 vec.search 路径 B 的取数阶梯：fetch = k×oversample，不足则 ×2，至多 3 轮
      const q = synthVec(9999, 16);
      const blob = Buffer.from(q.buffer, q.byteOffset, q.byteLength);
      let fetch = k * kernel.cfg.retrieve.knnOversample;
      let scanned = 0;
      let returned = 0;
      for (let i = 0; i < 3; i++) {
        const hits = kernel.db.prepare(
          'SELECT entry_id AS id FROM entries_vec WHERE embedding MATCH ? AND k = ?',
        ).all(blob, fetch);
        scanned += hits.length;
        const ids = hits.map((h) => h.id);
        const inDomain = ids.length
          ? kernel.db.prepare(`SELECT COUNT(*) c FROM entries WHERE id IN (${ids.map(() => '?').join(',')}) AND domain_id = ?`)
            .get(...ids, domain).c
          : 0;
        if (inDomain >= k || hits.length < fetch) { returned = Math.min(inDomain, k); break; }
        fetch *= 2;
      }
      rows.push({
        domainVectors: count,
        tableVectors: total,
        share: round(count / total),
        k,
        scannedPerCall: scanned,
        returned,
        waste: round(scanned / Math.max(1, returned)),
        pathACost: k,
      });
    }
  }
  await kernel.close();
  await fs.rm(root, { recursive: true, force: true });

  // 建议：浪费倍数 ≥4× 是 oversample=4 的固有成本（首趟 fetch 就取 4k 行），
  // 真正的决策指标是**绝对扫描行数**（进检索 P95）与"阶梯翻倍有没有发生"（占比太低才会触发）。
  const doubled = rows.filter((r) => r.scannedPerCall > r.k * kernel.cfg.retrieve.knnOversample * 1.5);
  const maxScan = Math.max(...rows.map((r) => r.scannedPerCall));
  report.overfetch = {
    rows,
    suggestion: doubled.length
      ? `占比 ≤ ${Math.min(...doubled.map((r) => r.share))} 的域会触发阶梯翻倍（扫描 ${maxScan} 行 vs 路径 A 的 k 行）→ 这类小域适合让 minPartitionVectors 兜底到路径 A；当前默认 50 是否够，取决于真实表总量（占比 = 域向量 / 全表）`
      : `各规模均一趟收敛，绝对扫描行数最大 ${maxScan}（对照路径 A 的 k=${Math.max(...rows.map((r) => r.k))}）→ 维持当前默认 minPartitionVectors=50，待单表 > 10 万行时按真实占比重估`,
  };
}

/* ───────────── 内存精确索引 vs vec0（R-137 的评测面）───────────── */

/**
 * 同一批向量、同一批查询，对比两条路：
 *   ① 内存精确索引：每域常驻 flat Float32Array + usearch exactSearch（不搬 BLOB）
 *   ② vec0 MATCH：SQLite 内全精度扫描（每次查询把域内向量搬进进程）
 *
 * 判定指标：
 *   - **top-k 重叠率**：两者都是精确算法，重叠率不是 1.0 就是 bug（不是精度问题），
 *     所以这条是硬断言式的，低于 1.0 必须查；
 *   - 延迟比：内存索引省掉的正是"搬 BLOB"那一笔，这个倍数就是它存在的理由。
 *
 * 没有 ann 对照组了：rescore 索引上游从未发布，且实测 300 维下收益为负（R-136），
 * 那一整套评测已经删掉，别再加回来。
 */
async function vecEval(report) {
  // 用**真实维度**测（库里 model_meta 是 300），不跟着其它评测的 16 维走：
  // 这个对比的胜负手全在维度上——16 维时 BLOB 才 1.3MB，搬起来本来就快，
  // usearch 的跨语言调用开销反而成了主项（实测内存索引 1.54ms vs vec0 0.65ms，更慢）。
  const DIM_EVAL = 300;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-eval-vec-'));
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM_EVAL },
      write: { p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'vec', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(DIM_EVAL),
    gitInit: false,
  });
  try {
    await kernel.init();
    const N = 20_000;
    const K = 8;
    let seed = 7;

    // 直接灌 entries + 向量：本节只测向量路，别把配额/路由/抽取搅进来
    // 注意：不能用 generate_series —— 本机 SQLite 没编这个扩展（旧 annEval 写了它，
    // 但那条路被 canAnn=false 提前挡住，从未执行过，属于"看起来跑过"的死代码）。
    const insEntry = kernel.db.prepare(`INSERT INTO entries(id, domain_id, entry_type, text, topic_tags,
        triples, evidence_links, source_ref, provenance, observed_at, recorded_at, persistence_init,
        last_decay_at, persistence_at_decay, gamma_multiplier, activation_count, trust_prior_logit,
        trust_posterior_logit, trust_updated_at, identity_scope, sensitivity, embedding_pending)
        VALUES (?, 'vec', 'fact', 'x', '[]', '[]', '[]', '{}', '{}', 1, 1, 0.5, 1, 0.5, 1, 0, 0, 0, 1, 'domain', 'normal', 0)`);
    dbTx(kernel.db, () => { for (let i = 0; i < N; i++) insEntry.run(`vec:${i + 1}`); });
    kernel.db.exec('DELETE FROM vec_shards');
    kernel.db.prepare(`INSERT INTO vec_shards(domain_id, vector_count, updated_at) VALUES ('vec', ?, ?)`).run(N, Date.now());
    dbTx(kernel.db, () => {
      for (let i = 0; i < N; i++) kernel.vec.upsert({ id: `vec:${i + 1}`, domain_id: 'vec', cold: false }, synthVec(seed++, DIM_EVAL));
    });

    const queryVecs = Array.from({ length: 20 }, (_, q) => synthVec(90_000 + q, DIM_EVAL));
    const median = (a) => { const x = [...a].sort((m, n) => m - n); return x[Math.floor(x.length / 2)]; };
    const p95 = (a) => { const x = [...a].sort((m, n) => m - n); return x[Math.floor(x.length * 0.95)]; };

    const sweep = () => {
      const lat = [];
      const idss = [];
      for (const v of queryVecs) {
        const t0 = performance.now();
        idss.push(kernel.vec.search(v, 'vec', K).map((h) => h.id));
        lat.push(performance.now() - t0);
      }
      return { lat, idss };
    };

    // ① 内存索引。第一次查询会懒加载整个域，那一次的延迟不代表稳态 → 先热一次再计时
    kernel.vec.search(queryVecs[0], 'vec', K);
    const stats = kernel.vec.indexStats();
    const memRun = sweep();

    // ② 热关内存索引 → 下外审即回落 vec0（顺手验证"这开关不是死的"）
    kernel.cfg.retrieve.memIndex.enabled = false;
    const sqlRun = sweep();
    kernel.cfg.retrieve.memIndex.enabled = true;

    const overlaps = memRun.idss.map((ids, i) => {
      const other = new Set(sqlRun.idss[i]);
      return ids.filter((id) => other.has(id)).length / Math.max(1, ids.length);
    });
    const overlap = round(overlaps.reduce((a, b) => a + b, 0) / overlaps.length);
    const speedup = round(median(sqlRun.lat) / Math.max(1e-6, median(memRun.lat)));

    report.vec = {
      available: Boolean(stats.enabled),
      refusal: stats.refusal ?? null,
      vectors: N, queries: queryVecs.length, k: K,
      mem: { medianMs: round(median(memRun.lat)), p95Ms: round(p95(memRun.lat)) },
      sqlite: { medianMs: round(median(sqlRun.lat)), p95Ms: round(p95(sqlRun.lat)) },
      topKOverlap: overlap,
      residentBytes: stats.bytes,
      speedup,
      verdict: stats.enabled
        ? `内存精确索引比 vec0 快 ${speedup}×（P50）。top-k 重叠 ${overlap}——两者都是精确扫描，`
          + `重叠率低于 1.0 就是 bug 不是精度差，先查 swap-remove 的 id→下标映射。`
        : `内存索引未启用（${stats.refusal ?? 'unknown'}）→ 本节走的是 vec0 单路，没有对照意义。`,
    };
  } finally {
    await kernel.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/* ───────────── detectVerified 误报率（§16.2 的 P2 打开判据）───────────── */

function verifiedEval(report) {
  const cfg = loadConfig({});
  const pos = VERIFIED_SET.positives;
  const neg = VERIFIED_SET.negatives;
  const tp = pos.filter((m) => detectVerified(m, cfg)).length;
  const fp = neg.filter((m) => detectVerified(m, cfg)).length;

  // 触发密度按"千轮对话"口径：每轮一次 post-step，正例占比按评测集比例外推
  const densityPer1000 = Math.round((tp / (pos.length + neg.length)) * 1000);
  const fpRate = fp / neg.length;
  report.verified = {
    positives: pos.length, negatives: neg.length,
    truePositive: tp, falsePositive: fp,
    falsePositiveRate: round(fpRate),
    recallOnPositives: round(tp / pos.length),
    triggerPer1000Turns: densityPer1000,
    pass: fpRate < 0.05 && densityPer1000 >= 1,
    verdict: fpRate < 0.05 && densityPer1000 >= 1
      ? '误报 < 5% 且触发密度达标 → verifiedEnabled=true 维持'
      : '未达标 → 应回退 verifiedEnabled=false（§16.2）',
  };
}

/* ───────────────────────── 报告输出 ───────────────────────── */

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c)).join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

function toMarkdown(report) {
  const out = [];
  out.push(`# P2 校准报告`, '', `生成时间：${new Date().toISOString()}`, '');

  out.push(`## 1. 检索质量对比（NDCG@${K} / MRR / Recall@${K}）`, '');
  out.push(mdTable(
    ['配置', 'n', 'NDCG@K', 'MRR', 'Recall@K'],
    report.comparison.map((c) => [c.label, c.n, c.ndcgAtK, c.mrr, c.recallAtK]),
  ), '');
  out.push('> ⚠ **合成集上的对比只用于验证 harness 与方向性**：合成语料的嵌入走确定性哈希（词面哈希），'
    + '"纯向量"的得分高是词面重叠的伪象，**不能据此得出"该用纯向量"的结论**——'
    + '真实决策必须换真嵌入模型 + 真实查询重跑（§20：参数校准只能在真实数据上定稿）。', '');

  out.push(`## 2. classifyIntent 判定准确率`, '');
  out.push(`准确率 **${report.intent.accuracy}**（n=${report.intent.n}）。混淆分布：`, '');
  out.push(mdTable(['标注 → 判定', '条数'], Object.entries(report.intent.confusion)), '');

  out.push(`## 3. rrfK 单变量扫描`, '');
  out.push(mdTable(['rrfK', 'NDCG@K', 'MRR', 'Recall@K'],
    report.rrfK.map((r) => [r.rrfK, r.ndcgAtK, r.mrr, r.recallAtK])), '');
  const bestK = report.rrfK.reduce((a, b) => (b.ndcgAtK > a.ndcgAtK ? b : a));
  out.push(`NDCG 峰值在 rrfK=${bestK.rrfK}；曲线平台区间内取中点即可，不值得为小数点后的差异换默认值。`, '');

  out.push(`## 4. alpha（衰减配比）单变量扫描`, '');
  out.push(mdTable(['alpha', 'NDCG@K', 'MRR', 'Recall@K'],
    report.alpha.map((r) => [r.alpha, r.ndcgAtK, r.mrr, r.recallAtK])), '');

  out.push(`## 5. 意图 × 路权重单变量扫描（±50%，相对基线 NDCG 的变化）`, '');
  out.push('**减半**：', '');
  out.push(mdTable(['intent.route', 'NDCG', 'Δ'],
    report.routeWeights.halved.map((r) => [`${r.intent}.${r.route}×0.5`, r.ndcg, r.delta >= 0 ? `+${r.delta}` : r.delta])), '');
  out.push('', '**翻倍**：', '');
  out.push(mdTable(['intent.route', 'NDCG', 'Δ'],
    report.routeWeights.doubled.map((r) => [`${r.intent}.${r.route}×2`, r.ndcg, r.delta >= 0 ? `+${r.delta}` : r.delta])), '');
  const flat = [...new Set([...report.routeWeights.halved, ...report.routeWeights.doubled]
    .filter((r) => Math.abs(r.delta) < 0.005).map((r) => `${r.intent}.${r.route}`))];
  out.push('', flat.length
    ? `不敏感（|Δ| < 0.005）：${flat.join('、')} —— 这些权重在校准上没有抓手，保持默认。`
    : '所有权重都对 NDCG 有可观测影响。', '');

  out.push(`## 5b. 差分衰减 A/B（一半语料回填 40 天后对比半衰期档位）`, '');
  out.push(mdTable(['档位', 'NDCG@K', 'MRR', 'Recall@K'],
    report.decayAB.map((r) => [r.label, r.ndcgAtK, r.mrr, r.recallAtK])), '');
  const bestDecay = report.decayAB.reduce((a, b) => (b.ndcgAtK > a.ndcgAtK ? b : a));
  out.push('', `NDCG 最高：**${bestDecay.label}**。差分在"老化条目"上才可观测；全量灰度时按域分布加权再看。`, '');

  out.push(`## 6. 路径 B over-fetch 放大代价`, '');
  out.push(mdTable(
    ['域向量数', '表总量', '占比', 'k', '单次扫描行数', '实返', '浪费倍数', '路径A成本'],
    report.overfetch.rows.map((r) => [r.domainVectors, r.tableVectors, r.share, r.k, r.scannedPerCall, r.returned, r.waste, r.pathACost]),
  ), '');
  out.push(`**取值建议**：${report.overfetch.suggestion}`, '');

  out.push(`## 6b. 内存精确索引 vs vec0（R-137）`, '');
  if (report.vec.available) {
    out.push(mdTable(
      ['路径', '向量数', '查询数', 'k', 'P50 ms', 'P95 ms'],
      [
        ['内存精确索引（exactSearch）', report.vec.vectors, report.vec.queries, report.vec.k, report.vec.mem.medianMs, report.vec.mem.p95Ms],
        ['vec0 MATCH（每次搬 BLOB）', report.vec.vectors, report.vec.queries, report.vec.k, report.vec.sqlite.medianMs, report.vec.sqlite.p95Ms],
      ],
    ), '');
    out.push(`**常驻内存**：${(report.vec.residentBytes / 1048576).toFixed(1)} MB。**top-k 重叠率**：${report.vec.topKOverlap}。`, '');
    out.push(report.vec.verdict, '');
  } else {
    out.push(report.vec.verdict, '');
  }

  out.push(`## 7. detectVerified 误报率（verifiedEnabled 的打开判据，§16.2）`, '');
  const v = report.verified;
  out.push(mdTable(['正例', '命中', '负例', '误报', '误报率', '正例召回', '触发/千轮', '判定'],
    [[v.positives, v.truePositive, v.negatives, v.falsePositive, v.falsePositiveRate, v.recallOnPositives, v.triggerPer1000Turns, v.pass ? '达标' : '不达标']]));
  out.push('', v.verdict, '');

  // 【R-157】Security Suite 三套数据集
  out.push(`## 8. Security Suite：抽取保真（R-157 数据集①）`, '');
  out.push(mdTable(['用例', '结果', '实得'],
    report.extractFidelity.rows.map((r) => [r.name, r.ok ? '✓' : '✗', (r.got ?? []).join(' / ') + (r.error ? `（${r.error}）` : '')])), '');
  out.push('', report.extractFidelity.verdict, '');

  out.push(`## 9. Security Suite：冲突消解（R-157 数据集②）`, '');
  out.push(mdTable(['矛盾对', '结果', '实得裁决', '期望'],
    report.conflict.rows.map((r) => [r.name, r.ok ? '✓' : '✗', r.got ?? r.error ?? '', r.expect ?? ''])), '');
  out.push('', report.conflict.verdict, '');

  out.push(`## 10. Security Suite：隐私红线（R-157 数据集③，CI 红灯即失败）`, '');
  out.push(mdTable(['矩阵行', '结果', '实得可见', '期望'],
    report.privacy.rows.map((r) => [r.name, r.ok ? '✓' : '✗', String(r.got), String(r.expect)])), '');
  out.push('', report.privacy.verdict, '');
  return out.join('\n');
}

/* ───────────────────────── main ───────────────────────── */

const report = {};
await retrievalEval(report);
await overfetchEval(report);
await vecEval(report);
verifiedEval(report);

// 【R-157】Security Suite：抽取保真 / 冲突消解 / 隐私红线。隐私红灯 = 整个 eval 失败。
await extractEval(report);
await conflictEval(report);
await privacyEval(report);
const secOk = report.extractFidelity.passed && report.conflict.passed && report.privacy.passed;
if (!secOk) process.exitCode = 1;

await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
await fs.writeFile(path.join(OUT_DIR, 'report.md'), toMarkdown(report));
console.log(`报告已生成：${path.join(OUT_DIR, 'report.md')}（+ report.json）`);
console.log(`基线 NDCG@${K}=${report.baseline.ndcgAtK} | 意图准确率=${report.intent.accuracy} | verified 误报率=${report.verified.falsePositiveRate}`);

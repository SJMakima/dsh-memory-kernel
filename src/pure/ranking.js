/**
 * §13 的纯排序 / 判定逻辑 —— 进 P0-0 基线，接 SQLite 之前就能跑（附录 B）。
 */
import { collapseWs } from './normalize.js';
import { tokenizeBigram } from './tokenize.js';
import { parseTimeRange } from './dayparse.js';

/* ─────────────────────────── §13.3 加权 RRF ─────────────────────────── */

/**
 * 权重 × 1/(k + rank + 1)。**只用数组位置**，不读 `score`、不读 `rank` 字段 [R-76]。
 * 不做 min-max、不用 IDF：前者在单元素列表上 span=0 会把"唯一命中"归零，
 * 后者对短查询不稳定（§13.3）。
 */
export function weightedRRF(routes, weights, k = 60) {
  const acc = new Map();
  for (const [route, list] of Object.entries(routes)) {
    const w = weights[route] ?? 0;
    if (!w || !list?.length) continue;
    list.forEach((hit, rank) => {
      acc.set(hit.id, (acc.get(hit.id) ?? 0) + w / (k + rank + 1));
    });
  }
  return [...acc].map(([id, fused]) => ({ id, fused }));
}

/**
 * 冷热两路合成一条 `fts` 路 [R-69]。
 * 三条边界语义都写死在代码里，不靠"稳定排序"这种引擎行为：
 *   ① hot 为空 → offset 不生效（冷表是唯一来源）[R-72]
 *   ② 同 rank → hot 在前（写进比较器）[R-73]
 *   ③ 同一条目两路都出现 → 取更好的名次
 */
export function mergeFtsRoutes(hot, cold, coldRankOffset = 8) {
  const best = new Map();
  hot.forEach((h, i) => best.set(h.id, { rank: i, hot: true, hit: h }));

  const offset = hot.length > 0 ? coldRankOffset : 0;

  cold.forEach((c, i) => {
    const eff = i + offset;
    const prev = best.get(c.id);
    if (!prev || eff < prev.rank) best.set(c.id, { rank: eff, hot: false, hit: c });
  });

  return [...best.values()]
    .sort((a, b) => (a.rank - b.rank) || (a.hot === b.hot ? 0 : a.hot ? -1 : 1))
    .map((v) => v.hit);
}

/* ─────────────────────────── §13.1 意图与计划表 ─────────────────────────── */

export const PLANS = {
  factual: {
    k: 3, alpha: 0.15,
    fetch: { vector: 20, fts: 30, triple: 20, recent: 10 },
    weights: { vector: 0.6, fts: 1.2, triple: 1.5, recent: 0.3 },
  },
  explanatory: {
    k: 5, alpha: 0.25,
    fetch: { vector: 30, fts: 30, triple: 20, recent: 15 },
    weights: { vector: 1.2, fts: 0.8, triple: 0.8, recent: 0.4 },
  },
  relational: {
    k: 8, alpha: 0.40,
    fetch: { vector: 30, fts: 20, triple: 30, recent: 15 },
    weights: { vector: 0.8, fts: 0.5, triple: 1.2, recent: 0.3 },
    expand: { maxSubjects: 5, maxPerSubject: 3, decay: 0.5 },
    // 【连锁记忆】evidence_links 一跳扩展（§9.1 做活）：类型加权 causal > support > coexist，
    // 激活集封顶 2×k；触发与 subject 扩展同源（relational 意图）
    linkExpand: { maxSeeds: 5, decay: 0.5, activationCap: 16 },
  },
  // 【R-147】显式时间限定（"上周说的那个事"）：recent 权重抬高（时间近的先验更强），
  // 真正的过滤在 retrieve 侧按 parseTimeRange 区间做（plan 只带意图，不带区间）
  temporal: {
    k: 8, alpha: 0.40,
    fetch: { vector: 30, fts: 30, triple: 15, recent: 30 },
    weights: { vector: 0.8, fts: 1.0, triple: 0.8, recent: 0.5 },
  },
};

const RELATIONAL_CUES = /(和|跟|与|还有谁|谁跟|之间|关系|认识|上次|那次|之前说|后来|接着|因为|所以)/;
const EXPLANATORY_CUES = /(为什么|为啥|怎么|如何|原理|区别|是不是|能不能|讲讲|说说|解释|介绍|流程|步骤|举例)/;
// 【R-147】只认显式时间词（"后来那次""上次说的"是 relational 的活，不抢——R-58 顺序纪律）。
// 词表与 dayparse.parseTimeRange 能解析的形态对齐：cue 命中但区间解析不出 → 不判 temporal。
const TEMPORAL_CUES = /(上周|上个礼拜|上星期|上个月|上月|这周|这一周|本周|这个月|本月|昨天|前天|大前天|最近一?周|[一二两三四五六七八九十\d]+\s*天前|(?:最近|过去|近)\s*[一二两三四五六七八九十\d]+\s*天|(?:上|去)\s*(?:周|礼拜|星期)\s*[一二三四五六日天])/;

/** 命中域内 subject 词表的个数（≥2 即判 relational）。 */
export function countSubjectsInQuery(query, vocab) {
  // 【R-124】不能删空格：subject_key 用 collapseWs 保留内部单空格（"alice smith"），
  // 这里删掉就永远 includes 不上——中文无空格所以测不出来（正是 R-91 第七关的退化输入）。
  const q = collapseWs(String(query ?? '').toLowerCase());
  let n = 0;
  for (const s of vocab?.subjects ?? []) {
    if (s.length >= 2 && q.includes(s)) n++;
  }
  return n;
}

/**
 * 【R-58】判定顺序不可交换：relational → temporal → explanatory → factual。
 * 顺序即优先级 —— RELATIONAL_CUES 里的"因为/所以"也常出现在解释型问句里。
 * temporal 排 relational 之后："上周为什么吵架"同时含时间词与因果词时，宁可多召回
 * 不丢时间过滤，但 relational 的主语优先级更高（"上次"这类归 relational，见 TEMPORAL_CUES）。
 * 兜底选 factual 是因为它的 k 最小（3），错判时浪费最少。
 */
export function classifyIntent(query, vocab, { now = Date.now() } = {}) {
  const q = String(query ?? '').trim();
  if (RELATIONAL_CUES.test(q) || countSubjectsInQuery(q, vocab) >= 2) return 'relational';
  if (TEMPORAL_CUES.test(q) && parseTimeRange(q, now)) return 'temporal';
  if (EXPLANATORY_CUES.test(q)) return 'explanatory';
  return 'factual';
}

/* ─────────────────────────── §13.0 自包含短路 ─────────────────────────── */

const SELF_CONTAINED = [
  /^(早|早安|早上好|午安|晚安|嗨+|hi|hello|在吗)[\s!！。~?？]*$/i,
  /^(好的?|嗯+|哦+|ok|okay|收到|明白|了解|知道了|谢谢|thx)[\s!！。~]*$/i,
  /^(你是谁|你能做什么|有啥功能|help|帮助)[\s?？]*$/i,
  // 纯时间 / 纯算术。**【实现层收紧】必须带运算符**：
  // §13.0 的白名单里 `[\d\s+\-*/().]+` 会把裸 "1" 判成自包含，而正文明确说
  // "'1'、'嗯'、'继续' 恰恰强依赖上下文" —— 两者冲突时按正文的意图收紧。
  /^(现在几点|今天几号|星期几|[\d\s+\-*/().]*[+\-*/=＝][\d\s+\-*/().]*[=＝]?)$/,
];

/**
 * 只认白名单 [R-19]：误判成"自包含"的代价是"该检索时没检索"，比多检索一次贵得多。
 * "继续 / 然后呢 / 那个呢" 故意不在白名单里 —— 它们强依赖上下文。
 */
export function isSelfContained(msg, maxLen = 12) {
  const s = String(msg ?? '').trim();
  if (s.length === 0 || s.length > maxLen) return false;
  return SELF_CONTAINED.some((re) => re.test(s));
}

/* ─────────────────────────── §13.7 证据可复现 ─────────────────────────── */

/**
 * 连续子串优先；失败退到 bigram 覆盖率，容忍"用中文回复"↔"偏好中文回复"这类改写。
 * CJK 必须滑动窗口切 bigram [R-35]，拉丁按词切（否则纯英文 value 一条 gram 都取不到）。
 */
export function containsNormalized(haystack, needle, threshold = 0.8) {
  const h = collapseWs(String(haystack ?? '').toLowerCase());
  const n = collapseWs(String(needle ?? '').toLowerCase());
  if (n.length < 2) return true;                 // 过短的值不参与判定
  if (h.includes(n)) return true;

  const grams = [];
  for (const run of n.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) grams.push(run.slice(i, i + 2));
  }
  grams.push(...(n.match(/[a-z0-9]+/g) ?? []));
  if (grams.length === 0) return false;

  const hit = grams.filter((g) => h.includes(g)).length;
  return hit / grams.length >= threshold;
}

/* ───────────────────── §13.6 向量跳过（纯判定部分）───────────────────── */

/** `terms.length < 2` 时不跳：单个 bigram 说明不了问题。真正的 AND 覆盖查询在 DB 层。 */
export function shouldConsiderSkipVector(intent, query, tripleHits) {
  if (intent !== 'factual') return false;
  if (!tripleHits?.length) return false;
  const terms = tokenizeBigram(query).split(' ').filter(Boolean);
  return terms.length >= 2;
}

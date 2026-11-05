/**
 * §13 检索管线：四路召回 → 加权 RRF → 一跳扩展 → 准入/验签 → 排序 → 回读复核 → 记激活。
 *
 * 【R-45】`isSelfContained` 的判定在 `agent/pre-step`，**不在这里**。
 * 这一层拿到就意味着"确定需要检索"；再加一次判定 = 两套白名单 + "记忆时灵时不灵"。
 */
import { PLANS, classifyIntent, mergeFtsRoutes, weightedRRF, containsNormalized } from '../pure/ranking.js';
import { detectDayRange, parseTimeRange } from '../pure/dayparse.js';
import { localDate } from './diary.js';
import { EMOTION_ZH } from '../pure/emotion-shape.js';
import { lazyPersistence, shouldColdArchive } from '../pure/lifecycle.js';
import { sigmoid } from '../pure/normalize.js';
import { tokenizeBigram } from '../pure/tokenize.js';
import { loadEntries } from './entry.js';
import { getVocab, matchTripleTerms } from './vocab.js';
import { expandAttributeAliases, synonymExtrasFor } from '../pure/normalize.js';

export function createRetriever({ db, cfg, vec, files, audit, security, domains, write, reranker, transcript, inner, diary, gate }) {
  const getDomain = (id) => domains.get(id);
  const now = () => Date.now();

  /* ─────────────────────────── 四路召回 ─────────────────────────── */

  /**
   * 【R-74】必须显式 `ORDER BY bm25(...)` 升序。
   * 没有排序子句时 FTS5 按 rowid（写入顺序）返回，`LIMIT k` 取到"最早写入的 k 条"，
   * 而 fts 路在 factual 下的权重是 1.2（四路最高）—— 等于让最老的记忆拿最高融合权重。
   */
  function ftsSearch(query, domainId, k, table = 'entries_fts', includeSuperseded = false) {
    const tokens = tokenizeBigram(query);
    if (!tokens) return [];
    // 【实现层修正】FTS5 对空格分隔的多个 token 是**隐式 AND**，直接塞进去等于要求
    // "整句话的每个 bigram 都出现"，一句自然问句几乎永不命中。这里显式 OR，
    // 让 bm25 负责"命中越多越靠前"。（`shouldSkipVectorChannel` 里那个 AND 是故意的，
    // 它问的是"有没有 ≥2 条覆盖了 query 的全部词"，语义不同。）
    // 【检索增强】查询同义词典：query 命中组内词时把同组其他词并入 OR（cfg.retrieve.queryExpansion 开关）。
    // 扩展词用 FTS5 前缀查询（"词"*）——词典词可能是单字/短词，与索引的 bigram token 粒度对齐靠前缀匹配
    const base = tokens.split(' ').filter(Boolean).map((t) => `"${t}"`);
    const extras = cfg.retrieve.queryExpansion === false ? [] : synonymExtrasFor(query).split(' ').filter(Boolean).map((w) => `"${w}"*`);
    const match = [...new Set([...base, ...extras])].join(' OR ');
    // 【冲突治理 §1.1】JOIN entries 在 SQL 层排除被取代条目（superseded_by != NULL），
    // 否则旧状态占掉 top-k 名额，最新状态可能根本进不了候选。
    const alive = includeSuperseded ? '' : ' AND e.superseded_by IS NULL';
    // 热表查热条目、冷表查冷条目——JOIN 的温度条件跟随表名，别一刀切
    const temp = table === 'entries_fts' ? ' AND e.cold = 0' : ' AND e.cold = 1';
    return db.prepare(`
      SELECT f.entry_id AS id, bm25(${table}) AS score
      FROM ${table} f
      JOIN entries e ON e.id = f.entry_id${temp}${alive}
      WHERE f.tokens MATCH ? AND f.domain_id = ?
      ORDER BY bm25(${table})
      LIMIT ?
    `).all(match, domainId, k).map((r) => ({ id: r.id, score: r.score }));
  }

  function tripleSearch(query, domainId, k, includeSuperseded = false) {
    const vocab = getVocab(db, domainId);
    // 【冲突治理 §2.2】查询侧对称：query 里的 attribute 别名先替换成规范名再做词表匹配
    const { hitSubjects, hitAttrs } = matchTripleTerms(expandAttributeAliases(query), vocab);
    if (!hitSubjects.length && !hitAttrs.length) return [];

    const clauses = [];
    const params = [domainId];
    if (hitSubjects.length) {
      clauses.push(`t.subject_key IN (${hitSubjects.map(() => '?').join(',')})`);
      params.push(...hitSubjects);
    }
    if (hitAttrs.length) {
      clauses.push(`t.attribute IN (${hitAttrs.map(() => '?').join(',')})`);
      params.push(...hitAttrs);
    }

    return db.prepare(`
      SELECT t.entry_id AS id, COUNT(*) AS hits, MAX(e.observed_at) AS last_at
      FROM entry_triples t
      JOIN entries e ON e.id = t.entry_id AND e.cold = 0${includeSuperseded ? '' : ' AND e.superseded_by IS NULL'}
      WHERE t.domain_id = ? AND (${clauses.join(' OR ')})
      GROUP BY t.entry_id
      -- 【R-87】hits 与 last_at 并列时补 entry_id，否则名次不确定
      ORDER BY hits DESC, last_at DESC, t.entry_id
      LIMIT ?
    `).all(...params, k).map((r) => ({ id: r.id, score: r.hits }));
  }

  function recentWindowSearch(domainId, k, includeSuperseded = false) {
    const rows = db.prepare(`
      SELECT id, observed_at FROM entries
      WHERE domain_id = ? AND cold = 0${includeSuperseded ? '' : ' AND superseded_by IS NULL'}
      -- 【R-85】同毫秒写入时补 id 作次要键
      ORDER BY observed_at DESC, id LIMIT ?
    `).all(domainId, k);
    const nowMs = now();
    return rows.map((r) => ({
      id: r.id,
      score: 1 / (1 + (nowMs - r.observed_at) / cfg.retrieve.recentHalfLifeMs),
    }));
  }

  /** §13.6：用「AND 全覆盖查询」表达"≥2 条命中覆盖 query 全部词"，不需要额外 coverage()。 */
  function shouldSkipVectorChannel(intent, query, domainId, tripleHits) {
    if (!cfg.retrieve.skipVector.enabled) return false;
    if (intent !== 'factual') return false;
    if (!tripleHits.length) return false;

    const terms = tokenizeBigram(query).split(' ').filter(Boolean);
    if (terms.length < 2) return false;

    const andQuery = terms.map((t) => `"${t}"`).join(' AND ');
    // 这条 LIMIT 2 只用于 COUNT，顺序无关（禁止项 49 的合法例外）
    const n = db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT entry_id FROM entries_fts WHERE tokens MATCH ? AND domain_id = ? LIMIT 2
      )
    `).get(andQuery, domainId).c;
    return n >= 2;
  }

  /* ─────────────────────── §13.4 一跳扩展 ─────────────────────── */

  function expandBySubject(fused, domainId, opt) {
    const out = new Map();
    for (const seed of fused.slice(0, opt.maxSubjects)) {
      const subjects = db.prepare(`
        SELECT DISTINCT subject_key FROM entry_triples WHERE domain_id = ? AND entry_id = ?
      `).all(domainId, seed.id);
      for (const { subject_key } of subjects) {
        const neighbors = db.prepare(`
          SELECT DISTINCT t.entry_id AS id
          FROM entry_triples t JOIN entries e ON e.id = t.entry_id AND e.cold = 0
          WHERE t.domain_id = ? AND t.subject_key = ? AND t.entry_id <> ?
          -- 【R-87】同毫秒条目顺序随机 → 补 t.entry_id
          ORDER BY e.observed_at DESC, t.entry_id LIMIT ?
        `).all(domainId, subject_key, seed.id, opt.maxPerSubject);
        for (const n of neighbors) {
          out.set(n.id, Math.max(out.get(n.id) ?? 0, seed.fused * opt.decay));   // 取 max，不累加
        }
      }
    }
    return out;
  }

  /* ─────────────────── 连锁记忆：evidence_links 一跳扩展（§9.1 做活） ─────────────────── */

  const LINK_WEIGHT = { causal: 1.0, support: 0.8, coexist: 0.6 };

  /**
   * 与 expandBySubject 同型的边扩展：对 top-k 种子沿 entry_links 跳一跳，
   * 分数 = 种子分 × 类型权重 × 衰减，取 max 不叠加。只扩冷热由后续 admit 统一裁决；
   * 激活集封顶 activationCap——连锁是"多想起几条"，不是"想起一切"。
   * 安全底线：返回的 id 只进 ranked 候选池，后续与种子走**同一条** admit + 验签管线，
   * 不因"是连锁带出来的"绕过 sensitivity / cold 检查。
   */
  function expandByLinks(fused, opt) {
    const seeds = fused.slice(0, opt.maxSeeds);
    if (!seeds.length) return new Map();
    const q = db.prepare(`
      SELECT linked_id, type FROM entry_links
      WHERE entry_id = ? AND type IN ('causal', 'support', 'coexist')
      LIMIT ?`);
    const out = new Map();
    for (const seed of seeds) {
      for (const { linked_id: id, type } of q.all(seed.id, opt.activationCap)) {
        out.set(id, Math.max(out.get(id) ?? 0, seed.fused * (LINK_WEIGHT[type] ?? 0.6) * opt.decay));
      }
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, opt.activationCap);
  }

  /* ─────────────────────────── 准入 / 验签 ─────────────────────────── */

  /**
   * 【R-153】成对隐私判定迁入 access-gate（pairVisible），admit 只做管线内其余硬排除。
   * 【R-157.4】admitReason：与 admit 同判据，但返回拒绝原因——trace 要能回答
   * "为什么拒绝它"，只给布尔回答不了。返回 null = 准入通过。
   */
  function admitReason(e, domain, req) {
    if (!gate.pairVisible(e, req)) return 'pair-privacy';
    if (e.superseded_by != null && !req.includeSuperseded) return 'superseded';
    if (req.minPersistence != null && lazyPersistence(e, cfg) < req.minPersistence) return 'min-persistence';
    if (e.cold && !req.includeCold) return 'cold-excluded';
    if (e.archived_topic && !req.includeArchived) return 'archived-topic';
    if (e.identity_scope === 'domain') {
      return e.domain_id === domain.id ? null : 'domain-scope';
    }
    if (!e.shareable || e.sensitivity !== 'normal') return 'sensitivity';
    if (e.domain_id === domain.id) return null;
    return (cfg.domainAllowlist[domain.id] ?? []).includes(e.domain_id) ? null : 'domain-allowlist';
  }

  function admit(e, domain, req) {
    return admitReason(e, domain, req) === null;
  }

  /**
   * 【R-157.4】检索 Trace 的采集器：单次请求一份，随 audit 落 `retrieval-trace` 通道，
   * 也挂在返回值 `result.trace` 上（eval 下钻直接读内存，不用翻日志）。
   * 边界：**敏感原文不入 trace**（query 只记长度，text 不落）；保留期限随 FTS optimize 周期清理。
   */
  function traceCollector(requestId, domainId, intent) {
    const sources = new Map();      // id -> {fts:{rank,score}, vector:{...}, triple:{...}, recent:{...}}
    const candidates = new Map();   // id -> {entryId, sources, fused, admission, score, finalRank}
    const addSource = (name, hits) => {
      hits.forEach((h, i) => {
        const s = sources.get(h.id) ?? {};
        s[name] = { rank: i + 1, score: Number((h.score ?? 0).toFixed(6)) };
        sources.set(h.id, s);
      });
    };
    return {
      addSource,
      addCandidate(id, { fused, score }) {
        candidates.set(id, { entryId: id, sources: sources.get(id) ?? {}, fused: Number((fused ?? 0).toFixed(6)), ...(score != null ? { score: Number(score.toFixed(6)) } : {}) });
      },
      mark(id, admission, extra = {}) {
        const c = candidates.get(id);
        if (c) Object.assign(c, { admission, ...extra });
      },
      done({ skipVec, elapsedMs, top }) {
        for (const [i, t] of (top ?? []).entries()) {
          const c = candidates.get(t.e?.id ?? t.id);
          if (c) c.finalRank = i + 1;
        }
        const list = [...candidates.values()].slice(0, 200);   // 上限防爆量（ranked 池理论 <100）
        const rejected = list.filter((c) => c.admission && c.admission !== 'admitted');
        const trace = {
          requestId, domainId, intent,
          skipVec: skipVec === true,
          candidates: list,
          rejected: rejected.map((c) => ({ entryId: c.entryId, reason: c.admission })),
          admittedCount: list.filter((c) => c.admission === 'admitted').length,
          rejectedCount: rejected.length,
          elapsedMs,
          at: new Date().toISOString(),
        };
        return trace;
      },
    };
  }

  /* ─────────────────────── §13.7 回读复核 ─────────────────────── */

  async function reReadAndCheck(e, domain) {
    if (!domain.requireSignature) return null;                 // 只对低信任域
    if (domain.sourceReaderIsLocal === false) {
      return { unavailable: true, evidence: 0, reason: 'remote-reader' };
    }
    let orig;
    try {
      orig = await withDeadline(domain.sourceReader.read(e.source_ref), cfg.security.rereadDeadlineMs);
    } catch {
      return { unavailable: true, evidence: 0, reason: 'read-failed-or-timeout' };
    }

    const triples = e.triples ?? [];
    // 【禁止项 29】不能 return 1：空三元组说明抽取违规，放行等于"不吐三元组就免检"
    if (triples.length === 0) return { unavailable: false, evidence: 0.5, reason: 'empty-triples' };

    // 验证目标是"证据可复现"（value 能否在原文找到），不是抽取文本与原文的相似度
    const hit = triples.filter((t) => containsNormalized(orig.text, t.value, cfg.security.bigramCoverageThreshold)).length;
    return { unavailable: false, evidence: hit / triples.length };
  }

  /* ─────────────────────────── 主流程 ─────────────────────────── */

  async function retrieve(req) {
    const t0 = now();
    // `req.domainId` 是显式指定（跨域合并时用）；否则按 session 路由。
    const domain = (req.domainId && domains.get(req.domainId)) ?? domains.routeDomain(req.sessionId);
    if (!domain) return emptyResult(t0, req);

    // 【R-109】全域检索：一次问遍所有域，结果按名次融合、每条自带 domain_id 出身处。
    // 单域部署下 targets 为空，等价于本域检索（所以默认开启是安全的）。
    const wantAll = req.allDomains ?? (cfg.retrieve.allDomains?.enabled !== false);
    if (wantAll) return retrieveAcrossDomains(req, domain, t0);

    const intent = req.intent ?? classifyIntent(req.query, getVocab(db, domain.id));
    const plan = PLANS[intent];
    // top_k 是调用方的显式覆盖（工具入参）；仍设 50 的硬上限，避免一个参数把回读范围撑爆
    const k = Math.max(1, Math.min(req.topK ?? plan.k, 50));

    // 1. 召回（并行）。冷表只有在 include_cold 时查，且单独计时（不进 500ms 预算）
    const coldT0 = now();
    const [ftsHits, tripleHits, recentHits, qVec, coldHits] = await Promise.all([
      Promise.resolve(ftsSearch(req.query, domain.id, plan.fetch.fts, 'entries_fts', req.includeSuperseded)),
      Promise.resolve(tripleSearch(req.query, domain.id, plan.fetch.triple, req.includeSuperseded)),
      Promise.resolve(recentWindowSearch(domain.id, plan.fetch.recent, req.includeSuperseded)),
      vec.embedQuery(req.query),
      Promise.resolve(req.includeCold ? ftsSearch(req.query, domain.id, plan.fetch.fts, 'entries_fts_cold', req.includeSuperseded) : []),
    ]);
    const coldScanMs = req.includeCold ? now() - coldT0 : 0;
    if (coldScanMs > cfg.retrieve.coldScanWarnMs) {
      await audit.coldScanSlow({ domainId: domain.id, coldScanMs, query: req.query });
    }

    // 冷热合成一条 fts 路：分开进 RRF 会让 fts 的总权重翻倍
    const ftsAll = mergeFtsRoutes(ftsHits, coldHits, cfg.retrieve.coldRankOffset);

    // 【R-157.4】trace 采集：各通道原始名次/分数（分数只到 1e-6，敏感原文不落 trace）
    const trace = traceCollector(req.requestId, domain.id, intent);
    trace.addSource('fts', ftsAll);
    trace.addSource('recent', recentHits);
    trace.addSource('triple', tripleHits);

    // 【R-54】两类降级必须分开记：`vec:not-ready`（模型还在加载）与 `vec:rpc-timeout`（模型在、这条超时）。
    // 混在一起的话，P0 第一次手测必然把前者误诊成"RPC 有 bug"，然后去调大 rpcTimeoutMs ——
    // 调大只是把误判推迟，不解决问题。
    if (qVec === null && vec.enabled) {
      await audit.write('vec-degraded', {
        domainId: domain.id,
        requestId: req.requestId,
        label: vec.isReady() ? 'vec:rpc-timeout' : 'vec:not-ready',
      });
    }

    const skipVec = qVec === null
      || shouldSkipVectorChannel(intent, req.query, domain.id, tripleHits);
    const vecHits = skipVec ? [] : vec.search(qVec, domain.id, plan.fetch.vector);
    trace.addSource('vector', vecHits);   // 【R-157.4】向量路名次（skipVec 时为空，trace 里看得到）

    // 2. 加权 RRF
    const fused = weightedRRF(
      { vector: vecHits, fts: ftsAll, triple: tripleHits, recent: recentHits },
      plan.weights,
      cfg.retrieve.rrfK,
    );

    // `ScoredHit.score` 的消费方之一：P2 校准权重需要各路原始分分布（采样写）
    if (cfg.retrieve.routeScoreSampling > 0 && Math.random() < cfg.retrieve.routeScoreSampling) {
      await audit.routeScores({
        requestId: req.requestId, intent, vector: vecHits, fts: ftsAll, triple: tripleHits, recent: recentHits,
      });
    }

    // 3. 扩展（仅 relational）：取 max，不叠加
    //    两条连锁路同源触发：subject 扩展（§13.4）+ evidence_links 边扩展（§9.1 做活）。
    //    边扩展出来的 id 只进候选池，与种子共用第 4/5 步的批量取 Entry + admit + 验签。
    let ranked;
    if (intent === 'relational' && plan.expand) {
      ranked = new Map(fused.map((f) => [f.id, f.fused]));
      for (const [id, s] of expandBySubject(fused, domain.id, plan.expand)) {
        ranked.set(id, Math.max(ranked.get(id) ?? 0, s));
      }
      if (plan.linkExpand) {
        for (const [id, s] of expandByLinks(fused, plan.linkExpand)) {
          ranked.set(id, Math.max(ranked.get(id) ?? 0, s));
        }
      }
    } else {
      ranked = new Map(fused.map((f) => [f.id, f.fused]));
    }

    // 4. 批量取 Entry（含验签所需全字段；triples 来自 entries.triples 原文）
    const entries = loadEntries(db, [...ranked.keys()], {
      includeCold: req.includeCold, includeArchived: req.includeArchived,
    });

    // 5. 准入 + 验签 + 排序
    // 【R-147】temporal：parseTimeRange 区间硬过滤。放宽纪律——区间内不足 k 时
    // **放宽而不是清空**（同"按实有量给"）：先在准入后按时间分两组，组内不足才放开全量。
    const timeRange = intent === 'temporal' ? parseTimeRange(req.query, t0) : null;
    const scored = [];
    const outOfRange = [];
    const coldProbe = db.prepare('SELECT cold, archived_topic, superseded_by FROM entries WHERE id = ?');
    for (const [id, rrfScore] of ranked) {
      trace.addCandidate(id, { fused: rrfScore });
      const e = entries.get(id);
      if (!e) {
        // loadEntries 的冷存/归档过滤发生在取数层——trace 要把"被哪层拒的"说准，别都写成 not-loaded
        const row = coldProbe.get(id);
        trace.mark(id, row ? (row.superseded_by != null ? 'superseded' : row.cold ? 'cold-excluded' : row.archived_topic ? 'archived-topic' : 'not-loaded') : 'not-loaded');
        continue;
      }
      const reason = admitReason(e, domain, req);
      if (reason !== null) { trace.mark(id, reason); continue; }
      if (!security.verifyEntrySignature(e, getDomain)) {
        trace.mark(id, 'signature-failed');
        await audit.signatureFailure({ entryId: e.id, domainId: e.domain_id, reason: 'verify-failed' });
        continue;
      }
      trace.mark(id, 'admitted');
      const p = lazyPersistence(e, cfg, t0);
      const item = { e, score: rrfScore * (1 - plan.alpha + plan.alpha * p) * sigmoid(e.trust_posterior_logit) };
      // 【R-144】importance 排序调制：与 activation（persistence）解耦的第三轴——
      // 重要的事不容易忘（衰减/冷存管不着），也不该在排序里沉底。w=0 关闭。
      const impW = cfg.retrieve.importanceWeight ?? 0;
      if (impW !== 0) {
        item.score *= 1 + impW * ((e.importance ?? 0.5) - 0.5);
      }
      if (timeRange && !(e.observed_at >= timeRange.start && e.observed_at < timeRange.end)) outOfRange.push(item);
      else scored.push(item);
    }
    if (timeRange && scored.length < k && outOfRange.length) {
      // 放宽：区间内不足 k，把区间外的按分并入（区间内的仍排前——同分才看原始序）
      await audit.write?.('temporal-relaxed', {
        requestId: req.requestId, domainId: domain.id, inRange: scored.length, relaxed: outOfRange.length,
        range: { start: timeRange.start, end: timeRange.end },
      });
      scored.push(...outOfRange);
    }
    scored.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1));

    // 6. 回读复核：**over-read 后降权再截断**（不能先截 top-k 再降权重排）[禁止项 31]
    const overRead = Math.min(cfg.security.rereadOverRead, Math.max(0, scored.length - k));
    const pool = scored.slice(0, k + overRead);
    const excluded = new Set();
    const contexts = new Map();

    await Promise.all(pool.map(async (t) => {
      const r = await reReadAndCheck(t.e, domain);
      contexts.set(t.e.id, r);
      if (!r || r.unavailable) return;

      const factor = r.evidence < 0.5 ? cfg.security.rereadPenalty ** 2
        : r.evidence < 1 ? cfg.security.rereadPenalty : 1;
      await audit.rereadShadow({ entryId: t.e.id, evidence: r.evidence, factor, enforced: cfg.security.rereadEnforcePenalty });

      if (r.evidence < 0.5) {
        // 硬失败（抽曲解）→ 直接排除；P1 shadow 期间这条也生效
        excluded.add(t.e.id);
        trace.mark(t.e.id, 'reread-excluded');
        await audit.signatureFailure({ entryId: t.e.id, domainId: domain.id, evidence: r.evidence, reason: 'reread-excluded' });
      } else if (cfg.security.rereadEnforcePenalty) {
        t.score *= factor;
      }
    }));

    pool.sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1));

    // P3+ cross-encoder 重排（可插拔，默认关）。三条纪律：
    //   ① 只在 over-read 池内动顺序，不扩大取数（重排是精排，不是召回），且**必须发生在
    //      最终 score 排序之后**——放在前面会被 pool.sort 原样盖掉，钩子等于没接；
    //   ② 它是本地推理，不吃 embedding RPC 配额（R-62），但耗时进 500ms 预算，灰度看 P95；
    //   ③ 失败 → 原顺序继续。重排是增强，不是依赖。
    if (cfg.retrieve.rerank?.enabled && reranker?.rerank && pool.length > 1) {
      const poolSize = Math.min(cfg.retrieve.rerank.pool ?? 24, pool.length);
      try {
        const rerankPool = pool.slice(0, poolSize);
        const ranked = await reranker.rerank(req.query, rerankPool.map((t) => ({ id: t.e.id, text: t.e.text })));
        const order = new Map((ranked ?? []).map((x, i) => [x.id, i]));
        if (order.size) {
          rerankPool.sort((a, b) => (order.get(a.e.id) ?? Number.MAX_SAFE_INTEGER)
            - (order.get(b.e.id) ?? Number.MAX_SAFE_INTEGER));
          pool.splice(0, rerankPool.length, ...rerankPool);
        }
        await audit.write('rerank', { requestId: req.requestId, pool: poolSize, returned: order.size });
      } catch (err) {
        await audit.write('rerank-failed', { requestId: req.requestId, error: String(err?.message ?? err) });
      }
    }

    // 排除用集合过滤，不用 -Infinity 哨兵（两个 -Infinity 相减得 NaN）
    const top = pool.filter((t) => !excluded.has(t.e.id)).slice(0, k);

    // 6.5 【R-108】原话片段：**独立一段，不进 RRF**。原文没有 entry_id，混进融合排序会污染
    // id 一致性；它的价值是"当时怎么说的"（语气/上下文），与"提炼出的事实"互补而非同一路。
    // 默认本域过滤（R-110）：原话是隐私含量最高的数据，跨域互检既是泄露也是噪声。
    // 【R-141】原话双路：FTS（字面）+ 向量（语义），RRF 融合。
    // 背景是实测盲区：用户问"我给你发了句歌词吗"，原话"我不难过只是为什么~"里没有
    // "歌词"二字，FTS 永远捞不到——向量路就是给这种"意思相近、词面不同"补的。
    // 两路打分量纲不同（bm25 为负、cos 相似 0~1），直接比大小没有意义，用名次融合。
    let transcripts = [];
    if (transcript) {
      try {
        const k2 = (cfg.transcript?.searchTopK ?? 3) * 2;
        const [fts, vecHits] = await Promise.all([
          Promise.resolve(transcript.search(req.query, { domainId: domain.id, k: k2 })).catch(() => []),
          transcript.searchVec ? transcript.searchVec(req.query, { domainId: domain.id, k: k2 }) : Promise.resolve([]),
        ]);
        const key = (t) => `${t.ts}\u0000${t.text}`;
        const merged = new Map();
        fts.forEach((t, i) => { const k0 = key(t); merged.set(k0, { ...t, rrf: (merged.get(k0)?.rrf ?? 0) + 1 / (60 + i) }); });
        vecHits.forEach((t, i) => { const k0 = key(t); merged.set(k0, { ...merged.get(k0), ...t, rrf: (merged.get(k0)?.rrf ?? 0) + 1 / (60 + i) }); });

        // 【泛句降权】lexvec 对短泛句嵌入高度相似（"行，我只听…"成了万能背景句，检索演练实测
        // 10/11 题都召回它）。判据是数据驱动而不是黑名单：同域内**同文本重复出现**（口头禅/
        // 模板句）≥ demoteRepeat 次 → rrf 打折。重复少的偶发句不受影响。
        const demoteRepeat = cfg.transcript?.demoteRepeat ?? 3;
        if (demoteRepeat > 0) {
          const cnt = db.prepare('SELECT COUNT(*) AS c FROM transcript WHERE domain_id = ? AND text = ?');
          for (const m of merged.values()) {
            try {
              if (cnt.get(domain.id, m.text).c >= demoteRepeat) m.rrf *= cfg.transcript?.demoteFactor ?? 0.3;
            } catch { /* 单行计数失败不挡检索 */ }
          }
        }

        transcripts = [...merged.values()]
          .sort((a, b) => b.rrf - a.rrf || b.ts - a.ts)
          .slice(0, cfg.transcript?.searchTopK ?? 3);
      } catch { transcripts = []; }
    }

    // 6.6 【R-139】当日档案 + 日记检索：与原话片段同型（独立段、不进 RRF）。
    //   dayArchive —— 查询里带日期（"回忆一下 10 月 1 号"）时触发：那天的日记 + 内心活动 + 原话。
    //     四路召回对这种查询是全盲的（日期是剥掉的噪声、没有关键词），这是唯一的通道。
    //   diaryHits —— 无日期时轻量搜日记 FTS（k=2）："我是不是说过想学吉他"可能落在日记里。
    let dayArchive = null;
    let diaryHits = [];
    const emotionInjectable = cfg.emotion?.enabled !== false;   // 【R-142 评审#3】开关只控注入
    if (diary?.enabled?.() ?? true) {
      try {
        const day = detectDayRange(req.query, t0);
        if (day && day.end <= now() + 864e5) {   // 未来日期（解析错位）不响应
          const d = diary.get(domain.id, localDate(day.start));
          const notes = inner ? inner.range(domain.id, day.start, day.end).slice(0, 5) : [];
          const msgs = db.prepare('SELECT ts, speaker, text FROM transcript WHERE domain_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 12')
            .all(domain.id, day.start, day.end);
          // 【R-142】当天情绪紧凑序列（原始编码，评审 #6：防 LLM 二次压缩失真）。
          // 注：这里不滤噪——单日查询是"翻档案"场景，如实给全量点，滤噪只用于"近期轨迹"摘要。
          let moodLine = null;
          if (emotionInjectable) {
            try {
              const moodPts = db.prepare(`
                SELECT ts, owner, emotion, strong, source FROM emotion_log
                WHERE domain_id = ? AND ts >= ? AND ts < ? AND emotion IS NOT NULL ORDER BY ts
              `).all(domain.id, day.start, day.end);
              const hh = (t) => { const d0 = new Date(t); return `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`; };
              moodLine = moodPts.map((p) => `${hh(p.ts)}${p.owner === 'agent' ? (p.source === 'self' ? '你【自述】' : '你') : '对方'}${EMOTION_ZH[p.emotion] ?? p.emotion}${p.strong ? '（强）' : ''}`).join(' / ') || null;
            } catch { /* 老库无表 */ }
          }
          dayArchive = {
            date: localDate(day.start),
            matched: day.matched,
            moodLine,
            diary: d ? { content: d.content, generatedBy: d.generated_by } : null,
            inner: notes.map((n) => ({ ts: n.ts, text: n.text })),
            messages: msgs.map((m) => ({ ts: m.ts, speaker: m.speaker, text: m.text })),
          };
        }
        diaryHits = await diary.searchAsync(req.query, { domainId: domain.id }) ?? [];
      } catch { /* 日记/档案查询失败不阻塞主检索 */ }
    }

    // 7. 命中回报：只记事件，不动 trust / persistence
    write.recordActivations(top.map((t) => t.e.id), 'retrieval', t0);    // 【R-80】retrieval_log 的唯一消费方是 applyVerified；P1 verifiedEnabled=false 时不写
    if (cfg.trust.verifiedEnabled) {
      db.prepare('INSERT OR REPLACE INTO retrieval_log(request_id, domain_id, entry_ids, created_at) VALUES (?, ?, ?, ?)')
        .run(req.requestId, domain.id, JSON.stringify(top.map((t) => t.e.id)), t0);
    }

    // 【R-157.4】trace 收口：随 audit 落 `retrieval-trace` 通道 + 挂在返回值上（eval 下钻直接读）
    const traceRow = trace.done({ skipVec, elapsedMs: now() - t0, top });
    void audit.write?.('retrieval-trace', traceRow);

    return {
      domain,
      entries: top.map((t) => t.e),
      contexts: top.map((t) => contexts.get(t.e.id) ?? null),
      transcripts,
      dayArchive,
      diaryHits,
      intent,
      timeRange: timeRange ? { start: timeRange.start, end: timeRange.end, matched: timeRange.matched } : null,
      skipVec,
      elapsedMs: now() - t0,
      coldScanMs,
      opsQuery: req.includeCold === true,
      query: req.query,
      requestId: req.requestId,
      trace: traceRow,
    };
  }

  /**
   * 【R-109】全域检索：对每个域各跑一次完整管线，再做**名次融合**（rank-RRF）。
   *
   * 为什么不去掉 SQL 里的 `domain_id = ?`：三路召回各自依赖域内词表（`getVocab`）、
   * 域内向量分区（vec0 PARTITION KEY）与域内三元组索引——去掉过滤会让词表与分区串味，
   * 召回质量反而崩。逐域跑再融合既保真又天然带出身处。
   *
   * 隐私不靠这个开关兜：private/shared 的成对可见性在 `admit()` 里硬过滤（R-117），
   * 跨域查 private 条目一样看不见。
   */
  async function retrieveAcrossDomains(req, primary, t0) {
    const targets = domains.list().filter((d) => d.id !== primary.id);
    if (!targets.length) return retrieve({ ...req, allDomains: false });

    const parts = [await retrieve({ ...req, allDomains: false })];
    for (const d of targets) {
      try {
        parts.push(await retrieve({ ...req, allDomains: false, domainId: d.id }));
      } catch (err) {
        await audit.write('cross-domain-failed', { domainId: d.id, error: String(err?.message ?? err) });
      }
    }

    const fused = new Map();
    for (const r of parts) {
      r.entries.forEach((e, i) => {
        const cur = fused.get(e.id) ?? { e, score: 0, ctx: null };
        cur.score += 1 / (cfg.retrieve.rrfK + i + 1);
        cur.ctx = cur.ctx ?? (r.contexts ?? [])[i] ?? null;
        fused.set(e.id, cur);
      });
    }
    const ordered = [...fused.values()].sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1));
    const k = Math.max(1, Math.min(req.topK ?? cfg.retrieve.defaultTopK, 50));
    const top = ordered.slice(0, k);

    // 原话不跨域合并（R-110）：只保留发起方本域那一路，隐私边界不因全域检索而放宽。
    return {
      ...parts[0],
      entries: top.map((x) => x.e),
      contexts: top.map((x) => x.ctx),
      domains: parts.map((r) => r.domain?.id).filter(Boolean),
      elapsedMs: now() - t0,
    };
  }

  function emptyResult(t0, req) {
    return {
      domain: null, entries: [], contexts: [], transcripts: [], intent: 'factual', skipVec: true,
      elapsedMs: now() - t0, coldScanMs: 0, opsQuery: req?.includeCold === true,
      query: req?.query ?? '', requestId: req?.requestId ?? null, trace: null,
    };
  }

  return {
    retrieve, ftsSearch, tripleSearch, recentWindowSearch,
    shouldSkipVectorChannel, expandBySubject, admit, admitReason, pairVisible: (e, req) => gate.pairVisible(e, req), reReadAndCheck,
    shouldColdArchive: (e) => shouldColdArchive(e, cfg),
  };
}

function withDeadline(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('deadline-exceeded')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

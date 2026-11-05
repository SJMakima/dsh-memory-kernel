/**
 * §15 组装：静态 guide / 稳定段 / 动态段。
 *
 * 稳定段进 system prompt（参与 prefix cache），动态段进**当前 user 消息**。
 * 两处分离的收益是"前缀不动"，代价是每轮要剥离历史动态段（见 pure/assembly.js）。
 */
import { lazyPersistence } from '../pure/lifecycle.js';
import {
  GUIDE, trimToBudget, buildDynamicSection, stripHistoricalDynamic, injectDynamic,
} from '../pure/assembly.js';
import { rowToEntry } from './entry.js';
import { shapeEmotionSeries, EMOTION_ZH } from '../pure/emotion-shape.js';

export function createAssembler({ db, cfg, audit, domains, emotions }) {
  let cachedHash = null;
  let cachedText = null;

  const stableSortKey = (e, now = Date.now()) => {
    const recency = e.last_activated_at
      ? 1 / (1 + (now - e.last_activated_at) / cfg.assemble.recencyHalfLifeMs)
      : 0;
    return lazyPersistence(e, cfg, now) * 0.7 + recency * 0.3;
  };

  function listEntries(domainId, { type, scope } = {}) {
    const where = ['cold = 0'];
    const params = [];
    if (type) { where.push('entry_type = ?'); params.push(type); }
    if (scope) { where.push('identity_scope = ?'); params.push(scope); }
    if (domainId && scope !== 'shared_core') { where.push('domain_id = ?'); params.push(domainId); }
    const rows = db.prepare(`SELECT * FROM entries WHERE ${where.join(' AND ')}`).all(...params);
    return rows.map(rowToEntry).sort((a, b) => stableSortKey(b) - stableSortKey(a));
  }

  function buildStableSection(domainId) {
    const sections = [
      { key: 'boundary', title: '## 身份与边界（本域）', list: listEntries(domainId, { type: 'boundary' }) },
      { key: 'skill', title: '## 本域技能', list: listEntries(domainId, { type: 'skill' }) },
      // 只对跨域共享做数量截断（sharedMax 宁小勿大，避免把预算逼到临界点）
      { key: 'shared', title: '## 跨域共享身份', list: listEntries(domainId, { scope: 'shared_core' }).slice(0, cfg.assemble.sharedMax) },
    ];
    return trimToBudget(sections, cfg.assemble.tokenBudget.stable, ['shared', 'skill'], (o) => {
      audit.budgetOverflow(o);   // 超预算不是异常，是可被 grep 到的运维信号
    });
  }

  /**
   * 【R-96】情绪聚合：只读、本域、近 N 天、排除冷存与被取代。
   * 只在有数据时返回非空——没标过情绪的用户零额外 token。
   */
  function emotionStats(domainId) {
    const conf = cfg.assemble.emotionHint ?? {};
    if (conf.enabled === false || !domainId) return null;
    const windowDays = conf.windowDays ?? 3;
    const since = Date.now() - windowDays * 864e5;
    let rows;
    try {
      rows = db.prepare(`
        SELECT emotion, COUNT(*) AS count FROM entries
        WHERE domain_id = ? AND emotion != 'neutral' AND emotion_owner = 'user'
          AND cold = 0 AND superseded_by IS NULL AND observed_at >= ?
        GROUP BY emotion ORDER BY count DESC, emotion LIMIT 3
      `).all(domainId, since);
    } catch { return null; }   // 老库还没跑 ensureColumns 时不让组装整条失败
    return rows.length ? { windowDays, items: rows } : null;
  }

  /**
   * 【R-142】情绪曲线（emotion_log）：近 N 天双轨点 → 形状化滤噪 → 双行摘要。
   * 与 emotionStats（entries 标注）并存——一个是"被写下的记忆里标的"，一个是"每轮判的轨迹"，
   * 样本量差一个数量级。开关只在这里判（注入），采集在 extract/emotion 侧无条件进行。
   */
  function emotionCurve(domainId, nowTs) {
    if (cfg.emotion?.enabled === false || !domainId) return null;
    const windowDays = cfg.emotion?.windowDays ?? 3;
    const since = nowTs - windowDays * 864e5;
    const points = emotions.range(domainId, since, nowTs);
    if (!points.length) return null;
    // **按轨道分形状**（emotion-shape 是单轨函数）：user 判定 / agent 表达（extract）各走滤噪；
    // felt（self 第一手）不滤噪，全保留。三轨合成一个 curve 对象。
    const by = (owner, source) => points.filter((p) => p.owner === owner && (!source || p.source === source));
    return {
      windowDays,
      user: shapeEmotionSeries(by('user')),
      agentExpressed: shapeEmotionSeries(by('agent', 'extract')),
      felt: by('agent').filter((p) => p.source === 'self'),
    };
  }

  /**
   * 【R-148】冲突提示：读未消费的 conflict 家族信号（pending-conflict / cross-entry-conflict），
   * 让 Agent 知道"库里对 X 存在不同记忆，请结合语境确认"——裁决权在人与 Agent（R-120 红线），
   * 组装层只复述事实，不下结论。上限 3 条防提示段膨胀；信号不在此消费置位（提示≠结算）。
   */
  function conflictHints(domainId) {
    try {
      const rows = db.prepare(`
        SELECT kind, detail, created_at FROM consolidation_signals
        WHERE domain_id = ? AND consumed = 0 AND kind LIKE '%conflict%' AND detail IS NOT NULL
        ORDER BY created_at DESC LIMIT 3
      `).all(domainId);
      return rows.map((r) => {
        let d = {};
        try { d = JSON.parse(r.detail ?? '{}'); } catch { /* 坏明细当无明细 */ }
        return { kind: r.kind, at: r.created_at, ...d };
      });
    } catch { return []; }
  }

  function dynamicFor(result, recentTurns) {
    const domainId = result.domain?.id;
    return buildDynamicSection({ ...result, domain: result.domain }, recentTurns, (id) => domains.get(id), {
      emotionStats: emotionStats(domainId),
      emotionCurve: emotionCurve(domainId, Date.now()),
      transcripts: result.transcripts ?? [],
      dayArchive: result.dayArchive ?? null,   // 【R-139】当日档案
      diaryHits: result.diaryHits ?? [],       // 【R-139】日记回溯
      conflictHints: conflictHints(domainId),  // 【R-148】冲突提示（信号家族消费口）
    });
  }

  /**
   * 组装入口。
   * 输入：sessionId + 消息数组（最后一条是当前 user 消息）+ 检索结果
   * 输出：{ system, messages } —— 历史动态段已剥离，当前消息已注入本轮动态段
   */
  function assemble({ sessionId, messages, result, recentTurns = [] }) {
    const domain = domains.routeDomain(sessionId);
    const stable = buildStableSection(domain?.id);
    const hash = fnv1a(stable);
    if (hash !== cachedHash) {
      cachedHash = hash;
      cachedText = stable;
      audit.assemble({ event: 'stable-rebuild', domainId: domain?.id, hash, bytes: stable.length });
    }

    const dynamic = dynamicFor({ ...result, domain }, recentTurns);
    return {
      system: [GUIDE, cachedText].filter(Boolean).join('\n\n'),
      messages: injectDynamic(messages, dynamic),
      stableHash: hash,
      guide: GUIDE,
      stable: cachedText,
      dynamic,
    };
  }

  /** 只取 system prompt（自包含短路时用：不注入动态段，但稳定段照旧）。 */
  function systemPrompt(domainId) {
    const stable = buildStableSection(domainId);
    cachedHash = fnv1a(stable);
    cachedText = stable;
    return [GUIDE, stable].filter(Boolean).join('\n\n');
  }

  /** 压缩事件：强制下外审重建稳定段 + 动态段。 */
  function invalidate() {
    cachedHash = null;
    cachedText = null;
  }

  return { assemble, buildStableSection, systemPrompt, invalidate, stripHistoricalDynamic, stableSortKey };
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

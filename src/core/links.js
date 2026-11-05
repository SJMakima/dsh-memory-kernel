/**
 * 【连锁记忆 · 第三步】共现边挖掘：从 retrieval_log 里长出"一起被想起过"的 coexist 边。
 *
 * 这是唯一让连锁网"自己长出来"的通道——不靠任何预埋，系统用得越久，
 * 同 request 反复共同命中的条目对就自动连得越密（"聊到咖啡顺势想起你熬夜"）。
 *
 * 设计约束：
 *   - 边只写 entry_links 表（source='dream'），**不进 md 真相源**——它是可从
 *     retrieval_log 完全重算的派生数据，rebuild 时重挖一遍即可（与 extract 声明边
 *     从 md/JSON 重灌是两条独立通道）。
 *   - minCo 频次阈值 + perEntryCap 单条目边数上限，防止热门条目长成蜘蛛网。
 *   - 幂等：同对重复挖不重复写（主键去重，ON CONFLICT IGNORE）。
 */

const LINK_TYPES = new Set(['support', 'causal', 'coexist']);

/**
 * 从 retrieval_log 窗口内挖 coexist 边并落库。
 * @returns {{ pairs: number, edges: number }} pairs=满足频次的条目对数，edges=实际写入的边数（含双向）
 */
export function mineCooccurrenceLinks(db, { windowMs = 30 * 864e5, minCo = 3, perEntryCap = 8, now = Date.now() } = {}) {
  const since = now - windowMs;
  const rows = db.prepare('SELECT entry_ids FROM retrieval_log WHERE created_at >= ?').all(since);
  const counts = new Map();   // 'a\u0000b'（a<b 保证有序）→ 共现次数
  for (const r of rows) {
    let ids;
    try { ids = JSON.parse(r.entry_ids); } catch { continue; }
    if (!Array.isArray(ids)) continue;
    const uniq = [...new Set(ids.filter((x) => typeof x === 'string'))];
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const key = `${uniq[i]}\u0000${uniq[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }

  // 达到频次阈值的对 → 按频次降序分配配额（热门联想优先保留）
  const qualified = [...counts.entries()]
    .filter(([, c]) => c >= minCo)
    .sort((a, b) => b[1] - a[1])
    .map(([key, c]) => {
      const [a, b] = key.split('\u0000');
      return { a, b, co: c };
    });

  const capOf = new Map();   // entry_id → 已占用的 dream 边数
  const accepted = [];
  for (const p of qualified) {
    if ((capOf.get(p.a) ?? 0) >= perEntryCap || (capOf.get(p.b) ?? 0) >= perEntryCap) continue;
    capOf.set(p.a, (capOf.get(p.a) ?? 0) + 1);
    capOf.set(p.b, (capOf.get(p.b) ?? 0) + 1);
    accepted.push(p);
  }

  const ins = db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at)
                          VALUES (?, ?, 'coexist', 'dream', ?)
                          ON CONFLICT(entry_id, linked_id, type, source) DO NOTHING`);
  let edges = 0;
  db.transaction(() => {
    for (const p of accepted) {
      edges += ins.run(p.a, p.b, now).changes;
      edges += ins.run(p.b, p.a, now).changes;   // 双向：扩展查询只走 entry_id 侧
    }
  })();

  return { pairs: accepted.length, edges };
}

/** 校验 EvidenceLink 形状（写入口与重建共用）。 */
export function isValidLink(l) {
  return Boolean(l && typeof l.entry_id === 'string' && l.entry_id
    && ['support', 'causal', 'coexist'].includes(l.type));
}

export { LINK_TYPES };

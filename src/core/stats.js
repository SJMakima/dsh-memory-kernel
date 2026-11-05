/**
 * 【R-152】状态聚合（health 组的数据面）——适配层（src/index.js / dsh/ / bin/）的
 * 只读 SQL 全部收拢到这里，消费方只调函数，不再各自 `kernel.db.prepare`。
 * 纯只读：任何一行 SELECT 都不写库；表缺失（老库）按 0/空兜底不抛。
 */
export function statusStats(db) {
  const n = (sql, ...params) => {
    try { return db.prepare(sql).get(...params); } catch { return undefined; }
  };
  const all = (sql, ...params) => {
    try { return db.prepare(sql).all(...params); } catch { return []; }
  };
  return {
    entries: n('SELECT COUNT(*) c FROM entries')?.c ?? 0,
    cold: n('SELECT COUNT(*) c FROM entries WHERE cold = 1')?.c ?? 0,
    vecPending: n('SELECT COUNT(*) c FROM entries WHERE embedding_pending = 1')?.c ?? 0,
    sources: all("SELECT json_extract(source_ref, '$.adapter_id') AS src, COUNT(*) AS c FROM entries GROUP BY src ORDER BY c DESC")
      .map((r) => ({ id: r.src ?? 'unknown', count: r.c })),
    entryTypes: all('SELECT entry_type AS t, COUNT(*) AS c FROM entries GROUP BY entry_type ORDER BY c DESC')
      .map((r) => ({ type: r.t, count: r.c })),
    emotionTags: all("SELECT emotion, COUNT(*) c FROM entries WHERE emotion != 'neutral' GROUP BY emotion ORDER BY c DESC")
      .map((r) => ({ emotion: r.emotion, count: r.c })),
    confirmPending: n("SELECT COUNT(*) c FROM pending_candidates WHERE reason = 'confirm' AND expire_at > ?")?.c ?? 0,
    domainEntries(domainIds) {
      const out = {};
      for (const id of domainIds) {
        out[id] = n('SELECT COUNT(*) c FROM entries WHERE domain_id = ?', id)?.c ?? 0;
      }
      return out;
    },
  };
}

/** CLI stats 命令的聚合（同一数据面，别在 bin 里手写第二份 SQL）。 */
export function cliStats(db, extra = {}) {
  const s = statusStats(db);
  return {
    ...s,
    ftsRows: n0(db, 'SELECT COUNT(*) c FROM entries_fts'),
    triples: n0(db, 'SELECT COUNT(*) c FROM entry_triples'),
    vecRows: extra.vecEnabled ? n0(db, 'SELECT COUNT(*) c FROM entries_vec') : 'vec:disabled',
    pending: n0(db, 'SELECT COUNT(*) c FROM pending_candidates'),
    activationEvents: n0(db, 'SELECT COUNT(*) c FROM activation_events'),
    quotas: all(db, 'SELECT domain_id, date, count FROM quotas'),
    topPersistence: all(db, 'SELECT id, text, persistence_at_decay p FROM entries ORDER BY p DESC LIMIT 3'),
  };
}

function n0(db, sql) { try { return db.prepare(sql).get().c; } catch { return 0; } }
function all(db, sql) { try { return db.prepare(sql).all(); } catch { return []; } }

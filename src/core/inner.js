/**
 * 【R-139】内心活动流水层（inner_log）。
 *
 * 与 transcript（R-108）同型的三条边界，别在别处"顺手"放松：
 *   ① **纯机械追加**：进来什么存什么，不判真假、不分类、不占配额、不进真相源。
 *      "她当时为什么这么说"的第一手记录，来源只有 memory_inner 工具（她自己写）——
 *      宿主 pre-step 消息里没有推理内容通道（已核实），内核拿不到实时思考，
 *      任何"自动捕获内心"的尝试都是编造。日记里的「当时的想法」是合并层：
 *      第一手（inner_log）标注【第一手】，LLM 从对话推断的标注【推断】。
 *   ② **检索默认本域**：内心活动比原话更私密（她的动机、犹豫、倾向），
 *      跨域互检同样是泄露。与 transcript 的 R-110 决策对称。
 *   ③ **不进 RRF**：作为动态段独立呈现，不污染 entries 的 id 一致性。
 *
 * 生命周期同 transcript（retainDays）：流水是情景记忆会淡忘，
 * 耐久版是日记合并后的「当时的想法」段落（进真相源，永不删）。
 */
import { sha256 } from '../pure/normalize.js';
import { tokenizeBigram } from '../pure/tokenize.js';

export function createInner({ db, cfg }) {
  const enabled = () => cfg.inner?.enabled !== false;

  /** 追加一批内心活动（幂等：UNIQUE(session_id, text_hash) + INSERT OR IGNORE）。 */
  function append({ sessionId, domainId, notes = [], now = Date.now() }) {
    if (!enabled() || !sessionId || !domainId || !notes.length) return { written: 0 };
    const maxChars = cfg.inner?.maxCharsPerNote ?? 500;

    const insRow = db.prepare(`
      INSERT OR IGNORE INTO inner_log(session_id, domain_id, ts, text, text_hash)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insFts = db.prepare(`
      INSERT INTO inner_fts(tokens, inner_id, session_id, domain_id) VALUES (?, ?, ?, ?)
    `);
    const findId = db.prepare('SELECT id FROM inner_log WHERE session_id = ? AND text_hash = ?');
    let written = 0;

    db.transaction(() => {
      for (const n of notes) {
        const raw = String(n?.text ?? '').trim();
        if (!raw) continue;
        // 去空白后哈希：同一条内心活动换个首尾空白不该被记两遍
        const hash = sha256(raw.replace(/\s+/g, ''));
        const existed = findId.get(sessionId, hash);
        if (existed) continue;
        const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
        const r = insRow.run(sessionId, domainId, n?.ts ?? now, text, hash);
        insFts.run(tokenizeBigram(text), r.lastInsertRowid, sessionId, domainId);
        written++;
      }
    })();
    return { written };
  }

  /** 本域内关键词检索（FTS，bm25 排序）。 */
  function search(query, { domainId, k } = {}) {
    if (!enabled() || !domainId) return [];
    const tokens = tokenizeBigram(String(query ?? ''));
    if (!tokens) return [];
    const match = tokens.split(' ').filter(Boolean).map((t) => `"${t}"`).join(' OR ');
    try {
      return db.prepare(`
        SELECT t.text, t.ts, bm25(inner_fts) AS score
        FROM inner_fts f
        JOIN inner_log t ON t.id = f.inner_id
        WHERE f.tokens MATCH ? AND f.domain_id = ?
        ORDER BY bm25(inner_fts), t.ts DESC, t.id DESC
        LIMIT ?
      `).all(match, domainId, Math.max(1, Math.min(k ?? 3, 10)))
        .map((r) => ({ text: r.text, ts: r.ts, score: r.score, kind: 'inner' }));
    } catch {
      return [];   // FTS 查询失败不阻塞主检索
    }
  }

  /** 按时间段取（日记生成用）。 */
  function range(domainId, start, end) {
    return db.prepare(`
      SELECT ts, text FROM inner_log
      WHERE domain_id = ? AND ts >= ? AND ts < ? ORDER BY ts
    `).all(domainId, start, end);
  }

  function prune(nowMs) {
    const days = Number(cfg.inner?.retainDays ?? 180);
    if (!(days > 0)) return 0;
    const cutoff = nowMs - days * 864e5;
    const victims = db.prepare('SELECT id FROM inner_log WHERE ts < ?').all(cutoff);
    if (!victims.length) return 0;
    const delFts = db.prepare('DELETE FROM inner_fts WHERE inner_id = ?');
    const delRow = db.prepare('DELETE FROM inner_log WHERE id = ?');
    db.transaction(() => { for (const v of victims) { delFts.run(v.id); delRow.run(v.id); } })();
    return victims.length;
  }

  function stats() {
    try {
      const total = db.prepare('SELECT COUNT(*) AS c FROM inner_log').get().c;
      const domains = db.prepare('SELECT domain_id, COUNT(*) AS c FROM inner_log GROUP BY domain_id').all();
      const latest = db.prepare('SELECT MAX(ts) AS t FROM inner_log').get().t;
      return { total, domains, latest: latest ?? null };
    } catch { return { total: 0, domains: [], latest: null }; }
  }

  return { append, search, range, prune, stats, enabled };
}

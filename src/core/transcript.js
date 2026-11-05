/**
 * 【R-108】对话流水层（transcript）：原话的独立存储与召回。
 *
 * 三条边界写死在这里，别在别处"顺手"放松：
 *   ① **纯机械追加**：进来什么存什么，不判重（除非内容完全一样）、不分类、不占配额、
 *      不进真相源 Markdown。做判断的是 Agent（memory_remember）或 LLM 抽取，不是这一层
 *      —— 代码猜"哪句是承诺"必然误判（R-115 的同一个禁令）。
 *   ② **检索默认本域**（R-110）：原话是隐私含量最高的数据，跨域互检既是泄露也是噪声。
 *      与 entries 的全域检索形成对照——entries 带出身标注可以跨域，原话不行。
 *   ③ **不进 RRF**：原文没有 entry_id，混进融合排序会污染 id 一致性；它作为动态段里
 *      独立的一小段呈现（"当时怎么说的" vs "提炼出的事实"）。
 */
import { sha256 } from '../pure/normalize.js';
import { tokenizeBigram } from '../pure/tokenize.js';

/** speaker 归一：宿主的 role 只有 user/assistant，多平台 adapter 可显式给 speaker。 */
function speakerOf(m) {
  const raw = m?.speaker ?? m?.author ?? m?.source?.speaker;
  if (raw) return String(raw);
  return m?.role === 'assistant' ? 'assistant' : 'owner';
}

const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);

export function createTranscript({ db, cfg, vec }) {
  const enabled = () => cfg.transcript?.enabled !== false;

  /**
   * 追加一批消息（幂等）。
   * pre-step 每轮都给**全量** messages，所以必须靠内容哈希去重——
   * 否则同一条消息会随着轮次线性膨胀成 N 份。去掉空白与动态段后算哈希：
   * 注入的 `<memory_context>` 每轮都变，不剥掉的话同一条用户消息会被当成新消息反复写入。
   */
  async function append({ sessionId, domainId, messages = [], now = Date.now() }) {
    if (!enabled() || !sessionId || !domainId || !messages.length) return { written: 0 };
    const maxChars = cfg.transcript?.maxCharsPerMsg ?? 1000;

    const insRow = db.prepare(`
      INSERT OR IGNORE INTO transcript(session_id, domain_id, ts, speaker, text, text_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insFts = db.prepare(`
      INSERT INTO transcript_fts(tokens, transcript_id, session_id, domain_id) VALUES (?, ?, ?, ?)
    `);
    const findId = db.prepare('SELECT id FROM transcript WHERE session_id = ? AND text_hash = ?');

    let written = 0;
    const fresh = [];   // { id, text } —— 新落库的，向量化用
    db.transaction(() => {
      for (const m of messages) {
        const text = String(m?.content ?? '').replace(/<memory[-_]context\b[^>]*>[\s\S]*?<\/memory[-_]context>/gi, '').trim();
        if (!text) continue;
        const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
        const speaker = speakerOf(m);
        const hash = sha256(`${speaker}\u0000${hashKey(clipped)}`).slice(0, 32);

        const before = findId.get(sessionId, hash);
        if (before) continue;                       // 幂等：这条原话已经在库里
        const r = insRow.run(sessionId, domainId, Number(m?.ts ?? now), speaker, clipped, hash);
        if (!r.changes) continue;
        const id = Number(r.lastInsertRowid);
        const tokens = tokenizeBigram(clipped);
        if (tokens) insFts.run(tokens, id, sessionId, domainId);
        fresh.push({ id, text: clipped });
        written += 1;
      }
    })();

    // 【R-141】向量化：FTS 只认字面，"歌词"对不上"我不难过只是为什么~"。
    // 嵌入失败/未就绪静默跳过（FTS 路仍在），缺口由 backfillVectors 补。
    if (fresh.length && vec?.enabled && vec.isReady()) {
      try {
        const embeddings = await vec.embedTexts(fresh.map((x) => x.text));
        // vec0 虚表不支持 INSERT OR IGNORE / REPLACE（禁止项 3 同族），必须查重 + 裸插
        const has = db.prepare('SELECT 1 FROM transcript_vec WHERE message_id = ?');
        const insVec = db.prepare('INSERT INTO transcript_vec(message_id, domain_id, embedding) VALUES (?, ?, ?)');
        db.transaction(() => {
          for (let i = 0; i < fresh.length; i++) {
            if (!embeddings[i] || has.get(String(fresh[i].id))) continue;
            insVec.run(String(fresh[i].id), domainId, toBlob(embeddings[i]));
          }
        })();
      } catch { /* 向量路失败不影响原话落库 */ }
    }
    return { written };
  }

  /**
   * FTS5 检索原话。`domainId` 必填（本域过滤是隐私边界，不是优化）。
   * 命中按相关度排，同分按时间新→旧（R-85 的次要键纪律：不补时间序等于随机）。
   */
  function search(query, { domainId, k } = {}) {
    if (!enabled() || !domainId) return [];
    const tokens = tokenizeBigram(String(query ?? ''));
    if (!tokens) return [];
    const match = tokens.split(' ').filter(Boolean).map((t) => `"${t}"`).join(' OR ');
    try {
      return db.prepare(`
        SELECT t.text, t.ts, t.speaker, bm25(transcript_fts) AS score
        FROM transcript_fts f
        JOIN transcript t ON t.id = f.transcript_id
        WHERE f.tokens MATCH ? AND f.domain_id = ?
        ORDER BY bm25(transcript_fts), t.ts DESC, t.id DESC
        LIMIT ?
      `).all(match, domainId, Math.max(1, Math.min(k ?? cfg.transcript?.searchTopK ?? 3, 10)))
        .map((r) => ({ text: r.text, ts: r.ts, speaker: r.speaker, score: r.score }));
    } catch {
      return [];   // 老库还没有这张表时不让整轮检索失败
    }
  }

  /** 运维统计（运行状态页展示）：按域计数 + 最新时间戳。 */
  function stats({ domainId } = {}) {
    try {
      if (domainId) {
        return db.prepare('SELECT COUNT(*) AS count, MAX(ts) AS lastAt FROM transcript WHERE domain_id = ?').get(domainId)
          ?? { count: 0, lastAt: null };
      }
      return db.prepare('SELECT COUNT(*) AS count, MAX(ts) AS lastAt FROM transcript').get() ?? { count: 0, lastAt: null };
    } catch { return { count: 0, lastAt: null }; }
  }

  /** TTL 清理（dream 顺路调；原话体积增长比条目快得多）。 */
  function prune({ retainDays = cfg.transcript?.retainDays ?? 180, now = Date.now() } = {}) {
    if (!retainDays || retainDays <= 0) return { deleted: 0 };
    const cutoff = now - retainDays * 864e5;
    const rows = db.prepare('SELECT id FROM transcript WHERE ts < ?').all(cutoff);
    if (!rows.length) return { deleted: 0 };
    const delFts = db.prepare('DELETE FROM transcript_fts WHERE transcript_id = ?');
    const delRow = db.prepare('DELETE FROM transcript WHERE id = ?');
    db.transaction(() => {
      for (const r of rows) { delFts.run(r.id); delRow.run(r.id); }
    })();
    return { deleted: rows.length };
  }

  /**
   * 【R-141】向量检索原话：补 FTS 的语义盲区（"歌词" vs "我不难过只是为什么~"）。
   * 与 search() 同型：本域必填、失败返回 [] 不阻塞主检索。score = 1 - distance。
   */
  async function searchVec(query, { domainId, k } = {}) {
    if (!enabled() || !domainId || !vec?.enabled || !vec.isReady()) return [];
    try {
      const qv = await vec.embedQuery(String(query ?? ''));
      if (!qv) return [];
      const hits = db.prepare(`
        SELECT message_id, distance FROM transcript_vec
        WHERE embedding MATCH ? AND domain_id = ? AND k = ?
      `).all(toBlob(qv), domainId, Math.max(1, Math.min(k ?? 3, 10)));
      if (!hits.length) return [];
      const get = db.prepare('SELECT text, ts, speaker FROM transcript WHERE id = ?');
      return hits
        .map((h) => { const t = get.get(h.message_id); return t ? { ...t, ts: Number(t.ts), score: 1 - h.distance, kind: 'transcript-vec' } : null; })
        .filter(Boolean);
    } catch { return []; }
  }

  /**
   * 【R-141】回填：嵌入器没就绪期间落库的原话没有向量，这里补齐。
   * init 后台跑一次，dream 每轮再扫（量小，LEFT JOIN 一把就出来）。
   */
  async function backfillVectors(limit = 500) {
    if (!vec?.enabled || !vec.isReady()) return 0;
    let rows;
    try {
      rows = db.prepare(`
        SELECT t.id, t.domain_id, t.text FROM transcript t
        LEFT JOIN transcript_vec v ON v.message_id = t.id
        WHERE v.message_id IS NULL LIMIT ?
      `).all(limit);
    } catch { return 0; }
    if (!rows.length) return 0;
    let n = 0;
    try {
      const embeddings = await vec.embedTexts(rows.map((r) => r.text));
      // vec0 不支持 INSERT OR IGNORE：LEFT JOIN 查过的缺口行直接裸插（并发重复靠主键兜底抛错可忽略）
      const ins = db.prepare('INSERT INTO transcript_vec(message_id, domain_id, embedding) VALUES (?, ?, ?)');
      db.transaction(() => {
        rows.forEach((r, i) => {
          if (!embeddings[i]) return;
          try { ins.run(String(r.id), r.domain_id, toBlob(embeddings[i])); n++; } catch { /* 已有向量：跳过 */ }
        });
      })();
    } catch { return n; }
    return n;
  }

  return { append, search, searchVec, backfillVectors, stats, prune };
}

/** 去重键：抹平空白与大小写差异，避免"同一句话多敲一个空格"被存两份。 */
const hashKey = (s) => s.replace(/\s+/g, ' ').toLowerCase();

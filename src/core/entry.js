/**
 * §9.1 Entry + §12.3 `buildEntry`（候选 → 完整 Entry 的唯一构造点 [R-77]）。
 *
 * `buildEntry` 决定的三件事全都影响衰减曲线与排序，所以**只在这里写一次**：
 *   生命周期初值、trust 初值、state 块是否完整（首写不完整 = 重建后那条记忆的年龄被抹掉）。
 *
 * 【R-83】这里**一个字段都不归一化**：`Entry.triples` 是原文，要落 Markdown、要参与签名。
 * 归一化只发生在 `writeTripleRows` 落 `entry_triples` 时。
 */
import { logit, newUlid, normalizeValue } from '../pure/normalize.js';

const MAX_TEXT_CHARS = 200;   // ADR-24：写入端约束，注入端不截断

/** 初始化持久度 = max(全局初值, 本类型 floor)，保证"出生即达标"（R-123）。 */
function initialPersistence(entryType, cfg) {
  const init = cfg.lifecycle.initPersistence;
  const floor = cfg.lifecycle.floor?.[entryType] ?? 0;
  return Math.max(init, floor);
}

/** 【R-95】情绪枚举收敛：非法/缺省一律 neutral（写入端不做"猜情绪"，猜是 Agent/LLM 的事）。 */
export const EMOTIONS = ['neutral', 'joy', 'sadness', 'anger', 'anxiety', 'fatigue'];
function normalizeEmotion(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return EMOTIONS.includes(s) ? s : 'neutral';
}

export function buildEntry(c, domain, cfg, now = Date.now()) {
  const t = now;
  const prior = logit(domain.trustPrior ?? 0.5);
  const seq = c.triples ?? [];

  return {
    id: newUlid(t),
    domain_id: domain.id,
    source_ref: c.sourceRef,
    provenance: c.provenance,
    observed_at: c.observedAt ?? t,
    recorded_at: t,
    text: c.text,
    entry_type: c.entryType,
    topic_tags: c.topicTags ?? [],
    triples: seq.map((x) => ({
      subject: x.subject,
      attribute: x.attribute,               // **保留原大小写**
      value: normalizeValue(x.value),       // 只 trim（§9.2 第 3 行）
    })),
    evidence_links: c.evidenceLinks ?? [],

    // 【R-123】初值必须 ≥ 本类型的 floor：boundary 的 floor 是 0.6，而全局 initPersistence 是 0.5，
    // 直接取全局值会让新条目"一出生就低于自己的下限"，与 §14 的语义冲突（两套数字对齐）。
    persistence_init: initialPersistence(c.entryType, cfg),
    persistence_at_decay: initialPersistence(c.entryType, cfg),
    last_decay_at: t,
    gamma_multiplier: 1.0,
    activation_count: 0,
    last_activated_at: null,

    trust_prior_logit: prior,
    trust_posterior_logit: prior,           // 从 prior 起步，不是 0
    trust_updated_at: t,

    signature: null,
    signature_key_id: null,
    identity_scope: domain.identityScope ?? 'domain',
    shareable: c.shareable ?? domain.shareableByDefault ?? false,
    sensitivity: c.sensitivity ?? domain.defaultSensitivity ?? 'normal',
    // 【R-95】情绪走列、追加式；缺省 neutral（不参与判重、不占配额、不进三元组）。
    emotion: normalizeEmotion(c.emotion),
    emotion_owner: c.emotionOwner === 'agent' ? 'agent' : 'user',
    archived_topic: false,
    cold: false,
    superseded_by: null,
    supersedes: [],
    // 【R-144】写入期判定 importance（与 activation 解耦，永不衰减）：
    //   boundary/skill = 1.0（原冷存豁免类型的等价抬升）；
    //   fact 含身份三元组（subject=用户 且 attribute 是身份类字段）= 0.8；
    //   其余 = 0.5。**不暴露给抽取 LLM 自报**——让它自报重要性等于把幻觉洗成权重（C12 同族）。
    importance: initialImportance(c.entryType, c.triples ?? []),
    // 建出来时还没有向量：索引阶段按"这次真的拿到了向量吗"翻成 0
    embedding_pending: true,
  };
}

/** 身份类 attribute 白名单：命中即视为"关于用户身份的记忆"。 */
const IDENTITY_ATTRS = new Set(['身份', '名字', '姓名', '称呼', '生日', '职业', '家乡']);

/** 【R-144】写入期 importance 判定（纯函数，测试直接打这里）。 */
export function initialImportance(entryType, triples) {
  if (entryType === 'boundary' || entryType === 'skill') return 1.0;
  const identity = (triples ?? []).some((t) =>
    String(t?.subject ?? '').trim() === '用户' && IDENTITY_ATTRS.has(String(t?.attribute ?? '').trim()));
  if (identity) return 0.8;
  return 0.5;
}

/**
 * 超长说明抽取没有压缩好：先按句拆，拆不动才截到句末。
 * 不抛异常 —— 抛等于整条消息不落库，而"多一条长条目"只是注入端 token 变多。
 */
export function validateCandidate(c) {
  const text = String(c.text ?? '');
  if (text.length <= MAX_TEXT_CHARS) return { ...c, text };
  const parts = splitBySentence(text, MAX_TEXT_CHARS);
  if (parts.length > 1) return { ...c, text: parts[0], overflow: parts.slice(1) };
  return { ...c, text: truncateAtSentence(text, MAX_TEXT_CHARS) };
}

function splitBySentence(text, max) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (/[。！？!?；;\n]/.test(ch)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length > 1 ? out : [text.slice(0, max)];
}

function truncateAtSentence(text, max) {
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  return cut > max * 0.5 ? head.slice(0, cut + 1) : head;
}

/* ─────────────────────────── 行 ↔ Entry ─────────────────────────── */

export const ENTRY_COLUMNS = [
  'id', 'domain_id', 'entry_type', 'text', 'topic_tags', 'triples', 'evidence_links',
  'source_ref', 'provenance', 'observed_at', 'recorded_at',
  'persistence_init', 'last_decay_at', 'persistence_at_decay', 'gamma_multiplier',
  'activation_count', 'last_activated_at', 'importance',
  'trust_prior_logit', 'trust_posterior_logit', 'trust_updated_at',
  'signature', 'signature_key_id', 'identity_scope', 'shareable', 'sensitivity',
  'emotion', 'emotion_owner',
  'archived_topic', 'cold', 'superseded_by', 'supersedes', 'embedding_pending',
];

export function upsertEntryRow(db, e) {
  const stmt = db.prepare(`
    INSERT INTO entries(${ENTRY_COLUMNS.join(',')})
    VALUES (${ENTRY_COLUMNS.map((c) => `@${c}`).join(',')})
    ON CONFLICT(id) DO UPDATE SET
      ${ENTRY_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(',\n      ')}
  `);
  stmt.run({
    ...e,
    // 【R-95】兜底：重建/dream 这些"从真相源拼回 Entry"的路径历史上不认识新列，
    // 少一个 named param 就是一条 SqliteError（实测：rebuild 直接炸 Missing named parameter）。
    emotion: e.emotion ?? 'neutral',
    emotion_owner: e.emotion_owner ?? 'user',
    importance: e.importance ?? 0.5,
    topic_tags: JSON.stringify(e.topic_tags ?? []),
    // triples 存**原文** JSON：签名对象 + entry_triples 的重建来源（R-88）
    triples: JSON.stringify(e.triples ?? []),
    evidence_links: JSON.stringify(e.evidence_links ?? []),
    source_ref: JSON.stringify(e.source_ref ?? {}),
    provenance: JSON.stringify(e.provenance ?? {}),
    shareable: e.shareable ? 1 : 0,
    archived_topic: e.archived_topic ? 1 : 0,
    cold: e.cold ? 1 : 0,
    embedding_pending: e.embedding_pending ? 1 : 0,
    supersedes: JSON.stringify(e.supersedes ?? []),
    last_activated_at: e.last_activated_at ?? null,
    signature: e.signature ?? null,
    signature_key_id: e.signature_key_id ?? null,
    superseded_by: e.superseded_by ?? null,
  });
}

export function rowToEntry(r) {
  return {
    ...r,
    topic_tags: parseJson(r.topic_tags, []),
    triples: parseJson(r.triples, []),
    evidence_links: parseJson(r.evidence_links, []),
    source_ref: parseJson(r.source_ref, {}),
    provenance: parseJson(r.provenance, {}),
    supersedes: parseJson(r.supersedes, []),
    shareable: r.shareable === 1,
    archived_topic: r.archived_topic === 1,
    cold: r.cold === 1,
    embedding_pending: r.embedding_pending === 1,
  };
}

const parseJson = (s, dflt) => {
  try { return s == null ? dflt : JSON.parse(s); } catch { return dflt; }
};

/**
 * 【R-90】单条读取是**包装**，不是另一条 SQL。
 * 独立实现 `SELECT * WHERE id = ?` 然后返回裸行，`triples` 会是 JSON 字符串，
 * `writeTripleRows` 对它 `.forEach` → 索引任务全体失败（炸的是整条写入链）。
 *
 * 这里只做"硬过滤"（冷存 / 归档）；`minPersistence` 属于准入，必须在检索层
 * 用 `lazyPersistence(e, cfg)` 判 —— 惰性衰减是有时钟的，不属于这一层。
 */
export function loadEntries(db, ids, opt = {}) {
  const out = new Map();
  if (!ids.length) return out;
  const stmt = db.prepare(`SELECT * FROM entries WHERE id IN (${ids.map(() => '?').join(',')})`);
  for (const row of stmt.all(...ids)) {
    const e = rowToEntry(row);
    if (e.cold && !opt.includeCold) continue;
    if (e.archived_topic && !opt.includeArchived) continue;
    out.set(e.id, e);
  }
  return out;
}

export const loadEntry = (db, id) => loadEntries(db, [id], { includeCold: true }).get(id) ?? null;

export function loadDomainMap(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT id, domain_id FROM entries WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  for (const r of rows) out.set(r.id, r.domain_id);
  return out;
}

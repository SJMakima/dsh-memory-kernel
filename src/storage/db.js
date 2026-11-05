/**
 * §9.4 SQLite Schema（可执行）—— 派生层。
 *
 * 三条与文档强绑定的实现约定：
 *   ① standalone FTS5 + 应用层 bigram，**不用 external content / 触发器** [R-3]；
 *      这样 dream 的纯状态回写不会触发 FTS 的 delete+insert。
 *   ② 所有关联用 `entry_id`，**禁止 rowid**；也因此**禁止 VACUUM** [R-22]。
 *   ③ `entries_vec` 单表 + `domain_id PARTITION KEY`（sqlite-vec ≥ 0.1.6）；
 *      版本不支持时降级为每域一表（路径 C），见 retrieve.js。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  text TEXT NOT NULL,
  topic_tags TEXT NOT NULL,
  triples TEXT NOT NULL,
  evidence_links TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  provenance TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  persistence_init REAL NOT NULL,
  last_decay_at INTEGER NOT NULL,
  persistence_at_decay REAL NOT NULL,
  gamma_multiplier REAL NOT NULL DEFAULT 1.0,
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_at INTEGER,
  trust_prior_logit REAL NOT NULL,
  trust_posterior_logit REAL NOT NULL,
  trust_updated_at INTEGER NOT NULL,
  signature TEXT,
  signature_key_id TEXT,
  identity_scope TEXT NOT NULL,
  shareable INTEGER NOT NULL DEFAULT 0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  -- 【R-95 情感雷达 P-a】情绪是**追加式状态**，必须走列而不是三元组：
  -- 走 triples 会触发 update 取代（"开心"顶掉"委屈"）、过判重线进待定池、还消耗写入配额。
  -- emotion_owner 区分是谁的情绪（'user' | 'agent'）——不借道 subject，避免与三元组折叠打架。
  emotion TEXT NOT NULL DEFAULT 'neutral',
  emotion_owner TEXT NOT NULL DEFAULT 'user',
  archived_topic INTEGER NOT NULL DEFAULT 0,
  cold INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  supersedes TEXT,
  -- §18：嵌入 RPC 超时 / 模型未就绪 → 写入标 embedding_pending，等补嵌扫回来。
  -- 这不是"失败标记"，是"这一条还没向量化"，冷启动前几秒写的条目全都落在这里。
  embedding_pending INTEGER NOT NULL DEFAULT 0,
  -- 【R-144】重要性轴：与 activation（persistence）解耦。衰减只作用 activation，
  -- importance 只做三件事（冷存豁免线 / confirm 加成 / 排序调制），永不衰减。
  importance REAL NOT NULL DEFAULT 0.5
);
CREATE INDEX IF NOT EXISTS idx_vec_pending ON entries(embedding_pending, recorded_at);

CREATE INDEX IF NOT EXISTS idx_domain  ON entries(domain_id, cold);
CREATE INDEX IF NOT EXISTS idx_scope   ON entries(identity_scope, shareable, sensitivity, cold);
CREATE INDEX IF NOT EXISTS idx_observed ON entries(domain_id, observed_at DESC, id);

CREATE TABLE IF NOT EXISTS entry_triples (
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  domain_id   TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  attribute   TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (entry_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_triple_dedup
  ON entry_triples(domain_id, subject_key, attribute, value);
CREATE INDEX IF NOT EXISTS idx_triple_subject
  ON entry_triples(domain_id, subject_key);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  tokens, entry_id UNINDEXED, domain_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts_cold USING fts5(
  tokens, entry_id UNINDEXED, domain_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TABLE IF NOT EXISTS vec_shards (
  domain_id    TEXT PRIMARY KEY,
  vector_count INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  domain_id    TEXT NOT NULL,
  date         TEXT NOT NULL,
  part_no      INTEGER NOT NULL DEFAULT 0,
  sha256       TEXT NOT NULL,
  last_synced  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_part ON files(domain_id, date, part_no);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 5,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  not_before   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_pick ON tasks(status, priority, not_before);

CREATE TABLE IF NOT EXISTS quotas (
  domain_id TEXT NOT NULL,
  date      TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain_id, date)
);

CREATE TABLE IF NOT EXISTS pending_candidates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id   TEXT NOT NULL,
  payload     TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  expire_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model_id  TEXT NOT NULL,
  dim       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activation_events (
  entry_id TEXT NOT NULL,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL DEFAULT 'retrieval'
);
CREATE INDEX IF NOT EXISTS idx_act ON activation_events(entry_id, kind, at);

CREATE TABLE IF NOT EXISTS retrieval_log (
  request_id TEXT PRIMARY KEY,
  domain_id  TEXT NOT NULL,
  entry_ids  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retrieval_time ON retrieval_log(created_at);

-- 【连锁记忆 · evidence_links 归一化】§9.1 的 EvidenceLink 从 entries JSON 列展开的索引表。
-- 与 entry_triples 同型：索引表，不是图数据库。source 区分边来源：
--   'extract' = 抽取/写入时声明（真相源是 entries.evidence_links JSON / md evidence 行，可重灌）
--   'dream'   = dream 期从 retrieval_log 共现挖出的 coexist 边（派生数据，不进 md，可重算）
CREATE TABLE IF NOT EXISTS entry_links (
  entry_id   TEXT NOT NULL,
  linked_id  TEXT NOT NULL,
  type       TEXT NOT NULL,             -- support | causal | coexist
  source     TEXT NOT NULL DEFAULT 'extract',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (entry_id, linked_id, type, source)
);
CREATE INDEX IF NOT EXISTS idx_entry_links_src ON entry_links(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_links_dst ON entry_links(linked_id);

CREATE TABLE IF NOT EXISTS identity_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id    TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  window_end   INTEGER NOT NULL,
  metrics      TEXT NOT NULL,
  alert        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consolidation_signals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  domain_id  TEXT NOT NULL,
  weight     REAL NOT NULL,
  created_at INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────── 【R-108】对话流水层（transcript）───────────────────
-- 原话与提炼事实是两种粒度：原话的价值是"当时怎么说的"（语气/上下文/承诺原文），
-- 走四分类管线必然失真或爆炸（配额秒爆、"好的"/"好嘞"过判重线、流水账淹掉事实）。
-- 这里纯 append：不判重、不占配额、不进真相源 Markdown、不参与 entries 的 RRF 排序。
-- text_hash 是 (session_id, speaker, text) 的摘要，UNIQUE 让重复灌入天然幂等
-- （pre-step 每轮都给全量 messages，没有去重就会几何级膨胀）。
CREATE TABLE IF NOT EXISTS transcript (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  domain_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  speaker    TEXT NOT NULL,
  text       TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  UNIQUE(session_id, text_hash)
);
CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_transcript_domain  ON transcript(domain_id, ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  tokens, transcript_id UNINDEXED, session_id UNINDEXED, domain_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);

-- ─────────────── 【R-142】情绪日志（emotion_log）───────────────
-- 第三层流水：双方情绪的独立记录，不再只当事实条目的附属标签。
-- 事件行模型：一行一个情绪事件（不是一对话轮一行）——
--   source='extract'：抽取任务顺带判定（owner=user 判用户；owner=agent 是 **expressed**，
--                     从她回复语气反推，有自我强化循环的风险，只作"她表现出的"记录）；
--   source='self'  ：memory_inner 自述（owner=agent，**felt 第一手**，唯一的诚实来源）。
-- 隐私边界：全库隐私含量最高的数据之一——只本域、纯流水（TTL 同 transcript）、不进真相源、
-- 不进 RRF。耐久版只有日记「情绪」节。
-- emotion 可为 NULL：**NULL = 未判出/未自述，绝不填补 neutral**（消费层必须过滤 NULL，
-- 把 NULL 当 neutral 统计 = 编造"她很平静"）。
CREATE TABLE IF NOT EXISTS emotion_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  domain_id  TEXT NOT NULL,
  owner      TEXT NOT NULL,             -- 'user' | 'agent'
  emotion    TEXT,                      -- joy/sadness/anger/anxiety/fatigue/neutral/NULL
  strong     INTEGER NOT NULL DEFAULT 0,-- 强单点：用户原话第一人称明确表述（滤噪例外）
  source     TEXT NOT NULL,             -- 'extract' | 'self'
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_emotion_domain ON emotion_log(domain_id, ts DESC);

-- ─────────────── 【R-139】内心活动流水（inner_log）───────────────
-- 与 transcript 同型的流水层：纯 append、内容哈希幂等、不进真相源、不占配额。
-- 记的是"她当时为什么这么说"（动机/打算/情绪反应）——第一手来源是 memory_inner 工具
-- （宿主 pre-step 消息里没有推理内容通道，内核看不见她的实时思考，这是已核实的事实）。
-- 生命周期同 transcript（retainDays），耐久版是日记里合并后的「当时的想法」。
CREATE TABLE IF NOT EXISTS inner_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  domain_id  TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  text       TEXT NOT NULL,
  text_hash  TEXT NOT NULL,
  UNIQUE(session_id, text_hash)
);
CREATE INDEX IF NOT EXISTS idx_inner_session ON inner_log(session_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_inner_domain  ON inner_log(domain_id, ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS inner_fts USING fts5(
  tokens, inner_id UNINDEXED, session_id UNINDEXED, domain_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);

-- ─────────────── 【R-139】日记（diary）───────────────
-- 与 transcript/inner 相反：日记**进真相源**（domains/<域>/diary/YYYY-MM-DD.md），
-- 永不衰减、不过 TTL、rebuild 可重放——"人写了日记就一直记得"的机制翻译。
-- SQLite 行是第一派生（content 全文在 md 里，这里存一份供检索），(domain_id, date) 唯一。
CREATE TABLE IF NOT EXISTS diary (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_id    TEXT NOT NULL,
  date         TEXT NOT NULL,            -- YYYY-MM-DD（本地时区）
  path         TEXT NOT NULL,
  generated_by TEXT NOT NULL,            -- 'llm' | 'template'
  content      TEXT NOT NULL,            -- 正文（不含 frontmatter）
  mtime        INTEGER NOT NULL,
  UNIQUE(domain_id, date)
);
CREATE INDEX IF NOT EXISTS idx_diary_domain ON diary(domain_id, date DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(
  tokens, diary_id UNINDEXED, domain_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 0'
);
`;

export function openDatabase({ dbPath, modelId, dim, enableVec = true, busyTimeoutMs = 5000 }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  let vecVersion = null;
  if (enableVec) {
    try {
      // 可选依赖：装不上 sqlite-vec 时向量路自动降级为三路（§18），不影响其余功能
      const sqliteVec = require('sqlite-vec');
      db.loadExtension(sqliteVec.getLoadablePath());
      vecVersion = db.prepare('SELECT vec_version() AS v').get().v;
    } catch {
      vecVersion = null;
    }
  }

  db.exec(SCHEMA);
  ensureColumns(db);

  const meta = db.prepare('SELECT model_id, dim FROM model_meta WHERE id = 1').get();
  let dimMismatch = false;
  if (!meta) {
    db.prepare('INSERT INTO model_meta(id, model_id, dim, created_at) VALUES (1, ?, ?, ?)')
      .run(modelId, dim, Date.now());
  } else if (meta.dim !== dim) {
    // §18：维度与 model_meta 不一致 → 启动期拒绝服务并触发全量重建
    dimMismatch = true;
  }

  let canPartition = false;
  let hasRescoreTable = false;   // 旧库残留的 rescore 建表子句（已证伪的 R-136 产物）
  if (vecVersion) {
    const existing = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries_vec'",
    ).get();
    hasRescoreTable = Boolean(existing?.sql && hasRescoreClause(existing.sql));
    try {
      if (!existing) {
        // distance_metric=cosine：`ScoredHit.score = 1 - distance` 才是余弦相似度（§13.2）
        db.exec(vecTableDdl(dim));
      } else if (hasRescoreTable) {
        // 老库可能还带着已证伪的 `INDEXED BY rescore(...)` 子句（R-136/R-137）。它不影响查询
        // 正确性，但会误导后来的人以为"这功能真实现过"。空表直接换掉；非空表留给 rebuild ——
        // 启动时 DROP 非空表等于"启动即丢向量"，绝不能干。
        if (emptyVecTable(db)) {
          db.exec('DROP TABLE entries_vec');
          db.exec(vecTableDdl(dim));
          hasRescoreTable = false;
        }
      }
      canPartition = true;
      // 【R-141】原话向量表：跟 entries_vec 同维。失败不阻断（FTS 路仍在）
      try { db.exec(transcriptVecDdl(dim)); } catch { /* 忽略：检索降级到纯 FTS */ }
    } catch {
      canPartition = false;   // < 0.1.6 → 路径 C（每域一表）
    }
  }

  return {
    db,
    vec: {
      enabled: Boolean(vecVersion), version: vecVersion, canPartition, dim, dimMismatch,
      hasRescoreTable,
    },
    close: () => db.close(),
  };
}

function emptyVecTable(db) {
  try { return db.prepare('SELECT COUNT(*) AS c FROM entries_vec').get().c === 0; } catch { return true; }
}

/** 是否残留 rescore 子句（upstream 至今没有这个能力，但它可能出现在旧库的 DDL 文本里）。 */
export function hasRescoreClause(sql) {
  return /INDEXED BY\s+rescore\s*\(/i.test(String(sql ?? ''));
}

/**
 * entries_vec 的建表 DDL。
 *
 * 关于 `INDEXED BY rescore(...)`：**不要加**。sqlite-vec 至今（v0.1.9 / 0.1.10-alpha.4）
 * 都不支持 rescore 索引，只有 PR #276 的讨论；连"能建表"都是假象（`rescore integer` 只是个
 * 普通列，塞 rowid 会报 Only integers allowed）。历史上这一度被写成可选策略，纯属死代码，
 * 已按 R-136/R-137 清掉。要加速走 §13.3 的内存精确索引，不要碰建表子句。
 */
export function vecTableDdl(dim) {
  return `CREATE VIRTUAL TABLE entries_vec USING vec0(
  entry_id  TEXT PRIMARY KEY,
  domain_id TEXT PARTITION KEY,
  embedding float[${dim}] distance_metric=cosine
)`;
}

/**
 * 重建 entries_vec（只给"维度变了"和 rebuild 用）。
 * 必须 DROP + CREATE 而不是 DELETE：DELETE 只清数据，旧表的 vec0 维度声明还在，
 * 新维度向量灌进去直接 SqliteError（实测：1024 表 vs lexvec 32 维）。
 */
export function recreateVecTable(db, { dim }) {
  db.exec('DROP TABLE IF EXISTS entries_vec');
  db.exec(vecTableDdl(dim));
  // 【R-141】原话向量表与 entries_vec 同维同生命周期：模型换了，两边都得重建
  try {
    db.exec('DROP TABLE IF EXISTS transcript_vec');
    db.exec(transcriptVecDdl(dim));
  } catch { /* 老库没开 vec：跳过 */ }
}

/**
 * 【R-141】transcript_vec：原话的向量投影（与 entries_vec 同构，同维同度量）。
 * 动机是实测踩到的检索盲区：FTS 是关键词匹配，用户问"我给你发了句歌词吗"，
 * 而原话是"我不难过只是为什么~"——"歌词"二字不在原话里，FTS 永远捞不到，
 * 只能靠宿主翻原始会话文件兜底（2026-10-28 实录）。原话向量化后"意思相近"
 * 就能召回。message_id = String(transcript.id)——vec0 的 INTEGER PRIMARY KEY 是
 * 「能建表不能用」家族：建表成功，插整数也报 Only integers are allows，实测钉死。
 */
export function transcriptVecDdl(dim) {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_vec USING vec0(
  message_id TEXT PRIMARY KEY,
  domain_id  TEXT PARTITION KEY,
  embedding float[${dim}] distance_metric=cosine
)`;
}

/**
 * `CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表补列。
 * 现存库（P0a 之前建的）打开时缺 `embedding_pending` → 每条 UPDATE 都报 no such column，
 * 而报错点离建表十万八千里。这里做一次幂等补齐，新库上这些语句一条都不会执行。
 */
function ensureColumns(db) {
  const add = [
    ['entries', 'embedding_pending', 'INTEGER NOT NULL DEFAULT 0'],
    // 【R-95】老库补情绪两列：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列。
    ['entries', 'emotion', "TEXT NOT NULL DEFAULT 'neutral'"],
    ['entries', 'emotion_owner', "TEXT NOT NULL DEFAULT 'user'"],
    // 【R-141 同族】日记向量路：老库补 embedding 列（BLOB，Float32Array 二进制）。
    // 旧行 embedding 为 NULL → 检索向量路自然跳过，下次 dream 重建时回填。
    ['diary', 'embedding', 'BLOB'],
    // 【R-148】信号明细：conflict 家族的信号要进组装层提示，光有 kind 不够——
    // 得带上"哪两条、说了什么"。JSON 文本列，非 conflict 信号为 NULL。
    ['consolidation_signals', 'detail', 'TEXT'],
    // 【R-149】候选确认池：pending_candidates 复用为双用途队列（reason 区分）——
    // 'uncertain' = 四分类待定池（drain 自动消化，原行为）；'confirm' = 低置信确认池
    // （不自动落盘，等用户在设置页裁决）。老库默认 'uncertain' 保持原行为。
    ['pending_candidates', 'reason', "TEXT NOT NULL DEFAULT 'uncertain'"],
    // 【R-144】重要性轴：老库补列后按 entry_type 一次性回填（幂等：只抬默认 0.5 的行）。
    ['entries', 'importance', 'REAL NOT NULL DEFAULT 0.5'],
  ];
  for (const [table, column, ddl] of add) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  // 【R-144】老库 importance 回填：boundary/skill 抬到 1.0（与写入期判定一致）。
  // 幂等：新写入的 boundary/skill 本来就是 1.0，重复执行无效果。
  db.exec(`UPDATE entries SET importance = 1.0
           WHERE entry_type IN ('boundary', 'skill') AND importance = 0.5`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_vec_pending ON entries(embedding_pending, recorded_at)`);
  // 情绪聚合段每次组装都查一次：按域 + 时间倒序扫，带 emotion 条件（neutral 占绝大多数）。
  db.exec(`CREATE INDEX IF NOT EXISTS idx_emotion ON entries(domain_id, observed_at DESC, emotion)`);
}

/** 事务包装。注意：**事务内禁止文件 IO** [R-48]。 */
export function dbTx(db, fn) {
  return db.transaction(fn)();
}

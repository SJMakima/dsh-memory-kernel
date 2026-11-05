/**
 * 【R-139】日记层：每天一篇，进真相源，永不衰减。
 *
 * 定位（对着"人怎么记住"写的）：
 *   - transcript / inner_log 是情景记忆——会淡忘（TTL 滚动删除）；
 *   - diary 是**主动写下的自传记忆**——md 落盘即持久，rebuild 可重放。
 *   人靠"当时写了下来"绕过遗忘曲线，这里靠 md 真相源绕过 TTL。
 *
 * 结构（用户定的六节，缺数据就写"（无）"，不许空着装神秘）：
 *   经历 / 场景（在哪、什么情境，AI 判断）/ 情绪 / 在场 / 当时的想法 / 原话摘录
 *
 * 「当时的想法」的来源标注是硬规则：
 *   - inner_log 里的第一手记录 → 标【第一手】
 *   - LLM 从对话推断的 → 标【推断】
 *   冒充第一手 = 比缺数据更糟的污染。
 *
 * 生成纪律：
 *   - 幂等：(domain_id, date) 已有就跳过。日记是"当时写下的"，事后不重写——
 *     重写就是在篡改记忆（想要修订就追加日期后缀的补记，不是覆盖）。
 *   - md 先落（writeFileAtomic fsync）→ SQLite → FTS，与 entries 同一写序（R-40）。
 *   - LLM 不可用 → 机械模板（丑但不断供），generated_by 标 'template'。
 */
import { EMOTION_ZH } from '../pure/emotion-shape.js';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { writeFileAtomic, readFileSafe } from '../storage/md.js';
import { tokenizeBigram } from '../pure/tokenize.js';

/** 本地时区 YYYY-MM-DD。 */
export function localDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const SECTIONS = ['经历', '场景', '情绪', '在场', '当时的想法', '原话摘录'];

/** 从 LLM 输出里抠 JSON（容忍 ```json 围栏与前后废话）。 */
function parseJsonLoose(text) {
  const raw = String(text ?? '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function createDiary({ db, cfg, domains, inner, transcript, llm, audit, rootDir, embed = null }) {
  const enabled = () => cfg.diary?.enabled !== false;
  const maxQuote = () => cfg.diary?.maxQuoteChars ?? 160;

  const diaryDir = (domainId) => path.join(rootDir, 'domains', domainId, 'diary');
  const diaryPath = (domainId, date) => path.join(diaryDir(domainId), `${date}.md`);

  /**
   * 【R-141 同族】日记向量回填：给指定行嵌正文并落 BLOB。
   * 失败不阻断（embedding NULL → 向量路自然跳过，下次 rebuild/写入再补）。
   * 日记量小（人均 < 百篇），不进 vec0——直接行内 BLOB + 查询时全读算余弦，够用且零依赖。
   */
  async function backfillEmbedding(id, content) {
    if (!embed) return;
    try {
      const [v] = await embed(content);
      if (!v) return;
      db.prepare('UPDATE diary SET embedding = ? WHERE id = ?').run(Buffer.from(new Float32Array(v).buffer), id);
    } catch { /* 嵌入失败不挡日记主线 */ }
  }

  /* ── 数据收集：一天的原材料 ── */
  function collect(domainId, start, end) {
    const msgs = db.prepare(`
      SELECT session_id, ts, speaker, text FROM transcript
      WHERE domain_id = ? AND ts >= ? AND ts < ? ORDER BY ts
    `).all(domainId, start, end);
    const notes = inner.range(domainId, start, end);
    const entries = db.prepare(`
      SELECT id, text, topic_tags, emotion, emotion_owner, entry_type FROM entries
      WHERE domain_id = ? AND observed_at >= ? AND observed_at < ? AND superseded_by IS NULL
      ORDER BY observed_at
    `).all(domainId, start, end);
    const sessions = [...new Set(msgs.map((m) => m.session_id).filter(Boolean))];
    // 【R-142】当天情绪事件（评审 #3：日记是消费口，受 emotion.enabled 开关管；
    // 但已写成的日记不回改——开关只影响"之后写的日记"）
    let moodEvents = [];
    if (cfg.emotion?.enabled !== false) {
      try {
        moodEvents = db.prepare(`
          SELECT ts, owner, emotion, strong, source, note FROM emotion_log
          WHERE domain_id = ? AND ts >= ? AND ts < ? AND emotion IS NOT NULL ORDER BY ts
        `).all(domainId, start, end);
      } catch { /* 老库无表 */ }
    }
    return { msgs, notes, entries, sessions, moodEvents };
  }

  /** 情绪统计（当天条目的 emotion 字段，按 owner 分组）。 */
  function emotionSummary(entries) {
    const acc = {};
    for (const e of entries) {
      if (!e.emotion || e.emotion === 'neutral') continue;
      const key = `${e.emotion_owner === 'agent' ? '助手' : '用户'}·${e.emotion}`;
      acc[key] = (acc[key] ?? 0) + 1;
    }
    const list = Object.entries(acc).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}×${c}`);
    return list.length ? list.join('、') : '平稳（无显著情绪标注）';
  }

  /**
   * 【R-142】当天情绪紧凑序列：`19:16 对方疲惫 / 19:26 你开心 / 23:10 你【自述】疲惫`。
   * 不滤噪（单日翻档案场景如实给全量点）； felt 缺席时补一行【未自述】（评审 #1：
   * 缺席是如实记录，不是平静）。
   */
  function moodLineOf(moodEvents) {
    if (!moodEvents.length) return null;
    const hh = (t) => { const d0 = new Date(t); return `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}`; };
    const items = moodEvents.map((p) => {
      const who = p.owner === 'agent' ? (p.source === 'self' ? '你【自述】' : '你（表现）') : '对方';
      return `${hh(p.ts)} ${who}${EMOTION_ZH[p.emotion] ?? p.emotion}${p.strong ? '（强）' : ''}`;
    });
    if (!moodEvents.some((p) => p.owner === 'agent' && p.source === 'self')) {
      items.push('（你今天未自述内心情绪）');
    }
    return items.join(' / ');
  }

  const clip = (s, n) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };

  /* ── 机械模板：LLM 不可用时的兜底 ── */
  function buildTemplate(data, dateStr, domainId) {
    const facts = data.entries.slice(0, 12).map((e) => `- ${clip(e.text, 120)}`);
    const speakers = [...new Set(data.msgs.map((m) => m.speaker))];
    const thoughts = data.notes.map((n) => `- 【第一手】${clip(n.text, 200)}`);
    const quotes = data.msgs.slice(0, 8).map((m) => `- ${m.speaker === 'assistant' ? '助手' : '用户'}：${clip(m.text, maxQuote())}`);
    return [
      `## 经历`,
      facts.length ? facts.join('\n') : '（当天没有提炼出新条目）',
      '',
      `## 场景`,
      `（模板生成，未做语义判断）${data.sessions.length} 个会话：${data.sessions.map((s) => clip(s, 40)).join('、') || '无会话记录'}`,
      '',
      `## 情绪`,
      [moodLineOf(data.moodEvents), emotionSummary(data.entries)].filter(Boolean).join('\n') || '平稳（无记录）',
      '',
      `## 在场`,
      speakers.length ? speakers.map((s) => (s === 'assistant' ? '助手' : '用户（owner）')).join('、') : '（无对话记录）',
      '',
      `## 当时的想法`,
      thoughts.length ? thoughts.join('\n') : '（无第一手内心记录；模板模式不做推断）',
      '',
      `## 原话摘录`,
      quotes.length ? quotes.join('\n') : '（无）',
    ].join('\n');
  }

  /* ── LLM 模式 ── */
  async function buildWithLlm(data, dateStr, domainId) {
    if (!llm?.available?.()) return null;
    const convo = data.msgs.slice(0, 120).map((m) => `${m.speaker === 'assistant' ? '助手' : '用户'}: ${clip(m.text, 200)}`).join('\n');
    const facts = data.entries.slice(0, 15).map((e) => clip(e.text, 120)).join('\n');
    const innerNotes = data.notes.map((n) => clip(n.text, 200)).join('\n');
    if (!convo && !facts) return null;

    const system = [
      '你在为一位 AI 助手写当天日记——她的视角、第一人称，给多年后的她自己看。',
      '输出严格 JSON（不要多余文字），字段：',
      '{"summary":"当天经历了什么（事实层，3-6句）",',
      ' "scene":"在哪里/什么情境（从对话内容推断：平台前缀、话题氛围、时间线索；写明是推断的依据）",',
      ' "emotion":"当天的情绪基调与起伏——优先依据给定的当日情绪序列（含【自述】标记的第一手），标注统计与对话语气作补充",',
      ' "participants":"谁在场（会话/说话人；单人就写单人）",',
      ' "thoughts":"当时的想法——只写【推断】：从对话推断的她的动机。第一手内心记录由系统原样附加到日记，不要在此复述",',
      ' "quotes":[{"speaker":"用户|助手","text":"最有记忆点的一两句原话（可轻度截断）；speaker 必须从这两个词里选"}]}',
      '约束：summary 只写发生的事，不写评价；scene 允许推断但要点明依据；quotes 最多 3 条、每条不超过 80 字；无内容就空数组/空串。',
    ].join('\n');
    const user = [
      `日期：${dateStr}；域：${domainId}`,
      data.sessions.length ? `会话：${data.sessions.map((x) => clip(x, 20)).join('、')}` : '会话：无',
      `\n当天提炼出的事实条目：\n${facts || '（无）'}`,
      `\n她的第一手内心记录：\n${innerNotes || '（无）'}`,
      `\n当天对话（按时序）：\n${convo || '（无）'}`,
      `\n当日情绪序列（紧凑编码；【自述】= 助手第一手，其余为逐轮判读）：\n${moodLineOf(data.moodEvents) ?? '（无）'}`,
      `\n情绪标注统计（记忆条目上的标签，样本稀疏）：${emotionSummary(data.entries)}`,
    ].join('\n');

    try {
      const out = await llm.complete({ system, messages: [{ role: 'user', content: user }] });
      const j = parseJsonLoose(out);
      if (!j) {
        // 【盲点修复】解析失败不是"没报错"——maxTokens 截断就是这么进来的，
        // 不落痕就永远归因不了为什么日记总退模板
        void audit?.write?.('diary', { event: 'llm-unparseable', domainId, date: dateStr, outputHead: String(out ?? '').slice(0, 400) }).catch?.(() => {});
        return null;
      }
      const firstHand = data.notes.length
        ? data.notes.map((n) => `- 【第一手】${clip(n.text, 200)}`).join('\n')
        : null;
      const thoughts = [
        firstHand ?? '',
        // 第一手已由系统原样附加，LLM 侧只应给【推断】；它若仍复述第一手，滤掉防重复
        j.thoughts
          ? j.thoughts.split('\n').filter((l) => !l.includes('【第一手】')).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')
          : '',
      ].filter(Boolean).join('\n');
      const quotes = Array.isArray(j.quotes)
        // speaker 两头都认：中文（按提示词约定）与英文枚举都映射，落不进两类的保守归"用户"
        ? j.quotes.slice(0, 3).map((q) => `- ${q?.speaker === '助手' || q?.speaker === 'assistant' ? '助手' : '用户'}：${clip(q?.text ?? '', maxQuote())}`).join('\n')
        : '';
      return [
        '## 经历', j.summary?.trim() || '（无）', '',
        '## 场景', j.scene?.trim() || '（无）', '',
        '## 情绪', j.emotion?.trim() || emotionSummary(data.entries), '',
        '## 在场', j.participants?.trim() || (data.sessions.join('、') || '（无）'), '',
        '## 当时的想法', thoughts || '（无记录，也无从推断）', '',
        '## 原话摘录', quotes || '（无）',
      ].join('\n');
    } catch (err) {
      void audit?.write?.('diary', { event: 'llm-failed', domainId, date: dateStr, error: String(err?.message ?? err).slice(0, 200) }).catch?.(() => {});
      return null;   // 落模板，不阻断
    }
  }

  /* ── 落盘 ── */
  function persist(domainId, dateStr, content, generatedBy, nowMs) {
    const p = diaryPath(domainId, dateStr);
    const md = [
      '---',
      'kind: diary',
      `domain: ${domainId}`,
      `date: ${dateStr}`,
      `generated_by: ${generatedBy}`,
      '---',
      '',
      `# 日记 ${dateStr}（${domainId}）`,
      '',
      content,
      '',
    ].join('\n');
    // 同步原子写（内容小、必须先于 SQLite 落地）：md 先落是 R-40 硬序
    return writeFileAtomic(p, md).then(async () => {
      db.prepare(`
        INSERT INTO diary(domain_id, date, path, generated_by, content, mtime)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain_id, date) DO UPDATE SET
          path = excluded.path, generated_by = excluded.generated_by,
          content = excluded.content, mtime = excluded.mtime
      `).run(domainId, dateStr, p, generatedBy, content, nowMs);
      // FTS 全量重挂该篇：幂等（先删后插），词表随内容更新
      const id = db.prepare('SELECT id FROM diary WHERE domain_id = ? AND date = ?').get(domainId, dateStr).id;
      db.prepare('DELETE FROM diary_fts WHERE diary_id = ?').run(id);
      db.prepare('INSERT INTO diary_fts(tokens, diary_id, domain_id) VALUES (?, ?, ?)')
        .run(tokenizeBigram(content), id, domainId);
      await backfillEmbedding(id, content);
      return { path: p, generatedBy };
    });
  }

  /**
   * 给指定日期写日记（幂等：已有即跳过）。dream 每天调用：给昨天写。
   * @returns {{ written: boolean, path?: string, generatedBy?: string, reason?: string }}
   */
  async function ensure({ domainId, date, now = Date.now() }) {
    if (!enabled()) return { written: false, reason: 'disabled' };
    if (!domains.get(domainId)) return { written: false, reason: 'unknown-domain' };
    const existed = db.prepare('SELECT id FROM diary WHERE domain_id = ? AND date = ?').get(domainId, date);
    if (existed) return { written: false, reason: 'exists' };

    const start = new Date(`${date}T00:00:00`).getTime();
    const end = start + 864e5;
    const data = collect(domainId, start, end);
    if (!data.msgs.length && !data.entries.length && !data.notes.length) {
      return { written: false, reason: 'empty-day' };   // 完全没活动不写空日记
    }

    let content = await buildWithLlm(data, date, domainId);
    let generatedBy = 'llm';
    if (!content) { content = buildTemplate(data, date, domainId); generatedBy = 'template'; }

    const r = await persist(domainId, date, content, generatedBy, now);
    void audit?.write?.('diary', { event: 'written', domainId, date, generatedBy, sections: SECTIONS }).catch?.(() => {});
    return { written: true, ...r };
  }

  /* ── 查询 ── */
  function get(domainId, date) {
    return db.prepare('SELECT * FROM diary WHERE domain_id = ? AND date = ?').get(domainId, date) ?? null;
  }

  /**
   * 搜日记（同步 FTS 单路——历史调用方保持兼容；双路合并见 searchAsync）。
   */
  function search(query, { domainId, k } = {}) {
    const tokens = tokenizeBigram(String(query ?? ''));
    if (!tokens || !domainId) return [];
    const match = tokens.split(' ').filter(Boolean).map((t) => `"${t}"`).join(' OR ');
    const cap = Math.max(1, Math.min(k ?? 2, 5));
    try {
      return db.prepare(`
        SELECT d.date, d.generated_by, substr(d.content, 1, 400) AS excerpt, bm25(diary_fts) AS score
        FROM diary_fts f JOIN diary d ON d.id = f.diary_id
        WHERE f.tokens MATCH ? AND f.domain_id = ?
        ORDER BY bm25(diary_fts) LIMIT ?
      `).all(match, domainId, cap)
        .map((r) => ({ date: r.date, excerpt: r.excerpt, score: r.score, kind: 'diary' }));
    } catch { return []; }
  }

  /**
   * 双路异步版：FTS（字面）+ 向量（语义），RRF 名次融合——"猫"搜得到写"煤球"的那篇。
   * 向量路实现约束：日记量小（人均 < 百篇），全读该域行内 BLOB 现场算余弦，不建 vec0。
   * embedding 为 NULL（旧行/嵌入失败/未配 embed）→ 向量路自然为空，纯 FTS 照旧。
   */
  async function searchAsync(query, opts = {}) {
    const tokens = tokenizeBigram(String(query ?? ''));
    if (!tokens || !opts.domainId) return [];
    const fts = search(query, opts);
    if (!embed) return fts;
    const cap = Math.max(1, Math.min(opts.k ?? 2, 5));
    try {
      const [qv] = await embed(String(query));
      if (!qv) return fts;
      const rows = db.prepare('SELECT id, date, generated_by, substr(content, 1, 400) AS excerpt, embedding FROM diary WHERE domain_id = ? AND embedding IS NOT NULL').all(opts.domainId);
      const q = Float32Array.from(qv);
      const scored = [];
      for (const r of rows) {
        const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
        if (v.length !== q.length) continue;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < q.length; i++) { dot += q[i] * v[i]; na += q[i] * q[i]; nb += v[i] * v[i]; }
        const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
        scored.push({ date: r.date, generated_by: r.generated_by, excerpt: r.excerpt, score: sim, kind: 'diary-vec' });
      }
      const vecTop = scored.sort((a, b) => b.score - a.score).slice(0, cap);
      // RRF 名次融合（量纲不同不比大小，与 R-141 同纪律）
      const merged = new Map();
      const key = (x) => x.date;
      fts.forEach((x, i) => merged.set(key(x), { ...x, rrf: (merged.get(key(x))?.rrf ?? 0) + 1 / (60 + i) }));
      vecTop.forEach((x, i) => merged.set(key(x), { ...(merged.get(key(x)) ?? x), rrf: (merged.get(key(x))?.rrf ?? 0) + 1 / (60 + i) }));
      return [...merged.values()].sort((a, b) => b.rrf - a.rrf).slice(0, cap);
    } catch { return fts; }
  }

  /** 某域最近 n 篇（状态页用）。 */
  function recent(domainId, n = 5) {
    return db.prepare('SELECT date, generated_by, mtime FROM diary WHERE domain_id = ? ORDER BY date DESC LIMIT ?')
      .all(domainId, n);
  }

  /**
   * rebuild 的日记侧重放：真相源在 md，SQLite 行全部从 md 重灌。
   * 与 entries 的 rebuild 同型：md 是裁决者，表可以随时清掉重来。
   */
  async function rebuildFromMd(domainId) {
    const dir = diaryDir(domainId);
    let files = [];
    try { files = await readdir(dir); } catch { return 0; }   // 无日记目录 = 0 篇，不是错误
    const rows = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    db.prepare('DELETE FROM diary WHERE domain_id = ?').run(domainId);
    db.prepare('DELETE FROM diary_fts WHERE diary_id NOT IN (SELECT id FROM diary)').run();
    const embedJobs = [];
    let n = 0;
    for (const f of rows) {
      const date = f.replace(/\.md$/, '');
      const md = await readFileSafe(path.join(dir, f));
      if (!md) continue;
      const fm = md.match(/^---\n([\s\S]*?)\n---/);
      const generatedBy = fm?.[1]?.match(/generated_by:\s*(\S+)/)?.[1] ?? 'template';
      // 正文 = 去掉 frontmatter 与一级标题
      const content = md.replace(/^---[\s\S]*?---\n/, '').replace(/^#[^\n]*\n/, '').trim();
      if (!content) continue;
      db.prepare(`
        INSERT INTO diary(domain_id, date, path, generated_by, content, mtime)
        VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(domain_id, date) DO UPDATE SET content = excluded.content, generated_by = excluded.generated_by
      `).run(domainId, date, path.join(dir, f), generatedBy, content);
      const id = db.prepare('SELECT id FROM diary WHERE domain_id = ? AND date = ?').get(domainId, date).id;
      db.prepare('DELETE FROM diary_fts WHERE diary_id = ?').run(id);
      db.prepare('INSERT INTO diary_fts(tokens, diary_id, domain_id) VALUES (?, ?, ?)')
        .run(tokenizeBigram(content), id, domainId);
      embedJobs.push(backfillEmbedding(id, content));   // 聚合后统一等：rebuild 返回前向量必须落库
      n++;
    }
    await Promise.all(embedJobs);
    return n;
  }

  function stats() {
    try {
      const total = db.prepare('SELECT COUNT(*) AS c FROM diary').get().c;
      const latest = db.prepare('SELECT domain_id, date, generated_by FROM diary ORDER BY date DESC, domain_id LIMIT 1').get();
      return { total, latest: latest ?? null };
    } catch { return { total: 0, latest: null }; }
  }

  return { ensure, get, search, searchAsync, recent, rebuildFromMd, stats, enabled };
}

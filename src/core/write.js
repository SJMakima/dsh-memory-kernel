/**
 * §12 写入管线：抽取 → 分类 → 配额 → **Markdown 先落盘** → 索引。
 *
 * 三条不能动的顺序：
 *   ① 真相源先落（Markdown → SQLite → 投索引）[R-40 / R-82 / C9]
 *   ② `vec_shards` 计数增量维护，不逐条 `COUNT(*)` [R-29]
 *   ③ `entry_triples` 的归一化只发生在 `writeTripleRows` [R-83]
 */
import { localDate } from '../pure/paths.js';
import { normalizeValue, subjectKey, attributeKey, literalJaccard, stripDateLike, commonSubstringLength } from '../pure/normalize.js';
import { tokenizeBigram } from '../pure/tokenize.js';
import { lazyPersistence } from '../pure/lifecycle.js';
import { buildEntry, validateCandidate, upsertEntryRow, loadEntry, loadEntries } from './entry.js';
import { extendVocab } from './vocab.js';
import { readFileSafe, upsertBlock, hasBlock, countBlocks, writeFileAtomic } from '../storage/md.js';
import { withFileLock } from '../storage/lock.js';
import { dbTx } from '../storage/db.js';
import { countFtsDelete } from '../storage/fts-stats.js';

export function createWritePipe({ db, cfg, vec, files, audit, security, domains }) {
  const now = () => Date.now();

  /* ─────────────────────── 配额 ─────────────────────── */

  const quotaLimit = (domainId) => cfg.write.dailyQuotaPerDomain[domainId]
    ?? cfg.write.dailyQuotaPerDomain.default ?? 20;

  /** 单语句 + 事务内判上限：读与写在同一个事务里，避免"查的时候还有额度"。 */
  const tryConsumeQuota = db.transaction((domainId, date) => {
    const row = db.prepare('SELECT count FROM quotas WHERE domain_id = ? AND date = ?').get(domainId, date);
    const used = row?.count ?? 0;
    if (used >= quotaLimit(domainId)) return false;
    db.prepare(`INSERT INTO quotas(domain_id, date, count) VALUES (?, ?, 1)
                ON CONFLICT(domain_id, date) DO UPDATE SET count = count + 1`).run(domainId, date);
    return true;
  });

  const rollbackQuota = (domainId, date) => {
    db.prepare('UPDATE quotas SET count = MAX(0, count - 1) WHERE domain_id = ? AND date = ?').run(domainId, date);
  };

  /* ─────────────── §10 原子写：锁内判满、满了换 path ─────────────── */

  async function writeMarkdownAtomic(entry, pathHint) {
    // 新条目走 markdownPath（查表 O(1)）；修改已有条目必须由调用方传入 locateEntryPath 的结果，
    // 否则 max(part) 会把 part-00 里的条目复制到 part-03。
    let path = pathHint ?? await files.markdownPath(entry);

    for (let attempt = 0; attempt < cfg.storage.partSwitchMaxAttempts; attempt++) {
      const outcome = await withFileLock(path, async () => {
        const existing = await readFileSafe(path);
        // 覆盖写（该条目已在文件里）不触发切分，否则更新会把自己赶到新分片。
        // 满额判定只认 countBlocks —— 不读任何"条目数"缓存列 [R-43]。
        if (!hasBlock(existing, entry.id) && countBlocks(existing) >= cfg.storage.maxEntriesPerFile) {
          return 'full';
        }
        await writeFileAtomic(path, upsertBlock(existing, entry));
        return 'written';
      });
      if (outcome === 'written') return path;
      path = await files.nextPartPath(entry.domain_id, path);   // 单调递增
    }

    // 重试耗尽：**降级而不是抛异常**（抛 = 丢条目；超限只是文件变大）[R-38]
    await audit.partOverflow(entry.domain_id, path);
    await withFileLock(path, async () => {
      const existing = await readFileSafe(path);
      await writeFileAtomic(path, upsertBlock(existing, entry));
    });
    return path;
  }

  /* ─────────────────── §12.3 索引（事务后刷 sha）─────────────────── */

  function upsertFtsRow(e) {
    const existed = db.prepare('SELECT 1 FROM entries_fts WHERE entry_id = ?').get(e.id)
      ?? db.prepare('SELECT 1 FROM entries_fts_cold WHERE entry_id = ?').get(e.id);
    if (existed) countFtsDelete(1);            // 删旧行 = 一次 FTS 删改，进 9a 的触发窗口
    db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(e.id);
    const table = e.cold ? 'entries_fts_cold' : 'entries_fts';
    if (e.cold) db.prepare('DELETE FROM entries_fts_cold WHERE entry_id = ?').run(e.id);
    db.prepare(`INSERT INTO ${table}(tokens, entry_id, domain_id) VALUES (?, ?, ?)`)
      .run(tokenizeBigram(`${e.text} ${(e.topic_tags ?? []).join(' ')}`), e.id, e.domain_id);
  }

  /** `entry_triples` 的唯一写入点 —— 归一化只在这里发生。 */
  function writeTripleRows(e) {
    db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(e.id);
    const ins = db.prepare(`INSERT INTO entry_triples(entry_id, seq, domain_id, subject_key, attribute, value)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    (e.triples ?? []).forEach((t, i) => {
      ins.run(e.id, i, e.domain_id, subjectKey(t.subject), attributeKey(t.attribute), t.value);
    });
  }

  /* ─────────────────── 连锁记忆：entry_links 归一化（§9.1 evidence_links 做活） ─────────────────── */

  /**
   * entry_links 里 source='extract' 行的唯一写入点（对齐 writeTripleRows 的先例）：
   * 从 entry.evidence_links JSON 重建该条目声明的边。dream 攒的 coexist 边（source='dream'）
   * 是派生数据，不在这里管——重建它走 rebuild 的共现重算。
   */
  function syncExtractLinks(e) {
    const del = db.prepare(`DELETE FROM entry_links WHERE entry_id = ? AND source = 'extract'`);
    const ins = db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at)
                            VALUES (?, ?, ?, 'extract', ?)`);
    dbTx(db, () => {
      del.run(e.id);
      for (const l of (e.evidence_links ?? [])) {
        if (!l || typeof l.entry_id !== 'string' || l.entry_id === e.id) continue;
        if (!['support', 'causal', 'coexist'].includes(l.type)) continue;
        ins.run(e.id, l.entry_id, l.type, e.recorded_at ?? now());
      }
    });
  }

  /** 单条目链接数上限：防止热门条目长成蜘蛛网（第三步 dream 攒边同样受此约束）。 */
  const MAX_LINKS_PER_ENTRY = 8;

  /**
   * 给已有条目追加 evidence links（两遍法的第二遍：同批候选都落库拿到 id 之后再补边）。
   * 去重（同目标同类型只留一条）、自环丢弃、上限截断；md 真相源同步重写（evidence 行）。
   * @returns {boolean} 是否真的写了
   */
  async function appendEvidenceLinks(entryId, links) {
    const e = loadEntry(db, entryId);
    if (!e) return false;
    const have = new Set((e.evidence_links ?? []).map((l) => `${l.entry_id}\u0000${l.type}`));
    const add = (links ?? []).filter((l) => l && typeof l.entry_id === 'string'
      && l.entry_id !== entryId && ['support', 'causal', 'coexist'].includes(l.type)
      && !have.has(`${l.entry_id}\u0000${l.type}`));
    if (!add.length) return false;
    e.evidence_links = [...(e.evidence_links ?? []), ...add].slice(0, MAX_LINKS_PER_ENTRY);
    dbTx(db, () => upsertEntryRow(db, e));
    syncExtractLinks(e);
    try {
      const path = await files.locateEntryPath(e);
      if (path) await writeMarkdownAtomic(e, path);   // 真相源同步（evidence 行随 entry 整体重写）
    } catch (err) {
      await audit.write?.('evidence-links-md-failed', { entryId, error: String(err?.message ?? err).slice(0, 200) });
    }
    return true;
  }

  function bumpShardCount(domainId, d) {
    if (d === 'skipped') return;
    if (d === 'replaced') {
      // 行数不变，只刷时间戳；不用 +0 的 UPSERT，否则会给不存在的域凭空建行
      db.prepare('UPDATE vec_shards SET updated_at = ? WHERE domain_id = ?').run(now(), domainId);
      return;
    }
    db.prepare(`INSERT INTO vec_shards(domain_id, vector_count, updated_at) VALUES (?, 1, ?)
                ON CONFLICT(domain_id) DO UPDATE SET
                  vector_count = vector_count + excluded.vector_count,
                  updated_at = excluded.updated_at`).run(domainId, now());
  }

  function decShardCount(domainId) {
    db.prepare(`UPDATE vec_shards SET vector_count = MAX(0, vector_count - 1), updated_at = ?
                WHERE domain_id = ?`).run(now(), domainId);
  }

  async function indexEntries(tasks) {
    const touched = new Set();
    dbTx(db, () => {
      for (const task of tasks) {
        const entry = loadEntry(db, task.entryId);     // R-90：包装读取，triples 已反序列化
        if (!entry) { audit.indexMissing({ ...task }); continue; }
        upsertFtsRow(entry);
        writeTripleRows(entry);
        const d = vec.upsert(entry, task.embedding);
        bumpShardCount(entry.domain_id, d);
        // §18：这次没拿到向量（模型未就绪 / RPC 超时）→ 标 pending，留给补嵌扫回来。
        // 向量路整个关掉（没 embedder）时不标，否则 pending 永远清不掉，日志里全是幽灵条目。
        const pending = vec.enabled && !entry.cold && !task.embedding;
        db.prepare('UPDATE entries SET embedding_pending = ? WHERE id = ?')
          .run(pending ? 1 : 0, entry.id);
        extendVocab(entry.domain_id, entry.triples);
        touched.add(task.mdPath);                       // 事务内不做任何文件 IO
      }
    });
    // 提交后再刷 sha：本批 N 条落在同一分片 → 只算 1 次 [R-48]
    for (const p of touched) await files.refreshFileSha(p);
  }

  /* ─────────────────── §12.1 isUseful / stashLowUtility ─────────────────── */

  /**
   * 「什么算低效用」—— 文档要求 P0b 之前定下来，别边写边发明。
   * 最小判据（四类，全部可配）：太短 / 既无标签又无三元组且不长 / 纯表情 / 纯链接。
   *
   * **低效用不是删除**：stash 到 `audit/low-utility.log` 留审计价值。
   * 返回 null 表示可用，否则返回原因字符串。
   */
  function usefulnessIssue(c) {
    const u = cfg.write.useful;
    if (!u?.enabled) return null;

    const text = String(c.text ?? '').trim();

    // 先判"形态"，再判长度：纯表情用 `text.length` 量是 4（每个 emoji 两个 code unit），
    // 先判长度会把它归到 `no-anchor`，审计里就看不到真正的原因
    if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(text)) return 'emoji-only';
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return 'link-only';

    if (text.length < u.minChars) return 'too-short';

    const hasTags = (c.topicTags ?? []).length > 0;
    const hasTriples = (c.triples ?? []).length > 0;
    if (!hasTags && !hasTriples && text.length < u.untaggedMinChars) return 'no-anchor';
    return null;
  }

  async function stashLowUtility(c, domain, reason) {
    await audit.write('low-utility', {
      domainId: domain.id,
      reason,
      text: String(c.text ?? '').slice(0, 200),
      triples: (c.triples ?? []).length,
    });
  }

  /* ─────────────────────── §12.3 落盘 ─────────────────────── */

  async function persistNewEntry(rawCandidate, domain, opts = {}) {
    const c = validateCandidate(rawCandidate);

    const issue = usefulnessIssue(c);
    if (issue) {
      await stashLowUtility(c, domain, issue);
      return { status: 'low-utility', reason: issue };
    }

    const entry = buildEntry(c, domain, cfg, now());
    const date = localDate(entry.recorded_at, cfg.storage.timezone);

    if (!tryConsumeQuota(domain.id, date)) {
      // `reenqueue: false` 来自 drainPending：这条**本来就在** pending 表里，
      // 再插一次会让每次"配额还没恢复"的 drain 都复制一份，表越攒越多且没有上限。
      if (opts.reenqueue !== false) {
        db.prepare(`INSERT INTO pending_candidates(domain_id, payload, enqueued_at, expire_at)
                    VALUES (?, ?, ?, ?)`)
          .run(domain.id, JSON.stringify(c), now(), now() + cfg.write.pendingTtlMs);
      }
      return { status: 'pending', entryId: entry.id };
    }

    if (domain.requireSignature) security.signEntry(entry);

    const [embedding] = await vec.embedTexts([`${entry.text} ${(entry.topic_tags ?? []).join(' ')}`]);
    if (embedding) entry.embedding = embedding;

    let path;
    try {
      path = await writeMarkdownAtomic(entry);          // 真相源先落
    } catch (err) {
      rollbackQuota(domain.id, date);                   // Markdown 写失败 → 回滚配额、不投索引
      throw err;
    }
    dbTx(db, () => upsertEntryRow(db, entry));          // 同步写 entries
    await indexEntries([{ entryId: entry.id, mdPath: path, embedding }]);
    if (entry.evidence_links?.length) syncExtractLinks(entry);   // 声明边（remember 直连路）随落库归一化
    return { status: 'written', entry, path };
  }

  /**
   * §17.2 第 7 步：pattern 落盘（P3+）。
   * 与 persistNewEntry 的唯一区别是配额来源：`patternQuotaPerDay` 按本地日独立计数，
   * **不碰 quotas 表**——pattern 挤占日常写入配额，等于让"提炼出的规律"把"今天的事实"顶掉。
   * 判重仍走调用方的 classifyNovelty（redundant 的 pattern 不落第二份）。
   */
  async function persistPattern(rawCandidate, domain) {
    const c = validateCandidate(rawCandidate);
    const entry = buildEntry(c, domain, cfg, now());
    entry.entry_type = 'pattern';

    const today = localDate(entry.recorded_at, cfg.storage.timezone);
    const usedToday = db.prepare("SELECT recorded_at FROM entries WHERE domain_id = ? AND entry_type = 'pattern'")
      .all(domain.id)
      .map((r) => localDate(r.recorded_at, cfg.storage.timezone))
      .filter((d) => d === today).length;
    if (usedToday >= cfg.write.patternQuotaPerDay) return { status: 'quota-full' };

    if (domain.requireSignature) security.signEntry(entry);
    const [embedding] = await vec.embedTexts([`${entry.text} ${(entry.topic_tags ?? []).join(' ')}`]);
    if (embedding) entry.embedding = embedding;

    const path = await writeMarkdownAtomic(entry);      // 真相源先落，与主写入路径同序
    dbTx(db, () => upsertEntryRow(db, entry));
    await indexEntries([{ entryId: entry.id, mdPath: path, embedding }]);
    return { status: 'written', entry, path };
  }

  /* ─────────────────── §12.2 四分类（P0a 绕过）─────────────────── */

  async function classifyNovelty(c, domain) {
    for (const t of c.triples ?? []) {
      const rows = db.prepare(`
        SELECT t.value, t.entry_id
        FROM entry_triples t JOIN entries e ON e.id = t.entry_id
        WHERE t.domain_id = ? AND t.subject_key = ? AND t.attribute = ? AND e.cold = 0 AND e.superseded_by IS NULL
        ORDER BY e.observed_at DESC, e.id
      `).all(domain.id, subjectKey(t.subject), attributeKey(t.attribute));

      if (rows.length === 0) continue;
      const exact = rows.find((r) => normalizeValue(r.value) === normalizeValue(t.value));
      if (exact) return { kind: 'redundant', existingId: exact.entry_id };
      return { kind: 'update', existingId: rows[0].entry_id };
    }

    const [embedding] = await vec.embedTexts([c.text]);
    if (!embedding) return { kind: 'new' };
    await reconcilePending(c, domain, embedding);
    const [top] = vec.search(embedding, domain.id, 1);
    if (!top) return { kind: 'new' };
    const sim = top.score ?? 0;
    if (sim > cfg.write.novelty.redundant) return { kind: 'redundant', existingId: top.id };
    // 【冲突治理 §2.3】字面相似兜底：向量没过线但文本几乎一样的，按 redundant 拦
    // （"我喜欢喝咖啡" vs "喜欢喝咖啡"这类——向量分不够、字面一眼同义）。
    const topEntry = loadEntry(db, top.id);
    if (topEntry) {
      const j = literalJaccard(c.text, topEntry.text);
      if (j >= (cfg.write.novelty.literalJaccard ?? 0.85)) {
        return { kind: 'redundant', existingId: top.id };
      }
    }
    if (sim > cfg.write.novelty.uncertain) {
      // 【实体锚定】词平均嵌入对"同主语句式"打高分——真实语料实测：全部以同一主语开头的
      // 条目两两相似度都在 0.8 上下（结构主导），0.80 的 uncertain 线形同虚设，任何
      // 新事实都会被误挂待定池。纯句式相似不算拿不准：必须与 top 条目有 ≥2 字连续
      // 字面重叠（具体实体/词组）才值得人工确认；否则视为结构巧合，正常入库。
      const cClean = stripDateLike(c.text);
      const topClean = stripDateLike(topEntry?.text ?? '');
      if (topEntry && commonSubstringLength(cClean, topClean) >= 2) {
        return { kind: 'uncertain', existingId: top.id };
      }
    }
    return { kind: 'new' };
  }

  /**
   * 【待定池对账（死水防波堤）】pending 不入索引 = 后续写入撞不见它——真实事故：
   * 待定池里躺着"芝麻开门是暗号"，另一会话写"想吃芝麻开门"畅通无阻进正库顶掉真计划，
   * 两条矛盾账并存无人发现。修法：每次向量路由前与 pending 逐条对账（文本先剥日期，
   * R-92 同款——pending 躺的全是注水原文）：
   *   ① 相似 ≥ redundant 线 → **提升**：pending 所述事实由本候选正式入库，删待定行；
   *   ② 相似 ≥ uncertain 线且字面实体重叠（commonSubstringLength ≥ 2）→ **疑似冲突**：
   *      双发（pending 保留、新候选照常走分类）+ consolidation_signals 打
   *      `pending-conflict` 标记供 dream/组装层提示——**绝不自动覆盖任何一方**
   *      （"想吃鱼"与"芝麻开门是暗号"可能同时成立，裁决权在人与 Agent）。
   * 真语义对账等 M7 的 dream s7（只告警不自动清理，同 s10 纪律）。
   */
  async function reconcilePending(c, domain, embedding) {
    let rows;
    try {
      rows = db.prepare('SELECT id, payload FROM pending_candidates WHERE domain_id = ? ORDER BY rowid DESC LIMIT 50').all(domain.id);
    } catch { return; }   // 表不存在（极早期 schema）= 无对账对象
    if (!rows.length) return;
    const cClean = stripDateLike(c.text);
    for (const row of rows) {
      let pText = '';
      try { pText = String(JSON.parse(row.payload).text ?? ''); } catch { continue; }
      if (!pText) continue;
      const pClean = stripDateLike(pText);
      let sim = literalJaccard(cClean, pClean);
      if (embedding && vec.enabled) {
        const [pv] = await vec.embedTexts([pText]);
        if (pv && pv.length === embedding.length) {
          let d = 0;
          for (let i = 0; i < embedding.length; i++) d += embedding[i] * pv[i];
          sim = Math.max(sim, d);
        }
      }
      if (sim > (cfg.write.novelty.redundant ?? 0.92)) {
        db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(row.id);
        await audit.dream({ event: 'pending-promoted', domainId: domain.id, by: c.text.slice(0, 60) });
        continue;
      }
      if (sim > (cfg.write.novelty.uncertain ?? 0.8) && commonSubstringLength(cClean, pClean) >= 2) {
        // 【R-148】明细随信号走：组装层提示要能说清"哪两句在打架"
        recordConsolidationSignal('pending-conflict', domain.id, Number(sim.toFixed(4)), {
          pendingText: pText.slice(0, 160), candidateText: c.text.slice(0, 160),
        });
        await audit.dream({ event: 'pending-conflict', domainId: domain.id, pending: pText.slice(0, 60), candidate: c.text.slice(0, 60), sim: Number(sim.toFixed(4)) });
      }
    }
  }

  /* ─────────────────────── §12.4 更新与 γ ─────────────────────── */

  /**
   * 【冲突治理】内部重路由：handleUpdate 抢占失败时对 candidate 重新分类并分发。
   * 与 kernel.remember 的 switch 同语义——因为重路由必须发生在 write 内部（抢占失败
   * 时刻），这里复制一份分发逻辑；redundant 的 reinforce 与 kernel 侧调用同函数。
   */
  async function dispatch(rawCandidate, domain) {
    const route = await classifyNovelty(rawCandidate, domain);
    if (route.kind === 'redundant') { reinforceEntry(route.existingId); return { status: 'redundant', existingId: route.existingId }; }
    if (route.kind === 'update') return handleUpdate(rawCandidate, route, domain);
    if (route.kind === 'uncertain') return handleUncertain(rawCandidate, route, domain);
    return persistNewEntry(rawCandidate, domain);
  }

  async function handleUpdate(rawCandidate, route, domain) {
    const oldEntry = loadEntry(db, route.existingId);
    if (!oldEntry) return persistNewEntry(rawCandidate, domain);

    const c = validateCandidate(rawCandidate);
    const newEntry = buildEntry(c, domain, cfg, now());
    const settled = lazyPersistence(oldEntry, cfg);
    newEntry.supersedes = [oldEntry.id];

    // 【冲突治理】原子抢占：条件 UPDATE 防并发互标循环取代（A 标 B、B 又标 A
    // → 两者都被检索过滤 → 双盲）。抢占 = 直接写入真 newEntry.id（后面所有存储
    // 都不再重复写这个字段）。失败 = 旧条目已被其他写入取代——本次 candidate
    // 重新分类（查表已排除被取代条目，会看到新终值，落入 redundant/update/new 的
    // 正确分支；递归最多链长次，实践中 1 次）。抢占成功后才写任何存储。
    const grab = db.prepare('UPDATE entries SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL')
      .run(newEntry.id, oldEntry.id);
    if (grab.changes === 0) return dispatch(rawCandidate, domain);

    // 【全量审查 S1】抢占已提交（独立语句），后续任何失败都会造成"旧条目被过滤 +
    // 新条目不存在"的双丢失。这里包补偿式回滚：失败则还原 superseded_by 并留审计，
    // 让这条记忆退回可检索状态，而不是无声消失。
    const rollbackGrab = (why) => {
      db.prepare('UPDATE entries SET superseded_by = NULL WHERE id = ? AND superseded_by = ?')
        .run(oldEntry.id, newEntry.id);
      audit.write('update-rollback.log', {
        at: now(), oldId: oldEntry.id, newId: newEntry.id, why,
        text: String(rawCandidate.text ?? '').slice(0, 80),
      }).catch(() => {});
    };
    try {
      if (domain.requireSignature) security.signEntry(newEntry);

      const at = now();    // 【R-84】只取一次：两个存储的同名字段必须完全相等
      const [embedding] = await vec.embedTexts([`${newEntry.text} ${(newEntry.topic_tags ?? []).join(' ')}`]);
      if (embedding) newEntry.embedding = embedding;

      // 真相源先落（新条目 + 旧条目的 state 补丁）[R-82]
      const newPath = await writeMarkdownAtomic(newEntry);
      const oldPatched = {
        ...oldEntry,
        superseded_by: newEntry.id,
        gamma_multiplier: cfg.write.updateGamma,
        last_decay_at: at,
        persistence_at_decay: settled,
      };
      const oldPath = await writeMarkdownAtomic(oldPatched, await files.locateEntryPath(oldEntry));

      dbTx(db, () => {
        upsertEntryRow(db, newEntry);
        // superseded_by 已在入口抢占（见 handleUpdate 开头），这里只补齐衰减字段
        db.prepare(`UPDATE entries SET gamma_multiplier = ?,
                    last_decay_at = ?, persistence_at_decay = ? WHERE id = ?`)
          .run(cfg.write.updateGamma, at, settled, oldEntry.id);
      });

      await indexEntries([
        { entryId: newEntry.id, mdPath: newPath, embedding },
        { entryId: oldEntry.id, mdPath: oldPath },
      ]);
      recordConsolidationSignal('conflict_accum', domain.id, 1.0);
      return { status: 'updated', entry: newEntry, superseded: oldEntry.id };
    } catch (error) {
      rollbackGrab(`update 失败回滚: ${String(error).slice(0, 120)}`);
      throw error;
    }
  }

  async function handleUncertain(c, route, domain) {
    // P3+ 才开 LLM 合并；现在只记信号 + 保留候选（不丢）
    recordConsolidationSignal('uncertain_merge', domain.id, 1.0);
    // 【R-149】确认闸门开：uncertain 候选只进确认池等用户裁决，不照常入库——
    // "抽取错的、抽过界的"在落库前就被拦住，而不是事后靠删除/遗忘补救。
    // 关闭时维持 R-119 的双发行为（pending 保留 + 新候选照常分类），不改存量语义。
    if (cfg.write.confirmGate?.enabled) {
      db.prepare(`INSERT INTO pending_candidates(domain_id, payload, enqueued_at, expire_at, reason)
                  VALUES (?, ?, ?, ?, 'confirm')`)
        .run(domain.id, JSON.stringify(c), now(), now() + cfg.write.pendingTtlMs);
      await audit.write?.('confirm-enqueued', { domainId: domain.id, text: c.text?.slice(0, 80) });
      return { status: 'pending-confirm' };
    }
    db.prepare(`INSERT INTO pending_candidates(domain_id, payload, enqueued_at, expire_at)
                VALUES (?, ?, ?, ?)`)
      .run(domain.id, JSON.stringify(c), now(), now() + cfg.write.pendingTtlMs);
    return { status: 'uncertain', existingId: route.existingId };
  }

  /* ─────────────── R-149：确认池消费口（设置页 human-in-the-loop）─────────────── */

  /** 确认队列列表（未过期在前）。 */
  function confirmQueue() {
    return db.prepare(`SELECT id, domain_id, payload, enqueued_at, expire_at
                       FROM pending_candidates WHERE reason = 'confirm' AND expire_at > ?
                       ORDER BY enqueued_at DESC`).all(now())
      .map((r) => {
        let text = '', entryType = '';
        try { const p = JSON.parse(r.payload); text = p.text ?? ''; entryType = p.entryType ?? p.entry_type ?? ''; } catch { /* 坏 payload 原样展示 */ }
        return { id: r.id, domainId: r.domain_id, text, entryType, enqueuedAt: r.enqueued_at, expireAt: r.expire_at };
      });
  }

  /**
   * 确认 → 走正常落盘管线（p0a 直写语义：已由人工背书，无需再分类）。
   * 确认过的记忆写 reinforce 激活事件——**天生比自动入库的更持久，这个不对称是有意的**。
   */
  async function confirmApprove(id) {
    const row = db.prepare(`SELECT * FROM pending_candidates WHERE id = ? AND reason = 'confirm'`).get(id);
    if (!row) return { ok: false, error: 'not-found' };
    let payload;
    try { payload = JSON.parse(row.payload); } catch { db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(id); return { ok: false, error: 'bad-payload' }; }
    const domain = domains.get(row.domain_id);
    if (!domain) { db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(id); return { ok: false, error: 'domain-gone' }; }

    const result = await persistNewEntry(payload, domain);
    db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(id);
    const entryId = result?.entry?.id;
    if (entryId) {
      recordActivations([entryId], 'reinforce', now());
      // 【R-144】confirm 加成：importance +0.2（cap 1.0）——确认过的记忆更耐冷存、排序略前。
      // md 真相源同步重写（importance 在 state 块里，R-88 纪律）。
      try {
        const e = loadEntry(db, entryId);
        if (e) {
          e.importance = Math.min(1.0, (e.importance ?? 0.5) + (cfg.write.confirmGate?.confirmBoost ?? 0.2));
          dbTx(db, () => upsertEntryRow(db, e));
          syncExtractLinks(e);
          const p = await files.locateEntryPath(e);
          if (p) await writeMarkdownAtomic(e, p);
        }
      } catch (err) {
        await audit.write?.('confirm-boost-failed', { entryId, error: String(err?.message ?? err).slice(0, 150) });
      }
    }
    await audit.write?.('confirm-approved', { id, domainId: row.domain_id, entryId: entryId ?? null });
    return { ok: true, result };
  }

  /** 拒绝 → 删 + audit。拒绝本身也是记忆治理的一部分（用户说了"这个不用记"）。 */
  async function confirmReject(id, note = '') {
    const row = db.prepare(`SELECT payload FROM pending_candidates WHERE id = ? AND reason = 'confirm'`).get(id);
    if (!row) return { ok: false, error: 'not-found' };
    db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(id);
    let text = '';
    try { text = JSON.parse(row.payload)?.text?.slice(0, 80) ?? ''; } catch { /* 坏 payload */ }
    await audit.write?.('confirm-rejected', { id, note: String(note).slice(0, 200), text });
    return { ok: true };
  }

  /** 【R-148】detail：conflict 家族信号要进组装层提示，携带明细 JSON；其余信号不填。 */
  function recordConsolidationSignal(kind, domainId, weight, detail = null) {
    db.prepare(`INSERT INTO consolidation_signals(kind, domain_id, weight, created_at, detail)
                VALUES (?, ?, ?, ?, ?)`).run(kind, domainId, weight, now(), detail ? JSON.stringify(detail) : null);
  }

  /* ─────────────────────── 激活事件 ─────────────────────── */

  /**
   * 【R-78】kind 只有两个合法值，三个消费方必须认全：
   *   `settleEntry` 的统计 / dream 第 4 步的随批 DELETE / 本函数的写入。
   * `verified` 不走这里（它属于 trust 链路）。
   */
  function recordActivations(ids, kind = 'retrieval', at = now()) {
    const stmt = db.prepare('INSERT INTO activation_events(entry_id, at, kind) VALUES (?, ?, ?)');
    dbTx(db, () => { for (const id of ids) stmt.run(id, at, kind); });
  }

  /**
   * redundant → 只写一条激活事件，让既有闭环在下外审 dream 发奖励。
   * **不得直接改 `persistence_at_decay`** —— 那是 settleEntry 的专属字段（两个写入方 +
   * 绕过落盘顺序，与 R-40/R-82 同型）。
   */
  function reinforceEntry(entryId, at = now()) {
    recordActivations([entryId], 'reinforce', at);
  }

  /**
   * §18 补嵌：把 `embedding_pending` 的条目重新嵌入并补进向量路。
   *
   * 为什么非有不可：预热是 fire-and-forget（§11.1），冷启动前几秒写入的条目拿不到向量。
   * 没有补嵌的话，它们要等下一次全量 rebuild 才进向量路——而 rebuild 只在删库/维度变更时发生，
   * 等于**永久少一路召回**，且日志里没有任何异常，只会表现为"新写的记忆怎么搜不到"。
   *
   * 幂等：embedTexts 走 embedding_cache 去重，反复调用不会重复付费；
   * 补完就清 pending，下次扫描自然为空，不需要额外的"已处理"标记。
   */
  async function backfillEmbeddings(limit = cfg.embedding.batchSize) {
    if (!vec.enabled) return { scanned: 0, embedded: 0, stillPending: 0 };

    const ids = db.prepare(`SELECT id FROM entries
                            WHERE embedding_pending = 1 AND cold = 0
                            ORDER BY recorded_at DESC LIMIT ?`).all(limit).map((r) => r.id);
    if (!ids.length) return { scanned: 0, embedded: 0, stillPending: 0 };

    const list = [...loadEntries(db, ids, { includeCold: true }).values()];
    const vectors = await vec.embedTexts(list.map((e) => `${e.text} ${(e.topic_tags ?? []).join(' ')}`));

    let embedded = 0;
    dbTx(db, () => {
      for (let i = 0; i < list.length; i++) {
        const v = vectors[i];
        if (!v) continue;                       // 这外审还是没拿到 → 保持 pending，下轮再来
        bumpShardCount(list[i].domain_id, vec.upsert(list[i], v));
        db.prepare('UPDATE entries SET embedding_pending = 0 WHERE id = ?').run(list[i].id);
        embedded++;
      }
    });

    const still = list.length - embedded;
    if (still) await audit.write('vec-backfill-deferred', { scanned: list.length, stillPending: still });
    return { scanned: list.length, embedded, stillPending: still };
  }

  function consumePending(domainId, limit = 5) {
    const rows = db.prepare(`SELECT * FROM pending_candidates WHERE domain_id = ?
                             ORDER BY id LIMIT ?`).all(domainId, limit);
    return rows;
  }

  /**
   * pending_candidates 的消费闭环（§12.3 末段）：FIFO，逐条重走 `persistNewEntry`，
   * **仍受配额约束，满了就停**（不越权写）；`expire_at` 已过的直接删并写 audit。
   *
   * 没有这一步，配额满那天的候选就是永久躺在表里 —— 表面上"只是延迟"，实际是静默丢记忆。
   */
  async function drainPending(domain, opts = {}) {
    const limit = opts.limit ?? cfg.write.pendingDrainLimit;
    // 【R-149】confirm 池不进自动消化——它就是为"等人裁决"存在的，drain 碰它 = 闸门白装
    const rows = db.prepare(`SELECT * FROM pending_candidates WHERE domain_id = ?
                             AND (reason IS NULL OR reason != 'confirm')
                             ORDER BY id LIMIT ?`).all(domain.id, limit);
    const result = { scanned: rows.length, consumed: 0, expired: 0, dropped: 0, blocked: false };

    for (const row of rows) {
      const del = () => db.prepare('DELETE FROM pending_candidates WHERE id = ?').run(row.id);

      if (row.expire_at < now()) {
        del();
        result.expired++;
        await audit.write('pending-expired', { domainId: domain.id, id: row.id, enqueuedAt: row.enqueued_at });
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        del();                                  // 坏 payload 不能永远占位
        result.dropped++;
        await audit.write('pending-bad-payload', { domainId: domain.id, id: row.id });
        continue;
      }

      const res = await persistNewEntry(payload, domain, { reenqueue: false });
      if (res.status === 'pending') { result.blocked = true; break; }   // 配额仍满，后面的别再试
      del();
      if (res.status === 'low-utility') result.dropped++;
      else result.consumed++;
    }
    return result;
  }

  return {
    tryConsumeQuota,
    persistNewEntry,
    persistPattern,
    writeMarkdownAtomic,
    indexEntries,
    classifyNovelty,
    handleUpdate,
    handleUncertain,
    reinforceEntry,
    recordActivations,
    recordConsolidationSignal,
    decShardCount,
    bumpShardCount,
    consumePending,
    drainPending,
    backfillEmbeddings,
    usefulnessIssue,
    stashLowUtility,
    syncExtractLinks,
    appendEvidenceLinks,
    MAX_LINKS_PER_ENTRY,
    confirmQueue,
    confirmApprove,
    confirmReject,
  };
}

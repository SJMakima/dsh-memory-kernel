/**
 * §17.2 Dream：状态注册表，不是一条流水线 [R-60]。
 *
 * 每一步都是独立函数，声明四件事：输入 → 输出 → 失败语义 → 可重入性。
 * P1 只开 1/2/3/4/5/6/8/9b（关 9a / 10 / 11），开关在 `cfg.dream.steps`。
 *
 * 两条铁律：
 *   ① 真相源先落（第 3 步 Markdown 先、第 4 步 SQLite 后）[R-40]
 *   ② 事件删除必须与状态回写**同事务、按批收敛**（否则某批失败时 hits 静默归零）[R-57]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lazyPersistence, settleEntry, shouldColdArchive } from '../pure/lifecycle.js';
import { parsePartPath, localDate } from '../pure/paths.js';
import { tokenizeBigram } from '../pure/tokenize.js';
import { loadEntries, upsertEntryRow, rowToEntry } from './entry.js';
import { clearVocab } from './vocab.js';
import { mineCooccurrenceLinks } from './links.js';
import {
  readFileSafe, writeFileAtomic, upsertBlock, removeBlock, parseMarkdownFile, listMarkdownFiles,
} from '../storage/md.js';
import { withFileLock } from '../storage/lock.js';
import { dbTx } from '../storage/db.js';
import { countFtsDelete, markFtsOptimize, ftsStats } from '../storage/fts-stats.js';

const execFileP = promisify(execFile);

export function createDream({ db, cfg, vec, files, audit, domains, write, llm, diary, inner, transcript, emotions }) {
  let dreamCount = 0;
  let pendingMdWrites = new Set();   // 跨 dream 的**路径级**累积，只用来缩短 git pathspec

  function auditTopActivated(domainId, n = 10) {
    // 【R-87】计数并列时补 id，audit 也要可复现
    return db.prepare(`SELECT id, activation_count FROM entries
                       WHERE domain_id = ? AND cold = 0
                       ORDER BY activation_count DESC, id LIMIT ?`).all(domainId, n);
  }

  /** 第 1 步：git 前置快照。Windows 上禁止 `git add -A`（要 stat 整个工作区）[R-23]。 */
  async function step1GitSnapshot(snapshotTs) {
    if (!cfg.dream.steps.gitSnapshot) return { skipped: 'disabled' };
    const isRepo = await fs.stat(path.join(cfg.storage.root, '.git')).then(() => true).catch(() => false);
    if (!isRepo) return { skipped: 'not-a-repo' };

    const changed = new Set(pendingMdWrites);
    const tracked = await execFileP('git', ['ls-files', '-m', '-o', '--exclude-standard'], { cwd: cfg.storage.root })
      .then((r) => r.stdout.split('\n').filter(Boolean))
      .catch(() => []);
    for (const f of tracked) changed.add(f);
    if (changed.size === 0) return { skipped: 'no-changes' };

    try {
      await execFileP('git', ['add', '--', ...changed], { cwd: cfg.storage.root });
      // 快照仓库是内核自己管的，不该依赖用户全局 git 身份（新机器上
      // "Author identity unknown" 会让每次 dream 的提交都失败）
      await execFileP('git', [
        '-c', 'user.name=dsh-memory-kernel',
        '-c', 'user.email=dsh-memory-kernel@localhost',
        'commit', '-q', '-m', `dream ${new Date(snapshotTs).toISOString()}`,
      ], { cwd: cfg.storage.root });
      pendingMdWrites = new Set();
      return { committed: changed.size };
    } catch (err) {
      return { failed: String(err.message ?? err) };   // 不阻塞后续步骤，下次重试
    }
  }

  /**
   * 第 2 步：纯内存算新状态。只处理 `recorded_at <= snapshotTs` 的条目 [禁止项 8]。
   *
   * 【实现层修正】文档第 4 步写的是 `activation_count = activation_count + ?`，
   * 但第 3 步的 Markdown 状态同步写的是 `e.activation_count`（**增量前**的值）——
   * 于是真相源里的激活计数永远落后 SQLite 一个窗口，删库重建后 `activation_count` 归零。
   * 修法：第 2 步就把 `count + hits` 算成绝对值，两个存储写同一个数。
   * 绝对写在"同一 snapshot 内"是幂等的；文档反对的是用 `COUNT(*) FROM activation_events`
   * 重算（事件结算即删，那样写会每轮清零），不是绝对值本身。
   */
  function step2ComputeState(snapshotTs) {
    const rows = db.prepare('SELECT * FROM entries WHERE recorded_at <= ? AND cold = 0').all(snapshotTs);
    return rows.map((row) => {
      const e = rowToEntry(row);
      const hits = db.prepare(`
        SELECT COUNT(*) AS n FROM activation_events
        WHERE entry_id = ? AND kind IN ('retrieval','reinforce') AND at > ? AND at <= ?
      `).get(e.id, e.last_decay_at, snapshotTs).n;
      const p = settleEntry(e, cfg, snapshotTs, hits);
      return {
        e,
        p,
        hits,
        activation_count: e.activation_count + hits,
        last_activated_at: hits > 0 ? snapshotTs : e.last_activated_at,
        // 【R-121】落盘门槛（量化）：惰性衰减让 p 几乎永远不等于存量值，用 ε 判等等于"每轮全库重写"——
        // ADR-21 当年接受的是"dream 期写放大"，不是"每夜重写 100% 分片"。三条放行条件：
        //   ① 本轮有激活（hits>0，激活计数变化必须有持久痕迹，不能攒）；
        //   ② |Δp| ≥ stateWriteEpsilonP（默认 0.01，约等于可见的衰减一步）；
        //   ③ 距上次落盘 ≥ stateWriteMaxStaleDays 天（保底：防止极慢衰减的条目永久不落）。
        // 被跳过的条目**不更新 last_decay_at**，下外审从同一基准重算，delta 累积到门槛再落 —— 幂等。
        changed: hits > 0
          || Math.abs(p - e.persistence_at_decay) >= (cfg.dream.stateWriteEpsilonP ?? 0.01)
          || (snapshotTs - e.last_decay_at) >= (cfg.dream.stateWriteMaxStaleDays ?? 14) * 864e5,
      };
    });
  }

  /**
   * 第 3 步：Markdown 状态同步（真相源先落）。
   * 失败分片的条目进 `pendingMdStateWrites`（本轮内存集合，不持久化 [R-46]），本轮不写 SQLite。
   */
  async function step3SyncMarkdown(patches, snapshotTs) {
    const pending = new Set();
    const groups = new Map();

    for (const patch of patches) {
      if (!patch.changed) continue;
      const p = await files.locateEntryPath(patch.e);
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(patch);
    }

    for (const [p, list] of groups) {
      try {
        await withFileLock(p, async () => {
          let md = await readFileSafe(p);
          for (const patch of list) {
            md = upsertBlock(md, {
              ...patch.e,
              persistence_at_decay: patch.p,
              last_decay_at: snapshotTs,
              activation_count: patch.activation_count,
              last_activated_at: patch.last_activated_at,
            });
          }
          await writeFileAtomic(p, md);
          await files.refreshFileSha(p, md);     // sha 的单点刷新 [R-49]
        });
        pendingMdWrites.add(path.relative(cfg.storage.root, p).replace(/\\/g, '/'));
      } catch {
        for (const { e } of list) pending.add(e.id);
      }
    }
    return pending;
  }

  /** 第 4 步：仅 landed 条目，微批事务；事件删除与状态 UPDATE **同事务**。 */
  function step4SyncSqlite(patches, pendingSet, snapshotTs) {
    const landed = patches.filter((x) => x.changed && !pendingSet.has(x.e.id));
    const size = Math.max(1, cfg.write.microBatchRows);

    for (let i = 0; i < landed.length; i += size) {
      const batch = landed.slice(i, i + size);
      const ids = batch.map((x) => x.e.id);
      dbTx(db, () => {
        const upd = db.prepare(`UPDATE entries SET last_decay_at = ?, persistence_at_decay = ?,
                                activation_count = ?, last_activated_at = ?
                                WHERE id = ?`);
        for (const { e, p, activation_count, last_activated_at } of batch) {
          upd.run(snapshotTs, p, activation_count, last_activated_at, e.id);
        }
        // 【R-57】kind 集合与 settleEntry 一致；按批收敛，不能全局删
        db.prepare(`DELETE FROM activation_events
                    WHERE kind IN ('retrieval','reinforce')
                      AND entry_id IN (${ids.map(() => '?').join(',')})
                      AND at <= ?`).run(...ids, snapshotTs);
      });
    }
    return landed.length;
  }

  /** 第 5 步：TTL 清理（retrieval/reinforce 已在第 4 步随批删除）。 */
  function step5TtlCleanup(snapshotTs) {
    const v = db.prepare("DELETE FROM activation_events WHERE kind = 'verified' AND at < ?")
      .run(snapshotTs - cfg.trust.verifiedWindowMs).changes;
    // P1 verifiedEnabled=false 时这张表没有写入，DELETE 命中 0 行 —— 保留而不加开关
    const r = db.prepare('DELETE FROM retrieval_log WHERE created_at < ?')
      .run(snapshotTs - cfg.retrieve.retrievalLogTtlMs).changes;

    // 【R-108】对话流水 TTL：原话体积增长比提炼条目快得多（每条几百字 × 每轮 N 条），
    // 不跟随 dream 清理迟早把库撑爆。FTS 是独立虚拟表，没有外键级联——先删索引行再删主行。
    let transcriptRows = 0;
    const retainDays = cfg.transcript?.retainDays ?? 180;
    if (cfg.transcript?.enabled !== false && retainDays > 0) {
      try {
        const ids = db.prepare('SELECT id FROM transcript WHERE ts < ?')
          .all(snapshotTs - retainDays * 864e5).map((x) => x.id);
        if (ids.length) {
          const delFts = db.prepare('DELETE FROM transcript_fts WHERE transcript_id = ?');
          const delRow = db.prepare('DELETE FROM transcript WHERE id = ?');
          // 【R-141】向量投影随主行一起删——留孤儿向量不但占空间，还会被 MATCH 捞出来
          // 再 JOIN 空行，白耗一次检索
          let delVec = null;
          try { delVec = db.prepare('DELETE FROM transcript_vec WHERE message_id = ?'); } catch { /* 老库无表 */ }
          dbTx(db, () => { for (const id of ids) { delFts.run(id); if (delVec) delVec.run(String(id)); delRow.run(id); } });
          transcriptRows = ids.length;
        }
      } catch { /* 老库没有 transcript 表：跳过，不影响其他清理 */ }
    }
    // 【R-139】内心活动流水 TTL：与 transcript 同寿命。日记里已合并「当时的想法」，
    // 流水过期丢的只是原始记录，第一手要点已在日记里长期保存。
    let innerRows = 0;
    if (inner && cfg.inner?.enabled !== false) {
      try { innerRows = inner.prune(snapshotTs); } catch { /* 老库无表：跳过 */ }
    }
    // 【R-142】情绪流水 TTL：同 transcript/inner。耐久版在日记「情绪」节
    let emotionRows = 0;
    if (emotions) { try { emotionRows = emotions.prune(snapshotTs); } catch { /* 老库无表 */ } }
    return { verifiedEvents: v, retrievalLog: r, transcript: transcriptRows, inner: innerRows, emotions: emotionRows };
  }

  /**
   * 第 6 步：一致性修复 —— C2 里"Markdown 可手改"的唯一兑现路径。
   * 6a sha 比对（重解析数应恒为 0，持续 > 0 说明存在绕过写入管线的写入源）
   * 6b files 行对账（删掉磁盘上已不存在的 path）
   * 6c SQLite 有、Markdown 无 → audit + orphan（不自动删除）
   */
  async function step6ConsistencyRepair() {
    const rows = files.allFileRows();
    const knownIds = new Set();
    let reparsed = 0;
    let reverseUpserts = 0;
    let orphans = 0;

    const upsertParsed = (list) => {
      dbTx(db, () => {
        for (const e of list) {
          const existing = loadEntries(db, [e.id], { includeCold: true }).get(e.id);
          if (existing) upsertEntryRow(db, { ...existing, ...pickStateFromMd(e) });
        }
      });
    };

    for (const row of rows) {
      const exists = await fs.stat(row.path).then(() => true).catch(() => false);
      if (!exists) { files.deleteFileRow(row.path); continue; }   // 6b：幽灵分片
      if (!parsePartPath(row.path)) { files.deleteFileRow(row.path); await audit.unknownFilePattern(row.path); continue; }

      const md = await readFileSafe(row.path);
      const parsed = parseMarkdownFile(md);
      for (const e of parsed) knownIds.add(e.id);

      const nowSha = (await files.fileShaOnDisk(row.path)) ?? '';
      if (nowSha !== row.sha256) {
        upsertParsed(parsed);                                    // 手改回流
        reparsed++;
        reverseUpserts += parsed.length;
        await files.refreshFileSha(row.path, md);
      }
    }

    // 磁盘上存在但 files 表没有的文件（新文件 / 改名后的分片 / files 落后）
    for (const p of await listMarkdownFiles(cfg.storage.root)) {
      if (files.fileRow(p)) continue;
      if (!parsePartPath(p)) { await audit.unknownFilePattern(p); continue; }
      const md = await readFileSafe(p);
      const parsed = parseMarkdownFile(md);
      for (const e of parsed) knownIds.add(e.id);
      await files.refreshFileSha(p, md);
      upsertParsed(parsed);
    }

    // 6c：只在确实扫到过条目时比对，否则空工作区会把所有条目报成 orphan
    if (knownIds.size > 0) {
      for (const r of db.prepare('SELECT id FROM entries').all()) {
        if (!knownIds.has(r.id)) { await audit.write('orphan-entries', { entryId: r.id }); orphans++; }
      }
    }

    return { reparsed, reverseUpserts, orphans };
  }

  /** 第 8 步：冷存归档 —— 调的是"热区边界"，不是"遗忘" [R-64]。 */
  async function step8ColdArchive(snapshotTs) {
    if (!cfg.dream.steps.coldArchive) return { skipped: 'disabled' };
    const rows = db.prepare('SELECT * FROM entries WHERE cold = 0').all();
    let archived = 0;

    for (const row of rows) {
      const e = rowToEntry(row);
      if (!shouldColdArchive(e, cfg, snapshotTs)) continue;

      const src = await files.locateEntryPath(e);
      const cold = files.coldPathOf(e.domain_id, snapshotTs);
      const coldEntry = {
        ...e, cold: true, last_decay_at: snapshotTs, persistence_at_decay: lazyPersistence(e, cfg, snapshotTs),
      };

      try {
        await withFileLock(src, async () => {
          const md = await readFileSafe(src);
          await writeFileAtomic(src, removeBlock(md, e.id));
          await files.refreshFileSha(src);
        });
        // 冷文件是第二个被写的文件，必须单独刷 sha（否则下轮 6a 当成手改）
        await withFileLock(cold, async () => {
          const next = upsertBlock(await readFileSafe(cold), coldEntry);
          await writeFileAtomic(cold, next);
          await files.refreshFileSha(cold, next);
        });
        pendingMdWrites.add(path.relative(cfg.storage.root, src).replace(/\\/g, '/'));
        pendingMdWrites.add(path.relative(cfg.storage.root, cold).replace(/\\/g, '/'));
      } catch (err) {
        await audit.write('cold-move-failed', { entryId: e.id, error: String(err.message ?? err) });
        continue;
      }

      const tokens = tokenizeBigram(`${e.text} ${(e.topic_tags ?? []).join(' ')}`);
      dbTx(db, () => {
        db.prepare('UPDATE entries SET cold = 1, last_decay_at = ?, persistence_at_decay = ? WHERE id = ?')
          .run(snapshotTs, coldEntry.persistence_at_decay, e.id);
        db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(e.id);
        countFtsDelete(1);                 // 冷存移动也是一次 FTS 删改（9a 的窗口内）
        db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(e.id);   // 一跳扩展不涉及冷存
      });
      // 冷表：删 + 加（移动不是 UPDATE）
      db.prepare('DELETE FROM entries_fts_cold WHERE entry_id = ?').run(e.id);
      db.prepare('INSERT INTO entries_fts_cold(tokens, entry_id, domain_id) VALUES (?, ?, ?)')
        .run(tokens, e.id, e.domain_id);

      vec.remove(e.id, e.domain_id);
      write.decShardCount(e.domain_id);      // 唯一允许 -1 的调用点
      archived++;
    }
    clearVocab();                            // 剔除冷存残留，让词表懒重建
    return { archived };
  }

  /** 第 9a 步：FTS optimize。**有触发条件，不是每轮都跑**（§17.2：>500 删改或 >7 天）。 */
  function step9aFtsOptimize() {
    if (!cfg.dream.steps.ftsOptimize) return { skipped: 'disabled' };
    const { deletes, lastOptimizeAt } = ftsStats();

    // 首次（lastOptimizeAt=0）只有在删改攒够时才值得跑；没删改的 optimize 纯烧 CPU
    const overDeletes = deletes > cfg.dream.ftsOptimizeEveryDeletes;
    const overInterval = lastOptimizeAt > 0
      && Date.now() - lastOptimizeAt > cfg.dream.ftsOptimizeIntervalMs;
    if (!overDeletes && !overInterval) return { skipped: 'no-need', deletesSinceLast: deletes };

    db.exec("INSERT INTO entries_fts(entries_fts) VALUES('optimize')");
    db.exec("INSERT INTO entries_fts_cold(entries_fts_cold) VALUES('optimize')");
    markFtsOptimize();
    // 【R-157.4】trace 有保留期限：随 FTS optimize 周期轮转（保留最近 1000 行，够回查一次排障）。
    // 本步是同步函数 → 轮转 fire-and-forget，失败不挡 optimize。
    void (async () => {
      try {
        const p = path.join(cfg.storage.root, 'audit', 'retrieval-trace.log');
        const raw = await fs.readFile(p, 'utf8');
        const lines = raw.split('\n').filter((l) => l.trim());
        if (lines.length > 1000) await fs.writeFile(p, `${lines.slice(-1000).join('\n')}\n`, 'utf8');
      } catch { /* 文件不存在 = 没写过 trace，无需轮转 */ }
    })();
    return { optimized: true, deletesSinceLast: deletes };
  }

  /**
   * 第 9b 步：shard 对账 —— 分层，不抽样 [R-60/R-65]。
   * 每轮只对"本轮有 vec 写入/删除的域"；每 N 轮一次全量。漂移一律写 audit。
   */
  function step9bReconcileShards(touchedDomainIds) {
    if (!cfg.dream.steps.reconcileShards) return { skipped: 'disabled' };
    const full = dreamCount === 1 || dreamCount % cfg.dream.reconcileFullEveryNDreams === 0;
    if (!full && touchedDomainIds.length === 0) return { scope: 'none' };

    const scope = full ? '' : `WHERE domain_id IN (${touchedDomainIds.map(() => '?').join(',')})`;
    const rows = db.prepare(`SELECT domain_id, COUNT(*) AS n FROM entries_vec ${scope} GROUP BY domain_id`)
      .all(...(full ? [] : touchedDomainIds));
    const truth = new Map(rows.map((r) => [r.domain_id, r.n]));
    const targets = full
      ? db.prepare('SELECT domain_id FROM vec_shards').all().map((r) => r.domain_id)
      : touchedDomainIds;

    const drift = [];
    for (const id of targets) {
      const n = truth.get(id) ?? 0;
      const cur = vec.shardCount(id);
      if (n !== cur) {
        drift.push({ domainId: id, recorded: cur, actual: n });
        db.prepare('UPDATE vec_shards SET vector_count = ?, updated_at = ? WHERE domain_id = ?').run(n, Date.now(), id);
      }
    }
    for (const d of drift) audit.shardDrift(d);

    // 9c：热区告警 —— 现在是**纯观测点**，不再挂"切 ANN"的建议（那个能力已证伪，R-136/R-137）。
    // 内存精确索引是 O(n) 全量 SIMD 扫描，这个数直接给出单次查询向量路的耗时上界；
    // 真到了扫描扛不住的量级，该做的是拆域 / 上真正的图索引，而不是改一个不存在的开关。
    const hot = db.prepare('SELECT domain_id, vector_count FROM vec_shards WHERE vector_count > ?')
      .all(cfg.retrieve.hotPartitionWarnAt);
    for (const h of hot) {
      audit.write('hot-partition', {
        ...h,
        mode: vec.mode?.(h.domain_id) ?? null,
        suggestion: `域内 ${h.vector_count} 条向量：内存精确索引单次全量 SIMD 扫描，检索 P95 上升先看这里`,
      });
    }

    return { scope: full ? 'full' : 'touched', drift, hot: hot.length };
  }

  /** 第 10 步：身份指标采集（P2 起）。分叉 = 同一 (subject, attribute) 存活多个未取代的不同值。 */  function step10IdentityMetrics(snapshotTs) {
    if (!cfg.dream.steps.identityMetrics) return { skipped: 'disabled' };

    // 只数"活着"的条目：被 superseded 的旧值已经由取代边收口，不算分叉
    const rows = db.prepare(`
      SELECT t.domain_id, t.subject_key, t.attribute, COUNT(DISTINCT t.value) AS values_cnt
      FROM entry_triples t JOIN entries e ON e.id = t.entry_id
      WHERE e.cold = 0 AND e.superseded_by IS NULL
      GROUP BY t.domain_id, t.subject_key, t.attribute
      HAVING values_cnt > 1
      ORDER BY values_cnt DESC, t.domain_id, t.subject_key, t.attribute
    `).all();

    const byDomain = new Map();
    for (const r of rows) {
      const m = byDomain.get(r.domain_id) ?? { forkedGroups: 0, worst: null };
      m.forkedGroups++;
      if (!m.worst || r.values_cnt > m.worst.values_cnt) m.worst = { ...r };
      byDomain.set(r.domain_id, m);
    }

    if (byDomain.size) {
      dbTx(db, () => {
        const ins = db.prepare(`INSERT INTO identity_metrics(domain_id, window_start, window_end, metrics, alert)
                                VALUES (?, ?, ?, ?, ?)`);
        for (const [domainId, m] of byDomain) {
          ins.run(domainId, snapshotTs - cfg.dream.minIntervalMs, snapshotTs,
            JSON.stringify({ forkedGroups: m.forkedGroups, worst: m.worst }), 1);
        }
      });
      // 告警 = 分叉确实存在。P2 只采集与告警，**对齐是 P3+ 的人工确认动作**，
      // 这里绝不自动合并——自动合并错一次，抹掉的是用户的一条真实偏好。
      for (const [domainId, m] of byDomain) {
        audit.write('identity-fork', { domainId, ...m });
      }
    }
    return { domains: byDomain.size, forkedGroups: rows.length };
  }

  /** 未消费巩固信号的加权分（§17.1）。步 7 的触发依据 + kernel.maybeDream 的判断依据。 */
  function pendingConsolidationScore() {
    const rows = db.prepare('SELECT kind, domain_id, weight FROM consolidation_signals WHERE consumed = 0').all();
    const score = {};
    for (const r of rows) {
      const w = cfg.dream.signalWeights[r.kind] ?? 1.0;
      score[r.domain_id] = round3((score[r.domain_id] ?? 0) + r.weight * w);
    }
    return { signals: rows.length, score };
  }

  const round3 = (x) => Math.round(x * 1000) / 1000;

  const PATTERN_PROMPT = `你是模式提炼器。下面是同一主体、同一属性的多条事实记录。判断它们是否共同构成一个**稳定的行为模式或规律**。
- 是（有规律、可预测，例如"反复变化"本身就是一种模式）→ 输出一个 JSON 对象：
  {"text": "第三人称的模式描述，不超过 100 字", "topic_tags": ["短标签"], "triples": [{"subject": "主体", "attribute": "属性", "value": "模式结论"}]}
- 不是（只是孤立事实的罗列，或互相矛盾且无规律）→ 输出 []
只输出 JSON，不要解释。`;

  /**
   * 第 7 步：pattern 提炼（P3+）—— 同域同簇的 fact ≥ 2 → LLM 提炼候选 pattern。
   * 触发：该域未消费巩固信号的加权分 ≥ signalThreshold（否则一个 LLM 调用都不发）。
   * 独立配额：`cfg.write.patternQuotaPerDay` 按本地日计，**不挤日常写入配额**。
   * 溯源：provenance.message_ids 指向参与提炼的源条目（pattern 的"原文"就是这些条目）。
   */
  async function step7PatternMining(snapshotTs) {
    if (!cfg.dream.steps.patternMining) return { skipped: 'disabled' };
    if (!llm?.complete) return { skipped: 'no-llm' };

    const { score } = pendingConsolidationScore();
    const hot = Object.entries(score)
      .filter(([, s]) => s >= cfg.dream.signalThreshold)
      .map(([d]) => d)
      .filter((d) => domains.get(d));
    if (!hot.length) return { skipped: 'below-threshold' };

    let mined = 0;
    let quotaBlocked = 0;
    const perDomain = {};

    for (const domainId of hot) {
      const domain = domains.get(domainId);
      const today = localDate(snapshotTs, cfg.storage.timezone);
      const minedToday = db.prepare("SELECT recorded_at FROM entries WHERE domain_id = ? AND entry_type = 'pattern'")
        .all(domainId)
        .map((r) => localDate(r.recorded_at, cfg.storage.timezone))
        .filter((d) => d === today).length;
      let budget = cfg.write.patternQuotaPerDay - minedToday;
      if (budget <= 0) { quotaBlocked++; continue; }

      // 簇 = 同 (subject_key, attribute) 的存活 fact ≥ 2；每轮最多看 3 个簇、每簇 1 次 LLM
      const clusters = db.prepare(`
        SELECT t.subject_key, t.attribute, COUNT(DISTINCT e.id) AS n,
               GROUP_CONCAT(DISTINCT e.id) AS ids
        FROM entry_triples t JOIN entries e ON e.id = t.entry_id
        WHERE t.domain_id = ? AND e.cold = 0 AND e.superseded_by IS NULL AND e.entry_type = 'fact'
        GROUP BY t.subject_key, t.attribute
        HAVING n >= 2
        ORDER BY n DESC, t.subject_key, t.attribute
        LIMIT 3
      `).all(domainId);

      for (const c of clusters) {
        if (budget <= 0) { quotaBlocked++; continue; }   // 配额挡住的簇要留痕，不许静默消失
        const sources = [...loadEntries(db, c.ids.split(','), { includeCold: true }).values()];
        if (sources.length < 2) continue;

        let raw;
        try {
          raw = await llm.complete({
            system: PATTERN_PROMPT,
            messages: [{
              role: 'user',
              content: `主体=${c.subject_key} 属性=${c.attribute}\n`
                + sources.map((e) => `- ${e.text}`).join('\n'),
            }],
          });
        } catch (err) {
          await audit.write('pattern-mining-failed', { domainId, error: String(err?.message ?? err) });
          continue;
        }

        let picked;
        try {
          const { parseCandidatesJson } = await import('./extract.js');
          picked = parseCandidatesJson(raw)[0];
        } catch (err) {
          await audit.write('pattern-mining-failed', { domainId, error: `parse: ${String(err?.message ?? err)}` });
          continue;
        }
        if (!picked || typeof picked !== 'object' || !String(picked.text ?? '').trim()) continue;   // LLM 说"不是模式"

        const res = await write.persistPattern({
          text: String(picked.text).trim(),
          entryType: 'pattern',
          topicTags: (Array.isArray(picked.topic_tags) ? picked.topic_tags : [])
            .filter((x) => typeof x === 'string' && x.trim()).slice(0, 5),
          triples: (Array.isArray(picked.triples) ? picked.triples : [])
            .filter((x) => x && x.subject && x.attribute && x.value).slice(0, 4),
          sourceRef: { adapter_id: domainId, locator: `pattern:${domainId}:${snapshotTs}` },
          provenance: {
            session_id: `${domainId}:dream`,
            message_ids: sources.map((e) => e.id),          // 溯源到参与提炼的源条目
            extract_task_id: `dream-pattern:${snapshotTs}`,
            model_version: llm.model ?? 'unknown',
            extracted_at: snapshotTs,
            source_content_hash: '',
          },
        }, domain);

        if (res.status === 'written') { mined++; budget--; perDomain[domainId] = (perDomain[domainId] ?? 0) + 1; }
        else if (res.status === 'quota-full') { quotaBlocked++; break; }
      }
    }
    return { hotDomains: hot, mined, quotaBlocked, perDomain };
  }

  /**
   * 第 11 步：消费巩固信号（P3+）。**只结算，不丢权重**：
   * 加权分达标的域本轮已经进过步 7；没达标的继续留着累计（consumed=0），
   * 把"攒了 4.9 分"的域清零等于让它的下一次爆发更远 —— 信号是积分制的，不是轮询制的。
   */
  /**
   * 【R-139】第 12 步：写日记 —— 给昨天写，(domain_id, date) 幂等。
   * 为什么放在 dream 而不是实时：日记要"一天结束回头看"，实时写只能写流水账；
   * 为什么幂等跳过而不重写：日记是"当时写下的"，事后重写 = 篡改记忆。
   * 全天无活动不写空日记（写一堆"（无）"是给库注水）。
   */
  async function step12Diary(snapshotTs) {
    const results = {};
    // 【R-141】每轮 dream 顺手回填原话向量（嵌入器没就绪期间的缺口）
    if (transcript?.backfillVectors) {
      try { const n = await transcript.backfillVectors(500); if (n) results.backfilled = n; } catch { /* 不挡日记 */ }
    }
    if (!diary || cfg.diary?.enabled === false) return { skipped: 'disabled' };
    for (const d of domains.list()) {
      const today = new Date(snapshotTs); today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today.getTime() - 864e5);
      const p = (n) => String(n).padStart(2, '0');
      const dateStr = `${yesterday.getFullYear()}-${p(yesterday.getMonth() + 1)}-${p(yesterday.getDate())}`;
      try {
        results[d.id] = await diary.ensure({ domainId: d.id, date: dateStr, now: snapshotTs });
      } catch (err) {
        results[d.id] = { written: false, reason: `error: ${String(err?.message ?? err).slice(0, 120)}` };
      }
    }
    return results;
  }

  function step11ConsumeSignals(snapshotTs) {
    if (!cfg.dream.steps.consolidation) return { skipped: 'disabled' };
    const { signals, score } = pendingConsolidationScore();
    if (!signals) return { consumed: 0, score: {} };

    dbTx(db, () => {
      // 【R-148】提示型信号（pending-conflict / cross-entry-conflict）不在此消费——
      // 它们是给组装层提示的（读 unconsumed），吞掉就提示不了了。conflict_accum 是巩固
      // 燃料必须照常结算——LIKE '%conflict%' 会误伤它（回归实测）。
      db.prepare("UPDATE consolidation_signals SET consumed = 1 WHERE consumed = 0 AND kind NOT IN ('pending-conflict', 'cross-entry-conflict')").run();
    });
    const hot = Object.entries(score).filter(([, s]) => s >= cfg.dream.signalThreshold).map(([d]) => d);
    return { consumed: signals, score, hot, snapshotTs };
  }

  /**
   * 【连锁记忆·步 13】共现挖边：同一 request 反复共同命中的条目对自动长 coexist 边。
   * 人的连锁记忆是"这两件事总一起被想起来，所以连上了"——这是唯一不靠预埋的连锁来源。
   * 边是派生数据（source='dream'），不进 md 真相源；rebuild 用同函数从 retrieval_log 重算。
   */
  function step13CooccurrenceLinks(snapshotTs) {
    if (!cfg.dream.steps.cooccurrenceLinks) return { skipped: 'disabled' };
    const r = mineCooccurrenceLinks(db, { ...cfg.dream.cooccurrence, now: snapshotTs });
    return { pairs: r.pairs, edges: r.edges };
  }

  /* ─────────────── R-120 L3：跨条目语义对账（步 14）─────────────── */

  const AUDIT_SYSTEM_PROMPT = `你是记忆审计员。给你同一用户的两条记忆，判断它们之间的关系。只输出一个 JSON 对象：
{"relation": "conflict | duplicate | related | unrelated", "note": "一句话说明（conflict 时必须写清两条各说了什么）"}
判定标准：
- conflict：两条对同一事实给出**互斥**的说法（如"讨厌香菜"vs"香菜还行"；时间/状态不同的"以前如此现在不如此"不算冲突，算 related）。
- duplicate：两条说的是同一件事，信息量几乎一致。
- related：相关但不互斥（补充细节、因果、阶段变化）。
- unrelated：主题无关。
拿不准就 related 或 unrelated，**宁可漏报冲突也不误报**。`;

  /**
   * 【R-120 L3 红线】发现跨条目矛盾**只允许告警**（audit 明细 + consolidation_signals 打标），
   * 绝对不允许 LLM 自动删除/覆盖任何一方——自动裁决 = 静默丢数据复发；裁决权在人与 Agent。
   * 对账范围：近 N 天新账 × 各自向量近邻（增量对账，不做全库两两——那是 O(n²) 的 LLM 账单）。
   */
  async function step14SemanticAudit(snapshotTs) {
    if (!cfg.dream.steps.semanticAudit) return { skipped: 'disabled' };
    if (!llm?.available?.()) return { skipped: 'no-llm' };
    if (!vec?.enabled) return { skipped: 'no-vec' };
    const { lookbackDays, neighbors, maxPairsPerRun } = cfg.dream.semanticAuditCfg ?? { lookbackDays: 14, neighbors: 3, maxPairsPerRun: 12 };

    const fresh = db.prepare(`
      SELECT id, domain_id, text FROM entries
      WHERE cold = 0 AND superseded_by IS NULL AND recorded_at >= ?
      ORDER BY recorded_at DESC LIMIT ?`).all(snapshotTs - lookbackDays * 864e5, maxPairsPerRun * 2);
    if (!fresh.length) return { skipped: 'no-recent-entries' };

    const seen = new Set();
    const pairs = [];
    for (const e of fresh) {
      if (pairs.length >= maxPairsPerRun) break;
      const [v] = await vec.embedTexts([e.text]);
      if (!v) continue;
      const hits = vec.search(v, e.domain_id, neighbors + 1) ?? [];
      for (const h of hits) {
        const hitId = h.id ?? h.entry_id;
        if (!hitId || hitId === e.id || seen.has(`${e.id}\u0000${hitId}`)) continue;
        const other = db.prepare('SELECT id, text FROM entries WHERE id = ? AND cold = 0 AND superseded_by IS NULL').get(hitId);
        if (!other || other.text === e.text) continue;
        seen.add(`${e.id}\u0000${hitId}`);
        seen.add(`${hitId}\u0000${e.id}`);
        pairs.push({ domainId: e.domain_id, a: e, b: other });
        if (pairs.length >= maxPairsPerRun) break;
      }
    }
    if (!pairs.length) return { skipped: 'no-candidate-pairs' };

    const results = { checked: pairs.length, conflicts: 0, duplicates: 0 };
    for (const p of pairs) {
      let out;
      try {
        const raw = await llm.complete({
          system: AUDIT_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `记忆一：${p.a.text}\n\n记忆二：${p.b.text}` }],
        });
        out = JSON.parse(String(raw).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim().replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
      } catch (err) {
        await audit.write?.('semantic-audit-failed', { error: String(err?.message ?? err).slice(0, 150) });
        continue;
      }
      if (out?.relation === 'conflict') {
        results.conflicts++;
        // R-120 红线：只告警。audit 留全文摘要，signal 打标供组装层/人工复核，库一条不动。
        await audit.write?.('cross-entry-conflict', {
          domainId: p.domainId, note: String(out.note ?? '').slice(0, 200),
          a: { id: p.a.id, text: p.a.text.slice(0, 120) },
          b: { id: p.b.id, text: p.b.text.slice(0, 120) },
        });
        write.recordConsolidationSignal?.('cross-entry-conflict', p.domainId, 1.0, {
          aId: p.a.id, bId: p.b.id, note: String(out.note ?? '').slice(0, 200),
          aText: p.a.text.slice(0, 160), bText: p.b.text.slice(0, 160),
        });
      } else if (out?.relation === 'duplicate') {
        results.duplicates++;
        await audit.write?.('cross-entry-duplicate', {
          domainId: p.domainId, note: String(out.note ?? '').slice(0, 200),
          a: { id: p.a.id }, b: { id: p.b.id },
        });
      }
    }
    return results;
  }

  async function run(opts = {}) {
    dreamCount++;
    const snapshotTs = opts.now ?? Date.now();
    const result = { snapshotTs, dream: dreamCount, steps: {} };

    result.steps.s1 = await step1GitSnapshot(snapshotTs);

    const patches = step2ComputeState(snapshotTs);
    result.steps.s2 = { candidates: patches.length, changed: patches.filter((x) => x.changed).length };

    if (cfg.dream.steps.stateSync) {
      const pendingSet = await step3SyncMarkdown(patches, snapshotTs);
      result.steps.s3 = { pending: pendingSet.size };
      result.steps.s4 = { landed: step4SyncSqlite(patches, pendingSet, snapshotTs) };
    }
    if (cfg.dream.steps.ttlCleanup) result.steps.s5 = step5TtlCleanup(snapshotTs);
    if (cfg.dream.steps.consistencyRepair) result.steps.s6 = await step6ConsistencyRepair();

    result.steps.s7 = await step7PatternMining(snapshotTs);
    result.steps.s8 = await step8ColdArchive(snapshotTs);
    result.steps.s9a = step9aFtsOptimize();

    const touched = db.prepare('SELECT DISTINCT domain_id FROM vec_shards WHERE updated_at >= ?')
      .all(snapshotTs - cfg.dream.minIntervalMs).map((r) => r.domain_id);
    result.steps.s9b = step9bReconcileShards(touched);
    result.steps.s10 = step10IdentityMetrics(snapshotTs);
    result.steps.s11 = step11ConsumeSignals(snapshotTs);
    result.steps.s12 = await step12Diary(snapshotTs);
    result.steps.s13 = step13CooccurrenceLinks(snapshotTs);   // 连锁记忆：共现长边，最后跑（用本轮最新的 retrieval_log）
    result.steps.s14 = await step14SemanticAudit(snapshotTs);   // R-120 L3：跨条目语义对账，只告警不清理

    for (const d of domains.list()) {
      const top = auditTopActivated(d.id);
      if (top.length) result.topActivated = { ...(result.topActivated ?? {}), [d.id]: top };
    }

    await audit.dream(result);
    return result;
  }

  return { run, auditTopActivated, step6ConsistencyRepair, step8ColdArchive, pendingConsolidationScore };
}

function pickStateFromMd(e) {
  return {
    persistence_init: e.persistence_init,
    persistence_at_decay: e.persistence_at_decay,
    last_decay_at: e.last_decay_at,
    gamma_multiplier: e.gamma_multiplier,
    activation_count: e.activation_count,
    last_activated_at: e.last_activated_at,
    cold: e.cold,
    trust_posterior_logit: e.trust_posterior_logit,
    superseded_by: e.superseded_by,
    supersedes: e.supersedes,
  };
}

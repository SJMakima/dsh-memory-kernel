/**
 * §9.5 派生层重建（O(总量) 的运维操作，与线上 O(热区) 无耦合 [R-64]）。
 *
 * 顺序不能反：
 *   3. entries（triples 写**原文** JSON）
 *   4. entry_triples（从 entries.triples 展开并归一化）—— 顺序反了就没有原文可展开
 *   5. FTS（bigram）+ 6. vec（dim 取自 model_meta）+ 7. 冷表
 *   8. files **整表重建**：不能只 upsert，必须删掉本次扫描未出现的 path [R-39]
 *
 * ⚠ 实测发现的一处文档缺口：`identity_scope` / `shareable` / `sensitivity` /
 * `archived_topic` 不在 Markdown 块里，重建只能按域注册信息 + 缺省值重算。
 * 因此这里对"共享身份"的条目会写 audit（`rebuild-identity-defaulted`），
 * 而不是假装 C2 覆盖了这四个字段。
 */
import { parsePartPath, domainIdOfPath } from '../pure/paths.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256, subjectKey, attributeKey } from '../pure/normalize.js';
import { tokenizeBigram } from '../pure/tokenize.js';
import { upsertEntryRow } from './entry.js';
import { readFileSafe, listMarkdownFiles, parseMarkdownFile } from '../storage/md.js';
import { dbTx, recreateVecTable } from '../storage/db.js';
import { clearVocab } from './vocab.js';
import { markFtsOptimize } from '../storage/fts-stats.js';
import { mineCooccurrenceLinks } from './links.js';
import { readTombstones } from './forget.js';

export async function rebuildAll({ db, cfg, files, vec, vecInfo, audit, domains }, { clean = true, onProgress } = {}) {
  const started = Date.now();
  // onProgress({ phase, done, total })：宿主设置页的 rebuild 进度显示用。缺省 no-op。
  const progress = (phase, done = 0, total = 0) => { try { onProgress?.({ phase, done, total }); } catch { /* 进度回调不许砸重建 */ } };
  const paths = await listMarkdownFiles(cfg.storage.root);
  progress('scan', 0, paths.length);

  // 【R-156】tombstone 感知：被遗忘的条目即使从旧快照/备份回到 md，也绝不复活。
  // 这是 forget 六位置闭环的第七道保险——"rebuild 不复活"是对老契约的反向验收。
  // 【外审 P1】扫描用 forget.js 的唯一实现：坏 tombstone 按文件名恢复 entryId
  // 照常排除（宁可多删不复活），恢复不出的进 corrupt 清单（见返回值 tombstoneCorrupt）。
  const { ids: tombstoned, corrupt: tombstoneCorrupt } = await readTombstones(cfg.storage.root, audit);
  const tombstoneHits = [];

  // 【外审】fatal corrupt = 身份冲突（JSON 与文件名各说各话）或无法恢复
  // entryId——对应条目有复活风险，rebuild 必须中止而不是"报警后继续"（遗忘不可逆原则）。
  // 此刻尚未清任何表：中止 = 原数据库完好，人工修复/删除损坏文件后可重试。
  const fatalCorrupt = tombstoneCorrupt.filter((c) => c.fatal);
  if (fatalCorrupt.length) {
    throw new Error(`tombstone 锚点异常（${fatalCorrupt.length} 个）——rebuild 中止（fail-closed）：`
      + `身份冲突或无法恢复条目 ID，已遗忘数据可能复活，请人工检查 <root>/.tombstones/ 后修复或删除损坏文件再重建。`
      + ` 涉及：${fatalCorrupt.map((c) => `${c.file}[${c.kind}]`).join(', ')}`);
  }

  // 从 0 开始：派生层整表清空（§9.5 第 9 步明说运行时的表不动，所以只清这些）
  if (clean) {
    dbTx(db, () => {
      db.exec('DELETE FROM entry_triples');
      db.exec('DELETE FROM entries');
      db.exec('DELETE FROM entries_fts');
      db.exec('DELETE FROM entries_fts_cold');
      db.exec('DELETE FROM files');
      db.exec('DELETE FROM vec_shards');
      db.exec('DELETE FROM entry_links');   // 连锁边同样重建：extract 边从 JSON 重灌、dream 边从日志重算
      if (vec.enabled) {
        try { db.exec('DELETE FROM entries_vec'); } catch { /* 表不存在（未启用 vec） */ }
      }
    });
    // 【R-137】老库可能还带着已证伪的 `INDEXED BY rescore(...)` 建表子句（R-136 的残留）。
    // 它不影响查询正确性，但会让人误以为这功能实现过。rebuild 是唯一安全的换表时机——
    // 向量反正要重灌，此刻 DROP+CREATE 不丢东西。
    if (vec.enabled && vecInfo?.hasRescoreTable) {
      recreateVecTable(db, { dim: vec.dim });
      vecInfo.hasRescoreTable = false;
      audit.write('vec-table', { event: 'rescore-clause-dropped' }).catch(() => {});
    }
  }

  const parsedFiles = [];
  const entries = [];
  for (const p of paths) {
    const info = parsePartPath(p);
    if (!info) { await audit.unknownFilePattern(p); continue; }   // 不写 files 行，索引照常完成
    const md = await readFileSafe(p);
    const list = parseMarkdownFile(md);
    parsedFiles.push({ path: p, info, sha: sha256(md), count: list.length });
    // 【R-156】tombstone 排除：命中的记数留痕，不进重建（也不假装文件干净）
    const alive = list.filter((e) => !tombstoned.has(e.id));
    if (alive.length !== list.length) tombstoneHits.push({ path: p, skipped: list.length - alive.length });
    for (const e of alive) entries.push({ e, path: p, cold: p.includes('/cold/') });
  }

  // files 表整表重建：先清后写（映射表的完整性必须以磁盘现状为准）
  dbTx(db, () => {
    db.prepare('DELETE FROM files').run();
    const ins = db.prepare(`INSERT INTO files(path, domain_id, date, part_no, sha256, last_synced)
                            VALUES (?, ?, ?, ?, ?, ?)`);
    for (const f of parsedFiles) {
      const domainId = domainIdOfPath(f.path);
      if (!domainId) { continue; }
      ins.run(f.path, domainId, f.info.date, f.info.part, f.sha, Date.now());
    }
  });

  // 3/4：entries + entry_triples（原文先、归一化后）
  const embeddings = [];
  dbTx(db, () => {
    for (let ei = 0; ei < entries.length; ei++) {
      const { e, path: p } = entries[ei];
      progress('entries', ei + 1, entries.length);
      const domain = domains.get(domainIdOfPath(p)) ?? { id: domainIdOfPath(p) };
      const full = {
        ...e,
        domain_id: domain.id,
        // 这四个字段不在 Markdown 里 → 只能按域注册信息 + 缺省重算（见文件头注释）
        identity_scope: domain.identityScope ?? e.identity_scope ?? 'domain',
        shareable: domain.shareableByDefault ?? e.shareable ?? false,
        sensitivity: domain.defaultSensitivity ?? e.sensitivity ?? 'normal',
        archived_topic: e.archived_topic ?? false,
      };
      if (full.shareable || full.identity_scope === 'shared_core') {
        audit.write('rebuild-identity-defaulted', { entryId: full.id, domainId: domain.id }).catch(() => {});
      }
      upsertEntryRow(db, full);
      db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(full.id);
      const ins = db.prepare(`INSERT INTO entry_triples(entry_id, seq, domain_id, subject_key, attribute, value)
                              VALUES (?, ?, ?, ?, ?, ?)`);
      full.triples.forEach((t, i) => {
        ins.run(full.id, i, full.domain_id, subjectKey(t.subject), attributeKey(t.attribute), t.value);
      });
    }
    // 【Fix · rebuild 向量清零，人工评审 Bug2】parseEntryBlock 不产出 embedding_pending，
    // upsertEntryRow 的 `?? 0` 会把热区全部写成 0——若本次 rebuild 时模型不可用（vec 阶段
    // 跳过或部分向量 null），补嵌扫描 `embedding_pending = 1 AND cold = 0` 永远扫不到，
    // 向量路**永久**三路降级且日志干净。修复：热区重灌后默认 pending=1（与 write 路径
    // "先落 pending 再补嵌"同语义），vec 阶段每批成功嵌入后逐条清 0（见下方 vec 段）；
    // 冷区不进向量路（设计如此），维持 0。
    db.prepare('UPDATE entries SET embedding_pending = 1 WHERE cold = 0').run();
  });

  // 4 步半：entry_links 重建 —— extract 声明边从 entries JSON 展开（对齐 entry_triples 的先例），
  // dream 共现边从 retrieval_log 重挖（派生数据可重算，md 真相源不动）
  const linksFromJson = db.prepare('SELECT id, evidence_links, recorded_at FROM entries').all();
  dbTx(db, () => {
    db.prepare("DELETE FROM entry_links WHERE source = 'extract'").run();
    const ins = db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at)
                            VALUES (?, ?, ?, 'extract', ?)`);
    for (const r of linksFromJson) {
      let links;
      try { links = JSON.parse(r.evidence_links ?? '[]'); } catch { continue; }
      if (!Array.isArray(links)) continue;
      for (const l of links) {
        if (!l || typeof l.entry_id !== 'string' || l.entry_id === r.id) continue;
        if (!['support', 'causal', 'coexist'].includes(l.type)) continue;
        ins.run(r.id, l.entry_id, l.type, r.recorded_at ?? 0);
      }
    }
  });
  const cooccur = mineCooccurrenceLinks(db, { now: started });
  audit.write('rebuild-links', { extractEntries: linksFromJson.filter((r) => (r.evidence_links ?? '[]') !== '[]').length, coexistPairs: cooccur.pairs, coexistEdges: cooccur.edges }).catch(() => {});

  // 5/7：FTS 热表 + 冷表
  progress('fts', 0, entries.length);
  dbTx(db, () => {
    db.exec('DELETE FROM entries_fts');
    db.exec('DELETE FROM entries_fts_cold');
    const insHot = db.prepare('INSERT INTO entries_fts(tokens, entry_id, domain_id) VALUES (?, ?, ?)');
    const insCold = db.prepare('INSERT INTO entries_fts_cold(tokens, entry_id, domain_id) VALUES (?, ?, ?)');
    for (const { e, path: p } of entries) {
      const tokens = tokenizeBigram(`${e.text} ${(e.topic_tags ?? []).join(' ')}`);
      const domainId = domainIdOfPath(p);
      if (p.includes('/cold/')) insCold.run(tokens, e.id, domainId);
      else insHot.run(tokens, e.id, domainId);
    }
  });

  // 6：向量（模型不可用则跳过，检索自动降级三路）
  if (vec.enabled) {
    const rows = entries.filter((x) => !x.path.includes('/cold/'));
    progress('vec', 0, rows.length);   // 最慢的阶段（逐批嵌入），进度主要看这里
    for (let i = 0; i < rows.length; i += cfg.embedding.batchSize) {
      const batch = rows.slice(i, i + cfg.embedding.batchSize);
      const vectors = await vec.embedTexts(batch.map(({ e }) => `${e.text} ${(e.topic_tags ?? []).join(' ')}`));
      dbTx(db, () => {
        batch.forEach(({ e, path: p }, j) => {
          const domainId = domainIdOfPath(p);
          const d = vec.upsert({ ...e, domain_id: domainId }, vectors[j]);
          if (vectors[j]) {
            // 【Fix · Bug2 配套】真实拿到向量才清 pending；null（模型临时不可用）保持 1，
            // 交给补嵌扫描在模型恢复后兜底——rebuild 不再把"暂时嵌不了"固化成"永远不嵌"。
            db.prepare('UPDATE entries SET embedding_pending = 0 WHERE id = ?').run(e.id);
          }
          if (d === 'inserted') {
            db.prepare(`INSERT INTO vec_shards(domain_id, vector_count, updated_at) VALUES (?, 1, ?)
                        ON CONFLICT(domain_id) DO UPDATE SET vector_count = vector_count + 1,
                        updated_at = excluded.updated_at`).run(domainId, Date.now());
          }
        });
      });
      embeddings.push(...vectors);
      progress('vec', Math.min(i + cfg.embedding.batchSize, rows.length), rows.length);
    }
    // 全量对账：重建后的计数必须与 COUNT(*) 完全一致
    const truth = new Map(db.prepare('SELECT domain_id, COUNT(*) AS n FROM entries_vec GROUP BY domain_id').all()
      .map((r) => [r.domain_id, r.n]));
    const all = new Set([...db.prepare('SELECT domain_id FROM vec_shards').all().map((r) => r.domain_id), ...truth.keys()]);
    dbTx(db, () => {
      for (const id of all) {
        db.prepare(`INSERT INTO vec_shards(domain_id, vector_count, updated_at) VALUES (?, ?, ?)
                    ON CONFLICT(domain_id) DO UPDATE SET vector_count = excluded.vector_count,
                    updated_at = excluded.updated_at`).run(id, truth.get(id) ?? 0, Date.now());
      }
    });
  }

  progress('finalize', 0, 0);
  clearVocab();   // 词表是缓存，重建后必须整体失效
  markFtsOptimize();   // FTS 是刚从头写的，删改计数窗口一并清零

  if (tombstoneHits.length) {
    audit.write('rebuild-tombstoned', { files: tombstoneHits, total: tombstoned.size }).catch(() => {});
  }
  if (tombstoneCorrupt.length) {
    // 【外审 P1】损坏 tombstone 的可见性：已按文件名恢复的照常排除；
    // 恢复不出 ID 的（unknown 条目有复活风险）在结果里醒目标记，等人工修复文件。
    audit.write('rebuild-tombstone-corrupt', { count: tombstoneCorrupt.length, items: tombstoneCorrupt }).catch(() => {});
  }

  return {
    files: parsedFiles.length,
    entries: entries.length,
    embedded: embeddings.filter(Boolean).length,
    tombstoned: tombstoneHits.reduce((a, b) => a + b.skipped, 0),
    tombstoneCorrupt,
    elapsedMs: Date.now() - started,
  };
}


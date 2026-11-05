/**
 * §9.6 路径解析 + `files` 表的读写。
 *
 * `files` 同时承担两个职责，不能只 upsert 不删差集 [R-39]：
 *   ① sha256 清单（重建 / 一致性修复的比对基准）
 *   ② **分片映射表**（`markdownPath` 的 O(1) 查表）
 * 因此"写入路径查表、重建路径扫目录"两条路径必须共用本文件的两个解析器，
 * 否则"写入进 part-03、重建只读 part-01"这种错位只在首次全量重建时才暴露。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../pure/normalize.js';
import {
  partPath, coldPath, parsePartPath, domainIdOfPath, localDate,
} from '../pure/paths.js';
import { readFileSafe, hasBlock } from './md.js';

export function createFileStore({ db, cfg, audit }) {
  const selPart = db.prepare(
    'SELECT MAX(part_no) AS p FROM files WHERE domain_id = ? AND date = ?',
  );
  const delPart = db.prepare('DELETE FROM files WHERE path = ?');
  const upsertSha = db.prepare(`
    INSERT INTO files(path, domain_id, date, part_no, sha256, last_synced)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      domain_id = excluded.domain_id, date = excluded.date,
      part_no = excluded.part_no, sha256 = excluded.sha256,
      last_synced = excluded.last_synced
  `);
  const allRows = db.prepare('SELECT * FROM files');
  const rowByPath = db.prepare('SELECT * FROM files WHERE path = ?');

  /** files 表里该 (域, 本地日) 当前的分片号；未命中返回 null。 */
  function lookupPartNo(domainId, date) {
    const row = selPart.get(domainId, date);
    return row?.p ?? null;
  }

  /**
   * 磁盘上该 (域, 本地日) 的**当前可写分片号** = 已存在的最大 part（无则 0）。
   *
   * 名字与 §10 的 `probeNextPart` 对齐，但语义要写清：它返回的是"现在该往哪个分片写"，
   * 不是"下一个空分片"。若返回 max+1，一天的第一次写入就会落到 part-01、part-00 永久缺失，
   * 而"part 0 = 未分片的单文件"是 §9.3 的路径契约。切分动作归 `writeMarkdownAtomic`
   * 在锁内判定满之后调 `nextPartPath`（max+1，单调递增）。
   *
   * 目录里的非法名（`.md.bak`、`2026-10-26 (1).md`、编辑器临时文件）**跳过并计数**，
   * 不能因为"多了一个文件"就把分片号推高 [R-50]。
   */
  async function probeWritablePart(domainId, date) {
    const dir = path.join(cfg.storage.root, 'domains', domainId);
    let files;
    try { files = await fs.readdir(dir); } catch { return 0; }
    let max = 0;
    for (const f of files) {
      const parsed = parsePartPath(f);
      if (!parsed) {
        if (f.endsWith('.md')) await audit.unknownFilePattern(`${dir}/${f}`);
        continue;
      }
      if (parsed.date === date) max = Math.max(max, parsed.part);
    }
    return max;
  }

  async function maxExistingPart(domainId, date) {
    return probeWritablePart(domainId, date);
  }

  /** 分片后 markdownPath 不再是纯函数：查表 O(1)，未命中才 readdir。 */
  async function markdownPath(entry) {
    const date = localDate(entry.recorded_at, cfg.storage.timezone);
    const known = lookupPartNo(entry.domain_id, date);
    if (known !== null) return partPath(cfg.storage.root, entry.domain_id, date, known);
    return partPath(cfg.storage.root, entry.domain_id, date, await probeWritablePart(entry.domain_id, date));
  }

  async function nextPartPath(domainId, currentPath) {
    const date = parsePartPath(currentPath)?.date;
    if (!date) return currentPath;
    const max = await maxExistingPart(domainId, date);
    return partPath(cfg.storage.root, domainId, date, max + 1);
  }

  /**
   * 【实现层澄清】`markdownPath` 只回答"新条目该往哪个分片写"。
   * 修改**已有**条目（handleUpdate / dream 状态回写 / 冷存归档）时必须先找到它现在躺在哪个分片：
   * 一个域一天可能有 part-00..part-03，`lookupPartNo` 返回的是 max，用它去改 part-00 里的条目
   * 会把同一个 id 写成第二份副本（读写分裂，且没有任何报错）。
   * 所以这里按 part 降序找 block：分片数是个位数量级，代价可接受。
   */
  async function locateEntryPath(entry) {
    const date = localDate(entry.recorded_at, cfg.storage.timezone);
    const rows = db.prepare(`SELECT path FROM files WHERE domain_id = ? AND date = ?
                             ORDER BY part_no DESC`).all(entry.domain_id, date);
    for (const r of rows) {
      const md = await readFileSafe(r.path);
      if (hasBlock(md, entry.id)) return r.path;
    }
    // files 表落后于磁盘（比如刚重建一半）→ 最后再扫一次已知分片名
    for (let part = await maxExistingPart(entry.domain_id, date); part >= 0; part--) {
      const p = partPath(cfg.storage.root, entry.domain_id, date, part);
      const md = await readFileSafe(p);
      if (hasBlock(md, entry.id)) return p;
    }
    return markdownPath(entry);
  }

  /**
   * `files.sha256` 的唯一写入口。
   * 判据是"刚刚完整写完一个文件"，全部落点：写入管线 / dream 第 3 步 / dream 第 8 步冷存移动。
   * 检索路径上顺手刷 sha 是禁止项 [R-48 第 45 条]。
   */
  async function refreshFileSha(p, content) {
    const parsed = parsePartPath(p);
    const domainId = domainIdOfPath(p);
    if (!parsed || !domainId) {
      // 不写 files 行，只留证 —— 用 `date ?? ''` 兜底会造出脏映射，随后读写分裂且无报错
      await audit.unknownFilePattern(p);
      return false;
    }
    const text = content ?? await readFileSafe(p);
    upsertSha.run(p, domainId, parsed.date, parsed.part, sha256(text), Date.now());
    return true;
  }

  async function fileShaOnDisk(p) {
    const text = await readFileSafe(p);
    return text === '' ? null : sha256(text);
  }

  return {
    lookupPartNo,
    probeWritablePart,
    markdownPath,
    locateEntryPath,
    nextPartPath,
    refreshFileSha,
    fileShaOnDisk,
    deleteFileRow: (p) => delPart.run(p),
    allFileRows: () => allRows.all(),
    fileRow: (p) => rowByPath.get(p),
    coldPathOf: (domainId, ms) => coldPath(cfg.storage.root, domainId, ms, cfg.storage.timezone),
  };
}

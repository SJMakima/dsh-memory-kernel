/**
 * 【R-156】forget —— 修正/取代/遗忘三语义闭环的最后一环。
 *
 * 现状缺口（立项理由）：修正（update）与取代（supersede）语义完整，遗忘没有闭环——
 * 删当前文件后 SQLite+FTS、向量+内存索引、entry_links、冷存、Git 历史五处残留，
 * "删库重建复活"正是"重建不丢状态"老契约的反面用。
 *
 * 本模块是 forget(entryId) 的唯一入口。**执行顺序即语义：tombstone 先行（⓪），六个位置随后一次清**：
 *   ⓪ git tombstone（root/.tombstones/<ts>-<id>.json）：**锚点步，落盘之前一个字节都不删**——
 *      中途崩溃/写失败时数据完好，重跑 forget 即可（幂等：孤儿 tombstone 无害，rebuild 只按 id 排除）；
 *      写失败直接中止并返回 forgotten:false，绝不"数据删了、防复活闸没关"（外审 P1：
 *      旧顺序先删后写 tombstone，失败还报 forgotten:true 自相矛盾）；
 *   ① md 块（真相源：removeBlock + 原子写；文件空了连文件一起删——冷存月文件尤其需要）
 *   ② SQLite 行 + FTS 热冷表（FTS5 虚拟表无外键级联：必须先删索引行再删主行）
 *   ③ 向量行 + 内存索引同步（vec.remove 内部处理 swap-remove 的 id→下标 Map）
 *   ④ entry_links 双侧（声明边与共现边一并对称删，不留悬垂边）
 *   ⑤ 冷存目录（md 块删除已覆盖；空文件 + files 行一并清）
 *   git 提交在 tombstone 落盘后做：失败只标 degraded（防复活靠 rebuild 读目录，不靠 git）；
 *   删除阶段任一步失败如实标 degraded（tombstone 已兜底防复活，残留可被 rebuild 收敛）。
 *
 * 三条红线（DESIGN-NEXT R-156 不做事项）：
 *   - 不做软删除回收站（tombstone 即是）；
 *   - 不做 LLM 自动裁决删什么（裁决权在人，R-120 同族红线）；
 *   - 不做批量遗忘（先单条跑稳）。
 *
 * 误删防护：confirm 参数必须显式等于 entryId（二次确认），否则拒绝执行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSafe, removeBlock, hasBlock, countBlocks, writeFileAtomic } from '../storage/md.js';
import { withFileLock } from '../storage/lock.js';
import { dbTx } from '../storage/db.js';

const TOMBSTONE_DIR = '.tombstones';

export function createForgetter({ db, cfg, vec, files, audit, write }) {
  /**
   * 物理删除一条记忆，六个位置一次清。
   * @param {string} entryId
   * @param {{confirmId?: string, reason?: string}} opts confirmId 必须显式等于 entryId（误删防护）
   * @returns {{forgotten: boolean, entryId, positions: object, tombstone: string|null}}
   */
  async function forget(entryId, opts = {}) {
    if (typeof entryId !== 'string' || !entryId) throw new Error('forget: entryId 必填');
    if (opts.confirmId !== entryId) {
      throw new Error(`forget: 需要二次确认——confirmId 必须等于 entryId（收到 ${JSON.stringify(opts.confirmId ?? null)}）。裁决权在人，不提供批量与自动通道。`);
    }

    const e = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
    const positions = {
      md: 'not-found', sqlite: 'not-found', vector: 'not-found',
      links: 0, coldFile: null, tombstone: null,
    };
    if (!e) {
      // 幂等：条目本来就不在（已忘过 / 从未存在）——留痕并如实返回，不假装删了
      await audit.write('forget', { event: 'not-found', entryId, reason: opts.reason ?? null });
      return { forgotten: false, entryId, positions, tombstone: null };
    }

    const domainId = e.domain_id;
    const cold = e.cold === 1;

    /* ── ⓪ tombstone 先行（锚点步：落盘之前一个字节都不删）── */
    let tombstone = null;
    try {
      const dir = path.join(cfg.storage.root, TOMBSTONE_DIR);
      await fs.mkdir(dir, { recursive: true });
      tombstone = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${entryId}.json`);
      // 【持久化确认，外审】writeFile 只到 OS 页缓存，进程崩溃/断电后可能没落盘——
      // 锚点步必须 fsync 确认真正持久，否则"确认 tombstone 持久化成功"是空话。
      const fh = await fs.open(tombstone, 'w');
      try {
        await fh.writeFile(JSON.stringify({
          entryId, domainId, forgottenAt: Date.now(), reason: opts.reason ?? null,
          textSha: require_sha(e.text),   // 只留摘要指纹，不留原文（tombstone 会进 git）
        }, null, 2), 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      // 【目录项持久化，外审】文件 fsync ≠ 目录项持久：新建文件的**名字**也要落盘，
      // 断电后 tombstone 才一定能在目录里被 rebuild 发现。承诺分级：
      //   硬承诺 = 文件内容 fsync（失败 → 整个 forget 中止，上方 catch）；
      //   尽力 = 父目录 fsync——POSIX 可对目录句柄 sync；Windows 无目录 fsync 接口
      //   （需未暴露的 FILE_FLAG_BACKUP_SEMANTICS），降级为 NTFS 元数据日志兜底，留痕不中止。
      try {
        if (process.platform === 'win32') throw new Error('win32: no dir-fsync api, NTFS journaling best-effort');
        const dfh = await fs.open(dir, 'r');
        try { await dfh.sync(); } finally { await dfh.close(); }
        positions.tombstoneDirSync = 'synced';
      } catch (dirErr) {
        positions.tombstoneDirSync = `degraded: ${String(dirErr?.message ?? dirErr).slice(0, 100)}`;
      }
      positions.tombstone = tombstone;
    } catch (err) {
      // 中止语义：tombstone 是防复活的最后闸，闸没关上就绝不动数据。
      // 此时数据完好，调用方可直接重试（幂等）。
      await audit.write('forget', { event: 'forget-aborted', entryId, stage: 'tombstone', error: String(err?.message ?? err).slice(0, 200) });
      return { forgotten: false, entryId, positions, tombstone: null, error: 'tombstone-failed' };
    }
    await commitTombstone(cfg.storage.root, tombstone);   // git 失败不中止：防复活靠 rebuild 读目录

    let degraded = false;

    /* ── ① md 真相源块 ─────────────────────────────── */
    let mdPath = null;
    let mdRemoved = false;   // md 块确认已从真相源移除（删除成功或锁下发现已被并发移除）
    let mdIoErr = null;      // 读取阶段 I/O 错误（区分 not-found 与 unverifiable，外审）
    let coldDirErr = null;   // 冷目录 readdir 失败时的 I/O 错误标记
    try { mdPath = await files.locateEntryPath({ id: entryId, domain_id: domainId, recorded_at: e.recorded_at }); } catch (e_) { mdIoErr ??= `locate: ${e_?.code ?? e_?.message ?? e_}`; mdPath = null; }
    let mdText = '';
    if (mdPath) {
      try { mdText = await readFileSafe(mdPath); } catch (e_) { mdIoErr ??= `read hot: ${e_?.code ?? e_?.message ?? e_}`; }
    }
    // 冷存条目 locateEntryPath 的兜底是热区 markdownPath（错的），冷路径单独再试一次。
    // 【Fix · 跨月冷存，人工评审 Bug1】dream 归档把冷块写进"归档时刻月"的冷文件（dream.js
    // step8 用 snapshotTs），而条目归档后 decay 还会推 last_decay_at——recorded_at 单一
    // 候选在跨月场景必然错位（此前表现为 positions.md: not-found，SQLite/FTS/向量删净而
    // md 原文永留真相源与 git）。修复：候选月按可靠性排序（last_decay_at → recorded_at →
    // persistence_at_decay），仍找不到就整冷区目录扫描（月文件个位数，hasBlock 纯字符串
    // 搜索代价可忽略）——从根上杜绝任何"月份口径不一致"导致的漏删。
    if (!mdText || !hasBlock(mdText, entryId)) {
      let coldP = null;
      const candidates = [e.last_decay_at, e.recorded_at, e.persistence_at_decay]
        .filter((ms) => Number.isFinite(ms) && ms > 0);
      for (const ms of candidates) {
        const p = files.coldPathOf(domainId, ms);
        let t = '';
        try { t = await readFileSafe(p); } catch (e_) { mdIoErr ??= `read ${p}: ${e_?.code ?? e_?.message ?? e_}`; continue; }
        if (hasBlock(t, entryId)) { coldP = p; mdText = t; break; }
      }
      if (!coldP) {
        const coldDir = path.dirname(files.coldPathOf(domainId, Date.now()));
        let names = [];
        try { names = (await fs.readdir(coldDir)).filter((f) => f.endsWith('.md')).sort(); } catch (dirErr) { names = []; coldDirErr = `readdir ${coldDir}: ${dirErr?.code ?? dirErr?.message ?? dirErr}`; }
        for (const f of names) {
          const p = path.join(coldDir, f);
          let t = '';
          try { t = await readFileSafe(p); } catch (e_) { mdIoErr ??= `read ${p}: ${e_?.code ?? e_?.message ?? e_}`; continue; }
          if (hasBlock(t, entryId)) { coldP = p; mdText = t; break; }
        }
      }
      if (coldP) mdPath = coldP;
    }
    if (mdPath && hasBlock(mdText, entryId)) {
      try {
        const after = await withFileLock(mdPath, async () => {
          const cur = await readFileSafe(mdPath);
          if (!hasBlock(cur, entryId)) return null;
          const next = removeBlock(cur, entryId);
          await writeFileAtomic(mdPath, next);
          return next;
        });
        if (after !== null) {
          positions.md = mdPath;
          mdRemoved = true;
          // 文件空了连文件一起删（冷存月文件最容易只剩一条）：files 行同步清，别留脏映射
          if (countBlocks(after) === 0) {
            await fs.rm(mdPath, { force: true }).catch(() => {});
            files.deleteFileRow?.(mdPath);
            positions.coldFile = mdPath.endsWith('/cold/') || mdPath.includes('/cold/') ? 'removed' : 'removed-empty';
          } else {
            await files.refreshFileSha(mdPath, after).catch(() => {});
          }
        } else {
          positions.md = 'lost-race';
          mdRemoved = true;   // 锁下发现块已消失（并发 forget）：终态一致（无块），不算降级
        }
      } catch (err) {
        // md 删失败不挡后续：tombstone 已兜底（rebuild 会排除），残留如实标注
        degraded = true;
        positions.md = `failed: ${String(err?.message ?? err).slice(0, 120)}`;
      }
    }

    // 【Fix · 遗忘报告诚实性（外审修正）】判定必须在删除尝试**之后**——v4.31.20
    // 把它放在删除前，positions.md 初始 'not-found' 使正常删除也被标 degraded（回归）。
    // 语义：只有走到这里 md 块仍未确认移除才算异常——
    //   'not-found'          = 全部候选与目录扫描均未命中且读路径无异常（真相源缺失本身即异常）；
    //   'unverifiable: …'    = 冷目录/文件读取发生 I/O 错误，无法确认（含权限突变场景）；
    //   'failed: …'          = 找到了块但删除失败（上方 catch 已标，不进本分支）。
    // tombstone 挡得住 rebuild 复活，但挡不住"用户以为忘了的那句话还躺在 md/git 里"——如实报告。
    if (!mdRemoved && positions.md === 'not-found') {
      degraded = true;
      const ioDetail = mdIoErr ?? coldDirErr;
      if (ioDetail) positions.md = `unverifiable: ${ioDetail}`;
      await audit.write('forget', { event: 'md-not-removed', entryId, cold, detail: String(positions.md).slice(0, 160) }).catch(() => {});
    }

    /* ── ② SQLite + FTS（先删索引行，虚拟表无级联）── */
    try {
      dbTx(db, () => {
        const had = db.prepare('SELECT 1 FROM entries WHERE id = ?').get(entryId);
        if (!had) return;
        db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(entryId);
        db.prepare('DELETE FROM entries_fts_cold WHERE entry_id = ?').run(entryId);
        db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(entryId);
        db.prepare('DELETE FROM entries WHERE id = ?').run(entryId);
        positions.sqlite = 'deleted';
      });
    } catch (err) {
      degraded = true;
      positions.sqlite = `failed: ${String(err?.message ?? err).slice(0, 120)}`;
    }

    /* ── ③ 向量行 + 内存索引 ──────────────────────── */
    if (vec?.enabled) {
      try {
        vec.remove(entryId, domainId);
        db.prepare(`UPDATE vec_shards SET vector_count = MAX(0, vector_count - 1), updated_at = ?
                    WHERE domain_id = ?`).run(Date.now(), domainId);
        positions.vector = 'removed';
      } catch (err) {
        degraded = true;
        positions.vector = `failed: ${String(err?.message ?? err).slice(0, 120)}`;
      }
    }

    /* ── ④ entry_links 双侧 ───────────────────────── */
    try {
      dbTx(db, () => {
        positions.links = db.prepare('DELETE FROM entry_links WHERE entry_id = ? OR linked_id = ?').run(entryId, entryId).changes;
      });
    } catch (err) {
      degraded = true;
      positions.links = `failed: ${String(err?.message ?? err).slice(0, 120)}`;
    }

    await audit.write('forget', {
      event: 'forgotten', entryId, domainId, cold,
      reason: opts.reason ?? null, positions, degraded,
      supersededBy: e.superseded_by ?? null,
    });
    // 派生计数（若 dream 统计过 activation 等）随行删除，无需补偿；配额不回滚（删除不是退账）。
    // degraded=true = 数据已删但某位置残留（tombstone 已兜底防复活，残留可被 rebuild 收敛）。
    return { forgotten: true, entryId, positions, tombstone, degraded };
  }

  /** tombstone 集合（rebuild 用）：id 集合 + 数量。目录不存在 = 空。
   *  【外审 P1】与 rebuild 共用 readTombstones 唯一实现——两套逻辑迟早漂移。 */
  async function tombstonedIds() {
    return (await readTombstones(cfg.storage.root, audit)).ids;
  }

  return { forget, tombstonedIds };
}

/* ── helpers ─────────────────────────────────────────── */

/**
 * 【tombstone 扫描唯一实现，外审 P1】forget 与 rebuild 共用——rebuild 原来自带
 * 一套静默吞坏文件的扫描，而它才是防复活真正消费 tombstone 的地方。
 *
 * 坏文件处理（宁可多删不复活）：
 *   ① JSON 烂但文件名完好 → 按命名格式恢复 entryId，照常进排除集（文件名是我们自己写的，
 *      `<ISO 时间>-<entryId>.json`，内容损坏名字通常还在）；
 *   ② 名字也烂、恢复不出 → 不静默：进 corrupt 清单 + audit 留痕，rebuild 结果带出，
 *      人工介入（该文件对应的未知条目存在复活风险，必须有迹可循）。
 */
export async function readTombstones(root, audit = null) {
  const dir = path.join(root, TOMBSTONE_DIR);
  const ids = new Set();
  const corrupt = [];
  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 【错误分类，外审 P1】只有 ENOENT 才是"目录不存在 = 无删除记录"；
    // EACCES/EPERM/ENOTDIR/其他 I/O 故障绝不等于"没有锚点"——吞掉异常会让 rebuild
    // 拿空集合继续清表重建，已遗忘条目复活，直接击穿 R-156 的核心承诺。
    // 调用方（rebuildAll）在清表之前调用本函数，这里抛错 = 重建中止且原数据完好。
    if (err?.code === 'ENOENT') return { ids, corrupt };
    throw err;
  }
  for (const d of dirents) {
    // 【改名绕过封堵，外审 P1】锚点识别只看内容与命名规则，**不信任扩展名**——
    // 旧逻辑 `endsWith('.json')` 让改名 .bak/.corrupt 的锚点静默跳过，防复活闸免费送人。
    // .tombstones 是内核专属目录，出现任何非锚点对象都按异常处理（fail-closed）：
    const name = d.name;
    const recovered = recoverEntryIdFromName(name);
    if (!d.isFile()) {
      // 目录 / 符号链接 / 其他：名字能恢复 ID 照常排除（宁可多删不复活）；
      // 恢复不出 = unknown 异常对象 → corrupt(fatal) → rebuild 中止，人工检查
      if (recovered) ids.add(recovered);
      const kind = d.isDirectory() ? 'directory' : (d.isSymbolicLink() ? 'symlink' : 'other');
      const fatal = !recovered;
      corrupt.push({ file: name, kind, fatal, recoveredId: recovered, error: '非普通文件，无法按锚点解析（fail-closed）' });
      audit?.write?.('tombstone-corrupt', {
        file: path.join(dir, name), kind, fatal, recoveredId: recovered,
        error: '非普通文件，无法按锚点解析（fail-closed）',
      })?.catch?.(() => {});
      continue;
    }
    const full = path.join(dir, name);
    // 【F-09 双来源身份，外审 P1】JSON entryId 与文件名恢复 ID 是两个独立来源。
    // 两边都必须过 ULID 校验（生产唯一 ID 源 newUlid）——只判非空字符串会把 "entry123"
    // 这类垃圾当锚点。**两边都在且不一致 = 有东西被篡改**（手工编辑/部分写坏/拷贝错位），
    // 绝不信任任何一方静默放行：corrupt(fatal) → rebuild 清表前中止，人工介入。
    let jsonId = null;
    try {
      const j = JSON.parse(await fs.readFile(full, 'utf8'));
      if (j && typeof j.entryId === 'string' && ULID_RE.test(j.entryId)) jsonId = j.entryId;
    } catch { /* 解析失败 → 走文件名恢复路径 */ }

    if (jsonId && recovered && jsonId !== recovered) {
      corrupt.push({
        file: name, kind: 'identity-conflict', fatal: true,
        jsonEntryId: jsonId, recoveredId: recovered,
        error: 'JSON entryId 与文件名 ULID 不一致——身份冲突，不信任任何一方（fail-closed）',
      });
      audit?.write?.('tombstone-corrupt', {
        file: full, kind: 'identity-conflict', jsonEntryId: jsonId, recoveredId: recovered,
        error: 'JSON entryId 与文件名 ULID 不一致——身份冲突（fail-closed）',
      })?.catch?.(() => {});
      continue;
    }
    if (jsonId) {
      ids.add(jsonId);   // JSON 有效且与文件名一致（或文件名无法恢复）→ 信任
      continue;
    }
    // JSON 缺失/非法/entryId 非 ULID：文件名可恢复则照常排除（宁可多删不复活）；恢复不出 → 中止
    if (recovered) {
      ids.add(recovered);
      corrupt.push({ file: name, kind: 'name-recovered', recoveredId: recovered, error: 'JSON 解析失败或 entryId 非法，按文件名恢复 ID' });
      audit?.write?.('tombstone-corrupt', {
        file: full, kind: 'name-recovered', recoveredId: recovered,
        error: 'JSON 解析失败或 entryId 非法，按文件名恢复 ID',
      })?.catch?.(() => {});
      continue;
    }
    corrupt.push({ file: name, kind: 'unrecoverable', fatal: true, recoveredId: null, error: 'JSON 解析失败或 entryId 非 ULID，且文件名无法恢复' });
    audit?.write?.('tombstone-corrupt', {
      file: full, kind: 'unrecoverable', recoveredId: null,
      error: 'JSON 解析失败或 entryId 非 ULID，且文件名无法恢复',
    })?.catch?.(() => {});
  }
  return { ids, corrupt };
}

/**
 * 从文件名恢复 entryId（外审 F-08 重写：先钉时间前缀，再独立处理 ID 与后缀）。
 * 命名 = `<ISO 时间（[:.]→-）>-<ULID>` + 任意后缀（写入时的 .json、改名附带的 .bak 等）。
 * 剥完所有后缀后，剩余部分必须是**合法 ULID**（26 位 Crockford base32——生产唯一 ID 源
 * 是 src/pure/normalize.js 的 newUlid，无第二来源，无依据不放宽）：空串、`.bak`、`.json`
 * 这类后缀残片一律 null → rebuild fail-closed 中止，绝不把垃圾当"已恢复的锚点"放行。
 */
const TOMBSTONE_TS_RE = /^(\d{4}-\d{2}-\d{2}T[\d-]+Z)-(.+)$/;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function recoverEntryIdFromName(name) {
  const m = TOMBSTONE_TS_RE.exec(name);
  if (!m) return null;
  let id = m[2];
  for (;;) {   // 剥掉尾部扩展名链（.json / .json.bak / .corrupt / …）
    const dot = id.lastIndexOf('.');
    if (dot <= 0) break;   // dot=0 说明整段都是扩展名（如 ".bak"）——没有 ID 可言
    id = id.slice(0, dot);
  }
  return ULID_RE.test(id) ? id : null;
}

function require_sha(text) {
  // 轻量 FNV 指纹就够：tombstone 只用于人查与 rebuild 排除，不做密码学用途
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/** tombstone 单独提交（历史可追溯但不复活）。非 repo / git 失败不挡遗忘本身。 */
async function commitTombstone(root, tombstone) {
  if (!tombstone) return;
  const isRepo = await fs.stat(path.join(root, '.git')).then(() => true).catch(() => false);
  if (!isRepo) return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    await run('git', ['add', '--', path.relative(root, tombstone)], { cwd: root });
    await run('git', ['-c', 'user.name=dsh-memory-kernel', '-c', 'user.email=dsh-memory-kernel@localhost',
      'commit', '-q', '-m', `forget: tombstone ${path.basename(tombstone)}`], { cwd: root });
  } catch { /* git 不可用不挡遗忘；tombstone 文件本身已在磁盘上 */ }
}

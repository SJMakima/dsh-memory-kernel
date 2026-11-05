/**
 * 【R-159】单写者部署契约 —— Memory Root 级跨进程写锁。
 *
 * 现状缺口（外审首提的真缺口）：`lock.js` 是进程内 Promise 链锁（C6 单进程成立），
 * 跨进程为零；而 `bin/dsh-memory.js` CLI 与 DSH 宿主操作同一 Memory Root 是真实场景——
 * 两个进程各持自己的 Promise 链互相不知道对方在写，md 分片可被交叉覆盖。
 *
 * 最小契约（DESIGN-NEXT R-159）：
 *   ① 锁文件 `<root>/writer.lock`，`O_EXCL` 原子创建，
 *      内容 `{rootId, pid, processStartTime, instanceId, acquiredAt, kernelVersion}`；
 *   ② 检测到锁时验证持有者存活。liveness 用 kill(pid,0)；processStartTime/instanceId
 *      随锁落盘供审计与人工排查（Windows 拿不到他进程启动时刻，存活判定取保守档：
 *      进程在 = 活，宁可拒绝写也不交叉覆盖——fail-closed 同款取舍）；
 *      ②a 不可解析锁（半写残留）**一律 fail-closed 人工恢复**——仅凭 mtime 年龄不够
 *      （持锁进程可能只是被暂停超阈值后恢复），自动接管只给"可解析且持有者已死"的锁；
 *      ②b 结构校验（rootId/pid/instanceId/时间戳）：合法 JSON 但结构无效同样 fail-closed——
 *      自动接管的条件是"结构有效且确认持有者已死"，不是"可解析且不可证明存活"；
 *   ③ stale 锁判定后可安全接管（删旧建新 + audit 留痕由调用方负责）；
 *   ④ 正常关闭 `release()` 删除锁文件；
 *   ⑤ 只读访问并行允许，写动作（rebuild/forget/dream/写入管线）必须持锁——
 *      内核侧以 `singleWriter: true` 选项启用，锁在 openDatabase 之前获取，失败即抛。
 *
 * 不做事项：跨进程分布式锁 / 多主写入 / 分布式事务（C6 红线）；锁等待队列
 * （拒绝即报错，重试是人点的事）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const LOCK_FILE = 'writer.lock';

/** 本进程的近似启动时刻（epoch ms）。同进程内恒定；PID 复用的新进程算出来必然不同。 */
export function processStartTime() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

export class WriterLockError extends Error {
  constructor(holder, root) {
    super(`Memory Root 正被另一个进程写入（单写者契约 R-159）：\n`
      + `  root: ${root}\n  持有者 pid=${holder.pid} instanceId=${holder.instanceId}`
      + ` 启动于 ${new Date(holder.processStartTime).toISOString()} acquiredAt=${new Date(holder.acquiredAt).toISOString()}\n`
      + `  若确认持有者已死（崩溃残留），删除锁文件后重试：${path.join(root, LOCK_FILE)}`);
    this.name = 'WriterLockError';
    this.holder = holder;
  }
}

/**
 * 获取写锁。返回 { acquired, stale, holder, release, lockPath }。
 * - 无锁 → acquired: true（锁文件已创建）
 * - 有锁且持有者活着 → 抛 WriterLockError（明确报错，不排队不静默）
 * - 有锁但持有者已死（进程不在 / processStartTime 不匹配 = PID 复用）→ 接管，stale: true
 * - allowShared: true 时探测到活锁不抛，返回 acquired:false + holder（只读实例用）
 */
export async function acquireWriterLock(root, {
  instanceId = crypto.randomUUID(),
  kernelVersion = 'unknown',
  processStart = processStartTime(),
  allowShared = false,
} = {}) {
  const lockPath = path.join(root, LOCK_FILE);
  const rootId = await computeRootId(root);

  for (;;) {
    const payload = JSON.stringify({
      rootId, pid: process.pid, processStartTime: processStart,
      instanceId, acquiredAt: Date.now(), kernelVersion,
    });
    let fd;
    try {
      // O_EXCL：创建即原子占位——两个进程同时抢，只有一个成功
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, payload, 'utf8');
      fs.closeSync(fd);
      return {
        acquired: true, stale: false, holder: null, lockPath,
        release: () => releaseIfOurs(lockPath, instanceId),
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;   // 目录不存在等真实错误照常抛
    }

    // 已有锁：验证持有者存活
    let holder = null;
    let unreadable = false;
    try { holder = JSON.parse(await fsp.readFile(lockPath, 'utf8')); } catch { unreadable = true; }

    if (unreadable) {
      // 【半写竞态 + 暂停恢复，外审 P1】不可解析锁**一律 fail-closed，绝不自动删除**：
      //   旧逻辑"删掉重抢"会把另一个进程刚占位、还没写完的活锁删掉（两进程同时持锁，单写者归零）；
      //   仅凭 mtime 年龄也不够——持锁进程可能只是被暂停超过阈值后恢复。
      //   自动接管只保留给**可解析且持有者已死**的锁（kill -9 崩溃残留的正常形态）；
      //   不可解析 = 半写残留，属异常状态，指向人工确认后手动删除（报错里给全路径）。
      const ghost = { pid: null, instanceId: 'unreadable-lock', processStartTime: Date.now(), acquiredAt: Date.now() };
      const err = new WriterLockError(ghost, root);
      err.message = `锁文件不可解析（半写残留，创建者可能在写入中被中断）——单写者契约拒绝接管：\n`
        + `  锁文件: ${lockPath}\n`
        + `  处置：确认没有进程在写这个 Memory Root 后，人工删除该文件再重试。\n`
        + `  （写锁文件是同步三行调用，毫秒级完成；不可解析 = 异常中断残留，宁可卡住也不赌）`;
      if (allowShared) return { acquired: false, stale: false, holder: ghost, lockPath, release: () => {} };
      throw err;
    }

    if (!validLockRecord(holder, rootId)) {
      // 结构无效：合法 JSON 但缺字段/类型不符/rootId 不匹配 → 与不可解析锁同通道，
      // fail-closed 人工恢复。绝不把它当"持有者已死"自动接管。
      const ghost = { pid: null, instanceId: 'invalid-lock-record', processStartTime: Date.now(), acquiredAt: Date.now() };
      if (allowShared) return { acquired: false, stale: false, holder: ghost, lockPath, release: () => {} };
      const err = new WriterLockError(ghost, root);
      err.message = `锁记录结构无效（合法 JSON 但字段缺失/类型不符/rootId 不匹配）——单写者契约拒绝接管：\n`
        + `  锁文件: ${lockPath}\n`
        + `  处置：确认来源后人工删除该文件再重试（rootId 是 Memory Root 路径指纹，不匹配说明锁文件被移动过）。`;
      throw err;
    }

    const alive = holderAlive(holder);
    if (alive) {
      if (allowShared) return { acquired: false, stale: false, holder, lockPath, release: () => {} };
      throw new WriterLockError(holder, root);
    }
    // stale：持有者已死（kill(pid,0) 判死）。【保守档说明】Windows 拿不到他进程启动时刻，
    // PID 复用场景无法和 processStartTime 比对——复用者会被当活锁卡住（安全方向：宁可卡住
    // 人工删锁，也不误删活锁），processStartTime 字段落盘仅供审计与人工排查。
    //
    // 【stale 接管的原子交接，外审 P1】裸 rm 有接管竞态：B、C 同时读到旧锁判死，
    // B rm 后抢到新锁，C 慢一步的 rm 删掉的是 **B 的新锁** → C 也抢到，两进程同时持锁。
    // rename 是原子的"清理权声明"：并发接管者只有一个 rename 成功（输家 ENOENT，说明旧锁
    // 已被领走，回循环重读重判）。且无论谁清了残留，**新锁的创建仍必须过 O_EXCL 这道唯一
    // 闸**——清理后到建新锁之间的锁真空窗口里第三者进来抢，wx 也只有一个成功，输家按普通
    // 活锁逻辑拒绝。任何交错下，同时持锁者至多一个。
    const staleName = `${lockPath}.stale-${instanceId}`;
    try {
      await fsp.rename(lockPath, staleName);   // 原子：成功 = 我拿到了旧锁的清理权
    } catch (err) {
      // 【错误分类，外审 P2】只有 ENOENT 才是"别的接管者已领走旧锁"→ 重读重判；
      // EACCES/EPERM/其他 I/O 错误不是接管竞态，照抛——否则会变成不报错不恢复的无限快转。
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    fsp.rm(staleName, { force: true }).catch(() => {});   // 清已归我所有的残留；失败无害（已不在锁位）
    const result = await acquireWriterLock(root, { instanceId, kernelVersion, processStart, allowShared });
    return { ...result, stale: true, previousHolder: holder };
  }
}

/**
 * 【R-159】rootId = Memory Root 物理路径指纹。锁文件换 root 拷贝会被结构校验拦下。
 * 【外审 F-03】realpath 规范化：同一物理目录经 symlink/大小写差异访问时
 * 指纹一致，减少"rootId 不匹配 → 误报人工恢复"的可用性损耗。目录不存在（首次创建）
 * 退回词义规范化——symlink 误报只发生在目录已存在时。
 */
export async function computeRootId(root) {
  const resolved = path.resolve(root);
  let canonical = resolved;
  try { canonical = await fsp.realpath(resolved); } catch { /* ENOENT 等：退回 resolved */ }
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * 【锁记录结构校验，外审 P1】合法 JSON ≠ 有效锁记录：`{}`、`{"pid":"1234"}`
 * 会被 holderAlive 判成"持有者已死"而自动接管——自动接管的实际条件不能是
 * "可解析且不可证明存活"，必须是"结构有效且确认持有者已死"。结构无效一律
 * fail-closed 人工恢复（与不可解析锁同通道）。rootId 比对顺带防"锁文件被拷去别的 root"。
 */
function validLockRecord(holder, rootId) {
  return !!holder
    && holder.rootId === rootId
    && Number.isInteger(holder.pid) && holder.pid > 0
    && typeof holder.instanceId === 'string' && holder.instanceId.length > 0
    && Number.isFinite(holder.processStartTime) && holder.processStartTime > 0
    && Number.isFinite(holder.acquiredAt) && holder.acquiredAt > 0;
}

/** 持有者存活判定。Windows 无跨进程 uptime 接口，存活比对做保守档：进程在 = 活（fail-closed：
 * 宁可误判"活"而拒绝写入，也绝不误判"死"造成两进程交叉覆盖）。PID 复用的残留锁方向相反
 * （复用者会被当活锁挡住）——安全侧卡死，人工删锁恢复，锁文件路径在报错里给全。 */
function holderAlive(holder) {
  if (!holder || typeof holder.pid !== 'number') return false;
  if (holder.pid === process.pid) return true;   // 自己（同进程重入）
  try { process.kill(holder.pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** 只删自己写的锁（instanceId 比对）；别人的锁绝不动手。
 * 【R-159.6 · 外审 P2】异常分类——释放失败绝不能伪装成正常完成（否则 closeKernel
 * 收不到错误、运维日志缺失、锁残留无信号）。分类：
 *   ① 锁文件不存在（ENOENT）→ false（预期情况：已被接管/已释放）；
 *   ② 归属非本实例 → false（别人的锁绝不动手，也与竞态接管语义一致）；
 *   ③ 读锁文件的真实 I/O 错误（EACCES 等）→ 上抛；④ 锁文件损坏不可解析 → 上抛
 *      （无法验证归属，fail-closed 绝不 rm 不可确认的文件）；
 *   ⑤ rm 的真实错误（EACCES/EPERM 等，force 只豁免 ENOENT）→ 上抛。 */
async function releaseIfOurs(lockPath, instanceId) {
  let holder;
  try {
    holder = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;   // I/O 错误 / JSON 损坏：无法确认归属，如实上抛（fail-closed）
  }
  if (holder.instanceId !== instanceId) return false;
  await fsp.rm(lockPath, { force: true });   // 真实错误直接上抛，由 closeKernel 收集报告
  return true;
}

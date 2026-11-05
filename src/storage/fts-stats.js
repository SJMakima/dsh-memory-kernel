/**
 * FTS 删除计数的进程内账本 —— dream 第 9a 步（optimize 触发条件）的唯一数据源。
 *
 * 为什么不建表：optimize 的触发条件是"本窗口 > 500 次删改 或 距上次 > 7 天"，
 * 两个数都是软状态——进程重启后计数归零，最坏情况是"重启后多 optimize 一次"，
 * 成本一次性且无害；为它建表 + 维护，比问题本身还贵。
 */

const state = { deletes: 0, lastOptimizeAt: 0 };

/** 每逢 `DELETE FROM entries_fts*` 记一笔（调用点：write.upsertFtsRow / dream 冷存移动）。 */
export function countFtsDelete(n = 1) {
  state.deletes += n;
}

/** optimize 跑完 / 全量重建（FTS 是新写的）后调用，清零重新计窗。 */
export function markFtsOptimize(now = Date.now()) {
  state.deletes = 0;
  state.lastOptimizeAt = now;
}

export function ftsStats() {
  return { ...state };
}

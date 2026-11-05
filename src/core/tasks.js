/**
 * 【R-155】任务统一视图：四类任务性质积压的只读聚合。
 * 只查不改——这里没有任何清理/重试语义（那是各表自己的 TTL 与 drain 的事）。
 * 面板消费口（dsh/client.js）与巡检 SQL 用同一份数字，不允许两套口径。
 */

/** 单表安全查询：表不存在（老库未迁移）返回空对象，面板显示 0 而不是炸。 */
function one(db, sql) {
  try {
    return db.prepare(sql).get() ?? {};
  } catch {
    return {};
  }
}

export function taskBacklog(db) {
  const pending = one(db, `SELECT COUNT(*) AS c,
         SUM(CASE WHEN reason = 'confirm' THEN 1 ELSE 0 END) AS confirm,
         MIN(enqueued_at) AS oldest
      FROM pending_candidates`);
  const embed = one(db, `SELECT COUNT(*) AS c, MIN(recorded_at) AS oldest
      FROM entries WHERE embedding_pending = 1`);
  const retr = one(db, `SELECT COUNT(*) AS c, MIN(created_at) AS oldest FROM retrieval_log`);

  const pendingTotal = pending.c ?? 0;
  const pendingConfirm = pending.confirm ?? 0;

  return {
    // 待定池（R-119 双发行为）与确认池（R-149 human-in-the-loop）分开计
    pendingUncertain: pendingTotal - pendingConfirm,
    pendingConfirm,
    pendingOldestAt: pending.oldest ?? null,
    embeddingPending: embed.c ?? 0,
    embeddingOldestAt: embed.oldest ?? null,
    retrievalLog: retr.c ?? 0,
    retrievalOldestAt: retr.oldest ?? null,
  };
}

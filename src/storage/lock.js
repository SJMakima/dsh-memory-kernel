/**
 * §10 单进程内 per-path 异步互斥。
 * C6：不引入第二进程，所以进程内 Promise 链就够 —— 但**锁单元是具体文件路径**
 * （分片场景下是 `.../part-NN.md`，不是 `.../<date>.md`），否则同域同天的两个分片会互相覆盖。
 */
const locks = new Map();

export function withFileLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // 存"永不 reject"的那条链：一次失败不能污染后续所有排队者。
  // 不做 map 回收 —— key 是文件路径，数量随"域数 × 天数"增长，量级很小；
  // 反过来"以为自己回收了、其实删掉了别人的锁"是真正的并发漏洞。
  locks.set(key, next.catch(() => {}));
  return next;
}

export const _locks = locks;

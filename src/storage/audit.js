/**
 * audit/*.log —— 所有"不抛异常但必须留痕"的降级路径都写这里（§9.3 目录约定）。
 *
 * 三条实现约束：
 *   ① **同一文件必须串行追加**。检索路径上 `Promise.all(pool.map(...))` 会并发写同一个
 *      `reread-shadow.log`，Windows 上并发 `appendFile` 会直接 EPERM（共享冲突），
 *      而 audit 写失败绝不该把检索一起带崩 —— 所以按文件排队 + 吞掉错误。
 *   ② 日志本身不能成为热点路径的一部分：调用方可以 `void audit.xxx(...)` 不等，
 *      排队链保证顺序，进程退出前 `flush()` 可以等干净。
 *   ③ 每行 `{ts, channel, payload}` 三元组——**频道名必须落进行里**。早期版本只写 payload，
 *      读取侧只能靠文件名反推频道，设置页摘要因此没法跨频道聚合（这个坑踩过两次）。
 *      读取时对没有 channel 字段的旧行按文件名归频道，旧日志不用迁移。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const TAIL_BYTES = 64 * 1024;

export function createAudit(root) {
  const dir = path.join(root, 'audit');
  let ready = null;
  const chains = new Map();

  const ensure = () => {
    ready ??= fs.mkdir(dir, { recursive: true });
    return ready;
  };

  function write(name, payload) {
    const file = path.join(dir, `${name}.log`);
    const line = `${JSON.stringify({ ts: new Date().toISOString(), channel: name, payload })}\n`;
    const prev = chains.get(file) ?? Promise.resolve();
    const next = prev
      .then(() => ensure())
      .then(() => fs.appendFile(file, line, 'utf8'))
      .catch(() => {});            // 审计失败不影响主流程
    chains.set(file, next);
    return next;
  }

  /** 从文件尾部反向读 N 字节。返回 trimmed=true 表示起点切在行中间（首行是残行，消费方应跳过）。 */
  async function readTail(file, bytes = TAIL_BYTES) {
    const fh = await fs.open(file, 'r');
    try {
      const st = await fh.stat();
      const start = Math.max(0, st.size - bytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return { text: buf.toString('utf8'), trimmed: start > 0 };
    } finally {
      await fh.close();
    }
  }

  /**
   * 只读摘要（设置页状态面板用）：tail 读 + 按频道聚合，绝不全量读。
   *
   * 【语义边界——消费方必读】
   *   - 一个频道一个文件，tail 必达**该频道文件的末尾**，所以 lastTs 永远是该频道
   *     真正的最近一次写入——"频道 A 最近一次告警被漏掉"这种事不会发生；
   *   - 但 **count 是 tail 窗口内的计数，不是历史总数**：一个几 MB 的老频道，
   *     count 只反映 64KB 窗口里的行数。需要完整历史请直接读文件；
   *   - 窗口是"文件尾部"维度，不是时间维度；windowMs 是在窗口内**再**按时间过滤。
   *
   * @param {{channels?: string[], windowMs?: number, limit?: number, tailBytes?: number}} opts
   *   channels  只看这些频道（省略 = 全部）；windowMs 只统计最近 N 毫秒；
   *   limit     每频道保留的样本条数（默认 3）；tailBytes 每文件尾部读取量（默认 64KB）。
   * @returns {Promise<Array<{channel, count, lastTs, samples}>>} 按 lastTs 新→旧排序
   */
  async function summary({ channels, windowMs, limit = 3, tailBytes = TAIL_BYTES } = {}) {
    let files;
    try { files = await fs.readdir(dir); } catch { return []; }
    const want = channels ? new Set(channels) : null;
    const now = Date.now();
    const agg = new Map();

    for (const f of files) {
      if (!f.endsWith('.log')) continue;
      const fileChannel = f.slice(0, -4);
      if (want && !want.has(fileChannel)) continue;
      let tail;
      try { tail = await readTail(path.join(dir, f), tailBytes); } catch { continue; }

      const lines = tail.text.split('\n');
      const first = tail.trimmed ? 1 : 0;   // 起点切在行中间 → 首段是残行，跳过
      for (let i = first; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }   // 残行/坏行跳过，不抛
        const channel = typeof row.channel === 'string' ? row.channel : fileChannel;
        if (want && !want.has(channel)) continue;
        if (windowMs != null) {
          const t = Date.parse(row.ts);
          if (Number.isFinite(t) && now - t > windowMs) continue;
        }
        let a = agg.get(channel);
        if (!a) { a = { channel, count: 0, lastTs: null, samples: [] }; agg.set(channel, a); }
        a.count++;
        if (a.lastTs == null || row.ts > a.lastTs) a.lastTs = row.ts;
        if (a.samples.length < limit) a.samples.push(row.payload ?? row);
      }
    }
    return [...agg.values()].sort((a, b) => String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? '')));
  }

  return {
    dir,
    partOverflow: (domainId, p) => write('part-overflow', { domainId, path: p }),
    unknownFilePattern: (p) => write('unknown-file-pattern', { path: p }),
    coldScanSlow: (o) => write('cold-scan-slow', o),
    routeScores: (o) => write('route-scores', o),
    rereadShadow: (o) => write('reread-shadow', o),
    signatureFailure: (o) => write('signature-failures', o),
    trustUpdate: (o) => write('trust-updates', o),
    identityAlert: (o) => write('identity-alerts', o),
    domainAmbiguous: (o) => write('domain-ambiguous', o),
    budgetOverflow: (o) => write('assemble-budget-overflow', o),
    assemble: (o) => write('assemble', o),
    dream: (o) => write('dream', o),
    shardDrift: (o) => write('shard-drift', o),
    indexMissing: (o) => write('index-missing', o),
    write,    // 兜底：自定义日志名
    summary,  // 只读摘要（设置页状态面板）
    flush: () => Promise.all([...chains.values()]),
  };
}

/**
 * §11 / §11.1 主线程侧的 embedding RPC 客户端。
 *
 * 四条契约，缺一条就会在真机上表现为"随机 2s 超时"：
 *   ① **warmup 用独立 timeout**（默认 10s），绝不复用 `rpcTimeoutMs`。
 *      模型加载 1–2s，用 2s 的通用超时去等，会判超时 → 判 worker 挂 → 重启 → 再加载一遍，
 *      越重启越慢，日志里还长得像 RPC bug。
 *   ② 预热**不阻塞就绪标志**：`init()` 之后 fire-and-forget，期间 `embed()` 返回 null →
 *      检索自动降级三路（`vec:not-ready`，不是错误）。
 *   ③ `ready` 只由 worker 的 ready 事件翻转；worker 崩溃/退出必须重置回 false 并重走预热。
 *      挂在进程启动上的实现在重启后仍是 true，第一条查询就会打到"模型还没加载"的 worker。
 *   ④ 普通请求超时 → 返回 null 数组（降级），不 reject 到检索路径上。
 */
import { Worker } from 'node:worker_threads';

const DEFAULT_WORKER = new URL('../workers/embedding-worker.js', import.meta.url);

export function createEmbeddingWorkerClient(opts = {}) {
  const dim = opts.dim ?? 256;
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 2000;
  const warmupTimeoutMs = opts.warmupTimeoutMs ?? 10_000;
  const onEvent = opts.onEvent ?? (() => {});

  const worker = new Worker(opts.workerPath ?? DEFAULT_WORKER, { workerData: { dim } });
  let ready = false;
  let closed = false;
  let seq = 0;
  const pending = new Map();
  let warmupPromise = null;

  function settle(id, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  worker.on('message', (msg) => settle(msg.id, msg));

  /** worker 没了：就绪位、在途请求、预热 promise 一起失效（否则 warmup() 会永远返回旧的成功值）。 */
  function dead(kind, detail) {
    ready = false;
    // 主动 close 引发的 exit 属于预期内，不清理预热 promise：close 后 warmup() 复用已完成的那个，
    // 否则会走进 terminated 线程再报一次假失败，日志里出现"关闭后预热失败"这种鬼故事。
    if (!closed) warmupPromise = null;
    for (const [id] of pending) settle(id, null);
    if (!closed && kind) onEvent({ ...detail, kind });
  }

  worker.on('error', (err) => dead('worker-error', { error: String(err?.message ?? err) }));
  worker.on('exit', (code) => dead(closed ? null : 'worker-exit', { code }));

  /** 发一条 RPC；超时或异常都返回 null（调用方按"该轮降级"处理）。 */
  function call(msg, timeoutMs, label) {
    if (closed) return Promise.resolve(null);
    const id = ++seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(id, null);
        onEvent({ kind: 'timeout', label, timeoutMs });
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        worker.postMessage({ ...msg, id });
      } catch (err) {
        // 线程已终止：postMessage 会同步抛。等同于超时，走同一条降级路径。
        settle(id, null);
        onEvent({ kind: 'post-failed', label, error: String(err?.message ?? err) });
      }
    });
  }

  async function warmup() {
    if (ready) return true;
    const t0 = Date.now();
    const r = await call({ kind: 'warmup' }, warmupTimeoutMs, 'warmup');
    if (r?.kind !== 'ready') {
      // 不重启 worker：模型可能仍在加载（连续 3 次 ready 事件都不来才按崩溃处理，交给上层的退出事件）
      onEvent({ kind: 'warmup-failed', ms: Date.now() - t0 });
      return false;
    }
    ready = true;
    onEvent({ kind: 'warmup-ok', ms: Date.now() - t0, dim: r.dim });
    return true;
  }

  async function embed(texts) {
    const list = texts ?? [];
    if (!list.length) return [];
    // 预热未完成 / 已关闭：直接降级，不重试、不计入超时统计（§18）
    if (!ready || closed) return list.map(() => null);

    const r = await call({ kind: 'batch', texts: list }, rpcTimeoutMs, 'embed');
    if (r?.kind !== 'vectors') return list.map(() => null);
    return list.map((_, i) => {
      const v = r.vectors?.[i];
      return v && v.length === dim ? v : null;
    });
  }

  return {
    dim,
    embed,
    /** 发起预热；重复调用复用同一个 promise。 */
    warmup: () => (warmupPromise ??= warmup()),
    isReady: () => ready,
    async close() {
      closed = true;
      ready = false;
      for (const [id] of pending) settle(id, null);
      await worker.terminate().catch(() => {});
    },
  };
}

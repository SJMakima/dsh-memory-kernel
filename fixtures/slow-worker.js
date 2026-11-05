/**
 * 测试替身：慢 worker。
 *   ① warmup 50ms 返回 ready   → 证明 warmup 不走通用 rpcTimeout
 *   ② batch 300ms 返回向量     → 证明普通请求超时会降级为 null，而不是把检索拖死
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  const { id, kind } = msg;
  if (kind === 'warmup') {
    setTimeout(() => parentPort.postMessage({ id, kind: 'ready', dim: msg.dim ?? 8 }), 50);
    return;
  }
  setTimeout(() => {
    parentPort.postMessage({
      id,
      kind: 'vectors',
      dim: 8,
      vectors: (msg.texts ?? []).map(() => new Float32Array(8).fill(0.5)),
    });
  }, 300);
});

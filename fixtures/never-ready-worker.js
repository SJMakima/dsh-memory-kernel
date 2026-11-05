/**
 * 测试替身：模型永远加载不完的 worker。
 *   warmup 不回任何消息 → 用来验证"预热有自己独立的超时，且超时后 ready 保持 false"。
 *   batch 正常回包 → 证明 ready=false 时 embed() 直接降级，不会去打一个没模型的线程。
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  if (msg.kind === 'warmup') return;                        // 吞掉，永不回复
  parentPort.postMessage({
    id: msg.id,
    kind: 'vectors',
    dim: 8,
    vectors: (msg.texts ?? []).map(() => new Float32Array(8).fill(1)),
  });
});

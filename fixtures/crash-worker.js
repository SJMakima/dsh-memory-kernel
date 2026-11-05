/**
 * 测试替身：先报 ready 再自杀的 worker。
 *   用来验证"就绪位只由 worker 的 ready 事件翻转，也必须由 exit/error 事件翻回去"——
 *   挂在进程启动上的实现（spawn 即 ready）在崩溃后仍返回 true，
 *   下一条查询就会打到已经不存在的线程上。
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  if (msg.kind === 'warmup') {
    parentPort.postMessage({ id: msg.id, kind: 'ready', dim: 8 });
    setTimeout(() => process.exit(1), 20);                  // 就绪后立刻崩
    return;
  }
  parentPort.postMessage({
    id: msg.id,
    kind: 'vectors',
    dim: 8,
    vectors: (msg.texts ?? []).map(() => new Float32Array(8).fill(0.25)),
  });
});

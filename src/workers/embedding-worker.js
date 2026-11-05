/**
 * embedding worker —— 模型**只在这个线程里**常驻，全进程一份（ADR-2 / 禁止项 20）。
 *
 * 为什么必须独立：主线程需要 `embed(query)` 才做向量召回，但 600MB 级模型常驻会挤爆内存
 * （主线程 + index worker 各一份逼近 1.5GB 上限），所以主线程只能通过 RPC 拿向量。
 *
 * 生产接入点：`loadModel()` 里换成真模型（bge-m3-q8 / xvita-300m-q8）。
 * 除了这个文件，`core/` 没有任何地方知道"向量是怎么来的"。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createHashEmbedder } from '../adapters/hash-embedder.js';

const dim = workerData?.dim ?? 256;
let model = null;

async function loadModel() {
  if (model) return model;
  // ── 生产替换点：这里加载真模型 ──────────────────────────────
  // const { pipeline } = await import('@xenova/transformers');
  // model = await pipeline('feature-extraction', 'Xenova/bge-m3', { quantized: true });
  // ──────────────────────────────────────────────────────────
  model = createHashEmbedder(dim);
  return model;
}

parentPort.on('message', async (msg) => {
  const { id, kind } = msg;
  const t0 = Date.now();
  try {
    if (kind === 'warmup') {
      await loadModel();
      parentPort.postMessage({ id, kind: 'ready', dim, ms: Date.now() - t0 });
      return;
    }
    if (kind !== 'batch' && kind !== 'single') {
      parentPort.postMessage({ id, kind: 'error', error: `unknown-kind:${kind}` });
      return;
    }
    const m = await loadModel();
    const texts = kind === 'single' ? [msg.text] : (msg.texts ?? []);
    const vectors = await m.embed(texts);
    // Float32Array 走结构化克隆，不需要手工转 Buffer
    parentPort.postMessage({ id, kind: 'vectors', dim, ms: Date.now() - t0, vectors });
  } catch (err) {
    parentPort.postMessage({ id, kind: 'error', error: String(err?.message ?? err) });
  }
});

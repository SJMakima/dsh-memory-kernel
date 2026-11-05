/**
 * 测试 / 演示用的**确定性哈希嵌入**——不是语义模型，不要在生产接入。
 *
 * 存在的理由：P0a 验收要求"embedding 必须真实调用"，否则 `entries_vec` + 分区键
 * 这条核心资产一条都没验到（§7）。但真实模型（600MB）不该进单测。
 * 这里用 bigram 哈希 + L2 归一化，让余弦相似度≈词面重叠，
 * 足以驱动 vec0 的写入、路径 A/B/C、以及 `classifyNovelty` 的向量兜底。
 *
 * 生产接入方式见 §11：模型只存在于 embedding worker，主线程通过 RPC 拿向量 ——
 * 把 `embed()` 换成 worker 客户端即可，本文件之外没有任何代码依赖"向量怎么来的"。
 */
import { tokenizeBigram } from '../pure/tokenize.js';

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createHashEmbedder(dim = 256) {
  function embedOne(text) {
    const v = new Float32Array(dim);
    const tokens = tokenizeBigram(text).split(' ').filter(Boolean);
    for (const t of tokens) {
      const h = fnv1a(t);
      const idx = h % dim;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      v[idx] += sign;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
  }

  // 【R-158.4】Embedder 统一契约：dim / embed(texts) / close() / health()。
  // hash 实现无外部资源，close 是显式 no-op；health 恒 ok（纯函数没有"未就绪"态）。
  return {
    dim,
    kind: 'hash',
    async embed(texts) {
      return texts.map(embedOne);
    },
    close: async () => {},
    health: () => ({ ok: true, dim, model: 'hash' }),
  };
}

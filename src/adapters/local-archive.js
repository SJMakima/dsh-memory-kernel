/**
 * P0a 的 Adapter：本地 JSONL 原始档案 + 手写候选入口。
 *
 * 两份职责严格分开（C1：原项目存储只读；§3：Adapter 不写记忆、不做检索决策）：
 *   ① `sourceReader.read(ref)` —— 只读原始档案，`locator` 必须**跨时间稳定**
 *      （用消息 ID，不用行号/字节偏移 [R-11]），且必须**本地 50ms 内**返回 [R-30]。
 *   ② 候选输入 —— P0a 用手写 `EntryCandidate`，把 `classifyNovelty` 判定链摘掉 [R-53]。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDomainId } from '../pure/normalize.js';

/**
 * 从 `<dir>/<domain>.jsonl` 读原始档案：每行 `{ id, text, at }`。
 * 读失败返回空串（回读复核按 `unavailable` 处理，不降权也不排除）。
 */
export function createLocalArchiveReader(dir) {
  const cache = new Map();

  async function load(file) {
    if (!cache.has(file)) {
      const p = path.join(dir, file);
      const text = await fs.readFile(p, 'utf8').catch(() => '');
      const rows = new Map();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o.id) rows.set(o.id, o);
        } catch { /* 坏行跳过：原始档案不是我们的真相源，不能因此中断检索 */ }
      }
      cache.set(file, rows);
    }
    return cache.get(file);
  }

  return {
    async read(ref) {
      const file = ref.locator.startsWith('msg:')
        ? `${ref.adapter_id}.jsonl`
        : ref.locator;
      const rows = await load(file);
      const id = ref.locator.replace(/^msg:/, '');
      const hit = rows.get(id);
      // 读不到 ≠ 内容对不上。抛错让 `reReadAndCheck` 走 `unavailable`（不降权、不排除）；
      // 若这里返回空串，会被判成 `evidence=0` → 条目被"抽曲解"硬规则误杀。
      if (!hit) throw new Error(`source-not-found:${ref.locator}`);
      return { text: String(hit.text ?? ''), meta: { at: hit.at, id } };
    },
  };
}

/** 最小 DomainRegistration：只填 §9.1 定义过的字段，其余走 kernel 默认值。
 *  `sourceReader` 可整体覆盖（bili/douyin 的 locator 归一化各不相同），给了它就优先于 dir。 */
export function defineDomain({
  id,
  matchSessionId,
  dir,
  sourceReader,
  trustPrior = 0.5,
  trustedSource = true,
  identityScope = 'domain',
  defaultSensitivity = 'normal',
  shareableByDefault = false,
  requireSignature = false,
  sourceReaderIsLocal = true,
}) {
  validateDomainId(id);   // 【R-158.6】双入口复用同一份校验
  return {
    id,
    matchSessionId: matchSessionId ?? ((sid) => String(sid).split(':')[0] === id || String(sid) === id),
    trustPrior,
    trustedSource,
    identityScope,
    defaultSensitivity,
    shareableByDefault,
    requireSignature,
    sourceReaderIsLocal,
    ...(sourceReader
      ? { sourceReader }
      : (dir ? { sourceReader: createLocalArchiveReader(dir) } : {})),
  };
}

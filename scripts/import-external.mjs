#!/usr/bin/env node
/**
 * 通用外部记忆导入器 —— 吃《外部记忆导入规范》(docs/external-import-spec.md) 定义的标准 JSON，
 * 走与 qq 导入完全相同的幂等/去重/写入管线。任何外部插件只要按规范导出 JSON 就能接入，
 * 无需修改本仓库代码。
 *
 *   node scripts/import-external.mjs --file <spec.json> [--dry]
 *
 * spec.json 形态：
 * {
 *   "source": "snowluma",            // 必填：来源标识（进 source_ref 与审计）
 *   "domain":  "dsh",                // 可选：目标域，默认 dsh
 *   "items": [ {                     // 必填：候选数组
 *     "text": "用户喜欢喝矿泉水",      // 必填：记忆原文（一行陈述句）
 *     "entryType": "fact",           // 可选：fact|pattern|boundary|skill，默认 fact
 *     "topicTags": ["snowluma"],     // 可选：建议首位为来源名
 *     "observedAt": "2026-10-27T10:00:00Z",  // 可选：ISO 时间，记录于 provenance（条目时间用导入时刻）
 *     "triples": [ { "subject": "用户", "attribute": "偏好", "value": "矿泉水" } ],  // 可选
 *     "locator": "snowluma:pref:42"  // 必填：来源内稳定唯一（幂等键）
 *   } ]
 * }
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const DRY = args.includes('--dry');
const specFile = flag('file', null);
if (!specFile) {
  console.error('用法：node scripts/import-external.mjs --file <spec.json> [--dry]');
  process.exit(1);
}

const spec = JSON.parse(await fs.readFile(specFile, 'utf8'));
const source = String(spec.source ?? '').trim();
if (!source) { console.error('spec.source 必填（来源标识）'); process.exit(1); }
const items = Array.isArray(spec.items) ? spec.items : [];
if (!items.length) { console.log('spec.items 为空，无事可做。'); process.exit(0); }

const ENTRY_TYPES = new Set(['fact', 'pattern', 'boundary', 'skill']);

// ── 规范校验：不合格的条目收集并跳过（不中断整批）──
const problems = [];
const candidates = [];
for (const [i, it] of items.entries()) {
  const where = `items[${i}]`;
  const text = String(it.text ?? '').trim();
  if (!text) { problems.push(`${where}: text 为空`); continue; }
  const locator = String(it.locator ?? '').trim();
  if (!locator) { problems.push(`${where}: locator 必填（幂等键）`); continue; }
  if (/\s/.test(locator)) { problems.push(`${where}: locator 不允许空白字符`); continue; }
  const entryType = ENTRY_TYPES.has(it.entryType) ? it.entryType : 'fact';
  if (it.entryType && !ENTRY_TYPES.has(it.entryType)) problems.push(`${where}: entryType "${it.entryType}" 不在白名单，已按 fact 处理`);
  const tags = Array.isArray(it.topicTags) ? it.topicTags.map(String) : [];
  const triples = Array.isArray(it.triples)
    ? it.triples.filter((tr) => tr && String(tr.subject ?? '').trim() && String(tr.attribute ?? '').trim() && String(tr.value ?? '').trim())
    : [];
  const observedAt = it.observedAt ? Date.parse(it.observedAt) : NaN;
  candidates.push({
    candidate: {
      text,
      entryType,
      topicTags: tags.length ? tags : [source],
      triples,
      sourceRef: { adapter_id: source, locator: `${source}:${locator}` },
      provenance: {
        session_id: source,
        message_ids: [`${source}:${locator}`],
        extract_task_id: `${source}-import`,
        model_version: 'external-import',
        extracted_at: Number.isFinite(observedAt) ? observedAt : Date.now(),
        source_content_hash: '',
      },
      // observedAt 记录在 provenance.extracted_at（buildEntry 的 observed_at 用导入时刻——
      // 回填历史时间需要内核侧支持，暂不提供）。
    },
    locator: `${source}:${locator}`,
  });
}
for (const p of problems) console.error(`  [跳过] ${p}`);

const root = flag('root', path.join(os.homedir(), '.dsh', 'memory-kernel-dsh'));
const domainId = String(spec.domain ?? 'dsh');

const { createKernel } = await import('../src/kernel.js');
const { defineDomain } = await import('../src/adapters/local-archive.js');

console.log(`规范校验：候选 ${candidates.length} 条（跳过 ${problems.length} 条），目标域 ${domainId}`);
if (DRY) {
  for (const { candidate, locator } of candidates) {
    console.log(`  [dry] ${locator} | ${candidate.entryType} | ${(candidate.topicTags ?? []).join(',')} | ${candidate.text}`);
  }
  process.exit(0);
}

const kernel = await createKernel({
  config: { storage: { root: path.isAbsolute(root) ? root : path.join(os.homedir(), '.dsh', root) } },
  domains: [defineDomain({ id: domainId, matchSessionId: () => true })],
  embeddingWorker: false,
  gitInit: false,
});
await kernel.init();

let imported = 0;
let skippedExisting = 0;
let rejected = 0;
for (const { candidate, locator } of candidates) {
  const dup = kernel.db.prepare('SELECT id FROM entries WHERE source_ref LIKE ? LIMIT 1').get(`%${locator}%`);
  if (dup) { skippedExisting++; continue; }
  const r = await kernel.remember(candidate).catch((e) => { console.error(`  [错误] ${locator}: ${String(e).slice(0, 100)}`); return null; });
  if (!r) { rejected++; continue; }
  imported++;
  console.log(`  + ${r.status}：${locator} | ${candidate.text}`);
}
console.log(`\n完成：新导入 ${imported}，已存在跳过 ${skippedExisting}，被拒 ${rejected}。`);
await kernel.close();

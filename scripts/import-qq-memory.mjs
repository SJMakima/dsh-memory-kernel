/**
 * 一次性导入：把 qq-bridge 的现行人物账本（state/people.json，经 qq-memory adapter v2
 * 只读解析）灌进我们内核的记忆库。幂等——locator 已存在的条目直接跳过。
 *
 *   node scripts/import-qq-memory.mjs [--people <people.json>] [--root <内核root>] [--dry]
 *
 * 默认：内核 root = ~/.dsh/memory-kernel-dsh（dsh-memory-kernel 插件的库）。
 * people 账本路径不设默认值（那是每台机器自己的 qq-bridge 布局），必须 --people 传入。
 * 写入只发生在我们自己的内核；qq 侧零改动。重复执行安全。
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

const root = flag('root', path.join(os.homedir(), '.dsh', 'memory-kernel-dsh'));
const peopleFile = flag('people', '');

if (!peopleFile || typeof peopleFile !== 'string') {
  console.error('用法：node scripts/import-qq-memory.mjs --people <qq-bridge>/state/people.json [--root <内核root>] [--dry]');
  process.exit(1);
}

const { createKernel } = await import('../src/kernel.js');
const { defineDomain } = await import('../src/adapters/local-archive.js');
const { collectQqPeopleCandidates } = await import('../src/adapters/qq-memory.js');

const { candidates, people } = await collectQqPeopleCandidates({ file: peopleFile });
console.log(`adapter 解析：人物 ${people.length} 个，候选 ${candidates.length} 条`);
for (const p of people) {
  if (p.facts.length || p.traits.length) {
    console.log(`  ${p.name}(${p.qqId})：facts ${p.facts.length} / traits ${p.traits.length}`);
  }
}

if (DRY) {
  for (const { candidate } of candidates) {
    console.log(`  [dry] ${candidate.sourceRef.locator} | ${candidate.topicTags.join(',')} | ${candidate.text}`);
  }
  process.exit(0);
}

// 幂等去重：locator 已在库里的直接跳过（source_ref 是 JSON 字符串，LIKE 匹配 locator）
const kernel = await createKernel({
  config: { storage: { root } },
  domains: [defineDomain({ id: 'dsh', matchSessionId: () => true })],
  embeddingWorker: false,
  gitInit: false,
});
await kernel.init();

let imported = 0;
let skippedExisting = 0;
for (const { candidate } of candidates) {
  const locator = candidate.sourceRef.locator;
  const dup = kernel.db.prepare(
    'SELECT id FROM entries WHERE source_ref LIKE ? LIMIT 1',
  ).get(`%${locator}%`);
  if (dup) { skippedExisting++; continue; }
  const r = await kernel.remember(candidate);
  imported++;
  console.log(`  + ${r.status}：${locator} | ${candidate.text}`);
}
console.log(`\n完成：新导入 ${imported}，已存在跳过 ${skippedExisting}。`);
const all = kernel.db.prepare("SELECT COUNT(*) c FROM entries WHERE source_ref LIKE '%qq-people:%'").get().c;
console.log(`内核中 qq-people 来源条目总数：${all}`);
await kernel.close();

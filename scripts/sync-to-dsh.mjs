/**
 * 把本仓库的内核与 DSH 适配入口同步到宿主插件目录（唯一真源 → 部署产物）。
 *
 *   node scripts/sync-to-dsh.mjs           # 同步 + 冒烟
 *   node scripts/sync-to-dsh.mjs --check   # 只校验差异，不写
 *
 * 部署目标：$DSH_HOME/plugins/dsh-memory-kernel（默认 ~/.dsh/plugins/…）。
 * 同步范围：src/**（内核）+ dsh/lib-index.js → lib/index.js（cordis 入口）+ dsh/cordis.patch.yml。
 * **不同步** node_modules（原生依赖 better-sqlite3/sqlite-vec 装在插件目录里，动它要重装）。
 *
 * 同步后需要重启 dsh web 才会加载新代码（patch 配置改动才有 HMR，源码没有）。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const target = process.env.DSH_PLUGIN_DIR ?? path.join(home, 'plugins', 'dsh-memory-kernel');

const CHECK = process.argv.includes('--check');

/** 相对项目 → 相对插件目录 的映射（键为目录/文件，值为目标路径）。 */
const mapping = [
  { from: 'src', to: 'src' },
  { from: path.join('dsh', 'lib-index.js'), to: path.join('lib', 'index.js') },
  { from: path.join('dsh', 'cordis.patch.yml'), to: 'cordis.patch.yml' },
  { from: path.join('dsh', 'client.js'), to: path.join('lib', 'client.js') },
];

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** 递归比较两棵目录树的内容差异，返回不相等的相对路径列表。 */
async function diffTree(a, b, rel = '') {
  const out = [];
  const sa = await fs.readdir(a, { withFileTypes: true });
  const sb = await fs.readdir(b).catch(() => []);
  const bNames = new Set(sb.map((d) => (typeof d === 'string' ? d : d.name)));
  for (const ent of sa) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (!bNames.has(ent.name)) { out.push(`${r}（目标缺失）`); continue; }
    const pa = path.join(a, ent.name);
    const pb = path.join(b, ent.name);
    if (ent.isDirectory()) out.push(...await diffTree(pa, pb, r));
    else {
      const [ca, cb] = await Promise.all([fs.readFile(pa), fs.readFile(pb)]);
      if (!ca.equals(cb)) out.push(`${r}（内容不同）`);
    }
  }
  return out;
}

const [srcExists, entryExists] = await Promise.all([
  exists(path.join(project, 'src', 'kernel.js')),
  exists(path.join(project, 'dsh', 'lib-index.js')),
]);
if (!srcExists || !entryExists) {
  console.error('真源缺失：src/kernel.js 或 dsh/lib-index.js 不在仓库里，先检查项目结构。');
  process.exit(1);
}

// 【外审】第三方/审计环境的可复现性：目标缺失时给出明确指引而非一串"目标缺失"——
// 解压发布包的 deploy 目录到任意位置，DSH_PLUGIN_DIR 指向它（或 DSH_HOME 指向宿主根）即可复核。
if (!await exists(target)) {
  if (CHECK) {
    console.error(`部署目标不存在：${target}`);
    console.error('审计/第三方环境：将发布包内 deploy 目录解压到任意位置，设 DSH_PLUGIN_DIR 指向它后重跑（本机宿主默认 ~/.dsh/plugins/dsh-memory-kernel）。');
    process.exit(1);
  }
  await fs.mkdir(target, { recursive: true });
}

const diffs = [];
for (const { from, to } of mapping) {
  const a = path.join(project, from);
  const b = path.join(target, to);
  if (!await exists(a)) { console.error(`源缺失：${from}`); process.exit(1); }
  if (!await exists(b)) { diffs.push(`${to}（目标缺失）`); continue; }
  const sa = await fs.stat(a);
  if (sa.isDirectory()) diffs.push(...await diffTree(a, b, to));
  else {
    const [ca, cb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    if (!ca.equals(cb)) diffs.push(`${to}（内容不同）`);
  }
}

if (diffs.length === 0) {
  console.log('✓ 部署副本与仓库一致，无需同步。');
  process.exit(0);
}
console.log(`检测到 ${diffs.length} 处差异：`);
for (const d of diffs) console.log(`  - ${d}`);

if (CHECK) {
  console.log('\n（--check 模式，未写入。去掉 --check 执行同步。）');
  process.exit(0);
}

for (const { from, to } of mapping) {
  const a = path.join(project, from);
  const b = path.join(target, to);
  await fs.mkdir(path.dirname(b), { recursive: true });
  await fs.cp(a, b, { recursive: true, force: true });
  console.log(`✓ ${from} → ${path.join(target, to).replace(/\\/g, '/')}`);
}

console.log(`
同步完成。⚠ 源码改动需要重启 dsh web 才生效（patch 配置才有 HMR）：
  1. 重启前先确认插件目录 node_modules 还在（原生依赖不随同步走）；
  2. 重启 dsh web 后看日志确认没有 "did not activate"；
  3. 内核审计落痕在 <root>/audit/dream.log（bootstrap-rebuild = 激活成功）。`);

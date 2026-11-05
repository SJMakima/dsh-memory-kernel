#!/usr/bin/env node
/**
 * 【R-152】门面边界静态断言（进 CI：npm test 的最后一环）。
 *
 * 铁律落地：适配层（src/index.js / dsh/ / bin/）一律走 kernel 的四组能力面
 * （memory / lifecycle / domains / health），不得绕过门面直达内部实现——
 * ① `kernel.db` / `.db.prepare`：读必须过闸门、写必须走管线，裸 SQL 是绕行；
 * ② `kernel.vecInfo` / `kernel.files` / `kernel.retrieve.`：内部接线不是能力面；
 * ③ `kernel.write.`：写管线本体在 memory 组（kernel.memory.write）。
 *
 * src/core/** 与 src/storage/** 不在断言范围（它们经依赖注入拿 db，是管线本身）。
 * test/** 也不在范围（边界测试有权直接打内部）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'src/index.js',
  'dsh/lib-index.js',
  'dsh/client.js',
  'bin/dsh-memory.js',
];

const RULES = [
  { re: /\bkernel\.db\b/, why: '裸 db 访问（读未经闸门 / 写未经管线）——走 kernel.health.stats() / kernel.memory.*' },
  { re: /\.db\.prepare\(/, why: '适配层手写 SQL——聚合收进 src/core/stats.js（kernel.health.stats）' },
  { re: /\bkernel\.vecInfo\b/, why: '内部接线——用 kernel.health.vec.info' },
  { re: /\bkernel\.files\b/, why: '内部接线——文件定位属写管线内部，不对外' },
  { re: /\bkernel\.retrieve\b/, why: '内部接线——检索走 kernel.memory.search' },
  { re: /\bkernel\.write\b/, why: '写管线本体在 kernel.memory.write（R-152 分组）' },
];

let failed = 0;
for (const f of FILES) {
  const p = path.join(ROOT, f);
  let text;
  try { text = await fs.readFile(p, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        failed++;
        console.error(`✗ ${f}:${i + 1}  ${rule.why}\n    ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

if (failed) {
  console.error(`\n门面边界断言失败：${failed} 处违规（R-152）。能力面只有四组：memory / lifecycle / domains / health。`);
  process.exit(1);
}
console.log('✓ 门面边界断言通过：适配层无直达内部实现的调用路径');

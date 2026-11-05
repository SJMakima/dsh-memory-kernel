#!/usr/bin/env node
/**
 * 词向量表裁剪：fastText .vec.gz → 精简 .vec（常用词 + 记忆相关词）
 *
 * 策略：fastText crawl 向量大致按词频降序排列——保留前 --top 个高频词 +
 * 【观察名单】：当前记忆库正文/标签里出现过的词（含其 1~4 字子串）+
 * 同义词典与种子表里的词。流式解压（zlib），不全量解压 4.5GB。
 *
 * 用法：
 *   node scripts/trim-lexvec.mjs --in cc.zh.300.vec.gz --out trimmed.vec --top 50000 [--db <index.db>]
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (k, d = '') => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const IN = opt('in');
const OUT = opt('out');
const TOP = Number(opt('top', '50000'));
const DB = opt('db', path.join(os.homedir(), '.dsh', 'memory-kernel-dsh', 'index.db'));

if (!IN || !OUT) { console.error('用法: --in <vec.gz> --out <trimmed.vec> [--top 50000] [--db index.db]'); process.exit(1); }

/** 观察名单：记忆库文本的 1~4 字 CJK 子串 + 拉丁/数字 token + 同义词典词 */
async function buildWatchlist() {
  const set = new Set();
  let texts = [];
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(DB, { readonly: true });
    texts = db.prepare('SELECT text, topic_tags FROM entries').all()
      .map((r) => `${r.text} ${(r.topic_tags ?? '')}`);
    db.close();
    console.log(`观察名单来源：记忆库 ${texts.length} 条`);
  } catch (e) { console.log(`记忆库读取失败（只用词典词）: ${e.message}`); }
  try {
    const syn = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.dsh', 'memory-kernel-dsh', 'query-synonyms.json'), 'utf8'));
    texts.push(syn.flat().join(' '));
  } catch { /* 无词典文件 */ }

  for (const t of texts) {
    for (const seg of String(t).match(/[\u4e00-\u9fff]+|[a-zA-Z0-9_]+/g) ?? []) {
      if (/^[\u4e00-\u9fff]+$/.test(seg)) {
        for (let i = 0; i < seg.length; i++) {
          for (let len = 1; len <= 4 && i + len <= seg.length; len++) set.add(seg.slice(i, i + len));
        }
      } else set.add(seg.toLowerCase());
    }
  }
  return set;
}

async function main() {
  console.log(`观察名单构建中…`);
  const watch = await buildWatchlist();
  console.log(`观察名单 ${watch.size} 个词`);

  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(IN).pipe(gunzip);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const kept = [];
  let dim = 0;
  let scanned = 0;
  let topDone = false;
  for await (const line of rl) {
    if (scanned === 0) { scanned++; continue; }   // 头行 "词数 维度"
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const word = line.slice(0, sp);
    if (!dim) dim = (line.length - sp - 1) > 0 ? (line.trim().split(' ').length - 1) : 0;

    if (!topDone && kept.length < TOP && word.length > 0 && !word.startsWith('#')) {
      kept.push(line);
      if (kept.length >= TOP) topDone = true;
      scanned++;
      continue;
    }
    // 高频段之外：只保留观察名单命中的词（记忆/词典相关词，不限词频）
    const probe = word.length <= 4 ? word : null;
    const hit = watch.has(word) || watch.has(word.toLowerCase()) || (probe && watch.has(probe));
    if (hit) kept.push(line);
    scanned++;
    if (scanned % 500000 === 0) console.log(`  已扫描 ${scanned / 10000} 万行，保留 ${kept.length}`);
  }

  console.log(`扫描完成：共 ${scanned} 行，保留 ${kept.length} 词（dim=${dim}）`);
  await fsp.mkdir(path.dirname(OUT), { recursive: true });
  const out = [`${kept.length} ${dim}`, ...kept].join('\n') + '\n';
  await fsp.writeFile(OUT, out, 'utf8');
  const mb = (Buffer.byteLength(out) / 1048576).toFixed(1);
  console.log(`已写出 ${OUT}（${mb} MB）`);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });

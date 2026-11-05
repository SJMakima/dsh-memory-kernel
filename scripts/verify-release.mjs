/**
 * 【发布门禁】一键验证：独立复跑全量测试 + 派生层一致性 + 可选发布包完整性。
 *
 *   node scripts/verify-release.mjs                    # 最小门禁：测试 + 一致性
 *   node scripts/verify-release.mjs dsh-kernel-vX.zip  # 追加发布包逐文件 hash 比对
 *
 * 门禁规则（任何一条不过 = 退出码 1，不得标记为安全通过）：
 *   ① 全量测试独立复跑：0 fail、0 skipped、0 todo、0 cancelled——
 *      被跳过的安全测试等于没跑，宁可红灯不可静默绿。
 *   ② 门面边界断言通过（check-facade）。
 *   ③ sync:dsh:check：源码与部署副本一致（deploy 遗漏源码修复 = 拦下）。
 *   ④ 传入 zip 时：包内逐文件 sha256 重算，与 .sha256.txt 清单逐行比对；
 *      清单末行整包指纹同时核对。清单缺失 = 失败。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const results = [];

const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/* ① 全量测试独立复跑（与 npm test 同形：node --test 默认发现；输出 TAP 解析计数） */
// 【人工评审】门禁必须可复现：默认并发下 phase1 墙钟 <200ms 断言与 root-lock 用例会随机红
//（单文件跑全绿）——门禁跑串行，牺牲时长换确定性；npm test 不变（开发期仍并发）。
const t = spawnSync(process.execPath, ['--test', '--test-concurrency=1'], {
  cwd: project,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
const tap = (t.stdout ?? '') + (t.stderr ?? '');
const num = (re) => { const m = tap.match(re); return m ? Number(m[1]) : -1; };
const pass = num(/^# pass (\d+)/m);
const fail = num(/^# fail (\d+)/m);
const skipped = num(/^# skipped (\d+)/m);
const todo = num(/^# todo (\d+)/m);
const cancelled = num(/^# cancelled (\d+)/m);
record(
  `全量测试复跑：${pass} pass`,
  pass > 0 && fail === 0,
  fail > 0 ? `${fail} fail（见上方 TAP 输出定位用例）` : '',
);
const noSkips = skipped === 0 && todo === 0 && cancelled === 0;
record(
  '无静默跳过：skipped/todo/cancelled 全 0',
  noSkips,
  noSkips ? '' : `skipped=${skipped} todo=${todo} cancelled=${cancelled}——安全测试被跳过等于没跑，门禁拒绝`,
);
if (fail > 0) {
  for (const line of tap.split('\n')) {
    if (/^not ok /.test(line)) console.error('   ' + line.trim());
  }
}

/* ② 门面边界断言 */
const facade = spawnSync(process.execPath, ['scripts/check-facade.mjs'], { cwd: project, encoding: 'utf8' });
record('门面边界断言', facade.status === 0, (facade.stdout ?? '').trim().split('\n').pop() ?? '');

/* ③ 源码/部署一致性 */
const sync = spawnSync(process.execPath, ['scripts/sync-to-dsh.mjs', '--check'], { cwd: project, encoding: 'utf8' });
record('sync:dsh:check 源码与部署一致', sync.status === 0, (sync.stdout ?? '').trim().split('\n').pop() ?? '');

/* ④ 可选：发布包逐文件 hash 比对 */
for (const zipPath of process.argv.slice(2)) {
  const abs = path.resolve(zipPath);
  const listPath = abs + '.sha256.txt';
  if (!fs.existsSync(abs)) { record(`发布包 ${path.basename(abs)}`, false, '文件不存在'); continue; }
  if (!fs.existsSync(listPath)) { record(`发布包 ${path.basename(abs)}`, false, '缺 .sha256.txt 清单，拒绝无清单发布'); continue; }

  const expected = new Map();
  for (const line of fs.readFileSync(listPath, 'utf8').split('\n').filter(Boolean)) {
    if (line.includes('(whole-archive')) continue;   // 整包指纹行单独核对，不进文件比对
    const m = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (m) expected.set(m[2].replace(/\r$/, ''), m[1]);
  }
  // 整包指纹（清单末行）
  const wholeLine = fs.readFileSync(listPath, 'utf8').split('\n').filter(Boolean).find((l) => l.includes('whole-archive'));
  let wholeOk = null;
  if (wholeLine) {
    const wm = wholeLine.match(/^([0-9a-f]{64})/);
    const actualWhole = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    wholeOk = wm && wm[1] === actualWhole;
  }

  // 包内逐文件重算（不依赖外部 unzip 库：用 python zipfile，与打包端同源）
  const py = spawnSync('python', ['-c', `
import sys, zipfile, hashlib
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    print(hashlib.sha256(z.read(info.filename)).hexdigest() + '  ' + info.filename)
`, abs], { encoding: 'utf8' });
  const actual = new Map((py.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    l = l.replace(/\r$/, '');
    const i = l.indexOf('  ');
    return [l.slice(i + 2), l.slice(0, i)];
  }));

  const missing = [], mismatch = [], extra = [];
  for (const [name, hash] of actual) {
    if (!expected.has(name)) extra.push(name);
    else if (expected.get(name) !== hash) mismatch.push(name);
  }
  for (const name of expected.keys()) if (!actual.has(name)) missing.push(name);

  const ok = missing.length === 0 && mismatch.length === 0 && extra.length === 0 && wholeOk !== false && wholeOk !== null;
  record(
    `发布包 ${path.basename(abs)}：${actual.size} 文件逐文件比对`,
    ok,
    ok ? `整包指纹 ${wholeOk ? '✓' : '未核对'}`
       : `missing=${missing.length} mismatch=${mismatch.length} extra=${extra.length} 整包指纹=${wholeOk === null ? '清单缺末行' : wholeOk ? '✓' : '✗'}`
         + [...missing.slice(0, 3).map((n) => `\n   缺 ${n}`), ...mismatch.slice(0, 3).map((n) => `\n   差 ${n}`), ...extra.slice(0, 3).map((n) => `\n   多 ${n}`)].join(''),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n门禁结论：${failed.length ? `不通过（${failed.length} 项）` : '通过'}——${results.length} 项检查，${failed.length} 项失败`);
process.exit(failed.length ? 1 : 0);

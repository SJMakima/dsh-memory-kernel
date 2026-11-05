/**
 * 【公开前整改 · 外审】eval/privacy.js 门禁回归钉子。
 *
 * 历史 bug：exit 判定读不存在的 `pass_` 字段（真字段 `passed`），`!undefined` 恒 true
 * → 隐私评测无论通过失败都以失败退出，CI 门禁等于瞎的。修法：privacyExitCode 抽成
 * 唯一判定出口 + 本文件钉死两个方向。另：security-eval.js 的 privacyEval 曾在
 * provenanceSession=null（矩阵"缺出身"行）时产 session_id:null 被 I9 拒，eval 整体
 * 跑不完——prov 已兜 `sid ?? ''`（空串 = 无宿主身份的合法 fail-closed 出身）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import url from 'node:url';

import { privacyExitCode } from '../eval/privacy.js';

const execFileP = promisify(execFile);
const here = path.dirname(url.fileURLToPath(import.meta.url));

/* ── 1. 判定函数两个方向都钉死（修的就是这个方向） ── */
test('privacyExitCode：passed=true → 0（通过必须能成功退出）', () => {
  assert.equal(privacyExitCode({ privacy: { passed: true } }), 0);
});

test('privacyExitCode：passed=false / 缺字段 / 报告空 → 1（失败必须非零）', () => {
  assert.equal(privacyExitCode({ privacy: { passed: false } }), 1);
  assert.equal(privacyExitCode({ privacy: {} }), 1);
  assert.equal(privacyExitCode({}), 1);
  assert.equal(privacyExitCode(undefined), 1);
  // 回归锚：历史错字段 pass_ 在真报告上恒 undefined，这里钉死"缺 passed = 失败"
  assert.equal(privacyExitCode({ privacy: { pass_: true } }), 1);
});

/* ── 2. 整链冒烟：真实跑一遍 npm run eval:privacy 的裸命令，必须以 0 退出 ──
 * （12 行隐私矩阵全绿时 exitCode 必须是 0——旧 bug 恰恰是全绿也退 1） */
test('eval/privacy.js 全绿冒烟：exit code = 0 且报告 12/12', { timeout: 120_000 }, async () => {
  const { stdout, code } = await execFileP(process.execPath, ['eval/privacy.js'], {
    cwd: path.resolve(here, '..'),
    timeout: 110_000,
  }).then(
    (r) => ({ stdout: r.stdout, code: r.code ?? 0 }),
    (err) => ({ stdout: err.stdout ?? '', code: err.code ?? -1 }),
  );
  assert.equal(code, 0, `隐私评测应成功退出，实际 code=${code}\n${stdout}`);
  assert.match(stdout, /隐私红线：12\/12/);
  assert.match(stdout, /隐私红线全部通过/);
});

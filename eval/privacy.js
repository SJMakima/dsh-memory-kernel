/**
 * 【R-157】CI 快跑口：只跑隐私红线，任何一项红灯 exit code 非 0（CI 直接失败）。
 * 与 v4.29 对抗测试合流成 Security Suite 的命令行入口。
 *   npm run eval:privacy
 *
 * 【公开前整改】历史 bug：exit 判定读的是不存在的 `pass_` 字段（真字段是 `passed`），
 * `!undefined` 恒 true → 无论通过失败都以失败退出。现抽出 privacyExitCode /
 * runPrivacyCli 两个可测函数，test/privacy-gate.test.js 钉死两个方向的退出码。
 */
import { privacyEval } from './security-eval.js';

/** 门禁判定（唯一出口）：passed（真字段）为真 → 0，否则 1。 */
export function privacyExitCode(report) {
  return report?.privacy?.passed ? 0 : 1;
}

/** 跑一遍隐私红线并打印人读报告；返回退出码（不直接动 process，方便测试）。 */
export async function runPrivacyCli({ log = console.log } = {}) {
  const report = {};
  await privacyEval(report);
  log(`隐私红线：${report.privacy.pass}/${report.privacy.total}`);
  for (const r of report.privacy.rows) {
    log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `（实得 visible=${r.got}，期望 ${r.expect}）`}`);
  }
  log(report.privacy.verdict);
  return privacyExitCode(report);
}

const isMain = process.argv[1] && process.argv[1].endsWith('privacy.js');
if (isMain) {
  process.exitCode = await runPrivacyCli();
}

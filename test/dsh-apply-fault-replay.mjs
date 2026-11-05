/**
 * 【R-159.2/159.4/159.5 · 真实宿主 apply 故障注入】（外审：真实 DSH apply 失败 + 竞态验收）
 *
 * 与 cordis-fiber-replay.mjs（模拟锁时序）互补：本脚本驱动**生产插件本体**
 * （dsh/lib-index.js 的 apply）+ 真实 kernel（singleWriter:true + 真实 root-lock）+ 宿主同款
 * cordis，验证完整失败链路：
 *   ① 工具注册中途抛错 → apply 失败 → cordis 失败回滚执行 effect；
 *   ② effect 清理函数返回 kernel.close() 的 Promise——cordis **等待异步关闭完成**（R-159.4）；
 *   ③ 【R-159.5-A · 外审 P1】gate 拦截锁文件删除（fsp.rm），人为把旧实例固定在
 *      "close 进行中、锁未释放"的稳定竞态窗口——窗口内新 apply 必须 WriterLockError
 *      fail-closed 拒绝、且不动旧锁；释放 gate 后旧 close 完成、锁消失、新 apply 才成功。
 *      （外审：此前场景 2 发生在 waitLockGone 之后，不构成竞态证据——已纠正。）
 *   ④ webServer 注册中途抛错走同一条 effect 回收路径。
 *
 * 运行：node test/dsh-apply-fault-replay.mjs（依赖宿主 asar 目录的 cordis，见 CORDIS_PATH）
 * 退出码 0 = 全部断言通过。事件流水即原始证据（docs/dsh-apply-fault-evidence.txt 由重定向落盘）。
 */
import fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const CORDIS = process.env.CORDIS_PATH
  ?? path.join(os.homedir(), '.dsh', 'extracted-asar', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
const { Context } = await import(pathToFileURL(CORDIS));

/* 【R-159.5-B · 外审】加载归属校验：部署副本必须与本仓库 dsh/lib-index.js 逐字节一致，
 * 否则测试结果无法归属当前代码——拒绝运行（先 npm run sync:dsh）。 */
import { fileURLToPath } from 'node:url';
const DEPLOYED = path.join(os.homedir(), '.dsh/plugins/dsh-memory-kernel/lib/index.js');
const REPO_LIB = fileURLToPath(new URL('../dsh/lib-index.js', import.meta.url));
const sha256File = async (p) => createHash('sha256').update(await fs.readFile(p)).digest('hex');
{
  const a = await sha256File(DEPLOYED);
  const b = await sha256File(REPO_LIB);
  if (a !== b) {
    console.error('✗ 部署副本与本仓库 dsh/lib-index.js hash 不一致（deployed=' + a.slice(0, 12) + ' repo=' + b.slice(0, 12) + '）——测试结果无法归属当前代码，拒绝运行。请先 npm run sync:dsh。');
    process.exit(1);
  }
  console.log('[hash] deployed == repo (' + a.slice(0, 12) + '…) — 测试归属当前代码 ✓');
}
// 生产插件本体：直接 import 部署副本（其 node_modules 里有 @deepseek-ai/schemastery 等宿主依赖；
// 部署副本由 scripts/sync-to-dsh.mjs 从本仓库同步，verify:release 门禁保证 src/deploy 一致）
const DSH_APPLY = pathToFileURL(DEPLOYED);
const dsh = await import(DSH_APPLY.href);

const events = [];
const mark = (event, detail = '') => { events.push({ t: performance.now(), event, detail }); console.log(`[${events.length}] ${event}${detail ? ' — ' + detail : ''}`); };
const lockPathOf = (root) => path.join(root, 'writer.lock');
const lockExists = async (root) => { try { await fs.access(lockPathOf(root)); return true; } catch { return false; } };

/* ── gate：拦截锁文件删除，制造"close 进行中、锁未释放"的稳定竞态窗口（R-159.5-A）──
 * root-lock 的 releaseIfOurs 用 fsp.rm(lockPath) 释放锁（同进程 ESM 共享同一 fs/promises
 * default 对象，patch 可见）。gate 只对精确匹配的 lockPath 生效：close 走到锁释放这一步时
 * 挂起，settle 标志 = 旧 close 已阻塞在"最后一步"。 */
const makeLockGate = (rootDir) => {
  const lockPath = lockPathOf(rootDir);
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const state = { engaged: false, released: false };
  const origRm = fsp.rm.bind(fsp);
  fsp.rm = async (target, opts) => {
    if (String(target) === lockPath && !state.released) {
      state.engaged = true;                       // 旧 close 已走到锁释放前一刻
      await gate;
      state.released = true;
    }
    return origRm(target, opts);
  };
  return { state, release: () => releaseGate(), uninstall: () => { fsp.rm = origRm; } };
};

/* 可注入的服务桩：failTools = true 时 ctx.tools.register 即抛（模拟工具注册中途失败） */
let failTools = true;
let failWebServer = false;
const services = {
  tools: {
    register(def) {
      if (failTools) throw new Error('injected: tools.register failed mid-apply');
      return () => {};
    },
  },
  webServer: { register() {
    if (failWebServer) throw new Error('injected: webServer.register failed mid-apply');
    return () => {};
  } },
  sessions: {},
  sessionProjections: {},
  sessionQuery: { listSessions: async () => [] },
  llm: {},
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-fault-'));
const config = { root, plugin: { enabled: true }, embedding: { backend: 'hash' } };

// 生产插件本体（dsh/lib-index.js 具名导出）包一层——不带 Config，跳过 cordis 配置校验
const makePlugin = (tag) => ({
  name: `dsh-memory-kernel:${tag}`,
  inject: dsh.inject,
  apply: (ctx) => dsh.apply(ctx, config),   // 固定 config：root 指向本测试的临时目录（绝不碰生产 root）
});

const host = new Context();
for (const [name, value] of Object.entries(services)) host.provide(name, value);
const waitLockGone = async (rootDir, timeoutMs = 5000) => {
  const start = Date.now();
  while (await lockExists(rootDir)) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout：锁未在时限内释放');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const waitFor = async (pred, what, timeoutMs = 15000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout：' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/* ── 场景 1【R-159.5-A · 真竞态】：工具注册抛错 → effect close 被锁在"锁释放前一步" →
 *      竞态窗口内新 apply 必须 fail-closed → 释放 gate 后才可拿锁 ── */
mark('scenario1: gated race — old close blocked at lock release, new apply fired into the window');
failTools = true;
const lockGate = makeLockGate(root);
try {
  const fiber1 = host.plugin(makePlugin('fault'));
  // 不 await fiber1：close 挂在 gate 上时 fiber1 不会落定——这本身就是"cordis 等待异步
  // close 完成"（R-159.4）的直接证据（等待完成后再补第二条断言）。
  await waitFor(() => lockGate.state.engaged, 'effect close 未在时限内走到锁释放（gate 未 engage）');
  mark('gate:engaged', '旧 close 已阻塞在锁释放前一步——竞态窗口打开');
  if (!(await lockExists(root))) { console.error('✗ gate 已挂但锁竟不存在——窗口前提不成立'); process.exit(1); }
  mark('window:lock-held', '竞态窗口内锁仍被旧实例持有');

  // 窗口内发起新 apply：必须被 root-lock fail-closed 明确拒绝（绝不静默双写）
  failTools = false;
  let rejected = null;
  try {
    await host.plugin(makePlugin('race-into-window'));
    console.error('✗ 竞态窗口内新 apply 居然成功——单写者契约违约（双写窗口！）'); process.exit(1);
  } catch (e) {
    if (!/单写者|WriterLock/i.test(String(e?.message ?? e))) {
      console.error('✗ 窗口内失败但原因不是单写者契约：', String(e?.message ?? e).slice(0, 100)); process.exit(1);
    }
    rejected = e;
  }
  mark('race:rejected-in-window', '新 apply 被拒：' + String(rejected.message).slice(0, 60));
  if (!(await lockExists(root))) { console.error('✗ 新实例被拒后旧锁竟消失——拒绝路径动了旧锁'); process.exit(1); }
  mark('window:old-lock-untouched', '被拒路径未动旧锁（fail-closed 无副作用）');

  // 【R-159.4 强断言 · 外审】释放 gate **之前**：fiber1 必须保持未落定——
  // 若 cordis 不等待 effect 的异步 close，fiber1 早已 settle，此处 150ms 竞速必返回 true。
  // 这是"cordis 等待被 gate 阻塞的异步 close"的直接可证伪断言（外审上版缺此条）。
  const settledBeforeRelease = await Promise.race([
    Promise.resolve(fiber1).then(() => true, () => true),
    new Promise((r) => setTimeout(() => r(false), 150)),
  ]);
  if (settledBeforeRelease) {
    console.error('✗ fiber1 在异步 close 完成前已经 settle——cordis 未等待 effect 清理（R-159.4 违约）');
    process.exit(1);
  }
  mark('wait:fiber1-pending-before-release', 'gate 阻塞期间 fiber1 保持未落定——cordis 等待异步 close 的强断言通过');

  // 释放 gate → 旧 close 完成最后一步（锁删除）→ fiber1 落定（cordis 等到了异步 close）
  lockGate.release();
  try { await fiber1; } catch { /* apply 错误可能被 cordis 静默或冒泡——两种都合法 */ }
  await waitLockGone(root);
  mark('gate:released-close-done', 'gate 释放 → 旧 close 完成 → 锁消失；await fiber1 落定 = cordis 确实等待了被 gate 阻塞的异步 close（R-159.4 直接证据）');

  // 窗口关闭后新 apply 成功
  const fiber3 = host.plugin(makePlugin('recovery'));
  await fiber3;
  mark('apply:recovered-after-window', '窗口关闭后同 root 重新 apply 成功');
  if (!(await lockExists(root))) { console.error('✗ 存活实例运行中应有锁'); process.exit(1); }

  /* ── 场景 2：webServer 注册中途抛错——走同一条 effect 回收路径（外审问题 C）── */
  mark('scenario2: apply with webServer.register failure');
  const fiber3ref = fiber3;
  try { await fiber3ref.dispose?.(); } catch (e) { mark('scenario2: dispose threw', String(e?.message ?? e).slice(0, 80)); }
  await waitLockGone(root);
  failWebServer = true;
  const fiber4 = host.plugin(makePlugin('webfault'));
  try { await fiber4; mark('webfault:fiber-settled-no-throw'); }
  catch (e) { mark('webfault:fiber-rejected', String(e?.message ?? e).slice(0, 80)); }
  await waitLockGone(root);
  mark('lock:released-after-webfault', 'webServer 失败同样经 effect 完整回收');
  failWebServer = false;
} finally {
  lockGate.uninstall();   // 恢复 fsp.rm，绝不把 patch 泄漏给后续场景
}

/* ── 收尾：全部实例已收，锁必须全释放 ── */
mark('final:lock-released');
if (await lockExists(root)) { console.error('✗ 最终收尾后锁残留'); process.exit(1); }

console.log('\n结论：通过——竞态窗口（旧 close 阻塞在锁释放）内新 apply 被 root-lock fail-closed 拒绝且不动旧锁；gate 释放后旧 close 完成、cordis 落定、新 apply 成功；webServer 失败同路径回收；最终不遗留持锁者。');
process.exit(0);

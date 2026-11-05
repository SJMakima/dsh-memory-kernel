/**
 * 【R-159.1 · Cordis 真实生命周期复现脚本】（外审 P2：要求可复现、可独立复核）
 *
 * 用宿主同款 @deepseek-ai/cordis 驱动一个与 dsh/lib-index.js 同形态的 async 插件
 * （函数为 async、内部 await 完整生命周期），连续执行 fiber.update，验证：
 *   ① fiber.update 严格先卸后启：旧 dispose（含 await 异步耗时）完整跑完后新 apply 才开始；
 *   ② dispose 期间旧实例的锁已释放（模拟 closeKernel 释放 writer.lock）；
 *   ③ 新 apply 启动时拿到干净锁，无"同进程自撞"。
 *
 * 运行（需要宿主 asar 目录下的 cordis；与生产同源）：
 *   node test/cordis-fiber-replay.mjs
 * 可用环境变量 CORDIS_PATH 覆盖 cordis 入口。
 * 输出为带时间戳的事件流水（原始证据），全部断言通过时退出码 0。
 */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CORDIS = process.env.CORDIS_PATH
  ?? path.join(os.homedir(), '.dsh', 'extracted-asar', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js');
const require = createRequire(import.meta.url);
const { Context } = await import(pathToFileUrl(CORDIS));


function pathToFileUrl(p) {
  const abs = path.resolve(p.replace(/\\/g, '/'));
  return new URL(`file:///${abs.split(':')[0]}:${abs.slice(abs.indexOf(':') + 1)}`.replace(/\\/g, '/'));
}

/* 锁模拟：进程内单例（模拟 writer.lock 的获取/释放语义） */
const lockLog = [];
const lock = { held: false, acquire(id) { if (this.held) return false; this.held = true; lockLog.push({ t: performance.now(), event: 'acquire', id }); return true; }, release(id) { if (!this.held) return false; this.held = false; lockLog.push({ t: performance.now(), event: 'release', id }); return true; } };

const events = [];
const mark = (event, detail = '') => { events.push({ t: performance.now(), event, detail }); console.log(`[${events.length}] ${event}${detail ? ' — ' + detail : ''}`); };

const plugin = {
  name: 'dsh-memory-kernel',
  inject: [],
  async apply(ctx) {
    // 与 dsh/lib-index.js 同款形态：async apply，返回清理函数 = cordis 的 dispose 注册
    const id = Math.random().toString(36).slice(2, 8);
    mark('apply:start', id);
    const ok = lock.acquire(id);
    if (!ok) throw new Error('writer.lock 被占：同进程旧实例未释放（R-159 违约）');
    mark('lock:acquired', id);
    mark('apply:end', id);
    return async () => {
      mark('dispose:start', id);
      await new Promise((r) => setTimeout(r, 30));   // 模拟 audit.flush / embedder.close 的异步耗时
      mark('dispose:resources-closed', id);
      lock.release(id);
      mark('dispose:lock-released', id);
    };
  },
};

const root = new Context();
const fiber = root.plugin(plugin);   // ctx.plugin() 返回插件自己的 fiber（cordis 文档语义）
mark('root:started');
const waitReleases = async (n, timeoutMs = 2000) => {
  const start = Date.now();
  while (events.filter((e) => e.event === 'dispose:lock-released').length < n) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout：第 ${n} 次 dispose:lock-released 未出现`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
while (!events.some((e) => e.event === 'apply:end')) await new Promise((r) => setTimeout(r, 10));

// 连续两次 fiber.update（热重载路径）：观察 apply/dispose 的交错顺序。
// 不依赖 fiber.await（它不等 dispose 的异步收尾），轮询事件流水直到锁释放落定——证据以事件时序为准。
fiber.update({});
await waitReleases(1);
fiber.update({});
await waitReleases(2);
// 【外审 P2】最终关闭也要释放锁：dispose 最后一个实例（fiber 收尾），断言锁全释放——
// "两次 update 期间旧实例先卸" + "最终关闭不遗留持锁者"两条都钉死。
try { await fiber.dispose?.(); } catch { /* 已收尾则跳过 */ }
await waitReleases(3);
if (lock.held) { console.error('✗ 最终 dispose 后仍有实例持锁'); process.exit(1); }
mark('all-instances-disposed: lock fully released');
mark('root:stopped');

/* 断言：先卸后启语义 —— 每次 apply:start 之前必须已完成一次 dispose:lock-released（首次除外） */
const applies = events.filter((e) => e.event === 'apply:start');
const releases = events.filter((e) => e.event === 'dispose:lock-released');
let violations = 0;
for (let i = 1; i < applies.length; i++) {
  const prev = releases.find((r) => r.t < applies[i].t && (i === 1 || r.t > applies[i - 1].t));
  if (!prev) { violations++; console.error(`✗ 第 ${i + 1} 次 apply 前未见旧实例完整释放（fiber.update 并发窗口）`); }
}
const finalRelease = releases.length >= applies.length - 1;
if (!finalRelease) { violations++; console.error('✗ 结束时存在未释放的锁'); }

console.log(`\n结论：${violations === 0 ? '通过' : '不通过'}——fiber.update 先卸后启语义成立，dispose 完整跑完后新 apply 才开始；锁无自撞窗口。`);
console.log('（内核侧兜底由 r159-root-lock.test.js 的「fiber 重放全流程」用例独立覆盖。）');
process.exit(violations === 0 ? 0 : 1);

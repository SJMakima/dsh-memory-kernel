/**
 * §11.1 embedding worker 的四条契约，逐条验收。
 *
 * 这里全部用测试替身（fixtures/），不碰真模型：真模型只会让这些断言变得随机。
 * 每条契约对应一个真实的故障现场，文件名就是现场：
 *   slow-worker        —— 预热 50ms / 推理 300ms（模型加载只发生一次，比单条推理慢得多）
 *   never-ready-worker —— 模型永远加载不完（首次下载权重、显存不足、路径写错）
 *   crash-worker       —— 加载成功但随后 OOM 退出
 *
 * 四条契约：
 *   ① warmup 用独立 timeout，不被 rpcTimeoutMs 误伤；
 *   ② 预热不阻塞就绪标志，未就绪时 embed 降级返回 null；
 *   ③ ready 只由 ready 事件翻转，且必须由 exit/error 翻回去；
 *   ④ 普通请求超时 → null 数组（降级），不 reject 到检索路径上。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createEmbeddingWorkerClient } from '../src/core/embedding-client.js';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';

const slowWorker = new URL('../fixtures/slow-worker.js', import.meta.url);
const neverWorker = new URL('../fixtures/never-ready-worker.js', import.meta.url);
const crashWorker = new URL('../fixtures/crash-worker.js', import.meta.url);

function clientWith(path, opts = {}) {
  const events = [];
  const c = createEmbeddingWorkerClient({
    dim: 8,
    workerPath: path,
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { c, events };
}

test('① 预热走独立超时：50ms 的 warmup 不会被 20ms 的 rpcTimeout 判死', async (t) => {
  const { c, events } = clientWith(slowWorker, { rpcTimeoutMs: 20, warmupTimeoutMs: 1000 });
  t.after(() => c.close());

  const t0 = Date.now();
  assert.equal(await c.warmup(), true, '通用超时 20ms 若被复用，这里必然失败');
  assert.equal(c.isReady(), true);
  assert.ok(Date.now() - t0 >= 40, 'warmup 确实用了 ~50ms，说明是真的在等模型');

  const ok = events.find((e) => e.kind === 'warmup-ok');
  assert.ok(ok, '应发出 warmup-ok 事件');
  assert.equal(ok.dim, 8);
  assert.ok(ok.ms >= 40 && ok.ms < 1000, 'warmup 计时落在独立超时窗内');
});

test('④ 推理超时降级为 null，且不把就绪位一起拽下去', async (t) => {
  const { c, events } = clientWith(slowWorker, { rpcTimeoutMs: 30, warmupTimeoutMs: 1000 });
  t.after(() => c.close());

  assert.equal(await c.warmup(), true);

  const out = await c.embed(['你好', '世界']);
  assert.equal(out.length, 2, '返回数组必须与输入等长，否则上层 zip 会错位');
  assert.deepEqual(out, [null, null], '超时是降级（null），不是抛异常');

  const to = events.filter((e) => e.kind === 'timeout');
  assert.equal(to.length, 1, '一条请求只计一次超时');
  assert.equal(to[0].label, 'embed');
  assert.equal(c.isReady(), true, '单条超时不该把整个向量路判死');
});

test('② 未就绪时 embed 直接降级，不去打一个还没有模型的线程', async (t) => {
  const { c, events } = clientWith(neverWorker, { rpcTimeoutMs: 200, warmupTimeoutMs: 120 });
  t.after(() => c.close());

  const t0 = Date.now();
  assert.equal(await c.warmup(), false, '预热超时必须显式失败，不能假装就绪');
  assert.ok(Date.now() - t0 < 400, '超时就是超时，不该等到天荒地老');
  assert.equal(c.isReady(), false);

  assert.deepEqual(
    await c.embed(['a', 'b']),
    [null, null],
    'ready=false 时短路返回，不占用 RPC 槽位（下面的 embed 事件计数验证这点）',
  );
  assert.equal(
    events.filter((e) => e.kind === 'timeout' && e.label === 'embed').length,
    0,
    '未就绪的 embed 不该产生 RPC 超时事件',
  );
  assert.ok(events.some((e) => e.kind === 'warmup-failed'), '预热失败要有事件留痕');
});

test('③ worker 崩溃必须把 ready 翻回 false，并让在途请求落地', async (t) => {
  const { c, events } = clientWith(crashWorker, { rpcTimeoutMs: 500, warmupTimeoutMs: 1000 });
  t.after(() => c.close());

  assert.equal(await c.warmup(), true);
  assert.equal(c.isReady(), true, 'ready 事件翻转就绪位');

  // 等崩溃发生（fixture 在 ready 后 20ms 退出）
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(c.isReady(), false, 'exit 事件必须把就绪位翻回去');
  assert.ok(events.some((e) => e.kind === 'worker-exit'), '崩溃要有 exit 事件留痕');

  const out = await c.embed(['x']);
  assert.deepEqual(out, [null], '线程已死，embed 返回 null 而不是抛 postMessage 异常');

  // 关键：崩溃后重新 warmup 不能沿用崩溃前那个"成功"的 promise
  assert.equal(await c.warmup(), false, '崩溃后重走预热必须失败，不能复用旧 promise');
});

test('边界：空输入返回空数组；关闭后一律降级', async (t) => {
  const { c } = clientWith(slowWorker, { rpcTimeoutMs: 500, warmupTimeoutMs: 1000 });
  assert.deepEqual(await c.embed([]), [], '空批不该发 RPC');
  assert.deepEqual(await c.embed(null), [], '空批不该发 RPC');

  assert.equal(await c.warmup(), true);
  await c.close();

  assert.deepEqual(await c.embed(['a']), [null], '关闭后 embed 返回 null，不再碰已终止的线程');
  assert.equal(await c.warmup(), true, '关闭后的 warmup 属于无操作，不该再报失败');
});

/* ─────────── 接入 kernel：两档冷启动 + 预热前后各走各的路 ─────────── */

test('两档冷启动：init 不等模型，预热完成后向量路自动接上', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-worker-'));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive, { recursive: true });

  // 不注入 embedder → 走真实 worker（worker 里是 hash embedder，确定性、无下载）
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: 64, rpcTimeoutMs: 500 },
    },
    domains: [defineDomain({ id: 'wk', dir: archive })],
    gitInit: false,
  });
  t.after(async () => {
    await kernel.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const t0 = Date.now();
  const info = await kernel.init();
  assert.equal(info.embedding, 'worker', '未注入 embedder 时必须起 worker');
  assert.ok(Date.now() - t0 < 2000, '就绪标志只等骨架与索引，不等模型加载（§6 冷启动预算）');
  assert.equal(kernel.ready, true);

  await kernel.remember({
    domainId: 'wk',
    text: '用户喜欢喝咖啡，每天两杯',
    entryType: 'fact',
    topicTags: ['偏好'],
    triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }],
    sourceRef: { adapter_id: 'wk', locator: 'msg:worker1' },
    provenance: {
      session_id: 'wk:1', message_ids: ['msg:worker1'], extract_task_id: 'p0a-manual',
      model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
    },
  });

  // 预热窗口里写进来的条目：到这里向量可能还没补（hash embedder 预热快慢是竞态，
  // 不对中间态做断言），但 whenEmbeddingReady 连带补嵌，出来后必须是干净的
  await kernel.whenEmbeddingReady();
  const row = kernel.db.prepare(`SELECT id, embedding_pending FROM entries WHERE domain_id = 'wk'`).get();
  assert.equal(row.embedding_pending, 0, '预热 + 补嵌完成后不允许有漏网的 pending');
  assert.ok(kernel.vec.shardCount('wk') >= 1, '条目必须已经进向量路');

  // 确定性复现"预热窗口写入"：手动把这条记忆退化回 pending 状态，再走补嵌
  kernel.db.prepare('DELETE FROM entries_vec WHERE entry_id = ?').run(row.id);
  kernel.db.prepare('UPDATE vec_shards SET vector_count = 0 WHERE domain_id = ?').run('wk');
  kernel.db.prepare('UPDATE entries SET embedding_pending = 1 WHERE id = ?').run(row.id);
  assert.equal(kernel.vec.shardCount('wk'), 0);

  const bf = await kernel.backfillVectors();
  assert.equal(bf.scanned, 1);
  assert.equal(bf.embedded, 1, '补嵌必须真的把向量补进去');
  assert.equal(bf.stillPending, 0);
  assert.equal(kernel.db.prepare('SELECT embedding_pending FROM entries WHERE id = ?').get(row.id).embedding_pending, 0);
  assert.equal(kernel.vec.shardCount('wk'), 1, '补嵌必须同步维护 vec_shards，否则路径 B 判定失真');

  const q = await kernel.vec.embedQuery('咖啡');
  assert.ok(q, '预热完成后必须拿到查询向量');
  assert.equal(q.length, 64, '维度必须与 model_meta 一致，否则全量重建');

  const hits = kernel.vec.search(q, 'wk', 10);
  assert.ok(hits.length >= 1, '向量路要真的召回，而不是静默返回空');

  const r = await kernel.search({ sessionId: 'wk:1', query: '用户喜欢喝什么' });
  assert.ok(r.entries.length >= 1, '四路召回融合后仍有结果');
});

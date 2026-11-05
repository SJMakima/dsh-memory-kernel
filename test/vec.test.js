/**
 * §13.2 向量路的三条路径，逐条验收。
 *
 * 为什么必须手工插向量：真模型出来的向量分布是"聚簇"的，路径选择（A/B/C）由
 * `vec_shards.vector_count` 决定，跟向量长什么样无关。用 synthetic-small 向量能精确控制
 * "表里有几行"，把路径选择这件事从嵌入质量里剥出来单独测。
 *
 * 三条路径的分工：
 *   路径 A：分区键可用 + 本域向量数 ≥ `minPartitionVectors` → KNN 直接限制在域内，k 语义正确
 *   路径 B：分区键可用 + 本域向量数 < 阈值    → 全表 over-fetch + 内存过滤
 *   路径 C：sqlite-vec 不支持分区键          → 每域一表
 * 另外还有 `vec_shards` 计数对账：它一旦漂移，路径选择就整个错掉（A/B 判反）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { buildEntry, upsertEntryRow, loadEntries } from '../src/core/entry.js';
import { createVec } from '../src/core/vec.js';

const DIM = 8;
const N_PER_DOMAIN = 30;      // 合成规模：足以让 over-fetch 拿到"别域的干扰项"

/** 确定性随机：同一 seed 每次跑出同一批向量，断言才有意义（禁止 Math.random）。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function synthVector(seed) {
  const rnd = mulberry32(seed);
  const v = new Float32Array(DIM);
  let norm = 0;
  for (let i = 0; i < DIM; i++) {
    v[i] = rnd() * 2 - 1;
    norm += v[i] * v[i];
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

async function boot(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vec-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  const config = {
    storage: { root, dbPath: path.join(root, 'index.db'), ...(overrides.storage ?? {}) },
    embedding: { dim: DIM, ...(overrides.embedding ?? {}) },
    retrieve: { ...(overrides.retrieve ?? {}) },
  };
  const kernel = await createKernel({
    config,
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') }), defineDomain({ id: 'db', dir: path.join(root, 'b') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  return { kernel, root };
}

/**
 * 手工插 30+30 条：两个域各 N_PER_DOMAIN，**shard 计数同步写**。
 * 不同步写的话，路径 A/B 的判定依据（vec_shards）就是空的，测出来的行为全是假的。
 */
function seedSynthetic(kernel, { withShards = true } = {}) {
  const cfg = kernel.cfg;
  const vectors = new Map();
  for (const [domain, offset] of [['da', 0], ['db', 1_000_000]]) {
    const d = kernel.domains.get(domain);
    for (let i = 0; i < N_PER_DOMAIN; i++) {
      const c = {
        text: `${domain} 的第 ${i} 条记忆`,
        entryType: 'fact',
        topicTags: ['合成'],
        triples: [{ subject: domain, attribute: '序号', value: String(i) }],
        sourceRef: { adapter_id: domain, locator: `${domain}:${i}` },
        provenance: {
          session_id: `${domain}:1`, message_ids: [`${domain}:${i}`], extract_task_id: 'synthetic',
          model_version: 'synthetic', extracted_at: Date.now(), source_content_hash: '',
        },
      };
      const e = buildEntry(c, d, cfg, Date.now() - i * 1000);
      const v = synthVector(offset + i);
      upsertEntryRow(kernel.db, { ...e, embedding_pending: false });
      kernel.vec.upsert(e, v);
      if (withShards) kernel.write.bumpShardCount(domain, 'inserted');
      vectors.set(e.id, { domain, v });
    }
  }
  return vectors;
}

/** Windows 上必须先关库再删目录，否则 WAL/SHM 还被句柄占着 → EBUSY。 */
const cleanup = async (kernel, root) => {
  await kernel?.close();
  await fs.rm(root, { recursive: true, force: true });
};

/* ───────────────────────────── 路径 B ───────────────────────────── */

test('路径 B：小域 over-fetch 后仍能取满 k，且 100% 是本域条目', async (t) => {
  // minPartitionVectors 抬到 1000 → 30 条必然走路径 B
  const { kernel, root } = await boot({ retrieve: { minPartitionVectors: 1000, knnOversample: 4 } });
  t.after(() => cleanup(kernel, root));

  const vectors = seedSynthetic(kernel);
  assert.equal(kernel.vec.shardCount('da'), N_PER_DOMAIN, 'shard 计数必须与插入同步，否则路径判定失真');

  // 查询向量 = 第 0 条（da）的向量本身 → 它的近邻里必然混着 db 的条目，
  // 这正是路径 B 要处理的场景：over-fetch 拿到别域的，内存过滤掉。
  const q = [...vectors.values()].find((x) => x.domain === 'da').v;

  const hits = kernel.vec.search(q, 'da', 10);
  assert.equal(hits.length, 10, '路径 B 必须能取满 k，不能因为 over-fetch 里有别域条目就少给');

  const rows = loadEntries(kernel.db, hits.map((h) => h.id));
  for (const h of hits) {
    assert.equal(rows.get(h.id).domain_id, 'da', '路径 B 漏过滤 = 把别域的记忆塞进上下文');
  }
  // 距离升序 → 位置即名次（禁止在调用方再排一次序）
  const scores = hits.map((h) => h.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'KNN 结果必须保持距离升序');
  assert.ok(hits[0].score > 0.999, '自匹配的距离应接近 0（余弦相似度接近 1）');
});

test('路径 B：表里不足 fetch 时按"抽干"收工，小域不返回空', async (t) => {
  const { kernel, root } = await boot({ retrieve: { minPartitionVectors: 1000, knnOversample: 4 } });
  t.after(() => cleanup(kernel, root));

  const cfg = kernel.cfg;
  const d = kernel.domains.get('da');
  for (let i = 0; i < 3; i++) {
    const e = buildEntry({
      text: `只有三条的小域 ${i}`, entryType: 'fact', topicTags: ['合成'],
      triples: [{ subject: '小域', attribute: '序号', value: String(i) }],
      sourceRef: { adapter_id: 'da', locator: `da:${i}` },
      provenance: { session_id: 'da:1', message_ids: [`da:${i}`], extract_task_id: 'synthetic', model_version: 'synthetic', extracted_at: Date.now(), source_content_hash: '' },
    }, d, cfg, Date.now() - i * 1000);
    upsertEntryRow(kernel.db, { ...e, embedding_pending: false });
    kernel.vec.upsert(e, synthVector(500 + i));
    kernel.write.bumpShardCount('da', 'inserted');
  }

  const hits = kernel.vec.search(synthVector(500), 'da', 10);
  assert.equal(hits.length, 3, '3 条向量的域要 10 条是不可能事件：给 3 条真的，胜过给 0 条');
});

test('路径 B：本域命中不足 k 时宁缺毋滥，不拿别域凑数', async (t) => {
  const { kernel, root } = await boot({ retrieve: { minPartitionVectors: 1000, knnOversample: 1 } });
  t.after(() => cleanup(kernel, root));

  seedSynthetic(kernel);
  // 造一个"表里很大、但本域命中很少"的查询：取 db 的向量去查 da
  const q = synthVector(1_000_000);
  const hits = kernel.vec.search(q, 'da', 20);
  assert.ok(hits.length <= 20);
  if (hits.length) {
    const rows = loadEntries(kernel.db, hits.map((h) => h.id));
    for (const h of hits) assert.equal(rows.get(h.id).domain_id, 'da');
  }
});

/* ───────────────────────────── 路径 A ───────────────────────────── */

test('路径 A：过阈值后走分区键 KNN，跨域查询只回本域', async (t) => {
  const { kernel, root } = await boot({ retrieve: { minPartitionVectors: 30 } });
  t.after(() => cleanup(kernel, root));

  const vectors = seedSynthetic(kernel);
  assert.equal(kernel.vec.shardCount('da'), N_PER_DOMAIN);

  const q = [...vectors.values()].find((x) => x.domain === 'da').v;
  const hits = kernel.vec.search(q, 'da', 10);

  assert.equal(hits.length, 10, '路径 A 的 k 是分区内的 k，不是全表的 k');
  const rows = loadEntries(kernel.db, hits.map((h) => h.id));
  for (const h of hits) assert.equal(rows.get(h.id).domain_id, 'da');

  // 分区键真的生效：db 自己的向量在 db 的分区里能取满，反过来在 da 里一条都没有
  const bOnly = kernel.vec.search(synthVector(1_000_000), 'db', 10);
  assert.equal(bOnly.length, 10);
});

/* ─────────────────────────── 路径 C（降级）─────────────────────────── */

test('路径 C：不支持分区键时每域一表，upsert 幂等', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  // 独立构造一个"canPartition=false"的 vec，验证降级路径本身（真机上由 sqlite-vec 版本决定）
  const vec = createVec({
    db: kernel.db,
    cfg: kernel.cfg,
    vec: { enabled: true, canPartition: false, dim: DIM },
    embedder: createHashEmbedder(DIM),
  });

  const e = {
    id: 'synthetic-c-1', domain_id: 'da', cold: false,
    text: '路径 C 的条目', topic_tags: [],
  };
  assert.equal(vec.upsert(e, synthVector(9001)), 'inserted');
  assert.equal(vec.upsert(e, synthVector(9002)), 'replaced', 'vec0 不能 INSERT OR REPLACE，必须 DELETE + INSERT');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM entries_vec_da').get().c, 1);

  const hits = vec.search(synthVector(9001), 'da', 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'synthetic-c-1');

  vec.remove(e.id, 'da');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM entries_vec_da').get().c, 0);
});

/* ──────────────────── vec_shards 计数对账（§16 第 7 步）──────────────────── */

test('vec_shards 计数漂移会被 remove 修正，行数与计数始终一致', async (t) => {
  const { kernel, root } = await boot({ retrieve: { minPartitionVectors: 30 } });
  t.after(() => cleanup(kernel, root));

  const vectors = seedSynthetic(kernel);
  const countRows = (d) => kernel.db.prepare('SELECT COUNT(*) AS c FROM entries_vec WHERE domain_id = ?').get(d).c;

  assert.equal(kernel.vec.shardCount('da'), countRows('da'));
  assert.equal(kernel.vec.shardCount('db'), countRows('db'));

  const [victim] = [...vectors.entries()].filter(([, x]) => x.domain === 'da');
  kernel.vec.remove(victim[0], 'da');
  kernel.write.decShardCount('da');
  assert.equal(kernel.vec.shardCount('da'), countRows('da'), '删向量与减计数必须成对，否则路径判定漂移');
  assert.equal(kernel.vec.shardCount('da'), N_PER_DOMAIN - 1);

  // shard 掉到阈值以下 → 同一条查询改走路径 B，结果仍然只对
  const { kernel: k2, root: r2 } = await boot({ retrieve: { minPartitionVectors: 5 } });
  t.after(() => cleanup(k2, r2));
  const v2 = seedSynthetic(k2);
  for (const [id, x] of v2) {
    if (x.domain !== 'da') continue;
    k2.vec.remove(id, 'da');
    k2.write.decShardCount('da');
  }
  assert.equal(k2.vec.shardCount('da'), 0);
  assert.equal(k2.vec.search(synthVector(1_000_000), 'da', 10).length, 0, '域内没有向量就只能给空，不能拿别域的');
});

/* ─────────── 降级标签：vec:not-ready 与 vec:rpc-timeout 必须分开 ─────────── */

test('R-54：模型未就绪与 RPC 超时写成两个标签', async (t) => {
  const { kernel, root } = await boot();
  t.after(() => cleanup(kernel, root));

  const readLog = async () => {
    await kernel.audit.flush();
    return fs.readFile(path.join(root, 'audit', 'vec-degraded.log'), 'utf8').catch(() => '');
  };

  // 模拟"模型还在加载"：embedQuery 返回 null，且 isReady 为 false
  kernel.vec.embedQuery = async () => null;
  kernel.vec.isReady = () => false;
  const r1 = await kernel.search({ sessionId: 'da:1', query: '咖啡' });
  assert.equal(r1.skipVec, true, '拿不到查询向量 → 跳过向量路，三路召回');
  assert.match(await readLog(), /vec:not-ready/);
  assert.doesNotMatch(await readLog(), /vec:rpc-timeout/, '未就绪不该被记成超时');

  // 模拟"模型在、这条超时"
  kernel.vec.isReady = () => true;
  await kernel.search({ sessionId: 'da:1', query: '咖啡' });
  assert.match(await readLog(), /vec:rpc-timeout/);

  // 向量路整个关闭时不写降级日志：那不是降级，是这条路径不存在
  kernel.vec.embedQuery = async () => null;
  const k2Root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vecno-'));
  await fs.mkdir(path.join(k2Root, 'a'), { recursive: true });
  const k2 = await createKernel({
    config: { storage: { root: k2Root, dbPath: path.join(k2Root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(k2Root, 'a') })],
    embeddingWorker: false,
    gitInit: false,
  });
  t.after(() => cleanup(k2, k2Root));
  await k2.init();
  await k2.search({ sessionId: 'da:1', query: '咖啡' });
  await k2.audit.flush();
  await assert.rejects(
    fs.readFile(path.join(k2Root, 'audit', 'vec-degraded.log'), 'utf8'),
    '向量路关闭是配置，不是降级',
  );
});

/* ─────────────────── 嵌入不可用时整条向量路静默降级 ───────────────── */

test('没有 embedder 时向量路整条关闭，不是"返回空结果"', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vecoff-'));
  t.after(() => cleanup(kernel, root));
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embeddingWorker: false,
    gitInit: false,
  });
  await kernel.init();

  assert.equal(kernel.vec.enabled, false);
  assert.deepEqual(await kernel.vec.embedTexts(['x']), [null]);
  assert.deepEqual(kernel.vec.search(synthVector(1), 'da', 10), []);
  assert.equal(kernel.vec.upsert({ id: 'x', domain_id: 'da', cold: false }, synthVector(2)), 'skipped');

  // 向量路关掉时不应该产生 pending：根本没有可补的东西
  await kernel.remember({
    domainId: 'da', text: '向量路关闭时写入的记忆', entryType: 'fact', topicTags: ['关闭'],
    triples: [], sourceRef: { adapter_id: 'da', locator: 'da:off' },
    provenance: { session_id: 'da:1', message_ids: ['da:off'], extract_task_id: 'synthetic', model_version: 'synthetic', extracted_at: Date.now(), source_content_hash: '' },
  });
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM entries WHERE embedding_pending = 1').get().c, 0);
});

/* ─────────────────── 入嵌剥日期（假相似治理）───────────────────
 * 真实病例：fastText 词平均下，"用户想吃火锅，点名某火锅店（2026-10-27 傍晚）" vs
 * "用户说现在喜欢喝矿泉水（2026-10-27 更新）…" = 0.883（>0.80 判重线）——单凭共享的
 * "用户 + 同一个日期 + 括号旁白"就把不相干事实拉成假相似进待定池。修法：入嵌统一剥日期。
 * 用 spy embedder 钉住"进 embedder 的文本长什么样"，hash/lexvec 语义无关。
 */
test('embedTexts 入嵌前剥掉日期时间形态（存储/判重/rebuild/查询四侧同源）', async (t) => {
  const Database = (await import('better-sqlite3')).default;
  const received = [];
  const spyEmbedder = {
    dim: DIM, kind: 'spy',
    async embed(texts) { received.push(...texts); return texts.map((_, i) => synthVector(7 + i)); },
  };
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE embedding_cache (
    text_hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, model_id TEXT NOT NULL, dim INTEGER NOT NULL)`);
  const v = createVec({ db, cfg: { embedding: { model: 'spy' } }, vec: { enabled: true, dim: DIM }, embedder: spyEmbedder, audit: {} });

  const [emb] = await v.embedTexts(['用户想吃火锅，点名某火锅店（2026-10-27 傍晚）。']);
  assert.ok(emb instanceof Float32Array, '向量应产出');
  assert.equal(received[0], '用户想吃火锅，点名某火锅店（ 傍晚）。', '日期 token 应在入嵌前被剥掉');

  received.length = 0;
  await v.embedTexts(['用户的账号是 1234567890，2026 年记']);
  assert.equal(received[0], '用户的账号是 1234567890， 年记', '孤立年份剥掉，QQ 号等标识符不误伤');
});

/* ─────────────────── 旁路实例的维度安全（真实病例：导入器差点洗掉 lexvec 库）───────────────────
 * 宿主 Config volatile 断 → 嵌入后端自管落盘 embedding-settings.json，但只有宿主读它。
 * 导入器/CLI 等 headless 内核拿默认 hash/1024 维开库，对 300 维 lexvec 库就是 dimMismatch
 * → 全量重建 → 真向量洗成空。两条防线：① headless 恢复落盘后端；② 撞 mismatch 且无后端
 * 时禁用向量路而不是重建。
 */
test('headless 内核从 embedding-settings.json 恢复 lexvec 后端', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-headless-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.writeFile(path.join(root, 'embedding-settings.json'),
    JSON.stringify({ backend: 'lexvec', lexvecTablePath: '' }));
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: 64 } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embeddingWorker: false,
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(kernel.vec.enabled, true, '落盘的 lexvec 后端应被恢复 → 向量路开启');
  assert.equal(kernel.vec.dim, 32, '无外部表路径 → 种子表 32 维');
});

test('headless 实例撞维度不匹配：禁用向量路，绝不洗掉库里真向量', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dimguard-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  const cfgOf = (dim) => ({ storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim } });
  const k1 = await createKernel({
    config: cfgOf(64), domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embedder: createHashEmbedder(64), gitInit: false,
  });
  await k1.init();
  await k1.remember({
    domainId: 'da', text: '维度守卫测试条目', entryType: 'fact', topicTags: ['守卫'],
    triples: [], sourceRef: { adapter_id: 'da', locator: 'da:guard' },
    provenance: { session_id: 'da:1', message_ids: ['da:guard'], extract_task_id: 't', model_version: 't', extracted_at: Date.now(), source_content_hash: '' },
  });
  const before = k1.db.prepare('SELECT COUNT(*) AS c FROM entries_vec_rowids').get().c;
  assert.ok(before > 0, '前提：向量已入库');
  await k1.close();

  // headless（无 embedder，默认 1024 维）打开 64 维库 → mismatch → 必须降级而非重建
  const k2 = await createKernel({
    config: cfgOf(1024), domains: [defineDomain({ id: 'da', dir: path.join(root, 'a') })],
    embeddingWorker: false, gitInit: false,
  });
  await k2.init();
  t.after(async () => { await k2.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(k2.vec.enabled, false, '降级为本实例禁用向量路');
  assert.equal(k2.db.prepare('SELECT COUNT(*) AS c FROM entries_vec_rowids').get().c, before, '向量行原样保留');
  assert.equal(k2.db.prepare('SELECT dim FROM model_meta WHERE id = 1').get().dim, 64, 'model_meta 未被改写');
  assert.ok(k2.db.prepare("SELECT COUNT(*) AS c FROM entries WHERE text LIKE '%维度守卫%'").get().c, '条目完好');
});

/**
 * §13.2 向量路（vec0 + 内存精确索引）+ §11 嵌入服务的主线程侧。
 *
 * 查询按下列顺序短路，判定一律在函数入口（禁止项 32：`return` 之后写降级路径 = 不可达代码）：
 *   ① 内存索引：每域一份扁平 Float32Array，usearch `exactSearch` 精确扫描（R-137）。
 *      命中即返回 —— 省掉"每次查询都从 SQLite 搬 2 万条 BLOB"的那 283ms；
 *      不可用 / 脏 / 未加载失败 → 一律落到下面，**不返回半截结果**。
 *   ② 分区键把 KNN 限制在域内（vec0 MATCH），k 语义正确
 *   ③ 小分区（< minPartitionVectors）域内全量内存算 —— 全表 KNN 在这个规模会**丢结果**（R-122）
 *   ④ 全表 over-fetch + 内存过滤（路径 B）；sqlite-vec 无分区键 → 每域一表（路径 C）
 * 没有 embedder / 模型未就绪：`search()` 直接返回 []，检索降级三路，**不是错误**。
 */
import { sha256, stripDateLike } from '../pure/normalize.js';
import { createVecIndexStore } from './vec-index.js';

const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
const safeTable = (domainId) => `entries_vec_${String(domainId).replace(/[^a-zA-Z0-9_]/g, '_')}`;

/**
 * 余弦 top-k（纯函数，R-122）：`rows = [{id, embedding: Buffer}]`。
 * 向量是否已归一化不确定 → 老实算模长，不做"点积当余弦"的假设。
 *
 * 保留为纯函数而非直接调 usearch：① 单测要能在没有原生依赖的环境里跑；
 * ② 它是内存索引不可用时的兜底路径，不能反过来依赖那层。
 */
export function topKByCosine(q, rows, k) {
  const qa = q instanceof Float32Array ? q : Float32Array.from(q);
  let qn = 0;
  for (let i = 0; i < qa.length; i++) qn += qa[i] * qa[i];
  qn = Math.sqrt(qn) || 1e-12;

  const scored = [];
  for (const r of rows) {
    const buf = r.embedding;
    if (!buf || buf.length !== qa.length * 4) continue;   // 维度不符（错维残留）→ 跳过，不猜
    const v = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    let dot = 0; let vn = 0;
    for (let i = 0; i < qa.length; i++) { dot += qa[i] * v[i]; vn += v[i] * v[i]; }
    const score = dot / (qn * (Math.sqrt(vn) || 1e-12));
    scored.push({ id: r.id, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));   // 次要键：同分稳定
  return scored.slice(0, k);
}

export function createVec({ db, cfg, vec, embedder, audit }) {
  const enabled = Boolean(vec.enabled && embedder);
  const dim = vec.dim;
  const fallbackTables = new Set();

  // 【R-137】第二派生层：内存精确索引。纯缓存，丢了/脏了都只影响延迟，绝不影响正确性。
  // limits 传函数而不是快照：memIndex.enabled 是热键，关掉以后下外审查询就得回落到 vec0。
  const memIndex = createVecIndexStore({
    dim,
    limits: () => cfg.retrieve.memIndex,
    audit,
  });
  // 脏域的自愈次数：重灌一次还脏说明不是偶发（并发写坏 / 原生库问题），熔断到 vec0，
  // 否则会陷入"每次查询都重灌全部 BLOB"的负优化——那比一开始就不开这层还慢。
  const memRetry = new Map();
  const MEM_RETRY_MAX = 2;
  // 明确"这层在这个域上永远别试了"（超内存上限 / usearch 缺失）。不清空就会每次查询白读全表 BLOB。
  const memRefused = new Set();

  const cacheGet = db.prepare('SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model_id = ? AND dim = ?');
  const cachePut = db.prepare(`INSERT INTO embedding_cache(text_hash, embedding, model_id, dim)
                               VALUES (?, ?, ?, ?) ON CONFLICT(text_hash) DO UPDATE SET embedding = excluded.embedding`);

  async function embedTexts(rawTexts) {
    // 入嵌统一剥日期时间（【全链路唯一入嵌口】：存储/判重/rebuild/查询四侧一致）——
    // 日期零语义还会制造假相似（见 stripDateLike 注释），查询侧剥掉同样无害。
    const texts = rawTexts.map(stripDateLike);
    if (!enabled || !texts.length) return texts.map(() => null);
    const out = new Array(texts.length).fill(null);
    const missing = [];
    texts.forEach((t, i) => {
      const row = cacheGet.get(sha256(t), cfg.embedding.model, dim);
      if (row) {
        const b = row.embedding;
        out[i] = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      } else missing.push(i);
    });
    if (!missing.length) return out;
    try {
      const vectors = await embedder.embed(missing.map((i) => texts[i]));
      missing.forEach((idx, j) => {
        const v = vectors?.[j];
        if (!v || v.length !== dim) return;
        out[idx] = v;
        cachePut.run(sha256(texts[idx]), Buffer.from(v.buffer, v.byteOffset, v.byteLength), cfg.embedding.model, dim);
      });
    } catch {
      // 嵌入失败 → 该轮无向量；调用方按"模型未就绪"降级，日志标 vec:not-ready
    }
    return out;
  }

  async function embedQuery(text) {
    const [v] = await embedTexts([text]);
    return v ?? null;
  }

  function shardCount(domainId) {
    return db.prepare('SELECT vector_count FROM vec_shards WHERE domain_id = ?').get(domainId)?.vector_count ?? 0;
  }

  /** 该域全部向量行（灌内存索引用）。路径 C 下表名按域拼，所以必须区分。 */
  function readDomainRows(domainId) {
    try {
      if (vec.canPartition) {
        return db.prepare('SELECT entry_id AS id, embedding FROM entries_vec WHERE domain_id = ?').all(domainId);
      }
      return db.prepare(`SELECT entry_id AS id, embedding FROM ${safeTable(domainId)}`).all();
    } catch {
      return [];   // 表还没建 / 已坏：当空处理，让下面各路径自己判定
    }
  }

  /**
   * 内存索引查询。**返回 null = 本层不可用，调用方必须继续往下走**。
   * 绝不在失败时返回 [] —— 那会被上层读成"向量路没有命中"，把召回静默吃掉。
   */
  function memSearch(q, domainId, k) {
    if (!memIndex.enabled) return null;
    if (memRefused.has(domainId)) return null;
    if ((memRetry.get(domainId) ?? 0) >= MEM_RETRY_MAX) return null;

    // 懒加载：第一次查这个域时才从 SQLite 灌。没被查过的域不占内存，写入也不必同步。
    if (!memIndex.has(domainId)) {
      const rows = readDomainRows(domainId);
      if (!rows.length) return null;                        // 空域不值得建索引
      if (!memIndex.load(domainId, rows)) {
        // 超 maxVectors / usearch 不可用：钉死不再重试，否则每次查询都白读一遍全部 BLOB
        memRefused.add(domainId);
        return null;
      }
    }

    const hits = memIndex.search(domainId, q, k);
    if (hits === null) {
      const n = (memRetry.get(domainId) ?? 0) + 1;
      memRetry.set(domainId, n);
      void audit?.write?.('vec-index', {
        event: n >= MEM_RETRY_MAX ? 'circuit-open' : 'degraded',
        domainId, retry: n, fallback: 'vec0',
      }).catch?.(() => {});
      return null;
    }
    memRetry.delete(domainId);
    return hits;
  }

  /** 单表 + 分区键；`k` 在分区内语义正确。 */
  function search(q, domainId, k) {
    if (!enabled || !q) return [];

    // ① 内存精确索引（R-137）。命中即返回；不可用/脏 → 落到下面各路，绝不返回半截结果
    const mem = memSearch(q, domainId, k);
    if (mem !== null) return mem;

    // ② 以下为降级路径。路径 C 判定必须在入口（v4.1 把它写在 `return []` 之后，从未生效过）
    if (!vec.canPartition) return searchByTable(q, domainId, k);

    if (shardCount(domainId) >= cfg.retrieve.minPartitionVectors) {
      try {
        const rows = db.prepare(`
          SELECT entry_id AS id, distance FROM entries_vec
          WHERE embedding MATCH ? AND domain_id = ? AND k = ?
        `).all(toBlob(q), domainId, k);
        // sqlite-vec 的 KNN 结果天然按距离升序 → 数组位置即名次
        return rows.map((r) => ({ id: r.id, score: 1 - r.distance }));
      } catch (err) {
        // 运行时降级：闸门只保证"进来的时候是好的"，保不住"某次查询时虚拟表坏没坏"。
        // 检索绝不能因向量路挂掉，最多慢一次。
        void audit?.write?.('vec-strategy', {
          event: 'vec-query-failed',
          domainId, error: String(err?.message ?? err), fallback: 'brute-force over-fetch',
        }).catch?.(() => {});
        const hits = bruteForceKnn(q, domainId, k);
        if (hits) { hits.degraded = 'vec-failed'; return hits; }
        return [];
      }
    }
    // 【R-122】小分区不能靠全表 KNN：主域 5 万、本域 30 条时，全局 top-80 里期望命中本域 0.05 条，
    // 翻到 320 也只有 0.19 条 → 恒返回 []（P0a 用 synthetic-small 造数据，正好掩盖了这个缺陷，
    // 当年判成"P2 校准问题"是误判，它影响的是**正确性**）。正解：域内向量本来就少，
    // 直接取该域全部向量在内存算余弦（30×300 次乘加，微秒级），完全绕开全表 KNN。
    const scanned = domainScan(q, domainId, k);
    if (scanned) return scanned;
    return bruteForceKnn(q, domainId, k) ?? [];
  }

  /**
   * 域内暴力扫描：`SELECT entry_id, embedding FROM entries_vec WHERE domain_id = ?`。
   * 返回 null = 这条 SQL 本身不可用（老 sqlite-vec / 表结构差异），调用方退回全表 KNN。
   */
  function domainScan(q, domainId, k) {
    try {
      const rows = db.prepare('SELECT entry_id AS id, embedding FROM entries_vec WHERE domain_id = ?').all(domainId);
      if (!rows.length) return [];
      return topKByCosine(q, rows, k);
    } catch (err) {
      void audit?.write?.('vec-strategy', {
        event: 'domain-scan-failed', domainId, error: String(err?.message ?? err), fallback: 'global-knn',
      }).catch?.(() => {});
      return null;
    }
  }

  /**
   * 路径 B：分区过碎，固定开销摊薄后反而更快；同时是路径 A 异常时的暴力 KNN 降级路。
   * 返回 null 表示表本身查询失败（调用方按"向量路不可用"处理，检索降级三路）。
   */
  function bruteForceKnn(q, domainId, k) {
    let fetch = k * cfg.retrieve.knnOversample;
    try {
      for (let i = 0; i < 3; i++) {
        const hits = db.prepare(`
          SELECT entry_id AS id, distance FROM entries_vec
          WHERE embedding MATCH ? AND k = ?
        `).all(toBlob(q), fetch);

      // 不用 JOIN 过滤（禁止项 4），改为一次 IN 查询取归属
      const ids = hits.map((h) => h.id);
      const domainMap = new Map();
      if (ids.length) {
        for (const r of db.prepare(`SELECT id, domain_id FROM entries WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
          domainMap.set(r.id, r.domain_id);
        }
      }
      const rows = hits.filter((h) => domainMap.get(h.id) === domainId);
      // 终止条件有两个，缺一不可：
      //   `rows.length >= k`   —— 够数了
      //   `hits.length < fetch` —— 表被抽干了，再翻倍也拿不到新东西。
      // 少了后者：一个只有 3 条向量的新域会连翻三倍 fetch 后返回 []，
      // 明明手里握着 3 条真命中，却把向量路整个让出去（小域在前几周就是常态）。
      if (rows.length >= k || hits.length < fetch) {
        return rows.slice(0, k).map((r) => ({ id: r.id, score: 1 - r.distance }));
      }
        fetch *= 2;
      }
      return [];   // 表很大但本域命中不足 k：宁可少给，也不拿别域的条目凑数
    } catch (err) {
      // 降级路也炸了 = 表本身坏了。吞掉不抛：检索降级三路，日志留痕。
      void audit?.write?.('vec-strategy', {
        event: 'vec-query-failed', domainId, error: String(err?.message ?? err), fallback: 'none',
      }).catch?.(() => {});
      return null;
    }
  }

  function ensureFallbackTable(domainId) {
    const table = safeTable(domainId);
    if (fallbackTables.has(table)) return table;
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
      entry_id TEXT PRIMARY KEY, embedding float[${dim}] distance_metric=cosine
    )`);
    fallbackTables.add(table);
    return table;
  }

  function searchByTable(q, domainId, k) {
    const table = ensureFallbackTable(domainId);
    const rows = db.prepare(`SELECT entry_id AS id, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`)
      .all(toBlob(q), k);
    return rows.map((r) => ({ id: r.id, score: 1 - r.distance }));
  }

  /** vec0 不能 INSERT OR REPLACE（禁止项 3），必须 DELETE + INSERT。 */
  function upsert(e, embedding) {
    if (!enabled || e.cold || !embedding) return 'skipped';
    if (!vec.canPartition) {
      const table = ensureFallbackTable(e.domain_id);
      const existed = db.prepare(`SELECT 1 FROM ${table} WHERE entry_id = ?`).get(e.id) != null;
      db.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(e.id);
      db.prepare(`INSERT INTO ${table}(entry_id, embedding) VALUES (?, ?)`).run(e.id, toBlob(embedding));
      syncIndex(e, embedding);
      return existed ? 'replaced' : 'inserted';
    }
    const existed = db.prepare('SELECT 1 FROM entries_vec WHERE entry_id = ?').get(e.id) != null;
    db.prepare('DELETE FROM entries_vec WHERE entry_id = ?').run(e.id);
    db.prepare('INSERT INTO entries_vec(entry_id, domain_id, embedding) VALUES (?, ?, ?)')
      .run(e.id, e.domain_id, toBlob(embedding));
    syncIndex(e, embedding);
    return existed ? 'replaced' : 'inserted';
  }

  /**
   * 【R-137】把一次写入同步进内存索引。
   * **顺序不可反**：SQLite 先落（调用点上已经落完），索引后跟 —— 索引是派生，
   * 万一同步失败只是这层变脏（下外审降级重灌），绝不会让库比索引旧。
   * 域没加载过就什么都不做：下次加载时从 SQLite 读到的本来就是新数据。
   */
  function syncIndex(entry, embedding) {
    const r = memIndex.upsert(entry.domain_id, entry.id, embedding);
    if (r === 'dirty') {
      void audit?.write?.('vec-index', {
        event: 'sync-failed', domainId: entry.domain_id, entryId: entry.id, fallback: 'vec0',
      }).catch?.(() => {});
    }
  }

  /**
   * 路径 C 下表名不可枚举（按 domain_id 拼出来的），所以 `domainId` 是必填参数：
   * 靠遍历 `vec_shards` 猜是不行的 —— 计数漂移到 0 的域在表里就没有行，
   * 删不掉的那条向量会永远留在 KNN 结果里（表现为"召回里混着已删除的 id"）。
   */
  function remove(entryId, domainId) {
    if (!enabled) return;
    if (!vec.canPartition) {
      const table = domainId ? safeTable(domainId) : null;
      if (table) {
        try { db.prepare(`DELETE FROM ${table} WHERE entry_id = ?`).run(entryId); } catch { /* 表可能未建 */ }
        memIndex.remove(domainId, entryId);
        return;
      }
      for (const r of db.prepare('SELECT domain_id FROM vec_shards').all()) {
        try { db.prepare(`DELETE FROM ${safeTable(r.domain_id)} WHERE entry_id = ?`).run(entryId); } catch { /* 表可能未建 */ }
      }
      // 不知道删的是哪个域 → 整层丢弃。残留的后果是"召回里混着已删除的 id"，
      // 宁可下外审重灌一次（几十~几百 ms），也不能让已删条目继续被检索出来。
      memIndex.clear('remove-unknown-domain');
      memRefused.clear();
      memRetry.clear();
      return;
    }
    db.prepare('DELETE FROM entries_vec WHERE entry_id = ?').run(entryId);
    if (domainId) memIndex.remove(domainId, entryId);
    else { memIndex.clear('remove-unknown-domain'); memRefused.clear(); memRetry.clear(); }
  }

  /**
   * 模型当前是否就绪。**没有 `isReady` 方法的注入式 embedder 视为"永远就绪"**：
   * 测试/demo 用的是同步哈希嵌入，它没有"加载中"这个状态，如果按未就绪处理，
   * 日志里会平白多出无数条 `vec:not-ready`。
   */
  const isReady = () => embedder?.isReady?.() ?? true;

  /**
   * 本域**实际**会走的查询路径（诊断用，不是开关）。取值：
   *   'disabled'     无向量路（没 embedder / sqlite-vec 不可用）
   *   'mem-exact'    内存精确索引命中（R-137 目标态：单次查询不再搬 BLOB）
   *   'mem-lazy'     内存索引可用但该域尚未加载（下一次查询会灌）
   *   'vec0-knn'     分区键直通（内存层被熔断/拒绝时的主降级路）
   *   'domain-scan'  小分区域内全量内存算（R-122）
   *   'per-domain'   sqlite-vec 无分区键 → 每域一表
   * 这里故意不返回"配置想要什么"，只返回"现在实际是什么"——诊断价值全在前者与后者差多少。
   */
  const mode = (domainId) => {
    if (!enabled) return 'disabled';
    if (memIndex.enabled && !memRefused.has(domainId) && (memRetry.get(domainId) ?? 0) < MEM_RETRY_MAX) {
      return memIndex.has(domainId) ? 'mem-exact' : 'mem-lazy';
    }
    if (!vec.canPartition) return 'per-domain';
    if (shardCount(domainId) >= cfg.retrieve.minPartitionVectors) return 'vec0-knn';
    return 'domain-scan';
  };

  /**
   * rebuild / 维度重建后**必须**调：整层失效重灌。
   * 漏了这步的后果不是变慢，是**张冠李戴**（旧 flat 的 id 映射已与库脱节，
   * 查 A 返回 B 且不报错）——那种错误比慢 60ms 严重得多。
   */
  function resetIndex(reason = 'rebuild') {
    memIndex.clear(reason);
    memRefused.clear();
    memRetry.clear();
  }

  return {
    enabled, dim, embedTexts, embedQuery, search, upsert, remove, shardCount, isReady,
    mode, resetIndex,
    indexStats: () => memIndex.stats(),
  };
}

/**
 * §13.3 内存向量索引（**第二派生层**，R-137）。
 *
 * 层级必须说清楚，否则后面接手的人会拿它当真相源用：
 *   md 片段（真相源，可重放）
 *     └─ SQLite / entries_vec（第一派生，rebuild 可从 md 整体重建）
 *          └─ 本模块（第二派生，只是 SQLite 的缓存，丢了从 SQLite 重灌）
 * 裁决权在 md；本模块**不承载任何真相**，任何时候都可以整体丢弃。
 *
 * 为什么要有这一层（实测，8 万条 × 300 维，域内 2 万条）：
 *   单次查询从 SQLite 读全部 BLOB 展开成 Float32Array ≈ 283ms，
 *   拿到数组后算余弦只要 40ms（手写 JS）/ 8ms（usearch SIMD 精确扫描）。
 *   搬运比计算贵 7 倍 —— 所以瓶颈不是"要不要 ANN"，而是"别每次查询都重新搬一遍"。
 *
 * 因此本层做两件事，只做这两件：
 *   ① 常驻：每域一份扁平 Float32Array，查询不再回 SQL 取向量（只按命中 id 回取内容）；
 *   ② SIMD：用 usearch 的 `exactSearch` 做**精确**扫描 —— 不是它的 `Index`（HNSW）。
 *      实测 8 万条精确扫描 8~10.6ms、召回 100%；HNSW 1.28ms 但召回只有 88%（聚类分布）
 *      / 11%（随机均匀分布），且建索引 16~37s。省 7ms 换 12% 召回 + 一致性维护，不划算。
 *
 * 三条硬约束（违反任意一条，这套结构就该拆掉）：
 *   ① 可丢弃：坏了一律 `null` 交回调用方降级到 vec0 KNN，绝不返回未经校验的结果；
 *   ② 只优化延迟：任何"用索引判断库里有没有这条"的用法都是错的；
 *   ③ rebuild 后必须整体失效重灌：rebuild 会重排 id / 删块，旧 flat 会**张冠李戴**
 *      （查 A 返回 B，且不报错），这种错比慢 60ms 严重得多。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** usearch 是可选依赖：装不上（无预编译包的平台）就整层不启用，向量路回到 vec0。 */
let exactSearch = null;
let loadError = null;
try {
  ({ exactSearch } = require('usearch'));
} catch (err) {
  loadError = String(err?.message ?? err);
}

export const usearchAvailable = () => typeof exactSearch === 'function';
export const usearchLoadError = () => loadError;

/** 容量增长 1.5 倍：翻倍策略在 8 万条时最坏占 2 倍内存（184MB vs 92MB），不值得。 */
const GROWTH = 1.5;

/**
 * 单域索引。对外不暴露，只有 store 持有。
 * `flat` 前 `size * dim` 个元素有效，尾部是预留空间 —— 查询时用 subarray 切出有效段，
 * 零拷贝传给 exactSearch（它只读）。
 */
function createDomainIndex(dim) {
  let cap = 0;
  let flat = new Float32Array(0);
  const ids = [];                       // 下标 → entry_id
  const pos = new Map();                // entry_id → 下标
  let size = 0;
  let dirty = null;                     // 非 null = 本域索引不可信，search 必须返回 null

  function grow(need) {
    if (need <= cap) return;
    let next = cap || 64;
    while (next < need) next = Math.ceil(next * GROWTH);
    const bigger = new Float32Array(next * dim);
    if (size) bigger.set(flat.subarray(0, size * dim));
    flat = bigger;
    cap = next;
  }

  /** 覆盖或追加。vec 必须是长度 = dim 的 Float32Array。 */
  function put(id, vec) {
    const at = pos.get(id);
    if (at !== undefined) {
      flat.set(vec, at * dim);
      return 'updated';
    }
    grow(size + 1);
    flat.set(vec, size * dim);
    ids[size] = id;
    pos.set(id, size);
    size++;
    return 'inserted';
  }

  /**
   * swap-remove：把末尾那条挪到空位，O(1)。
   * 顺序会被打乱 —— 这是刻意的：本索引只按距离排序返回，从不依赖插入顺序。
   */
  function drop(id) {
    const at = pos.get(id);
    if (at === undefined) return false;
    const last = size - 1;
    if (at !== last) {
      flat.copyWithin(at * dim, last * dim, last * dim + dim);
      const movedId = ids[last];
      ids[at] = movedId;
      pos.set(movedId, at);
    }
    ids.length = last;
    pos.delete(id);
    size = last;
    return true;
  }

  return {
    put,
    drop,
    get size() { return size; },
    get dirty() { return dirty; },
    setDirty(reason) { dirty = dirty ?? reason; },   // 首个原因留痕，后续不覆盖
    clearDirty() { dirty = null; },
    bytes: () => cap * dim * 4,
    search(q, k) {
      if (dirty) return null;
      if (!size) return [];
      const view = flat.subarray(0, size * dim);
      const want = Math.min(k, size);
      let res;
      try {
        res = exactSearch(view, q, dim, want, 'cos');
      } catch (err) {
        // 查询炸了：本域索引不可信（可能是并发写入把 flat 改在半路）。
        // 标脏 → 调用方降级 vec0，下次重灌；宁可慢外审，也不返回半截结果。
        dirty = `search-failed: ${String(err?.message ?? err)}`;
        return null;
      }
      const out = new Array(res.keys.length);
      for (let i = 0; i < res.keys.length; i++) {
        // exactSearch 的 keys 是数据行号；cos 度量返回 `1 - cos_sim`，
        // 与 SQLite 侧 `score = 1 - distance` 同构，不用改符号 [R-122]。
        out[i] = { id: ids[Number(res.keys[i])], score: 1 - res.distances[i] };
      }
      return out;
    },
  };
}

/**
 * @param {object} o
 * @param {number} o.dim      向量维度（必须与 entries_vec 一致）
 * @param {() => {enabled:boolean, maxVectors:number}} [o.limits]
 *   每次判定现读配置（不是构造期快照）：`memIndex.enabled` 是热键，改完下外审查询就得是新行为，
 *   否则就是一个点了没反应的空开关（R-43 死旋钮判据）。
 * @param {object} [o.audit]
 */
export function createVecIndexStore({ dim, limits, audit }) {
  const domains = new Map();
  let resident = 0;      // 全库常驻向量总数（用于 maxVectors 闸）
  let refusal = null;    // 全局不可用原因（开关关闭 / usearch 缺失 / 维度非法）

  const lim = () => ({ enabled: true, maxVectors: 200_000, ...(limits?.() ?? {}) });

  const usable = () => {
    if (!lim().enabled) { refusal = 'disabled-by-config'; return false; }
    if (!usearchAvailable()) { refusal = `usearch-unavailable: ${loadError ?? 'not loaded'}`; return false; }
    if (!(dim > 0)) { refusal = `bad-dim: ${dim}`; return false; }
    return true;
  };

  function state(domainId) {
    let st = domains.get(domainId);
    if (!st) { st = createDomainIndex(dim); domains.set(domainId, st); }
    return st;
  }

  return {
    /** 本层是否可能生效（不保证某域已加载）。 */
    get enabled() { return usable(); },
    get refusal() { return refusal; },

    has: (domainId) => domains.has(domainId) && !domains.get(domainId).dirty,

    /**
     * 从 SQLite 行灌一个域。`rows = [{ id, embedding: Buffer }]`。
     * 已加载且不脏 → 直接返回（幂等，查询路径每次都可能调）。脏 → 丢弃重灌。
     * 返回 false 表示该域最终**没有**可用索引，调用方走 vec0。
     */
    load(domainId, rows) {
      if (!usable()) return false;
      const existing = domains.get(domainId);
      if (existing && !existing.dirty) return true;

      if (existing) { resident -= existing.size; domains.delete(domainId); }

      // 先算这批能装多少：超上限就整域不装（装一半的域还不如不装，查询会静默少结果）
      const accept = [];
      for (const r of rows) {
        const b = r.embedding;
        // 维度不符（换模型时的错维残留）→ 跳过，不猜。与 topKByCosine 同一判据。
        if (!b || b.length !== dim * 4) continue;
        accept.push(r);
      }
      // 空域：**不建索引**。这里绝不能"顺手留一个空 state 接住后续写入"——
      // 一旦 rows 是空（真空域，或者读取失败伪装成空），留了 state 之后 upsert 就会往里增量写，
      // 而索引缺全部历史，召回会静默变少。正确做法是让该域保持"未加载"，
      // 后续写入走 skip-unloaded，下次查询时从 SQLite 读到的自然是全量。
      if (!accept.length) return false;
      const maxVectors = lim().maxVectors;
      if (resident + accept.length > maxVectors) {
        refusal = `over-max-vectors: ${resident}+${accept.length}>${maxVectors}`;
        void audit?.write?.('vec-index', {
          event: 'refused-over-limit', domainId, resident, incoming: accept.length, maxVectors,
        }).catch?.(() => {});
        return false;
      }

      const st = state(domainId);
      for (const r of accept) {
        const b = r.embedding;
        // 4 字节对齐才能零拷贝建视图；不对齐（少见）就复制一份，不拿正确性换性能
        const vec = (b.byteOffset % 4 === 0)
          ? new Float32Array(b.buffer, b.byteOffset, dim)
          : new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + dim * 4));
        st.put(r.id, vec);
      }
      resident += accept.length;
      return true;
    },

    search(domainId, q, k) {
      const st = domains.get(domainId);
      return st ? st.search(q, k) : null;
    },

    /** 写入同步：域未加载 = 什么都不做（下次加载时从 SQLite 读到的自然是新数据）。 */
    upsert(domainId, id, vec) {
      const st = domains.get(domainId);
      if (!st || st.dirty) return 'skip-unloaded';
      if (!vec || vec.length !== dim) { st.setDirty('upsert-bad-vector'); return 'dirty'; }
      const before = st.size;
      try {
        st.put(id, vec);
      } catch (err) {
        st.setDirty(`upsert-failed: ${String(err?.message ?? err)}`);
        return 'dirty';
      }
      if (st.size > before) resident += 1;
      return 'ok';
    },

    remove(domainId, id) {
      const st = domains.get(domainId);
      if (!st || st.dirty) return 'skip-unloaded';
      if (st.drop(id)) resident -= 1;
      return 'ok';
    },

    /**
     * rebuild / 维度重建后**必须**整层丢弃。
     * 不做这一步的后果不是变慢，是返回错条目（旧 flat 的 id 映射已与库脱节）。
     */
    clear(reason = 'rebuild') {
      if (domains.size) {
        void audit?.write?.('vec-index', { event: 'cleared', reason, domains: domains.size, vectors: resident })
          .catch?.(() => {});
      }
      domains.clear();
      resident = 0;
      refusal = null;
    },

    markDirty(domainId, reason) {
      const st = domains.get(domainId);
      if (st) st.setDirty(reason);
    },

    stats() {
      const per = {};
      let dirtyCount = 0;
      for (const [d, st] of domains) {
        per[d] = { vectors: st.size, bytes: st.bytes(), dirty: st.dirty };
        if (st.dirty) dirtyCount++;
      }
      return {
        enabled: usable() && !refusal,
        refusal,
        domains: domains.size,
        vectors: resident,
        bytes: [...domains.values()].reduce((s, st) => s + st.bytes(), 0),
        dirtyDomains: dirtyCount,
        maxVectors: lim().maxVectors,
        per,
      };
    },
  };
}

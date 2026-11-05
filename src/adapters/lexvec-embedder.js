/**
 * lexvec 嵌入后端 —— 词向量表方案（零神经网络、纯查表）。
 *
 * 原理：语义来自【预训练词向量表】（别人训练好的 词→向量 对照文件，几十 MB），
 * 本文件只做查表与平均：句子向量 = 句中各词的向量取平均（L2 归一）。
 * 语义知识在表文件里，不在代码里——这就是它比 hash 强、比真模型轻的原因。
 *
 * 词表来源（两档，可叠加）：
 *   1. 内置种子表 SEED_GROUPS：常用记忆词汇的手工语义簇（开箱即可用，16 维）；
 *   2. 外部词表文件（cfg.embedding.lexvecTablePath）：fastText/腾讯词向量的文本格式
 *      （每行 `word v1 v2 ... vD`），用户从预训练发布版裁剪常用词后提供。
 *
 * 分词：正向最长匹配（用词表本身当词典）+ 单字兜底——表里有"矿泉水"就能整体切出。
 * 幂等与接口：与 hash-embedder 完全同构（{ dim, embed }），外加 neighbors()（近邻发现，
 * 供设置页"同义词候选推荐"使用——词向量当发现引擎，词典当人工确认池）。
 */
import { createHash } from 'node:crypto';

const DIM = 32;

// ── 内置种子表：10 个语义簇 × 每簇 16 维簇心 + 词级确定性扰动 ──
const SEED_GROUPS = {
  饮品:   ["喝", "饮品", "茶", "咖啡", "矿泉水", "饮料", "奶茶", "水", "口味"],
  偏好:   ["喜欢", "偏好", "爱", "爱好", "口味", "偏爱", "最爱"],
  游戏:   ["玩", "游戏", "LOL", "英雄联盟", "打", "电竞", "段位"],
  工作:   ["上班", "工作", "排班", "值班", "加班", "周日", "任务", "开会"],
  称呼:   ["我", "用户", "爹", "主人", "本人", "自己"],
  遗忘:   ["忘", "忘记", "删除", "作废", "清掉", "抹掉"],
  性格:   ["性格", "脾气", "相处", "逗", "损", "软"],
  运动:   ["游泳", "运动", "健身", "跑步", "锻炼"],
  身份:   ["是谁", "身份", "什么人", "资料", "信息"],
  查询:   ["查", "检索", "搜", "查找", "记忆", "想起"],
};

function fnv(s) {
  const h = createHash("sha256").update(s).digest();
  return (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
}

/** 从簇心 + 词级确定性扰动生成种子向量（同簇相近、跨簇正交）。 */
function buildSeedTable() {
  const groupNames = Object.keys(SEED_GROUPS);
  const centers = groupNames.map((_, i) => {
    const v = new Float32Array(DIM);
    // 每簇独占 3 个维度（10 簇 × 3 = 30 ≤ DIM=32，互不重叠 → 跨簇正交）
    for (let d = 0; d < 3; d++) v[(i * 3 + d) % DIM] = 1.0 - d * 0.2;
    return v;
  });
  const table = new Map();
  for (const [gi, name] of groupNames.entries()) {
    for (const w of SEED_GROUPS[name]) {
      const v = new Float32Array(DIM);
      for (let d = 0; d < DIM; d++) {
        const noise = ((fnv(`${name}:${w}:${d}`) % 1000) / 1000 - 0.5) * 0.2;   // ±0.1（信噪比：簇心为主，扰动只做区分度）
        v[d] = centers[gi][d] + noise;
      }
      table.set(w.toLowerCase(), v);   // 键必须 lower——segment 查询走 toLowerCase（'LOL' vs 'lol' 的坑）
    }
  }
  return table;
}

/** 归一化（L2）。 */
function l2(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function createLexVecEmbedder({ tablePath, dim = DIM } = {}) {
  // 种子表 + 外部词表（异步加载，加载完成前用种子）
  let table = buildSeedTable();
  let tableDim = dim;
  let loadedExternal = false;

  async function loadExternalTable(p) {
    if (!p || loadedExternal) return;   // 幂等：kernel 与宿主都可能触发，重复调用不重复加载
    const raw = await fsRead(p);
    const ext = new Map();
    let d = -1;
    for (const line of raw.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const w = parts[0];
      if (w.startsWith("#")) continue;                    // 注释行（本测试样例的头部）
      const vec = new Float32Array(parts.length - 1);
      let ok = true;
      for (let i = 1; i < parts.length; i++) {
        const n = Number(parts[i]);
        if (Number.isNaN(n)) { ok = false; break; }       // fastText 头行"词数 维度"混入非数值 → 跳过
        vec[i - 1] = n;
      }
      if (!ok) continue;
      if (d < 0) d = vec.length;
      if (vec.length !== d) continue;
      ext.set(w, l2(vec));
    }
    if (ext.size) {
      table = ext;                       // 外部表完整替代种子（维度以外部为准）
      tableDim = d;
      loadedExternal = true;
    }
  }

  function fsRead(p) { return import("node:fs/promises").then((m) => m.readFile(p, "utf8")); }

  /** 正向最长匹配分词：词表本身当词典，切不出的连续段按单字兜底。 */
  function segment(text) {
    const out = [];
    let i = 0;
    const s = String(text ?? "");
    while (i < s.length) {
      let matched = null, matchedLen = 0;
      for (let len = Math.min(8, s.length - i); len >= 1; len--) {
        const cand = s.slice(i, i + len);
        if (table.has(cand.toLowerCase())) { matched = cand.toLowerCase(); matchedLen = len; break; }
      }
      if (matched) { out.push(matched); i += matchedLen; }
      else {
        const ch = s[i].toLowerCase();
        if (/[\u4e00-\u9fff a-z0-9]/.test(ch)) out.push(ch);   // 单字兜底（表里常有单字向量）
        i += 1;
      }
    }
    return out;
  }

  function embedOne(text) {
    const words = segment(text);
    const v = new Float32Array(tableDim);
    let used = 0;
    for (const w of words) {
      const vec = table.get(w);
      if (!vec || vec.length !== tableDim) continue;
      for (let d = 0; d < tableDim; d++) v[d] += vec[d];
      used++;
    }
    if (used === 0) { v[0] = 1; return l2(v); }   // 全词表外：退化单位向量（互不相似）
    return l2(v);
  }

  /** 近邻发现：word 的余弦 top-k（供设置页同义词候选推荐）。 */
  function neighbors(word, k = 8) {
    const base = table.get(String(word ?? '').toLowerCase());
    if (!base) return { word, neighbors: [], vocabSize: table.size, hasWord: false };
    const nb = [];
    for (const [w, v] of table) {
      if (w === word) continue;
      if (v.length !== base.length) continue;
      let dot = 0;
      for (let d = 0; d < base.length; d++) dot += base[d] * v[d];
      nb.push({ word: w, sim: dot });
    }
    nb.sort((a, b) => b.sim - a.sim);
    return { word, neighbors: nb.slice(0, k), vocabSize: table.size, hasWord: true };
  }

  return {
    get dim() { return tableDim; },   // getter：外部词表加载后维度跟随（驱动 vec 表重建判定）
    kind: "lexvec",
    vocabSize: () => table.size,
    loadedExternal: () => loadedExternal,
    hasWord: (w) => table.has(String(w ?? '').toLowerCase()),
    neighbors,
    loadExternalTable,
    async embed(texts) { return texts.map(embedOne); },
    // 【R-158.4】统一契约：ok = 词表可用（有词才有向量可言）；dim 跟随 tableDim（外部表加载后可能变化）
    close: async () => {},
    health: () => ({ ok: table.size > 0, dim: tableDim, model: 'lexvec', external: loadedExternal }),
  };
}

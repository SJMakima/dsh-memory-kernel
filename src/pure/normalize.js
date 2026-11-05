/**
 * §9.2 归一化 + §16 的 logit 工具。
 *
 * 【R-83】归一化只允许在写 `entry_triples` 时发生；`Entry.triples` 永远是原文。
 * 【R-86】`subjectKey` / `attributeKey` 必须成对使用，`extendVocab` 与 `classifyNovelty`
 *          漏掉任何一个，都会让"同一主体被当成两个"。
 * 【R-79】`normalizeValue` 只 trim，不做 lower —— 与写入侧等宽，不能更宽。
 */
import { createHash, createHmac } from 'node:crypto';

export const collapseWs = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

export const subjectKey = (s) => collapseWs(String(s ?? '').toLowerCase());

// ── 【冲突治理 §2.2】attribute 同义折叠表 ──────────────────────────
// cfg.write.attributeAliases（别名 → 规范名）经 setAttributeAliases 安装后，
// attributeKey 自动把别名折叠到规范名——写入/词表/查表全部走这一个入口，
// 查询侧用 expandAttributeAliases 对 query 做对称替换（R-86 成对纪律不变）。
let attributeAliasMap = new Map();      // 折叠别名 → 规范名（折叠）
let attributeAliasTexts = [];           // 原始别名文本（查询替换用，保留原大小写）

export function setAttributeAliases(aliases) {
  const map = new Map();
  const texts = [];
  for (const [alias, canonical] of Object.entries(aliases ?? {})) {
    const ak = collapseWs(String(alias ?? '')).toLowerCase();
    const ck = collapseWs(String(canonical ?? '')).toLowerCase();
    if (!ak || !ck || ak === ck) continue;
    map.set(ak, ck);
    texts.push(String(alias ?? '').trim());
  }
  attributeAliasMap = map;
  attributeAliasTexts = texts.sort((a, b) => b.length - a.length);   // 长别名先替换
}

export const attributeKey = (a) => {
  const k = collapseWs(String(a ?? '').toLowerCase());
  return attributeAliasMap.get(k) ?? k;
};

// ── 【检索增强】查询同义词典 ──────────────────────────────
// cfg.retrieve.synonymGroups（同义组数组，组内词互为变体）经 setSynonymGroups 安装后，
// ftsSearch 把 query 命中的组内其他词也并入 FTS 匹配（OR），弥补字面检索的变体盲区。
// 与 attributeAliases 的区别：那个折叠【字段值】，这个扩展【查询词】。
let synonymGroupMap = new Map();   // 词（lower） -> 同义组全词列表（含自身）

export function setSynonymGroups(groups) {
  const map = new Map();
  for (const group of Array.isArray(groups) ? groups : []) {
    const words = (Array.isArray(group) ? group : []).map((w) => collapseWs(String(w ?? '')).toLowerCase()).filter(Boolean);
    if (words.length < 2) continue;
    for (const w of words) map.set(w, words);
  }
  synonymGroupMap = map;
}

/** query 中出现组内任一词 → 返回组内其他词（空格分隔；FTS 侧以 *"词"* 前缀查询匹配索引）。 */
export function synonymExtrasFor(query) {
  const q = String(query ?? '');
  if (!q) return '';
  const qLower = q.toLowerCase();
  const extras = new Set();
  for (const [word, group] of synonymGroupMap) {
    if (!qLower.includes(word)) continue;
    for (const w of group) {
      if (w !== word && !qLower.includes(w)) extras.add(w);
    }
  }
  return [...extras].join(' ');
}

/** 查询侧对称（§2.2）：query 里的别名替换成规范名，再做词表匹配。 */
export function expandAttributeAliases(query) {
  let out = String(query ?? '');
  for (const alias of attributeAliasTexts) {
    const canonical = attributeAliasMap.get(alias.toLowerCase());
    if (canonical && out.includes(alias)) out = out.split(alias).join(canonical);
  }
  return out;
}

export const normalizeValue = (v) => String(v ?? '').trim();

/**
 * 剥掉日期时间形态的 token（嵌入与判重专用）。日期/时间戳是注水惯犯、对语义零贡献，
 * 却会在词平均向量里把"同天写的两条不相干事实"拉成假相似——实测"用户想吃火锅，点名
 * 某火锅店（2026-10-27 傍晚）" vs "用户说现在喜欢喝矿泉水（2026-10-27 更新）…" = 0.883，
 * 单凭共享的"用户 + 同一个日期 + 括号旁白"就过了 0.80 判重线。
 * 只剥日期/时间【形态】，不剥裸数字串（QQ 号等标识符不是日期，别误伤）。
 */
export function stripDateLike(text) {
  return String(text ?? '')
    .replace(/\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g, ' ')   // 2026-10-27 / 2026/10/27 / 2026年10月27日
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')                  // 17:09 / 17:09:47
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')                      // 孤立年份 2026（QQ 号等长数字串不受影响）
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 【冲突治理 §2.3】字面相似度：归一化后的字符 bigram Jaccard（0..1）。
 * 用于向量兜底阶段的"字面几乎一样"冗余拦截——不依赖嵌入模型语义。
 */
export function literalJaccard(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa.length || !sb.length) return 0;
  if (sa === sb) return 1;
  const bigrams = (str) => {
    const set = new Set();
    for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
    return set;
  };
  const A = bigrams(normalizeValue(sa));
  const B = bigrams(normalizeValue(sb));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 最长公共子串长度（区分大小写、连续匹配）。用于待定池对账的"实体重叠"判定：
 * 两条记忆字面相似度不高、但共享同一个具体实体（如"芝麻开门"三字连续出现），
 * 且条目类型不同——这是"疑似冲突"的字面信号（真语义对账要等 M7 的 dream s7）。
 */
export function commonSubstringLength(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa.length || !sb.length) return 0;
  let best = 0;
  for (let i = 0; i < sa.length; i++) {
    for (let len = 1; i + len <= sa.length; len++) {
      if (sb.includes(sa.slice(i, i + len))) best = Math.max(best, len);
      else break;
    }
  }
  return best;
}

export const logit = (p) => Math.log(p / (1 - p));
export const sigmoid = (x) => 1 / (1 + Math.exp(-x));

export function sha256(s) {
  return createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

export function hmacSha256(payload, key) {
  return createHmac('sha256', key).update(payload).digest('hex');
}

/** 键名按字典序输出 → 同一 Entry 永远同一字节串（§16.1 serializeForSign）。 */
export function stableStringify(value) {
  const walk = (v) => {
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (v && typeof v === 'object') {
      return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return walk(value);
}

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID（时间有序）—— 只要单调递增 + 26 字符可排序。
 * 时钟回拨时用 `last` 自增兜底，避免同一毫秒内 id 乱序。
 */
let lastMs = 0;
let lastRand = new Uint8Array(10);
export function newUlid(now = Date.now()) {
  let ms = now;
  let rand;
  if (ms <= lastMs) {
    // 同毫秒 / 时钟回拨：把上一次的随机部分 +1
    ms = lastMs;
    rand = new Uint8Array(lastRand);
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 255) { rand[i]++; break; }
      rand[i] = 0;
    }
  } else {
    rand = new Uint8Array(10);
    for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  lastMs = ms;
  lastRand = rand;

  let time = '';
  let t = ms;
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }

  let bits = 0;
  let budget = 0;
  let tail = '';
  for (const byte of rand) {
    budget = (budget << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      tail += B32[(budget >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) tail += B32[(budget << (5 - bits)) & 31];
  return time + tail.slice(0, 16);
}

/**
 * 【R-158.6】Domain ID 唯一校验（R-138 管理入口的正则下沉为共享契约）。
 * 域 id 会直接成为 md 目录名 / sessionId 前缀 / 配额键 / 词表与向量分区名——
 * 放宽字符就是把注入面引进文件系统。所有能造出 domain 的入口都必须过这里。
 */
export const DOMAIN_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

export function validateDomainId(id) {
  const s = String(id ?? '').trim();
  if (!DOMAIN_ID_RE.test(s)) {
    throw new Error(`invalid domain id "${s}": 英文开头，只能含英文字母/数字/下划线/连字符，最长 32 字符`);
  }
  return s;
}

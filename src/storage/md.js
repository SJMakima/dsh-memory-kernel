/**
 * §9.3 Markdown 真相源：条目块的序列化 / 解析 / 定位。
 *
 * 为什么序列化必须无损 [R-88]：
 *   `triples` 是签名对象、也是 entry_triples 的重建来源。Markdown 丢一个大小写，
 *   重建后的条目就会验签失败（中文 lower 是 no-op，所以中文语料永远测不出来）。
 *   因此所有字符串值一律 JSON 转义（带引号），而不是裸写 —— 裸写在 value 含逗号/
 *   冒号/引号时无法回读，这类值在真实抽取结果里很常见。
 *
 * `state:` 块是 C2 的关键 [R-1]：只存 persistence_init 的话，重建后所有条目会"复活"。
 * 这里在文档图示基础上补了两个字段（`persistence_init` / `trust_prior_logit`），
 * 因为 §9.5 第 3 步要求"按 state 块还原生命周期字段"，而这两个字段同样是生命周期状态。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const BLOCK_RE = /^## ([0-9A-HJKMNP-TV-Z]{26})\s*$/gm;

const iso = (ms) => (ms == null ? 'null' : new Date(ms).toISOString());
const ms = (s) => (s == null || s === 'null' ? null : Date.parse(s));

/* ───────────────────────────── 序列化 ───────────────────────────── */

export function serializeEntryBlock(e) {
  const L = [];
  L.push(`## ${e.id}`);
  L.push(`type: ${e.entry_type}`);
  L.push(`observed_at: ${iso(e.observed_at)}`);
  L.push(`recorded_at: ${iso(e.recorded_at)}`);
  L.push(`topic_tags: ${JSON.stringify(e.topic_tags ?? [])}`);
  // 【R-95】情绪必须进真相源：否则 rebuild 会把所有情绪标签洗成 neutral
  // （R-88 的教训——"内存里有、真相源里没有"的字段，重建即丢）。不进签名对象（serializeForSign）。
  if (e.emotion && e.emotion !== 'neutral') L.push(`emotion: ${JSON.stringify(e.emotion)}`);
  if (e.emotion_owner === 'agent') L.push(`emotion_owner: "agent"`);

  const triples = e.triples ?? [];
  if (triples.length === 0) {
    L.push('triples: []');
  } else {
    L.push('triples:');
    for (const t of triples) {
      L.push(`  - { subject: ${JSON.stringify(t.subject)}, attribute: ${JSON.stringify(t.attribute)}, value: ${JSON.stringify(t.value)} }`);
    }
  }

  L.push(`evidence: ${JSON.stringify(e.evidence_links ?? [])}`);
  L.push(`source: ${e.source_ref.adapter_id} / ${JSON.stringify(e.source_ref.locator)}`
    + (e.source_ref.hint ? ` (hint: ${JSON.stringify(e.source_ref.hint)})` : ''));

  const p = e.provenance ?? {};
  L.push('provenance:');
  L.push(`  session_id: ${JSON.stringify(p.session_id ?? '')}`);
  L.push(`  message_ids: ${JSON.stringify(p.message_ids ?? [])}`);
  L.push(`  extract_task_id: ${JSON.stringify(p.extract_task_id ?? '')}`);
  L.push(`  model_version: ${JSON.stringify(p.model_version ?? '')}`);
  L.push(`  extracted_at: ${iso(p.extracted_at)}`);
  L.push(`  source_content_hash: ${JSON.stringify(p.source_content_hash ?? '')}`);

  L.push(`signature: ${e.signature ? JSON.stringify(e.signature) : 'null'}`);
  L.push(`signature_key_id: ${e.signature_key_id ? JSON.stringify(e.signature_key_id) : 'null'}`);

  L.push('state:');
  L.push(`  persistence: ${round(e.persistence_at_decay)}`);
  L.push(`  persistence_init: ${round(e.persistence_init)}`);
  L.push(`  last_decay_at: ${iso(e.last_decay_at)}`);
  L.push(`  gamma_multiplier: ${e.gamma_multiplier}`);
  L.push(`  activation_count: ${e.activation_count}`);
  L.push(`  last_activated_at: ${iso(e.last_activated_at)}`);
  L.push(`  cold: ${e.cold === true}`);
  L.push(`  importance: ${round(e.importance ?? 0.5)}`);   // 【R-144】重要性轴进真相源（R-88：新字段必须进 md）
  L.push(`  trust_prior_logit: ${round(e.trust_prior_logit)}`);
  L.push(`  trust_posterior_logit: ${round(e.trust_posterior_logit)}`);
  L.push(`  superseded_by: ${e.superseded_by ? JSON.stringify(e.superseded_by) : 'null'}`);
  L.push(`  supersedes: ${JSON.stringify(e.supersedes ?? [])}`);

  L.push('text: |');
  for (const line of String(e.text ?? '').split('\n')) L.push(`  ${line}`);
  return `${L.join('\n')}\n`;
}

const round = (n) => (n == null ? 0 : Number(n));

/* ───────────────────────────── 解析 ───────────────────────────── */

function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' ) return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"') || s.startsWith('[') || s.startsWith('{')) {
    try { return JSON.parse(s); } catch { /* 落到下面的宽松分支 */ }
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitTop(s.slice(1, -1)).map(parseScalar);
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** 按顶层逗号切分，忽略引号/括号内的逗号。 */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim() !== '') out.push(buf);
  return out.map((x) => x.trim());
}

function parseFlowMap(s) {
  const inner = s.trim().replace(/^\{/, '').replace(/\}$/, '');
  const obj = {};
  for (const part of splitTop(inner)) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    obj[part.slice(0, i).trim()] = parseScalar(part.slice(i + 1));
  }
  return obj;
}

/**
 * 解析单个条目块。不做"猜字段"的兜底：缺失字段按"新条目"的语义补默认值，
 * 但**这是重建路径**，缺 state 时必须在 audit 里留痕（见 rebuild.js）。
 */
export function parseEntryBlock(block) {
  const lines = block.split('\n');
  const idMatch = /^## ([0-9A-HJKMNP-TV-Z]{26})/.exec(lines[0] ?? '');
  if (!idMatch) return null;

  const e = { id: idMatch[1] };
  const prov = {};
  const state = {};
  let triples = [];
  let section = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('text:')) {
      const body = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.startsWith('  ')) body.push(l.slice(2));
        else if (l.trim() === '') body.push('');
        else break;
        i = j;
      }
      e.text = body.join('\n').trimEnd();
      section = null;
      continue;
    }
    if (line.startsWith('  ')) {
      const trimmed = line.slice(2);
      if (section === 'triples') {
        if (trimmed.startsWith('- ')) triples.push(parseFlowMap(trimmed.slice(2)));
      } else if (section === 'provenance') {
        const i2 = trimmed.indexOf(':');
        if (i2 > 0) prov[trimmed.slice(0, i2).trim()] = parseScalar(trimmed.slice(i2 + 1));
      } else if (section === 'state') {
        const i2 = trimmed.indexOf(':');
        if (i2 > 0) state[trimmed.slice(0, i2).trim()] = parseScalar(trimmed.slice(i2 + 1));
      }
      continue;
    }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();

    switch (key) {
      case 'triples':
        section = rest === '[]' ? null : 'triples';
        if (rest === '[]') triples = [];
        break;
      case 'provenance':
        section = 'provenance';
        break;
      case 'state':
        section = 'state';
        break;
      case 'type': e.entry_type = rest; section = null; break;
      case 'observed_at': e.observed_at = ms(rest); section = null; break;
      case 'recorded_at': e.recorded_at = ms(rest); section = null; break;
      case 'topic_tags': e.topic_tags = parseScalar(rest) ?? []; section = null; break;
      case 'emotion': e.emotion = String(parseScalar(rest) ?? 'neutral'); section = null; break;
      case 'emotion_owner': e.emotion_owner = parseScalar(rest) === 'agent' ? 'agent' : 'user'; section = null; break;
      case 'evidence': e.evidence_links = parseScalar(rest) ?? []; section = null; break;
      case 'signature': e.signature = parseScalar(rest); section = null; break;
      case 'signature_key_id': e.signature_key_id = parseScalar(rest); section = null; break;
      case 'source': e.source_ref = parseSource(rest); section = null; break;
      default: section = null;
    }
  }

  e.triples = triples;
  e.provenance = {
    session_id: prov.session_id ?? '',
    message_ids: prov.message_ids ?? [],
    extract_task_id: prov.extract_task_id ?? '',
    model_version: prov.model_version ?? '',
    extracted_at: ms(prov.extracted_at) ?? e.recorded_at ?? Date.now(),
    source_content_hash: prov.source_content_hash ?? '',
  };
  e.source_ref ??= { adapter_id: 'unknown', locator: 'unknown' };

  e.persistence_at_decay = state.persistence ?? 0;
  e.persistence_init = state.persistence_init ?? state.persistence ?? 0;
  e.last_decay_at = ms(state.last_decay_at) ?? e.recorded_at ?? Date.now();
  e.gamma_multiplier = state.gamma_multiplier ?? 1.0;
  e.activation_count = state.activation_count ?? 0;
  e.last_activated_at = ms(state.last_activated_at);
  e.cold = state.cold === true;
  // 【R-144】旧 md 无 importance 行 → 按 entry_type 推（与写入期判定同规则），rebuild 不丢语义
  e.importance = state.importance
    ?? ((e.entry_type === 'boundary' || e.entry_type === 'skill') ? 1.0 : 0.5);
  e.trust_prior_logit = state.trust_prior_logit ?? 0;
  e.trust_posterior_logit = state.trust_posterior_logit ?? e.trust_prior_logit;
  e.trust_updated_at = e.recorded_at ?? Date.now();
  e.superseded_by = state.superseded_by ?? null;
  e.supersedes = Array.isArray(state.supersedes) ? state.supersedes : [];

  // 以下字段不在 Markdown 里，由调用方（重建 / 落库）补齐
  e.identity_scope = 'domain';
  e.shareable = false;
  e.sensitivity = 'normal';
  e.archived_topic = false;
  // 【R-95】情绪在 Markdown 里（老文件没有 → neutral），owner 缺省 user
  e.emotion ??= 'neutral';
  e.emotion_owner ??= 'user';
  e.text ??= '';
  e.topic_tags ??= [];
  e.entry_type ??= 'fact';
  return e;
}

function parseSource(rest) {
  const i = rest.indexOf(' / ');
  if (i < 0) return { adapter_id: rest.trim(), locator: '' };
  const adapter_id = rest.slice(0, i).trim();
  let tail = rest.slice(i + 3).trim();
  let hint;
  const hm = /\s\(hint: (.+)\)$/.exec(tail);
  if (hm) {
    hint = parseScalar(hm[1]);
    tail = tail.slice(0, hm.index).trim();
  }
  return { adapter_id, locator: parseScalar(tail), ...(hint ? { hint } : {}) };
}

/* ───────────────────────────── 块操作 ───────────────────────────── */

export function countBlocks(md) {
  return (md.match(BLOCK_RE) ?? []).length;
}

export function hasBlock(md, id) {
  return new RegExp(`^## ${id}\\s*$`, 'm').test(md);
}

function blockRange(md, id) {
  const re = new RegExp(`^## ${id}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const start = m.index;
  const nextRe = /^## [0-9A-HJKMNP-TV-Z]{26}\s*$/gm;
  nextRe.lastIndex = start + 1;
  const next = nextRe.exec(md);
  return { start, end: next ? next.index : md.length };
}

/** 覆盖写（该条目已在文件里）不触发切分 —— 否则更新会把自己赶到新分片。 */
export function upsertBlock(md, entry) {
  const serialized = serializeEntryBlock(entry);
  const range = blockRange(md, entry.id);
  if (range) return `${md.slice(0, range.start)}${serialized}${md.slice(range.end)}`;
  const base = md.length === 0 ? '' : md.endsWith('\n\n') ? md : md.endsWith('\n') ? `${md}\n` : `${md}\n\n`;
  return `${base}${serialized}`;
}

export function removeBlock(md, id) {
  const range = blockRange(md, id);
  if (!range) return md;
  return `${md.slice(0, range.start)}${md.slice(range.end)}`.replace(/\n{3,}/g, '\n\n');
}

export function parseMarkdownFile(md) {
  const out = [];
  const re = /^## [0-9A-HJKMNP-TV-Z]{26}\s*$/gm;
  const starts = [];
  let m;
  while ((m = re.exec(md))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const block = md.slice(starts[i], starts[i + 1] ?? md.length);
    const e = parseEntryBlock(block);
    if (e) out.push(e);
  }
  return out;
}

/* ───────────────────────────── 文件 IO ───────────────────────────── */

export async function readFileSafe(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

/** 原子替换：tmp → fsync → rename → fsync(dir)。rename 在同分区上是原子的。 */
export async function writeFileAtomic(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, p);
  try {
    const dh = await fs.open(path.dirname(p), 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch {
    // Windows 上对目录 fsync 会抛 EPERM/EINVAL —— rename 本身已保证原子性，忽略即可
  }
}

export async function listMarkdownFiles(root) {
  const out = [];
  for (const dir of ['domains', 'cold']) {
    const base = path.join(root, dir);
    let doms;
    try { doms = await fs.readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const d of doms) {
      if (!d.isDirectory()) continue;
      const files = await fs.readdir(path.join(base, d.name));
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        out.push(`${root}/${dir}/${d.name}/${f}`.replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

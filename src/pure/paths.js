/**
 * §9.6 路径解析 + §9.3 分片布局。
 *
 * 【路径契约只有一个来源】就是本文件的 `parsePartPath` 正则：
 *   <root>/domains/<domain>/<YYYY-MM-DD>.md           → { date, part: 0 }
 *   <root>/domains/<domain>/<YYYY-MM-DD>.part-NN.md   → { date, part: NN }
 *   <root>/cold/<domain>/<YYYY-MM>.md                 → { date: 'YYYY-MM', part: 0 }
 *
 * 【R-81】分片名是 `2026-10-26.part-01.md`，不是 `2026-10-26/part-01.md`。
 * 按日期子目录写出来的路径会被这里判为非法名 → 不写 files 行 → 分片映射退化成目录扫描。
 */
export const PATH_RE = /(?:^|\/)(\d{4}-\d{2}(?:-\d{2})?)(?:\.part-(\d{2}))?\.md$/;

export const normalizeSlashes = (p) => String(p ?? '').replace(/\\/g, '/');

export function normalizePath(p) {
  return normalizeSlashes(p).replace(/\/{2,}/g, '/');
}

/** 唯一的路径解析器。返回 null 表示"这个文件不归我们管"（不要用默认值兜底）[R-50]。 */
export function parsePartPath(p) {
  const m = PATH_RE.exec(normalizeSlashes(p));
  if (!m) return null;
  return { date: m[1], part: m[2] ? Number(m[2]) : 0 };
}

/** `<root>/(domains|cold)/<domain_id>/<file>.md` → 倒数第二段。 */
export function domainIdOfPath(p) {
  const segs = normalizePath(p).split('/');
  const i = Math.max(segs.lastIndexOf('domains'), segs.lastIndexOf('cold'));
  if (i < 0 || i + 2 >= segs.length) return null;
  return segs[i + 1];
}

export function isColdPath(p) {
  return normalizePath(p).split('/').includes('cold');
}

export function localDate(ms, timeZone) {
  const d = new Date(ms);
  if (!timeZone) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // en-CA 的输出形态正好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function localMonth(ms, timeZone) {
  return localDate(ms, timeZone).slice(0, 7);
}

const pad = (n) => String(n).padStart(2, '0');

export function partFileName(date, part) {
  return part === 0 ? `${date}.md` : `${date}.part-${pad(part)}.md`;
}

export function partPath(root, domainId, date, part) {
  return normalizePath(`${root}/domains/${domainId}/${partFileName(date, part)}`);
}

export function coldPath(root, domainId, ms, timeZone) {
  return normalizePath(`${root}/cold/${domainId}/${localMonth(ms, timeZone)}.md`);
}

export function dateOfPath(p) {
  return parsePartPath(p)?.date ?? null;
}

/** `domains/` 与 `cold/` 下的所有 .md；其余一概不扫。 */
export function isManagedMarkdownPath(root, p) {
  const rel = normalizePath(p).slice(normalizePath(root).length);
  return /^\/(domains|cold)\/[^/]+\/[^/]+\.md$/.test(rel);
}

/**
 * §13.2 三元组词表（`getVocab` / `extendVocab`）。
 *
 * 【R-85】5000 截断必须带次要排序键，否则每次重建选出的主体集合可能不同，
 *         词表缓存不稳定 → `tripleSearch` 的命中面跟着抖。
 * 【R-86】主体与属性**必须成对归一化**：词表里存 `Preference`、库里存 `preference`，
 *         `tripleSearch` 把 `Preference` 塞进 `attribute IN (...)` 就永不命中。
 */
import { subjectKey, attributeKey, collapseWs } from '../pure/normalize.js';

const vocabCache = new Map();

export function getVocab(db, domainId) {
  let v = vocabCache.get(domainId);
  if (!v) {
    v = {
      subjects: new Set(
        db.prepare(`SELECT subject_key FROM entry_triples WHERE domain_id = ?
                    GROUP BY subject_key ORDER BY COUNT(*) DESC, subject_key LIMIT 5000`)
          .all(domainId).map((r) => r.subject_key),
      ),
      attributes: new Set(
        db.prepare('SELECT DISTINCT attribute FROM entry_triples WHERE domain_id = ?')
          .all(domainId).map((r) => r.attribute),
      ),
    };
    vocabCache.set(domainId, v);
  }
  return v;
}

export function extendVocab(domainId, triples) {
  const v = vocabCache.get(domainId);
  if (!v) return;
  for (const t of triples) {
    v.subjects.add(subjectKey(t.subject));
    v.attributes.add(attributeKey(t.attribute));
  }
}

/** dream 后清空该域，让它懒重建（剔除冷存残留）。 */
export function clearVocab(domainId) {
  if (domainId === undefined) vocabCache.clear();
  else vocabCache.delete(domainId);
}

/**
 * `tripleSearch` 的匹配逻辑（纯函数，词表由调用方注入）[R-18]：
 * 只命中 subject / attribute，**不匹配 value**（否则与 FTS 路重叠、同一条目被重复计分），
 * 单字实体不参与，避免误匹配几乎所有 query。
 */
export function matchTripleTerms(query, vocab) {
  // 【R-124】与 subjectKey 同源：保留内部单空格，否则含空格的英文实体永不命中。
  const q = collapseWs(String(query ?? '').toLowerCase());
  const hitSubjects = [...(vocab?.subjects ?? [])].filter((s) => s.length >= 2 && q.includes(s));
  const hitAttrs = [...(vocab?.attributes ?? [])].filter((a) => a.length >= 2 && q.includes(a));
  return { hitSubjects, hitAttrs };
}

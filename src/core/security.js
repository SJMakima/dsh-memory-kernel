/**
 * §16 安全：签名覆盖 provenance（低信任域）+ 信任后验（P1 只留结构）。
 *
 * 三层防御：存储层 HMAC / 检索层回读复核 / 组装层第三方标签。
 * 签名**不证明**内容可信，只证明"来源与未篡改"（C7）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hmacSha256, stableStringify, logit, sigmoid } from '../pure/normalize.js';

/** `serializeForSign` 的字段清单 = §9.3 那张"手改边界"表的判据。 */
export function serializeForSign(e) {
  return stableStringify({
    id: e.id,
    domain_id: e.domain_id,
    text: e.text,
    triples: e.triples,                 // **原文**（内存对象，或 entries.triples 反序列化）
    source_ref: e.source_ref,
    session_id: e.provenance.session_id,
    message_ids: e.provenance.message_ids,
    source_content_hash: e.provenance.source_content_hash,
    observed_at: e.observed_at,
  });
}

export function createSecurity({ cfg, audit }) {
  const keys = new Map();

  function getKey(domainId) {
    if (keys.has(domainId)) return keys.get(domainId);
    fs.mkdirSync(cfg.security.keyDir, { recursive: true, mode: 0o700 });
    const p = path.join(cfg.security.keyDir, `${domainId}.key`);
    let key;
    if (fs.existsSync(p)) {
      key = Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
    } else {
      key = randomBytes(32);
      fs.writeFileSync(p, key.toString('hex'), { mode: 0o600 });
    }
    keys.set(domainId, key);
    return key;
  }

  function signEntry(e) {
    e.signature = hmacSha256(serializeForSign(e), getKey(e.domain_id));
    e.signature_key_id = e.domain_id;
    return e;
  }

  /**
   * 【必须】不能写成 `if (!e.signature) return true` —— 那等于低信任域全部放行。
   * 未签名时的放行条件取决于该域是否 `requireSignature`。
   */
  function verifyEntrySignature(e, getDomain) {
    const domain = getDomain(e.domain_id);
    if (!e.signature) return !domain?.requireSignature;
    const expect = hmacSha256(serializeForSign(e), getKey(e.signature_key_id ?? e.domain_id));
    return timingSafeEqualHex(expect, e.signature);
  }

  return { getKey, signEntry, verifyEntrySignature };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export { logit, sigmoid };

/** trust 后验：命中**不**更新 trust（ADR-11），只有外部信号走这里。 */
export function updateTrustLogit(e, signal, cfg) {
  const lr = cfg.trust.lr[signal];
  if (!lr) return;
  const updated = e.trust_posterior_logit + Math.log(lr);
  e.trust_posterior_logit = cfg.trust.meanReversion * e.trust_prior_logit
    + (1 - cfg.trust.meanReversion) * updated;
  e.trust_updated_at = Date.now();
}

/* ── P2 才打开的信号（P1 `verifiedEnabled=false`，整条链不注册）[R-59] ── */

const REFERENTIAL = /(这个|这条|这条记忆|刚才|上次说|上面那个|你说的)/;
const AFFIRM = /(对|是的|没错|正确|就是|记得|确实是)/;

export function detectVerified(userMsg, cfg) {
  const s = String(userMsg ?? '').trim();
  if (s.length > cfg.trust.verifiedMaxLen) return false;   // 长段叙述不算确认
  if (s.includes('？') || s.includes('?')) return false;   // 反问不算确认
  // 【P2 评测发现】"这个不对 / 你说的不对" 里 AFFIRM 会命中裸"对"——
  // 否定用法当确认，是这条链路唯一能往上调 trust 的误报源。剥掉否定后再匹配。
  const affirmative = s.replace(/(?:不|没|别|并非)对/g, '').replace(/不是/g, '');
  if (!REFERENTIAL.test(affirmative) || !AFFIRM.test(affirmative)) return false;
  return true;
}

/**
 * §9.1 `routeDomain`：session → domain 的解析 [R-77]。
 *
 * `matchSessionId` 是**谓词**，多个域可能同时命中，所以"多重匹配怎么办"必须显式定义：
 *   P0/P1 假设 session 与 domain 一对一；出现多重匹配说明 Adapter 谓词写宽了 ——
 *   **记 audit 并取第一个，但不静默**（这是 P3+ 拆多域 session 时唯一的线索来源）。
 *   不抛错：session 路由在检索入口，抛错 = 整个会话的记忆功能坏掉。
 */
import { validateDomainId } from '../pure/normalize.js';

export function createDomainRegistry({ audit }) {
  const map = new Map();

  /**
   * 【R-158.6】id 校验下沉：任何进 registry 的域都过共享正则。
   * 默认保留"同 id 覆盖"语义（domains-dynamic.test.js 钉死的已定义行为，
   * lib-index 的 exists 检查是运行时唯一闸门）；bootstrap 等不想静默覆盖的
   * 调用方显式传 { replace: false }，撞 id 直接炸而不是悄悄替换。
   */
  function register(domain, { replace = true } = {}) {
    if (!domain?.id) throw new Error('domain.id is required');
    validateDomainId(domain.id);
    if (!replace && map.has(domain.id)) {
      throw new Error(`duplicate domain id "${domain.id}"（无意覆盖防护：确要覆盖请显式 replace: true）`);
    }
    if (typeof domain.matchSessionId !== 'function') {
      domain.matchSessionId = (sid) => String(sid).startsWith(`${domain.id}:`) || sid === domain.id;
    }
    if (!domain.sourceReader) {
      domain.sourceReader = { read: async () => ({ text: '', meta: {} }) };
      domain.sourceReaderIsLocal = false;
    }
    map.set(domain.id, domain);
    return domain;
  }

  function routeDomain(sessionId) {
    const hits = [...map.values()].filter((d) => d.matchSessionId(String(sessionId ?? '')));
    if (hits.length === 0) return null;
    if (hits.length > 1) {
      // 不 await：路由在同步路径上，audit 落盘不能阻塞检索
      audit?.domainAmbiguous({ sessionId, domains: hits.map((d) => d.id) });
    }
    return hits[0];
  }

  return {
    register,
    get: (id) => map.get(id),
    routeDomain,
    list: () => [...map.values()],
  };
}

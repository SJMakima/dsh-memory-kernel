/**
 * 【R-153】Access Gate —— 读取权限的单文件强制入口。
 *
 * 两条铁律（写死在本文件头，任何读路径不得绕过）：
 *   ① `includePrivate` 自报不是凭据：本文件不认识这个参数——普通检索/工具/外部调用
 *      想靠传参打开私有记忆，没有这条通道。运维审计/身份对齐必须另建独立授权接口。
 *   ② `context(entryId)` 不许绕过准入：entry_id 本身不是授权凭据，取回必须走
 *      admitContext 的完整守卫链（可信 sessionId → 域路由 → 成对隐私 → 验签）。
 *
 * 迁移自 retrieve.pairVisible（v4.29 fail-closed 语义原样保留）：
 *   - normal 档不受 origin 管控（全域检索带出身标注，R-109/R-133）；
 *   - ownerIds 白名单配了就硬性生效，缺 viewer = 拒绝（缺身份 ≠ 是 owner）；
 *   - private/shared 缺 provenance.session_id = 拒绝（没有出身就无法判定同源）。
 */
export function createAccessGate({ cfg }) {
  /**
   * 成对隐私可见性判定。req 只认三个可信字段：sessionId / viewer / crossSession 开关——
   * 全部由宿主上下文注入，调用方自报无效（铁律①的另一半：白名单字段之外一律忽略）。
   */
  function pairVisible(e, req) {
    const vis = e.sensitivity ?? 'normal';
    if (vis === 'normal') return true;

    // 【R-111/R-112】speaker 闸：配了 owner 白名单时缺 viewer 也拒绝（fail-closed）。
    const owners = cfg.privacy?.ownerIds ?? [];
    const viewer = req.viewer ?? null;
    if (owners.length && (!viewer || !owners.includes(viewer))) {
      if (vis === 'private') return false;
      if (vis === 'shared' && cfg.privacy?.nonOwnerSeesShared !== true) return false;
    }

    const origin = e.provenance?.session_id ?? null;
    // 【v4.29】private/shared 缺少来源会话 → 默认拒绝；normal 档不受影响（老数据照常用）。
    if (!origin) return false;
    if (origin === req.sessionId) return true;    // 同对话对：可见
    if (vis === 'private') return false;
    return cfg.privacy?.crossSessionSensitivity === true;
  }

  /**
   * 铁律②：context 的准入链。任何一步不过 → null（调用方必须原样返回 null，不得降级）。
   * deps 显式注入（domains / security / loadEntry），gate 不私持内核引用——模块化不引事件总线。
   */
  function admitContext({ entryId, request, domains, security, loadEntry }) {
    if (typeof request?.sessionId !== 'string' || !request.sessionId) return null;
    const e = loadEntry(entryId);
    if (!e) return null;
    const viewerDomain = domains.routeDomain(request.sessionId);
    if (!viewerDomain) return null;
    const accessRequest = {
      sessionId: request.sessionId,
      viewer: request.viewer ?? null,
      includeCold: false,
      includeArchived: false,
      includeSuperseded: false,
      // 不设 includePrivate：铁律①，能力不能由请求参数授予
    };
    if (!pairVisible(e, accessRequest)) return null;
    // 与检索 admit 同语义的硬排除：被取代的旧账、冷存条目不单独取回
    if (e.superseded_by != null) return null;
    if (e.cold) return null;
    if (!security.verifyEntrySignature(e, (id) => domains.get(id))) return null;
    return { entry: e, domain: viewerDomain, accessRequest };
  }

  return { pairVisible, admitContext };
}

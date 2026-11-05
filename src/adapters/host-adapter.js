/**
 * 【R-158.1】Host Adapter —— 宿主 API 形态差异的统一收口。
 *
 * 立项理由：`ctx.registerTool` 的宿主写法有两种——(descriptor, handler) 与
 * (name, parameters, handler)。旧代码在 src/index.js 里用 `registerTool.length >= 3`
 * 猜参数个数，但**包装函数 / rest 参数 / 默认参数都能改变 `.length`**（包装后恒 0），
 * 猜错 = 工具注册成残废且无报错。本适配器是全库唯一认识宿主形态差异的地方。
 *
 * 判定顺序（与 docs/host-compat-matrix.md 的 claimed/verified 对齐）：
 *   ① 显式声明：createPlugin({ hostToolStyle }) —— 人说了一律听人的；
 *   ② 宿主自报：ctx.hostToolStyle 字段（宿主适配层的自我描述）；
 *   ③ 能力探测：宿主同时提供 listTools + unregisterTool 时，注册哨兵工具验证
 *      descriptor 式是否真被接受（验完即注销，不留垃圾）；
 *   ④ 兜底启发式：`.length >= 3`（保留但只作为最后手段，且集中在这一处）。
 *
 * hooks / provide 同样经此转发——宿主差异以后只改这个文件。
 */
export function createHostAdapter(ctx, options = {}) {
  let style = options.toolStyle ?? ctx?.hostToolStyle ?? null;

  function detectStyle() {
    if (style) return style;
    const reg = ctx?.registerTool;
    if (typeof reg !== 'function') return 'none';
    // ③ 能力探测：只在宿主给了 listTools + unregisterTool 时做（验完能收拾干净）
    if (typeof ctx.listTools === 'function' && typeof ctx.unregisterTool === 'function') {
      const PROBE = '__dsh_host_probe__';
      try {
        reg({ name: PROBE, description: 'host style probe', parameters: { type: 'object', properties: {} } }, () => {});
        const listed = ctx.listTools();
        const names = (Array.isArray(listed) ? listed : (listed?.tools ?? []))
          .map((t) => (typeof t === 'string' ? t : t?.name));
        style = names.includes(PROBE) ? 'descriptor' : 'args';
      } catch {
        style = 'args';
      }
      try { ctx.unregisterTool(PROBE); } catch { /* 探针注销失败 = 宿主自己保证，不再纠缠 */ }
      return style;
    }
    // ④ 兜底启发式（唯一保留 .length 的地方；判定依据进 host-compat-matrix）
    style = reg.length >= 3 ? 'args' : 'descriptor';
    return style;
  }

  return {
    get toolStyle() { return detectStyle(); },

    /** 注册工具：descriptor 是本插件的规范形态，宿主形态差异在这里消化。 */
    registerTool(descriptor, handler) {
      const s = detectStyle();
      if (s === 'args') ctx.registerTool(descriptor.name, descriptor.parameters, handler);
      else if (s === 'descriptor') ctx.registerTool(descriptor, handler);
      // 'none'：宿主没有工具通道，静默跳过（钩子照常工作）
      return s !== 'none';
    },

    /** 已注册工具名清单（宿主支持 listTools 时可做注册后断言）。 */
    listToolNames() {
      if (typeof ctx?.listTools !== 'function') return null;
      try {
        const listed = ctx.listTools();
        return (Array.isArray(listed) ? listed : (listed?.tools ?? []))
          .map((t) => (typeof t === 'string' ? t : t?.name));
      } catch { return null; }
    },

    hook(name, fn, opts) {
      if (typeof ctx?.hook !== 'function') return false;
      try { ctx.hook(name, fn, opts); return true; } catch { return false; }
    },

    provide(name, value) {
      if (typeof ctx?.provide !== 'function') return false;
      try { ctx.provide(name, value); return true; } catch { return false; }
    },
  };
}

/**
 * 【LLM 接入 · R-127~R-130】选路器：按 cfg.llm 决定给不给内核一个 transport。
 *
 *   llm.enabled=false  → 返回 null（抽取器不构造，与接入前完全一致：骨架在、不产候选）
 *   transport='host'   → createHostLlm(ctx.llm)     —— key 不进插件（路径 B）
 *   transport='local'  → createChatLlm(本地端点)    —— Ollama / LM Studio / vLLM
 *   transport='custom' → createChatLlm(云 API)      —— key 优先环境变量
 *
 * 三条纪律（写在这里省得以后有人"优化"掉）：
 *   1. **不静默降级**：配了 host 但本实例没有宿主服务（headless / CLI / 导入器），
 *      不偷偷换成 custom —— 返回一个"调用即报错"的 transport，错误信息写清原因。
 *   2. **不猜模型**：provider/model 空着就报错，不从别处推断（宿主默认模型会变，写死就是坏账）。
 *   3. **配置错也要能启动**：构造期只 audit，报错推迟到 complete()——插件起不来比抽不出记忆更严重。
 */
import { createChatLlm } from './llm-chat.js';
import { createHostLlm } from './host-llm.js';

/** 配错了：能构造、调用即抛（错误信息本身就是给用户看的说明书）。 */
function brokenLlm(kind, message) {
  return {
    kind,
    model: '',
    available: () => false,
    async complete() { throw new Error(`llm(${kind}): ${message}`); },
  };
}

/**
 * @param {{ cfg: object, hostLlm?: object|null, audit?: { write: Function }, env?: NodeJS.ProcessEnv }} args
 * @returns {object|null} transport（含 complete）或 null（关闭）
 */
export function createLlmRouter({ cfg, hostLlm = null, audit = null, env = process.env } = {}) {
  const c = cfg?.llm ?? {};
  if (!c.enabled) return null;

  const note = (kind, message) => {
    // 审计写不进去不能反过来影响启动：吞掉 audit 的错，但不吞 message
    try { void audit?.write?.('llm', { kind, message }); } catch { /* noop */ }
  };

  const transport = String(c.transport ?? 'host');
  const maxTokens = Number(c.maxTokens) > 0 ? Number(c.maxTokens) : 1024;
  const timeoutMs = Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 60_000;

  if (transport === 'host') {
    const usable = typeof hostLlm?.prepareCall === 'function';
    if (!usable) {
      note('llm-unavailable', 'transport=host 但本实例没有宿主 llm 服务（headless / CLI），host 档不可用');
      return brokenLlm('host', '当前实例没有宿主 llm 服务（headless / CLI / 旁路导入器）——请改用 local 或 custom 档');
    }
    const provider = String(c.host?.provider ?? '');
    const model = String(c.host?.model ?? '');
    if (!provider || !model) {
      note('llm-misconfigured', 'transport=host 但 provider/model 为空');
      return brokenLlm('host', '未选 provider/model——请在设置页「LLM 接入」里选宿主模型');
    }
    return createHostLlm(hostLlm, { provider, model, maxTokens, timeoutMs });
  }

  if (transport === 'local') {
    const baseUrl = String(c.local?.baseUrl ?? '').trim();
    const model = String(c.local?.model ?? '').trim();
    if (!baseUrl || !model) {
      note('llm-misconfigured', 'transport=local 但 baseUrl/model 为空');
      return brokenLlm('local', '本机端点未配全（baseUrl + model 都要）');
    }
    // 本地端点多数不要 key；OpenAI 兼容层需要字符串占位
    return createChatLlm({ baseUrl, model, apiKey: String(c.local?.apiKey ?? '') || 'local', timeoutMs });
  }

  if (transport === 'custom') {
    const baseUrl = String(c.custom?.baseUrl ?? '').trim();
    const model = String(c.custom?.model ?? '').trim();
    const envName = String(c.custom?.apiKeyEnv ?? '').trim();
    const apiKey = (envName && env ? String(env[envName] ?? '') : '') || String(c.custom?.apiKey ?? '');
    if (!baseUrl || !model) {
      note('llm-misconfigured', 'transport=custom 但 baseUrl/model 为空');
      return brokenLlm('custom', '云端点未配全（baseUrl + model 都要）');
    }
    if (!apiKey) {
      note('llm-misconfigured', `transport=custom 但取不到 apiKey（环境变量 ${envName || '(未设)'} 与文件值都为空）`);
      return brokenLlm('custom', `取不到 apiKey——设置环境变量 ${envName || 'DSH_MEMORY_LLM_API_KEY'} 或在设置页填 key`);
    }
    return createChatLlm({ baseUrl, model, apiKey, timeoutMs });
  }

  note('llm-misconfigured', `未知 transport: ${transport}`);
  return brokenLlm(transport, `未知 transport "${transport}"（只支持 host / local / custom）`);
}

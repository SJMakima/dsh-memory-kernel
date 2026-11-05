/**
 * 【LLM 接入 · R-130】宿主通道 transport —— 复用 DSH 的 `ctx.llm` 服务（路径 B）。
 *
 * 为什么走服务而不是读宿主 key 文件（路径 A）：key 的所有权留在宿主（Models 页），插件只见服务，
 * 密钥不散落到各个插件里；且宿主的记账 / 重试（dsh-llm-retry）/ 配额都在服务层统一做，插件不用重造。
 *
 * 与 `llm-chat.js` 同契约：`complete({ system, messages }) => string`，core 对背后是谁无感知。
 * 调用面（据宿主 @deepseek-ai/dsh-llm v0.2.1-rc.3 实测）：
 *   const call = await llm.prepareCall({ provider, model, maxTokens }, signal)
 *   for await (const chunk of call.stream({ ...call.config, messages, system, purpose, signal })) ...
 *   用 BlockAssembler 聚合，取 text block 拼成字符串。
 *
 * 边界：
 *   · 宿主辅助函数（BlockAssembler / createUserMessage）动态导入——插件在自己的目录里跑，
 *     导入失败时退化为"普通消息对象 + 自建 chunk 拼接"，不因为少一个构造器就整条路死掉；
 *   · 超时抛错、不重试（与 llm-chat.js 一致：重试是抽取层的事）。
 */

/**
 * 从流式 chunk 里抠正文文本。
 *
 * 【R-140】必须按 chunk.type 过滤，不能按字段名抓。dsh-llm 的流里 `reasoning-delta`
 * （思考增量）与 `text-delta`（正文增量）**同形**——都带 `.text` 字段——按"有没有 text"
 * 抓会把整段思考拼进返回值。实测症状：llm-test 返回的全是推理过程、PONG 一个字没有；
 * 抽取管线每轮拿到思考文本，JSON 解析必炸（extract-failed 里的
 * "Unexpected non-whitespace character after JSON" 就是它）。
 *
 * 增量（text-delta）与完整块（text）按 index 分桶，完整块优先——防止两者都在流里时同一句算两遍。
 */
function chunkTextBuckets() {
  return new Map();   // index -> { delta: '', full: null }
}

function collectText(parts, chunk) {
  if (!chunk || typeof chunk !== 'object') return;
  const t = typeof chunk.type === 'string' ? chunk.type : '';
  // 思考与工具调用不是正文：reasoning-delta 带 .text（与 text-delta 同形），必须在这里挡掉
  if (t.startsWith('reasoning') || t === 'thinking' || t.startsWith('tool-call')) return;
  const idx = Number.isInteger(chunk.index) ? chunk.index : 0;
  const p = parts.get(idx) ?? { delta: '', full: null };
  if (t === 'text-delta') {
    p.delta += typeof chunk.text === 'string' ? chunk.text : (typeof chunk.delta === 'string' ? chunk.delta : '');
  } else if (t === 'text' && typeof chunk.text === 'string') {
    p.full = (p.full ?? '') + chunk.text;
  } else if (typeof chunk.text === 'string') {
    // 无类型但带 text 的未知形状：当完整块兜底（旧宿主版本兼容）
    p.full = (p.full ?? '') + chunk.text;
  } else if (chunk.block && typeof chunk.block.text === 'string' && chunk.block.type !== 'reasoning') {
    p.full = (p.full ?? '') + chunk.block.text;
  }
  parts.set(idx, p);
}

function drainText(parts) {
  return [...parts.keys()].sort((a, b) => a - b)
    .map((i) => { const p = parts.get(i); return (p.full != null && p.full !== '') ? p.full : p.delta; })
    .join('');
}

/** 从 BlockAssembler 的 blocks() 里取文本。 */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && (b.type === undefined || b.type === 'text'))
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .join('');
}

/** 宿主辅助函数：拿不到就返回 null（退化路径）。 */
async function loadHostHelpers() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    if (typeof mod?.BlockAssembler === 'function' && typeof mod?.createUserMessage === 'function') {
      return mod;
    }
  } catch { /* 宿主包不可解析：退化 */ }
  return null;
}

/**
 * @param {object} llmService 宿主的 llm 服务（ctx.llm），需有 prepareCall
 * @param {{ provider: string, model: string, maxTokens?: number, timeoutMs?: number, purpose?: string }} opt
 */
export function createHostLlm(llmService, {
  provider,
  model,
  maxTokens = 1024,
  timeoutMs = 60_000,
  purpose = 'memory-extract',
} = {}) {
  let helpersPromise = null;
  const helpers = () => (helpersPromise ??= loadHostHelpers());

  return {
    kind: 'host',
    model,
    /** 探测本实例是否真的能调（headless 实例没有 ctx.llm）。 */
    available() {
      return typeof llmService?.prepareCall === 'function';
    },
    async complete({ system, messages }) {
      if (!this.available()) {
        throw new Error('llm(host): 当前实例没有宿主 llm 服务（headless / CLI / 旁路导入器）——请改用 local 或 custom 档');
      }
      if (!provider || !model) {
        throw new Error('llm(host): 未选 provider/model——请在设置页「LLM 接入」里选宿主模型');
      }
      const h = await helpers();
      const signal = AbortSignal.timeout(timeoutMs);
      const call = await llmService.prepareCall({ provider, model, maxTokens }, signal);

      const plain = (messages ?? []).map((m) => String(m?.content ?? ''));
      const msgs = h
        ? plain.map((text) => h.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-memory-kernel' } }))
        // 退化路径：手搓同等结构（role + content 数组）。纯字符串 content 在宿主侧会被丢弃——
        // 实测症状是"流只有一个 finish 块、零文本"，极难归因。
        : plain.map((text) => ({ role: 'user', content: [{ type: 'text', text }] }));

      const options = { ...(call.config ?? {}), messages: msgs, system, purpose, signal };

      // 诊断袋：一条文本都抠不出来时，把流里到底出现了什么形状带进错误信息——
      // 否则只能看到"没有文本输出"，分不清是模型拒答、鉴权失败还是形状不认识。
      const shapes = [];
      const note = (c) => {
        if (shapes.length >= 6) return;
        try {
          const kind = typeof c === 'object' && c !== null ? (c.type ?? c.blockType ?? Object.keys(c).slice(0, 4).join('|')) : typeof c;
          const s = String(kind);
          if (!shapes.includes(s)) shapes.push(s);
        } catch { /* noop */ }
      };

      if (h) {
        const assembler = new h.BlockAssembler();
        for await (const chunk of call.stream(options)) { note(chunk); assembler.push(chunk); }
        const text = blocksText(assembler.blocks?.() ?? []);
        if (text) return text;
        throw new Error(`llm(host): 流已结束但聚合不出文本块（chunk 形状：${shapes.join(' / ') || '无'}）`);
      }

      // 【R-140】退化路径重写：按 chunk.type 分桶收集（增量与完整块去重、思考块挡掉）。
      // 旧的"见到 .text 就拼"会把 reasoning-delta 的思考全文混进返回值——extract-failed 的真凶。
      const parts = chunkTextBuckets();
      let finishSeen = null;
      for await (const chunk of call.stream(options)) {
        note(chunk);
        if (chunk && (chunk.type === 'finish' || chunk.finish !== undefined)) finishSeen = chunk;
        collectText(parts, chunk);
      }
      const out = drainText(parts);
      if (!out) {
        let detail = '';
        try { detail = JSON.stringify(finishSeen ?? {}).slice(0, 300); } catch { /* noop */ }
        throw new Error(`llm(host): 流已结束但没有文本输出（assisted=${Boolean(h)}｜chunk 形状：${shapes.join(' / ') || '无'}｜finish=${detail}）`);
      }
      return out;
    },
  };
}

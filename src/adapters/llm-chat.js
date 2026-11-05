/**
 * OpenAI 兼容的 chat transport —— P0b 的 LLM 注入点。
 *
 * 接口只有 `complete({ system, messages }) => string`，**schema / 提示词 / JSON 解析都不在这里**
 * （那是 core/extract.js 的事）：换模型、换厂商只动这个文件，core 不知道"LLM 长什么样"。
 * 超时抛错、不重试 —— 重试是抽取层的事（它才知道哪一步值得重试）。
 */

export function createChatLlm({
  baseUrl = 'https://api.openai.com/v1',
  apiKey,
  model,
  timeoutMs = 30_000,
  temperature = 0,
} = {}) {
  if (!apiKey) throw new Error('createChatLlm: 缺少 apiKey');
  if (!model) throw new Error('createChatLlm: 缺少 model');
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;

  return {
    model,
    /** 返回助手的文本回复；HTTP/网络/超时一律抛错（由调用方决定重试语义）。 */
    async complete({ system, messages }) {
      const body = JSON.stringify({
        model,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...(messages ?? []).map((m) => ({
            role: m.role ?? 'user',
            content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
          })),
        ],
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`llm http ${res.status}: ${detail.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('llm 响应缺 choices[0].message.content');
      return text;
    },
  };
}

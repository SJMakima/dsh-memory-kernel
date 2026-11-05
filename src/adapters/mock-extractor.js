/**
 * 抽取器的测试替身 —— 与真 LLM 同一接口（`complete({system, messages}) => string`）。
 *
 * 为什么要"装成 LLM"而不是直接给候选数组：P0b 要验的是**整条链**（JSON 解析 → 清洗 →
 * 四分类 → 落盘），替身走完同一条路才能暴露"解析层把好候选弄坏"这类问题。
 * 真模型只在宿主里接（`createChatLlm`），单测里跑 600MB 模型是给自己找不痛快。
 */

/** 脚本化替身：`fn({system, messages}) => string`，返回值就是"模型输出"。 */
export function createMockExtractor(fn) {
  let calls = 0;
  return {
    model: 'mock-extractor',
    calls: () => calls,
    async complete(args) {
      calls++;
      const out = await fn(args);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}

/** 便捷脚本：按调用次序出队，耗尽后一直返回最后一个（缺省 []）。 */
export function createScriptedExtractor(outputs) {
  const list = [...outputs];
  return createMockExtractor(() => (list.length > 1 ? list.shift() : list[0] ?? []));
}

/**
 * 规则版"抽取器"（demo 用）：不是语义模型，只是把几种最常见的中文句式翻成候选，
 * 让 demo 不用配 apiKey 也能跑通 P0b 全链。**别在测试里依赖它的分类正确性**——
 * 测试请用 createScriptedExtractor 精确控制输出。
 */
export function createRuleExtractor() {
  return createMockExtractor(({ messages }) => {
    const text = [...(messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
    const out = [];
    const like = text.match(/(?:喜欢|爱|常|迷上|离不开|每天)(?:喝|吃|用|看|来|上)?(?:一?杯|点|些)?([\u4e00-\u9fa5A-Za-z0-9]{1,12})/);
    if (like) {
      out.push({
        text: `用户喜欢${like[1]}`,
        entry_type: 'fact',
        topic_tags: ['偏好'],
        triples: [{ subject: '用户', attribute: '偏好', value: like[1] }],
      });
    }
    if (/不要|别再|禁止|一律|必须/.test(text)) {
      out.push({
        text: text.slice(0, 80),
        entry_type: 'boundary',
        topic_tags: ['边界'],
        triples: [{ subject: '用户', attribute: '边界', value: text.slice(0, 30) }],
      });
    }
    return out;
  });
}

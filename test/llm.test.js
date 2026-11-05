/**
 * LLM 接入（R-127~R-130）：选路器 + 宿主通道 transport。
 *
 * 三条纪律各钉一条测试，防止以后被"顺手优化"掉：
 *   1. 关闭 = 返回 null（抽取器不构造，行为与接 LLM 前一致）；
 *   2. 不静默降级（配了 host 但没有宿主服务 → 调用即报错，绝不偷偷走 custom）；
 *   3. 不猜模型（provider/model 空 → 报错，不从别处推断）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlmRouter } from '../src/adapters/llm-router.js';
import { createHostLlm } from '../src/adapters/host-llm.js';

const baseCfg = (llm) => ({ llm });

test('llm.enabled=false → 返回 null（抽取器不构造，行为与接入前一致）', () => {
  assert.equal(createLlmRouter({ cfg: baseCfg({ enabled: false, transport: 'host' }) }), null);
  assert.equal(createLlmRouter({ cfg: {} }), null);
  assert.equal(createLlmRouter({}), null);
});

test('local 档：配全 → 拿到可调用的 transport；缺 model → 调用即报错', async () => {
  const ok = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'local', local: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } }),
  });
  assert.equal(typeof ok.complete, 'function');
  assert.equal(ok.model, 'm');

  const broken = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'local', local: { baseUrl: 'http://127.0.0.1:9/v1', model: '' } }),
  });
  assert.equal(broken.available(), false);
  await assert.rejects(() => broken.complete({ messages: [{ content: 'x' }] }), /未配全/);
});

test('custom 档：key 优先读环境变量，其次文件值；都没有 → 报错且提示变量名', async () => {
  const fromEnv = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'custom', custom: { baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'MY_KEY', apiKey: '' } }),
    env: { MY_KEY: 'sk-env' },
  });
  assert.equal(fromEnv.model, 'm', '环境变量有 key 时应构造成功');

  const none = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'custom', custom: { baseUrl: 'https://x/v1', model: 'm', apiKeyEnv: 'MY_KEY', apiKey: '' } }),
    env: {},
  });
  await assert.rejects(() => none.complete({ messages: [{ content: 'x' }] }), /MY_KEY/);
});

test('host 档：本实例没有宿主服务 → 调用即报错，绝不静默降级', async () => {
  const r = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'host', host: { provider: 'deepseek', model: 'deepseek-chat' } }),
    hostLlm: null,
  });
  assert.equal(r.kind, 'host');
  assert.equal(r.available(), false);
  await assert.rejects(() => r.complete({ messages: [{ content: 'x' }] }), /没有宿主 llm 服务/);
});

test('host 档：provider/model 为空 → 报错（不猜宿主默认模型）', async () => {
  const fake = { prepareCall: async () => ({ config: {}, stream: async function* () { yield { text: 'x' }; } }) };
  const r = createLlmRouter({
    cfg: baseCfg({ enabled: true, transport: 'host', host: { provider: '', model: '' } }),
    hostLlm: fake,
  });
  await assert.rejects(() => r.complete({ messages: [{ content: 'x' }] }), /未选 provider\/model/);
});

test('host transport：prepareCall → 流聚合（无宿主辅助包时走自建拼接）', async () => {
  let seen = null;
  const fake = {
    async prepareCall(route, signal) {
      seen = { route, hasSignal: Boolean(signal) };
      return {
        config: { temperature: 0 },
        async *stream(options) {
          assert.ok(Array.isArray(options.messages), 'messages 必须传给 stream');
          assert.equal(options.purpose, 'memory-extract');
          // 【R-140】dsh-llm 实测形状：reasoning-delta 与 text-delta 同形带 .text，
          // 思考必须挡掉；完整块（type:'text'）按 index 覆盖增量，不算两遍。
          yield { type: 'reasoning-delta', index: 0, text: '（思考：这句话该回什么）' };
          yield { type: 'text-delta', index: 1, text: '你好' };
          yield { type: 'text-delta', index: 1, text: '，世界' };
          yield { type: 'text', index: 1, text: '你好，世界' };
        },
      };
    },
  };
  const llm = createHostLlm(fake, { provider: 'deepseek', model: 'deepseek-chat' });
  const out = await llm.complete({ system: 'sys', messages: [{ content: 'hi' }] });
  assert.equal(out, "你好，世界", "完整块覆盖增量，思考不混入");
  assert.equal(seen.route.provider, 'deepseek');
  assert.equal(seen.route.model, 'deepseek-chat');
  assert.equal(seen.hasSignal, true, '调用必须带超时 signal');
});

test('host transport：空流 → 抛错（不返回空串冒充成功）', async () => {
  const fake = { prepareCall: async () => ({ config: {}, stream: async function* () { /* 无输出 */ } }) };
  const llm = createHostLlm(fake, { provider: 'p', model: 'm' });
  await assert.rejects(() => llm.complete({ messages: [{ content: 'x' }] }), /没有文本输出|聚合不出文本/);
});

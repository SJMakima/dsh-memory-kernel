/**
 * 【R-140】两个"她没记住"的根因修复：
 *   ① host-llm 退化路径按字段名抓文本 → reasoning-delta（思考）被当成正文，
 *      抽取管线每轮 JSON 解析必炸（extract-failed 的 "position 2" 家族）；
 *   ② 她的回复不进 transcript（pre-step 的 messages 只有用户侧输入）→ 由
 *      lib-index 的 assistant-stream 订阅补记（那条在宿主环境里，这里测内核侧契约）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostLlm } from '../src/adapters/host-llm.js';
import { parseCandidatesJson } from '../src/core/extract.js';

/** 假宿主 llm 服务：按给定 chunk 序列流式产出（模拟 dsh-llm v0.2.1-rc.3 实测形状）。 */
function fakeLlmService(chunks) {
  return {
    async prepareCall(_opt, _signal) {
      return {
        config: { provider: 'p', model: 'm' },
        async *stream(_options) { for (const c of chunks) yield c; },
      };
    },
  };
}

const reasoning = (s) => ({ type: 'reasoning-delta', index: 0, text: s });
const answer = (s) => ({ type: 'text-delta', index: 1, text: s });

test('R-140 host-llm：思考增量不进返回值，正文完整', async () => {
  const llm = createHostLlm(fakeLlmService([
    reasoning('用户这句话里有值得记的偏好吗？让我想想。'),
    reasoning('输出 [{"text":"用户喜欢喝咖啡"}]。'),
    answer('[{"text":"用户喜欢喝咖啡","subject":"用户","attribute":"偏好","value":"喝咖啡"}]'),
  ]), { provider: 'p', model: 'm' });
  const out = await llm.complete({ system: 'x', messages: [{ content: 'y' }] });
  // 思考里故意放了 [{...}]——按字段名抓的话它会被当成正文，JSON 解析报 "position 2" 家族错误
  assert.ok(!out.includes('让我想想'), '思考内容不得混入');
  assert.match(out, /喜欢喝咖啡/);
  assert.equal(parseCandidatesJson(out).length, 1);
});

test('R-140 host-llm：完整块与增量同流时不算两遍', async () => {
  const llm = createHostLlm(fakeLlmService([
    answer('你好'),
    { type: 'text', index: 1, text: '你好' },   // 某些宿主版本会再发一个完整块
  ]), { provider: 'p', model: 'm' });
  const out = await llm.complete({ system: 'x', messages: [{ content: 'y' }] });
  assert.equal(out, '你好', '同一 index：完整块覆盖增量，不重复');
});

test('R-140 host-llm：纯思考输出 = 没有正文，报错而不是把思考交出去', async () => {
  const llm = createHostLlm(fakeLlmService([
    reasoning('想来想去没有值得记的。'),
  ]), { provider: 'p', model: 'm' });
  await assert.rejects(() => llm.complete({ system: 'x', messages: [{ content: 'y' }] }),
    /没有文本输出/);
});

test('R-140 parseCandidatesJson：剥离 <think> 内联思考（custom/local 档兼容）', () => {
  const raw = '<think>用户喜欢咖啡，输出数组。</think>\n```json\n[{"text":"用户喜欢喝咖啡"}]\n```';
  const list = parseCandidatesJson(raw);
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '用户喜欢喝咖啡');
});

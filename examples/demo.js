/**
 * 端到端演示：写入 → 检索 → 组装 → dream，并把 Markdown 真相源留在 ./.demo 里。
 *   node examples/demo.js           # 默认清空重建，保证输出可复现
 *   node examples/demo.js --keep    # 保留上次数据（可观察二次写入的分片/更新行为）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createRuleExtractor } from '../src/adapters/mock-extractor.js';
import { createTools } from '../src/index.js';

const root = path.join(process.cwd(), '.demo');
if (!process.argv.includes('--keep')) await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });

// 原始档案（只读）：回读复核会用它验证"三元组的 value 能在原文里找到"
const archive = path.join(root, 'archive');
await fs.mkdir(archive, { recursive: true });
await fs.writeFile(path.join(archive, 'qq-group.jsonl'), [
  { id: 'm1', text: '我基本每天两杯咖啡，早上那杯必须的，不加糖', at: Date.now() - 86_400_000 },
  { id: 'm2', text: '以后都用中文回复我就行，别整英文', at: Date.now() - 3_600_000 },
  { id: 'm3', text: '记忆库那套东西，Markdown 存真相，SQLite 只是索引，删了能重建', at: Date.now() - 90_000 },
].map((x) => JSON.stringify(x)).join('\n') + '\n');

const domain = defineDomain({ id: 'qq-group', dir: archive, requireSignature: true });

// P0b：注入抽取器（demo 用规则版，零配置；生产换 createChatLlm({ apiKey, model })）
const llm = createRuleExtractor();

const kernel = await createKernel({
  config: {
    storage: { root, dbPath: path.join(root, 'index.db') },
    embedding: { dim: 128 },
    assemble: { tokenBudget: { guide: 150, stable: 600, dynamic: 1200 } },
  },
  domains: [domain],
  llm,
});

const boot = await kernel.init();
console.log('boot（就绪标志不等模型）:', boot);
await kernel.whenEmbeddingReady();   // 演示脚本单发，等一次；宿主不该等
console.log('embedding ready:', kernel.vec.enabled);

const tools = createTools(kernel);
const remember = (text, triples, locator, extra = {}) => tools.memory_remember.handler({
  text,
  type: extra.type ?? 'fact',
  domain: 'qq-group',
  topic_tags: extra.tags ?? ['偏好'],
  triples,
  source: { adapter_id: 'qq-group', locator: `msg:${locator}` },
}, { sessionId: 'qq-group:8823' });

await remember('用户每天两杯咖啡，早上那杯不加糖', [{ subject: '用户', attribute: '偏好', value: '咖啡' }], 'm1');
await remember('用户要求一律用中文回复', [{ subject: '用户', attribute: '偏好', value: '用中文回复' }], 'm2');
await remember('Markdown 是真相源，SQLite 可从它完全重建', [{ subject: '记忆系统', attribute: '架构', value: 'Markdown 真相源' }], 'm3', { tags: ['架构'] });
await remember('用户说话偏好简短，不要铺垫', [{ subject: '用户', attribute: '偏好', value: '简洁' }], 'm4');

// boundary / skill 进**稳定段**（system prompt，低频变），而且永不衰减、不参与冷存
await remember('回复一律用中文，先给结论再补理由', [{ subject: '用户', attribute: '边界', value: '中文+结论先行' }], 'm5', { type: 'boundary', tags: ['边界'] });
await remember('会做 SQLite FTS5 + vec0 的检索评测', [{ subject: '助手', attribute: '技能', value: '检索评测' }], 'm6', { type: 'skill', tags: ['技能'] });

console.log('\n=== memory_extract（P0b：消息 → LLM 抽取 → 四分类） ===');
console.log(JSON.stringify(await tools.memory_extract.handler({
  text: '对了，我最近迷上了手冲咖啡，每天早上都要来一杯',
  message_id: 'msg:p0b-1',
}, { sessionId: 'qq-group:8823' }), null, 2));

console.log('\n=== memory_search("咖啡") ===');
console.log(JSON.stringify(await tools.memory_search.handler({ query: '咖啡' }, { sessionId: 'qq-group:8823' }), null, 2));

console.log('\n=== agent/pre-step ===');
const pre = await kernel.preStep({
  sessionId: 'qq-group:8823',
  messages: [
    { role: 'user', content: '<memory_context>\n（上外审注入、本轮必须被剥离）\n</memory_context>\n\n早安' },
    { role: 'assistant', content: '早安，今天想聊什么？' },
    { role: 'user', content: '我平时喝什么咖啡来着？' },
  ],
});
console.log('skip:', pre.skipped, '| intent:', pre.result?.intent);
console.log('--- system ---\n' + pre.system);
console.log('--- 当前 user 消息 ---\n' + pre.messages.at(-1).content);
console.log('--- 历史消息已被剥离 ---\n' + pre.messages[0].content);

console.log('\n=== dream ===');
const d = await kernel.dream();
console.log(JSON.stringify(d.steps, null, 2));

console.log('\n=== Markdown 真相源 ===');
const dir = path.join(root, 'domains', 'qq-group');
for (const f of await fs.readdir(dir)) {
  console.log(`\n--- domains/qq-group/${f} ---`);
  console.log((await fs.readFile(path.join(dir, f), 'utf8')).split('\n').slice(0, 24).join('\n'));
}

console.log('\n=== 重建（模拟删库）===');
console.log(await kernel.rebuild());

await kernel.close();
console.log(`\n数据目录: ${root}`);

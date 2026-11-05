/**
 * qq-memory adapter v2（只读接入 qq-bridge 人物账本 people.json）的验收：
 * facts/traits 映射、空人物跳过、locator 内容哈希幂等键、坏文件报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectQqPeopleCandidates } from '../src/adapters/qq-memory.js';

async function writeLedger(dir, ledger) {
  const file = path.join(dir, 'people.json');
  await fs.writeFile(file, JSON.stringify(ledger, null, 2), 'utf8');
  return file;
}

test('collectQqPeopleCandidates：facts/traits 映射 + locator 内容哈希 + 空人物跳过', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qqp-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const file = await writeLedger(dir, {
    '12345678': {
      name: '私聊',
      traits: ['说话直接 偶尔毒舌 但会认真给建议'],
      facts: ['我喜欢喝咖啡', '现在改喜欢喝茶了'],
      topics: ['昨天聊了排班'],           // 会话级暂态：不导入
      pending: ['还想聊月底旅行'],        // 同上
    },
    '87654321': { name: '路人甲', traits: [], facts: [], topics: [], pending: [] },
  });

  const { candidates, people } = await collectQqPeopleCandidates({ file });
  assert.equal(people.length, 2, '两个人物都被读出（含空人物，供调用方观测）');
  assert.equal(candidates.length, 3, 'facts 2 + traits 1；topics/pending 不产出');

  const byLocator = new Map(candidates.map(({ candidate }) => [candidate.sourceRef.locator, candidate]));
  const coffee = byLocator.get('qq-people:12345678:fact:' + (await import('../src/pure/normalize.js')).sha256('我喜欢喝咖啡').slice(0, 12));
  assert.ok(coffee, 'locator = qq-people:<QQ号>:<kind>:<内容短哈希>');
  assert.equal(coffee.text, '我喜欢喝咖啡');
  assert.deepEqual(coffee.topicTags, ['qq', 'people', '私聊', 'qq:12345678']);
  assert.equal(coffee.domainId, 'dsh', '落入部署插件的 catch-all 域');
  assert.equal(coffee.provenance.model_version, 'qq-bridge', 'provenance 指明来源而非 LLM 抽取');

  const trait = [...byLocator.entries()].find(([k]) => k.includes(':trait:'))?.[1];
  assert.ok(trait, 'trait 有独立 kind');
  assert.deepEqual(trait.topicTags, ['qq', 'people', '私聊', 'qq:12345678', 'trait']);

  // locator 与数组顺序无关：调换 facts 顺序，locator 不变（幂等导入不重不漏）
  const file2 = await writeLedger(dir, {
    '12345678': {
      name: '私聊',
      traits: ['说话直接 偶尔毒舌 但会认真给建议'],
      facts: ['现在改喜欢喝茶了', '我喜欢喝咖啡'],
    },
  });
  const { candidates: c2 } = await collectQqPeopleCandidates({ file: file2 });
  const loc2 = new Set(c2.map(({ candidate }) => candidate.sourceRef.locator));
  assert.equal(loc2.size, c2.length, '调序后无重复');
  for (const { candidate } of c2) assert.ok(byLocator.has(candidate.sourceRef.locator), `调序不改变 locator：${candidate.sourceRef.locator}`);
});

test('collectQqPeopleCandidates：坏文件明确报错，不产出空结果伪装成功', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-qqp-bad-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'people.json');
  await fs.writeFile(file, '{ broken', 'utf8');
  await assert.rejects(() => collectQqPeopleCandidates({ file }), /人物账本读取失败/);
});

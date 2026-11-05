/**
 * 【R-139】内心活动（inner_log）+ 日记（diary）。
 *
 * 两条生命周期钉死在这里：
 *   - inner_log：流水层，同 transcript（append 幂等 / 本域检索 / TTL / 不进 RRF）
 *   - diary：真相源层（md 落盘 / (domain_id, date) 幂等 / rebuild 重放 / LLM 与模板双路）
 * 以及检索侧的新通道：日期查询 → 当日档案；关键词 → 日记回溯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { detectDayRange } from '../src/pure/dayparse.js';
import { localDate } from '../src/core/diary.js';

const DIM = 32;
const DAY = 864e5;

/** 假 LLM：返回固定 JSON（日记的 LLM 路测试用）。 */
function fakeLlm(payload) {
  return {
    available: () => true,
    async complete() { return typeof payload === 'function' ? payload() : JSON.stringify(payload); },
  };
}

async function boot(t, { llm = null, now = Date.now() } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-diary-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    llm,
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

const yesterdayStr = (now) => localDate(now - DAY);

/** 灌一天的对话 + 内心活动 + 条目（全部落在"昨天"，日记才有料）。 */
async function seedDay(kernel, now) {
  const y = now - DAY;
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [
      { role: 'user', content: '我想学吉他，但是怕坚持不下来', ts: y + 3600e3 },
      { role: 'assistant', content: '先买把入门琴，每天十五分钟比周末两小时有效', ts: y + 3660e3 },
    ],
  });
  kernel.appendInner({
    sessionId: 'da:s1',
    notes: [{ text: '我建议拆小目标，是因为用户上次健身计划就是败在目标太大', ts: y + 3700e3 }],
  });
  await kernel.remember({
    domainId: 'da',
    text: '用户想学吉他',
    entryType: 'fact',
    topicTags: ['爱好'],
    triples: [],
    sourceRef: { adapter_id: 'da', locator: `da:${Math.random().toString(36).slice(2)}` },
    provenance: {
      session_id: 'da:s1', message_ids: [], extract_task_id: 't',
      model_version: 'manual', extracted_at: y, source_content_hash: '',
    },
  });
}

/* ─────────────────── inner_log：流水层纪律 ─────────────────── */

test('R-139 inner 追加幂等：同 session 同文本哈希只写一次，跨 session 各写各的', async (t) => {
  const { kernel } = await boot(t);
  const note = { text: '我推荐 A 是因为它可回滚' };
  const r1 = kernel.appendInner({ sessionId: 'da:s1', notes: [note] });
  const r2 = kernel.appendInner({ sessionId: 'da:s1', notes: [{ ...note, ts: Date.now() + 999 }] });
  const r3 = kernel.appendInner({ sessionId: 'da:s2', notes: [note] });
  assert.equal(r1.written, 1);
  assert.equal(r2.written, 0, '同 session 同内容 = 幂等跳过（pre-step 全量重灌不能膨胀）');
  assert.equal(r3.written, 1, '跨 session 是不同的对话对，各写各的');
});

test('R-139 inner 本域检索：FTS 命中带 kind 标记，空查询返回空', async (t) => {
  const { kernel } = await boot(t);
  kernel.appendInner({ sessionId: 'da:s1', notes: [{ text: '用户对花生过敏，菜单里要避开' }] });
  const hits = kernel.inner.search('花生过敏', { domainId: 'da' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'inner');
  assert.equal(kernel.inner.search('', { domainId: 'da' }).length, 0);
});

test('R-139 inner TTL：过期清空且 FTS 同步删除', async (t) => {
  const { kernel } = await boot(t);
  const now = Date.now();
  kernel.appendInner({ sessionId: 'da:s1', notes: [
    { text: '旧记录', ts: now - 200 * DAY },
    { text: '新记录', ts: now - 10 * DAY },
  ] });
  const pruned = kernel.inner.prune(now);
  assert.equal(pruned, 1);
  const left = kernel.inner.search('记录', { domainId: 'da' });
  assert.equal(left.length, 1, '只剩未过期的');
  assert.match(left[0].text, /新记录/);
});

/* ─────────────────── diary：真相源层纪律 ─────────────────── */

test('R-139 日记模板模式：六节齐全、md 落盘、幂等跳过、generated_by=template', async (t) => {
  const { kernel, root } = await boot(t);
  const now = Date.now();
  await seedDay(kernel, now);
  const date = yesterdayStr(now);

  const r1 = await kernel.diary.ensure({ domainId: 'da', date, now });
  assert.equal(r1.written, true);
  assert.equal(r1.generatedBy, 'template', '没注入 LLM → 模板兜底，不断供');

  // md 真相源：六节标题 + frontmatter
  const md = await fs.readFile(r1.path, 'utf8');
  for (const sec of ['经历', '场景', '情绪', '在场', '当时的想法', '原话摘录']) {
    assert.ok(md.includes(`## ${sec}`), `缺节：${sec}`);
  }
  assert.match(md, /kind: diary/);
  assert.match(md, /【第一手】/, '内心活动必须标【第一手】');
  assert.match(md, /想学吉他/, '事实条目进「经历」');
  assert.match(md, /每天十五分钟/, '原话摘录');

  // 幂等：同一天再跑跳过，文件不被重写（事后重写 = 篡改记忆）
  const mtime1 = (await fs.stat(r1.path)).mtimeMs;
  const r2 = await kernel.diary.ensure({ domainId: 'da', date, now: now + 600e3 });
  assert.equal(r2.written, false);
  assert.equal(r2.reason, 'exists');
  assert.equal((await fs.stat(r1.path)).mtimeMs, mtime1);

  // 空天不写
  const r3 = await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now - 30 * DAY), now });
  assert.equal(r3.written, false);
  assert.equal(r3.reason, 'empty-day');
});

test('R-139 日记 LLM 模式：结构化字段落节、第一手与推断并存、LLM 坏了退模板', async (t) => {
  const { kernel } = await boot(t, {
    llm: fakeLlm({
      summary: '用户提出想学吉他，助手给了拆解式建议',
      scene: '一对一对话（推断依据：单会话、生活话题）',
      emotion: '用户期待中带犹豫',
      participants: '用户与助手',
      thoughts: '【推断】助手建议拆小目标，沿用了"降低启动门槛"的一贯策略',
      quotes: [{ speaker: 'assistant', text: '每天十五分钟比周末两小时有效' }],
    }),
  });
  const now = Date.now();
  await seedDay(kernel, now);
  const r = await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now), now });
  assert.equal(r.written, true);
  assert.equal(r.generatedBy, 'llm');
  const md = await fs.readFile(r.path, 'utf8');
  assert.match(md, /拆解式建议/);
  assert.match(md, /【第一手】/, 'LLM 模式也必须带上第一手记录，不许只写推断');
  assert.match(md, /【推断】/);
  assert.ok(md.indexOf('【第一手】') < md.indexOf('【推断】'), '第一手在前，推断在后');
  assert.match(md, /- 助手：/, 'speaker 英文枚举 assistant 须映射为"助手"');
});

test('日记 LLM 渲染：speaker 中文"助手"正确映射；LLM 复述第一手被滤掉不重复', async (t) => {
  const { kernel } = await boot(t, {
    llm: fakeLlm({
      summary: '用户提出想学吉他',
      scene: '一对一对话',
      emotion: '期待',
      participants: '用户与助手',
      // 不听话场景：LLM 照旧复述【第一手】——渲染层必须滤掉，只留系统附加的那份
      thoughts: '【第一手】想学吉他很久了\n【推断】助手建议拆小目标',
      quotes: [{ speaker: '助手', text: '每天十五分钟比周末两小时有效' }],
    }),
  });
  const now = Date.now();
  await seedDay(kernel, now);
  const r = await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now), now });
  assert.equal(r.generatedBy, 'llm');
  const md = await fs.readFile(r.path, 'utf8');
  assert.match(md, /- 助手：每天十五分钟/, 'speaker 中文"助手"须正确映射，不得误标为用户');
  assert.doesNotMatch(md, /- 用户：每天十五分钟/, '助手的原话不许落到"用户"名下');
  // 系统第一手（seedDay 的内心记录）只出现一次；fake LLM 复述的"想学吉他很久了"必须被滤掉（0 次）
  assert.equal(md.match(/败在目标太大/g)?.length, 1, '系统第一手只出现一次');
  assert.doesNotMatch(md, /想学吉他很久了/, 'LLM 复述的第一手必须被滤掉');
});

test('R-139 LLM 挂掉退模板：不抛错、generated_by=template、审计有痕', async (t) => {
  const { kernel } = await boot(t, {
    llm: { available: () => true, async complete() { throw new Error('boom'); } },
  });
  const now = Date.now();
  await seedDay(kernel, now);
  const r = await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now), now });
  assert.equal(r.written, true);
  assert.equal(r.generatedBy, 'template', 'LLM 崩了不能让日记断供');
});

test('R-139 rebuild 从 md 重放日记表：删行重灌，检索不丢', async (t) => {
  const { kernel } = await boot(t);
  const now = Date.now();
  await seedDay(kernel, now);
  const date = yesterdayStr(now);
  await kernel.diary.ensure({ domainId: 'da', date, now });
  assert.ok(kernel.diary.get('da', date));

  // 模拟派生层丢失：手清 SQLite 行（真相源 md 不动）
  kernel.db.prepare('DELETE FROM diary').run();
  assert.equal(kernel.diary.get('da', date), null);

  const n = await kernel.diary.rebuildFromMd('da');
  assert.equal(n, 1);
  const row = kernel.diary.get('da', date);
  assert.ok(row, 'md 是裁决者，表能从它长回来');
  assert.match(row.content, /想学吉他/);
  assert.equal(kernel.diary.search('吉他', { domainId: 'da' }).length, 1, 'FTS 随重放恢复');
});

/* ─────────────────── 检索通道 ─────────────────── */

test('R-139 日期查询触发当日档案：日记/内心/原话三合一，无日期不触发', async (t) => {
  const { kernel } = await boot(t);
  const now = Date.now();
  await seedDay(kernel, now);
  await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now), now });

  const withDay = await kernel.search({ sessionId: 'da:s1', query: `帮我回忆一下${yesterdayStr(now)}聊了什么` });
  assert.ok(withDay.dayArchive, '带日期 → 当日档案必须触发');
  assert.equal(withDay.dayArchive.date, yesterdayStr(now));
  assert.ok(withDay.dayArchive.diary, '日记已存在 → 注入日记而非原样流水');
  assert.match(withDay.dayArchive.diary.content, /想学吉他/);

  const rel = await kernel.search({ sessionId: 'da:s1', query: '回忆一下昨天我们说了啥' });
  assert.ok(rel.dayArchive, '相对日期"昨天"也要触发');
  assert.equal(rel.dayArchive.date, yesterdayStr(now));

  const none = await kernel.search({ sessionId: 'da:s1', query: '我想学吉他' });
  assert.equal(none.dayArchive, null, '无日期查询不该塞当日档案');
});

test('R-139 无日期关键词回溯日记：diaryHits 带日期与摘录', async (t) => {
  const { kernel } = await boot(t);
  const now = Date.now();
  await seedDay(kernel, now);
  await kernel.diary.ensure({ domainId: 'da', date: yesterdayStr(now), now });

  const r = await kernel.search({ sessionId: 'da:s1', query: '吉他' });
  assert.ok(Array.isArray(r.diaryHits));
  assert.ok(r.diaryHits.some((h) => h.date === yesterdayStr(now)), '关键词命中日记 → 回溯段');
});

/* ─────────────────── dayparse：宁缺勿滥 ─────────────────── */

test('R-139 dayparse：绝对/相对日期命中，歧义形态不误报', () => {
  const now = new Date('2026-10-28T12:00:00').getTime();
  const d = (ms) => localDate(ms);

  assert.equal(d(detectDayRange('2026-10-01 的事', now).start), '2026-10-01');
  assert.equal(d(detectDayRange('10月1号我们干嘛了', now).start), '2026-10-01');
  assert.equal(d(detectDayRange('2026年10月3日', now).start), '2026-10-03');
  assert.equal(d(detectDayRange('昨天聊的', now).start), '2026-10-27');
  assert.equal(d(detectDayRange('前天', now).start), '2026-10-26');
  assert.equal(d(detectDayRange('今天', now).start), '2026-10-28');
  // 不带年：已过去的归今年，还没到的归去年（就近原则）
  assert.equal(d(detectDayRange('1月5号', now).start), '2026-01-05');
  assert.equal(d(detectDayRange('12月1号', now).start), '2025-12-01', '今年的 12 月还没到 → 归去年');
  assert.equal(detectDayRange('2月30号', now), null, '不存在的日期不硬凑');
  assert.equal(detectDayRange('随便聊聊', now), null, '无日期不误报');
});

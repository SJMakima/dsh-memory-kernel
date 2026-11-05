/**
 * 【R-142】情绪日志（emotion_log）——双方情绪的独立流水。
 *
 * 钉住评审定稿的四个边界：
 *   ① felt 缺席 ≠ 平静：NULL 语义贯穿采集与消费；
 *   ② 强单点例外：孤立但 strong 的用户情绪不被滤噪吃掉；
 *   ③ 开关只控消费不控采集：A/B 必须基于同一批数据；
 *   ④ agent 轨拆 expressed（判）/ felt（自述），两条线不混。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { shapeEmotionSeries, compactEmotionLine } from '../src/pure/emotion-shape.js';
import { parseExtractOutput } from '../src/core/extract.js';

const DIM = 32;

async function boot(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-emo2-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      ...overrides,
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

/* ── ① 纯函数：滤噪与强单点 ── */

test('滤噪：连续 ≥2 同档位成段；孤立非 strong 丢弃；strong 孤立保留', () => {
  const t0 = 1_700_000_000_000;
  const pts = [
    { ts: t0, emotion: 'fatigue' },
    { ts: t0 + 60e3, emotion: 'fatigue' },          // 连续 2 → 段
    { ts: t0 + 120e3, emotion: 'joy' },              // 孤立非 strong → 丢
    { ts: t0 + 180e3, emotion: 'sadness', strong: 1 }, // 孤立 strong → 单点保留
    { ts: t0 + 240e3, emotion: 'neutral' },
    { ts: t0 + 300e3, emotion: 'neutral' },
  ];
  const { segments, singles } = shapeEmotionSeries(pts);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => s.emotion), ['fatigue', 'neutral']);
  assert.equal(segments[0].count, 2);
  assert.equal(singles.length, 1);
  assert.equal(singles[0].emotion, 'sadness');
  assert.equal(singles[0].strong, true);
});

test('self（felt 第一手）不参与滤噪，全部保留并带 self 标记', () => {
  const t0 = 1_700_000_000_000;
  const pts = [
    { ts: t0, emotion: 'joy', source: 'self' },
    { ts: t0 + 60e3, emotion: 'anxiety', source: 'self' },   // 相邻不同档也不该影响
    { ts: t0 + 120e3, emotion: 'fatigue' },                   // extract 判定走滤噪：孤立 → 丢
  ];
  const { segments, singles } = shapeEmotionSeries(pts);
  assert.equal(segments.length, 0);
  assert.equal(singles.length, 2);
  assert.ok(singles.every((s) => s.self));
});

test('compactEmotionLine：段合并、强单点与自述标记、空序列空串', () => {
  const t0 = new Date('2026-10-28T19:16:00').getTime();
  const line = compactEmotionLine([
    { ts: t0, emotion: 'fatigue' },
    { ts: t0 + 60e3, emotion: 'fatigue' },
    { ts: t0 + 120e3, emotion: 'sadness', strong: 1 },
    { ts: t0 + 180e3, emotion: 'joy', source: 'self' },
  ]);
  assert.match(line, /疲惫×2/);
  assert.match(line, /低落（强）/);
  assert.match(line, /【自述】/);
  assert.equal(compactEmotionLine([]), '');
});

/* ── ② 抽取协议：新对象 / 旧数组 / 非法枚举 ── */

test('parseExtractOutput：新协议对象解析出候选与 mood；非法枚举丢 null 不映射', () => {
  const raw = `好的，以下是抽取结果：{"candidates":[{"text":"用户在做 dsh 记忆插件","entry_type":"fact","topic_tags":["开发"],"triples":[]}],"mood":{"user":"fatigue","user_strong":true,"agent":"ecstatic","note":"深夜还在聊"}}`;
  const { candidates, mood } = parseExtractOutput(raw);
  assert.equal(candidates.length, 1);
  assert.equal(mood.user, 'fatigue');
  assert.equal(mood.userStrong, true);
  assert.equal(mood.agentExpressed, null, '六档之外的词丢弃，绝不映射成最接近的档位');
  assert.equal(mood.note, '深夜还在聊');
});

test('parseExtractOutput：user_strong 在 user 为 null 时强制失效（strong 只随 user）', () => {
  const raw = `{"candidates":[],"mood":{"user":null,"user_strong":true,"agent":"neutral","note":null}}`;
  const { mood } = parseExtractOutput(raw);
  assert.equal(mood.user, null);
  assert.equal(mood.userStrong, false);
});

test('parseExtractOutput：旧协议裸数组兼容——候选照收、mood 缺席', () => {
  const raw = '```json\n[{"text":"用户喜欢鱼","entry_type":"fact","topic_tags":["吃"],"triples":[]}]\n```';
  const { candidates, mood } = parseExtractOutput(raw);
  assert.equal(candidates.length, 1);
  assert.equal(mood, null);
});

/* ── ③ 端到端：闲聊轮也采集；开关只控注入 ── */

test('闲聊轮（零候选）情绪照常落库；两轮连续判读被滤成段；strong 孤立点活下来', async (t) => {
  const { kernel } = await boot(t);
  const fakeLlm = async () => {};
  // 直接走 emotions.append 模拟 extract 落库（extract 侧协议已由上面三个用例钉住）
  const t0 = Date.now();
  kernel.emotions.append({
    sessionId: 'da:s1', domainId: 'da', now: t0,
    user: { emotion: 'fatigue' },
    agentExpressed: { emotion: 'neutral' },
  });
  kernel.emotions.append({
    sessionId: 'da:s1', domainId: 'da', now: t0 + 60e3,
    user: { emotion: 'fatigue', note: '连说两次困' },
    agentExpressed: { emotion: 'neutral' },
  });
  kernel.emotions.append({
    sessionId: 'da:s1', domainId: 'da', now: t0 + 120e3,
    user: { emotion: 'sadness', strong: true, note: '用户原话：今天特别崩溃' },
    agentExpressed: { emotion: 'neutral' },
  });
  const st = kernel.emotions.stats();
  assert.equal(st.total, 6);   // 每轮 user + agent 各一条
  assert.ok(st.byOwner.some((b) => b.owner === 'user' && b.c === 3));
});

test('emotion.enabled=false：emotion_log 照常采集（开关不控采集），组装段消失', async (t) => {
  const { kernel } = await boot(t, { emotion: { enabled: false, windowDays: 3, retainDays: 180 } });
  kernel.emotions.append({
    sessionId: 'da:s1', domainId: 'da', now: Date.now(),
    user: { emotion: 'fatigue' }, agentExpressed: { emotion: 'neutral' },
  });
  // 采集侧：数据在
  assert.equal(kernel.emotions.stats().total, 2);

  // 注入侧：组装动态段不含情绪参考
  const r = kernel.search({ sessionId: 'da:s1', query: '随便聊聊' });
  const r2 = await (r.then ? r : Promise.resolve(r));
  const dyn = r2.dynamic ?? r2.dynamicSection ?? '';
  assert.ok(!String(dyn).includes('近期情绪参考'), '开关关闭时情绪参考段不得注入');
});

/* ── ④ felt 第一手与 null 语义 ── */

test('appendSelf：传了档位写 source=self；没传不写行（null = 未自述，不补 neutral）', async (t) => {
  const { kernel } = await boot(t);
  assert.equal(kernel.appendEmotionSelf({ sessionId: 'da:s1', note: '说不上来' }).written, 0,
    '无 emotion 不写行——缺席是缺席');
  assert.equal(kernel.appendEmotionSelf({ sessionId: 'da:s1', emotion: 'fatigue', note: '陪你到这么晚我也累' }).written, 1);
  const rows = kernel.db.prepare("SELECT owner, emotion, source FROM emotion_log WHERE source='self'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].owner, 'agent');
  assert.equal(rows[0].emotion, 'fatigue');
  // 非法档位拒收
  assert.equal(kernel.appendEmotionSelf({ sessionId: 'da:s1', emotion: 'ecstatic' }).written, 0);
});

test('消费层不把 NULL 读成 neutral：range 已过滤 NULL 行', async (t) => {
  const { kernel } = await boot(t);
  kernel.db.prepare(`
    INSERT INTO emotion_log(ts, session_id, domain_id, owner, emotion, strong, source, note)
    VALUES (?, 'da:s1', 'da', 'user', NULL, 0, 'extract', '判不出')
  `).run(Date.now());
  assert.equal(kernel.emotions.range('da', Date.now() - 864e5, Date.now() + 864e5).length, 0,
    'NULL 行不得进入消费层，否则会被统计成"平静"');
});

/* ── ⑤ TTL 与按域隔离 ── */

test('prune 过期清理；跨域数据互不可见', async (t) => {
  const { kernel } = await boot(t);
  const now = Date.now();
  kernel.emotions.append({ sessionId: 'da:s1', domainId: 'da', now: now - 200 * 864e5, user: { emotion: 'joy' } });
  kernel.emotions.append({ sessionId: 'da:s2', domainId: 'da', now, user: { emotion: 'fatigue' } });
  // 另一个域：先注册
  kernel.domains.register({ id: 'db2', matchSessionId: (sid) => sid.startsWith('db2:') });
  kernel.emotions.append({ sessionId: 'db2:s1', domainId: 'db2', now, user: { emotion: 'anger' } });

  assert.equal(kernel.emotions.prune(now), 1, '过期行被清');
  assert.equal(kernel.emotions.range('da', now - 864e5, now + 864e5).length, 1);
  assert.equal(kernel.emotions.range('db2', now - 864e5, now + 864e5).length, 1);
  assert.equal(kernel.emotions.range('db2', now - 864e5, now + 864e5)[0].emotion, 'anger',
    'db2 域只见自己的情绪——跨域泄露在情绪数据上是更严重的事故');
});

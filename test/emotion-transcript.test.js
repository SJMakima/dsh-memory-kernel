/**
 * 【R-95~R-98 情感雷达 P-a】【R-108~R-110 对话流水】【R-117 成对隐私】
 *
 * 这三组的共同纪律：**新数据走新列/新表，不改既有语义**——存量条目全是
 * emotion='neutral' / sensitivity='normal'，所以上线不该改变任何现有召回结果。
 * 测试同时钉住"有能力"和"不越界"两面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { buildDynamicSection } from '../src/pure/assembly.js';

const DIM = 32;

async function boot(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-emo-'));
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

const remember = (kernel, text, extra = {}) => kernel.remember({
  domainId: 'da',
  text,
  entryType: 'fact',
  // 带一个 tag：write.useful 的 untaggedMinChars=15 会把短的无锚点条目判 low-utility
  // （那是生产侧的防流水账判据，测试不该绕过它——给 tag 才是最贴近真实写入的形态）。
  topicTags: ['记录'],
  triples: [],
  sourceRef: { adapter_id: 'da', locator: `da:${Math.random().toString(36).slice(2)}` },
  provenance: {
    session_id: 'da:s1', message_ids: [], extract_task_id: 't',
    model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
  },
  ...extra,
});

/* ─────────────────── R-95：情绪走列，不走三元组 ─────────────────── */

test('R-95 emotion 写入列、非法值收敛为 neutral、不吃三元组也不占判重', async (t) => {
  const { kernel } = await boot(t);
  const a = await remember(kernel, '用户今天被临时通知加班', { emotion: 'anxiety' });
  assert.equal(a.status, 'written');
  const row = kernel.db.prepare('SELECT emotion, emotion_owner FROM entries WHERE id = ?').get(a.entry.id);
  assert.equal(row.emotion, 'anxiety');
  assert.equal(row.emotion_owner, 'user');

  const b = await remember(kernel, '用户明天要去体检', { emotion: '不知道啥词' });
  assert.equal(
    kernel.db.prepare('SELECT emotion FROM entries WHERE id = ?').get(b.entry.id).emotion, 'neutral',
    '非法枚举一律 neutral——写入端不猜情绪',
  );

  // 关键：情绪不进 entry_triples（否则会触发 update 取代 + 过判重线进待定池）
  assert.equal(
    kernel.db.prepare('SELECT COUNT(*) AS c FROM entry_triples WHERE entry_id = ?').get(a.entry.id).c, 0,
    '情绪类条目不应产生三元组行',
  );
});

test('R-95 情绪进真相源：rebuild 后不丢（内存有、md 没有 = 重建即洗掉）', async (t) => {
  // 这个用例要开两次内核（写 → 重建），不能复用 boot 的 after（它的 rm 会撞上第二个连接）
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-emo-rebuild-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const mk = () => createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  const k1 = await mk();
  await k1.init();
  const r = await remember(k1, '用户说最近总失眠', { emotion: 'fatigue', emotionOwner: 'user' });
  assert.equal(r.status, 'written');
  await k1.close();

  const md = await fs.readFile(r.path, 'utf8');
  assert.match(md, /emotion: "fatigue"/, 'Markdown 里必须有 emotion 行');
  assert.ok(!/emotion_owner/.test(md), 'user 侧是缺省值，不写进文件（省字节、少噪）');

  const k2 = await mk();
  await k2.init();
  t.after(async () => { await k2.close(); await fs.rm(root, { recursive: true, force: true }); });
  await k2.rebuild();
  assert.equal(
    k2.db.prepare('SELECT emotion FROM entries WHERE id = ?').get(r.entry.id).emotion, 'fatigue',
    '真相源有 emotion，重建后必须还原',
  );
});

test('R-96 情绪只做只读参考段：有数据才出现，无数据零 token，且不进检索排序', async (t) => {
  const { kernel } = await boot(t);
  // 无数据：动态段里不该有情绪段
  const empty = buildDynamicSection({ entries: [], domain: { id: 'da' }, opsQuery: false }, [], null, {});
  assert.ok(!empty.includes('情绪参考'), '没有情绪数据时不占 token');

  await remember(kernel, '用户被临时通知加班', { emotion: 'anxiety' });
  await remember(kernel, '用户又被通知加班', { emotion: 'anxiety' });
  await remember(kernel, '用户说想去泡温泉', { emotion: 'joy' });

  // 端到端：preStep 组装出来的动态段里应出现统计（query 够长，不走 selfContained 短路）
  const out = await kernel.preStep({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '帮我回顾一下最近几天我提到过的那些事情' }],
  });
  assert.ok(out.dynamic, '应产出动态段');
  assert.match(out.dynamic, /情绪参考/, '有情绪数据时应有参考段');
  assert.match(out.dynamic, /焦虑 ×2/, '同情绪应聚合计数');
  assert.match(out.dynamic, /样本稀疏/, '措辞必须说明这是记忆标签而非情绪时间线');

  // 边界：Agent 侧情绪不进用户侧参考段（R-97 不建"内心戏"注入）
  await remember(kernel, '助手觉得自己刚才答得挺好', { emotion: 'joy', emotionOwner: 'agent' });
  const out2 = await kernel.preStep({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '再帮我回顾一下最近几天提到过的事情' }],
  });
  assert.match(out2.dynamic, /开心 ×1/, "agent 侧情绪不计数（用户侧 joy 只有 1 条，词表 v4.21 起 joy=开心）");
});

/* ─────────────────── R-108：对话流水层 ─────────────────── */

test('R-108 transcript 幂等追加：pre-step 每轮给全量消息，不得线性膨胀', async (t) => {
  const { kernel } = await boot(t);
  const messages = [
    { role: 'user', content: '我明天想去买一把蓝色的雨伞' },
    { role: 'assistant', content: '好的，蓝色雨伞记下了' },
  ];
  const first = await kernel.appendTranscript({ sessionId: 'da:s1', messages });
  assert.equal(first.written, 2);
  const second = await kernel.appendTranscript({ sessionId: 'da:s1', messages });
  assert.equal(second.written, 0, '同一条原话重复灌入必须幂等');

  const total = kernel.db.prepare('SELECT COUNT(*) AS c FROM transcript').get().c;
  assert.equal(total, 2);
});

test('R-108 原话检索：能查到"当时怎么说的"，且按域隔离（R-110）', async (t) => {
  const { kernel } = await boot(t);
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '那把蓝色雨伞是去年在日本买的' }],
  });

  const hits = kernel.transcript.search('蓝色雨伞', { domainId: 'da' });
  assert.equal(hits.length, 1, '本域应命中');
  assert.match(hits[0].text, /蓝色雨伞/);
  assert.equal(hits[0].speaker, 'owner');

  // 域隔离：别的域查不到（原话是隐私含量最高的数据，跨域互检既是泄露也是噪声）
  assert.equal(kernel.transcript.search('蓝色雨伞', { domainId: 'other' }).length, 0);
});

test('R-108 原话片段进动态段，但不混进条目排序（无 entry_id 不参与 RRF）', async (t) => {
  const { kernel } = await boot(t);
  await remember(kernel, '用户有一把蓝色雨伞');
  await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '那把蓝色雨伞是去年在日本买的' }],
  });

  const r = await kernel.search({ sessionId: 'da:s1', query: '蓝色雨伞' });
  assert.ok(r.entries.length >= 1, '条目照常召回');
  assert.ok(r.transcripts.length >= 1, '原话独立返回');
  assert.ok(
    r.entries.every((e) => typeof e.id === 'string' && !String(e.text).includes('去年在日本买的')),
    '原话不得伪装成条目混进 entries',
  );

  const dyn = buildDynamicSection({ entries: r.entries, domain: r.domain, opsQuery: false }, [], null, {
    transcripts: r.transcripts,
  });
  assert.match(dyn, /原话片段/, '动态段应有独立原话段');
  assert.match(dyn, /不是用户当前发言/, '必须声明这是历史原文');
});

test('R-108 enabled=false 立即停止落盘与召回（配置是 hot 的）', async (t) => {
  const { kernel } = await boot(t);
  kernel.applyConfigPatch({ transcript: { enabled: false } });
  const r = await kernel.appendTranscript({
    sessionId: 'da:s1',
    messages: [{ role: 'user', content: '这句话不该被落盘' }],
  });
  assert.equal(r.written, 0);
  assert.equal(kernel.transcript.search('不该被落盘', { domainId: 'da' }).length, 0);
});

/* ─────────────────── R-117：成对隐私 ─────────────────── */

test('R-117 private 只在产生它的对话对可见：owner 换个会话也看不见', async (t) => {
  const { kernel } = await boot(t);
  // 同一域（da）的两段不同对话
  const priv = await remember(kernel, '用户的账号密码提示是蓝色雨伞', {
    sensitivity: 'private',
    provenance: {
      session_id: 'da:s1', message_ids: [], extract_task_id: 't',
      model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
    },
  });
  assert.equal(priv.status, 'written');

  const same = await kernel.search({ sessionId: 'da:s1', query: '蓝色雨伞' });
  assert.ok(same.entries.some((e) => e.id === priv.entry.id), '产生它的对话对能看见');

  const other = await kernel.search({ sessionId: 'da:s2', query: '蓝色雨伞' });
  assert.ok(!other.entries.some((e) => e.id === priv.entry.id), '换个会话必须看不见（隐私靠不可见）');
});

test('R-117 存量 normal 不受影响：跨会话照常可召回（不引入回归）', async (t) => {
  const { kernel } = await boot(t);
  const r = await remember(kernel, '用户有一把蓝色雨伞', { sensitivity: 'normal' });
  const other = await kernel.search({ sessionId: 'da:s2', query: '蓝色雨伞' });
  assert.ok(other.entries.some((e) => e.id === r.entry.id), 'normal 档跨会话可见，域内不受影响');
});

test('R-111 speaker 闸：配了 owner 白名单时非 owner 看不到私聊档', async (t) => {
  const { kernel } = await boot(t, { privacy: { ownerIds: ['owner-1'] } });
  const priv = await remember(kernel, '用户的账号提示是蓝色雨伞', {
    sensitivity: 'private',
    provenance: {
      session_id: 'da:s1', message_ids: [], extract_task_id: 't',
      model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
    },
  });

  const asOwner = await kernel.search({ sessionId: 'da:s1', query: '蓝色雨伞', viewer: 'owner-1' });
  assert.ok(asOwner.entries.some((e) => e.id === priv.entry.id), 'owner 在对话对内可见');

  const asStranger = await kernel.search({ sessionId: 'da:s1', query: '蓝色雨伞', viewer: 'stranger-9' });
  assert.ok(!asStranger.entries.some((e) => e.id === priv.entry.id), '非 owner 同一会话也不可见');
});

/* ─────────────────── R-109：全域检索（domain 降级为出身标签） ─────────────────── */

test('R-109 全域检索：一个会话能问到别的域的事，且条目带出身处', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cross-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [
      defineDomain({ id: 'da', dir: path.join(root, 'a') }),
      defineDomain({ id: 'db', dir: path.join(root, 'b') }),
    ],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });

  // 写在另一个域（db）里的一条事实
  await kernel.remember({
    domainId: 'db', text: '群里有人提到周末要去爬香山', entryType: 'fact', topicTags: ['闲聊'],
    triples: [], emotion: 'joy',
    sourceRef: { adapter_id: 'db', locator: 'db:1' },
    provenance: {
      session_id: 'db:g1', message_ids: [], extract_task_id: 't',
      model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
    },
  });

  const r = await kernel.search({ sessionId: 'da:s1', query: '爬香山' });
  const hit = r.entries.find((e) => String(e.text).includes('香山'));
  assert.ok(hit, '在 da 会话里应该能查到 db 域里的事（R-109 全域检索）');
  assert.equal(hit.domain_id, 'db', '条目必须自带出身处，Agent 才知道这是别处听来的');
  assert.ok((r.domains ?? []).includes('db'), '返回里应记录参与检索的域');

  // 关掉全域开关 → 退回只查本域（配置是 hot 的）
  kernel.applyConfigPatch({ retrieve: { allDomains: { enabled: false } } });
  const local = await kernel.search({ sessionId: 'da:s1', query: '爬香山' });
  assert.ok(!local.entries.some((e) => String(e.text).includes('香山')), '关掉后不该跨域召回');
});

test('memory_context：必须经过会话准入；知道 entry_id 不能读取其他会话的 private 记忆（v4.29）', async (t) => {
  const { kernel } = await boot(t);
  const priv = await remember(kernel, '用户的私密提示是蓝色雨伞', { sensitivity: 'private' });
  assert.ok(priv.entry?.id, 'private 记忆应成功写入');

  const denied = await kernel.context(priv.entry.id, { sessionId: 'da:s2' });
  assert.equal(denied, null, '其他会话不能仅凭 entry_id 读取 private 记忆');

  const allowed = await kernel.context(priv.entry.id, { sessionId: 'da:s1' });
  assert.ok(allowed?.entry?.id === priv.entry.id, '来源会话可以读取自己的 private 记忆');

  const noIdentity = await kernel.context(priv.entry.id);
  assert.equal(noIdentity, null, '缺少宿主 sessionId 时必须 fail closed');

  // normal 档不受 origin 管控：跨会话仍可读（全域检索语义，带出身标注）
  const normal = await remember(kernel, '小明的生日是农历五月初五，属龙');
  const cross = await kernel.context(normal.entry.id, { sessionId: 'da:s2' });
  assert.ok(cross?.entry?.id === normal.entry.id, 'normal 档跨会话可见（R-109 语义不变）');
});

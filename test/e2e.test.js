/**
 * 端到端：写入 → 索引 → 检索 → 组装 → dream → 重建。
 *
 * 这里断言的是**契约**，不是"我记得的那条排第一"：
 *   FTS 名次必须跟相关度一致（R-74）、分片阈值必须真的生效（R-38）、
 *   dream 后事件必须清空且 persistence 只涨一次（R-57）、
 *   删库后能从 Markdown 完整重建且状态不丢（C2/R-1）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { parseMarkdownFile, readFileSafe } from '../src/storage/md.js';
import { lazyPersistence } from '../src/pure/lifecycle.js';

const DIM = 64;

function makeCandidate(text, triples = [], extra = {}) {
  const locator = `msg:${Math.random().toString(36).slice(2, 10)}`;
  return {
    domainId: 'qq-group',
    text,
    entryType: extra.entryType ?? 'fact',
    topicTags: extra.topicTags ?? ['偏好'],
    triples,
    sourceRef: { adapter_id: 'qq-group', locator },
    observedAt: extra.observedAt,
    provenance: {
      session_id: 'qq-group:8823',
      message_ids: [locator],
      extract_task_id: 'p0a-manual',
      model_version: 'manual',
      extracted_at: Date.now(),
      source_content_hash: '',
    },
    ...extra.overrides,
  };
}

async function boot(overrides = {}, domainOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-e2e-'));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive, { recursive: true });
  const domain = defineDomain({ id: 'qq-group', dir: archive, ...domainOverrides });

  const config = {
    ...overrides,
    storage: { root, dbPath: path.join(root, 'index.db'), ...(overrides.storage ?? {}) },
    embedding: { dim: DIM, ...(overrides.embedding ?? {}) },
  };

  const kernel = await createKernel({
    config,
    domains: [domain],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  return { kernel, root, archive, domain };
}

const cleanup = async (root) => fs.rm(root, { recursive: true, force: true });

/* ─────────────────────── 1. 写入 → 检索闭环 ─────────────────────── */

test('写入→索引→检索：中文两字命中，单字不命中', async () => {
  const { kernel, root } = await boot();
  await kernel.remember(makeCandidate('用户喜欢喝咖啡，每天两杯', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  await kernel.remember(makeCandidate('用户偏好中文回复，不要用英文', [{ subject: '用户', attribute: '边界', value: '用中文回复' }]));

  const r = await kernel.search({ sessionId: 'qq-group:8823', query: '咖啡' });
  assert.equal(r.entries[0].text, '用户喜欢喝咖啡，每天两杯');
  assert.equal(r.entries[0].triples[0].value, '咖啡');

  // 单字"咖"只有 1 个 token，命中不了任何 bigram 索引 → FTS 路为空。
  // （融合结果里仍可能出现它，那是 `recent` 时间窗路的行为：这一路与 query 无关，是"最近"先验）
  assert.equal(kernel.retrieve.ftsSearch('咖', 'qq-group', 10).length, 0);
  assert.equal(kernel.retrieve.ftsSearch('咖啡', 'qq-group', 10).length, 1);

  // 三元组路：查 subject 词表命中
  const t = await kernel.retrieve.tripleSearch('用户偏好', 'qq-group', 10);
  assert.ok(t.length >= 1);

  await kernel.close();
  await cleanup(root);
});

/* ───────────────── 2. FTS 名次必须跟相关度一致（R-74）───────────────── */

test('FTS 路有 ORDER BY bm25：写入顺序与相关度相反时，仍按相关度排名', async () => {
  const { kernel, root } = await boot();
  // 先写"长且弱相关"，后写"短且强相关"
  await kernel.remember(makeCandidate(
    '架构这个词在很长的一段描述里只出现一次，其它内容全是无关的填充文字，用来拉长文档长度从而提高 bm25 惩罚',
    [{ subject: '项目', attribute: '备注', value: '长文' }],
  ));
  await kernel.remember(makeCandidate('架构与检索', [{ subject: '项目', attribute: '主题', value: '架构' }]));

  const hits = kernel.retrieve.ftsSearch('架构', 'qq-group', 10);
  assert.ok(hits.length >= 2);
  const short = hits.findIndex((h) => h.id === kernel.db.prepare("SELECT id FROM entries WHERE text = '架构与检索'").get().id);
  assert.equal(short, 0, '最短（最相关）的条目必须排第一，而不是最早写入的那条');

  await kernel.close();
  await cleanup(root);
});

/* ───────────────── 2b. 自然问句（FTS 必须 OR，不能隐式 AND）───────────────── */

test('自然问句能命中：FTS5 对多 token 是隐式 AND，必须显式 OR', async () => {
  const { kernel, root } = await boot();
  await kernel.remember(makeCandidate('用户每天两杯咖啡，早上那杯不加糖', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  await kernel.remember(makeCandidate('用户要求一律用中文回复', [{ subject: '用户', attribute: '边界', value: '用中文回复' }]));

  // 这句话切出 9 个 bigram，只有"咖啡"这一个能被命中 → AND 语义下 FTS 路会整体为空
  const q = '我平时喝什么咖啡来着？';
  assert.ok(kernel.retrieve.ftsSearch(q, 'qq-group', 10).length >= 1);

  const r = await kernel.search({ sessionId: 'qq-group:8823', query: q });
  assert.equal(r.entries[0].text, '用户每天两杯咖啡，早上那杯不加糖');

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 3. Markdown 真相源 + 重建 ─────────────────────── */

test('Markdown 是真相源：文件含 state 块；删库后重建，状态不丢', async () => {
  const { kernel, root } = await boot();
  const r1 = await kernel.remember(makeCandidate('用户偏好中文回复', [{ subject: '用户', attribute: '边界', value: '用中文回复' }]));

  const md = await readFileAsync(r1.path);
  assert.match(md, /^## [0-9A-Z]{26}/m);
  assert.match(md, /^state:$/m);
  assert.match(md, /^  persistence: /m);
  assert.match(md, /^  gamma_multiplier: /m);
  assert.match(md, /^text: \|$/m);

  // 激活一次，让 persistence 真的有变化
  await kernel.search({ sessionId: 'qq-group:8823', query: '中文回复' });
  await kernel.dream();
  const before = kernel.db.prepare('SELECT persistence_at_decay, activation_count, last_decay_at FROM entries WHERE id = ?').get(r1.entry.id);
  const pBefore = lazyPersistence(
    { ...kernel.db.prepare('SELECT * FROM entries WHERE id = ?').get(r1.entry.id), triples: [], topic_tags: [] },
    kernel.cfg,
    before.last_decay_at,
  );
  await kernel.close();

  // 删掉派生层，只留 Markdown
  for (const f of ['index.db', 'index.db-wal', 'index.db-shm']) {
    await fs.rm(path.join(root, f), { force: true });
  }

  const kernel2 = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'qq-group' })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  const boot2 = await kernel2.init();
  assert.equal(boot2.ready, true);

  const row = kernel2.db.prepare('SELECT * FROM entries WHERE id = ?').get(r1.entry.id);
  assert.ok(row, '重建后条目必须还在');
  assert.equal(row.activation_count, before.activation_count);
  assert.equal(row.last_decay_at, before.last_decay_at);
  assert.equal(row.persistence_at_decay, before.persistence_at_decay);
  assert.ok(row.persistence_at_decay > kernel2.cfg.lifecycle.initPersistence, '激活回报必须被保存下来');
  assert.ok(pBefore >= kernel2.cfg.lifecycle.initPersistence);

  // 重建后检索仍可用
  const r = await kernel2.search({ sessionId: 'qq-group:8823', query: '中文回复' });
  assert.equal(r.entries[0].id, r1.entry.id);

  await kernel2.close();
  await cleanup(root);
});

/* ─────────────────────── 4. 分片（R-38）─────────────────────── */

test('分片：锁内判满 + 满了换 path，单文件条目数不超阈值', async () => {
  const { kernel, root } = await boot({ storage: { maxEntriesPerFile: 2 } });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const r = await kernel.remember(makeCandidate(`第 ${i} 条记忆，测试分片`, [{ subject: `实体${i}`, attribute: '标签', value: `v${i}` }]));
    ids.push(r.entry.id);
  }

  const dir = path.join(root, 'domains', 'qq-group');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 3, `应至少 3 个分片，实际 ${files.join(',')}`);

  let total = 0;
  for (const f of files) {
    const parsed = parseMarkdownFile(await readFileAsync(path.join(dir, f)));
    assert.ok(parsed.length <= 2, `${f} 有 ${parsed.length} 条，超过阈值`);
    total += parsed.length;
  }
  assert.equal(total, 5);
  // 每条记忆只存在一个分片里（覆盖写不能把条目复制到新分片）
  const seen = new Set();
  for (const f of files) {
    for (const e of parseMarkdownFile(await readFileAsync(path.join(dir, f)))) {
      assert.ok(!seen.has(e.id), `条目 ${e.id} 出现两次`);
      seen.add(e.id);
    }
  }

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 5. dream 结算（R-57）─────────────────────── */

test('dream：激活结算只涨一次，事件随批删除', async () => {
  const { kernel, root } = await boot();
  const r = await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  await kernel.search({ sessionId: 'qq-group:8823', query: '咖啡' });
  await kernel.search({ sessionId: 'qq-group:8823', query: '咖啡' });

  const eventsBefore = kernel.db.prepare('SELECT COUNT(*) AS c FROM activation_events').get().c;
  assert.ok(eventsBefore >= 2);

  const d1 = await kernel.dream();
  assert.equal(d1.steps.s4.landed, 1);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM activation_events').get().c, 0);
  const p1 = kernel.db.prepare('SELECT persistence_at_decay, activation_count FROM entries WHERE id = ?').get(r.entry.id);
  assert.ok(p1.activation_count >= 2);

  // 第外审：没有新事件 → 不再涨
  await kernel.dream();
  const p2 = kernel.db.prepare('SELECT activation_count FROM entries WHERE id = ?').get(r.entry.id);
  assert.equal(p2.activation_count, p1.activation_count);

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 6. 冷存归档 ─────────────────────── */

test('冷存：归档后默认检索查不到，include_cold 能查到且带 coldScanMs', async () => {
  const { kernel, root } = await boot();
  const r = await kernel.remember(makeCandidate('三年前讨论过的旧架构方案', [{ subject: '旧项目', attribute: '架构', value: '单体' }]));

  const old = Date.now() - 100 * 864e5;
  kernel.db.prepare(`UPDATE entries SET persistence_at_decay = 0.05, last_decay_at = ?, last_activated_at = ? WHERE id = ?`)
    .run(old, old, r.entry.id);

  const d = await kernel.dream();
  assert.equal(d.steps.s8.archived, 1);

  const coldFiles = await fs.readdir(path.join(root, 'cold', 'qq-group'));
  assert.equal(coldFiles.length, 1);

  const plain = await kernel.search({ sessionId: 'qq-group:8823', query: '旧架构' });
  assert.equal(plain.entries.some((e) => e.id === r.entry.id), false);
  assert.equal(plain.opsQuery, false);

  const cold = await kernel.search({ sessionId: 'qq-group:8823', query: '旧架构', includeCold: true });
  assert.equal(cold.entries.some((e) => e.id === r.entry.id), true);
  assert.equal(cold.opsQuery, true);
  assert.equal(cold.entries[0].cold, true);
  assert.ok(cold.coldScanMs >= 0);

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 7. 签名（C7 / 禁止项 10）─────────────────────── */

test('签名域：篡改后验签失败 → 排除出榜并写 audit', async () => {
  const { kernel, root } = await boot({}, { requireSignature: true });
  const r = await kernel.remember(makeCandidate('用户偏好中文回复', [{ subject: '用户', attribute: '边界', value: '用中文回复' }]));

  const ok = await kernel.search({ sessionId: 'qq-group:8823', query: '中文回复' });
  assert.equal(ok.entries.length, 1);

  // 模拟"内容被改但签名没重签"
  kernel.db.prepare('UPDATE entries SET text = ? WHERE id = ?').run('用户偏好英文回复', r.entry.id);

  const bad = await kernel.search({ sessionId: 'qq-group:8823', query: '中文' });
  assert.equal(bad.entries.length, 0);

  const log = await fs.readFile(path.join(root, 'audit', 'signature-failures.log'), 'utf8');
  assert.match(log, /verify-failed/);

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────── 8. handleUpdate：γ 与真相源先落（R-82/R-84/R-86）─────────────────── */

test('四分类 update：同一 (s,a) 不同 value → 旧条目打 superseded_by + γ，两个存储时间戳完全相等', async () => {
  const { kernel, root } = await boot({ write: { p0aBypassRouting: false } });

  const first = await kernel.remember(makeCandidate('用户在 Twitter 上关注科技新闻', [{ subject: '  Alice ', attribute: 'Preference', value: 'Twitter' }]));
  assert.equal(first.status, 'written');

  const second = await kernel.remember(makeCandidate('用户现在主要用 Mastodon', [{ subject: 'Alice', attribute: 'preference', value: 'Mastodon' }]));
  assert.equal(second.status, 'updated', '大小写/空白不同但归一化后同一 (s,a) → 必须判 update，不能判 new');

  const oldRow = kernel.db.prepare('SELECT * FROM entries WHERE id = ?').get(first.entry.id);
  assert.equal(oldRow.superseded_by, second.entry.id);
  assert.equal(oldRow.gamma_multiplier, kernel.cfg.write.updateGamma);

  // R-84：Markdown 与 SQLite 的 last_decay_at 必须**完全相等**
  const mdOld = await readFileAsync(await kernel.files.locateEntryPath(oldRow));
  const parsed = parseMarkdownFile(mdOld).find((e) => e.id === first.entry.id);
  assert.equal(parsed.last_decay_at, oldRow.last_decay_at);
  assert.equal(parsed.gamma_multiplier, oldRow.gamma_multiplier);
  assert.equal(parsed.superseded_by, oldRow.superseded_by);

  // 原文保留：triples 里 attribute 仍是 'Preference'、subject 仍是 '  Alice '（R-88）
  const oldEntry = kernel.db.prepare('SELECT triples FROM entries WHERE id = ?').get(first.entry.id);
  const triples = JSON.parse(oldEntry.triples);
  assert.equal(triples[0].attribute, 'Preference');
  assert.equal(triples[0].subject, '  Alice ');

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 9. 组装（R-4 / R-19）─────────────────────── */

test('组装：历史动态段被剥离、当前消息注入、自包含短路不检索', async () => {
  const { kernel, root } = await boot();
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));

  const messages = [
    { role: 'user', content: '<memory_context>\n旧的外审\n</memory_context>\n\n上次问的' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '我喜欢喝什么？' },
  ];
  const pre = await kernel.preStep({ sessionId: 'qq-group:8823', messages });
  assert.equal(pre.skipped, null);
  assert.equal(pre.messages[0].content.includes('<memory_context>'), false, '历史动态段必须被剥掉');
  assert.equal(pre.messages[2].content.includes('<memory_context>'), true);
  assert.match(pre.messages[2].content, /我喜欢喝什么？/);
  assert.match(pre.system, /记忆使用导引/);
  assert.match(pre.messages[2].content, /咖啡/);

  const short = await kernel.preStep({ sessionId: 'qq-group:8823', messages: [{ role: 'user', content: '好的' }] });
  assert.equal(short.skipped, 'self-contained');
  assert.equal(short.messages[0].content, '好的');

  await kernel.close();
  await cleanup(root);
});

/* ─────────────────────── 10. 配额 + pending ─────────────────────── */

test('配额：满额进 pending_candidates，不落 Markdown、不投索引', async () => {
  const { kernel, root } = await boot({ write: { dailyQuotaPerDomain: { 'qq-group': 1 } } });

  const a = await kernel.remember(makeCandidate('第一条记忆', [{ subject: 'a', attribute: 'x', value: '1' }]));
  assert.equal(a.status, 'written');
  const b = await kernel.remember(makeCandidate('第二条记忆', [{ subject: 'b', attribute: 'x', value: '2' }]));
  assert.equal(b.status, 'pending');

  const pending = kernel.db.prepare('SELECT COUNT(*) AS c FROM pending_candidates').get().c;
  assert.equal(pending, 1);

  const dir = path.join(root, 'domains', 'qq-group');
  const files = await fs.readdir(dir);
  let blocks = 0;
  for (const f of files) blocks += parseMarkdownFile(await readFileAsync(path.join(dir, f))).length;
  assert.equal(blocks, 1, 'pending 的候选不能写进 Markdown');

  const found = await kernel.search({ sessionId: 'qq-group:8823', query: '第二条记忆' });
  assert.equal(found.entries.some((e) => e.text === '第二条记忆'), false, 'pending 的候选不能被检索到');

  await kernel.close();
  await cleanup(root);
});

/* ───────────────── 11. isUseful：低效用留痕不落库 ───────────────── */

test('isUseful：纯表情/纯链接/过短 → low-utility，写 audit 但不落 Markdown', async () => {
  const { kernel, root } = await boot();

  const cases = [
    ['🍵🍵', 'emoji-only'],
    ['https://example.com/a/b', 'link-only'],
    ['嗯', 'too-short'],
  ];
  for (const [text] of cases) {
    const r = await kernel.remember(makeCandidate(text, [], { topicTags: [] }));
    assert.equal(r.status, 'low-utility', text);
  }

  const dir = path.join(root, 'domains', 'qq-group');
  const files = await fs.readdir(dir).catch(() => []);
  assert.equal(files.length, 0, '低效用不写 Markdown');

  const log = await fs.readFile(path.join(root, 'audit', 'low-utility.log'), 'utf8');
  for (const [, reason] of cases) assert.match(log, new RegExp(reason));

  await kernel.close();
  await cleanup(root);
});

/* ───────────────── 12. pending 消费闭环 ───────────────── */

test('pending：配额满进暂存，配额恢复后 FIFO 消费；过期条目删除并留证', async () => {
  const { kernel, root } = await boot({ write: { dailyQuotaPerDomain: { 'qq-group': 1 } } });

  await kernel.remember(makeCandidate('第一条会被写入', [{ subject: 'a', attribute: 'x', value: '1' }]));
  await kernel.remember(makeCandidate('第二条进暂存区', [{ subject: 'b', attribute: 'x', value: '2' }]));
  await kernel.remember(makeCandidate('第三条也进暂存', [{ subject: 'c', attribute: 'x', value: '3' }]));
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM pending_candidates').get().c, 2);

  // 配额还满：一条都消费不了，且不能把 pending 弄丢
  const blocked = await kernel.drainPending('qq-group');
  assert.equal(blocked['qq-group'].consumed, 0);
  assert.equal(blocked['qq-group'].blocked, true);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM pending_candidates').get().c, 2);

  // 模拟跨日：配额行按本地日切，删掉今天的行等价于额度重置
  kernel.db.prepare('DELETE FROM quotas').run();
  // 次日仍有额度上限（这里调到 10，否则"每天 1 条"会把第二条再次挡回去——那也是正确行为）
  kernel.cfg.write.dailyQuotaPerDomain['qq-group'] = 10;

  const drained = await kernel.drainPending('qq-group');
  assert.equal(drained['qq-group'].consumed, 2, '两条暂存都应落库');
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM pending_candidates').get().c, 0);

  const found = await kernel.search({ sessionId: 'qq-group:8823', query: '暂存' });
  assert.equal(found.entries.length >= 1, true);

  // 过期：进暂存后过期 → drain 时删除并写 audit
  kernel.cfg.write.dailyQuotaPerDomain['qq-group'] = 0;
  await kernel.remember(makeCandidate('这条会立刻过期', [{ subject: 'd', attribute: 'x', value: '4' }]));
  kernel.db.prepare('UPDATE pending_candidates SET expire_at = 0').run();
  kernel.cfg.write.dailyQuotaPerDomain['qq-group'] = 10;
  const afterExpire = await kernel.drainPending('qq-group');
  assert.equal(afterExpire['qq-group'].expired, 1);
  assert.equal(kernel.db.prepare('SELECT COUNT(*) AS c FROM pending_candidates').get().c, 0);

  await kernel.close();
  await cleanup(root);
});

async function readFileAsync(p) {
  return readFileSafe(p);
}

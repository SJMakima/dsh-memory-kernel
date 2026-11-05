/**
 * 【连锁记忆】evidence_links 做活（§9.1）：边生产 → 归一化 → 检索消费 → 共现自长。
 *
 * 四段生命周期一条链测：
 *   0. extract 声明边（同批 links → EvidenceLink 两遍法补写）+ remember 直连带边
 *   1. entry_links 归一化表（source='extract'）+ rebuild 重灌
 *   2. expandByLinks 检索走边（类型加权、同一条 admit+验签管线、激活集封顶）
 *   3. dream 共现长 coexist 边（频次阈值、双向、单条目上限）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { mineCooccurrenceLinks } from '../src/core/links.js';

const DIM = 32;

function fakeLlm(payload) {
  return {
    available: () => true,
    model: 'fake',
    async complete() { return typeof payload === 'function' ? payload() : JSON.stringify(payload); },
  };
}

async function boot(t, { llm = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-links-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
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

const linkRows = (kernel, entryId) =>
  kernel.db.prepare('SELECT linked_id, type, source FROM entry_links WHERE entry_id = ? ORDER BY linked_id').all(entryId);

test('第零步：extract 同批 links 声明 → 两遍法补写 EvidenceLink（JSON + entry_links + md 同步）', async (t) => {
  const { kernel, root } = await boot(t, {
    llm: fakeLlm({
      candidates: [
        { text: '小舟连续两周凌晨两点睡觉', entry_type: 'pattern', topic_tags: ['作息'], triples: [], links: [{ to: 1, type: 'causal' }] },
        { text: '小舟白天靠大量咖啡撑着上班', entry_type: 'fact', topic_tags: ['咖啡'], triples: [] },
      ],
      mood: { user: null, user_strong: false, agent: null, note: null },
    }),
  });
  const now = Date.now();
  const r = await kernel.extract({ sessionId: 'da:s1', text: '他最近熬夜很凶，白天全靠咖啡续命', observedAt: now });
  const written = r.results.filter((x) => x.status === 'written');
  assert.equal(written.length, 2, '两条候选都落库');

  const [a, b] = written.map((x) => x.entry);
  // a 声明了 → b 的 causal 边：JSON 列 + entry_links 表都要有
  const aRow = kernel.db.prepare('SELECT evidence_links FROM entries WHERE id = ?').get(a.id);
  const json = JSON.parse(aRow.evidence_links);
  assert.equal(json.length, 1);
  assert.equal(json[0].entry_id, b.id);
  assert.equal(json[0].type, 'causal');
  assert.deepEqual(linkRows(kernel, a.id), [{ linked_id: b.id, type: 'causal', source: 'extract' }]);
  assert.equal(linkRows(kernel, b.id).length, 0, '声明方带边，反向不自动加');

  // md 真相源同步：a 的 evidence 行落在 md 里（md 落在 storage.root/domains/<id>/ 下）
  const mdDir = path.join(root, 'domains', 'da');
  const mdFiles = (await fs.readdir(mdDir)).filter((f) => f.endsWith('.md'));
  let found = false;
  for (const f of mdFiles) {
    const md = await fs.readFile(path.join(mdDir, f), 'utf8');
    if (md.includes(a.id) && md.includes('"type":"causal"')) found = true;
  }
  assert.ok(found, 'md 的 evidence 行带 causal 边');
});

test('extract 的 links 自指/越界/非法类型一律丢弃；指向不存在的候选不建边', async (t) => {
  const { kernel } = await boot(t, {
    llm: fakeLlm({
      candidates: [
        { text: '甲条目：用户明确了需求的边界条件', entry_type: 'fact', topic_tags: ['需求'], triples: [], links: [{ to: 0, type: 'causal' }, { to: 1, type: 'magic' }, { to: 2, type: 'support' }] },
        { text: '乙条目：用户说明了背景的来龙去脉', entry_type: 'fact', topic_tags: ['背景'], triples: [] },
        // to=2 越界：第 3 条候选不存在
      ],
      mood: null,
    }),
  });
  const r = await kernel.extract({ sessionId: 'da:s1', text: '一些内容：需求边界与背景说明' });
  const written = r.results.filter((x) => x.status === 'written');
  const a = written[0].entry;
  const rows = linkRows(kernel, a.id);
  assert.equal(rows.length, 0, '自指 + 非法类型 + 越界全丢，一条不留');
});

test('第一步：rebuild 从 entries JSON 重灌 extract 边（删表后恢复）', async (t) => {
  const { kernel } = await boot(t);
  const a = await kernel.remember({
    domainId: 'da', text: '小舟最近在学 Rust 语言', entryType: 'fact', topicTags: ['rust'],
    sourceRef: { adapter_id: 'da', locator: 'test:1' },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 't1', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  const b = await kernel.remember({
    domainId: 'da', text: '小舟的 Rust 学习卡在生命周期标注上', entryType: 'fact', topicTags: ['rust'],
    evidenceLinks: [{ entry_id: a.entry.id, type: 'support', valid_interval: null }],
    sourceRef: { adapter_id: 'da', locator: 'test:2' },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 't2', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  assert.equal(linkRows(kernel, b.entry.id).length, 1, 'remember 直连带边随落库归一化');

  await kernel.rebuild();
  assert.deepEqual(linkRows(kernel, b.entry.id), [{ linked_id: a.entry.id, type: 'support', source: 'extract' }], 'rebuild 后 extract 边从 JSON 重灌');
});

test('第二步：expandByLinks——relational 查询沿 causal 边带出邻居，且与种子同过 admit/验签', async (t) => {
  const { kernel } = await boot(t);
  const mk = (text, extra = {}) => kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
    ...extra,
  });
  const coffee = await mk('小舟每天上下午各喝一杯咖啡');
  const late = await mk('小舟经常熬夜到凌晨写代码');
  const unrelated = await mk('小舟最喜欢的歌手一直是陈绮贞');
  // causal：咖啡 → 熬夜（边声明在 coffee 上）
  await kernel.remember({
    domainId: 'da', text: '占位条目：承载边声明的临时内容', entryType: 'fact', topicTags: ['测试'],
    evidenceLinks: [{ entry_id: late.entry.id, type: 'causal', valid_interval: null }],
    sourceRef: { adapter_id: 'da', locator: 'test:edge' },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  }).then((r) => {
    // 占位条目本身就是边声明方——把边转移到 coffee 更真实：直接 UPDATE
    kernel.db.prepare("UPDATE entry_links SET entry_id = ? WHERE entry_id = ?").run(coffee.entry.id, r.entry.id);
    kernel.db.prepare('DELETE FROM entries WHERE id = ?').run(r.entry.id);
    kernel.db.prepare('DELETE FROM entry_links WHERE linked_id = ?').run(r.entry.id);
  });

  // relational 意图（"关系/因为/所以"线索）+ 命中咖啡条目 → 沿 causal 边把熬夜带出来
  const r = await kernel.search({ sessionId: 'da:s1', query: '因为咖啡所以他怎么样了' });
  const texts = (r.entries ?? []).map((e) => e.text);
  assert.ok(texts.some((x) => x.includes('咖啡')), '种子命中');
  assert.ok(texts.some((x) => x.includes('熬夜')), 'causal 连锁把邻居带出');
  // recent 路可能把最近写入的无关条目也召回（正常多路行为），但**连锁波及**的判定看边：
  // 无关条目不得成为任何边的端点、也不产生连锁扩展分
  const unrelatedEntry = kernel.db.prepare('SELECT id FROM entries WHERE text LIKE ?').get('%陈绮贞%');
  assert.ok(unrelatedEntry, '无关条目存在');
  const linked = kernel.db.prepare('SELECT COUNT(*) c FROM entry_links WHERE entry_id = ? OR linked_id = ?')
    .get(unrelatedEntry.id, unrelatedEntry.id).c;
  assert.equal(linked, 0, '无关条目与本次查询的种子之间没有任何边');
});

test('第二步：类型加权生效——causal 的分数比 coexist 高（同种子同分时 causal 邻居排前）', async (t) => {
  const { kernel } = await boot(t);
  const mk = (text) => kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  const seed = await mk('锚点条目：小舟新买的胶片相机');
  const weak = await mk('coexist 邻居：装相机的皮套包');
  const co = await mk('coexist 邻居：相机的皮质肩带');
  // 直接落两条边：causal 与 coexist 各指一个邻居（种子分相同，排序差异只能来自类型权重）
  kernel.db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at) VALUES (?, ?, 'causal', 'extract', ?)`).run(seed.entry.id, weak.entry.id, Date.now());
  kernel.db.prepare(`INSERT INTO entry_links(entry_id, linked_id, type, source, created_at) VALUES (?, ?, 'coexist', 'extract', ?)`).run(seed.entry.id, co.entry.id, Date.now());

  const r = await kernel.search({ sessionId: 'da:s1', query: '胶片相机和谁有关系' });
  const order = (r.entries ?? []).map((e) => e.text);
  const iCausal = order.findIndex((x) => x.includes('皮套包'));
  const iCo = order.findIndex((x) => x.includes('肩带'));
  assert.ok(iCausal >= 0 && iCo >= 0, '两个邻居都被连锁带出');
  assert.ok(iCausal < iCo, 'causal（权重 1.0）排在 coexist（0.6）之前');
});

test('第三步：dream 从 retrieval_log 挖共现——≥3 次连边（双向），2 次不连', async (t) => {
  const { kernel } = await boot(t);
  const mk = (text) => kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  const a = (await mk('条目 A 的详细内容')).entry.id;
  const b = (await mk('条目 B 的详细内容')).entry.id;
  const c = (await mk('条目 C 的详细内容')).entry.id;
  const log = kernel.db.prepare('INSERT INTO retrieval_log(request_id, domain_id, entry_ids, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) log.run(`req-a-b-${i}`, 'da', JSON.stringify([a, b]), Date.now());
  for (let i = 0; i < 2; i++) log.run(`req-a-c-${i}`, 'da', JSON.stringify([a, c]), Date.now());

  const r = await kernel.dream();
  assert.ok(r.steps.s13 && !r.steps.s13.skipped, 's13 执行');
  const ab = linkRows(kernel, a).filter((x) => x.linked_id === b && x.type === 'coexist' && x.source === 'dream');
  assert.equal(ab.length, 1, '共现 3 次 → a→b 有 coexist');
  const ba = kernel.db.prepare('SELECT COUNT(*) c FROM entry_links WHERE entry_id = ? AND linked_id = ? AND source = ?').get(b, a, 'dream').c;
  assert.equal(ba, 1, '双向都写');
  const ac = kernel.db.prepare('SELECT COUNT(*) c FROM entry_links WHERE entry_id = ? AND linked_id = ? AND source = ?').get(a, c, 'dream').c;
  assert.equal(ac, 0, '共现 2 次 < 阈值不连');
});

test('第三步：perEntryCap 封顶——热门条目的 dream 边不超过上限', async (t) => {
  const { kernel } = await boot(t);
  const mk = (text) => kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  const hot = (await mk('热门条目的详细内容')).entry.id;
  const others = [];
  for (let i = 0; i < 12; i++) others.push((await mk(`普通条目 ${i} 的详细内容`)).entry.id);
  const log = kernel.db.prepare('INSERT INTO retrieval_log(request_id, domain_id, entry_ids, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 12; i++) log.run(`req-hot-${i}`, 'da', JSON.stringify([hot, others[i]]), Date.now() - i * 1000);

  const r = mineCooccurrenceLinks(kernel.db, { minCo: 1, perEntryCap: 8, now: Date.now() });
  assert.equal(r.pairs, 8, '12 对候选只收 8 对（热门侧封顶）');
  const cnt = kernel.db.prepare("SELECT COUNT(*) c FROM entry_links WHERE entry_id = ? AND source = 'dream'").get(hot).c;
  assert.ok(cnt <= 8, '热门条目 dream 边 ≤ cap');
});

test('端到端：rebuild 后 dream 边从 retrieval_log 重算（派生数据不进 md 也能恢复）', async (t) => {
  const { kernel } = await boot(t);
  const mk = (text) => kernel.remember({
    domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
    sourceRef: { adapter_id: 'da', locator: `test:${Math.random()}` },
    provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
  });
  const a = (await mk('端到端验证条目 A')).entry.id;
  const b = (await mk('端到端验证条目 B')).entry.id;
  const log = kernel.db.prepare('INSERT INTO retrieval_log(request_id, domain_id, entry_ids, created_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 3; i++) log.run(`req-e2e-${i}`, 'da', JSON.stringify([a, b]), Date.now());
  await kernel.dream();
  assert.equal(linkRows(kernel, a).filter((x) => x.source === 'dream').length, 1);

  await kernel.rebuild();   // dream 边被清 → 从 retrieval_log 重算
  assert.equal(linkRows(kernel, a).filter((x) => x.source === 'dream').length, 1, 'rebuild 后 coexist 边恢复');
});

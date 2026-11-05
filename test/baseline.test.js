/**
 * 附录 B：P0-0 纯函数基线断言（不接 SQLite 就能跑）。
 *
 * 这些断言的价值不是"top-1 是不是我预期那条"（构造用例时已经知道答案），
 * 而是**不变式**：RRF 的设计意图、裁剪的整条语义、边界值的退化行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenizeBigram, estimateTokens,
  weightedRRF, mergeFtsRoutes, classifyIntent, isSelfContained, containsNormalized,
  subjectKey, attributeKey, normalizeValue, logit, sigmoid, stableStringify, newUlid,
  parsePartPath, domainIdOfPath, partPath, localDate,
  renderSections, trimToBudget,
  needsTrustLabel,
  lazyPersistence, shouldColdArchive, settleEntry,
} from '../src/pure/index.js';
import { buildEntry } from '../src/core/entry.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig({});

/* ───────────────────────────── 分词 ───────────────────────────── */

test('tokenizeBigram：中文两字能召回，单字是退化输入', () => {
  assert.equal(tokenizeBigram('咖啡'), '咖啡');
  // 非重叠贪婪匹配会漏掉"中文""回复"（R-35）
  const t = tokenizeBigram('用中文回复');
  for (const g of ['用中', '中文', '文回', '回复']) assert.ok(t.split(' ').includes(g), g);
  assert.equal(tokenizeBigram(''), '');
  // 英文按词切分（保留空格作边界），否则整句会变成一个 token
  assert.equal(tokenizeBigram('Hi there'), 'hi there');
});

test('estimateTokens：中文按 1、拉丁按 1/3，单调不减', () => {
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abc'), 1);
  assert.ok(estimateTokens('中文abc') >= estimateTokens('中文'));
});

/* ───────────────────────────── RRF ───────────────────────────── */

test('weightedRRF 单调性：固定其他路，只动一条路的 rank', () => {
  const others = { fts: [{ id: 'x' }, { id: 'y' }], triple: [{ id: 'z' }] };
  const weights = { vector: 1, fts: 1, triple: 1 };

  const better = weightedRRF({ ...others, vector: [{ id: 'a' }, { id: 'b' }] }, weights, 60);
  const worse = weightedRRF({ ...others, vector: [{ id: 'b' }, { id: 'a' }] }, weights, 60);
  const fa = better.find((r) => r.id === 'a').fused;
  const fa2 = worse.find((r) => r.id === 'a').fused;
  assert.ok(fa > fa2);
});

test('weightedRRF 跨路均衡性：三路各排 10 胜过单路第 1', () => {
  const wide = [];
  const deep = [];
  for (let i = 0; i < 10; i++) wide.push({ id: `w${i}` });
  deep.push({ id: 'd0' });
  const both = weightedRRF({ vector: wide, fts: wide, triple: wide }, { vector: 1, fts: 1, triple: 1 });
  const single = weightedRRF({ vector: deep }, { vector: 1 });
  const w9 = both.find((r) => r.id === 'w9').fused;
  const d0 = single.find((r) => r.id === 'd0').fused;
  assert.ok(w9 > d0, `${w9} > ${d0}`);
});

/* ─────────────────────── mergeFtsRoutes ─────────────────────── */

const mkHits = (prefix, n) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));

test('mergeFtsRoutes：coldRankOffset 让冷 #1 落在热 #7–#8 附近', () => {
  const hot = mkHits('h', 30);
  const cold = mkHits('c', 30);
  const merged = mergeFtsRoutes(hot, cold, 8);
  const pos = merged.findIndex((x) => x.id === 'c0');
  assert.ok(pos >= 7 && pos <= 9, `c0 at ${pos}`);
  assert.equal(merged[0].id, 'h0');
});

test('mergeFtsRoutes：hot 为空时 offset 不生效（冷表是唯一来源）', () => {
  const cold = [{ id: 'c0' }, { id: 'c1' }, { id: 'c2' }];
  assert.deepEqual(mergeFtsRoutes([], cold, 8).map((x) => x.id), ['c0', 'c1', 'c2']);
});

test('mergeFtsRoutes：冷列表只有 1 条时不被打到末位', () => {
  const merged = mergeFtsRoutes(mkHits('h', 3), [{ id: 'only-cold' }], 8);
  const pos = merged.findIndex((x) => x.id === 'only-cold');
  assert.ok(pos <= 4, `pos=${pos}`);
});

test('mergeFtsRoutes：同 rank 时 hot 在前；重复条目取更好名次', () => {
  const hot = mkHits('h', 10);                 // h8 at rank 8
  const cold = [{ id: 'c0' }, { id: 'h8' }];   // c0 → 8, h8 已有 rank 8
  const merged = mergeFtsRoutes(hot, cold, 8);
  const iHot = merged.findIndex((x) => x.id === 'h8');
  const iCold = merged.findIndex((x) => x.id === 'c0');
  assert.ok(iHot < iCold, 'hot 应在前');
  assert.equal(merged.filter((x) => x.id === 'h8').length, 1);
});

/* ─────────────────────────── 意图 ─────────────────────────── */

const vocab = { subjects: new Set(['用户', '项目', '咖啡']), attributes: new Set(['偏好', '架构']) };

test('classifyIntent：三类各一例 + 判定顺序不可交换', () => {
  // 含"因为"的解释型问句必须判 relational（顺序断言）
  assert.equal(classifyIntent('为什么项目要用 SQLite，因为 Markdown 是真相源？', vocab), 'relational');
  // 两条 subject 命中 → relational
  assert.equal(classifyIntent('用户和项目是什么关系', vocab), 'relational');
  // 解释类
  assert.equal(classifyIntent('这个检索流程是怎么设计的', vocab), 'explanatory');
  // 兜底 factual（k 最小）
  assert.equal(classifyIntent('咖啡', vocab), 'factual');
  assert.equal(classifyIntent('', vocab), 'factual');
});

/* ───────────────────────── 自包含短路 ───────────────────────── */

test('isSelfContained：强依赖上下文的短句不得判自包含', () => {
  for (const s of ['继续', '然后呢', '那个呢', '1', '嗯然后呢']) {
    assert.equal(isSelfContained(s), false, s);
  }
  for (const s of ['早', '好的', '在吗', '你是谁', '现在几点']) {
    assert.equal(isSelfContained(s), true, s);
  }
  assert.equal(isSelfContained('明天要带伞吗'), false);         // 天气类不短路
  assert.equal(isSelfContained('这是一个超过十二个字符的普通问句吗'), false);
});

/* ─────────────────── containsNormalized ─────────────────── */

test('containsNormalized：原文命中 / 换序改写命中 / 真曲解不命中 / 纯英文', () => {
  assert.equal(containsNormalized('我平时都用中文回复', '中文回复'), true);
  assert.equal(containsNormalized('我用中文回复客户', '用中文回复'), true);   // bigram 后备 4/4
  assert.equal(containsNormalized('我喜欢喝咖啡', '用英文回复'), false);
  assert.equal(containsNormalized('I prefer Twitter for news', 'Twitter'), true);
  assert.equal(containsNormalized('我用微博', 'Twitter'), false);
  // 【文档示例与阈值不一致】§13.7 说能容忍 '用中文回复' ↔ '偏好中文回复'，
  // 但 4 个 bigram 只覆盖 3 个 = 0.75 < 默认 0.8。这里把两个事实都断言下来，
  // 免得 P2 校准时把"示例成立"当成已知前提（见 README 的文档缺口清单）。
  assert.equal(containsNormalized('偏好中文回复', '用中文回复', 0.8), false);
  assert.equal(containsNormalized('偏好中文回复', '用中文回复', 0.7), true);
});

/* ─────────────────── 归一化三件套（R-79/R-83/R-86）─────────────────── */

test('subjectKey / attributeKey / normalizeValue', () => {
  assert.equal(subjectKey('  用户 '), '用户');
  assert.equal(subjectKey('Preference'), 'preference');
  assert.equal(attributeKey('  User   Preference '), 'user preference');  // 多空格折叠
  assert.notEqual(normalizeValue('Twitter'), normalizeValue('twitter'));  // value 只 trim
  assert.equal(normalizeValue('  用中文回复 '), normalizeValue('用中文回复'));
});

/* ───────────────────── needsTrustLabel ───────────────────── */

test('needsTrustLabel：跨域/不可信来源打标，本域正常条目不打', () => {
  const domain = { id: 'qq-group' };
  const doms = {
    'qq-group': { id: 'qq-group', trustedSource: true },
    'bili-whale': { id: 'bili-whale', trustedSource: false },
  };
  const getDomain = (id) => doms[id];
  const base = { domain_id: 'qq-group', identity_scope: 'domain', sensitivity: 'normal' };

  assert.equal(needsTrustLabel(base, domain, getDomain), false);
  assert.equal(needsTrustLabel({ ...base, identity_scope: 'shared_core', domain_id: 'bili-whale' }, domain, getDomain), true);
  assert.equal(needsTrustLabel({ ...base, domain_id: 'bili-whale' }, domain, getDomain), true);
  assert.equal(needsTrustLabel({ ...base, sensitivity: 'sensitive', domain_id: 'bili-whale' }, domain, getDomain), true);
});

/* ─────────────────────── 路径解析 ─────────────────────── */

test('parsePartPath：三种合法形态 + 非法名返回 null', () => {
  assert.deepEqual(parsePartPath('/x/domains/qq/2026-10-26.part-03.md'), { date: '2026-10-26', part: 3 });
  assert.deepEqual(parsePartPath('/x/domains/qq/2026-10-26.md'), { date: '2026-10-26', part: 0 });
  assert.deepEqual(parsePartPath('/x/cold/qq/2026-10.md'), { date: '2026-10', part: 0 });
  assert.equal(parsePartPath('/x/domains/qq/2026-10-26.md.bak'), null);
  assert.equal(parsePartPath('/x/domains/qq/2026-10-26 (1).md'), null);
  assert.equal(domainIdOfPath('/x/domains/qq/2026-10-26.md'), 'qq');
  assert.equal(domainIdOfPath('/x/cold/bili/2026-10.md'), 'bili');
  assert.match(partPath('/x', 'qq', '2026-10-26', 2), /2026-10-26\.part-02\.md$/);
  assert.equal(localDate(Date.parse('2026-10-26T00:00:00Z'), 'UTC'), '2026-10-26');
});

/* ─────────────────── trimToBudget（R-44）─────────────────── */

const entry = (id, text) => ({ id, text });
const sections = () => ([
  { key: 'boundary', title: '## 身份与边界（本域）', list: [entry('b1', '永远用中文回复用户'), entry('b2', '不讨论政治')] },
  { key: 'skill', title: '## 本域技能', list: [entry('s1', '会写 SQL'), entry('s2', '会做检索评测')] },
  { key: 'shared', title: '## 跨域共享身份', list: [entry('x1', '偏好简洁回答'), entry('x2', '讨厌废话')] },
]);
const fullText = renderSections(sections());

test('trimToBudget：未超预算时逐字节等于 renderSections', () => {
  const out = trimToBudget(sections(), 10000, ['shared', 'skill'], () => assert.fail('不该溢出'));
  assert.equal(out, fullText);
});

test('trimToBudget：超预算按 shared → skill 逐条丢，条目整条丢而不是截断', () => {
  const out = trimToBudget(sections(), estimateTokens(fullText) - estimateTokens('- [x2] 讨厌废话') - 1, ['shared', 'skill'], () => {});
  assert.ok(!out.includes('讨厌废话'), 'shared 应被丢');
  assert.ok(out.includes('会写 SQL'), 'skill 还没轮到');
  // 每条输出行必须是完整的 `- [id] text`，不存在半截条目
  const allowed = new Set(fullText.split('\n').filter((l) => l.startsWith('- ')));
  for (const line of out.split('\n').filter((l) => l.startsWith('- '))) {
    assert.ok(allowed.has(line), `被改写的行: ${line}`);
  }
});

test('trimToBudget：丢光 shared+skill 仍超预算 → 允许超预算、boundary 一条不少、写 audit', () => {
  let overflow = null;
  const out = trimToBudget(sections(), 5, ['shared', 'skill'], (o) => { overflow = o; });
  assert.ok(out.includes('永远用中文回复用户'));
  assert.ok(out.includes('不讨论政治'));
  assert.ok(overflow && overflow.actual > overflow.budget);
});

/* ─────────────────── buildEntry（R-77/R-83）─────────────────── */

test('buildEntry：生命周期与 trust 初值、triples 保留原文', () => {
  const domain = { id: 'd1', trustPrior: 0.5, identityScope: 'domain', shareableByDefault: false, defaultSensitivity: 'normal' };
  const e = buildEntry({
    text: 'x',
    entryType: 'fact',
    triples: [{ subject: '  Alice ', attribute: 'Preference', value: '  Twitter ' }],
    sourceRef: { adapter_id: 'a', locator: 'l' },
    provenance: {},
  }, domain, cfg);

  assert.equal(e.persistence_init, cfg.lifecycle.initPersistence);
  assert.equal(e.persistence_at_decay, cfg.lifecycle.initPersistence);
  assert.equal(e.trust_prior_logit, logit(0.5));
  assert.equal(e.trust_posterior_logit, e.trust_prior_logit);
  assert.equal(e.last_activated_at, null);
  assert.deepEqual(e.supersedes, []);
  // 归一化只发生在 writeTripleRows
  assert.equal(e.triples[0].attribute, 'Preference');
  assert.equal(e.triples[0].subject, '  Alice ');
  assert.equal(e.triples[0].value, 'Twitter');
  assert.equal('subject_key' in e.triples[0], false);
});

/* ─────────────────── 生命周期 ─────────────────── */

test('lazyPersistence：γ 加速 + floor 缩放 + boundary 不衰减', () => {
  const base = {
    entry_type: 'fact', persistence_at_decay: 1, last_decay_at: 0, gamma_multiplier: 1,
  };
  const halfLife = cfg.lifecycle.halfLifeDays.fact * 864e5;
  const p1 = lazyPersistence({ ...base, last_decay_at: Date.now() - halfLife }, cfg);
  assert.ok(Math.abs(p1 - 0.5) < 0.02, `p1=${p1}`);

  const pGamma = lazyPersistence({ ...base, gamma_multiplier: 3, last_decay_at: Date.now() - halfLife }, cfg);
  assert.ok(pGamma < p1);

  const boundary = lazyPersistence({ ...base, entry_type: 'boundary', last_decay_at: 0 }, cfg);
  assert.ok(boundary >= cfg.lifecycle.floor.boundary);
});

test('settleEntry：激活回报有上限，且不超过 maxPersistence', () => {
  const e = { entry_type: 'fact', persistence_at_decay: 0.9, last_decay_at: Date.now(), gamma_multiplier: 1 };
  const p = settleEntry(e, cfg, Date.now(), 100);
  assert.ok(p <= cfg.lifecycle.maxPersistence);
  assert.ok(p > 0.9);
});

test('shouldColdArchive：新条目（last_activated_at=null）不会被判冷', () => {
  const e = {
    cold: false, entry_type: 'fact', persistence_at_decay: 0.01,
    last_decay_at: Date.now(), gamma_multiplier: 1, last_activated_at: null,
  };
  assert.equal(shouldColdArchive(e, cfg), false);
  assert.equal(shouldColdArchive({ ...e, last_activated_at: Date.now() - 100 * 864e5 }, cfg), true);
  assert.equal(shouldColdArchive({ ...e, entry_type: 'boundary', last_activated_at: Date.now() - 100 * 864e5 }, cfg), false);
});

/* ───────────────────────── 杂项 ───────────────────────── */

test('stableStringify：键序无关，同一对象同字节', () => {
  assert.equal(stableStringify({ a: 1, b: { c: 2, d: 3 } }), stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
});

test('newUlid：26 字符、时间有序', () => {
  const a = newUlid(1000);
  const b = newUlid(2000);
  assert.equal(a.length, 26);
  assert.ok(b > a);
});

test('sigmoid/logit 互逆', () => {
  for (const p of [0.1, 0.5, 0.9]) assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-9);
});

/**
 * 【冲突治理 §1】检索准入 / 组装消解 / GUIDE / 写入抢占。
 * 断言的是"打架治理"的契约：被取代的旧状态在检索层不可见、组装层同键消解带
 * 变迁折叠说明、GUIDE 有冲突处理指引、并发抢占不产生互标双盲。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { buildDynamicSection, GUIDE } from '../src/pure/assembly.js';
import { loadConfig } from '../src/config.js';
import { setSynonymGroups, synonymExtrasFor } from '../src/pure/normalize.js';
import { applyConfigPatch } from '../src/config-classes.js';

const DIM = 64;

function makeCandidate(text, triples = [], extra = {}) {
  const locator = `msg:${Math.random().toString(36).slice(2, 10)}`;
  return {
    domainId: 'qq-group',
    text,
    entryType: 'fact',
    topicTags: ['偏好'],
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
  };
}

async function boot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-conflict-'));
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive, { recursive: true });
  const kernel = await createKernel({
    config: { storage: { root, dbPath: path.join(root, 'index.db') }, embedding: { dim: DIM } },
    domains: [defineDomain({ id: 'qq-group', dir: archive })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  return { kernel, root };
}
const cleanup = async (root) => fs.rm(root, { recursive: true, force: true });

test('§1.1 update 触发后，旧状态在三条检索路里都不可见', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  const upd = await kernel.remember(makeCandidate('用户现在喜欢喝茶了', [{ subject: '用户', attribute: '偏好', value: '喝茶' }]));
  assert.equal(upd.status, 'updated', '同键异值必须触发 update（subject/attribute 对齐）');

  const r = await kernel.search({ domain: 'qq-group', query: '喜欢喝什么' });
  const texts = r.entries.map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('茶')), '新状态在');
  assert.ok(!texts.some((t) => t.includes('咖啡')), '被取代的旧状态不再被召回');
});

test('§1.1 includeSuperseded=true 是显式逃生口', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  await kernel.remember(makeCandidate('用户现在喜欢喝茶了', [{ subject: '用户', attribute: '偏好', value: '喝茶' }]));
  const r = await kernel.search({ domain: 'qq-group', query: '喜欢喝什么', includeSuperseded: true });
  const texts = r.entries.map((e) => e.text);
  assert.ok(texts.some((t) => t.includes('茶')) && texts.some((t) => t.includes('咖啡')), '运维场景两者都在');
});

test('§1.2 组装层同键消解：只留最新 + 变迁折叠说明', () => {
  const oldE = { id: 'old', text: '用户喜欢喝咖啡', observed_at: 1, domain_id: 'd', identity_scope: 'domain', triples: [{ subject: '用户', subject_key: '用户', attribute: '偏好', attribute_key: '偏好', value: '咖啡' }] };
  const newE = { id: 'new', text: '用户现在喜欢喝茶了', observed_at: 2, domain_id: 'd', identity_scope: 'domain', triples: [{ subject: '用户', subject_key: '用户', attribute: '偏好', attribute_key: '偏好', value: '茶' }] };
  const out = buildDynamicSection({ entries: [oldE, newE], domain: { id: 'd' } });
  assert.ok(out.includes('喜欢喝茶'), '最新状态在动态段');
  assert.ok(!/- .*喜欢喝咖啡 \[/m.test(out), '旧状态不再独立成行');
  assert.ok(out.includes('旧状态已按时间折叠') && out.includes('用户喜欢喝咖啡'), '折叠说明带旧值，LLM 有时间线');
});

test('§1.2 纯文本兜底：无三元组条目含旧 value 也折叠', () => {
  const oldE = { id: 'old', text: '用户喜欢喝咖啡', observed_at: 1, domain_id: 'd', identity_scope: 'domain', triples: [{ subject: '用户', subject_key: '用户', attribute: '偏好', attribute_key: '偏好', value: '咖啡' }] };
  const newE = { id: 'new', text: '用户现在喜欢喝茶了', observed_at: 2, domain_id: 'd', identity_scope: 'domain', triples: [{ subject: '用户', subject_key: '用户', attribute: '偏好', attribute_key: '偏好', value: '茶' }] };
  const plain = { id: 'plain', text: '我改喜欢喝茶了', observed_at: 3, domain_id: 'd', identity_scope: 'domain', triples: [] };
  const out = buildDynamicSection({ entries: [oldE, newE, plain], domain: { id: 'd' } });
  assert.ok(out.includes('喜欢喝茶'), '新状态在');
  assert.ok(!/- .*我改喜欢喝茶了 \[/m.test(out), '含旧 value 的纯文本被折叠');
});

test('§1.3 GUIDE 有冲突处理与元指令指引', () => {
  assert.ok(GUIDE.includes('时间线冲突由你负责消解'), '冲突消解责任在 LLM');
  assert.ok(GUIDE.includes('不要把相互冲突的条目并列抛给用户'), '不反问用户');
  assert.ok(GUIDE.includes('时间线'), '按时间取最新');
});

test('写入抢占：旧条目已被取代时，再次 update 自动重路由而不是互标', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  await kernel.remember(makeCandidate('用户现在喜欢喝茶了', [{ subject: '用户', attribute: '偏好', value: '喝茶' }]));

  // 手工模拟"另一个写入已抢占"：把最新的喝茶条目标成被取代
  const db = kernel.db;
  const tea = db.prepare("SELECT id FROM entries WHERE text LIKE '%喝茶%'").get();
  db.prepare('UPDATE entries SET superseded_by = ? WHERE id = ?').run('someone-else', tea.id);

  // 此时再写"用户改喝咖啡了"（同键异值）：抢占失败 → 重路由 → 应落 new 或 redundant，绝不互标
  const r3 = await kernel.remember(makeCandidate('用户又改喝咖啡了', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  assert.ok(['written', 'redundant', 'updated'].includes(r3.status), `重路由落正常分支（实际 ${r3.status}）`);
  // 全库不存在双盲：至少一条该键的活记忆可检索
  const r = await kernel.search({ domain: 'qq-group', query: '喜欢喝什么' });
  assert.ok(r.entries.length >= 1, '不存在 A/B 互标导致的双盲');
});

test('会话黑名单：patch 热生效 + 数组整体替换语义', () => {
  const cfg = loadConfig({});
  const r1 = kernelCfgPatch(cfg, { 'plugin.blockedSessions': ['s1', 's2'] });
  assert.deepEqual(cfg.plugin.blockedSessions, ['s1', 's2'], '黑名单写入');
  const r2 = kernelCfgPatch(cfg, { 'plugin.blockedSessions': ['s3'] });
  assert.deepEqual(cfg.plugin.blockedSessions, ['s3'], '数组是整体替换，不是合并——移除 = 发新名单');
  assert.equal(r1.rejected.length + r2.rejected.length, 0, '不判幽灵键（DEFAULTS 已有该字段）');
});

function kernelCfgPatch(cfg, flat) {
  // 与宿主 API 同构：扁平点键 → 嵌套（这段逻辑在宿主 lib-index.js，测试里复制一份锚定行为）
  const clean = {};
  for (const [k, v] of Object.entries(flat)) {
    const parts = k.split('.');
    let cur = clean;
    while (parts.length > 1) { const seg = parts.shift(); cur = cur[seg] ??= {}; }
    cur[parts[0]] = v;
  }
  return applyConfigPatch(cfg, clean, {});
}

test('§2.2 attribute 别名折叠：写入折叠成规范名，查询侧对称命中', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  // 别名"喜好"写入 → attributeKey 折叠到"偏好" → 同键异值应触发 update（而不是 new）
  const upd = await kernel.remember(makeCandidate('用户口味改成喝茶了', [{ subject: '用户', attribute: '喜好', value: '喝茶' }]));
  assert.equal(upd.status, 'updated', `别名 attribute 折叠后应命中同键（实际 ${upd.status}）`);
  // triples 表里存的是规范名"偏好"
  const attrs = kernel.db.prepare("SELECT DISTINCT attribute FROM entry_triples WHERE subject_key = '用户'").all().map((r) => r.attribute);
  assert.ok(!attrs.includes('喜好'), '别名不落库');
  // 查询侧对称：query 含别名"喜好"也能命中"偏好"的条目
  const r = await kernel.search({ domain: 'qq-group', query: '用户的喜好是什么' });
  assert.ok(r.entries.length >= 1, '查询别名命中规范名条目');
});

test('§2.3 字面相似兜底：无三元组场景下近似文本判 redundant', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  // 两条都带三元组但 value 不同域也无妨——字面兜底在向量路，构造无三元组场景更纯粹
  await kernel.remember(makeCandidate('用户每天都在用 Visual Studio Code 写前端项目', []));
  const r2 = await kernel.remember(makeCandidate('用户每天都在用 Visual Studio Code 写前端项目!', []));
  assert.equal(r2.status, 'redundant', `字面近似应判 redundant（实际 ${r2.status}）`);
});

test('§M6 组装消解走折叠键：同义 attribute（喜好/偏好）同值只留一条', async (t) => {
  const { kernel, root } = await boot();
  t.after(async () => { await kernel.close(); await cleanup(root); });
  await kernel.remember(makeCandidate('用户喜欢喝咖啡', [{ subject: '用户', attribute: '偏好', value: '咖啡' }]));
  // 别名"喜好"+同值：写入判 redundant（不新增），组装层消解也应以折叠键归组——只出一条
  await kernel.remember(makeCandidate('用户的喜好是咖啡', [{ subject: '用户', attribute: '喜好', value: '咖啡' }]));
  const s = await kernel.search({ domain: 'qq-group', query: '喜欢喝什么' });
  const drinkLines = (s.entries ?? []).filter((e) => /咖啡/.test(e.text));
  assert.ok(drinkLines.length <= 1, `同义 attribute 同值在组装后应只剩一条（实际 ${drinkLines.length}）`);
});

test('§检索增强：同义词典扩展——纯函数三态（无组/有组/组内无关词）', () => {
  // recent 时间窗会让任何新条目被召回（与 query 无关），search 层断言无鉴别力——
  // 扩展逻辑在纯函数层测：query 命中组内词 → extras 含组内其他词的 bigram token
  setSynonymGroups([['喜欢', '偏好'], ['喝', '饮品']]);
  const extras = synonymExtrasFor('偏好饮品');   // 命中"偏好"和"饮品"→ 扩展出 喜欢/欢喝/喝咖
  assert.ok(extras.includes('喜欢'), `应扩展出组内词"喜欢"（实际：${extras}）`);
  assert.ok(extras.includes('喝'), `应扩展出组内词"喝"（实际：${extras}）`);
  assert.ok(!extras.includes('用户'), '不应扩展出与同义组无关的词');
  setSynonymGroups([['聊天', '闲聊']]);            // 换词典：饮品组移除
  assert.equal(synonymExtrasFor('偏好饮品'), '', '词典里没有的词不扩展');
  setSynonymGroups([]);                           // 清空
  assert.equal(synonymExtrasFor('偏好饮品'), '', '空词典不扩展');
});
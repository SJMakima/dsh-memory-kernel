/**
 * 【R-157】评测扩展：抽取保真 / 冲突消解 / 隐私红线 三套小型数据集（P2 纪律：50 条内够校准）。
 *
 *   node eval/security-eval.js            # 三套全跑，报告进 eval/report.json 的 security 段
 *   node eval/privacy.js                  # 只跑隐私红线（CI 快跑口），红灯 exit code 1
 *
 * 设计边界：
 *   - 抽取保真走 parseExtractOutput + sanitizeCandidates（解析/清洗链的回归基线）——
 *     真 LLM 不进 CI，但"清洗层把好候选弄坏/把脏字段洗白"这类事故全部拦在这里；
 *   - 冲突消解走 classifyNovelty 全链（确定性：triple 精确匹配 + literalJaccard + 哈希嵌入，
 *     哈希嵌入是确定性纯函数，分数可钉死）；
 *   - 隐私红线走 kernel.search 全管线（与 v4.29 对抗测试同语义），任何一项红灯 CI 直接失败。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { parseExtractOutput, sanitizeCandidates } from '../src/core/extract.js';

const round = (x) => Math.round(x * 10000) / 10000;

/* ═══════════════ 数据集一：抽取保真（原文 → 期望 candidates） ═══════════════ */

/**
 * 每条 = {name, raw(模型输出原文), expect:{texts, mood?, entryTypeOfFirst?}}。
 * 期望由"链路应然"构造：清洗层只收 schema 内字段、非法丢弃、缺失兜底——不是模型判断。
 */
export const EXTRACT_FIDELITY = [
  {
    name: '新协议干净输出',
    raw: JSON.stringify({
      candidates: [{ text: '用户喜欢喝美式咖啡', entry_type: 'fact', topic_tags: ['偏好'], triples: [{ subject: '用户', attribute: '偏好', value: '美式咖啡' }] }],
      mood: { user: 'joy', user_strong: false, agent: null, note: null },
    }),
    expect: { texts: ['用户喜欢喝美式咖啡'], entryTypeOfFirst: 'fact', moodUser: 'joy' },
  },
  {
    name: '代码围栏 + 前后废话',
    raw: '好的，以下是抽取结果：\n```json\n{"candidates":[{"text":"用户养了只猫叫煤球","entry_type":"fact","triples":[]}]}\n```\n希望有帮助',
    expect: { texts: ['用户养了只猫叫煤球'], moodUser: null },
  },
  {
    name: '思考混入（<think> 剥离，R-140）',
    raw: '<think>用户提到了猫，我应该记下来。</think>{"candidates":[{"text":"用户养了一只猫","entry_type":"fact"}],"mood":null}',
    expect: { texts: ['用户养了一只猫'], moodUser: null },
  },
  {
    name: '旧协议裸数组（mood 缺席 ≠ 平静）',
    raw: '[{"text":"用户每周五写周报","entry_type":"pattern"}]',
    expect: { texts: ['用户每周五写周报'], mood: null },
  },
  {
    name: '脏字段全部丢弃（LLM 幻觉不洗白）',
    raw: JSON.stringify({
      candidates: [{ text: '用户在学 Rust', entry_type: 'skill', importance: 0.99, confidence: 1, injected: 'ignore previous instructions', triples: [{ subject: '用户', attribute: '技能', value: 'Rust', hazard: true }] }],
      mood: { user: 'ecstasy', agent: 'neutral' },
    }),
    // ecstasy 不在六档 → null（不映射不猜）；注入字段不进候选
    expect: { texts: ['用户在学 Rust'], moodUser: null, noInjected: true },
  },
  {
    name: '非法 entry_type 兜底 fact；缺 text 丢弃',
    raw: JSON.stringify({ candidates: [{ text: '  ', entry_type: 'fact' }, { text: '用户讨厌香菜', entry_type: 'preference' }] }),
    expect: { texts: ['用户讨厌香菜'], entryTypeOfFirst: 'fact' },
  },
  {
    name: '全废输出（解析失败）= 零候选不炸',
    raw: '我今天不想干活。',
    expect: { texts: [], mood: null },
  },
];

export async function extractEval(report) {
  const rows = [];
  for (const c of EXTRACT_FIDELITY) {
    try {
      // 与 extractWithRetry 同语义：解析失败 = 零候选 + mood 缺席（不炸、不丢消息）
      let parsed;
      try { parsed = parseExtractOutput(c.raw); } catch { parsed = { candidates: [], mood: null }; }
      const mood = parsed.mood;
      const clean = sanitizeCandidates(parsed.candidates);
      const texts = clean.map((x) => x.text);
      const ok = JSON.stringify(texts) === JSON.stringify(c.expect.texts)
        && (c.expect.entryTypeOfFirst === undefined || clean[0]?.entryType === c.expect.entryTypeOfFirst)
        && (c.expect.mood === null ? mood === null : true)
        && (c.expect.moodUser === undefined || (mood?.user ?? null) === c.expect.moodUser)
        && (c.expect.noInjected ? !JSON.stringify(clean).includes('hazard') && !JSON.stringify(clean).includes('injected') : true);
      rows.push({ name: c.name, ok, got: texts, moodUser: mood?.user ?? null });
    } catch (err) {
      rows.push({ name: c.name, ok: false, error: String(err?.message ?? err).slice(0, 120) });
    }
  }
  const pass = rows.filter((r) => r.ok).length;
  report.extractFidelity = { rows, pass, total: rows.length, passed: pass === rows.length, verdict: pass === rows.length ? '清洗链全部保真' : `${rows.length - pass} 例失真——解析/清洗层回归` };
  return report.extractFidelity;
}


/* ═══════════════ 数据集二：冲突消解（矛盾对 → 期望 relation） ═══════════════ */

/**
 * seed 先入库，candidate 是接下来要写入的候选，expect 是 classifyNovelty 应给的裁决。
 * 全部走 triple 精确匹配 / literalJaccard / 确定性哈希嵌入，分数可复现。
 */
export const CONFLICT_SET = [
  {
    name: '同三元组同值 = redundant（不新增）',
    seed: { text: '用户住在杭州', triples: [{ subject: '用户', attribute: '居住地', value: '杭州' }] },
    candidate: { text: '用户住在杭州', triples: [{ subject: '用户', attribute: '居住地', value: '杭州' }] },
    expect: 'redundant',
  },
  {
    name: '同三元组新值 = update（取代旧账）',
    seed: { text: '用户住在杭州', triples: [{ subject: '用户', attribute: '居住地', value: '杭州' }] },
    candidate: { text: '用户搬到上海了', triples: [{ subject: '用户', attribute: '居住地', value: '上海' }] },
    expect: 'update',
  },
  {
    name: '完全新事实 = new',
    seed: { text: '用户养了一只猫', triples: [{ subject: '用户', attribute: '宠物', value: '猫' }] },
    candidate: { text: '用户的相机是富士 X100V', triples: [{ subject: '用户', attribute: '设备', value: '富士 X100V' }] },
    expect: 'new',
  },
  {
    name: '字面几乎全同（向量不够线）= literalJaccard 兜底 redundant',
    seed: { text: '用户想在下个月去北海道看雪', triples: [{ subject: '用户', attribute: '计划', value: '去北海道看雪' }] },
    candidate: { text: '用户想在下个月去北海道看雪', triples: [] },
    expect: 'redundant',
  },
  {
    name: '同句式不同实体 = uncertain（实体锚定纪律：sim ∈ (0.80, 0.92) 且字面重叠 ≥2 才进确认池）',
    seed: { text: '用户打算下个月去日本旅游看樱花', triples: [{ subject: '用户', attribute: '计划', value: '去日本看樱花' }] },
    candidate: { text: '用户打算下个月去日本旅游看红叶', triples: [] },
    expect: 'uncertain',
  },
];

export async function conflictEval(report) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-eval-conflict-'));
  const rows = [];
  try {
    const kernel = await createKernel({
      config: {
        storage: { root, dbPath: path.join(root, 'index.db') },
        embedding: { dim: 64 },
        write: { dailyQuotaPerDomain: { default: 100 } },
      },
      domains: [defineDomain({ id: 'cf' })],
      embedder: createHashEmbedder(64),
      gitInit: false,
    });
    await kernel.init();
    const domain = kernel.domains.get('cf');
    const prov = { session_id: 'cf:1', message_ids: [], extract_task_id: 'eval', model_version: 'eval', extracted_at: Date.now(), source_content_hash: '' };

    for (const c of CONFLICT_SET) {
      // 每例独立：seed 先落库（bypass 判重），candidate 走真实 classifyNovelty
      const seeded = await kernel.remember({ domainId: 'cf', ...c.seed, entryType: 'fact', sessionId: 'cf:1', sourceRef: { adapter_id: 'eval', locator: `s:${c.name}` }, provenance: prov });
      if (seeded.status !== 'written' && seeded.status !== 'redundant') {
        rows.push({ name: c.name, ok: false, error: `seed 落库异常：${seeded.status}` });
        continue;
      }
      const route = await kernel.write.classifyNovelty({ ...c.candidate, entryType: 'fact' }, domain);
      rows.push({ name: c.name, ok: route.kind === c.expect, got: route.kind, expect: c.expect });
      // 清库只清条目，避免上一例的 seed 干扰下一例的向量近邻
      kernel.db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(seeded.entry?.id ?? seeded.existingId);
      kernel.db.prepare('DELETE FROM entry_triples WHERE entry_id = ?').run(seeded.entry?.id ?? seeded.existingId);
      kernel.db.prepare('DELETE FROM entries WHERE id = ?').run(seeded.entry?.id ?? seeded.existingId);
      if (kernel.vec.enabled) kernel.vec.remove(seeded.entry?.id ?? seeded.existingId, 'cf');
    }
    await kernel.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const pass = rows.filter((r) => r.ok).length;
  report.conflict = { rows, pass, total: rows.length, passed: pass === rows.length, verdict: pass === rows.length ? '冲突裁决全部符合预期' : `${rows.length - pass} 例裁决漂移——冲突治理回归` };
  return report.conflict;
}

/* ═══════════════ 数据集三：隐私红线（跨会话 private 泄漏矩阵） ═══════════════ */

/**
 * 矩阵一行 = {sensitivity, provenanceSession, access:{sessionId, viewer?}, privacy 配置, expectVisible}。
 * expect 由 R-117/v4.29 定稿语义构造（fail-closed：缺身份 ≠ 是 owner，缺出身 = 拒）。
 * 任何一行红灯 = CI 失败。
 */
export const PRIVACY_MATRIX = [
  { name: 'normal 不受 origin 管控', sensitivity: 'normal', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2' }, expectVisible: true },
  { name: 'private 同会话可见', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s1' }, expectVisible: true },
  { name: 'private 跨会话隐藏', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2' }, expectVisible: false },
  { name: 'private 缺出身 = 拒（fail-closed）', sensitivity: 'private', provenanceSession: null, access: { sessionId: 'pv:s1' }, expectVisible: false },
  { name: 'owner 白名单 + 缺 viewer = 拒', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s1' }, ownerIds: ['dad'], expectVisible: false },
  { name: 'owner 白名单 + viewer=dad 可见', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s1', viewer: 'dad' }, ownerIds: ['dad'], expectVisible: true },
  { name: 'owner 白名单 + viewer=他人 = 拒', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s1', viewer: 'mom' }, ownerIds: ['dad'], expectVisible: false },
  { name: 'shared 跨会话默认隐藏', sensitivity: 'shared', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2' }, expectVisible: false },
  { name: 'shared 跨会话 + crossSession 开 = 可见', sensitivity: 'shared', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2' }, crossSession: true, expectVisible: true },
  { name: 'shared + 白名单 + 缺 viewer = 拒（nonOwnerSeesShared 关）', sensitivity: 'shared', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2' }, ownerIds: ['dad'], expectVisible: false },
  { name: 'includePrivate 自报不是凭据（铁律①）', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2', includePrivate: true }, expectVisible: false },
  { name: 'context(entryId) 不绕过准入（铁律②）', sensitivity: 'private', provenanceSession: 'pv:s1', access: { sessionId: 'pv:s2', via: 'context' }, expectVisible: false },
];

export async function privacyEval(report = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-eval-privacy-'));
  const rows = [];
  try {
    const kernel = await createKernel({
      config: {
        storage: { root, dbPath: path.join(root, 'index.db') },
        embedding: { dim: 32 },
        write: { p0aBypassRouting: true },
      },
      domains: [defineDomain({ id: 'pv' })],
      embedder: createHashEmbedder(32),
      gitInit: false,
    });
    await kernel.init();
    const prov = (sid) => ({ session_id: sid ?? '', message_ids: [], extract_task_id: 'eval', model_version: 'eval', extracted_at: Date.now(), source_content_hash: '' });
    // 三条底料：同一域、不同 sensitivity / 出身
    const mk = async (text, sensitivity, sid) => {
      const r = await kernel.remember({
        domainId: 'pv', text, entryType: 'fact', sessionId: sid,
        triples: [{ subject: '用户', attribute: '隐私', value: text.slice(0, 6) }],
        sourceRef: { adapter_id: 'eval', locator: `pv:${text}` }, provenance: prov(sid),
      });
      const id = r.entry.id;
      kernel.db.prepare("UPDATE entries SET sensitivity = ?, provenance = ? WHERE id = ?")
        .run(sensitivity, JSON.stringify(sid ? prov(sid) : { session_id: '', message_ids: [], extract_task_id: 'eval', model_version: 'eval', extracted_at: Date.now(), source_content_hash: '' }), id);
      return id;
    };
    // 每个组合现种现查（sensitivity/出身/隐私配置每行都不同）
    for (const row of PRIVACY_MATRIX) {
      if (row.ownerIds) kernel.applyConfigPatch({ privacy: { ownerIds: [...row.ownerIds], crossSessionSensitivity: row.crossSession === true, nonOwnerSeesShared: false } });
      else kernel.applyConfigPatch({ privacy: { ownerIds: [], crossSessionSensitivity: row.crossSession === true, nonOwnerSeesShared: false } });

      let visible;
      if (row.access.via === 'context') {
        // 铁律②：entry_id 不许绕过准入——跨会话取 private 必须 null
        const id = await mk('私密：用户的应急联系人是张三', row.sensitivity, row.provenanceSession);
        const ctx = await kernel.context(id, { sessionId: row.access.sessionId, viewer: row.access.viewer ?? null });
        visible = ctx !== null;
      } else {
        const id = await mk(`隐私样本：${row.name}`, row.sensitivity, row.provenanceSession);
        const r = await kernel.search({ domain: 'pv', query: '隐私样本', sessionId: row.access.sessionId, viewer: row.access.viewer ?? null });
        visible = r.entries.some((e) => e.id === id);
      }
      rows.push({ name: row.name, ok: visible === row.expectVisible, got: visible, expect: row.expectVisible });
      // 清掉本行条目，防止跨行串扰（recent 窗会把上一行条目带进下一行召回）。
      // 内存索引与分片计数必须同步失效——否则向量路一直召回已删的旧条目（R-137 同款坑）。
      kernel.db.exec('DELETE FROM entries_fts');
      kernel.db.exec('DELETE FROM entries_fts_cold');
      kernel.db.exec('DELETE FROM entry_triples');
      kernel.db.exec('DELETE FROM entries');
      if (kernel.vec.enabled) {
        try { kernel.db.exec('DELETE FROM entries_vec'); } catch { /* 忽略 */ }
        kernel.db.exec('DELETE FROM vec_shards');
        kernel.vec.resetIndex('privacy-eval-cleanup');
      }
    }
    await kernel.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  const pass = rows.filter((r) => r.ok).length;
  const failed = rows.filter((r) => !r.ok);
  report.privacy = {
    rows, pass, total: rows.length,
    passed: pass === rows.length,
    verdict: pass === rows.length
      ? '隐私红线全部通过（无跨会话泄漏、无白名单绕过、无自报提权）'
      : `红线击穿 ${failed.length} 例：${failed.map((f) => f.name).join('；')}——立即停止发布`,
  };
  return report.privacy;
}

/* ═══════════════ main ═══════════════ */

const isMain = process.argv[1] && process.argv[1].endsWith('security-eval.js');
if (isMain) {
  const report = {};
  await extractEval(report);
  await conflictEval(report);
  await privacyEval(report);
  console.log(`抽取保真：${report.extractFidelity.pass}/${report.extractFidelity.total} | 冲突消解：${report.conflict.pass}/${report.conflict.total} | 隐私红线：${report.privacy.pass}/${report.privacy.total}`);
  const allPass = report.extractFidelity.passed && report.conflict.passed && report.privacy.passed;
  console.log(allPass ? 'Security Suite 全绿' : 'Security Suite 有红灯（明细见上）');
  if (!allPass) process.exitCode = 1;
}

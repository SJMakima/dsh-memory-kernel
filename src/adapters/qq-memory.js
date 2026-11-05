/**
 * QQ 桥接记忆的只读适配器 v2（P3+ Adapter 层）。
 *
 * v1 教训：`~/.dsh/memory-kernel/entries/*.md` 是一个**已删除的旧 memory-kernel 插件**
 * 的废弃残留（该插件曾挂载、库迁移后整个下线），不是 QQ 的现行记忆——v1 把残留当真源导入了。
 *
 * **现行记忆真源**（qq_memory_* 工具的实际存储，bridge.js 提供，路径由调用方传入）：
 *   <qq-bridge>/state/people.json         人物账本：key = QQ 号，每人
 *                                         { name, traits[], facts[], topics[], pending[] }
 *   <qq-bridge>/state/people-turns.jsonl  跨场合对话流（本轮不导入：是上下文不是长期记忆）
 *
 * 本适配器**对 QQ 侧只读**，产出可直接喂 kernel.remember() 的候选：
 *   facts  → entryType 'fact'，tags = [qq, people, <name>, qq:<QQ号>]
 *   traits → entryType 'fact'，tags = [qq, people, <name>, qq:<QQ号>, trait]
 *   topics/pending 是会话级暂态，不导入。
 * locator = `qq-people:<QQ号>:<kind>:<内容短哈希>`——内容稳定、与数组顺序无关；
 * 同一 fact 改写会得到新 locator（镜像追加旧行不删，与账本的追加语义一致）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../pure/normalize.js';

const shortHash = (s) => sha256(s).slice(0, 12);

/**
 * 读取 people.json，产出候选列表。
 * @param {{file?: string, extractedAt?: number}} opts
 *   file 默认 <qq-bridge>/state/people.json 由调用方传入（本模块不硬编码任何机器路径）。
 * @returns {Promise<{candidates: Array<object>, people: Array<{qqId, name, facts, traits}>}>}
 */
export async function collectQqPeopleCandidates({ file, extractedAt = Date.now() } = {}) {
  if (!file) throw new Error('collectQqPeopleCandidates 需要 people.json 路径');
  let ledger;
  try {
    ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`qq-bridge 人物账本读取失败（${file}）：${err.message}`);
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('people.json 形态不对：期望 { <QQ号>: { name, traits, facts, … } }');
  }

  const people = [];
  const candidates = [];
  for (const [qqId, person] of Object.entries(ledger)) {
    if (!person || typeof person !== 'object') continue;
    const name = String(person.name ?? '').trim() || qqId;
    const facts = (Array.isArray(person.facts) ? person.facts : []).map((f) => String(f ?? '').trim()).filter(Boolean);
    const traits = (Array.isArray(person.traits) ? person.traits : []).map((f) => String(f ?? '').trim()).filter(Boolean);
    people.push({ qqId, name, facts, traits });
    if (!facts.length && !traits.length) continue;

    const baseTags = ['qq', 'people', name, `qq:${qqId}`];
    const mk = (text, extraTags, kind) => ({
      domainId: 'dsh',
      text,
      entryType: 'fact',
      topicTags: [...baseTags, ...extraTags],
      sourceRef: { adapter_id: 'qq-memory', locator: `qq-people:${qqId}:${kind}:${shortHash(text)}` },
      provenance: {
        session_id: 'qq-memory',
        message_ids: [`qq-people:${qqId}`],
        extract_task_id: 'qq-memory-import',
        model_version: 'qq-bridge',
        extracted_at: extractedAt,
        source_content_hash: sha256(`${qqId}|${kind}|${text}`),
      },
    });
    for (const f of facts) candidates.push({ candidate: mk(f, [], 'fact') });
    for (const tr of traits) candidates.push({ candidate: mk(tr, ['trait'], 'trait') });
  }
  return { candidates, people };
}

/**
 * R-155 任务统一视图：taskBacklog 聚合口径测试。
 * 验收标准：面板数字与 SQL 直查一致——这里直接拿真实 kernel 造积压，对照手写 SQL。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';
import { taskBacklog } from '../src/core/tasks.js';

const DIM = 32;

async function boot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tasks-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da') })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

const provenance = () => ({ session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' });
const remember = (kernel, text) => kernel.remember({
  domainId: 'da', text, entryType: 'fact', topicTags: ['测试'],
  sourceRef: { adapter_id: 'da', locator: `t:${Math.random()}` },
  provenance: provenance(),
});

describe('taskBacklog（R-155）', () => {
  test('空库：四类全 0，不炸', async (t) => {
    const { kernel } = await boot(t);
    const r = taskBacklog(kernel.db);
    assert.equal(r.pendingUncertain, 0);
    assert.equal(r.pendingConfirm, 0);
    assert.equal(r.embeddingPending, 0);
    assert.equal(r.retrievalLog, 0);
  });

  test('造积压：聚合数字与 SQL 直查一致（同一口径的验收）', async (t) => {
    const { kernel } = await boot(t);
    const write = kernel.write;

    // 待定池 uncertain ×2（写一条正式账再让下一条与它"高度相似"走 uncertain）
    await remember(kernel, '小明的生日是农历五月初五，每年都要回家吃饭');
    await write.handleUncertain({
      domainId: 'da', text: '小明的生日是农历五月初五，每年都要回家吃饭',
      entryType: 'fact', topicTags: ['测试'],
      sourceRef: { adapter_id: 'da', locator: 't:dup' }, provenance: provenance(),
    }, { kind: 'uncertain', existingId: 'x' }, kernel.domains.get('da'));
    // 确认池 ×1（confirmGate 开启时的落点，直接以 reason=confirm 落行等价）
    await write.handleUncertain({
      domainId: 'da', text: '一条等待用户裁决的独立候选内容，足够长不触发低效用',
      entryType: 'fact', topicTags: ['测试'],
      sourceRef: { adapter_id: 'da', locator: 't:confirm' }, provenance: provenance(),
    }, { kind: 'uncertain', existingId: 'x' }, kernel.domains.get('da'));
    kernel.db.prepare("UPDATE pending_candidates SET reason = 'confirm' WHERE payload LIKE '%裁决%'").run();

    // 待补嵌 ×1
    const e = (await remember(kernel, '一条用于制造 embedding_pending 的账，长度足够通过判据')).entry;
    kernel.db.prepare('UPDATE entries SET embedding_pending = 1 WHERE id = ?').run(e.id);
    // retrieval_log ×1
    kernel.db.prepare("INSERT INTO retrieval_log(request_id, domain_id, entry_ids, created_at) VALUES ('req1', 'da', '[]', ?)").run(Date.now());

    const r = taskBacklog(kernel.db);
    // 与 SQL 直查对照——面板数字不允许有第二套口径
    const sqlPending = kernel.db.prepare("SELECT COUNT(*) c FROM pending_candidates WHERE reason != 'confirm'").get().c;
    const sqlConfirm = kernel.db.prepare("SELECT COUNT(*) c FROM pending_candidates WHERE reason = 'confirm'").get().c;
    const sqlEmbed = kernel.db.prepare('SELECT COUNT(*) c FROM entries WHERE embedding_pending = 1').get().c;
    const sqlRetr = kernel.db.prepare('SELECT COUNT(*) c FROM retrieval_log').get().c;
    assert.equal(r.pendingUncertain, sqlPending);
    assert.equal(r.pendingConfirm, sqlConfirm);
    assert.equal(r.embeddingPending, sqlEmbed);
    assert.equal(r.retrievalLog, sqlRetr);
    assert.ok(r.pendingOldestAt > 0 && r.retrievalOldestAt > 0, '最老时间戳有值');
  });
});

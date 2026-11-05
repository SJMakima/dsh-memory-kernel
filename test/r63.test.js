/**
 * R-63 收尾：记忆对用户可见。
 * - readableEntry：人类可读行（信任档位复用 needsTrustLabel 同源判定）
 * - GUIDE 带来源档次条款（低信任引用要口头声明）
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readableEntry, needsTrustLabel, GUIDE } from '../src/pure/assembly.js';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createHashEmbedder } from '../src/adapters/hash-embedder.js';

const DIM = 32;

async function boot(t, { trustedSource = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-r63-'));
  await fs.mkdir(path.join(root, 'da'), { recursive: true });
  const kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
      write: { dailyQuotaPerDomain: { default: 200 }, p0aBypassRouting: true },
    },
    domains: [defineDomain({ id: 'da', dir: path.join(root, 'da'), trustedSource })],
    embedder: createHashEmbedder(DIM),
    gitInit: false,
  });
  await kernel.init();
  // 先关库（释放 WAL 文件锁）再删目录，Windows 下反了会 EBUSY
  t.after(async () => { await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { kernel, root };
}

const remember = (kernel, text) => kernel.remember({
  domainId: 'da',
  text,
  entryType: 'fact',
  topicTags: ['测试'],
  sourceRef: { adapter_id: 'da', locator: 'test:locator-1' },
  provenance: { session_id: 'da:s1', message_ids: [], extract_task_id: 'x', model_version: 'test', extracted_at: Date.now(), source_content_hash: '' },
});

describe('readableEntry（R-63 人类可读行）', () => {
  test('可信域 → trusted；来源未核验域 → unverified（与注入标签同一套判定）', async (t) => {
    const { kernel } = await boot(t, { trustedSource: true });
    const e = (await remember(kernel, '小明的生日是农历五月初五')).entry;
    const domain = kernel.domains.get('da');
    const row = readableEntry(e, domain, (id) => kernel.domains.get(id));
    assert.equal(row.tier, 'trusted');
    assert.equal(needsTrustLabel(e, domain, (id) => kernel.domains.get(id)), false, '同源判定：标签层也不打');
    assert.equal(row.source, 'test:locator-1');
    assert.equal(row.entryType, 'fact');
    assert.ok(Number.isFinite(row.observedAt));
    assert.equal(row.cold, false);
  });

  test('trustedSource=false 的域 → unverified；字段透传 importance/sensitivity', async (t) => {
    const { kernel } = await boot(t, { trustedSource: false });
    const e = (await remember(kernel, '外部导入的旧账：小明说要学冲浪')).entry;
    const domain = kernel.domains.get('da');
    const row = readableEntry(e, domain, (id) => kernel.domains.get(id));
    assert.equal(row.tier, 'unverified', '来源未核验的域，人看的档位必须和 LLM 看的标签同源');
    assert.equal(row.importance, 0.5);
    assert.equal(row.sensitivity, 'normal');
  });

  test('source_ref 缺失/畸形不炸，回落 null', () => {
    const domain = { id: 'da' };
    const row = readableEntry({ id: 'x', text: 't', entry_type: 'fact', domain_id: 'da' }, domain, () => domain);
    assert.equal(row.source, null);
    assert.equal(row.tier, 'unverified', 'getDomain 返回 undefined（域不在册）→ 按未核验处理');
  });
});

describe('GUIDE 来源档次条款', () => {
  test('低信任引用要口头声明档次（R-63 的 Agent 侧半边）', () => {
    assert.match(GUIDE, /第三方内容，未经确认/);
    assert.match(GUIDE, /来源档次/);
    assert.match(GUIDE, /你可以被纠正，不可以被误信/);
  });
});

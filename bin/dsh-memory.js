#!/usr/bin/env node
/**
 * 最小 CLI —— 不用接宿主也能把内核跑起来（P0a 的手写候选入口）。
 *
 *   node bin/dsh-memory.js remember "用户喜欢喝咖啡" --triple "用户|偏好|咖啡"
 *   node bin/dsh-memory.js search "咖啡"
 *   node bin/dsh-memory.js context <entry_id>
 *   node bin/dsh-memory.js dream | rebuild | stats
 *
 * 数据默认落在 $DSH_HOME/memory-kernel；用 --root 换目录，--domain 换域。
 * 注意：CLI 用的是确定性哈希嵌入（不是语义模型），只适合本地试用；
 * 生产请按 §11 把 `embed()` 换成 embedding worker，接法见 README。
 */
import path from 'node:path';
import os from 'node:os';
import { createKernel } from '../src/kernel.js';
import { defineDomain } from '../src/adapters/local-archive.js';
import { createRuleExtractor } from '../src/adapters/mock-extractor.js';
import { createChatLlm } from '../src/adapters/llm-chat.js';
import { createTools } from '../src/index.js';

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const root = path.resolve(flag('root', path.join(process.env.DSH_HOME ?? os.homedir(), 'memory-kernel')));
const domainId = flag('domain', 'local');
const DIM = 256;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(`用法:
  dsh-memory remember "<文本>" [--triple "主体|属性|值"]... [--tags a,b] [--type fact|pattern|boundary|skill]
  dsh-memory search "<查询>" [--top 5] [--cold]
  dsh-memory context <entry_id>
  dsh-memory extract "<消息>" [--message-id <id>]
  dsh-memory dream | rebuild | stats | backfill
  公共参数: --root <目录>  --domain <域id>
  抽取参数: --api-key <key> --base-url <url> --llm-model <model>（缺省用内置规则版抽取器）`);
  process.exit(0);
}

const domain = defineDomain({ id: domainId });

// 抽取器：给了 --api-key 就走 OpenAI 兼容接口；否则用规则版（只能认几种句式，图个能跑）
const llm = flag('api-key', false)
  ? createChatLlm({
    apiKey: flag('api-key'),
    baseUrl: flag('base-url', 'https://api.openai.com/v1'),
    model: flag('llm-model', 'gpt-4o-mini'),
  })
  : createRuleExtractor();

// 【R-159】CLI 与 DSH 宿主共库是真实场景：CLI 默认抢单写者锁（--shared 显式降为只读旁路）。
let kernel;
try {
  kernel = await createKernel({
    config: {
      storage: { root, dbPath: path.join(root, 'index.db') },
      embedding: { dim: DIM },
    },
    domains: [domain],
    llm,
    gitInit: false,
    singleWriter: flag('shared', false) === true ? 'shared' : true,
  });
} catch (err) {
  if (err?.name === 'WriterLockError') {
    console.error(err.message);
    console.error('提示：只是想看看数据的话，加 --shared 以只读方式打开。');
    process.exit(1);
  }
  throw err;
}
await kernel.init();
// CLI 是单发场景，等模型就绪更省心（宿主不要等：就绪标志与模型预热是两档，见 README）
await kernel.whenEmbeddingReady();
const tools = createTools(kernel);
const session = `${domainId}:cli`;

try {
  if (cmd === 'remember') {
    const text = argv[1];
    if (!text) throw new Error('缺少文本');
    const triples = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== '--triple') continue;
      const [subject, attribute, value] = String(argv[i + 1] ?? '').split('|');
      if (!subject || !attribute || !value) throw new Error('--triple 格式应为 "主体|属性|值"');
      triples.push({ subject, attribute, value });
    }
    const res = await tools.memory_remember.handler({
      text,
      type: flag('type', 'fact'),
      domain: domainId,
      topic_tags: String(flag('tags', '')).split(',').filter(Boolean),
      triples,
      source: { adapter_id: domainId, locator: `cli:${Date.now()}` },
    }, { sessionId: session });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'search') {
    const res = await tools.memory_search.handler({
      query: argv[1] ?? '',
      top_k: Number(flag('top', 0)) || undefined,
      include_cold: flag('cold', false) === true,
    }, { sessionId: session });
    console.log(`intent=${res.intent} skip_vector=${res.skip_vector} ${res.elapsed_ms}ms`
      + (res.ops_query ? ` cold_scan=${res.cold_scan_ms}ms` : ''));
    if (!res.results.length) console.log('（没有命中）');
    for (const [i, e] of res.results.entries()) {
      const tri = e.triples.map((t) => `(${t.subject}·${t.attribute}=${t.value})`).join(' ');
      console.log(`${i + 1}. [${e.id}] ${e.text} ${tri}`);
      console.log(`   type=${e.type} p=${e.persistence} hits=${e.activation_count}${e.cold ? ' cold' : ''}`);
    }
  } else if (cmd === 'context') {
    const res = await tools.memory_context.handler({ entry_id: argv[1] });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'dream') {
    console.log(JSON.stringify((await kernel.lifecycle.dream()).steps, null, 2));
  } else if (cmd === 'rebuild') {
    console.log(JSON.stringify(await kernel.lifecycle.rebuild(), null, 2));
  } else if (cmd === 'backfill') {
    // 把"预热窗口 / RPC 超时"那批漏网的条目补进向量路（§18）
    console.log(JSON.stringify(await kernel.lifecycle.backfillVectors(), null, 2));
  } else if (cmd === 'extract') {
    // P0b 入口：消息 → LLM 抽取 → 四分类 → 落盘
    if (!argv[1]) throw new Error('缺少消息文本');
    const res = await tools.memory_extract.handler(
      { text: argv[1], message_id: flag('message-id', `cli:${Date.now()}`) },
      { sessionId: session },
    );
    if (flag('api-key', false) === false) console.log('（规则版抽取器：只认几种常见句式；真抽取请加 --api-key）');
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'stats') {
    // 【R-152】聚合统一走 health 组（src/core/stats.js）——bin 不再手写 SQL
    console.log(JSON.stringify({
      root,
      domain: domainId,
      ...kernel.health.stats(),
      ftsRows: kernel.health.stats().ftsRows ?? undefined,
      embeddingReady: kernel.vec.isReady(),
      // 【R-137】向量索引**实际**形态：mem-exact 是目标态，其余都是降级。
      vector: (() => {
        const st = kernel.health.vec.stats();
        return {
          mode: kernel.health.vec.mode(domainId),
          indexEnabled: st.enabled,
          residentVectors: st.vectors,
          residentBytes: st.bytes,
          loadedDomains: st.domains,
          dirtyDomains: st.dirtyDomains,
          refusal: st.refusal ?? null,
          sqliteVec: kernel.health.vec.info.version ?? null,
        };
      })(),
    }, null, 2));
  } else {
    console.error(`未知命令: ${cmd}（用 help 看用法）`);
    process.exitCode = 1;
  }
} finally {
  await kernel.close();
}

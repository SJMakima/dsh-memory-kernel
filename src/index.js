/**
 * DSH 插件入口。
 *
 * 宿主契约（只用这五个，不假设宿主内部结构）：
 *   ctx.provide(name, value)                     —— 暴露内核实例
 *   ctx.registerTool(descriptor, handler)        —— 注册工具
 *   ctx.hook(name, handler)                      —— 注册钩子
 * 钩子名沿用文档里的三段：
 *   `agent/pre-step`   自包含短路 + 检索 + 三段组装
 *   `agent/post-step`  巩固信号 /（P2）verified 绑定
 *   `kernel/idle`      空闲巩固（dream）
 *
 * 平台专有名词只出现在 Adapter 里（C4）；本文件与 core/ 都不认识 qq / bili / douyin。
 */
import { createKernel } from './kernel.js';
import { lazyPersistence } from './pure/lifecycle.js';
import { createHostAdapter } from './adapters/host-adapter.js';

export { createKernel } from './kernel.js';
export * from './pure/index.js';
export { defineDomain, createLocalArchiveReader } from './adapters/local-archive.js';
export { defineBiliDomain, defineDouyinDomain, defineVideoDomain, createVideoArchiveReader } from './adapters/video-archive.js';
export { createHashEmbedder } from './adapters/hash-embedder.js';
export { createChatLlm } from './adapters/llm-chat.js';
export { createMockExtractor, createScriptedExtractor, createRuleExtractor } from './adapters/mock-extractor.js';
export { parseCandidatesJson, sanitizeCandidates, createExtractor } from './core/extract.js';

/** 工具描述里的字数上限与 §19 的 text 约束一致：写入端 200 字，注入端不截断。 */
const MAX_TEXT_CHARS = 200;

/* ─────────────── 【R-158】清单单一生成源 ─────────────── */

/** 钩子清单：setup 注册与 manifest 声明共用这一份（声明了没注册 / 注册了没声明，结构上消失）。 */
export const HOOKS = ['agent/pre-step', 'agent/post-step', 'kernel/idle'];

/** 【R-158.3】能力枚举（Capability，区别于 Tool 与 Provider——见 MODULE-CONTRACTS R-158.5）。 */
export const CAPABILITIES = ['memory.search', 'memory.write', 'memory.lifecycle', 'memory.health'];

/** 【R-158.3】apiVersion：公共接口兼容承诺的版本号——内部重构不跟升，breaking change 必改。 */
export const API_VERSION = '1.0';

export function createTools(kernel, { trustSessionArgs = false } = {}) {
  // 【R-158.2】kernel 为 null 仅用于 manifest 枚举（handler 惰性引用，不调用就不碰 kernel）
  const cfg = kernel?.cfg;

  /**
   * 【身份可信纪律，外审 P1】会话身份只信宿主注入的 ctx.sessionId——
   * args.domain / args.sessionId 是 Agent 可控的工具参数，拿它当隐私配对身份 =
   * 把成对隐私的边界交给不可信输入（旧回退 `ctx.sessionId ?? args.domain` 已废）。
   * 无可信身份时 fail-closed 且不拒活：
   *   写路径 → provenance.session_id 记空出（normal 条目不受 origin 管控，照常写；
   *            用户事后标 private 也只会"缺出身 = 不可见"，往安全侧失败）；
   *   读路径 → sessionId 传 null（pair-privacy 对无身份请求拒绝一切 private，
   *            比伪装一个假身份安全得多；普通条目检索不受影响）。
   * 无隐私要求的本地单用户宿主可显式 createPlugin({ trustSessionArgs: true }) 恢复参数回退。
   */
  const trustedSession = (ctx, args) => {
    if (ctx?.sessionId) return ctx.sessionId;
    if (trustSessionArgs) return args?.sessionId ?? args?.domain ?? null;
    return null;
  };

  const toPublic = (e) => ({
    id: e.id,
    domain_id: e.domain_id,
    type: e.entry_type,
    text: e.text,
    topic_tags: e.topic_tags,
    triples: e.triples,
    observed_at: new Date(e.observed_at).toISOString(),
    persistence: Number(lazyPersistence(e, cfg).toFixed(4)),
    activation_count: e.activation_count,
    cold: e.cold,
    superseded_by: e.superseded_by,
  });

  return {
    memory_search: {
      description: '检索历史记忆。include_cold=true 是运维级查询（扫冷存、明显更慢），'
        + '返回里会带 coldScanMs，不要当常规检索用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索语句（中文两字即可命中 bigram 索引）' },
          domain: { type: 'string', description: '域 id；省略时按当前会话路由' },
          top_k: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数（默认按意图 3/5/8）' },
          min_persistence: { type: 'number', minimum: 0, maximum: 1, description: '持久度下限（0-1）' },
          include_cold: { type: 'boolean', description: '是否扫冷存（运维级，不计入 500ms 预算）' },
        },
        required: ['query'],
      },
      async handler(args = {}, ctx = {}) {
        const r = await kernel.memory.search({
          query: args.query,
          sessionId: trustedSession(ctx, args),
          domain: args.domain,
          topK: args.top_k,
          minPersistence: args.min_persistence,
          includeCold: args.include_cold === true,
        });
        return {
          query: args.query,
          intent: r.intent,
          skip_vector: r.skipVec,
          elapsed_ms: r.elapsedMs,
          cold_scan_ms: r.coldScanMs,
          ops_query: r.opsQuery,
          results: r.entries.map(toPublic),
        };
      },
    },

    memory_context: {
      description: '按 entry_id 取回一条记忆及其原始来源上下文（用于核对细节）。',
      parameters: {
        type: 'object',
        properties: { entry_id: { type: 'string' } },
        required: ['entry_id'],
      },
      async handler(args = {}, ctx = {}) {
        const r = await kernel.memory.context(args.entry_id, {
          // 【v4.29】身份必须来自宿主上下文，不能接受 Agent 自报的 session_id。
          sessionId: ctx.sessionId,
          viewer: ctx.viewer ?? ctx.userId ?? null,
        });
        if (!r) return { found: false };
        return {
          found: true,
          entry: toPublic(r.entry),
          source_text: r.original?.text ?? null,
          source_meta: r.original?.meta ?? null,
        };
      },
    },

    /**
     * P0a 专用：手写候选直接走 `new` 分支（§7）。
     * P0b 接上真实抽取后，这个工具的入参不变，只是由抽取器来填。
     */
    memory_remember: {
      description: '写入一条候选记忆（P0a：手写候选，绕过四分类判定）。'
        + `text 上限 ${MAX_TEXT_CHARS} 字，超长会按句拆分。`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          type: { type: 'string', enum: ['fact', 'pattern', 'boundary', 'skill'] },
          domain: { type: 'string' },
          topic_tags: { type: 'array', items: { type: 'string' } },
          triples: {
            type: 'array',
            items: {
              type: 'object',
              properties: { subject: { type: 'string' }, attribute: { type: 'string' }, value: { type: 'string' } },
              required: ['subject', 'attribute', 'value'],
            },
          },
          source: {
            type: 'object',
            properties: {
              adapter_id: { type: 'string' },
              locator: { type: 'string', description: '必须跨时间稳定：消息 ID，不要用行号' },
              hint: { type: 'string' },
            },
            required: ['adapter_id', 'locator'],
          },
          observed_at: { type: 'string', description: 'ISO 时间；省略则取当前时间' },
        },
        required: ['text', 'source'],
      },
      async handler(args = {}, ctx = {}) {
        const res = await kernel.memory.remember({
          text: args.text,
          entryType: args.type ?? 'fact',
          domainId: args.domain,
          sessionId: trustedSession(ctx, args),
          topicTags: args.topic_tags ?? [],
          triples: args.triples ?? [],
          sourceRef: args.source,
          observedAt: args.observed_at ? Date.parse(args.observed_at) : undefined,
          provenance: {
            session_id: trustedSession(ctx, args) ?? '',
            message_ids: [args.source?.locator].filter(Boolean),
            extract_task_id: 'p0a-manual',
            model_version: 'manual',
            extracted_at: Date.now(),
            source_content_hash: '',
          },
        });
        return {
          status: res.status,
          entry_id: res.entry?.id ?? res.entryId ?? res.existingId ?? null,
          path: res.path ? res.path.replace(/\\/g, '/') : null,
        };
      },
    },

    memory_dream: {
      description: '触发一次巩固（dream）：状态回写、激活结算、冷存归档、一致性修复、pattern 提炼。',
      parameters: { type: 'object', properties: {} },
      async handler() {
        const r = await kernel.lifecycle.dream();
        return { snapshot_ts: r.snapshotTs, steps: r.steps };
      },
    },

    /**
     * P3+ 人工确认式身份对齐：先 action=list 看分叉，再由人（或上层 Agent）指定保留项。
     * 内核**绝不自动合并**——这里唯一的写路径是带着显式 keepEntryId 的 resolve。
     */
    memory_align: {
      description: '列出/解决身份分叉（同一主体同一属性存在多个不同值的记忆）。'
        + '先 action=list 查看，确认保留哪条后用 action=resolve 提交。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'resolve'] },
          domain: { type: 'string' },
          subject_key: { type: 'string', description: 'resolve 时必填，来自 list 结果' },
          attribute: { type: 'string', description: 'resolve 时必填，来自 list 结果' },
          keep_entry_id: { type: 'string', description: 'resolve 时必填：人工确认保留的条目' },
        },
        required: ['action'],
      },
      async handler(args = {}, ctx = {}) {
        if (args.action === 'resolve') {
          const r = await kernel.health.resolveIdentityFork({
            domainId: args.domain ?? ctx.sessionId?.split(':')[0],
            subjectKey: args.subject_key,
            attribute: args.attribute,
            keepEntryId: args.keep_entry_id,
          });
          return { resolved: true, ...r };
        }
        return { resolved: false, forks: kernel.health.listIdentityForks(args.domain ?? ctx.sessionId?.split(':')[0]) };
      },
    },

    /**
     * P3+ 巩固触发：按"信号达标或空闲"判断要不要 dream，不满足条件时零成本返回。
     */
    memory_maybe_dream: {
      description: '按巩固信号与空闲时间判断是否需要 dream；不满足条件时返回 skipped，什么都不做。',
      parameters: { type: 'object', properties: {} },
      async handler() {
        const r = await kernel.lifecycle.maybeDream();
        if (r.skipped) return { skipped: r.skipped, score: r.score };
        return { triggered_by: r.triggeredBy, snapshot_ts: r.snapshotTs, steps: r.steps };
      },
    },

    /**
     * P0b 入口：把一条（或一段）消息交给抽取器，产出候选并走四分类。
     * 没注入 llm 时 handler 返回明确错误而不是崩溃。
     */
    memory_extract: {
      description: '从消息里抽取长期记忆（LLM 抽取 + 四分类判重）。闲聊/过时内容会被自动跳过。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要抽取的消息文本；多条消息时用 messages' },
          messages: {
            type: 'array',
            description: '完整上下文（最多取最近 4 条）',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
                id: { type: 'string', description: '消息的稳定 id（进 provenance）' },
              },
              required: ['content'],
            },
          },
          message_id: { type: 'string', description: '本条消息的稳定 id（溯源用，不要用行号）' },
        },
      },
      async handler(args = {}, ctx = {}) {
        const r = await kernel.memory.extract({
          sessionId: trustedSession(ctx, args),
          text: args.text,
          messages: args.messages,
          messageId: args.message_id,
        });
        if (r.skipped) return { skipped: r.skipped, results: [] };
        return {
          task_id: r.taskId,
          candidates: r.candidates,
          results: r.results.map((x) => ({
            status: x.status,
            entry_id: x.entry?.id ?? x.entryId ?? x.existingId ?? null,
            superseded: x.superseded ?? null,
            reason: x.reason ?? null,
          })),
        };
      },
    },
    /**
     * 【R-156】遗忘闭环：物理删除一条记忆（六个位置一次清 + git tombstone）。
     * confirm 必须显式等于 entry_id（误删防护）；内核不做 LLM 自动裁决、不提供批量。
     */
    memory_forget: {
      description: '物理删除一条记忆（不可逆：md 真相源、SQLite、向量、连锁边、冷存、git 一次清空并落 tombstone）。'
        + '只在用户明确要求忘记某条记忆时使用，必须先 memory_search 确认 entry_id，且 confirm 参数原样传同一个 entry_id。',
      parameters: {
        type: 'object',
        properties: {
          entry_id: { type: 'string', description: '要遗忘的条目 id（来自 memory_search）' },
          confirm: { type: 'string', description: '误删防护：原样再传一遍同一个 entry_id' },
          reason: { type: 'string', description: '可选：为什么忘（进 audit）' },
        },
        required: ['entry_id', 'confirm'],
      },
      async handler(args = {}, ctx = {}) {
        const r = await kernel.lifecycle.forget(String(args.entry_id ?? ''), {
          confirmId: String(args.confirm ?? ''),
          reason: args.reason ? String(args.reason).slice(0, 200) : undefined,
        });
        return {
          forgotten: r.forgotten,
          entry_id: r.entryId,
          positions: r.positions,
          tombstone: r.tombstone ? String(r.tombstone).replace(/\\/g, '/') : null,
        };
      },
    },
  };
}

export function createPlugin(options = {}) {
  let kernel = null;

  return {
    name: 'dsh-memory-kernel',
    version: '0.1.0',
    // 【R-158.2】Manifest 自动生成：tools 来自 createTools 的实际键（kernel 未启动时
    // createTools(null) 只用于枚举——handler 都是惰性引用，不调用就不碰 kernel），
    // hooks 来自 HOOKS 单一源。清单漂移（声明了没注册 / 注册了没声明）从结构上消失。
    // 【R-158.3】apiVersion + capabilities：MODULE-CONTRACTS"breaking change 必须改版本号"的落地。
    get manifest() {
      return {
        name: 'dsh-memory-kernel',
        apiVersion: API_VERSION,
        capabilities: [...CAPABILITIES],
        hooks: [...HOOKS],
        tools: Object.keys(createTools(kernel)),
      };
    },

    get kernel() { return kernel; },

    async setup(ctx = {}) {
      // 【R-158.7】通用适配器同样吃宿主 LLM：与 dsh 生产适配器同语义（hostLlm 优先，ctx.llm 兜底）。
      kernel = await createKernel({ ...options, domains: options.domains ?? ctx.domains ?? [], hostLlm: options.hostLlm ?? ctx.llm });
      const boot = await kernel.init();

      // 【R-158.1】宿主形态差异统一走 adapter：src/index.js 不再出现 .length 猜测
      const host = createHostAdapter(ctx, { toolStyle: options.hostToolStyle });
      host.provide('memory', kernel);

      const tools = createTools(kernel, { trustSessionArgs: options.trustSessionArgs === true });
      // 总开关闸门：**在注册处统一包**，不在每个 handler 里手写——以后加工具漏挂的可能性归零。
      // 只闸行为不注销注册：宿主没有运行时 unregister 单工具的路径，禁用时 handler 返回 disabled。
      const withGate = (handler) => async (args, ctx) => {
        if (!kernel.cfg.plugin.enabled) {
          return { status: 'disabled', note: '插件总开关已关闭（plugin.enabled=false）' };
        }
        return handler(args, ctx);
      };
      for (const [name, def] of Object.entries(tools)) {
        const descriptor = { name, description: def.description, parameters: def.parameters };
        host.registerTool(descriptor, withGate(def.handler));
      }

      for (const hookName of HOOKS) {
        if (hookName === 'agent/pre-step') host.hook(hookName, (input) => kernel.memory.preStep(input));
        else if (hookName === 'agent/post-step') host.hook(hookName, (input) => kernel.memory.postStep(input));
        else if (hookName === 'kernel/idle') host.hook(hookName, () => kernel.lifecycle.maybeDream());
      }

      return { ...boot, tools: Object.keys(tools), kernel, toolStyle: host.toolStyle };
    },
  };
}

/** 默认导出是**零配置**的插件描述符；需要传 config/domains/embedder 时用 createPlugin(options)。 */
export default createPlugin();

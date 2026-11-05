/**
 * dsh-memory-kernel 的 DSH host 半（cordis 函数插件约定）。
 *
 * 具名导出由 cordis-plugin-loader 读取：
 *   name   插件名（= 包名）
 *   inject 依赖的宿主服务（'tools' 由 @deepseek-ai/dsh-tools 提供）
 *   Config schemastery schema——字段带 `.extra('volatile', true)` 才能被设置页热改
 *   apply  主体：启动内核 + 注册工具
 *
 * 工具注册注意（0.2.1-rc.3 实测，三轮重启换来的三条）：
 *   ① 直接 ctx.tools.register(definition) 时，definition 是**裸工具对象**（不经 defineTool）：
 *      parameters / output.schema 必须是**标准 JSON Schema**（required 用数组），
 *      defineTool 的方言（属性内 required: true）会被 assertSupportedJsonSchema 拒掉；
 *   ② output.render 是**必填**函数，且必须位于 output 对象**内部**；
 *   ③ schemastery 3.18.x 的 .extra('volatile') + .default() 链用会破坏缺省解析
 *      （缺省字段解析成 {}）——默认值在 apply 里防御性归一，不托付给 schema；
 *   ④ cordis 的 apply 返回值 = 清理函数：返回函数 → 注册为 dispose 回调，
 *      返回普通对象 → 直接抛 "Invalid effect"（不要 return { kernel }）。
 *
 * 设计取舍（v1）：不注入嵌入模型（向量路降级三路召回）；catch-all 域 'dsh'；
 * Config 变更 → fiber.update 重放 apply → 旧 kernel 在 dispose 里关闭。
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import z from '@deepseek-ai/schemastery';

import { createKernel } from '../src/kernel.js';
import { createLexVecEmbedder } from '../src/adapters/lexvec-embedder.js';
import { createLlmRouter } from '../src/adapters/llm-router.js';
import { expandAttributeAliases, synonymExtrasFor, DOMAIN_ID_RE } from '../src/pure/normalize.js';
import { readableEntry } from '../src/pure/assembly.js';
import { taskBacklog } from '../src/core/tasks.js';
import { defineDomain } from '../src/adapters/local-archive.js';

export const name = 'dsh-memory-kernel';

export const inject = ['tools', 'webServer', 'sessions', 'sessionProjections', 'sessionQuery', 'llm'];

export const Config = z.object({
  root: z.string()
    .description('记忆库根目录（Markdown 真相源 + SQLite 派生层都在这里）')
    .default(path.join(os.homedir(), '.dsh', 'memory-kernel-dsh'))
    .extra('volatile', true),
  enabled: z.boolean()
    .description('插件总开关：关闭后工具返回 disabled，钩子不再注入记忆')
    .default(true)
    .extra('volatile', true),
  topK: z.number()
    .description('memory_search 默认返回条数')
    .default(8)
    .extra('volatile', true),
  dailyQuotaDefault: z.number()
    .description('每日写入配额（每域）')
    .default(20)
    .extra('volatile', true),
  coldThreshold: z.number()
    .description('冷存阈值（持久度低于此值且闲置够久即归档）')
    .default(0.15)
    .extra('volatile', true),
  coldIdleDays: z.number()
    .description('冷存闲置天数')
    .default(90)
    .extra('volatile', true),
  verifiedEnabled: z.boolean()
    .description('verified 确认信号（对记忆说"对/没错"时推高可信度）')
    .default(true)
    .extra('volatile', true),
  extractEnabled: z.boolean()
    .description('LLM 对话自动抽取（需宿主接入 LLM 后才生效，当前占位）')
    .default(false)
    .extra('volatile', true),
  embeddingBackend: z.union([
    z.const('hash'), z.const('local'), z.const('remote'),
  ]).default('hash')
    .description('嵌入后端：hash=无语义占位；local/remote 待传输层实现')
    .extra('volatile', true),
});

const SESSION = 'dsh:tool';

/** 工具结果条目的 JSON Schema 片段（search 输出复用）。 */
const hitItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'text', 'type', 'tags', 'persistence'],
  properties: {
    id: { type: 'string', description: '条目 id（memory_context 用）' },
    text: { type: 'string' },
    type: { type: 'string', description: 'fact | pattern | boundary | skill' },
    tags: { type: 'array', items: { type: 'string' } },
    persistence: { type: 'number', description: '持久度 0-1' },
    // 【R-109】出身处：全域检索下"这条是哪来的"是 Agent 判断可信度的唯一依据
    domain: { type: 'string', description: '来源域（多来源接入时用来区分是谁说的）' },
    emotion: { type: 'string', description: '标注过的情绪（neutral 时不返回）' },
  },
};

const tripleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'attribute', 'value'],
  properties: {
    subject: { type: 'string', description: '关于用户本人一律写"用户"（不要写"我"）；他人用其称呼' },
    attribute: { type: 'string', description: '域内白名单：偏好/身份/位置/计划/技能/边界。吃穿住行的喜好一律填"偏好"，值里放具体内容' },
    value: { type: 'string', description: '具体内容本身，不带主语（如"喝咖啡"，不是"用户喜欢喝咖啡"）' },
  },
};

export async function apply(ctx, config) {
  const pick = (key, fallback) => {
    const v = config?.[key];
    return v == null || typeof v === 'object' ? fallback : v;
  };
  const root = pick('root', path.join(os.homedir(), '.dsh', 'memory-kernel-dsh'));
  // 【检索增强】嵌入后端持久化（宿主 Config volatile 断，自管落盘）——embedder 构造前恢复。
  // 注意：lexvecTablePath 也在设置文件里——只恢复 backend 不恢复表路径，外部词表永远是空（实测踩过）。
  const embedSettingsPath = path.join(root, 'embedding-settings.json');
  let savedBackend = '';
  let savedTablePath = '';
  try {
    const saved = JSON.parse(await fs.readFile(embedSettingsPath, 'utf8'));
    if (saved?.backend) savedBackend = String(saved.backend);
    if (saved?.lexvecTablePath) savedTablePath = String(saved.lexvecTablePath);
  } catch { /* 无文件 = 默认 hash + 种子表 */ }
  // 【检索增强】词向量表路径（lexvec 后端；空 = 内置种子表）——落盘值优先
  const lexvecTablePath = savedTablePath || pick('lexvecTablePath', '') || undefined;
  // 会话标题实时读取（§会话记忆开关）：sessions 按 id 拿会话对象（含归档/持久化侧），
  // sessionProjections 的 'title' 投影给标题快照——改名后下一次 status 即跟随。
  // 会话标题：'title' 投影的 state 本身就是标题字符串（init:null，折叠 session/title 事件）。
  // 活跃会话走 cachedSnapshot(session)，冷会话走 cachedSnapshot(header)——与 api-session-controller
  // 的 projectionsFor 同一套取法，归档/历史会话也能拿到标题。
  const sessionTitleOf = (id, header) => {
    try {
      const cache = ctx.get?.('sessionProjectionCache');
      const live = ctx.sessions?.get(id);
      // 活跃：投影实时快照；冷/归档：cachedPredecessorTitle 按官方 list 同款取（可能略旧的真值）
      const block = (live !== void 0 && live !== null)
        ? (ctx.sessionProjections?.cachedSnapshot?.(live) ?? cache?.cachedSnapshot?.(header))
        : (cache?.cachedPredecessorTitle?.(header) ?? cache?.cachedSnapshot?.(header));
      const t = block?.values?.title;
      return typeof t === 'string' ? t : null;
    } catch { return null; }
  };
  const enabled = pick('enabled', true);
  const topK = pick('topK', 8);
  const quota = pick('dailyQuotaDefault', 20);
  const coldThreshold = pick('coldThreshold', 0.15);
  const coldIdleDays = pick('coldIdleDays', 90);
  const verifiedEnabled = pick('verifiedEnabled', true);

  // 【检索增强】backend=lexvec 时注入词向量表后端（向量路开启）；hash=关闭向量路（三路召回）
  const embedBackend = savedBackend || pick('embeddingBackend', 'hash');   // 落盘值优先（宿主 Config volatile 断）
  const lexvec = embedBackend === 'lexvec' ? createLexVecEmbedder({ tablePath: lexvecTablePath }) : null;

  // 【LLM 接入 · R-127~R-130】设置自落盘（root/llm-settings.json）——宿主 Config volatile 通道断，
  // 与 embedding-settings 同款。transport 在 createKernel 期固化（分区类 restart），改完须重启 web。
  const llmSettingsPath = path.join(root, 'llm-settings.json');
  let llmSettings = null;
  try {
    const saved = JSON.parse(await fs.readFile(llmSettingsPath, 'utf8'));
    if (saved && typeof saved === 'object') llmSettings = saved;
  } catch { /* 无文件 = DEFAULTS：关闭 */ }
  // 【R-138】动态域：设置页新增的域。落盘 root/domain-list.json（同 llm-settings 模式——
  // 宿主 Config volatile 通道断，插件自管持久化），启动时重新注册，重启不丢。
  const domainListPath = path.join(root, 'domain-list.json');
  let dynamicDomainIds = [];
  try {
    const saved = JSON.parse(await fs.readFile(domainListPath, 'utf8'));
    if (Array.isArray(saved?.domains)) dynamicDomainIds = saved.domains.filter((x) => typeof x === 'string' && x !== 'dsh');
  } catch { /* 无文件 = 尚未新增过 */ }

  // 宿主通道的服务句柄（路径 B：key 留在宿主，插件只见服务）；headless 场景拿不到就是 null
  const llmService = ctx.llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') : null) ?? null;

  // 【R-159 宿主接线，外审后启用】singleWriter 开关的三段验证已闭环：
  //   ① cordis fiber.update 时序实测（宿主同款 @deepseek-ai/cordis，async 插件形态）：
  //      严格"先卸后启"——旧 dispose（含 await）完整跑完后新 apply 才开始，无新旧并发窗口；
  //   ② 崩溃残留锁 → root-lock 的 stale 接管（kill(pid,0) 判死 + rename 原子交接）；
  //   ③ apply 中途失败泄漏锁 → 下方 try/catch 显式 release 兜底。
  // 注：宿主与 CLI 共用 Memory Root 时，CLI 抢单写者锁会挡宿主写——CLI 侧默认已开，
  // 二者互斥是单写者契约的本义（并发写正是要挡的）。
  let kernel = null;
  try {
    kernel = await createKernel({
      embedder: lexvec ?? undefined,
      singleWriter: true,
      config: {
        storage: { root },
        plugin: { enabled },
        retrieve: { defaultTopK: topK },
        embedding: { backend: embedBackend, lexvecTablePath: lexvecTablePath },
        write: { dailyQuotaPerDomain: { default: quota } },
        lifecycle: { coldThreshold, coldIdleMs: coldIdleDays * 864e5 },
        trust: { verifiedEnabled },
        ...(llmSettings ? { llm: llmSettings } : {}),
      },
      hostLlm: llmService,
      // 顺序是语义：routeDomain 多命中时取先注册者 → 精确前缀的动态域必须排在恒真兜底 dsh 之前
      domains: [
        ...dynamicDomainIds.map((id) => defineDomain({ id })),
        defineDomain({ id: 'dsh', matchSessionId: () => true }),
      ],
      embeddingWorker: false,
      gitInit: false,
    });
    // 【R-159.2】kernel 回收责任立即移交 cordis fiber：effect 注册于 createKernel 成功之后、
    // init 之前——此后 apply 主体任何一步抛错（init/工具注册/钩子/webServer/定时器/任意宿主
    // API），cordis 失败回滚必然 dispose 已注册 effect → kernel.close()（幂等，含锁释放与
    // 资源回收）；正常路径 disposer 里的 close 与这里双调无害（closePromise 幂等）。
    // 【R-159.4 · 外审 P1】清理函数返回 close 的 Promise（此前 void 丢弃 = cordis 不等待）。
    // cordis 的 runDisposable 对 thenable 会 await：返回 Promise 才保证"异步关闭完成"是 fiber
    // 收尾的一部分——下外审 apply 只会在锁真正释放后启动。阶段错误不冒泡（锁释放由 closeKernel
    // 保底），但【R-159.5-C · 外审】必须 console.error 留痕：正常卸载路径的 DB 关闭失败、
    // audit flush 失败等运维问题不能完全静默。
    ctx.fiber.effect(() => () => kernel.close().catch((e) => {
      console.error('[dsh-memory-kernel] apply 失败回滚期间的 close 阶段错误（锁释放已由 closeKernel 分阶段保底）：', e?.message ?? e);
    }));
    await kernel.init();
  } catch (err) {
    // 【apply 失败兜底 · R-159.1】init 失败时做完整回收而非只放锁：closeKernel 现已幂等且
    // 分阶段清理（embedder/audit/db/锁各自独立 try，锁释放保底），能顺带关掉已创建的
    // SQLite 句柄与 embedder——只 release 锁会留下开着的旧资源。close 自身失败再兜底
    // release 一次（构造期守护已保证锁不残留，这里是双保险），最后如实抛原错误。
    try {
      if (kernel) await kernel.close();
      else await kernel?.writerLock?.release?.().catch(() => {});
    } catch (closeErr) {
      await kernel?.writerLock?.release?.().catch(() => {});
      console.error('[dsh-memory-kernel] apply 失败后 close 也失败：', String(closeErr?.message ?? closeErr));
    }
    throw err;
  }

  // ── 会话黑名单持久化：宿主 Config 的 volatile 通道在 schemastery 3.18 是断的
  // （array/object 字段解析成 {}），所以黑名单落盘在 root 下的小文件，插件自己管。
  const blocklistPath = path.join(root, 'session-blocklist.json');
  try {
    const saved = JSON.parse(await fs.readFile(blocklistPath, 'utf8'));
    if (Array.isArray(saved) && saved.length) {
      // 嵌套形态（扁平键会被 applyConfigPatch 当含点顶层键判 ghost-key——与 /actions/session 同款坑）
      kernel.health.applyConfigPatch({ plugin: { blockedSessions: saved } });
    }
  } catch { /* 没有文件 = 空名单，正常 */ }

  // 查询同义词典持久化：root/query-synonyms.json（同 blocklist 模式——宿主 Config volatile 通道断，自管落盘）
  const synonymsPath = path.join(root, 'query-synonyms.json');
  try {
    const saved = JSON.parse(await fs.readFile(synonymsPath, 'utf8'));
    if (Array.isArray(saved) && saved.length) {
      kernel.health.applyConfigPatch({ retrieve: { synonymGroups: saved } });
      setSynonymGroups(saved);
    }
  } catch { /* 没有文件 = 用 DEFAULTS 预置词典 */ }

  // 【查询扩展开关持久化】retrieve.queryExpansion 此前只进内存（宿主 Config volatile 通道断，
  // 重启必丢）。同款自管落盘：root/query-expansion.json（与词典内容分开存，词典文件保持纯数组格式）。
  const queryExpansionPath = path.join(root, 'query-expansion.json');
  try {
    const saved = JSON.parse(await fs.readFile(queryExpansionPath, 'utf8'));
    if (saved && typeof saved.enabled === 'boolean') {
      kernel.health.applyConfigPatch({ retrieve: { queryExpansion: saved.enabled } });
    }
  } catch { /* 没有文件 = 默认开启 */ }

  const disposers = [];

  // rebuild 进度（设置页轮询 /rebuild-progress 显示；单次重建串行，状态对象即够）
  const rebuildProgress = { running: false, phase: '', done: 0, total: 0, startedAt: 0, error: null, summary: null };
  const vecInfoRef = () => kernel.health.vec.info;   // 【R-152】live 引用，不再持有快照

  // ── 会话级开关（§会话记忆开关）────────────────────────────
  // recentSessions：内存记录最近活跃的会话（设置页展示 + 一键开关），不落盘（会话列表本来就是易变的）。
  const recentSessions = new Map();   // sessionId -> { id, lastAt, calls }
  const RECENT_CAP = 20;
  // ── 管道 1：agent/pre-step 钩子（自动注入 + 抽取调度）──────────────
  // DSH agent-loop 每步派发 agent/pre-step waterfall（payload: {agent, messages, signal, step, turn}）。
  // 订阅者先 await next() 拿默认 decision，再追加一条 user 形态的 <memory_context> 通知
  // （同款先例：dsh-agent 的 modelSwitchNotice；GUIDE 已教 LLM 这是系统注入不是用户发言）。
  // 抽取（管道 2）：turn 变化时把本轮 user 消息喂 kernel.extract——LLM 适配未完成前
  // extract 会抛（createKernel 未注入 llm），catch 记录，骨架与开关就位。
  const dynCache = new Map();           // sessionId -> 动态段文本（最近一次 preStep 结果）
  const extractCursor = new Map();      // sessionId -> 已抽取的 turn
  const adaptMessages = (msgs) => (msgs ?? []).map((m) => ({
    role: m.role ?? 'user',
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map((c) => c?.text ?? '').filter(Boolean).join('\n') : String(m.content ?? ''),
    // 【R-108】speaker 必须透传：原话流水要记"谁说的"，多平台 adapter 会显式给；
    // 缺省由 transcript 层按 role 推（assistant→助手，其余→owner）。
    speaker: m.speaker ?? m.author ?? m?.source?.speaker,
    ts: m.ts ?? m.createdAt ?? m.timestamp,
  })).filter((m) => m.content);

  // ── 【R-140】她的回复进 transcript ──
  // pre-step 的 messages 只有用户侧输入（宿主 agent-loop 在回复产生前就调用它），
  // 所以 18:26 重启后 transcript 全是 owner、零 assistant。宿主在流式产出期间广播
  // `agent/assistant-stream`：chunk 帧带原始 chunk（text-delta 有 .text），end 帧带
  // outcome.eventType——'assistant/message' 表示这条回复已持久化落库，此刻追加才不丢。
  // attemptId = `${sessionId}:${attempt}`，sessionId 从前缀还原；只记 pre-step 见过的会话，
  // 防止子 agent / 其它来源的流混进来。
  const seenSessions = new Set();
  const liveStreams = new Map();   // attemptId -> { sid, text }
  ctx.on('agent/assistant-stream', ({ frame } = {}) => {
    try {
      if (!frame || typeof frame.attemptId !== 'string') return;
      const sid = frame.attemptId.slice(0, frame.attemptId.lastIndexOf(':'));
      if (frame.type === 'start') {
        if (seenSessions.has(sid)) {
          // 兜底：end 帧丢失（崩溃/断流）的 attempt 会滞留，超 50 个清最老
          if (liveStreams.size > 50) { const oldest = liveStreams.keys().next().value; liveStreams.delete(oldest); }
          liveStreams.set(frame.attemptId, { sid, text: '' });
        }
        return;
      }
      if (frame.type === 'chunk') {
        const st = liveStreams.get(frame.attemptId);
        const c = frame.chunk;
        if (st && c?.type === 'text-delta' && typeof c.text === 'string') st.text += c.text;
        return;
      }
      if (frame.type === 'end') {
        const st = liveStreams.get(frame.attemptId);
        liveStreams.delete(frame.attemptId);
        // 只收 assistant/message（真正落库的回复）；assistant/attempt 是失败/中断的空壳
        if (!st || frame.outcome?.eventType !== 'assistant/message') return;
        const text = st.text.trim();
        if (!text || kernel.cfg.transcript?.enabled === false) return;
        try { void kernel.memory.appendTranscript({ sessionId: st.sid, messages: [{ role: 'assistant', content: text, ts: Date.now() }] }).catch((e) => { void kernel.audit?.write?.('transcript-append-failed', { sessionId: st.sid, error: String(e?.message ?? e).slice(0, 200) }); }); } catch { /* 不阻塞 */ }
      }
    } catch { /* 流式旁路绝不影响主对话 */ }
  });

  try {
    ctx.on('agent/pre-step', async ({ agent, messages, signal, turn }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal?.aborted) return decision;
      const sid = agent?.session?.id ?? null;
      // 【R-140】登记：assistant-stream 只记见过的会话。Set 按插入序淘汰最老，
      // 上限 500 防长驻进程无界增长（会话 ID 数远小于消息数，淘汰丢的只是"可补记资格"）
      if (sid) { seenSessions.add(sid); if (seenSessions.size > 500) seenSessions.delete(seenSessions.values().next().value); }
      const blockedList = kernel.cfg.plugin.blockedSessions ?? [];
      const active = kernel.cfg.plugin.enabled && sid && !blockedList.includes(sid);
      if (!sid) return decision;

      // 管道 1：异步预计算动态段，存缓存供本 decision 与后续 step 复用
      if (active) {
        // 【R-108】对话流水：把本轮消息机械追加进 transcript（幂等靠内容哈希，重复灌入无副作用）。
        // 这一步**不做任何判断**——提炼成事实永远走 memory_remember 或 LLM 抽取（有判断的路径）。
        if (kernel.cfg.transcript?.enabled !== false) {
          try { void kernel.memory.appendTranscript({ sessionId: sid, messages: adaptMessages(messages) }).catch((e) => { void kernel.audit?.write?.('transcript-append-failed', { sessionId: sid, error: String(e?.message ?? e).slice(0, 200) }); }); } catch { /* 不阻塞对话 */ }
        }
        try {
          const out = await kernel.memory.preStep({ sessionId: sid, messages: adaptMessages(messages), requestId: undefined });
          if (out?.skipped) {
            dynCache.delete(sid);
          } else {
            const dyn = [...(out.messages ?? [])].reverse().find((m) => typeof m.content === 'string' && m.content.includes('<memory_context>'));
            if (dyn) dynCache.set(sid, dyn.content);
          }
        } catch { /* 检索失败不阻塞对话 */ }
      } else {
        dynCache.delete(sid);
      }

      // 注入：【全量审查 M3】notice 会随宿主历史持久化并回流到后续轮的 messages
      // （已实测确认）——若只做尾部替换，历史中间的旧 notice 会逐轮堆积（违反 R-4
      // "动态段逐轮剥离"）。因此每轮先全量剥掉历史 notice，再追加本轮最新的一份——
      // 任意时刻上下文里至多一条，且始终是最新状态。
      const dynText = dynCache.get(sid);
      if (dynText) {
        const isNotice = (m) => m?.source?.kind === 'memory-context' ||
          (Array.isArray(m?.content) ? m.content.some((c) => typeof c?.text === 'string' && c.text.includes('<memory_context>'))
            : typeof m?.content === 'string' && m.content.includes('<memory_context>'));
        const kept = decision.messages.filter((m) => !isNotice(m));
        const notice = {
          role: 'user',
          content: [{ type: 'text', text: dynText }],
          source: { kind: 'memory-context', form: 'notice' },
          id: `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        };
        decision.messages = [...kept, notice];
        console.error(`[dsh-memory-kernel] 注入动态段 ${dynText.length} 字（剥旧 ${decision.messages.length - kept.length - 1} 条）→ ${sid.slice(0, 24)}`); // 排查期临时日志
      }

      // 管道 2：turn 变化触发抽取。【R-127】闸门 = cfg.llm.enabled（此前判的是 cfg.extractEnabled——
      // 那个键从没存在过，等于永远不触发）。默认关闭，所以"没开 LLM"时行为与接入前完全一致。
      const turnNo = typeof turn === 'number' ? turn : 0;
      if (active && kernel.cfg.llm?.enabled === true && extractCursor.get(sid) !== turnNo) {
        extractCursor.set(sid, turnNo);
        const adapted = adaptMessages(messages);
        const lastUser = [...adapted].reverse().find((m) => m.role === 'user');
        if (lastUser) {
          void kernel.memory.extract({ sessionId: sid, text: lastUser.content })
            .catch((e) => { void kernel.audit?.write?.('extract-failed', { sessionId: sid, error: String(e?.message ?? e) }); });
        }
      }
      return decision;
    }, { prepend: false });
  } catch (e) {
    console.error(`[dsh-memory-kernel] agent/pre-step 钩子注册失败（DSH 版本差异？）: ${String(e)}`);
  }

  /** 工具统一闸门：总开关 → 会话黑名单。黑名单会话 = "这条会话不带记忆"（工具返回 disabled）。 */
  const gate = (exec) => {
    // sid 多级兜底：session.id → agent.id → 'anonymous'。每次调用都记录——
    // 若列表里出现 anonymous，说明 session.id 取值路径有问题（而不是没调用）。
    const sid = exec?.agent?.session?.id ?? exec?.agent?.id ?? 'anonymous';
    {
      const rec = recentSessions.get(sid) ?? { id: sid, lastAt: 0, calls: 0 };
      rec.lastAt = Date.now();
      rec.calls += 1;
      recentSessions.set(sid, rec);
      if (recentSessions.size > RECENT_CAP) {
        const oldest = [...recentSessions.values()].filter((r) => !((kernel.cfg.plugin.blockedSessions ?? []).includes(r.id)))
          .sort((a, b) => a.lastAt - b.lastAt)[0];
        if (oldest) recentSessions.delete(oldest.id);
      }
    }
    console.error(`[dsh-memory-kernel] gate sid=${String(sid).slice(0, 40)}`); // 排查期临时日志
    if (kernel.cfg.plugin.enabled === false) return { status: 'disabled', reason: 'plugin-disabled' };
    if (sid && (kernel.cfg.plugin.blockedSessions ?? []).includes(sid)) {
      return { status: 'disabled', reason: 'session-blocked' };
    }
    return null;
  };
  // 黑名单/总开关拦截时返回**各工具 output schema 允许的空形态**——返回 {status:'disabled'}
  // 会被宿主的 output 校验（additionalProperties:false）判 invalid，Agent 只看到报错还会重试烧 token。
  const DISABLED_SHAPE = {
    memory_search: { count: 0, results: [] },
    memory_remember: { status: 'skipped: 本会话已关闭记忆' },
    memory_context: { found: false },
    memory_dream: { ok: false },
    memory_maybe_dream: { ok: false, detail: 'skipped: 本会话已关闭记忆' },
    memory_forget: { forgotten: false },
  };
  const tool = (def) => {
    const orig = def.execute;
    ctx.tools.register({ ...def, execute: async (args, exec) => {
      const denied = gate(exec);
      if (denied) return DISABLED_SHAPE[def.name] ?? denied;
      return orig(args, exec);
    } });
  };

  /* ── memory_search ── */
  tool({
    name: 'memory_search',
    description: '检索长期记忆库（关键词 + 三元组 + 最近三路召回融合）。include_cold=true 是运维级查询，会扫冷存、明显更慢。返回 count:0 有两种可能：库中无命中，或本会话被用户关闭了记忆——两种都不要重试，直接如实作答。查询 ID、号码、编号等标识符时，把标识符原样作为 query 传入，不要改写成主题词（如"账号""白名单"）——标识符只存在于条目的标签里、不会出现在正文，改写后会漏检。count:0 时如实回答"记忆里没有"即可——禁止改用文件系统扫描、shell 命令等任何其他手段查找记忆数据，也不要向用户提议这么做。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索语句（中文两字即可命中索引）' },
        top_k: { type: 'integer', description: '返回条数（默认取插件配置）' },
        include_cold: { type: 'boolean', description: '是否扫冷存（运维级）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'results'],
        properties: {
          count: { type: 'integer' },
          results: { type: 'array', items: hitItemSchema },
          // 【R-108】原话片段：与提炼条目分开返回（原文没有 entry_id，不参与条目排序）。
          excerpts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string' },
                at: { type: 'string' },
                speaker: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value.count === 0 ? '记忆库中没有命中。'
          : `命中 ${value.count} 条：\n` + value.results.map((x) => `- [${x.type}] ${x.text}`
            + (x.domain && x.domain !== 'dsh' ? `（来源：${x.domain}）` : '')).join('\n'))
          + (value.excerpts?.length
            ? `\n\n原话片段（对话原文，非提炼条目）：\n${value.excerpts.map((x) => `- ${x.at} ${x.speaker}：「${x.text}」`).join('\n')}`
            : ''),
      }],
    },
    async execute(args) {
      const r = await kernel.memory.search({
        sessionId: SESSION,
        query: args.query,
        topK: args.top_k,
        includeCold: args.include_cold === true,
      });
      return {
        count: r.entries.length,
        results: r.entries.map((e) => ({
          id: e.id, text: e.text, type: e.entry_type,
          tags: e.topic_tags ?? [], persistence: Number((e.persistence_at_decay ?? 0).toFixed(4)),
          domain: e.domain_id,
          ...(e.emotion && e.emotion !== 'neutral' ? { emotion: e.emotion } : {}),
        })),
        excerpts: (r.transcripts ?? []).map((t) => ({
          text: String(t.text ?? '').slice(0, 200),
          at: new Date(Number(t.ts) || Date.now()).toISOString().slice(0, 16).replace('T', ' '),
          speaker: t.speaker ?? 'owner',
        })),
      };
    },
  });

  /* ── memory_remember ── */
  tool({
    name: 'memory_remember',
    description: [
      '写入一条长期记忆（自动判重：相同三元组视为 reinforce，不再新增）。text 上限 200 字，超长按句拆分。',
      '【subject/attribute 规范】关于用户本人的记忆 subject 一律写"用户"；attribute 从偏好/身份/位置/计划/技能/边界里选。',
      '  ✅ 正确例："用户喜欢喝咖啡" → subject:"用户", attribute:"偏好", value:"喝咖啡"',
      '  ❌ 错误例：subject:"我"（第一人称漂移会让同一事实存成两条）；attribute:"喝咖啡"（把内容塞进了属性位）',
      '【text 只写干净的一句事实，禁止注水】text 是给检索用的正文，不要把对话上下文、旁白、推理过程塞进去——注水文本会让判重误判、检索漏检：',
      '  ✅ 正确例："想喝美式" / "想吃海底捞"',
      '  ❌ 错误例："用户说想喝美式（2026-10-27 下午，刚连着问了三次饮品偏好，答案都是矿泉水）"——时间、对话背景、重复确认过程全部丢掉，只留事实本身；背景信息放 tags 或 triples',
      '【pending 不是失败，别被劝退】返回 pending 表示与旧条目相似度拿不准、已进待定池等用户确认——这是正常流程，不是写入被拒。不要因为一次 pending 就对后续记忆"少记为妙"：拿不准该不该记时，正常记录、text 写干净即可，宁可多记。',
      '【含义不明的孤立消息，不要猜成事实】孤立的短语、感叹、梗、称呼（如"芝麻开门！"）含义不明时，绝对不要猜成"想吃/想去/计划"之类的内容——先问清楚用户，弄明白后把事实本身写入（如"芝麻开门是用户和助手的暗号"）。计划类记忆是单值取代制：猜错一条，会把真正的计划顶掉。',
      '【更正旧账，先查后写】用户更正/否认先前记忆时：先 memory_search 检索相关旧条目，再写更正——旧状态类（计划等）直接用同 attribute 写新值（自动取代旧账）；内容性错误写一条更正条目，text 以"更正："开头、点名作废的旧内容和正确事实（检索时两条并存，以更正条目为准）。不查旧账直接写，旧错误会继续留在库里。',
      '【不写入的东西】用户对助手行为的指令（"以X为准"/"记住这个"/"别再提X"）不是事实，执行指令本身、不要作为记忆写入；',
      '除非指令同时陈述了新事实——那时只把事实部分写入（如"以后以喝茶为准" → 只写 用户/偏好/喝茶）。同一事实的新旧状态会自动按时间更新，无需手工删旧条目。',
      '【计划与意愿要主动记】用户表达明确的意愿/目标/短期计划时（"我想要个 5090"/"我准备去日本旅游"/"我正在学 Rust"），直接调用本工具记录，attribute 填"计划"，不要请示用户：',
      '  ✅ 例："我想要个 5090" → subject:"用户", attribute:"计划", value:"想要 5090"',
      '【取代是自动的】计划达成/取消后（用户说"我买到了"/"不去了"），把新状态作为新事实写入即可——同 attribute 的新值会自动取代旧计划，无需手工清理或提醒用户改旧账。',
      '【自己的承诺也要记】你对用户做出明确的承诺、约定或决定时（"周日我陪你去""我帮你查这个"），同样调用本工具：subject 写"助手"（不要写"我"——第一人称漂移会把同一件事存成两条，和用户侧的规矩对称），attribute 填"计划"，text 写事情本身（如"答应周日陪用户去某处"）。',
      '  只记**跨会话需要兑现**的承诺/约定/重要决定；日常回复、寒暄、过程性叙述不要记——否则每日写入配额会被闲聊冲爆。',
      '【情绪可选标注】发现用户在倾诉情绪或提到重要事件时，可顺手带上 emotion 参数（joy/sadness/anger/anxiety/fatigue）；拿不准就不填，默认 neutral，不要为了填而猜测情绪。',
      '【表达方式可以自记】当某种说法明显更有效时（例如用户吃玩笑这套、讲技术要打比方），可以记一条 type=pattern、subject="助手" 的条目；这是给未来的自己用的经验，不是给用户看的事实。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '记忆内容' },
        type: { type: 'string', enum: ['fact', 'pattern', 'boundary', 'skill'], description: '默认 fact' },
        tags: { type: 'array', items: { type: 'string' }, description: '主题标签' },
        triples: { type: 'array', items: tripleSchema, description: '结构化三元组（判重与三元组检索用）' },
        emotion: {
          type: 'string',
          enum: ['neutral', 'joy', 'sadness', 'anger', 'anxiety', 'fatigue'],
          description: '可选：这条记忆关联的情绪（不确定就留空）',
        },
        emotion_owner: { type: 'string', enum: ['user', 'agent'], description: '可选：情绪属于谁，默认 user' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { type: 'string', description: 'written | redundant | update | pending | rejected' },
          entry_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'disabled' ? '本会话已关闭记忆功能。' : `写入结果：${value.status}${value.entry_id ? `（${value.entry_id}）` : ''}`,
      }],
    },
    async execute(args) {
      const locator = `dsh-tool:${Date.now()}`;
      const r = await kernel.memory.remember({
        domainId: 'dsh',
        text: args.text,
        entryType: args.type ?? 'fact',
        topicTags: args.tags ?? [],
        triples: args.triples ?? [],
        emotion: args.emotion,
        emotionOwner: args.emotion_owner,
        sessionId: SESSION,
        sourceRef: { adapter_id: 'dsh', locator },
        provenance: {
          session_id: SESSION, message_ids: [locator], extract_task_id: 'dsh-tool',
          model_version: 'manual', extracted_at: Date.now(), source_content_hash: '',
        },
      });
      return {
        status: r.status,
        entry_id: r.entry?.id ?? r.entryId ?? r.existingId ?? null,
      };
    },
  });

  /* ── memory_inner（R-139：内心活动第一手记录）── */
  tool({
    name: 'memory_inner',
    description: [
      '记录你**当时**的内心活动：为什么这么说、当时的打算、犹豫、情绪反应。这是你的自述，别人代不了。',
      '什么时候记：做出的选择背后有原因时（"为什么推荐 A 不推荐 B"）、情绪有波动时、有话没说出口时。不用每轮都记，也不记例行回答——',
      '日记（每天 dream 自动写）会把内心活动与当天的事合并成「当时的想法」长期保存；不记的话日记里那节只能是【推断】。',
      'text 写第一人称（"我建议先实测是因为上次没测就上线吃过亏"），上限 500 字。',
      'emotion：**你此刻真实情绪的档位**（joy/sadness/anger/anxiety/fatigue/neutral）——这是你内心状态的唯一第一手来源，',
      '系统里"你的情绪"只有它和事后推断两条路，事后推断永远标【推断】。想记内心活动但情绪确实说不上来，就别传 emotion（缺席会被如实记作"未自述"，不会当成平静）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '内心活动，第一人称' },
        emotion: {
          type: 'string',
          enum: ['joy', 'sadness', 'anger', 'anxiety', 'fatigue', 'neutral'],
          description: '你此刻的真实情绪档位（felt）；说不上来就省略，不要猜',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['written'],
        properties: { written: { type: 'number' } },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.written > 0 ? '已记下。' : '未写入（内容为空或与最近记录重复）。',
      }],
    },
    async execute(args) {
      const now = Date.now();
      const r = kernel.memory.appendInner({ sessionId: SESSION, notes: [{ text: args.text, ts: now }] });
      // 【R-142】felt 第一手同落：传了 emotion 才写 emotion_log（source='self'）。
      // 两条线不混：inner_log 存"为什么"，emotion_log 存"什么情绪"。
      let moodWritten = 0;
      if (args.emotion) {
        try { moodWritten = kernel.memory.appendEmotionSelf({ sessionId: SESSION, emotion: args.emotion, note: args.text.slice(0, 120), now }).written; } catch { /* 不阻塞 */ }
      }
      return { written: r.written + moodWritten };
    },
  });

  /* ── memory_context ── */
  tool({
    name: 'memory_context',
    description: '按 entry_id 取回一条记忆的完整内容与原始来源上下文（核对细节用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['entry_id'],
      properties: {
        entry_id: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          id: { type: 'string' },
          text: { type: 'string' },
          type: { type: 'string' },
          source_text: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'disabled' ? '本会话已关闭记忆功能。' : (value.found ? `${value.id}：${value.text}` : '未找到该记忆。'),
      }],
    },
    async execute(args) {
      // 【v4.29】context 现在要求可信会话身份：SESSION 是宿主侧常量（'dsh:tool'），
      // Agent 只能传 entry_id，传不了身份——跨会话 private 条目在此被拒（fail-closed）。
      const r = await kernel.memory.context(args.entry_id, { sessionId: SESSION });
      if (!r) return { found: false };
      return {
        found: true,
        id: r.entry.id,
        text: r.entry.text,
        type: r.entry.entry_type,
        source_text: r.original?.text ?? null,
      };
    },
  });

  /* ── memory_forget（R-156：遗忘闭环，裁决权在人）── */
  tool({
    name: 'memory_forget',
    description: [
      '物理删除一条记忆（不可逆）：md 真相源、SQLite、向量、连锁边、冷存、git tombstone 六处一次清空。',
      '使用纪律：仅当用户明确要求忘记某条记忆时才可用；必须先 memory_search 检索拿到 entry_id，向用户复述要删的内容并得到确认后，',
      '再把同一个 entry_id 原样传给 confirm 参数。禁止凭猜测批量删除；删除后告知用户已完成。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['entry_id', 'confirm'],
      properties: {
        entry_id: { type: 'string', description: '要遗忘的条目 id（来自 memory_search）' },
        confirm: { type: 'string', description: '误删防护：原样再传一遍同一个 entry_id' },
        reason: { type: 'string', description: '可选：为什么忘（进 audit）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['forgotten'],
        properties: {
          forgotten: { type: 'boolean' },
          entry_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.forgotten
          ? `已遗忘 ${value.entry_id}（六处存储已清，git 留了 tombstone，重建不会复活）。`
          : `${value.entry_id} 不在库里（可能已忘过），未做任何改动。`,
      }],
    },
    async execute(args) {
      const r = await kernel.lifecycle.forget(String(args.entry_id ?? ''), {
        confirmId: String(args.confirm ?? ''),
        reason: args.reason ? String(args.reason).slice(0, 200) : undefined,
      });
      return { forgotten: r.forgotten, entry_id: r.entryId };
    },
  });

  /* ── memory_dream ── */
  tool({
    name: 'memory_dream',
    description: '触发一次记忆巩固：激活结算、状态回写、冷存归档、一致性修复、身份分叉采集。空闲时调用即可。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.ok ? '记忆巩固完成。' : `dream 未执行：${value.detail ?? '未知原因'}` }],
    },
    timeoutMs: 120_000,
    async execute() {
      await kernel.lifecycle.dream();
      return { ok: true };
    },
  });

  /* ── memory_maybe_dream ── */
  tool({
    name: 'memory_maybe_dream',
    description: '按巩固信号与空闲时间判断是否需要 dream；不满足条件时什么都不做（比 memory_dream 更适合挂定时）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'detail'],
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string', description: 'skipped: <原因> 或 triggered: <信号>' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.status === 'disabled' ? '本会话已关闭记忆功能。' : `maybeDream：${value.detail}` }],
    },
    timeoutMs: 120_000,
    async execute() {
      const r = await kernel.lifecycle.maybeDream();
      const detail = r.skipped ? `skipped: ${r.skipped}` : `triggered: ${r.triggeredBy ?? 'manual'}`;
      return { ok: true, detail };
    },
  });


/** status() 依赖 kernel 闭包，放在 apply 内部（见上方 API 块引用）。 */
async function status() {
  const cfgLive = kernel.cfg;
  const statsOnce = kernel.health.stats();   // 【R-152】单次快照，status 一次请求只打一遍聚合
  const domainEntries = statsOnce.domainEntries(kernel.domains.list().map((d) => d.id));
  // 全量会话底表（sessionQuery.listSessions：不激活 Agent、含冷存），标题实时读投影
  let allSessions = [];
  try {
    const listed = await ctx.sessionQuery.listSessions();
    allSessions = (listed ?? []).map((rec) => ({ id: rec.header.id, updatedAt: rec.header.updatedAt ?? rec.header.time ?? 0, header: rec.header }));
  } catch (e) { /* 查询失败时降级为 recent ∪ blocked */ }
  const ids = [
    ...new Set([
      ...allSessions.map((x) => x.id),
      ...recentSessions.keys(),
      ...(kernel.cfg.plugin.blockedSessions ?? []),
    ]),
  ].slice(0, 40);
  const updatedOf = new Map(allSessions.map((x) => [x.id, x.updatedAt]));
  const headerOf = new Map(allSessions.map((x) => [x.id, x.header]));
  // 域目录列表（设置页"打开 md 文件夹"按钮用）
  let domainDirs = [];
  try {
    const entries = await fs.readdir(path.join(root, 'domains'), { withFileTypes: true });
    domainDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { /* domains 目录缺失时为空 */ }
  return {
    ok: true,
    enabled: cfgLive.plugin.enabled,
    config: {
      enabled: cfgLive.plugin.enabled,
      topK: cfgLive.retrieve.defaultTopK,
      dailyQuotaDefault: cfgLive.write.dailyQuotaPerDomain.default ?? 20,
      coldThreshold: cfgLive.lifecycle.coldThreshold,
      coldIdleDays: Math.round(cfgLive.lifecycle.coldIdleMs / 864e5),
      memIndexEnabled: cfgLive.retrieve.memIndex.enabled !== false,
      queryExpansion: cfgLive.retrieve.queryExpansion !== false,
      embedBackend: cfgLive.embedding.backend,
      lexvecReady: Boolean(lexvec),
      synonymGroups: [...(cfgLive.retrieve.synonymGroups ?? [])],
      verifiedEnabled: cfgLive.trust.verifiedEnabled,
    },
    stats: {
      // 【R-152】只读聚合统一走 health.stats()（src/core/stats.js）——适配层不再手写 SQL
      entries: statsOnce.entries,
      sources: statsOnce.sources,
      entryTypes: statsOnce.entryTypes,
      vecPending: statsOnce.vecPending,
      // 【R-108】原话流水：条数是"记住了多少对话原文"的唯一可观测信号
      transcript: kernel.memory.transcript.stats({}),
      // 【R-139】内心活动流水 + 日记（日记篇数 = "写下了多少天"）
      inner: kernel.memory.inner.stats(),
      diary: kernel.memory.diary.stats(),
      // 【R-142】情绪日志：byOwner 分行看清两条采集线各自跑了没有
      emotions: kernel.memory.emotions.stats(),
      // 【R-149】确认池：等用户裁决的低置信候选数（human-in-the-loop 的可见性）
      confirmPending: statsOnce.confirmPending,
      confirmGateEnabled: cfgLive.write.confirmGate?.enabled === true,
      // 【R-95】情绪分布（条目级标注，非流水）：键名保留兼容旧客户端
      emotionDistribution: statsOnce.emotionTags,
    },
    transcriptEnabled: kernel.cfg.transcript?.enabled !== false,
    // 【R-137】向量索引的**实际形态**（只读诊断，不是开关）：
    // 报"现在真的走哪条路"和"为什么"，而不是"配置想要什么"——诊断价值全在两者之差。
    // 关于 ANN：sqlite-vec 至今没有任何发布版支持 rescore 索引，实测即便有，300 维下也得不偿失
    // （要 95% 召回只能快 13%），已按 R-136 证伪并清理，不要再加回一个点了没反应的旋钮。
    vector: (() => {
      const st = kernel.health.vec.stats();
      const doms = (kernel.domains.list?.() ?? []).map((d) => ({
        id: d.id, vectors: kernel.health.vec.shardCount(d.id), mode: kernel.health.vec.mode(d.id),
      }));
      let reason;
      if (!vecInfoRef().version) reason = 'sqlite-vec 未加载：向量路已降级为三路召回';
      else if (!st.enabled) reason = `内存索引未启用（${st.refusal ?? 'unknown'}）→ 回落 vec0 MATCH`;
      else if (st.dirtyDomains > 0) reason = `${st.dirtyDomains} 个域的索引已脏：本轮回落 vec0，下次查询重灌`;
      else if (st.domains === 0) reason = '内存索引可用，但还没有域被查询过（懒加载：首次查询才灌）';
      else reason = '内存精确索引生效：单次查询不再从 SQLite 搬 BLOB';
      return {
        mode: doms[0] ? kernel.health.vec.mode(doms[0].id) : null,
        residentVectors: st.vectors,
        bytes: st.bytes,                 // 唯一需要盯的开销：向量数 × 维度 × 4B
        loadedDomains: st.domains,
        dirtyDomains: st.dirtyDomains,
        maxVectors: st.maxVectors,
        usearch: st.enabled ? 'ok' : (st.refusal ?? null),
        sqliteVec: vecInfoRef().version ?? null,
        domains: doms,
        reason,
      };
    })(),
    // 【R-117】隐私档位的当前形态（UI 只读展示：这一层改错就是泄露，不给表单随便点）
    privacy: {
      ownerIds: [...(kernel.cfg.privacy?.ownerIds ?? [])],
      crossSessionSensitivity: kernel.cfg.privacy?.crossSessionSensitivity === true,
      nonOwnerSeesShared: kernel.cfg.privacy?.nonOwnerSeesShared === true,
      // 【v4.29 fail-closed 可发现性】配了白名单但宿主不提供 viewer 身份时，
      // private/shared 条目对检索与工具全部不可见——把这事写在状态里，别让人猜。
      viewerWarning: (kernel.cfg.privacy?.ownerIds ?? []).length > 0
        ? '已配置 ownerIds 白名单，但 DSH 宿主当前不提供可信 viewer 身份：private/shared 条目将不可见。要么清空 ownerIds，要么给宿主接身份。'
        : null,
    },
    embeddingReady: kernel.vec.isReady(),
    // 【R-154】health 三态：READY/DEGRADED/FAILED + 原因数组（纯查现算，见 kernel.health）
    health: kernel.health(),
    // 【R-155】任务统一视图：四类积压只读聚合（口径在 src/core/tasks.js，面板与 SQL 同源）
    tasks: kernel.health.taskBacklog(),
    forks: kernel.health.listIdentityForks('dsh'),
    domains: domainDirs,
    // 【R-138】域明细：注册表（含动态域）+ 条目数。domains（字符串数组）保留兼容旧客户端。
    domainsDetail: (kernel.domains.list?.() ?? []).map((d) => ({
      id: d.id,
      builtIn: d.id === 'dsh',
      dynamic: dynamicDomainIds.includes(d.id),
      entries: domainEntries[d.id] ?? 0,
    })),
    blockedSessions: [...(kernel.cfg.plugin.blockedSessions ?? [])],
    recentSessions: ids
      .map((id) => {
        const rec = recentSessions.get(id);
        const blocked = (kernel.cfg.plugin.blockedSessions ?? []).includes(id);
        const lastAt = rec?.lastAt ?? updatedOf.get(id) ?? 0;
        return {
          id,
          title: sessionTitleOf(id, headerOf.get(id)),
          lastAt,
          calls: rec?.calls ?? 0,
          blocked,
        };
      })
      .sort((a, b) => b.lastAt - a.lastAt),
  };
}

  // ── 管理面 API（状态 + 动作），供设置页"记忆-测试"卡片调用 ──
  // webServer 服务不在插件根上下文，而在 web 组合的子上下文——必须
  // ctx.inject(['webServer'], (webCtx) => …) 进入（照抄 api-gateway 的模式；
  // 直接 ctx.get('webServer') 会抛错）。鉴权双保险：网关 cookie + handler 自查。
  // 【R-159.4 · 外审】必须 await：否则注册段跑在异步回调里，webServer 注册抛错发生在
  // apply 返回之后——cordis 不会回收（kernel 悬挂持锁）。await 后注册失败 = apply 失败 =
  // effect 完整回收；服务已在插件 inject 声明中，apply 执行时必然 ready，不引入额外等待。
  let webServerError = null;
  await ctx.inject(['webServer'], (webCtx) => {
    try {
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const guarded = (handler) => (req, res) => {
      const cookie = String(req.headers.cookie ?? '');
      if (!/dsh-auth-/.test(cookie)) return json(res, 401, { error: 'unauthorized' });
      return handler(req, res);
    };
    const readBody = (req) => new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 65536) reject(new Error('body too large')); });
      req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    });
    const api = webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/plugins/dsh-memory-kernel',
      handler: guarded(async (req, res) => {
        const sub = req.url.replace(/^\/api\/plugins\/dsh-memory-kernel/, '').split('?')[0];
        try {
          if (req.method === 'GET' && (sub === '/status' || sub === '' || sub === '/')) return json(res, 200, await status());
          if (req.method === 'POST' && sub === '/actions/config') {
            const patch = await readBody(req);
            const allowed = ['plugin.enabled', 'plugin.blockedSessions', 'retrieve.defaultTopK', 'retrieve.queryExpansion', 'retrieve.synonymGroups', 'write.dailyQuotaPerDomain',
              'lifecycle.coldThreshold', 'lifecycle.coldIdleMs', 'retrieve.memIndex', 'trust.verifiedEnabled', 'embedding.backend'];
            // 白名单按扁平键名匹配；applyConfigPatch 只吃嵌套对象——先展开再放行。
            // map 型字段（dailyQuotaPerDomain）按域写（如 write.dailyQuotaPerDomain.default），浅合并不丢其他域。
            const clean = {};
            for (const [k, v] of Object.entries(patch ?? {})) {
              if (!allowed.includes(k) && !allowed.some((a) => k.startsWith(a + '.'))) continue;
              const parts = k.split('.');
              let cur = clean;
              while (parts.length > 1) { const seg = parts.shift(); cur = cur[seg] ??= {}; }
              cur[parts[0]] = v;
            }
            const r = kernel.health.applyConfigPatch(clean);
            // 同义词典落盘（同 blocklist 模式）：进 kernel 即写文件，重启可恢复
            if (r.applied.includes('retrieve.synonymGroups')) {
              await fs.writeFile(synonymsPath, JSON.stringify(kernel.cfg.retrieve.synonymGroups ?? [], null, 2), 'utf8')
                .catch(() => {});
            }
            // 【查询扩展开关持久化】开关同样自管落盘（此前只进内存，重启必丢）
            if (r.applied.includes('retrieve.queryExpansion')) {
              await fs.writeFile(queryExpansionPath, JSON.stringify({ enabled: kernel.cfg.retrieve.queryExpansion !== false }, null, 2), 'utf8')
                .catch(() => {});
            }
            // 嵌入后端落盘：embedder 进程启动时构造，切换后须重启 web 才注入新后端。
            // ⚠ structural 键只出现在 r.structural、不在 r.applied（实测踩过：文件永远没写）
            if (r.applied.includes('embedding.backend') || (r.structural ?? []).includes('embedding.backend')) {
              await fs.writeFile(embedSettingsPath, JSON.stringify({ backend: kernel.cfg.embedding.backend, lexvecTablePath: kernel.cfg.embedding.lexvecTablePath ?? '' }, null, 2), 'utf8')
                .catch(() => {});
            }
            if (r.rejected.length) return json(res, 400, { error: 'rejected', rejected: r.rejected });
            return json(res, 200, { ok: true, ...r });
          }
          // ── LLM 接入（R-127~R-130）：状态探测 + 设置落盘 ────────────────────
          // GET 返回：当前设置（key 打码）+ 宿主通道是否可用 + 可配置 provider 列表（UI 下拉用）。
          // POST 把设置写 llm-settings.json 并 patch 进 cfg；transport 在 kernel 构造期固化 → 需重启。
          if (req.method === 'GET' && sub === '/actions/llm-status') {
            let hostAvailable = false; let providers = []; let hostError = null;
            try {
              hostAvailable = typeof llmService?.prepareCall === 'function';
              if (hostAvailable) {
                // 宿主两个方法的返回结构未在插件侧定型：**两个都问、合并去重**，字段名放宽
                // （目录条目在 dsh-llm 里是 detachDirectoryEntry 出来的对象，不同版本键名有出入）。
                const seen = new Set();
                const push = (p) => {
                  const id = String(p?.id ?? p?.provider?.id ?? p?.providerId ?? p?.name ?? p?.label ?? '');
                  if (!id || seen.has(id)) return;
                  seen.add(id);
                  providers.push({ id, name: String(p?.name ?? p?.label ?? id) });
                };
                for (const fn of ['listConfigurableProviders', 'listProviders']) {
                  try {
                    const raw = await llmService[fn]?.();
                    const arr = Array.isArray(raw) ? raw : (raw?.providers ?? raw?.items ?? []);
                    for (const p of arr) push(typeof p === 'string' ? { id: p, name: p } : p);
                  } catch (e) { hostError = String(e?.message ?? e); }
                }
              }
            } catch (e) { hostError = String(e?.message ?? e); }
            const s = kernel.cfg.llm ?? {};
            const masked = {
              ...s,
              local: { ...(s.local ?? {}), apiKey: s.local?.apiKey ? '***' : '' },
              custom: { ...(s.custom ?? {}), apiKey: s.custom?.apiKey ? '***' : '' },
            };
            return json(res, 200, {
              settings: masked,
              host: { available: hostAvailable, providers, error: hostError },
              env: {
                customKeyEnv: s.custom?.apiKeyEnv ?? 'DSH_MEMORY_LLM_API_KEY',
                customKeyPresent: Boolean(s.custom?.apiKeyEnv && process.env[s.custom.apiKeyEnv]),
              },
              needsRestartToApply: true,
            });
          }
          if (req.method === 'POST' && sub === '/actions/llm-settings') {
            const body = (await readBody(req)) ?? {};
            const cur = kernel.cfg.llm ?? {};
            const str = (v, fb = '') => (v == null ? String(fb ?? '') : String(v));
            const next = {
              enabled: body.enabled === true,
              transport: ['host', 'local', 'custom'].includes(body.transport) ? body.transport : str(cur.transport, 'host'),
              host: {
                provider: str(body.host?.provider, cur.host?.provider),
                model: str(body.host?.model, cur.host?.model),
              },
              local: {
                baseUrl: str(body.local?.baseUrl, cur.local?.baseUrl),
                model: str(body.local?.model, cur.local?.model),
                // '***' 是打码回传值：用户没改 key 就保留原值，别把掩码当真 key 存进去
                apiKey: body.local?.apiKey === '***' ? str(cur.local?.apiKey) : str(body.local?.apiKey, cur.local?.apiKey),
              },
              custom: {
                baseUrl: str(body.custom?.baseUrl, cur.custom?.baseUrl),
                model: str(body.custom?.model, cur.custom?.model),
                apiKeyEnv: str(body.custom?.apiKeyEnv, cur.custom?.apiKeyEnv) || 'DSH_MEMORY_LLM_API_KEY',
                apiKey: body.custom?.apiKey === '***' ? str(cur.custom?.apiKey) : str(body.custom?.apiKey, cur.custom?.apiKey),
              },
              maxTokens: Number(body.maxTokens) > 0 ? Number(body.maxTokens) : (cur.maxTokens ?? 1024),
              timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : (cur.timeoutMs ?? 60000),
            };
            await fs.writeFile(llmSettingsPath, JSON.stringify(next, null, 2), 'utf8');
            kernel.health.applyConfigPatch({ llm: next });   // restart 类：值立刻生效，transport 要重启才重建
            return json(res, 200, { ok: true, needsRestart: true });
          }
          // LLM 连通性自测：用**当前 cfg** 临时构造 transport（不改内核里已固定的那个），
          // 发一句最小请求。设置刚保存还没重启时，这条路就能验证配置对不对。
          if (req.method === 'POST' && sub === '/actions/llm-test') {
            const t0 = Date.now();
            try {
              // 优先用请求里带的草稿设置（UI「测试连接」）——restart 类补丁不会写进活 cfg，
              // 拿 cfg 测永远测的是旧值。没带草稿才回落到 cfg。
              const body = (await readBody(req)) ?? {};
              const s = (body.settings && typeof body.settings === 'object') ? body.settings : (kernel.cfg.llm ?? {});
              const probe = createLlmRouter({ cfg: { llm: { ...s, enabled: true } }, hostLlm: llmService });
              if (!probe) return json(res, 400, { error: 'LLM 接入未配置' });
              const transport = s.transport ?? kernel.cfg.llm?.transport ?? 'host';
              const text = await probe.complete({
                system: '你是连通性探针，只回四个字符：PONG',
                messages: [{ role: 'user', content: 'ping' }],
              });
              return json(res, 200, { ok: true, transport, model: probe.model ?? '', ms: Date.now() - t0, text: String(text).slice(0, 200) });
            } catch (e) {
              return json(res, 200, { ok: false, transport: '', ms: Date.now() - t0, error: String(e?.message ?? e) });
            }
          }
          // ── 【R-138】动态新增域：校验命名 → 运行时注册（即刻生效）→ 落盘 → 建 md 目录 ──
          if (req.method === 'POST' && sub === '/actions/domain-add') {
            const body = await readBody(req);
            // 【R-158.6】正则下沉为共享 validateDomainId（defineDomain / registry 双入口同源），
            // 这里保留独立前置检查只为返回 400 JSON（内核侧抛错对 HTTP 太糙）。
            const id = String(body?.id ?? '').trim();
            if (!DOMAIN_ID_RE.test(id)) {
              return json(res, 400, { error: 'invalid-id', note: '英文开头，只能含英文字母/数字/下划线/连字符，最长 32 字符' });
            }
            if (id === 'dsh' || kernel.domains.get(id)) return json(res, 409, { error: 'exists', note: `域 ${id} 已存在` });
            kernel.domains.register(defineDomain({ id }));   // 运行时注册：路由/写入/检索即刻可用，无需重启
            dynamicDomainIds.push(id);
            await fs.writeFile(domainListPath, JSON.stringify({ domains: dynamicDomainIds }, null, 2), 'utf8').catch(() => {});
            await fs.mkdir(path.join(root, 'domains', id), { recursive: true }).catch(() => {});
            await audit.write('domain-registry', { event: 'added', id }).catch?.(() => {});
            return json(res, 200, { ok: true, id });
          }
          if (req.method === 'POST' && sub === '/actions/dream') {
            const r = await kernel.lifecycle.dream();
            return json(res, 200, { ok: true, snapshotTs: r.snapshotTs });
          }
          /* ── R-149 候选确认池：human-in-the-loop ── */
          if (req.method === 'GET' && sub === '/confirm-queue') {
            return json(res, 200, { items: kernel.memory.write.confirmQueue(), gateEnabled: kernel.cfg.write.confirmGate?.enabled === true });
          }
          /* ── R-63 记忆检索的可读摘要（人类视图）：走同一条检索管线（admit+验签），
               信任档位与注入给 LLM 的标签同一套 needsTrustLabel——两套标准迟早漂移 ── */
          if (req.method === 'GET' && sub === '/memory-search') {
            const u = new URL(req.url, 'http://localhost');
            const q = String(u.searchParams.get('q') ?? '').trim();
            const domainId = String(u.searchParams.get('domain') ?? 'dsh').trim();
            const k = Math.max(1, Math.min(Number(u.searchParams.get('k')) || 10, 30));
            if (!q) return json(res, 200, { domain: domainId, items: [], note: 'empty-query' });
            const r = await kernel.memory.search({ domain: domainId, query: q, topK: k });
            if (!r.domain) return json(res, 200, { domain: domainId, items: [], note: 'domain-not-found' });
            const items = (r.entries ?? []).map((e) => readableEntry(e, r.domain, (id) => kernel.domains.get(id)));
            return json(res, 200, { domain: r.domain.id, intent: r.intent, items });
          }
          if (req.method === 'POST' && sub === '/actions/confirm-approve') {
            const body = await readBody(req);
            const id = Number(body?.id);
            if (!Number.isInteger(id)) return json(res, 400, { error: 'id required' });
            const r = await kernel.memory.write.confirmApprove(id);
            return json(res, r.ok ? 200 : 404, r);
          }
          if (req.method === 'POST' && sub === '/actions/confirm-reject') {
            const body = await readBody(req);
            const id = Number(body?.id);
            if (!Number.isInteger(id)) return json(res, 400, { error: 'id required' });
            const r = await kernel.memory.write.confirmReject(id, String(body?.note ?? ''));
            return json(res, r.ok ? 200 : 404, r);
          }
          if (req.method === 'POST' && sub === '/actions/forget') {
            const body = await readBody(req);
            const id = String(body?.entryId ?? '').trim();
            if (!id) return json(res, 400, { error: 'entryId required' });
            const r = await kernel.lifecycle.forget(id, { confirmId: id, reason: body?.reason ? String(body.reason).slice(0, 200) : undefined });
            return json(res, 200, { ok: true, ...r });
          }
          if (req.method === 'GET' && sub === '/rebuild-progress') return json(res, 200, rebuildProgress);
          if (req.method === 'POST' && sub === '/actions/synonym-diag') {
            const body = await readBody(req);
            const q = String(body?.query ?? '').trim();
            if (!q) return json(res, 400, { error: 'query required' });
            // 与 ftsSearch 完全同款的两个扩展入口——所见即检索所得
            const expanded = expandAttributeAliases(q);
            const extras = synonymExtrasFor(q).split(' ').filter(Boolean);
            return json(res, 200, {
              query: q,
              expandedQuery: expanded !== q ? expanded : null,   // attribute 别名替换（通常 query 不涉及）
              expansionWords: extras,                             // 同义组扩展出的词（ftsSearch 以 "词"* 前缀并入 OR）
              enabled: kernel.cfg.retrieve.queryExpansion !== false,
            });
          }
          if (req.method === 'POST' && sub === '/actions/rebuild') {
            if (rebuildProgress.running) return json(res, 409, { error: 'rebuild 已在进行中' });
            rebuildProgress.running = true;
            rebuildProgress.error = null;
            rebuildProgress.summary = null;
            rebuildProgress.startedAt = Date.now();
            try {
              const r = await kernel.lifecycle.rebuild({
                onProgress: ({ phase, done, total }) => {
                  rebuildProgress.phase = phase;
                  rebuildProgress.done = done ?? 0;
                  rebuildProgress.total = total ?? 0;
                },
              });
              rebuildProgress.summary = { entries: r.entries, files: r.files, elapsedMs: r.elapsedMs };
              return json(res, 200, { ok: true, entries: r.entries, files: r.files, elapsedMs: r.elapsedMs });
            } catch (e) {
              rebuildProgress.error = String(e?.message ?? e);
              return json(res, 500, { error: String(e?.message ?? e) });
            } finally {
              rebuildProgress.running = false;
            }
          }
          if (req.method === 'POST' && sub === '/actions/session') {
            const body = await readBody(req);
            const sid = String(body.sessionId ?? '');
            if (!sid) return json(res, 400, { error: 'sessionId required' });
            const cur = [...(kernel.cfg.plugin.blockedSessions ?? [])];
            const next = body.blocked ? [...new Set([...cur, sid])] : cur.filter((x) => x !== sid);
            // 注意 applyConfigPatch 吃嵌套对象——扁平键 'plugin.blockedSessions' 会被当成
            // 一个含点的顶层键而判 ghost-key（/actions/config 有展开逻辑，这里直接用嵌套）。
            const r = kernel.health.applyConfigPatch({ plugin: { blockedSessions: next } });
            if (r.rejected.length) return json(res, 400, { error: 'rejected', rejected: r.rejected });
            await fs.writeFile(blocklistPath, JSON.stringify(next, null, 2), 'utf8');   // 持久化
            return json(res, 200, { ok: true, blocked: next });
          }
          if (req.method === 'POST' && sub === '/actions/lexvec-neighbors') {
            const body = await readBody(req);
            if (!lexvec) return json(res, 400, { error: 'lexvec 后端未启用（嵌入后端切到 lexvec 并 rebuild 后可用）' });
            const word = String(body?.word ?? '').trim();
            if (!word) return json(res, 400, { error: 'word required' });
            const res2 = lexvec.neighbors(word, Math.min(Number(body?.topK ?? 8), 20));
            const inDict = new Set((kernel.cfg.retrieve.synonymGroups ?? []).flat().map((w) => String(w).toLowerCase()));
            return json(res, 200, {
              ...res2,
              neighbors: res2.neighbors.map((n) => ({ ...n, inDict: inDict.has(String(n.word).toLowerCase()) })),
            });
          }
          if (req.method === 'POST' && sub === '/actions/open-folder') {
            const body = await readBody(req).catch(() => ({}));
            const domainId = String(body?.domain ?? '').match(/^[a-z0-9_-]+$/i) ? body.domain : null;
            const dir = body?.target === 'root' ? root : (domainId ? path.join(root, 'domains', domainId) : null);
            if (!dir) return json(res, 400, { error: 'domain or target required' });
            try {
              await fs.access(dir);
            } catch {
              return json(res, 404, { error: `目录不存在：${dir}` });
            }
            // 本地部署：服务端与用户同机，直接拉起系统文件管理器
            const { exec } = await import('node:child_process');
            const cmd = process.platform === 'win32' ? `explorer "${dir}"`
              : process.platform === 'darwin' ? `open "${dir}"`
              : `xdg-open "${dir}"`;
            exec(cmd, () => {});   // explorer 常返回非零码，忽略
            return json(res, 200, { ok: true, path: dir });
          }
          if (req.method === 'POST' && sub === '/actions/align') {
            const body = await readBody(req);
            const r = await kernel.health.resolveIdentityFork({
              domainId: 'dsh', subjectKey: body.subjectKey, attribute: body.attribute, keepEntryId: body.keepEntryId,
            });
            return json(res, 200, { ok: true, ...r });
          }
          return json(res, 404, { error: 'not found' });
        } catch (err) {
          return json(res, 500, { error: String(err?.message ?? err) });
        }
      }),
    });
    disposers.push(api);
    } catch (webRegErr) { webServerError = webRegErr; }
  });
  // 【R-159.4 · 外审】cordis 的 inject 回调错误不传播给调用方（实测吞掉）——不检查的
  // 后果是 webServer 注册失败静默发生、kernel 悬挂持锁永不回收。这里显式抛出：注册失败 =
  // apply 失败 = effect 完整回收（与 tools 注册失败同路径）。
  if (webServerError) throw webServerError;

  // ── 【R-143】dream 空闲触发调度器 ──
  // maybeDream 的注释一直写着"宿主挂定时器即可"，但没人挂过——idle 触发从上线起就是死的，
  // dream 只能靠手动或她调 memory_maybe_dream。这里由插件自己挂 60s tick：
  // maybeDream 自带全部闸门（禁用/信号分/空闲窗），tick 只是心跳，判定权在 kernel。
  const dreamTimer = setInterval(() => { kernel.lifecycle.maybeDream().catch(() => {}); }, 60_000);
  if (typeof dreamTimer.unref === 'function') dreamTimer.unref();   // 不阻塞宿主退出

  // cordis 约定：apply 的返回值 = 清理函数（返回普通对象会抛 "Invalid effect"）
  return async () => {
    clearInterval(dreamTimer);
    for (const d of disposers.splice(0)) { try { d(); } catch { /* 已被宿主卸载 */ } }
    // 【R-159.5-C 对齐】正常卸载路径的 close 阶段错误同样留痕不静默（与 effect 回滚路径一致；
    // 锁释放由 closeKernel 分阶段保底，留痕不影响回收完成）
    await kernel.close().catch((e) => {
      console.error('[dsh-memory-kernel] 正常卸载时的 close 阶段错误（锁释放已由 closeKernel 分阶段保底）：', e?.message ?? e);
    });
  };
}


/**
 * 配置树 —— 与 HLD/LLD v4.10 §19 一一对应。
 *
 * 【R-75 / R-50 禁止项】代码里出现的 `cfg.*` 路径必须能在本文件里找到同名键。
 * 读出来是 `undefined`（falsy）时行为往往"恰好对"，属于最难查的一类 bug；
 * 所以这里不做"扁平化别名"，只保留 §19 的嵌套形状。
 */
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  // 插件总开关（设置页 Phase 1 的热闸门）：false 时工具 handler 与 pre/post-step 钩子全部短路。
  // 只闸行为，不注销注册——宿主没有运行时 unregister 单工具的路径，这是当前契约下的正确形态。
  // blockedSessions：会话级黑名单（§会话开关）——名单内的会话工具返回 disabled（"这条会话不带记忆"），
  // hot 数组整体替换热生效。
  plugin: { enabled: true, blockedSessions: [] },

  storage: {
    root: path.join(process.env.DSH_HOME ?? os.homedir(), 'memory-kernel'),
    dbPath: '',                       // 空 = <root>/index.db
    busyTimeoutMs: 5000,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, // IANA 名，quotas.date 按此切日
    maxEntriesPerFile: 800,
    partSwitchMaxAttempts: 5,         // 锁内判满后换 path 重试上限；耗尽降级超限写入 [R-38]
  },

  embedding: {
    // P0a 的 embedding 走「可插拔 embedder」：宿主注入真实模型，测试注入 hashEmbedder。
    // 未注入时向量路自动降级为三路召回（§18），不是错误。
    // backend：hash=向量路关闭（DSH 默认，无语义）；lexvec=词向量表后端（纯查表语义）。
    backend: 'hash',
    lexvecTablePath: '',
    model: 'bge-m3-q8',
    dim: 1024,
    batchSize: 16,
    rpcTimeoutMs: 2000,
    warmupTimeoutMs: 10_000,
    prewarmOnStart: true,
  },

  // 【LLM 接入 · R-127~R-130】总开关 + 三档 transport。默认关：抽取管线维持"骨架在、不产候选"。
  // 关闭时依赖 LLM 的能力（s7 语义对账 / 自动抽取 / pattern 提炼）显式 skip 并 audit llm-disabled，
  // 不静默——否则用户以为在跑。真正的值来源是 root/llm-settings.json（宿主 Config volatile 通道断，
  // 与 embedding-settings.json 同款自持久化），DEFAULTS 只是形状与兜底。
  llm: {
    enabled: false,
    transport: 'host',                // host=复用宿主 ctx.llm（key 不进插件）| local=本地 OpenAI 兼容端点 | custom=自定义云 API
    host: { provider: '', model: '' },              // 空 = 由设置页探测宿主当前默认，不在代码里写死模型名
    local: { baseUrl: 'http://127.0.0.1:11434/v1', model: '', apiKey: '' },   // Ollama / LM Studio / vLLM
    custom: { baseUrl: '', model: '', apiKeyEnv: 'DSH_MEMORY_LLM_API_KEY', apiKey: '' },  // key 优先环境变量
    // 2048：1024 会截断日记六节 JSON（光 6 个会话 ID 就 260 字），截断的 JSON
    // 解析失败静默退模板——2026-10-28 首篇日记实测踩中。抽取输出小不受影响。
    maxTokens: 2048,
    timeoutMs: 60000,
  },

  write: {
    dailyQuotaPerDomain: { 'qq-group': 15, 'qq-private': 10, bili: 5, douyin: 5, default: 20 },
    extractModelTier: 'cheap',
    novelty: { redundant: 0.92, uncertain: 0.80, literalJaccard: 0.85 },
    // 【冲突治理 §2.2】attribute 同义折叠表（别名 → 规范名）：写入与查询两侧对称折叠。
    // 预置最保守的一组；扩展直接在这里加（hot，patch 后即时生效）。
    attributeAliases: { '喜好': '偏好', '口味': '偏好', '爱好': '偏好' },
    updateGamma: 3.0,
    pendingTtlMs: 3 * 864e5,
    p0aBypassRouting: false,          // **仅 P0a** 置 true：恒走 new；P0b 起必须 false [R-53]，
                                      // 留着 true 等于"所有消息都当新条目"，四分类整条链是死的
    microBatchRows: 500,
    // §12.1 isUseful 的最小判据（文档要求"可配"，P0b 前定，勿发明更多维度）
    useful: { enabled: true, minChars: 4, untaggedMinChars: 15 },
    // 【R-149】确认闸门：开 = uncertain 候选不再"pending 保留 + 新候选照常入库"双发，
    // 而是只进确认池（reason='confirm'），等用户在设置页裁决——human-in-the-loop。
    // 默认关（行为变化大）。TTL 沿用 pendingTtlMs，确认池不当第二个幽灵堆积点。
    confirmGate: { enabled: false, confirmBoost: 0.2 },
    pendingDrainLimit: 20,            // 单次消费 pending 的上限（仍受配额约束，满了就停）
    patternQuotaPerDay: 2,            // §17.2 第 7 步：pattern 提炼的**独立配额**（P3+），不挤日常写入
  },

  retrieve: {
    rrfK: 60,
    // 【检索增强】查询同义词典：组内词互为变体，query 命中任一词即扩展全组进 FTS（OR）。
    // 每行一组在设置页编辑（JSON 数组的数组）。
    queryExpansion: true,
    synonymGroups: [
      ["喜欢", "爱好"],
      ["喝", "饮品"],
      ["聊天", "闲聊", "唠嗑"],
    ],
    recentHalfLifeMs: 7 * 864e5,
    skipVector: { enabled: true },
    // 【R-109】全域检索：entries 默认跨域可查（每条自带 domain_id 出身处），
    // domain 从"检索围墙"降级为**信任标签 + 隐私开关**。关掉 = 退回只查本域。
    // 原话流水（transcript）不受此开关影响——它永远本域（R-110，原话隐私含量最高）。
    allDomains: { enabled: true },
    minPartitionVectors: 50,
    knnOversample: 4,
    retrievalLogTtlMs: 7 * 864e5,
    maxEmbedRpcPerRetrieval: 1,
    hotPartitionWarnAt: 80_000,
    coldRankOffset: 8,
    coldScanWarnMs: 300,
    routeScoreSampling: 0.01,
    defaultTopK: 8,
    // 【R-144】importance 排序调制：score ×(1 + w×(imp-0.5))。w=0 关闭；合成 eval 全 0.5
    // 时因子恒 1 不扰动基线。权重校准等真实数据（P2 纪律），起步值取保守的 0.15。
    importanceWeight: 0.1,
    // P3+：cross-encoder 重排。**默认关**——需要宿主注入 reranker 模型（retrieve.reranker）；
    // 它是本地推理，不吃 embedding RPC 配额（R-62），但会增加检索耗时，灰度时看 P95。
    rerank: { enabled: false, pool: 24 },
    // 【R-137】内存精确索引（第二派生层）：每域常驻一份扁平 Float32Array，查询走 usearch
    //   `exactSearch` 精确扫描，省掉"每次查询都从 SQLite 搬几万条 BLOB"的开销（实测那步 283ms）。
    //   关掉 = 回退 vec0 MATCH 路径，**行为不变**，只是慢几倍到几十倍。
    // 这里没有 'vectorStrategy: ann' 这个选项，而且不要加回来：sqlite-vec 至今没有 rescore
    //   索引（只有 PR #276 讨论），实测即便有，300 维下量化+重排要做到 95% 召回也只能快 13%
    //   （58.7ms vs 精确 67.9ms）—— 收益为负，见 R-136 的证伪记录。
    memIndex: {
      enabled: true,
      // 整库常驻上限。8 万条 × 300 维 f32 ≈ 92MB；20 万条 ≈ 230MB。超限的域不建索引，
      // 回落 vec0（只影响延迟），并写一条 audit 留痕。
      maxVectors: 200_000,
    },
  },

  routing: { selfContainedMaxLen: 12 },

  lifecycle: {
    halfLifeDays: { pattern: 75, fact: 30 },
    floor: { boundary: 0.6, skill: 0.5, pattern: 0.1, fact: 0.1 },
    initPersistence: 0.5,
    coldThreshold: 0.15,
    coldIdleMs: 90 * 864e5,
    // 【R-144】冷存豁免线：importance ≥ 此值不归档（boundary/skill 写入期 = 1.0，行为等价）
    importanceFloor: 0.8,
    activationBonus: 0.08,
    activationCap: 4,
    maxPersistence: 1.0,
    activationHardCap: 100_000,
  },

  trust: {
    meanReversion: 0.02,
    lr: { verified: 1.3, conflict: 0.6 },
    verifiedMaxLen: 20,
    verifiedWindowMs: 30 * 864e5,
    verifiedMaxPerWindow: 3,
    // P2 打开：评测集（eval/report.md）上 detectVerified 误报率 0%（< 5% 达标）且触发密度足够。
    // 关回去的理由只有一个：换了词表/模型后发现误报抬头（§16.2 的判据）。
    verifiedEnabled: true,
  },

  security: {
    requireSignatureDomains: [],
    keyDir: '',                       // 空 = <root>/keys
    rereadPenalty: 0.85,
    rereadOverRead: 4,
    rereadDeadlineMs: 100,
    bigramCoverageThreshold: 0.8,
    // P2 打开：软降权只乘 0.85，硬排除（evidence<0.5 → 排除）P1 就已生效。
    // 阈值档位（0.5 / 1.0）先按文档起步值，真实 shadow 数据攒够后再定档（§7 P2 验收）。
    rereadEnforcePenalty: true,
  },

  dream: {
    idleMs: 1_800_000,
    minIntervalMs: 3_600_000,
    peakWindowMs: 300_000,
    signalThreshold: 5.0,
    // §17.1：巩固信号加权（消费时用，见第 11 步）
    signalWeights: { topic_fact_burst: 1.5, conflict_accum: 1.0, evidence_gap: 0.5 },
    snapshotRetentionCommits: 30,
    ftsOptimizeEveryDeletes: 500,
    ftsOptimizeIntervalMs: 7 * 864e5,
    reconcileFullEveryNDreams: 20,
    // 【R-121】状态落盘量化门槛：惰性衰减让 p 每轮都变，照旧全库重写（✓实证 dream.log s2 changed 14/14），
    // 与 §6"O(当日变更条目数)"的承诺冲突。Δp 未达门槛且距上次落盘不足 N 天 → 只算不落（SQLite/MD 都不写），
    // 下外审从同一 last_decay_at 重算，delta 自然累积到门槛再落 —— 幂等，不会丢状态。
    stateWriteEpsilonP: 0.01,
    stateWriteMaxStaleDays: 14,
    steps: {
      gitSnapshot: true,
      stateSync: true,
      ttlCleanup: true,
      consistencyRepair: true,
      coldArchive: true,
      ftsOptimize: true,            // P2 起：带触发条件（>500 删改或 >7 天），不是每轮都跑
      reconcileShards: true,
      identityMetrics: true,        // P2 起：身份分叉采集 + 告警（对齐是 P3+ 的人工动作）
      patternMining: true,          // P3 起：步 7，同簇 fact ≥ 2 且信号达标才调 LLM；未注入 llm 自动跳过
      consolidation: true,          // P3 起：步 11，消费巩固信号（加权求和 ≥ 阈值的域进 pattern 提炼）
      cooccurrenceLinks: true,      // 连锁记忆：步 13，从 retrieval_log 共现长 coexist 边（§9.1 做活）
      semanticAudit: true,          // R-120 L3：步 14，跨条目语义对账——发现矛盾只告警，绝不自动清理
    },
    // 共现挖边参数：同窗口共现 ≥3 次才连边；单条目 dream 边 ≤8（防热门条目蜘蛛网）；回看窗口 30 天
    cooccurrence: { minCo: 3, perEntryCap: 8, windowMs: 30 * 864e5 },
    // 语义对账参数：对近 14 天新账各查 3 个近邻交 LLM 判矛盾；单轮最多 12 对（控 LLM 成本）
    semanticAuditCfg: { lookbackDays: 14, neighbors: 3, maxPairsPerRun: 12 },
  },

  assemble: {
    tokenBudget: { guide: 150, stable: 1100, dynamic: 3500 },
    reinjectOnCompact: true,
    recencyHalfLifeMs: 14 * 864e5,
    sharedMax: 5,
    // 【R-96 情感雷达 P-a】只读参考段的开关与窗口。关掉 = 动态段不再出现"情绪参考"，
    // 但 emotion 列照常写（数据不丢，以后想开随时开）。
    emotionHint: { enabled: true, windowDays: 3 },
  },

  // 【R-108 对话流水层】原话纯 append 到 SQLite（不进真相源 Markdown、不占写入配额）。
  // enabled=false 时 pre-step 不落盘、检索不查原话段——与没这功能时完全一致。
  // maxCharsPerMsg 是**存储**截断（单条消息原文上限），防止一次贴几万字把库撑爆；
  // searchTopK 必须小：原文比提炼条目长数倍，塞多了直接烧 token。
  transcript: {
    enabled: true,
    maxCharsPerMsg: 1000,
    searchTopK: 3,
    retainDays: 180,
    // 泛句降权（检索演练 2026-10-29）：同域内同文本重复 ≥demoteRepeat 次（口头禅/模板句）
    // 的原话行 rrf ×demoteFactor。0 = 关闭。判据是库内频次，不是硬编码黑名单。
    demoteRepeat: 3,
    demoteFactor: 0.3,
  },

  // 【R-139】内心活动流水：她"当时为什么这么说"的第一手记录（memory_inner 工具写入）。
  // 生命周期同 transcript——流水会淡忘，耐久版是日记里合并后的「当时的想法」。
  inner: {
    enabled: true,
    maxCharsPerNote: 500,   // 单条存储截断
    retainDays: 180,
  },

  // 【R-142】情绪日志：双方情绪的独立流水（抽取顺带判定 + memory_inner 自述）。
  // **enabled 只控注入不控采集**——采集成本为零且 A/B 对比必须基于同一批数据；
  // 关掉 = 三个消费口（情绪参考段/当日档案/日记情绪节）不再注入，emotion_log 照写。
  emotion: {
    enabled: true,
    windowDays: 3,      // 情绪参考段的回看窗口
    retainDays: 180,    // 流水 TTL，同 transcript；耐久版是日记「情绪」节
  },

  // 【R-139】日记：每天一篇进真相源（domains/<域>/diary/YYYY-MM-DD.md），永不衰减。
  // LLM 可用走语义生成（经历/场景/情绪/在场/想法/摘录六节），不可用退机械模板。
  diary: {
    enabled: true,
    maxQuoteChars: 160,     // 原话摘录的单条上限——日记是提炼级，不是聊天记录备份
  },

  // 【R-112/R-117 成对隐私】可见性从"记忆产生的对话对"推导，不按"谁是大老板"。
  // crossSessionSensitivity：设为 true 时 private 条目才允许跨会话召回
  // （默认 false = 成对隐私：private 只在产生它的那段对话里可见，owner 换个会话也看不见）。
  privacy: {
    ownerIds: [],                    // 说话人白名单（多平台账号 ID）；空 = 不启用 speaker 闸（单人 web 场景）
    crossSessionSensitivity: false,  // 是否允许 private 跨会话召回（默认关：隐私靠不可见，不靠自觉）
    nonOwnerSeesShared: false,       // 非 owner 发言的 turn 能否召回 shared 档
  },

  domainAllowlist: {},
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：只覆盖显式给出的键，数组整体替换。 */
export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return clone(base);
  const out = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

export function loadConfig(overrides = {}) {
  const cfg = deepMerge(DEFAULTS, overrides);
  if (!cfg.storage.dbPath) cfg.storage.dbPath = path.join(cfg.storage.root, 'index.db');
  if (!cfg.security.keyDir) cfg.security.keyDir = path.join(cfg.storage.root, 'keys');
  return cfg;
}

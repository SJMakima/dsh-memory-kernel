/**
 * 设置页 UI schema 草稿（Phase 1+2 字段）与"仅配置文件可改"白名单。
 *
 * 双向一致性纪律（test/config-schema.test.js 锁死）：
 *   ① UI_SCHEMA 的每个路径必须在 DEFAULTS 里真实存在 —— 防 `intent_k` 式幽灵旋钮；
 *   ② DEFAULTS 的每个叶子必须被 UI_SCHEMA 或 CONFIG_ONLY 覆盖 —— 防"有键无 UI 且没人知道为什么"；
 *   ③ UI_SCHEMA ∩ CONFIG_ONLY 必须为空 —— 一个键不能既在表单又在白名单里。
 *
 * CONFIG_ONLY 支持 `前缀.*`（整个子树）与精确路径（该子树）两种写法，
 * 每条都必须能解析到至少一个真实叶子 —— 白名单本身也不许有幽灵键。
 */

/** 设置页暴露的字段（路径 + 展示形态；phase 仅作注释用，不做机器校验）。 */
export const UI_SCHEMA = [
  { path: 'plugin.enabled',             widget: 'toggle', label: '插件总开关（关闭后工具与钩子全部短路）' },
  { path: 'write.dailyQuotaPerDomain',  widget: 'map-number', label: '每日写入配额（按域）' },
  { path: 'write.extractModelTier',     widget: 'enum:cheap,standard', label: 'LLM 抽取档位' },
  { path: 'lifecycle.coldThreshold',    widget: 'slider:0-0.5', label: '冷存阈值（记忆保留强度）' },
  { path: 'lifecycle.coldIdleMs',       widget: 'slider-days', label: '冷存闲置天数' },
  { path: 'retrieve.memIndex.enabled',  widget: 'toggle', label: '内存向量索引（关掉回落 vec0，行为不变只是变慢）' },
  { path: 'retrieve.queryExpansion',    widget: 'toggle', label: '查询扩展（同义词典，弥补字面变体盲区）' },
  { path: 'security.rereadEnforcePenalty', widget: 'toggle', label: '回读降权（软惩罚 0.85）' },
  { path: 'trust.verifiedEnabled',      widget: 'toggle', label: 'verified 确认信号' },
];

/** 不进设置页的键：内部机制 / 调参 / 文档反对暴露的项。前缀.* 覆盖整棵子树。 */
export const CONFIG_ONLY = [
  // 存储 / 嵌入 / 路由 / 组装：纯内部机制，暴露出去只会被误改
  'storage.*', 'embedding.*', 'llm.*', 'routing.*', 'assemble.*', 'domainAllowlist', 'plugin.blockedSessions', 'retrieve.synonymGroups',   // llm.*：走设置页「LLM 接入」卡片（含密钥引用，不进通用表单）   // 查询同义词典：由设置页自定义编辑器管理   // 会话黑名单：走设置页卡片/管理 API 管理，不上通用设置页
  // write 内部：四分类阈值与 isUseful 判据是 §12.1 校准项，等 P2 真实数据定稿前不上 UI
  'write.novelty.*', 'write.attributeAliases', 'write.updateGamma', 'write.pendingTtlMs', 'write.p0aBypassRouting',   // 【冲突治理 §2.2】attributeAliases=同义折叠表（内部规范化机制）
  'write.microBatchRows', 'write.useful.*', 'write.pendingDrainLimit', 'write.patternQuotaPerDay',
  'write.confirmGate.*',   // 【R-149】确认闸门：消费口在设置页"候选确认池"面板（队列出现即感知），开关本身暂不放 UI
  // retrieve 调参：§20 明确"参数校准只能在真实数据上定稿"，UI 不给抓手
  'retrieve.rrfK', 'retrieve.recentHalfLifeMs', 'retrieve.skipVector.*', 'retrieve.minPartitionVectors',
  'retrieve.knnOversample', 'retrieve.retrievalLogTtlMs', 'retrieve.maxEmbedRpcPerRetrieval',
  'retrieve.hotPartitionWarnAt', 'retrieve.coldRankOffset', 'retrieve.coldScanWarnMs',
  'retrieve.importanceWeight',   // 【R-144】P2 校准参数，等真实数据定稿再考虑进 UI
  'lifecycle.importanceFloor',   // 【R-144】冷存豁免线
  'retrieve.routeScoreSampling', 'retrieve.defaultTopK', 'retrieve.rerank.*', 'retrieve.memIndex.maxVectors', 'retrieve.allDomains.*',
  // lifecycle 其余：衰减数学的内部参数
  'lifecycle.halfLifeDays.*', 'lifecycle.floor.*', 'lifecycle.initPersistence',
  'lifecycle.activationBonus', 'lifecycle.activationCap', 'lifecycle.maxPersistence',
  'lifecycle.activationHardCap',
  // trust 校准项（verifiedEnabled 本体在 UI，窗口/上限是 §16.2 校准参数）
  'trust.meanReversion', 'trust.lr.*', 'trust.verifiedMaxLen', 'trust.verifiedWindowMs',
  'trust.verifiedMaxPerWindow',
  // security 其余：签名域管理是 Phase 3，密钥目录永远不该出现在表单里
  'security.requireSignatureDomains', 'security.keyDir', 'security.rereadPenalty',
  'security.rereadOverRead', 'security.rereadDeadlineMs', 'security.bigramCoverageThreshold',
  // dream：步开关与触发参数是运维项（dream 按钮已覆盖手动触发），不进表单
  'dream.*',
  // 【R-108】对话流水的落盘开关与检索 topK 是机制参数（原生开启，不需要用户决策）
  'transcript.*',
  // 【R-139】内心活动与日记同上：机制参数，原生开启，不进通用表单
  'inner.*',
  'diary.*',
  'emotion.*',
  // 【R-112/R-117】隐私档位：owner 白名单与可见性开关走设置页「隐私」卡片，不进通用表单
  'privacy.*',
];

# DSH 记忆内核 · 模组服务接口契约（MODULE-CONTRACTS）

> **定位**：模组化三步走的第一步——**先立缝，不切体**。本文把现有模块的服务接口定义成显式契约，代码一行不动；将来任何模块 peel 成独立插件（cordis 服务）时，接口以本文为准， breaking change 必须改版本号。
>
> **为什么先立缝**：跨插件边界会把进程内不变量变成运行时承诺。现在一处函数调用能保证的事（写入硬序、隐私过滤先于域判定、id 一致性），拆开后全靠契约自觉——所以契约要**先于拆分**存在，并且每条都标了"违反后的症状"。
>
> **总控（kernel）的调度职责**——将来无论模块在不在一个进程里，这六件事都归它，模块不得自作主张：
> 1. **注入顺序与 token 预算**：动态段各来源（情绪参考 → 原话片段 → 当日档案 → 日记回溯 → 检索结果）的排列与 `assemble.tokenBudget` 分配；
> 2. **写入编排**：md 先落 → SQLite → 投索引 的硬序（R-40/R-82），任何模块不得绕过 write 层直接写 SQLite；
> 3. **隐私执行**：成对隐私、sensitivity 三档在**检索侧统一过滤**，模块只提供数据，不做自己的隐私判断；
> 4. **会话 → 域路由**：`domains.routeDomain` 是唯一路由点（含 R-138 注册顺序语义：精确前缀在前、恒真兜底在后）；
> 5. **LLM 通道**：所有模块共用 `llm` 路由（host/local/custom 三档），模块不得私接 API；
> 6. **失效广播**：rebuild 时逐模块调用 reset/invalidate（向量索引整层清、日记表重灌、嵌入缓存清）。

---

## 模组一：memory（记忆内核本体）

**现状**：`src/kernel.js` + `src/core/{retrieve,write,vec,transcript,inner,diary}.js`。这是最重、内部耦合最深的模组——**最后才能拆，也可能永远不拆**（写入硬序决定了它是一个器官不是一堆零件）。
> 2026-10-31 补注：候选确认池（R-149，设置页确认面板）与 context 会话准入（v4.29）已并入本模组；`update / forget` 能力面与统一 Access Gate 见 DESIGN-NEXT 架构增补提案（R-152/R-153/R-156）。

### 对外服务（现有实现即契约）

| 接口 | 签名（现实现） | 语义 | 错误行为 |
|---|---|---|---|
| `search` | `kernel.search({sessionId, query, options}) → {entries, contexts, transcripts, dayArchive, diaryHits, dynamic, domain, …}` | 四路召回 + 加权 RRF + 动态段组装，**一次调用返回全部注入材料** | 任一路失败降级为其余三路；向量路挂掉绝不阻塞 FTS |
| `remember` | `kernel.remember({domainId, text, …}) → {id, …}` | P0a 直写（跳过抽取，写入硬序 md→SQLite→索引） | 写入失败抛异常，**md 已落则库可 rebuild 补** |
| `extract` | `kernel.extract({sessionId, text?, messages?}) → {taskId, candidates, results, …}` | P0b 异步抽取 → 四分类 → 落盘；顺带产 mood（见 emotion 模组） | LLM 失败重试一次后放弃，`audit/extract-failed` 带 raw，**不崩不丢消息** |
| `appendTranscript` | `kernel.appendTranscript({sessionId, domainId?, messages}) → {written}`（async） | 原话流水纯 append，哈希幂等，即嵌向量（R-141） | 嵌入失败静默跳过，缺口 backfill 补；**FTS/主行失败即失败** |
| `appendInner` | `kernel.appendInner({sessionId, domainId?, notes}) → {written}` | 内心活动流水（第一手），同型幂等 | 同上 |
| `context` | `memory_context` 工具（entry_id + 会话准入 → 完整内容 + 原始来源） | 细节核对。**v4.29 起 entry_id 不再是授权凭据**：可信 sessionId 必填 → routeDomain → admit（成对隐私）→ 验签 | id 不存在或任一守卫不过 → **返回 null，不返回近似条目**（工具层转 found:false）；跨会话 private 条目经工具取回 = null（缺身份 ≠ 是 owner，fail-closed，v4.29） |
| `rebuild` | `kernel.rebuild(opts)` | 从 md 真相源重放全部派生层 | 广播失效（向量索引整层清、diary 重灌）；重建期间检索不可用 |

### 不变量（拆分时必须保留，违反后的症状标注）

1. **写入硬序**：md（fsync）→ SQLite → 向量/FTS。违反：断电出现"库有 md 无"的不可自愈状态。
2. **隐私先于域判定**：成对隐私过滤必须发生在 `identity_scope==='domain'` 早退**之前**（R-134 踩过）。违反：private 条目跨会话泄露。
3. **id 一致性**：凡无 `entry_id` 的数据（原话/内心/日记）一律独立段呈现，不进 RRF。违反：融合排序里 id 对不上号，`memory_context` 取回错误条目。
4. **原话/内心/情绪是流水层**：纯 append、TTL、不进真相源 md。违反：rebuild 重放被流水灌爆。
5. **脏返回 null 不返回 `[]`**（向量路 R-137）：`[]` 会被读成"没命中"，静默吃掉召回。

### 【R-152】门面四组分组（2026-10-31 v4.31 收口后的正式 API 形态）

kernel 门面收敛为四组（平铺键保留为 `@deprecated` 别名，渐进迁移）；两条铁律写死 kernel.js 文件头——**写走管线**（任何写必须过 write 层硬序 md→SQLite→索引）、**读过闸门**（任何读必须过 admit/验签，R-153 gate 是唯一强制点）：

| 组 | 成员 | 语义 |
|---|---|---|
| `kernel.memory` | search / context / remember / extract / preStep / postStep / intentOf / appendTranscript / appendInner / appendEmotionSelf / transcript / inner / emotions / diary / **write** | 检索·取回·写入·抽取·注入·流水层；write 是写管线本体（R-149 确认队列等治理动作经此） |
| `kernel.lifecycle` | init / dream / maybeDream / rebuild / **forget** / drainPending / backfillVectors / close / whenEmbeddingReady | 巩固·重建·**遗忘**·配额消化·补嵌·生命周期 |
| `kernel.domains` | get / list / route(routeDomain 别名) / register | 注册·路由·枚举（R-138 注册顺序语义不变） |
| `kernel.health` | health()（可调用，三态直调） / stats / taskBacklog / auditSummary / audit / applyConfigPatch / listIdentityForks / resolveIdentityFork / vec | 三态诊断·只读聚合·审计摘要·配置热补·向量诊断 |

**边界执法（CI 级）**：`scripts/check-facade.mjs`——适配层（src/index.js / dsh/* / bin/*）禁止 `kernel.db`、`.db.prepare`、`kernel.vecInfo`、`kernel.files`、`kernel.retrieve`、`kernel.write`；`npm test` = node --test + 本断言。适配层只读聚合统一走 `kernel.health.stats()`（src/core/stats.js）。

**新增对外服务（同属本模组契约）**：

| 接口 | 签名 | 语义 |
|---|---|---|
| `forget` | `kernel.lifecycle.forget(entryId, {confirmId, reason?}) → {forgotten, positions, tombstone}` | 【R-156】物理删除闭环：md / SQLite+FTS / 向量+内存索引 / entry_links 双侧 / 冷存 / git tombstone 六位置一次清。**confirmId 必须显式等于 entryId**（误删防护）；不做软删除回收站、不做 LLM 自动裁决、不做批量。rebuild 读 tombstone 排除——**forget 后全量 rebuild 不复活**是对"重建不丢状态"老契约的反向验收 |
| `stats` | `kernel.health.stats() → statusStats(db)` | 适配层只读聚合的唯一入口（条目/来源/类型/情绪分布/确认池/域条目数）；手写 SQL 禁止 |
| `trace` | `kernel.memory.search(...)` 返回值 `.trace` | 【R-157.4】逐条检索 Trace：candidate 级 {sources(rank+score), fused, admission.reason, finalRank} + rejected[{entryId, reason}]；敏感原文不入 trace，随 FTS optimize 周期轮转（audit `retrieval-trace` 通道同款） |

**单写者部署契约（R-159，跨进程）**：`src/storage/root-lock.js`——writer.lock（O_EXCL）+ 存活判定（保守档：进程在 = 活）+ stale 接管 + shared 只读旁路。内核 `singleWriter: true` 启用；CLI 默认开启；DSH 宿主侧待验证 cordis fiber.update 的 dispose-before-apply 顺序后再默认开启。锁文件不进 git 快照；不做锁等待队列（拒绝即报错）。

**宿主适配契约（R-158）**：`src/adapters/host-adapter.js` 是通用适配器层唯一认识宿主形态差异的文件（registerTool 判定：显式 hostToolStyle > 宿主自报 > 哨兵探测 > `.length` 兜底）；`createPlugin().manifest` 由单一生成源自动生成（tools=Object.keys(createTools)，hooks=HOOKS），带 `apiVersion: '1.0'` 与 `capabilities: ['memory.search','memory.write','memory.lifecycle','memory.health']`——**Capability ≠ Tool ≠ Provider**（R-158.5 三层区分：内核有能力 ≠ 必须注册 Agent 工具才能被用）；breaking change 必须改 API_VERSION。

---

## 模组二：emotion（情绪日志）

**现状**：`src/core/emotion.js` + `src/pure/emotion-shape.js` + 抽取协议的 `mood` 字段 + 三个消费口。**最先可拆的模组**（最新、最小、对外只有一个数据依赖：抽取顺带判定）。

### 对外服务

| 接口 | 签名（现实现） | 语义 |
|---|---|---|
| `append` | `emotions.append({sessionId, domainId, now, user, agentExpressed}) → {written}` | extract 线落库：user 判读（可带 strong）+ agent expressed（语气判定）。**采集无条件，不受 enabled 开关管** |
| `appendSelf` | `emotions.appendSelf({sessionId, domainId, emotion, note}) → {written}` | felt 第一手（memory_inner 自述）。emotion 非六档枚举拒收；**没传不写行** |
| `range` | `emotions.range(domainId, start, end) → [{ts, owner, emotion, strong, source, note}]` | 时间窗事件（已过滤 NULL）。消费口自己做形状化 |
| `curve` | `assemble.emotionCurve(domainId, nowTs) → {windowDays, user, agentExpressed, felt}` | 三轨形状化（user/agent 各走滤噪，felt 全保留）。**单轨函数，混喂两个人的情绪连成一段** |
| `stats` | `emotions.stats() → {total, byOwner, latest}` | 诊断面 |

### 四条边界（评审定稿，契约级，不可协商）

1. **不做 current_mood 状态机**：`上次判定 × 衰减` 与查日志信息等价，包装成变量只会诱导模型表演情绪。felt 的诚实来源只有自述与事后推断（后者标【推断】）。
2. **felt = NULL ≠ neutral**：NULL = 未自述，不推断、不填补。消费层统计必须过滤 NULL——把空读成"平静"是编造她的内心。
3. **expressed / felt 分列**：语气判定有自我强化循环（提示词活泼 → 判"开心" → 下轮参考 → 更活泼），只能作"表现出的"记录。
4. **开关只控消费不控采集**：`emotion.enabled=false` 三个消费口（近期参考/当日档案/日记情绪节）不注入，emotion_log 照写——A/B 对比必须在同一批数据上做。

### 拆分时的耦合点（拆前必须解决）

- **抽取顺带判定**是它的采集命脉：独立成插件后要么 emotion 插件自己跑 LLM（成本翻倍），要么总控把 extract+mood 作为一次编排任务分发给两边（推荐，协议 `{candidates, mood}` 已是对象，天然可分）；
- 三个消费口全部在总控的组装层手里：拆出去后注入权必须上交总控（见总控职责 #1）。

---

## 模组三：persona（人格）——**尚未存在，先立契再长肉**

**现状**：没有独立模块。现有雏形散在三处：GUIDE 克制/披露条款（assembly）、pattern 条目（dream 第 7 步提炼，entry_type='pattern'）、日记与内心活动（叙事性自述）。

### 设计中的服务（目标契约，实现前先评审）

| 接口 | 拟签名 | 语义 |
|---|---|---|
| `render` | `persona.render({domainId, sessionId, contextTag}) → {guide: string[], style: string}` | 输出动态段的人格条款（GUIDE 扩展）与语气基调；**只读，不写任何数据** |
| `profile` | `persona.profile({domainId, speaker}) → {patterns: entry[], tone: …}` | 按 speaker 返回其 pattern 条目（R-114 消费端的雏形） |
| `onFacts` | 事件订阅：`kernel.search`/`write.persistNewEntry` 后广播 | 消费 pattern 条目变化，不自查库 |

### 契约红线（设计时就要守住）

1. **人格只读记忆、不写记忆**——它消费 memory 的输出，不产生新条目（pattern 提炼归 dream，不归 persona）；
2. **不自评情绪**：persona 可以读 emotion.curve 调整表达分寸，但不得声称"我现在很难过"——felt 只能来自自述通道；
3. **语气的克制条款与 GUIDE 同源**：人格模块输出与 R-96/R-131 的措辞纪律必须走同一份文案源，不许两套标准。

---

## 横切面：三模组共同遵守

| 横切面 | 规则 | 出处 |
|---|---|---|
| 隐私 | 所有流水/条目按域隔离；成对隐私在检索侧统一执行；**fail-closed（v4.29）**：配 ownerIds 缺 viewer 拒绝、private/shared 缺 provenance 拒绝、includePrivate 请求参数不再是凭据；情绪数据是隐私含量最高的一档（只本域、可过期） | R-110/R-117/R-134/v4.29 |
| 生命周期 | 流水层（transcript/inner/emotion）TTL 180 天；条目衰减不删；日记/真相源永不衰减 | R-108/R-139/R-142 |
| 审计 | 一切写入/降级/失效广播走 `audit.write(channel, payload)`；失败必须可归因（R-140 的 raw 落痕） | R-40/R-140 |
| 配置 | 各模组配置分区独立（`transcript.*` / `inner.*` / `diary.*` / `emotion.*`），全部热键，判定时现读——**构造期快照 = 死开关** | R-43/R-142 |
| 死旋钮判据 | 没有消费方的开关/字段不进 UI、不进配置 | R-43/M4 |

## 拆分判据（第三步何时触发）

- **emotion 先拆**：出现"只要情绪不要记忆"的独立消费者，或第三方想接 emotion 数据 → peel 为独立插件，总控走 `{candidates, mood}` 协议分发抽取结果；
- **memory 不拆内部**：写入硬序 + id 一致性决定了 entries/vec/transcript 是一个器官；对外可以只暴露 `search/remember/context` 三个门面；
- **persona 最后**：等 R-114 风格消费端真实立项时按上面契约实现，别提前造。

## 反模式（模块化之后也不许做）

1. 模块绕过总控直接往宿主注入内容（动态段必须一处组装）；
2. 模块私接 LLM API 或私存 key；
3. 模块间直接读对方的 SQLite 表（一律走服务接口——表结构是各自实现细节）；
4. 用"运行时试建探测"代替契约版本号（R-136 的教训：探测掩盖了没验证的事实）；
5. 失败静默返回空值冒充"无数据"（`null`/`[]`/NULL 三种语义必须分清——R-137/R-142 两轮的教训）。

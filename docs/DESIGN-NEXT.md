# DSH 记忆插件 · DESIGN-NEXT（路线图：已落地索引 + 未实现清单 + 架构增补提案 + 踩坑备忘）

> 2026-10-28 大改：原设计组的落地记录迁去 CHANGELOG（v4.12~v4.17），本文件只留**仍未实现**的部分；
> 新增「踩坑备忘」一节——实现期踩过的坑按主题集中在这里，**读代码前先过一遍**，详情按标注去 CHANGELOG 查。

## 已落地迁移记录（原设计条目 → 实现位置）

| 原设计 | 落地版本 | 备注 |
|---|---|---|
| R-95~R-98 / R-108~R-110 / R-111~R-112 / R-115~R-118 | v4.14（R-131~R-135） | 情感雷达 / 对话流水 / 全域检索 / 成对隐私 / 承诺记忆 |
| M7 接入层（R-127~R-130） | v4.12 | 三档 transport + 自动抽取闸门修正 |
| **pattern 批量提炼**（原列在 M7 消费端） | **已落地** | `dream` 第 7 步 `step7PatternMining`：同簇 fact ≥ 2 且信号达标才调 LLM，独立配额 2 条/天。等 `cfg.llm.enabled` + 真实数据即出效果 |
| ANN（rescore） | **证伪** | R-136：上游无发布版 + 300 维收益为负；R-137 改做内存精确索引（v4.16） |
| 动态域管理 | v4.17（R-138） | 设置页新增/查看，运行时注册即刻生效 |

## 已落地（v4.21 追加）

- **情绪日志层（R-142）**：emotion_log 双轨（agent 拆 expressed/felt，felt 唯一第一手是 memory_inner 自述）+ 抽取顺带判定（零新增调用，对象协议 `{candidates, mood}`）+ 三个消费口（近期情绪参考带优先级句 / 当日档案紧凑序列 / 日记情绪节）。四个评审定稿边界：不做 current_mood 状态机（演情绪不是有情绪）、felt=NULL 不补 neutral、强单点例外、开关只控消费不控采集。详见 CHANGELOG v4.21。

## 已落地（v4.18 追加）

- **内心活动 + 日记层（R-139）**：inner_log 流水（`memory_inner` 工具为第一手来源，宿主消息无推理通道已核实）+ diary 六节日记（md 真相源、永不衰减、dream 第 12 步生成、日期查询触发「当日档案」、LLM 坏退模板）。详见 CHANGELOG v4.18 与 HLD §13.2.5。

## 已落地（v4.24~v4.25 追加，2026-10-29）

- **连锁记忆（§9.1 evidence_links 做活）**：extract 同批声明边 + entry_links 归一化 + expandByLinks 类型加权一跳 + dream s13 共现自长 coexist 边。详见 CHANGELOG v4.24。
- **R-120 L3 跨条目语义对账**：dream s14，近 14 天新账 × 向量近邻交 LLM 判矛盾，**只告警不清理**（audit + signal，库一条不动）。"第 7 步撞号"的坑以 s14 绕开。
- **检索演练改进**：原话泛句降权（库内频次判据）、日记向量路（searchAsync 双路 RRF）。"情绪问句路由"经核实已被 R-142 组装层 emotionCurve 覆盖，未重复建设。详见 CHANGELOG v4.25。

## 已落地（v4.27 追加，2026-10-29 深夜）

- **R-144 importance/activation 解耦**：entries.importance 轴（写入期判定 + md state 块 + 老库回填），衰减永不作用；三消费口 = 冷存豁免线 0.8（替代类型硬编码）/ confirm +0.2 / 排序调制 importanceWeight=0.1（**eval 单变量对照 +7.1%，0.15 过冲**——详见 CHANGELOG v4.27 表）。测试坑：`shouldColdArchive` 单测要给全 lifecycle 键（lazyPersistence 读 halfLifeDays/floor）。
- 对标引入四件套（R-147/148/149/144）**全部落地**。详见 CHANGELOG v4.26/v4.27。

## 已落地（v4.28 追加，2026-10-29 深夜）

- **R-63 记忆对用户可见**（HLD §8 挂账最久的产品侧缺口）：设置页「记忆检索」面板（人类可读行：信任档位/来源/日期/重要度，走同一条检索管线，档位复用 `needsTrustLabel` 同源判定——新纯函数 `readableEntry`）+ GUIDE【来源档次】条款（低信任引用要口头声明，"你可以被纠正，不可以被误信"）。详见 CHANGELOG v4.28。

## 已落地（v4.31 追加，2026-10-31 深夜）

- **架构增补提案全量收口**：R-152（Kernel API 收口四组 + check-facade 静态断言进 CI）/ R-156（forget 六位置闭环 + tombstone 防复活 + memory_forget 工具与设置页遗忘面板）/ R-157（评测三套数据集：抽取保真 7 例、冲突消解 5 例、隐私红线 12 行矩阵——`npm run eval:privacy` 红灯即 CI 失败）+ R-157.4（检索 Trace：audit retrieval-trace 通道 + result.trace 双出口）/ R-158 主交付（.1 Host Adapter 去 .length 猜测 / .2 Manifest 自动生成 / .3 apiVersion+capabilities）/ R-159（单写者锁 root-lock：CLI 默认启用，宿主侧待验证 fiber.update 释放顺序后再挂）。268/268 绿 + 门面断言过。详见 CHANGELOG v4.31。**余**：R-160（P2）、R-158.5（文档条目，随 MODULE-CONTRACTS 修订）、宿主侧 singleWriter 开关。

## 已落地（v4.30 追加，2026-10-31 深夜）

- **架构增补提案第一批**：R-153 Access Gate（单文件强制入口，两条铁律收拢 + 静态断言）/ R-154 health() 三态（+ 设置页横幅）/ R-155 任务统一视图（taskBacklog 只读聚合 + 面板）/ R-158.6 Domain ID 校验下沉（bootstrap replace:false）/ R-158.7 通用适配器 hostLlm / R-158.4 Embedder 契约。242/242 绿。详见 CHANGELOG v4.30。**余**：R-152、R-156、R-157、R-158.1~.3。

## 已落地（v4.29 追加，2026-10-31）

- **安全补丁正确集成（外审）**：context 会话准入（entry_id 不再是授权凭据，dsh 侧传宿主常量 SESSION）+ 动态段单次边界编码（修其双转义）+ 历史剥离锚定式（旧全局正则会静默吃用户正文标签——自家旧病）+ pairVisible fail-closed（includePrivate 死口删除 / ownerIds 缺 viewer 拒绝 / 缺 provenance 的 private 拒绝 + status.viewerWarning）。223/223 绿。详见 CHANGELOG v4.29。

## 仍未实现（按等什么分类）

> 本章是**等条件项**（条件不到不硬做）；主动排期项在下方「架构增补提案」（R-152~R-157），两份清单互不包含。

### 等数据的（代码就绪，没数据跑不动）

| 项 | 依赖 | 备注 |
|---|---|---|
| **R-114 风格档案消费端** | R-113 给 speaker + 真实多说话人语料 | 单人 web 会话下注入 = 把用户自己的风格复述给用户，零收益。**宁可不做，也不做没有消费者的旋钮** |
| **importanceWeight 真实数据校准** | confirmGate 在真实库跑出 confirm 数据 + 条目量 | 起步 0.1 来自合成集；真实分布的 importance 方差更大后再定稿，必要时进 UI |

### 等通道的

| 项 | 依赖 | 备注 |
|---|---|---|
| **R-113 多平台 adapter** | 各平台 bridge / 拉取通道 | 机制侧全就绪（域注册、按域隔离、transcript 按域过滤、sensitivity 三档都能直接用），且设置页已可动态新增域（R-138）。无 bridge 的平台走 R-107 外部导入灌历史 |

### 等规模的

| 项 | 触发判据 | 备注 |
|---|---|---|
| **cross-encoder 重排** | 宿主注入 reranker 模型 + 条目量足够 | `retrieve.rerank.enabled=false`。条目少时是负优化 |
| **嵌入后端 API 档** | ① 单域 > 3000 条 ② 实测 vec 路弱于 FTS 路 ③ 找到长期可用的 API | 三条凑齐再做。宿主 `dsh-llm` 是 chat 接口无 embedding 端点，只能 custom 档——每次检索把查询原文发第三方，与本地优先哲学冲突，故非首选 |
| **HNSW 旁路** | 单域百万级 | 旁路接 usearch `Index`，不是改 sqlite-vec。`exactSearch` 与 HNSW 的对照基准在 CHANGELOG v4.16 |

### 等需求的

| 项 | 触发判据 | 备注 |
|---|---|---|
| **R-161 tombstone 内容指纹防重灌（P3）** | 出现"被遗忘内容被外部导入器重新灌入"的真实误用场景 | 2026-10-31 外审数据生命周期审计的裁定：导入走 remember 且 entryId 强制 newUlid（I1），**身份**不可能复活；但被遗忘条目的**内容**可重新入库为新条目——tombstone 只存 entryId 无内容指纹，写入侧技术上无法检测。若要做：tombstone 锚点冗余 sha256(text) 指纹，remember 时比对拒绝重灌。涉及 tombstone 格式变更 + 旧锚点兼容（无指纹字段按现状放行），当前无真实触发场景，不硬做。裁定全文见 docs/INVARIANTS.md I11 |

### 对标引入（2026-10-29，来源：taoshur/dafiyu-qq-desktop 的 Memory V3/V4）

> 该项目把记忆内置在 qq-bridge 侧、召回后注入 DSH 上下文，与本插件是同一宿主位的竞争方案。只借鉴设计思想，不碰其代码（PolyForm Noncommercial）。它已自证的三条强项值得引入；它的无向量、无更新语义短板正好是我们的差异化，不追。
>
> **✅ 状态（2026-10-31）**：本节三条**已全部落地**，正式编号以 CHANGELOG 为准——候选确认池 = **R-149**（v4.26）、importance 解耦 = **R-144**（v4.27）、temporal 时间召回 = **R-147**（v4.26）；组装层冲突提示顺延为 **R-148**。原占位编号 R-143/144/145 与在册编号撞车，下文仅作历史对照，勿在新文档中引用。

**R-143 候选确认池（human-in-the-loop）**

- 现状缺口：我们的防线全是自动化的（trust + 签名 + 回读复核），**没有"用户确认"这一环**。抽取错、抽取过界（用户不愿被记的）只能事后靠删除/遗忘补救。
- 设计：抽取链上加一道置信闸门——`classifyNovelty` 走 `uncertain` 的候选、以及 `trust_posterior_logit` 低于阈值的域的新候选，**不直接 `persistNewEntry`**，改入 `confirm_candidates` 队列（复用 pending_candidates 表加 `reason` 列即可，别建新表）；确认入口挂设置页（R-138 的动态基建现成），陪伴侧体验形态是"今天我记住了这些，对吗？"的批量确认。拒绝 → 删 + audit；确认 → 走正常落盘管线。
- 依赖与边界：**confirm 队列必须有 TTL**（复用 `expire_at`），否则变成第二个幽灵堆积点；确认动作本身写一条 activation 事件（kind 复用 `reinforce`），让确认过的记忆天生比自动入库的更持久——这个不对称是有意的。
- 验收：观察模式下低置信候选零直写；确认/拒绝都有 audit 痕迹；`reconcilePending` 与 confirm 队列不互相吃单。

**R-144 importance / activation 解耦**

- 现状缺口：`persistence` 把"值不值得留"（重要性）和"容不容易想起"（活跃度）混在一根轴上——重要性隐含在 entry_type floor 里，活跃度来自激活回报，衰减又同时作用两者。对方项目三轴独立（confidence/importance/activation）的拆法是对的。
- 设计：`entries` 增加 `importance REAL`（写入期判定：boundary/skill=1.0，含身份三元组的 fact 抬档，其余默认 0.5；**写进 md state 块**，否则 rebuild 即丢，R-88 纪律）。生命周期改双轴：`activation` 沿用现有衰减+激活回报公式（就是现在的 persistence 语义），`importance` 只做三件事——冷存豁免线（importance ≥ 0.8 不归档，替代现在"boundary/skill 豁免"的硬编码）、confirm 加成（R-143 确认过的 +0.2）、排序里的独立调制项（进 `score` 公式，权重 P2 校准）。**衰减只作用于 activation，永不作用于 importance**。
- 依赖：动排序公式 = 必须重跑 `npm run eval` 全套敏感度；旧库迁移用 `ensureColumns` 补列 + 按 entry_type 回填默认值。
- 防坑：别把 importance 做成可写旋钮暴露给抽取 LLM——让它自报重要性等于把幻觉洗成权重（同 C12）。

**R-145 时间范围召回意图**

- 现状缺口：只有 recent 窗口（与 query 无关的先验）和 include_cold 运维路。"上周说的那个事""前天你答应我什么"这类**显式时间限定**问题没有专用通道，全靠 FTS 词面撞运气。
- 设计：`classifyIntent` 增加第四档 `temporal`（判定顺序插在 relational 之后、explanatory 之前——"上周为什么吵架"同时含时间词和因果词时，宁可多召回也不丢时间过滤）；复用 `dayparse` 扩展成 range 解析（上周/N 天前/月初，已有"月份无年份归去年"的先例）；PLANS.temporal 在 recent 路之外增加 `observed_at BETWEEN` 硬过滤通道，时间范围内不足 k 时**放宽而不是清空**（同路径 B"按实有量给"的纪律）。
- 依赖：dayparse 扩展 + entries 的 `idx_observed` 已存在，无新表。
- 防坑：temporal 判据只认**显式时间词**，"后来那次""上次说的"不算——那是 relational 的活，抢过来会把 R-58 的判定顺序搅浑。

## 架构增补提案（2026-10-31 定稿，两轮外部评审收敛；编号自 R-152 起）

> **编号说明**：提案原文按 R-146~R-151 排，但该区段已被 v4.21~v4.27 用去（R-143~R-149 在册），顺延为 R-152 起，各条标注原编号。
> **已落地先声**：Access Gate 的两条铁律（includePrivate 死口删除、context(entryId) 准入）已于 **v4.29 兑现**；R-144 importance 已于 v4.27 落地——相关条目只写增量，不重复立项。
> **基线**：v4.31，268/268 测试绿 + 门面边界断言过（2026-10-31）。动 kernel.js 前以该基线为准。

### WP-1 边界与权限治理（P0）

**R-152 Kernel API 收口**（原提案 R-146）——**✅ 已落地 v4.31**

| 栏 | 内容 |
|---|---|
| 现状 | kernel 门面 40+ 方法平铺暴露，能力面没有分组；MODULE-CONTRACTS 只立了契约没立闸门，内部各模块直达 db 的路径没有断言约束 |
| 目标 | 对外能力面收敛为四组：**memory**（search/context/remember/extract/transcript/inner）、**lifecycle**（dream/rebuild/forget）、**domains**（注册/路由/枚举）、**health**（状态/审计摘要）。铁律：**写走管线**（任何写必须过 write 层硬序 md→SQLite→索引）、**读过闸门**（任何读必须过 admit/验签） |
| 修改文件 | src/kernel.js（门面分组导出）、src/index.js 与 dsh/lib-index.js（消费面切换）、MODULE-CONTRACTS.md（契约同步）、test（边界断言） |
| 验收 | 门面之外无直达 db 的调用路径（grep/静态断言进 CI）；四组各配边界测试；全量绿 |
| 不做事项 | **不引事件总线**（内部依赖保持显式函数调用）；不做进程/RPC 拆分；不改任何内部实现语义——这是收口不是重构 |

**R-153 Access Gate 单文件强制入口**（原提案 R-147）——**✅ 已落地 v4.30**

| 栏 | 内容 |
|---|---|
| 现状 | v4.29 已兑现两条铁律的语义（includePrivate 死口删除、context 准入守卫链），但规则散在 retrieve.pairVisible 与 kernel.context 两处，没有单一强制点，新读路径仍可能忘记过闸 |
| 目标 | 新建 src/core/access-gate.js 单文件强制入口：全部读路径（entries 检索 / context / transcript / diary / inner 查询）统一过闸，两条铁律写死在文件头——①`includePrivate` 自报不是凭据；②`context(entryId)` 不许绕过准入。pairVisible 逻辑原样迁入 |
| 修改文件 | 新 src/core/access-gate.js；src/core/retrieve.js（迁出 pairVisible）；src/kernel.js（接线）；v4.29 对抗测试迁移到 gate 名下 |
| 验收 | 静态断言无绕过 gate 的读路径；v4.29 对抗测试原样通过；迁移后全量绿 |
| 不做事项 | 不做 RBAC/策略引擎；不改 privacy 配置面；不引入每查询额外开销（gate 是函数调用不是中间层） |

### WP-2 运行状态与任务治理（P1）

**R-154 health() 三态**（原提案 R-148）——**✅ 已落地 v4.30**

| 栏 | 内容 |
|---|---|
| 现状 | status() 返回 20+ 字段诊断面，但没有"一句话结论"——embReady、索引脏域、LLM 可用性、confirm 队列各自为政，Agent 和用户都得自己拼装判断 |
| 目标 | health() 返回 **READY / DEGRADED / FAILED** 三态 + 原因数组；**纯查现算不缓存**；数据源全部复用现有字段（vec 就绪、memIndex 脏域、LLM 探针、db 完整性），不新增采集。两个消费口：web 设置页顶部 + memory_status 工具返回 |
| 修改文件 | src/kernel.js（health 聚合）、dsh/lib-index.js（status 接线）、dsh/client.js（StatusPanel 顶部横幅）、test |
| 验收 | 三态各有触发测试（kill embedding worker → DEGRADED；库锁死 → FAILED；全绿 → READY）；面板显示与实际状态一致 |
| 不做事项 | 不做自愈/自动重启；不做指标历史曲线（audit tail 已有）；不接外部监控外呼 |

**R-155 任务统一视图**（原提案 R-149）——**✅ 已落地 v4.30**

| 栏 | 内容 |
|---|---|
| 现状 | 四类任务性质的积压各自为政：pending_candidates（待定/确认双用途）、embedding_pending（补嵌扫）、retrieval_log TTL 清理、audit 尾巴——没有"现在压着什么"的单一视图，巡检靠手敲 SQL |
| 目标 | **只读聚合**：设置页一张"任务面板" + 一个聚合查询，列四类积压量与最老条目年龄。**通用 Job Queue 明确不做**——触发条件：任务积压实测拖垮检索 P95（>500ms 目标 2 倍且持续一周）再议 |
| 修改文件 | dsh/lib-index.js（聚合查询）、dsh/client.js（面板）、test |
| 验收 | 面板数字与 SQL 直查一致；空态显示"无积压"不报错 |
| 不做事项 | 不做 Job Queue/Worker 重写；不改四表写入语义；不做自动重试策略变更 |

### WP-3 Evidence 与记忆治理（P1，与已落地的 R-144 importance 对接）

**R-156 修正/取代/遗忘三语义闭环**（原提案 R-150；**全提案最重**）——**✅ 已落地 v4.31**

| 栏 | 内容 |
|---|---|
| 现状 | 修正（update）与取代（supersede）语义完整（冲突治理 §1.2 + md 变迁折叠注）；**遗忘没有闭环**——删当前文件后 SQLite+FTS、向量+内存索引、entry_links、冷存、Git 历史五处残留。"删库重建复活"正是老契约"重建不丢状态"的反面用 |
| 目标 | forget(entryId) 单入口**物理删除闭环**，六个位置一次清：①md 块（真相源重写 part 文件）②SQLite 行 + FTS 热冷表 ③向量行 + 内存索引同步（swap-remove 连 id→下标 Map，漏 Map 就是串位事故）④entry_links 双侧 ⑤冷存目录 ⑥**git tombstone**（提交一条删除记录：历史可追溯但不复活）。全程 accept/audit 留痕 |
| 修改文件 | 新 src/core/forget.js（或并入 write.js）、src/core/rebuild.js（tombstone 感知）、dsh/lib-index.js + dsh/client.js（memory_forget 工具 + 设置页入口）、test |
| 验收 | **forget 后全量 rebuild 不复活**（对"删库重建状态不丢"老契约的反向验收）；六位置逐一 SQL/fs 断言；tombstone 在 git log 可查；误删防护（要求二次确认参数） |
| 不做事项 | 不做软删除回收站（tombstone 即是）；**不做 LLM 自动裁决删什么**（裁决权在人，R-120 同族红线）；不碰 R-149 确认池语义；不做批量遗忘（先单条跑稳） |

**R-157 评测扩展：抽取/冲突/隐私三套数据集**（原提案 R-151）——**✅ 已落地 v4.31**

| 栏 | 内容 |
|---|---|
| 现状 | eval/ 只有一套合成检索评测（NDCG/MRR/Recall，importanceWeight 校准用过）；抽取保真、冲突消解、隐私边界全靠散装单测，没有回归基线 |
| 目标 | 三套小型数据集进 eval：①**抽取保真**（原文 → 期望 candidates）②**冲突消解**（矛盾对 → 期望 relation）③**隐私红线**（跨会话 private 泄漏矩阵）——隐私集任何一项红灯 **CI 直接失败**（exit code 非 0），与 v4.29 对抗测试合流成 Security Suite |
| 修改文件 | eval/（数据集 + runner 扩展）、test/（对齐）、package.json（eval:privacy 快跑口） |
| 验收 | npm run eval 三套全出报告；隐私集红灯时命令失败；报告进 CHANGELOG 可对照历史 |
| 不做事项 | 不追大规模语料（50~100 条够校准，P2 纪律）；不做网格搜索（单参数扫描）；不接外部 benchmark |

**R-157.4 检索 Trace**（2026-10-31 第外审增量）——**✅ 已落地 v4.31**

| 栏 | 内容 |
|---|---|
| 现状 | `retrieval_log` 仅 `request_id + entry_ids`（§13.4 共现挖边的消费方，非解释用）；逐条分数与准入原因无处可查——admit 拒绝理由散在 audit（`signatureFailure` 等）里，拼不回单次请求；"为什么召回它 / 为什么拒绝它 / 低可信为何排前面"目前答不上 |
| 目标 | 逐条 Trace 挂在现有 audit 通道下：candidate 级 `{sources, fts/vector/rrf 分数, admission.reason, finalRank}` + `rejected[{entryId, reason}]`；eval 失败可下钻定位到具体检索阶段（候选生成 vs 过滤 vs 排序）；**敏感原文不入 trace**，trace 有保留期限（随 FTS optimize 周期清理即可） |
| 修改文件 | src/core/retrieve.js（埋点）、src/storage/audit.js（trace 通道）、eval/（下钻视图） |
| 验收 | 任选一次检索请求可完整还原：每条终选记忆来自哪些通道、各通道分数、准入通过/拒绝原因；eval 红灯时能输出"失败发生在哪一层" |
| 不做事项 | 不做独立 trace 存储引擎；不改检索算法本身（先可解释，后优化）；不实时外发 |

### 暂缓登记（各自触发条件，不排期）

| 项 | 触发条件 |
|---|---|
| 事件总线 | 模组拆分实际发生（emotion peel 立项）且模块间调用点 > 6 处需要解耦时 |
| Index Worker 独立进程 | 检索 P95 被索引重灌拖垮（实测数据，非预估） |
| Persona 模组 | R-114 多说话人真实语料到位（目标契约已在 MODULE-CONTRACTS 备好） |

> 战略共识（Trust / Reasoning / Governance 闭环是壁垒）不单独成节——它与 R-149 确认池、R-120 对账、R-153 gate、R-156 遗忘闭环本就是同一条线，写进提案反而稀释。

### R-158 工具生态与宿主适配契约（2026-10-31 立项，第外审收敛；与 R-152 关联不合并）——**✅ 全部落地（.4/.6/.7 @ v4.30；.1/.2/.3 @ v4.31）**

> **定位**：R-152 管内核边界与权限治理，本条管**外部怎么接**——两件事不要合成一个大改造。外审中的两个误判已纠正并记档：`memory_inner` 系统级缺失**不成立**（生产入口 `dsh/lib-index.js` 已注册并联动 R-142 felt 写入，仅通用测试适配器没有）；`ctx.llm` 未传递**非生产故障**（dsh 路径 `hostLlm: llmService` 早已接线）。另核实：`routeDomain` 多命中已有 `domain-ambiguous` 审计；重复 Domain ID 覆盖是 `domains-dynamic.test.js` 钉死的**已定义行为**，不是漏洞。

**主交付（P1）**

| 编号 | 事项 | 要点 |
|---|---|---|
| R-158.1 | **Host Adapter** | 消除 `ctx.registerTool.length >= 3` 的参数个数猜测（包装函数 / rest 参数都能改变 `.length`）；统一 `createHostAdapter(ctx)` 处理宿主 API 形态差异，与 `docs/host-compat-matrix.md` 的 claimed/verified 矩阵对齐 |
| R-158.2 | **Manifest 自动生成** | `manifest.tools = Object.keys(createTools(kernel))`，钩子清单同法——清单漂移（声明了没注册 / 注册了没声明 / 文档说了代码没有）从结构上消失 |
| R-158.3 | **apiVersion + capabilities** | `{ name, apiVersion: '1.0', capabilities: ['memory.search', …] }`——MODULE-CONTRACTS"breaking change 必须改版本号"承诺的落地；内部实现重构只要公共接口兼容，外部插件不跟升 |

**配套小项（P1/P2）**

| 编号 | 事项 | 要点 |
|---|---|---|
| R-158.4 | Embedder 契约 | 统一 `dim / embed(texts) / close() / health()` + 错误语义（整体异常全 null 不抛，同 v4.24 纪律）+ 模型版本与 `model_meta.dim` 一致性声明。成本极低，现在立不违反 R-114 |
| R-158.5 | 双适配器能力矩阵 | 进 MODULE-CONTRACTS：**Capability / Tool / Provider 三层区分**（如 `memory.inner.append` 是能力、`memory_inner` 是工具、DSH 生产适配器是提供者）——内核有能力 ≠ 必须注册 Agent 工具才能被用 |
| R-158.6 | Domain ID 校验下沉 | 提取共享 `validateDomainId(id)`（沿用 R-138 管理入口正则 `^[a-zA-Z][a-zA-Z0-9_-]{0,31}$`），`defineDomain()`（现位于 `local-archive.js`）与 Registry `register()` 双入口复用；重复 ID 保留 Registry 覆盖语义，上层注册 API 显式 `replace: true` 防无意覆盖；`routeDomain` 既有 `hits[0]` + 歧义审计**不动**（R-138 既定语义） |
| R-158.7 | 通用适配器 hostLlm 注入 | `src/index.js:286` 补 `hostLlm: options.hostLlm ?? ctx.llm`（P2，一行 + 一条"宿主 LLM 正确传入"测试）；生产路径不动 |

**验收**：Host Adapter 后 `src/index.js` 无 `.length` 猜测；manifest 与实际注册表由单一生成源断言相等；capabilities 枚举进测试；双入口 domain id 非法值同拒；全量绿。

**不做事项**：动态工具市场 / 动态 Capability 注册 / 事件总线（R-114 纪律，等消费者）；不推翻 R-138 路由顺序语义；不把通用适配器补齐成生产适配器的镜像（两套入口的分层是有意的，用能力矩阵说明而不是抹平）。

## 第外审收敛（2026-10-31）：R-159 / R-160 立项与处置记录

> **定位**：初稿评审把三项"已建成"当缺口（写入一致性 P0 / Config Schema / Backpressure），经代码核实全部驳回；收敛后剩余两项真缺口立项、两项并入既有条目。**外审四问硬门槛（此后所有架构建议适用）**：①当前代码是否已实现？②是否已有 R 编号或验收测试覆盖？③现有机制的真实边界在哪？④解决的是实际缺口还是重复建设？——四问答不出真实缺口，不立项、不建新模块。

### 处置记录（八项逐一核码）

| 原建议 | 处置 | 核码依据 |
|---|---|---|
| 写入一致性 P0（五态状态机） | **不采纳** | `embedding_pending` 标记 + 启动预热后自动补嵌（kernel.js:179，3 趟重扫）+ 全量 rebuild 已覆盖其虚构故障场景；五态是拿分布式事务的药方治一个布尔标记的病。启动对账检查留作 P2 增量 |
| Config Schema 体系 | **不新建** | `config-schema.js` + `test/config-schema.test.js` 双向一致性已锁死；启动期 `validateConfig()` 小补可并入 R-158 收口时顺手做 |
| Backpressure 资源预算 | **不新建** | tokenBudget 三段（guide/stable/dynamic）+ `budgetOverflow` 审计 + 每日配额 + `dreamInFlight` 并发闸已覆盖 |
| 数据流专项审查 | **已完成** | HLD-v5 生成时的勘察代理已覆盖 write/retrieve/kernel 真实数据流 |
| 检索 Trace | **并入 R-157.4** | 见上 |
| 生命周期状态机 | **并入 R-156** | `cold` / `superseded_by` / tasks.status 字段已存在；revoked/deleted 语义即 R-156 本体，状态机框架作为 R-156 实现形态备选 |
| 单写者部署契约 | **R-159 立项** | 真缺口，外审首提 |
| Migration 机制 | **R-160 立项（P2）** | 真缺口但需收窄（见下） |

### R-159 单写者部署契约（P1）——**✅ 已落地 v4.31（CLI 侧；宿主侧待验证）**

| 栏 | 内容 |
|---|---|
| 现状 | `lock.js` 是进程内 Promise 链锁（文件路径粒度，C6 单进程成立），**跨进程为零**（grep 证实无 lockfile/flock/O_EXCL）；而 `bin/dsh-memory.js` CLI 与 DSH 宿主操作同一 Memory Root 是真实场景——两个进程各持自己的 Promise 链，互相不知道对方在写，md 分片可被交叉覆盖 |
| 目标 | 最小单写者契约：①Memory Root 锁文件（`O_EXCL` 原子创建）内容 `{rootId, pid, processStartTime, instanceId, acquiredAt, kernelVersion}`；②Kernel 与 CLI 启动时获取，检测到锁时验证持有者存活（**processStartTime 比对，不只 PID——PID 会复用**）；③stale 锁判定后可安全接管；④正常关闭释放；⑤只读访问并行允许，写入动作（含 rebuild/forget）必须持锁 |
| 修改文件 | 新 src/storage/root-lock.js、src/kernel.js（启动接线）、bin/dsh-memory.js、test |
| 验收 | 双进程并发写测试：第二实例拒绝写入并明确报错；kill -9 后 stale 锁可被接管且数据无损；锁文件残留不影响只读检索 |
| 不做事项 | 不做跨进程分布式锁 / 多主写入 / 分布式事务（C6 红线）；锁文件不进 git 快照；不做锁等待队列（拒绝即报错，重试是人点的事） |

### R-160 迁移机制（P2，范围比原建议收窄）

| 栏 | 内容 |
|---|---|
| 现状 | 全库无 `user_version` / 迁移注册表。但**SQLite 是派生层**，schema 变更走 rebuild 即可，in-place 迁移基本无害；**HMAC 的 `signature_key_id` 字段已存在**（security.js:58 验签按 key_id 取钥），密钥缺口只剩**轮换流程**：旧密钥登记、只读验签、重签进度；md 格式变更目前靠手动改 + rebuild，无版本号无幂等保障 |
| 目标 | 轻量迁移注册表两类：①**Key Migration**——key_version 登记、当前密钥签名 / 旧密钥只读验签、后台重签带进度与断点恢复；②**Memory Migration**——md 格式版本号、迁移前快照（复用 git 快照）、幂等重跑、迁移后验证（rebuild 对账）。SQLite 结构变更**明确不走迁移**，继续 rebuild |
| 修改文件 | src/core/security.js（key registry）、新 src/core/migrate.js、src/core/rebuild.js（对账复用） |
| 验收 | 密钥轮换后：旧条目验签不炸（只读期降级可见）、重签完成率可查询且终态 100%；md 格式迁移在快照上重跑两次结果一致 |
| 不做事项 | 不做通用 Migration Framework；不做 SQLite in-place DDL 迁移；不做自动迁移（默认手动触发，人是操作者） |

### 下版排期建议（第外审后收敛）

**（2026-10-31 v4.31 后已全部完成，本段留档）** 原排期：R-152 → R-153 → R-156 → R-157（含 .4）→ R-158 → R-159；R-160 登记 P2 随密钥需求触发。剩余待办只剩：R-160（P2）、R-158.5 能力矩阵写入 MODULE-CONTRACTS、宿主侧 singleWriter 开关验证、R-114/importanceWeight 真实数据校准（等数据）。

**（2026-11-01 v4.31.10 追记：外审路线阶段 1~4 全部闭环）** 阶段 1（R-159 生命周期审计）经逐条核对已闭环（其 8 条清单与 r159 测试一一对应）；阶段 2（数据生命周期审计）= v4.31.9.2，新增 INVARIANTS.md（I1~I12）+ R-161 立项（等需求）；阶段 3（故障注入）= v4.31.10，test/fault-injection.test.js 9 用例，修复两个真缺口（rebuild 并发写映射撕裂 I8 / openDatabase 失败锁残留 I10）；阶段 4（发布门禁 + API 边界审计）= v4.31.10，`npm run verify:release` 门禁（skipped/todo 拒绝 + 包完整性比对）+ INVARIANTS 附录 A 三层 API 权限矩阵。当前在册待办：R-160（P2 等密钥需求）、R-161（P3 等误用场景）、R-114/importanceWeight（等数据）。

**（2026-11-03 v4.31.19 追记：人工深读评审三 bug 修复 + 遗留登记）** 三个真 bug 当下修复：①跨月冷存 forget md 残留（dream 用归档月 snapshotTs、forget 兜底用 recorded_at，跨月必错位——候选月排序 last_decay_at→recorded_at→persistence_at_decay + 整冷区目录兜底扫描）②rebuild 向量清零（parseEntryBlock 不产 embedding_pending → 热区重灌后默认 pending=1、vec 批次成功逐条清 0，模型不可用时补嵌扫描可兜底）③remember 缺 sourceRef/provenance 深层 TypeError → 入口可读参数错误。verify:release 门禁加 --test-concurrency=1 防并发抖动（phase1 墙钟断言/root-lock 用例随机红）。

**R-162（P2 · 人工评审小坑清单，随下次触碰对应模块时顺手修）**：冷热双 FTS 计数口径、GROUP_CONCAT 逗号冒号分隔符、日记进程本地时区 vs quota 配置时区、confirmApprove 配额满仍返回 ok、transcript.prune 漏删向量、open-folder 拼 shell 命令（注入面）、两处排查期 console.error 清理。复现探针原在评审环境 review/probes/。

**R-163（P2 · 性能优化，带实测数据，等画像再动）**：①assemble() 每轮全域条目 JSON.parse（5000 条 5.2ms/轮、20000 条 19ms，同步阻塞；缓存只省了 audit 一行）——加条目级缓存或增量装配；②dream 第 2 步 N+1（5000 条 64ms → 单条聚合 SQL 0.4ms）。另有七条带数据优化建议在评审报告。

**（2026-11-01 v4.31.11 追记：R-159.1 锁生命周期收口）** 外审三项 P1 全修：①锁前 root 写操作归零（git init/.gitignore 挪锁后）②createKernel 全构造段统一异常清理（此前只护 openDatabase 一步）③closeKernel 分阶段清理+幂等+锁释放保底；宿主 apply 失败改完整 kernel.close；Cordis fiber.update 复现脚本固化（test/cordis-fiber-replay.mjs，事件流水证据）+ 故障注入 +3（构造段早期/中期失败→锁不残留）。R-159 全路径闭环，评审验收标准达成。

## 踩坑备忘（读代码前先过一遍）

### ⚠ 检索语义盲区：FTS 只认字面（R-141 的由来，2026-10-28 实录）

用户问「我给你发了句**歌词**吗」，原话是「我不难过只是为什么~」——**"歌词"二字不在原话里，FTS 永远捞不到**。当时 AI 的回答是"记忆库里没有"（诚实但错误），最后是**绕过记忆库、直接翻宿主的会话存储文件**（zstd 解压）才找到的。这条路的代价：绕开了配额、隐私过滤、TTL，不该当常规手段。

**修复（R-141，v4.20）**：原话向量化——`transcript_vec`（vec0，TEXT 主键，同维同度量）+ 检索双路融合（FTS + 向量，RRF 名次合并）。**心法：任何"只按字面/只按一种信号"的检索都有语义盲区；日期盲区（R-139 的 dayparse）和词面盲区（R-141）是同一家族，出现第三种盲区先想"哪种信号没被索引"。**


> 每条都是**静默失败**或"看起来跑过其实没有"级别的——详情见标注的 CHANGELOG 版本。

### 心智模型：静默失败家族（最高优先级）

这个项目反复出现的同款事故：**代码在跑、不报错、结果悄悄是错的**。每次改动后问自己："它坏的时候，我怎么知道？"

- R-122：小分区走全表 KNN → 恒返回 `[]`，被 synthetic 构造掩盖（v4.13）
- R-127：`agent/pre-step` 判 `cfg.extractEnabled`——**这个键从未存在**，自动抽取静默空转（v4.12）
- R-137：内存索引脏了若返回 `[]` 会被上层读成"向量路没命中"（v4.16）
- R-138：动态域注册在 dsh 兜底之后 → 数据静默全进 dsh（v4.17）
- R-131：`upsertEntryRow` 少一个 named param → rebuild 整个炸掉（v4.14）

### 向量与索引（v4.16）

- **搬 BLOB 比算余弦贵 7 倍**（2 万条 300 维：读 283ms vs 算 8ms）——索引必须常驻内存，别每次查询回 SQLite 搬
- `exactSearch(..., 'cos')` 返回 `1-cos_sim`，`keys` 是 **BigUint64 行号**；与 `score = 1 - distance` 同构
- **16 维下内存索引反而更慢**（1.54ms vs vec0 0.65ms）——维度是这类优化的胜负手，评测固定用真实 300 维
- swap-remove **必须同步改 `id→下标` Map**，漏了 = 删中间一条、其余全部串位，查 A 返回 B 且不报错
- 空域**不建索引**：留空 state 后 upsert 会增量写入，而索引缺全部历史 → 召回静默变少
- `memIndex.enabled` 必须每次现读配置——构造期快照 = 点了没反应的死旋钮（R-43）
- 脏域重灌 2 次仍失败就熔断回 vec0，否则每次查询重读全表 BLOB，比不开还慢
- `rescore integer` 列**能建表但不是 ANN 索引**（普通元数据列，`INSERT rowid` 直接报错）——只看"能建表"就以为支持会踩坑
- HNSW 召回极度依赖数据分布：聚类 88%、**随机均匀 11%**——等距数据没有"近邻"结构，且恶化不报错
- 本机 SQLite 没有 `generate_series`——旧 annEval 里整段 SQL 因 `if (!canAnn) return` **从未执行过**。"能编译、能加载、报告里有那一节"≠"跑过"

### 路由与域（v4.17）

- **注册顺序是语义**：`routeDomain` 多命中取先注册者，恒真兜底域必须排最后
- `defineDomain` 默认 `matchSessionId` 只认 `id:` 前缀（`split(':')[0] === id`），不做子串匹配
- 域 id 会直接成为文件夹名 / sessionId 前缀 / 配额键 / 分区名——命名放宽字符就是把注入面引进文件系统

### 配置与 LLM（v4.12）

- **restart 类补丁根本不进活 cfg**——"保存后按 cfg 自测"测的永远是旧值，自测要用请求草稿
- 宿主消息 `content` 必须是数组（`[{type:'text',text}]`），纯字符串时流里零文本且 `reason.kind='error'`
- provider 列表要 merge `listConfigurableProviders()` + `listProviders()`（后者才有数据）
- 宿主通道 headless 下没有 `ctx.llm` → 该档**调用即报错，绝不静默降级**到 custom
- 宿主 `dsh-llm` 是 chat 接口，**没有 embedding 端点**——别指望开了 LLM 就有语义嵌入

### 存储与真相源（v4.13/v4.14）

- **新字段必须进真相源 md**（R-88/R-131）："内存里有、md 没有"的字段 rebuild 即丢
- rebuild 从 md 拼回的 Entry 不认识新列 → `upsertEntryRow` 必须兜底，少一个 named param 就是 `Missing named parameter` 炸掉重建
- FTS5 多 token 是**隐式 AND**，自然问句要显式 `OR`（`shouldSkipVectorChannel` 里的 AND 是故意的，语义不同）
- FTS 虚拟表无外键级联：删主行前必须先删索引行
- transcript 幂等靠内容哈希，且哈希前**必须剥掉 `<memory_context>` 注入块**，否则同一条消息每轮都是"新消息"
- `entries_vec` 不支持 `INSERT OR REPLACE`：必须 DELETE + INSERT

### 检索正确性（v4.13/v4.14）

- 成对隐私判定**必须放在域判定之前**：`identity_scope='domain'` 早退会直接按域放行（R-117 缺口）
- γ 从侧门吃掉 floor 豁免：`∞` 半衰期分支直接 `max(p, floor)`，**不除 γ**（R-123）
- 含空格英文主体查询用 `collapseWs`，与 `subjectKey` 同源（R-124）
- 全域检索**不去掉 SQL 的 `domain_id = ?`**：词表/向量分区/三元组索引都按域组织，去掉过滤是串味不是全局（R-133）
- 隐私 owner 白名单没配时**不猜**说话人——猜错就是泄露（R-134）

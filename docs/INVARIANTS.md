# DSH Kernel 安全不变量清单（INVARIANTS）

> **定位**：本文件是内核的数据安全契约基线，由 外审建议立项（从"追着 F-xx/R-xxx 打地鼠"转向"系统性可靠性验证"）。每条不变量 = 一句可判定的断言 + 实现锚点 + 钉住它的测试。**此后任何改动（含重构）合入前对照本清单逐条自查；改到某条的实现时，对应测试必须仍绿或按新语义显式修订本条。**
>
> 新增不变量的准入：必须有明确的安全理由 + 可自动化验证的判定方式 + 至少一个测试锚点，三者齐才进清单。已裁定的设计边界（"不做"）也记在案，防止后人当缺口反复重查。

## I1 身份唯一且不可注入

**断言**：entryId 全库唯一，由内核 `newUlid()` 生成；任何 API 调用方（含导入器）都不能指定或影响 entryId。
**锚点**：`src/core/entry.js` buildEntry `id: newUlid(t)`；`src/pure/normalize.js` newUlid（26 位 Crockford）。
**测试**：r159 结构校验（锁记录里的 ID 语义）；r156 用例全部使用 `newUlid()` 真值（Crockford 表无 U/I/L/O）。

## I2 已遗忘的条目永不通过 rebuild 复活

**断言**：任何 entryId 一旦进入 tombstone，后续 rebuild（含 clean 全量重建）必须排除该条目——即使它从备份/快照/改名回到 md。
**锚点**：`src/core/forget.js` readTombstones（唯一实现）；`src/core/rebuild.js` 扫描过滤 `alive = list.filter((e) => !tombstoned.has(e.id))`，且扫描范围覆盖 `domains` + `cold` 两棵树（`src/storage/md.js` listMarkdownFiles）。
**测试**：r156「验收核心：forget 后全量 rebuild 不复活（含冷存条目）」；r156「端到端复活」系列。

## I3 遗忘六位置闭环

**断言**：forget(entryId, {confirmId}) 必须一次清六位置——① md 块（热+冷）② SQLite entries+FTS ③ 向量+内存索引 ④ entry_links ⑤ 冷存（md 块删除已覆盖 + files 行）⑥ git tombstone 锚点（前置写入 + fsync）。
**锚点**：`src/core/forget.js` forget 主流程（六位置顺序：tombstone 锚点第⓪步先行）。
**测试**：r156 四态表、六位置逐一断言（`coldFile`、`entries_fts_cold` 计数归零等）。

## I4 同一数据目录最多一个有效写入者

**断言**：同一 root 同时最多一个进程持有 writer.lock；半写/不可解析锁一律 fail-closed（无论多老，不自动接管——持锁进程可能只是被暂停）；可解析且持有者已死的 stale 锁通过 rename 原子交接接管，交接绝不删掉对方的新锁。
**锚点**：`src/storage/root-lock.js`（O_EXCL 创建 + validLockRecord 结构校验 + stale-taken-over rename 交接）；kernel 拿锁在 openDatabase 之前（不留"已开库无归属"句柄）。
**测试**：r159 模块层全部用例（半写竞态 ×3、坏锁清抢、并发接管 Promise.allSettled、结构校验）；真机验证 audit root-lock.log（pid 16516→27912，v4.31.9）。

## I5 失败的 rebuild 不破坏原有有效数据

**断言**：rebuild 在**清任何表之前**完成全部危险检查——tombstone fatal corrupt（身份冲突/无法恢复 ID）抛错中止，此时 SQLite 原数据完好。
**锚点**：`src/core/rebuild.js` `fatalCorrupt` 检查位于 `DELETE FROM ...` 之前。
**测试**：r156 F-09「冲突：rebuild rejects + SQLite 行数中止前后不变」；「F-08 六坏形态直接 rebuild fail-closed + 行数不变」。

## I6 shared 只读旁路不可写

**断言**：`singleWriter === 'shared'` 且未持锁的实例：读全放行；一切写动作（write/rebuild/forget/dream）明确抛错，绝不静默降级。
**锚点**：`src/kernel.js` requireWriter()——写入口五处拦截；锁探测 acquired=false 时 writerLock 置 null。
**测试**：r159「只读旁路可并行打开（读检索不受锁影响）」+「只读旁路写动作明确报错，不静默降级」；r159 模块层「allowShared 探测」「shared 只读旁路同样按活锁处理」。

## I7 身份双来源必须一致

**断言**：tombstone 锚点的 JSON entryId 与文件名恢复 ID 是两个独立来源——两边都在且不一致 = 身份冲突 = fatal，rebuild 中止；任一来源非法（非 ULID）不作锚点；文件名是唯一来源时信任文件名。
**锚点**：`src/core/forget.js` readTombstones（ULID_RE 校验 + fatal 标志）。
**测试**：r156 F-09 三条（一致基线 / 冲突中止 / 非法 entryId 走文件名恢复）+「唯一来源信任」。

## I8 不完整状态不得被误判为正常

**断言**：半写锁 fail-closed（I4）；tombstone 文件名残片/非 ULID 一律不恢复 ID → rebuild 中止（I7）；md 写入走临时文件+原子替换；坏 JSON 不静默吞（corrupt 清单留痕）。
**锚点**：`src/core/forget.js` recoverEntryIdFromName 两步解析（时间戳前缀 + 扩展名链剥离 + ULID_RE）；`src/storage/files.js` 原子写。
**测试**：r156 十二形态矩阵（六坏全 null）、真 ULID 改名双坏、F-08 矩阵回归。

## I9 身份信任只来自宿主

**断言**：会话身份只信宿主注入的 ctx；`ctx.sessionId ?? args.domain` 类参数回退全废；无身份时写空出身、读 null（往隐私安全侧失败）；`trustSessionArgs` 是唯一显式逃生口。
**锚点**：`src/index.js` 三处回退废除 + createTools 签名。
**测试**：identity-trust 4 用例（伪造 args.sessionId 不可见、ctx 恒优先、空出身落库、逃生口）。

## I10 锁生命周期无泄漏（R-159.1 全构造段收口）

**断言**：从锁获取成功到 kernel 对象完整构造，任何一步失败都必须回收已建资源（embedder/worker → db → 锁，同 closeKernel 顺序）；close 分阶段清理且幂等——任一阶段失败不阻断锁释放，重复 close 无副作用；宿主 init 失败做完整 kernel.close 而非只放锁；git init/.gitignore 等 root 写操作在锁获取之后执行。**验收标准：无论哪个初始化步骤失败、关闭步骤失败或热重载，都不留打开的旧 kernel，不留阻挡新实例的自有锁。**
**锚点**：`src/kernel.js` createKernel 构造期 try/catch 守护（R-159.1）+ closeKernel 分阶段幂等实现 + git 段在锁后；`dsh/lib-index.js` apply 失败完整 close；openDatabase 失败清理（v4.31.10）与 apply 失败兜底（v4.31.9）为前两层。
**测试**：r159 kernel 接线（拿锁/释放/fiber 重放/apply 兜底/双进程）；fault-injection「db 文件损坏 → 锁不残留」「构造段早期失败（domains 撞 id）/ 中期失败（loadExternalTable）→ 锁不残留」「close 幂等」；`test/cordis-fiber-replay.mjs` 事件流水证据（fiber.update 先卸后启，可复现）。

## I11 导入不复活已遗忘身份

**断言**：外部导入（import-external / import-qq-memory）走 kernel.remember，entryId 强制新生成（I1）——被遗忘条目的身份不可能因导入回归；tombstone 按身份判定，不按内容判定。
**已裁定边界**：被遗忘条目的**内容**可被重新导入为新 ID 新条目——tombstone 只存 entryId 不存内容指纹，写入侧无法检测"这条内容以前被遗忘过"；且身份唯一来源是 newUlid，不存在可复用的旧 ID。若未来需要"内容级防重灌"，立项 tombstone 内容指纹方案（见 DESIGN-NEXT R-161，P3，等需求触发）。
**测试**：现有导入脚本的 source_ref 去重路径 + I1 的 ID 生成断言。

## I12 检索与过滤规则单一来源

**断言**：热区与冷存（entries_fts 与 entries_fts_cold）使用同一套身份与过滤规则；冷存不是独立存储层而是 md 月文件 + 冷表，一切遗忘/重建过滤对二者同时生效。
**锚点**：rebuild `p.includes('/cold/')` 只分桶不过滤差异；write.js 双表写、forget 双表删。
**测试**：r156 冷存条目 forget 后 `entries_fts_cold` 计数归零 + rebuild 不复活（含冷存）。

---

## 使用方式

1. **改动自查**：PR/提交前对照本清单；触碰 I2/I4/I5/I7（数据安全核心四条）的实现改动，必须跑全量测试并确认对应用例逐条绿。
2. **新增测试**：修复任何安全相关问题时，测试用例名尽量引用不变量编号（如「I2：xxx」），保持清单↔测试双向可追溯。
3. **评审锚点**：外审（外审）提出的"系统性验证"要求，以本清单为索引回答"这条契约是否成立、被谁钉住"。
4. **版本纪律**：本清单的修订随 CHANGELOG 记录；删除或弱化任何不变量 = breaking，必须显式评审。

## 已裁定不做的（防重复立项）

- **SQLite in-place DDL 迁移**：SQLite 是派生层，schema 变更走 rebuild（R-160 范围收窄的基石）。
- **tombstone 内容指纹防重灌**：见 I11 已裁定边界 + DESIGN-NEXT R-161（P3 等需求）。
- **通用 Migration Framework / 自动迁移**：R-160 只做 Key Migration + Memory Migration 两类，默认手动触发。

---

## 附录 A · API 权限矩阵（2026-11-01 审计，外审阶段 4）

> 审计范围：内核 API（src/kernel.js 返回对象）、宿主 Agent 工具（dsh/lib-index.js 七个 memory_*）、
> 宿主 webServer 路由（/api/plugins/dsh-memory-kernel/*，19 个子路由）。语义以现有代码为准，未改变任何行为。

### A1 内核 API（kernel.memory / kernel.lifecycle / 平铺别名）

| API | 普通模式 | shared（只读旁路） | 未初始化 | rebuild 运行中 |
|---|---|---|---|---|
| memory.search / context / transcript / inner / emotions / diary | 允许 | 允许 | 不可达* | 允许（读） |
| memory.remember | 允许 | **拒绝**（requireWriter，明确报错） | 不可达* | **拒绝**（assertStableForWrite） |
| memory.appendTranscript / appendInner / appendEmotionSelf | 允许 | **拒绝** | 不可达* | **拒绝** |
| memory.extract / preStep / postStep | 允许 | 允许（读语义为主） | 不可达* | 允许 |
| lifecycle.forget | 允许 | **拒绝** | 不可达* | **拒绝** |
| lifecycle.dream | 允许 | **拒绝** | 不可达* | **拒绝** |
| lifecycle.rebuild | 允许 | **拒绝** | 不可达* | **拒绝**（重入） |
| lifecycle.close | 允许（幂等） | 允许（幂等） | 不可达* | 允许（会等当前操作收尾） |

\* "不可达"：tools 注册与 API 暴露都发生在 createKernel+init 成功之后；初始化失败（含坏 db）时 kernel 对象不会生成，宿主拿不到工具、调用方拿不到实例——不存在"半初始化"暴露面（I8；本审计修复了该路径的锁残留，见 I10）。

**三层区分（R-158.5）**：Capability（kernel API）≠ Tool（Agent 工具）≠ Provider（DSH 生产适配器）。内核写能力在 shared 下从 API 层就不可达，工具层无需二次实现。

### A2 宿主 Agent 工具（dsh/lib-index.js 注册）

| 工具 | 会话开关（R-153 gate） | shared 模式 | 语义 |
|---|---|---|---|
| memory_search / memory_context | 关 = 返回 DISABLED_SHAPE（明确"记忆已关闭"形态） | 可用（读） | 检索含 include_cold 运维档 |
| memory_remember | 关 = DISABLED_SHAPE | **内核层拒绝**（requireWriter 冒泡为工具错误） | 判重/低效用/pending 各有明确返回态 |
| memory_inner | 关 = DISABLED_SHAPE | **内核层拒绝** | 自述流水（写） |
| memory_forget | 关 = DISABLED_SHAPE | **内核层拒绝** | confirmId 二次确认；rebuild 运行中拒绝 |
| memory_dream / memory_maybe_dream | 关 = DISABLED_SHAPE | **内核层拒绝** | 巩固（写） |

工具注册只在 kernel 初始化成功后发生：初始化失败 → 工具不存在 → Agent 侧明确"无此工具"，无半初始化调用面。

### A3 宿主 webServer 路由（19 个子路由，全部经 guarded 401 鉴权）

| 类别 | 路由 | 写/读 | 鉴权 |
|---|---|---|---|
| 状态 | GET /status、/confirm-queue、/memory-search、/rebuild-progress | 读 | guarded（网关 cookie） |
| 配置 | POST /actions/config | **写**（白名单 11 键 + 落盘） | guarded |
| 敏感动作 | POST /actions/forget、confirm-approve、confirm-reject、rebuild、dream、session | **写** | guarded |
| LLM 设置 | POST /actions/llm-settings、llm-test | **写**（key 打码回显） | guarded |
| 运维 | POST /actions/domain-add、synonym-diag、lexvec-neighbors、open-folder | 写/诊断 | guarded（open-folder 域名白名单正则，无路径穿越） |

- 鉴权模型：**网关 cookie（dsh-auth-）在网关侧验证会话真实性，插件侧 guarded 只做存在性拦截**——双保险的前一半由宿主网关负责，这是宿主组合的既有设计，插件不重复实现会话校验。
- **本审计修复**：transcript 流式/批量追加失败的静默吞（`catch(() => {})`）改为 audit `transcript-append-failed` 留痕——不阻塞主对话的设计保留，但失败必须有据可查（I8"看似正常实际失败"）。

### A4 审计结论

- 三层入口（内核 API / Agent 工具 / HTTP 路由）的读写边界与 R-159 单写者契约、R-153 会话开关、I8 中间态防护**全部对齐，无漏网写入口**。
- 本审计共修复两处：①openDatabase 失败锁残留（I10，见 v4.31.10 条目）②transcript 失败静默吞（上文）。

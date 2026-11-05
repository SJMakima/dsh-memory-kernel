# CHANGELOG

本文是**面向公开仓库的技术变更精选**：按里程碑聚合，只保留结论。完整的逐版本开发记录见 git 提交历史。

版本说明：内核实现版本为 `4.31.x` 链（当前 `4.31.21.1`）；npm 包版本（`package.json` 的 `0.1.0`）是独立的 API 包版本，两者不是一个东西。

## 4.31.21.1（2026-11-03）

### Fixed
- Forget：正常删除成功时不再误报 degraded（诚实性判定移到删除尝试之后）。
- 冷存遗忘：跨月归档场景的 md 残留（候选月排序 last_decay_at → recorded_at → persistence_at_decay + 整冷区目录兜底扫描）。
- Rebuild：热区重灌后 `embedding_pending` 默认置 1，向量批次成功逐条清 0，杜绝"假向量"。
- Remember：入口参数校验（缺 sourceRef/provenance 时给出可读错误，不再深层 TypeError）。

### Reliability
- Writer lock 释放失败后的恢复语义（R-159.6/.7）：异常分类、失败保留引用可重试、构造回滚留痕。
- cordis 宿主生命周期：apply 全周期 effect 回收、fiber 异步 dispose 强等待、锁竞态 fail-closed（R-159.1~159.5）。
- verify-release 门禁 `--test-concurrency=1` 串行跑，消除并发抖动假红。

### Verification
- 331 项测试全绿（含 18 条故障注入 + 9 条评审回归 + cordis fiber 重放）。
- 宿主兼容矩阵（docs/host-compat-matrix.md）区分 claimed / verified / TBD。

## 4.31 系列（2026-10-31 ~ 2026-11-03）

- 安全收口：单写者 root-lock 全生命周期（获取 / stale 接管 / 释放 / 竞态窗口 fail-closed）；tombstone 四态防绕过（改名 / 扫描统一 / ULID 严格化 / 双来源身份冲突）；锁结构校验 + 并发接管竞态修复。
- 架构收口（R-152~R-159）：facade 语义、健康检查、任务积压、forget 诚实性、trace、契约测试、动态域 id 校验下沉。
- 工程化：发布门禁（逐文件 SHA256 清单 + 整包指纹 + 冒烟）、安全不变量清单（docs/INVARIANTS.md I1~I12）、API 权限矩阵、故障注入测试集、cordis fiber 重放脚本。

## 4.29 ~ 4.30（2026-10-31）

- 安全补丁集成与架构增补第一批：门禁闸门（Phase 1）、健康 API、任务积压、会话开关、设置页读口。

## 4.19 ~ 4.28（2026-10-28 ~ 2026-10-29）

- 抽取管线自灭根因修复（R-140）。
- 原话向量路（R-141）：补 FTS 的语义盲区。
- 情绪日志层（R-142）：记录双方情绪 + 情绪转录。
- 连锁记忆（R-144）：evidence_links 落地。
- importance / activation 解耦（R-144 三轴收尾）。
- L3 语义对账（R-120，只告警不清理）。
- 记忆对用户可见（R-63）：产品侧最久的缺口关闭。

## 更早（P0-0 → P3+ 分期）

- 纯函数基线、单进程骨架、Markdown 真相源 + SQLite 派生层、四路召回 + 加权 RRF、三段组装、dream、全量重建、embedding worker、补嵌闭环、LLM 抽取全链（四分类判重）、评测 harness、verified 上线、FTS optimize、身份分叉采集、pattern 提炼、人工确认式身份对齐、bili/douyin Adapter、cross-encoder 重排钩子（可插拔，默认关）、差分衰减 A/B、内存精确索引。

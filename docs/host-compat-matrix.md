# DSH 宿主兼容矩阵（Phase 0 探针的引用源）

**状态标记规则**：

- `claimed:` —— 来自搜索/二手资料的声明，**未被任何真宿主验证**。不允许被任何下游决策引用（包括"支持底线"这种判断）。
- `verified@<宿主版本>@<日期>` —— Phase 0 探针在真宿主上实测翻转后的状态，须注明验证人与环境。
- 探针没跑之前，**支持底线是 `TBD`**，不得预填进 README 的支持声明。

## 五道必答题（探针验收项）

| #  | 问题                                               | 不通过的后果                               |
| -- | ------------------------------------------------ | ------------------------------------ |
| Q1 | 目标宿主版本用哪套设置入口？（`installSection` vs 0.1.7+ 新架构）   | 决定 Host 半代码走哪条分支                     |
| Q2 | 命名空间如何配对？（插件自选 key vs 宿主以 `describe()` 为准）       | 决定卡片 key 的写法                         |
| Q3 | schemastery 运行期版本是否 ≥ 3.18.3？                    | 低于门槛时设置区块**静默失效**（`volatile` 守卫，无报错） |
| Q4 | 配置变更是否有 `watch`/等效通知？（`fiber.update` 只是原地替换，无回调） | 没有 → 热生效降级为"重启后生效"，Phase 2 重排        |
| Q5 | 字段是否真正可编辑且值可回读？（渲染 ≠ 可交互）                        | 回读抛 `field not persisted` → 命中静默失效   |

## 矩阵

| 宿主版本          | 入口插槽                                                                                                                                   | 命名空间配对                                                                             | schemastery 下限                                                                                           | 配置投递                                                                                                         | 可编辑+可回读                                                                    | 支持决策    | 状态           | 验证人/时间                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------- | ------------ | --------------------------------- |
| 0.1.5 / 0.1.6 | claimed: `settings.plugin.item`                                                                                                        | claimed: 插件自选 key                                                                  | claimed: 无硬门槛                                                                                            | claimed: 无 watch，重启生效                                                                                        | claimed: 未验证                                                               | **TBD** | claimed      | —                                 |
| 0.1.7-rc.1    | claimed: 移除 `installSection`（无垫片），新入口                                                                                                  | claimed: 宿主以 `describe()` 为准                                                       | claimed: ≥3.18.3                                                                                         | claimed: 同上                                                                                                  | claimed: 未验证（`editableConfig` 静默失效报告）                                      | **TBD** | claimed      | —                                 |
| 0.1.7+        | claimed: 新 settings 架构                                                                                                                 | claimed: `describe()` 为准                                                           | claimed: ≥3.18.3                                                                                         | claimed: 显式 `watch` 契约                                                                                       | claimed: 未验证                                                               | **TBD** | claimed      | —                                 |
| 0.2.0-rc.1    | verified@0.2.1-rc.3@2026-10-26: 无 API 破坏性变更（同 0.2.1）                                                                                   | verified@0.2.1-rc.3@2026-10-26: 命名空间由 entry id + Config 推导，`settings.register` 已删除 | verified@0.2.1-rc.3@2026-10-26: ≥3.18.3（.volatile() 只在宿主自带 schemastery 有；本地装的要 .extra('volatile', true)） | verified@0.2.1-rc.3@2026-10-26: patch 配置走 fiber.update 热应用                                                   | verified@0.2.1-rc.3@2026-10-26: 未逐字段验，但现役 qq-mode-console 的 volatile 写穿在工作 | **TBD** | verified（部分） | dsh-memory-kernel 安装实测 2026-10-26 |
| 0.2.1-rc.2/3  | verified@0.2.1-rc.3@2026-10-26: 插件 = 具名导出 name/inject/Config/apply；工具 = ctx.tools.register(defineTool(...))；bundle 声明 dsh.bundle.patch | verified@0.2.1-rc.3@2026-10-26: 同上                                                 | verified@0.2.1-rc.3@2026-10-26: 3.18.x 本地副本 **.extra+.default 链用会破坏缺省解析**（缺省字段变 {}）——默认值必须在 apply 里防御性归一 | verified@0.2.1-rc.3@2026-10-26: **profile/home 级 cordis.patch.yml 被 HMR 监视，bundle 内 patch 文件不在监视范围**；源码改动需重启 | verified@0.2.1-rc.3@2026-10-26: 未逐字段验                                      | **TBD** | verified（部分） | dsh-memory-kernel 安装实测 2026-10-26 |

## 探针执行清单（在目标宿主上逐项打勾）

- [ ] Q1：记录宿主版本号，确认 `ctx.settings` 上实际存在的方法集合
- [ ] Q2：注册最小卡片，确认命名空间来源（自选 key 是否被尊重）
- [ ] Q3：在宿主运行环境打印 schemastery 实际版本
- [ ] Q4：修改一个字段并保存，观察运行中插件是否收到通知（不看磁盘文件）
- [ ] Q5：卡片放一个可编辑字段 → 保存 → 回读，确认值持久化且可交互
- [ ] 产出：把上表对应行的 `claimed:` 翻成 `verified@…`，并填写"支持决策"列
- [ ] 附带：确认构建工具（如 `dsh-build-tools`，claimed: 产出 `__ModuleLoader__` CJS 浏览器产物、load id === 包名硬校验）与目标宿主版本兼容

## 实测补充（2026-10-26，dsh web @ 0.2.1-rc.3）

- 插件安装位置：`$DSH_HOME/plugins/<name>`（示例：`~/.dsh/plugins/`），profile 里以 `link:` 依赖 + junction 挂进 `node_modules`，包名进 `dsh.profile.bundles`。
- 工具注册：`ctx.tools.register(defineTool({name, description, parameters, output:{schema}, execute(args, exec), timeoutMs?}))`；parameters/output 用 DSH 方言（`required: true` 写在属性内）。
- 生命周期：`apply(ctx, config)` 里 `ctx.on('dispose', ...)` 收内核关闭；Config 变更 → fiber.update 重放 apply（重挂载 = 新 kernel，天然解决"热改 root"）。
- 同 id 跨层 insert：实测 bundle 层的 config 赢了 profile 层（与指南"后者覆盖前者"的直觉相反）——**两处 config 必须保持一致**。
- `dsh` CLI：`<DSH 安装目录>/resources/runtime/cli/bin/dsh.cmd`（Electron as node）；`dsh web` 起在 `127.0.0.1:3080`。
- **直接 ctx.tools.register(裸对象) 的三条硬规则**：① parameters/output.schema 必须是标准 JSON Schema（required 数组；defineTool 的属性内 `required: true` 是方言，绕过 defineTool 就会被 assertSupportedJsonSchema 拒）；② `output.render` 必填且必须在 output 对象**内部**；③ 工具名不得叫 `run_code`（PTC 保留）。
- **cordis apply 的返回值 = 清理函数**：返回函数 → 注册为 dispose 回调；返回普通对象 → 抛 "Invalid effect"（`return { kernel }` 是错的）。
- **安装最终形态**：`dsh web` @ 0.2.1-rc.3 上 dsh-memory-kernel 5 工具全部激活（2026-10-26 09:07Z），记忆库 root = `~/.dsh/memory-kernel-dsh`，审计落痕 `audit/dream.log` bootstrap-rebuild。

## 已定无须探针的决策

- **不维护 ≤0.1.6 双路径**（前提：探针确认目标宿主 ≥ 0.1.7；若目标宿主是旧版，此决策作废重议）。
- schemastery `>=3.18.3` 写入 `peerDependencies`（claimed: 兼容性校验读 peerDependencies 而非 engines.dsh —— 此条本身也是 claimed，探针顺带确认）。
- 兼容相关源码里的版本判断用**特性探测**，探测分支的 fallback 顺序以本矩阵为准。

## 工具注册形态判定（R-158.1，2026-10-31 收口进 host-adapter）

通用适配器（`src/index.js` createPlugin）与生产适配器（`dsh/lib-index.js`，走 `ctx.tools.register` 裸对象）是**两层入口**，能力矩阵说明差异而不是抹平（R-158.5）：

| 通道 | 宿主 API | 形态 | 判定者 |
|---|---|---|---|
| 通用适配器 | `ctx.registerTool` | `(descriptor, handler)` 或 `(name, parameters, handler)` 两种 | `src/adapters/host-adapter.js`：显式 `hostToolStyle` > 宿主自报 > listTools+unregister 探测 > `.length` 兜底（唯一保留处） |
| DSH 生产适配器 | `ctx.tools.register` | 裸工具对象（标准 JSON Schema + output.render 必填） | 固定形态，无判定 |

- `registerTool.length >= 3` 的旧启发式已被收进 host-adapter 单点：**包装函数 / rest 参数都会破坏 `.length`**（包装后恒 0），所以它只能当兜底，宿主侧推荐显式 `hostToolStyle` 自报。
- 探测式（descriptor 哨兵注册 + listTools 验证 + unregister 注销）只在宿主同时提供 listTools 与 unregisterTool 时启用——验完收拾干净，不留垃圾工具。
- claimed：宿主自报字段名定为 `ctx.hostToolStyle`（'descriptor' | 'args'）。verified@无@—（尚无宿主实现该字段，出现后把本行翻成 verified）。

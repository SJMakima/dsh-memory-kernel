# dsh-memory-kernel(测试版本慎用)

本地记忆内核：**Markdown 真相源 + SQLite 派生层**。把对话里值得留的内容（事实 / 边界 / 技能 / 模式）抽取成结构化条目落盘——Markdown 是人能直接读改的真相源，SQLite 做派生索引；检索时四路召回 + 加权 RRF 组装出带出身的上下文；dream 负责巩固、衰减与冷存。

**特性**

- 四路召回（FTS 精确 / FTS 模糊 / 向量 KNN / 域扫描）+ 加权 RRF 融合
- Markdown 真相源：条目就是普通 `.md` 文件，`rebuild` 可从 Markdown 全量重建索引
- LLM 抽取全链：schema 清洗 → isUseful → 四分类判重（redundant / update / uncertain / new）
- dream 巩固：激活结算、差分衰减、冷存归档、补嵌闭环
- 多域隔离 + 会话路由 + 来源信任档位（trusted / unverified）
- 331 条测试全绿（`npm test` 可复现），故障注入覆盖锁生命周期 / worker 崩溃 / 竞态窗口（见 docs/INVARIANTS.md 的不变量清单）

## 安装

要求：**Node ≥ 22**（better-sqlite3 13.x 与 usearch 2.26.x 的 engines 均要求 Node 22+，别用 20 硬装）。

```bash
git clone https://github.com/SJMakima/dsh-memory-kernel.git
cd dsh-memory-kernel
npm install        # 三个原生依赖 better-sqlite3 / sqlite-vec / usearch 均有预编译，Windows 可直接装
npm test           # 331 条用例全绿即装好
```

三个原生依赖的降级行为都是**已定义行为**，装不上不阻塞使用：

- `better-sqlite3`：必装（派生层的存储引擎），无预编译的平台需本地编译（要 C++ 工具链）。
- `sqlite-vec`：装不上时向量路自动降级为三路召回，其余功能不受影响。
- `usearch`：可选加速（SIMD 精确扫描，8 万条 8~10ms）。装不上时内存索引层自动禁用，向量路回到逐查询取 BLOB 的 vec0 路径（慢但结果一致）。

> 版本说明：`package.json` 的 `0.1.0` 是 npm 包 / API 版本；内核实现版本沿 `CHANGELOG.md` 的 `4.31.x` 版本链（当前 `4.31.21.1`）。两者不是一个东西。

## 快速开始（CLI）

不想接宿主时，用 CLI 直接当"本地记忆库"用：

```bash
node bin/dsh-memory.js remember "用户喜欢喝咖啡，每天两杯" --triple "用户|偏好|咖啡"
node bin/dsh-memory.js search "咖啡"           # 四路召回 + RRF
node bin/dsh-memory.js context <entry_id>      # 取原文上下文
node bin/dsh-memory.js stats                   # 行数/冷存/向量/嵌入状态
```

数据默认落在 `~/memory-kernel`（设了 `$DSH_HOME` 则在其下）；域目录首次写入自动创建，见 §1.5。

## 快速开始（作为库用）

```js
import { createKernel, defineDomain, createHashEmbedder } from 'dsh-memory-kernel';

const kernel = await createKernel({
  config: { storage: { root: '/path/to/memory-root' } },
  domains: [defineDomain({ id: 'my-domain', dir: '/path/to/archive' })],
  embedder: createHashEmbedder(1024),   // 换成真模型才有语义召回，见 §1 的说明
});
await kernel.init();

await kernel.remember({
  domainId: 'my-domain',
  text: '用户喜欢喝咖啡，每天两杯',
  entryType: 'fact',
  topicTags: ['偏好'],
  triples: [{ subject: '用户', attribute: '偏好', value: '咖啡' }],
  sourceRef: { adapter_id: 'my-domain', locator: 'my-domain:fact-1' },
  provenance: { session_id: 'my-domain:s1', message_ids: [], extract_task_id: 'manual',
                model_version: 'manual', extracted_at: Date.now(), source_content_hash: '' },
});

const r = await kernel.search({ sessionId: 'my-domain:s1', query: '咖啡' });
console.log(r.entries[0].text);       // 命中条目（带出处、权重、三元组）

await kernel.close();
```

接宿主（provide / registerTool / hook 约定或 DSH cordis 插件）见 §2 与 §0.5。

---

## 实现进度（对应 HLD 分期）

`DSH-memory-kernel-HLD-LLD-v4.10` 的可运行实现，文档的 P0-0 → P3+ 全部分期已落地：

- **P0-0**：附录 B 的纯函数基线，不接 SQLite 就能跑（`npm test` 里 24 条断言）
- **P0a**：单进程骨架 + Markdown 真相源 + SQLite 派生层 + 四路召回 + 加权 RRF + 三段组装 + dream + 全量重建
- **P1**：embedding worker 线程（§11.1 的预热/崩溃/超时四条约）+ 补嵌闭环（§18）
- **P0b**：`memory_extract` 全链 —— LLM 抽取（schema 清洗 + 重试）→ isUseful → 四分类（redundant/update/uncertain/new）→ 落盘
- **P2**：评测 harness（`npm run eval`）+ 单参数敏感度扫描 + over-fetch 代价评估 + verified 上线（误报 0%）+ 回读降权打开 + FTS optimize（带触发条件）+ 身份分叉采集
- **P3+**：dream 巩固信号消费与触发（`maybeDream`）+ pattern 提炼（步 7，LLM + 独立配额）+ 人工确认式身份对齐（`memory_align`）+ bili/douyin Adapter + cross-encoder 重排钩子（可插拔，默认关）+ 差分衰减 A/B（`eval/report.md` §5b）+ **内存精确索引**（`retrieve.memIndex`，默认开，见 §4.2）

不做的事：**ANN**。rescore 索引上游无发布版，HNSW 在 300 维下召回只有 88%（分布一变就掉到 11%）——精确 SIMD 扫描召回 100% 且更快，没有它的位置。真要百万级再旁路接 HNSW，别自己改 sqlite-vec。

```bash
npm install                    # better-sqlite3 必装；sqlite-vec / usearch 为可选依赖，装不上有已定义降级
npm test                       # 331 条：基线 / 端到端 / 插件 / audit / 向量 / 内存索引 / worker / P0b / P2 / P3 / 配置分类 / Phase 1 闸门与接口语义
npm run eval                   # P2+P3 校准报告 → eval/report.md（支持 --dataset 真实标注集 / --root 真实库）
npm run demo                   # 跑一遍抽取→写入→检索→组装→dream→重建，产物在 ./.demo

npm run cli -- remember "用户喜欢喝咖啡" --triple "用户|偏好|咖啡"
npm run cli -- search "咖啡"
```

## 0.5 部署到 DSH 宿主

> **验证边界（诚实声明）**：已在 DSH 0.2.1-rc.3 环境完成部分安装与兼容性验证（工具注册、
> 设置页探针、记忆读写、dream 落盘）；但**当前版本**（4.31.21.1）的完整宿主重启 → 旧实例
> 关闭 → 新实例接管（stale lock 接管）与 webServer 注册失败回收的**真宿主回归仍在待验清单**，
> 见 docs/host-compat-matrix.md 的格子状态（claimed / verified / TBD）。这些路径在测试层
> 有 fault-injection + fiber 重放覆盖，但"测试层覆盖"不等于"真机验收"。

真宿主不走 `src/index.js` 的 provide/registerTool/hook 约定，而是 **cordis 函数插件**（具名导出
`name / inject / Config / apply`，工具走 `ctx.tools.register`）。适配入口在 `dsh/lib-index.js`，
安装配方在 `dsh/cordis.patch.yml` + `dsh/package.json.template`。

```bash
npm run sync:dsh          # 仓库 → ~/.dsh/plugins/dsh-memory-kernel（同步后需重启 dsh web）
npm run sync:dsh:check    # 只看差异不写
```

- 宿主规则明细见 `docs/host-compat-matrix.md` 的"实测补充"（render 必须在 output 内、
  标准 JSON Schema、apply 返回值 = 清理函数、schemastery extra+default 坑）。
- 部署副本的原生依赖（better-sqlite3 / sqlite-vec）装在插件目录自己的 node_modules，不随同步走。
- `src/index.js` 的 createPlugin 仍保留：那是 HLD §11 的通用宿主约定 + 测试用，
  真 DSH 宿主用 `dsh/` 入口，两套不要混。

---

## 1. 跑起来（CLI）

不想接宿主时，用 CLI 直接当"本地记忆库"用：

```bash
npm install

# 写一条记忆（--triple 可给多个；不写三元组也能存，只是走不了四分类的查表判重）
node bin/dsh-memory.js remember "用户喜欢喝咖啡，每天两杯" \
  --triple "用户|偏好|咖啡" --tags 偏好,生活

node bin/dsh-memory.js remember "回复一律用中文，先给结论" \
  --triple "用户|边界|中文+结论先行" --type boundary

node bin/dsh-memory.js search "咖啡"          # 检索
node bin/dsh-memory.js search "咖啡" --top 5 --cold   # 连冷存一起扫（运维级）
node bin/dsh-memory.js context <entry_id>     # 取原文上下文
node bin/dsh-memory.js stats                  # 行数/冷存/向量/配额/嵌入是否就绪
node bin/dsh-memory.js dream                  # 巩固：结算激活、写状态、冷存归档、补嵌
node bin/dsh-memory.js backfill               # 只补嵌：把没向量的条目补进向量路
node bin/dsh-memory.js rebuild                # 从 Markdown 全量重建 SQLite
```

公共参数：`--root <目录>`（默认 `$DSH_HOME/memory-kernel`，没设就是 `~/memory-kernel`）、  
`--domain <id>`（默认 `local`）。也可以 `npm link` 之后直接用 `dsh-memory`。

## 1.5 多域（domains）：使用 → 创建

本仓库**不携带任何域数据**。域不是预置的，是"用到才建"：

- 域目录位于 `<root>/domains/<domain_id>/`（冷存 `<root>/cold/<domain_id>/`），首次写入或注册域时自动 `mkdir`，无需手工创建。
- CLI 用 `--domain <id>` 指定；宿主侧通过配置里的 `domains` 列表（`defineDomain`）或设置页的动态域声明。
- `domain_id` 过共享正则校验（`src/pure/normalize.js` 的 `DOMAIN_ID_RE`），非法 id 直接拒绝。
- `domains/`、`cold/` 已在 `.gitignore` 里：你的记忆数据永远只在你本机的 root 下，不会进版本库。

CLI 默认走 **embedding worker 线程**（`src/workers/embedding-worker.js`），模型只在 worker 里常驻；  
worker 里挂的是**确定性哈希嵌入**（`adapters/hash-embedder.js`），只为让 vec0 那条路跑得通，不是语义模型。  
要真的按语义召回，把 `loadModel()` 里的三行换成真模型（bge-m3-q8 等）——  
这是接宿主时唯一必须自己替换的部分，`core/` 之外没有任何代码知道"向量是怎么来的"。

```bash
node bin/dsh-memory.js stats    # 顺带看 embedding 是否就绪
```

## 2. 接进宿主

插件只依赖宿主三个口子：`provide` / `registerTool` / `hook`。

```js
import { createPlugin, defineDomain, createHashEmbedder, createChatLlm } from 'dsh-memory-kernel';

const plugin = createPlugin({
  config: { storage: { root: '/var/dsh/memory-kernel' }, embedding: { dim: 1024 } },
  domains: [
    defineDomain({ id: 'qq-group', dir: '/var/dsh/archive', requireSignature: false }),
  ],
  embedder: myWorkerClient,   // { dim, async embed(texts) => Float32Array[] }
  llm: createChatLlm({        // P0b：任意 OpenAI 兼容端点；不注入就没有 memory_extract
    apiKey: process.env.LLM_KEY, model: 'gpt-4o-mini',
  }),
});

await plugin.setup({
  provide: (name, value) => { /* 暴露 memory 实例 */ },
  registerTool: (descriptor, handler) => { /* 注册工具 */ },
  hook: (name, handler) => { /* 注册钩子 */ },
});
```

| 能力                   | 入口                 | 说明                                                        |
| -------------------- | ------------------ | --------------------------------------------------------- |
| `memory_search`      | `ctx.registerTool` | 四路召回 + 加权 RRF；`include_cold=true` 是运维级查询，返回带 `coldScanMs` |
| `memory_context`     | 同上                 | 按 `entry_id` 取原文（来自 Adapter 的 `sourceReader`，只读）          |
| `memory_remember`    | 同上                 | 手写候选直接进落盘管线（P0a 入口，抽取器也能填）                                |
| `memory_extract`     | 同上                 | **P0b**：消息 → LLM 抽取 → isUseful → 四分类 → 落盘；未注入 llm 时返回明确错误 |
| `memory_maybe_dream` | 同上                 | **P3+**：按"巩固信号达标或空闲"判断要不要 dream，不满足条件零成本返回                |
| `memory_align`       | 同上                 | **P3+**：身份分叉的 list / resolve；唯一写路径带显式 keepEntryId（人工确认）   |
| `memory_dream`       | 同上                 | 触发一次巩固                                                    |
| `agent/pre-step`     | `ctx.hook`         | 自包含短路 → 检索 → 三段组装（历史动态段已剥离）                               |
| `agent/post-step`    | `ctx.hook`         | 巩固信号；（P2 才开）`verified` 绑定                                 |
| `kernel/idle`        | `ctx.hook`         | 空闲巩固                                                      |

宿主不吃这套约定也没关系：`createTools(kernel)` 返回 `{ name: { description, parameters, handler } }`，自己接即可。

## 3. 目录结构

```
src/
  pure/            # P0-0 基线：无 IO、无时钟、无随机
    normalize.js   # collapseWs / subjectKey / attributeKey / normalizeValue / logit / ULID
    tokenize.js    # tokenizeBigram / estimateTokens
    paths.js       # parsePartPath（路径契约的唯一来源）/ 分片名 / 冷存路径
    ranking.js     # weightedRRF / mergeFtsRoutes / classifyIntent / isSelfContained / containsNormalized
    assembly.js    # 三段渲染 / trimToBudget / 历史剥离 / needsTrustLabel
    lifecycle.js   # lazyPersistence / settleEntry / shouldColdArchive
  storage/
    md.js          # 条目块序列化+解析（含 state 块）/ 原子写 / 块定位
    files.js       # files 表（sha 清单 + 分片映射）/ markdownPath / locateEntryPath / refreshFileSha
    db.js          # 完整 schema（FTS5 standalone + vec0 分区键）
    lock.js        # per-path 异步互斥
    audit.js       # audit/*.log
  core/
    entry.js       # buildEntry（唯一构造点）/ 行↔Entry
    write.js       # 配额 → Markdown 先落 → entries → 索引 →（§18）补嵌
    retrieve.js    # 四路召回 → RRF → 扩展 → 准入/验签 → 排序 → 回读 shadow → 记激活
    dream.js       # 11 步注册表（P1 开 1/2/3/4/5/6/8/9b）
    rebuild.js     # 从 Markdown 全量重建
    assemble.js    # 稳定段（带 hash 缓存）+ 动态段
    vocab.js       # tripleSearch 词表（读写同一套归一化）
    vec.js         # vec0 路径 A/B/C + 内存精确索引接入 + 嵌入缓存 + 查询期降级
    vec-index.js   # 【R-137】每域扁平 Float32Array + exactSearch（第二派生层，可丢弃）
    security.js    # HMAC 签名 / 验签 / trust 后验（P2 开关）
    embedding-client.js  # 主线程侧 RPC 客户端（独立 warmup 超时 / ready 事件）
    extract.js     # §12.1 runExtractTask：schema 清洗 + 重试 + 四分类路由
  config-classes.js  # 设置页 watch 补丁的三分类（hot/structural/restart）+ 热应用
  config-schema.js   # UI schema 草稿 + CONFIG_ONLY 白名单（双向一致性由测试锁死）
  workers/
    embedding-worker.js  # 模型常驻的独立线程（生产替换点在 loadModel()）
  adapters/
    local-archive.js  # 只读 JSONL 原始档案 + defineDomain
    hash-embedder.js  # 测试用确定性哈希嵌入（不是语义模型）
    llm-chat.js       # OpenAI 兼容 chat transport（P0b 的 LLM 注入点）
    mock-extractor.js # 抽取器替身：脚本化 / 规则版（demo 用，不是语义模型）
    video-archive.js  # bili / douyin Adapter（P3+，薄：域注册 + locator 归一 + sourceReader）
bin/dsh-memory.js     # 最小 CLI（remember / extract / search / context / dream / rebuild / stats / backfill）
examples/demo.js
eval/                 # P2 评测 harness：dataset（合成标注集）/ metrics（NDCG/MRR）/ run（报告生成）
test/{baseline,e2e,plugin,vec,worker,extract,p2,p3,ann,config-schema}.test.js
docs/callgraphs.md     # 三张函数级调用图（写入索引 / 检索 / dream）
docs/host-compat-matrix.md  # DSH 宿主兼容矩阵（设置页 Phase 0 探针的引用源，格子带 claimed/verified 状态）
fixtures/              # worker 测试替身（慢 / 永不就绪 / 就绪后崩溃）
```

## 4. 关键实现点（挑最容易写错的）

- **真相源先落**：`persistNewEntry` / `handleUpdate` / dream 第 3 步都是 Markdown → SQLite → 索引。反了就是"rebuild 静默回退 + sha 比对永不重试"。
- **sha 只在三个地方刷**：索引批次提交后、dream 第 3 步锁内、冷存移动的两个文件。检索路径上顺手刷是禁止项。
- **分片"满即切"在锁内判定**：`writeMarkdownAtomic` 锁内 `countBlocks`，满了放弃本次锁 → `nextPartPath`（max+1）→ 重新拿锁；重试耗尽降级为超限写入 + `audit/part-overflow.log`，不抛异常。
- **事件删除与状态回写同事务、按批收敛**：dream 第 4 步一条 `dbTx` 里做 UPDATE + `DELETE ... WHERE entry_id IN (本批)`。
- **归一化只有一处**：`writeTripleRows` 调 `subjectKey` / `attributeKey`；`Entry.triples` 永远保留原文（签名对象）。`extendVocab` / `classifyNovelty` 用同一对函数。
- **所有带 `LIMIT` 的召回都有 `ORDER BY`**，且并列值补次要键（`bm25` 升序 / `observed_at DESC, id` / `hits DESC, last_at DESC, entry_id`）。
- **audit 必须按文件串行追加**：回读复核是 `Promise.all` 并发，同一个 `reread-shadow.log` 被并发 `appendFile` 时 Windows 直接 EPERM —— 而审计失败不该把检索一起带崩，所以按文件排队 + 吞错 + `flush()`。
- **FTS optimize 有触发条件**（P2）：进程内删改计数（`storage/fts-stats.js`）> 500 或距上次 > 7 天才跑；刚 optimize 完绝不许空转。计数是进程内软状态——重启后多 optimize 一次，成本一次性且无害，为它建表比问题还贵。
- **身份分叉的判据**（P2 第 10 步）：同一 `(subject_key, attribute)` 在**未被取代**的条目里存在多个不同值。取代边收口后分叉自然消失；P2 只采集 + 告警（`audit/identity-fork.log`），对齐是 P3+ 的人工确认动作（`memory_align`），**绝不自动合并**。
- **巩固信号是积分制**（P3 第 11 步）：未消费信号按 `signalWeights` 加权累计，达标的域进 pattern 提炼，dream 结束才整批置 consumed——**没达标的继续留着**，把"攒了 4.9 分"的域清零等于让下一次爆发更远。
- **pattern 提炼的三道闸**（P3 步 7）：① 域信号分 ≥ `signalThreshold` 才发 LLM 调用（否则一个请求都不发）；② 独立配额 `patternQuotaPerDay` 按本地日计，不挤日常写入；③ LLM 判"不是模式"回 `[]` 时直接跳过。簇 = 同 `(subject_key, attribute)` 的存活 fact ≥ 2，溯源 `message_ids` 指向源条目。
- **cross-encoder 钩子必须挂在最终排序之后**：放在 `pool.sort(score)` 之前会被原样盖掉，钩子等于没接（这个 bug 是重排测试抓出来的）。失败 → 原顺序继续，重排是增强不是依赖。
- **embedding worker 的四条约**（§11.1）：warmup 走独立 10s 超时（复用 2s 的通用超时会造成"越重启越慢"的伪 RPC bug）；预热 fire-and-forget 不阻塞就绪标志；`ready` 只由 worker 的 ready 事件翻转、必须由 exit/error 翻回去；普通请求超时 → `null` 数组降级，不 reject 到检索路径上。
- **补嵌才是闭环**：预热是 fire-and-forget，冷启动前几秒写进来的条目拿不到向量。写入标 `embedding_pending`，预热完成后多趟扫描补嵌（第一趟扫空时说明"还没落库"，要再等一拍）。没有补嵌，那几条会永久停在三路召回里，而日志里干干净净。
- **向量路关闭时不标 pending**：`vec.enabled` 为 false 就没有任何可补的东西，标了只会造出永远清不掉的幽灵条目。
- **LLM 输出一律当不可信输入**（P0b）：`sanitizeCandidates` 只收 schema 内的字段、非法 `entry_type` 归位 `fact`、坏三元组剔除（**丢弃而不是猜测**——猜测等于把模型幻觉洗白成事实）；解析失败重试一次后放弃，写 `audit/extract-failed.log`，消息本体在宿主档案里所以"丢"的只是这外审候选。
- **provenance 由管线填，不由 LLM 填**：`message_ids` / `extract_task_id` / `source_content_hash` 都来自宿主传进来的消息与任务本身——让模型编溯源字段等于没有溯源。
- **四分类的两个阈值读全局配置**（R-79）：`cfg.write.novelty.{redundant, uncertain}` 按**嵌入模型**校准，不是按域——DomainRegistration 里没有这个字段，别发明。

## 4.1 三张调用图

改路径之前看 [`docs/callgraphs.md`](docs/callgraphs.md)：写入索引 / 检索 / dream 三张函数级图，  
每个节点标注 **入 → 出 → 允许怎么坏 → 谁消费**。

## 4.2 向量路：内存精确索引（`retrieve.memIndex`）

**没有 ANN 开关，这是刻意的。** sqlite-vec 至今没有任何发布版支持 `INDEXED BY rescore(...)`
（只有 PR #276 的讨论），而且实测即便支持也不划算：300 维下 bit 量化要 95% 召回需 58.7ms、
精确扫描 67.9ms —— 只快 13%，还白丢 5% 召回。usearch 的 HNSW 同样不划算：召回 88%、建索引 16.6s，
换成随机均匀分布召回直接掉到 11%（等距数据没有「近邻」结构，图遍历退化成随机走）。
所以这一层用的是 usearch 的 **`exactSearch`**（精确 SIMD 扫描，召回 100%），不是它的 `Index`。

真正要修的是**搬运**，不是算法：

| 环节（域内 2 万条 × 300 维） | 耗时 |
| --- | --- |
| 从 `entries_vec` 读 2 万条 BLOB 展开成 `Float32Array` | **283 ms** |
| 算余弦（手写 JS） | 40 ms |
| 换 SIMD `exactSearch` | 8 ms |

索引常驻之后：**1.79 ms** vs `vec0 MATCH` **34.14 ms**（快 19 倍），top-k 重叠率 **1.0**
（两者都是精确算法，不一致就是 bug）。常驻 = 向量数 × 维度 × 4B（8 万条 300 维 ≈ 92MB）。

**层级（别把这层当真相源）**：

```
md 片段（真相源，可重放）
  └─ SQLite / entries_vec（第一派生，rebuild 可从 md 重建）
       └─ 内存 flat（第二派生，只是 SQLite 的缓存，随时可丢弃）
```

重灌来源是 **SQLite 而不是 md**：向量不在 md 里（是 embed 出来的），从 md 重放要重跑一遍嵌入。

**五条约束，每条都对着一个具体的静默错误**：

| 约束 | 违反后的症状 |
| --- | --- |
| 懒加载：某域首次被查询时才灌 | 启动即扫全库；没查过的域白占内存 |
| swap-remove 时同步改 `id→下标` Map | 删中间一条后其余条目整体串位 → **查 A 返回 B，且不报错** |
| 脏了 `search` 返回 `null` 而不是 `[]` | `[]` 会被上层读成「向量路没命中」，把召回静默吃掉 |
| `kernel.rebuild()` 先 `resetIndex()` 再重灌 | 旧 flat 的映射与库脱节 → 张冠李戴，且更隐蔽（索引看着「有数据」） |
| 空域不建索引（`load([])` 直接 false） | 留一个空 state 后 upsert 会增量写，而索引缺全部历史 → 召回静默变少 |

**降级链**：内存索引 → `vec0 MATCH`（大分区）→ 域内全量内存算（小分区，R-122）→ 全表 over-fetch
（路径 B）→ 三路召回。任一层失败都不影响正确性，最多慢外审。脏域重灌 2 次仍失败就熔断到 `vec0`，
否则每次查询都重读全表 BLOB，比不开还慢。

**配置**：`retrieve.memIndex.enabled`（热键，判定时现读）、`retrieve.memIndex.maxVectors`（默认 20 万，
超限的域不建索引并写 audit）。`/status` 的 `vector` 块报**实际**模式
（`mem-exact` / `mem-lazy` / `vec0-knn` / `domain-scan` / `per-domain` / `disabled`）与常驻开销。

`dream` 9c 的 `hot-partition` 告警现在只是观测点：那个数就是内存索引的扫描量，是检索 P95 的解释变量。

## 4.3 总开关闸门与设置页读口（Phase 1）

- **`plugin.enabled`（hot 键）**：`createPlugin.setup` 注册时用 `withGate` 统一包住全部 7 个工具 handler——禁用返回 `{status:'disabled'}`，不在每个 handler 手写；三个钩子在 kernel 侧闸：`preStep` **整条短路**（`system` 为空 + `stripHistoricalDynamic` 剥历史动态段——guide/稳定段全是记忆，组装了再丢弃等于没关；历史轮已注入的 `<memory_context>` 不剥就会继续漏）、`postStep` 跳过巩固信号与 verified、`maybeDream` 不投任务。全部经 `applyConfigPatch` 热生效，开关往返不需要重启。
- **`audit.summary()`**：状态面板的数据口（tail + 聚合，见上行格式）。只读，不影响追加链。
- **重建**：设置页"重建派生层"按钮直接接现成的 `kernel.rebuild()`（= `rebuildAll({clean:true})`，Markdown 真相源重放，运行时表不动）；文案必须写明**重建期间检索不可用**。close→删文件路径有意不做——彻底重置留给手工 `rm index.db*`。

## 5. 与文档不一致的 8 处（代码里都有注释，编号沿用文档的 R）

实现期发现的问题，按"会不会静默出错"排序：

1. **`ftsSearch` 的 MATCH 必须显式 `OR`**：FTS5 对空格分隔的多 token 是**隐式 AND**。照 §13.2 把 `tokens`（`"我平 平时 时喝 …"`）直接塞进 `MATCH` 等于要求"整句话每个 bigram 都出现"，一句自然问句的 FTS 路常为空。→ `"...".join(' OR ')`，让 bm25 负责排序。（`shouldSkipVectorChannel` 里那个 AND 是故意的，语义不同。）
2. **`activation_count` 必须写绝对值**：§17.2 第 3 步写 Markdown 用的是 `e.activation_count`（**增量前**），第 4 步 SQL 写 `+ hits`。于是真相源永久落后一个窗口，删库重建后激活计数归零。→ 第 2 步就算出 `count + hits`，两个存储写同一个数。文档反对的是用 `COUNT(*) FROM activation_events` 重算（事件结算即删会清零），不是绝对值。
3. **`markdownPath` 只对新条目成立**（配合 R-31 的分片）：`lookupPartNo` 返回 `MAX(part_no)`，用它去改 part-00 里的条目会把同一条写成第二份副本。→ 修改已有条目走 `files.locateEntryPath`（按 part 降序找 block）。
4. **`isSelfContained` 的纯算术白名单要收紧**：`[\d\s+\-*/().]+[=＝]?` 会把裸 `"1"` 判成自包含，与 §13.0 正文（"'1'、'嗯'、'继续' 恰恰强依赖上下文"）冲突。→ 要求必须带运算符。
5. **`tokenizeBigram` 不该先删所有空白**：`replace(/\s+/g,'')` 对中文无影响，但会把 `"Hi there"` 变成一个 token `"hithere"`。→ 保留空格作分段边界（中文无空格场景行为不变）。
6. **Markdown 块缺 4 个字段**：`identity_scope` / `shareable` / `sensitivity` / `archived_topic` 不在 §9.3 的块里，重建只能按域注册信息重算 → 写 `audit/rebuild-identity-defaulted.log`。**C2 的"完全重建"在这四个字段上是打折的**，要真无损就得把它们写进 frontmatter。
7. **`containsNormalized` 的示例过不了自己的门槛**：§13.7 说能容忍 `用中文回复` ↔ `偏好中文回复`，但 4 个 bigram 只覆盖 3 个 = 0.75 < 默认 0.8。测试里把两个事实都断言了，P2 校准时别把它当"已知成立"。
8. **`probeNextPart` 的语义要写清**：返回"当前可写分片"（已存在的最大 part，无则 0），不是"下一个空分片"。返回 max+1 会让一天的第一次写入落到 `part-01`、`part-00` 永久缺失，破坏"part 0 = 未分片的单文件"这条路径契约。
9. **路径 B 的收工条件有两个**：只有 `rows.length >= k` 时，一个只有 3 条向量的新域会连翻三倍 `fetch` 后返回 `[]`，明明手里握着 3 条真命中却把向量路整个让出去。→ 补上"`hits.length < fetch`（表被抽干）"这个条件。小域在前几周是常态。
10. **`vec.remove` 在路径 C 下必须传 `domainId`**：表名是按 `domain_id` 拼的、不可枚举，靠遍历 `vec_shards` 猜的话，计数漂移到 0 的域在表里就没有行 —— 删不掉的那条向量会永远留在 KNN 结果里。
11. **`embedding_pending` 标了要有谁来补**：§18 只写"写入标 `embedding_pending`"，没说消费方。→ 预热后 + 每轮 dream 各扫一次，幂等（走 `embedding_cache` 去重），扫不干净就留到下外审。
12. **§11.1 要求的两类日志标签在检索侧得自己落地**：`vec:not-ready`（模型还在加载）与 `vec:rpc-timeout`（模型在、这条超时）必须分开写，否则第一次手测必然把前者误诊成 RPC bug，然后去调大 `rpcTimeoutMs`。


另外四**实现选择**（不是文档错误）：

- 嵌入走 worker 线程 + 可插拔 `embedder`。P0a 验收要求"embedding 必须真实调用"，但 600MB 模型不该进单测，所以 worker 里挂的是确定性哈希嵌入；生产把 `loadModel()` 换成真模型即可，`core/` 之外没有任何代码依赖"向量怎么来的"。测试用 `embedder:` 直接注入同步 embedder 跳过线程。
- 索引任务在进程内同步 drain（`persistNewEntry` 内 await），P0a 的"单进程 + 双 worker"只落了骨架；真正搬进 worker 时只需把 `indexEntries` 换成 RPC —— `filterLanded`（C9 二次校验）按文件读一次的实现已就位。
- dream 每轮会重写**全部**条目所在分片。这不是 bug：惰性衰减下 `persistence` 随时在变，state 块要落到当前值，代价就是 ADR-21 写明接受的"dream 期写放大"。

## 6. 运维

```bash
node examples/demo.js          # 输出 Markdown 真相源 + 组装结果 + dream 各步结果
```

- **删库重建**：删掉 `index.db*` 后重启，`init()` 检测空表就 `rebuildAll`。`files` 表是**整表重建**（先清后写），不会留下幽灵分片。
- **手改 Markdown**：只改 `state` 块安全；改 `text` / `triples` 必须同时把 `signature` 置 null 或重签，否则 `requireSignature` 域会静默排除该条（`audit/signature-failures.log`）。
- **冷存**：`coldThreshold` / `coldIdleMs` 调的是"热检索池多大"，不是"记多久就忘"；`include_cold=true` 仍能取回，且不计入 500ms 预算。
- **向量没接上先看两个地方**：`stats` 里的 `vecPending`（>0 说明有条目还没向量化）与 `embeddingReady`；`backfill` 手动补，或等下外审 dream。
- **P2 校准**：`npm run eval` 生成 `eval/report.md`；真实数据攒够后 `npm run eval -- --dataset 标注.jsonl --root 真实库` 重跑定稿。报告里"不敏感"的权重不要动——没有抓手就保持文档起步值。
- **audit 日志**（频道清单 = `audit.js` 的具名方法 + 各模块 `write()` 兜底名，实测枚举，别凭语义猜）：
  具名：`part-overflow` / `unknown-file-pattern` / `cold-scan-slow` / `route-scores` / `reread-shadow` / `signature-failures` / `trust-updates` / `identity-alerts` / `domain-ambiguous` / `assemble-budget-overflow` / `assemble` / `dream` / `shard-drift` / `index-missing`；
  兜底：`embedding` / `low-utility` / `pending-bad-payload` / `pending-expired` / `extract-failed` / `identity-fork` / `identity-aligned` / `pattern-mining-failed` / `rerank` / `rerank-failed` / `vec-degraded` / `vec-backfill-deferred` / `vec-strategy` / `hot-partition` / `config-patch` / `cold-move-failed` / `orphan-entries` / `rebuild-identity-defaulted`。
- **audit 行格式**：每行 `{ts, channel, payload}` 三元组——频道名落行内（v0.1 老日志无 channel 字段，`summary` 读取时按文件名归频道，不迁移旧文件）。设置页状态面板用 `audit.summary({channels?, windowMs?, limit?})`：tail 64KB 只读不扫全量，10 万行 < 50ms。**语义边界**：一频道一文件、tail 必达该文件末尾 → `lastTs` 永远是该频道真正的最近一次写入；但 `count` 是 64KB 窗口内的计数，不是历史总数——要完整历史请读文件。

## 7. 测试覆盖

| 文件                      | 覆盖                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/baseline.test.js` | 附录 B 全部断言：分词、RRF 两条不变式、`mergeFtsRoutes` 五条边界、意图判定顺序、自包含白名单、`containsNormalized`、三件套归一化、`needsTrustLabel`、`parsePartPath`、`trimToBudget`（整条丢 / boundary 不动 / 超预算 audit）、`buildEntry` 初值、衰减与冷存 |
| `test/e2e.test.js`      | 写入→索引→检索闭环、FTS 名次 vs 相关度（R-74）、自然问句 OR 语义、Markdown 含 state 块、删库重建状态不丢、分片阈值（并发写不超限、条目不重复）、dream 只结算一次、冷存归档 + `include_cold`、签名篡改排除、`handleUpdate` 的 γ/时间戳/原文保留、历史剥离与短路、配额 pending             |
| `test/plugin.test.js`   | 7 个工具 + 3 个钩子的接线、工具串联、`createTools` 单独使用、默认导出                                                                                                                                                |
| `test/vec.test.js`      | 路径 A/B/C 各自的判定与结果正确性：路径 B 取满 k 且 100% 本域、表被抽干时按实有量给、shard 计数对账、路径 C 的 upsert 幂等与 `remove(domainId)`、向量路关闭时静默降级、`vec:not-ready` / `vec:rpc-timeout` 两个标签分开                                    |
| `test/worker.test.js`   | §11.1 四条约逐条验收：warmup 独立超时不被 `rpcTimeoutMs` 误伤、推理超时降级为 `null` 且不拽下就绪位、未就绪时短路不占 RPC 槽位、worker 崩溃必须把 `ready` 翻回 false 且不能复用崩溃前的成功 promise；外加"两档冷启动 + 补嵌"端到端                                     |
| `test/extract.test.js`  | P0b 验收：消息 → Markdown 与 SQLite 均可见（provenance 指向原始消息）、重复消息 redundant 不新增条目（reinforce → dream 兑现）、换值走 update（取代边）、配额满 → pending → 恢复后消费、低效用 stash、坏 JSON 重试一次后放弃、解析/清洗的边界、uncertain 阈值路由       |
| `test/p2.test.js`       | P2 代码项：FTS optimize 的触发/清零/不空转、身份分叉的判定与取代边收口、verified 全链（后验推高 + 窗口 3 次上限 + retrieval_log 门开）、`detectVerified` 否定守卫（"这个不对"绝不当确认）                                                              |
| `test/vec-index.test.js` | 内存精确索引（R-137）：与暴力余弦结果**完全一致**（精确而非近似）、swap-remove 后 `id→下标` 不串位、覆盖同 id 不涨向量数、未加载域返回 `null`（不是 `[]`）、脏标记 → `null` + 重灌自愈、错维行跳过、容量增长不丢不错位、`maxVectors` 整域拒绝、开关现读配置（不是构造期快照）、`clear` 后零残留、空域不建索引 |
| `test/config-schema.test.js` | 设置页地基：`classifyConfigKey` 穷举（DEFAULTS 全叶无 undefined）、OVERRIDES/UI_SCHEMA/CONFIG_ONLY 幽灵键双向拦截、UI↔CONFIG_ONLY 双向覆盖、`applyConfigPatch` 行为（hot 活引用生效 / map 扩域 / 幽灵键拒 / restart 拒且不动值 / structural 归架 + partial 浅合并）、kernel 接线（`memIndex` 热键生效 + audit 落痕） |
| `test/phase1.test.js`   | Phase 1 三个口子：preStep 禁用整条短路（system 空 + 历史动态段剥净 + 开关往返即刻生效）、postStep/maybeDream 不采样不投任务、7 工具 withGate 统一 disabled、audit 新格式行 + 旧行按文件名归频道 + windowMs 过滤、summary 10 万行 < 50ms、rebuild 重建后行数与真相源一致且运行时表不动 |

没覆盖的：git 快照（依赖 root 是 git repo）、`dream` 第 4 步失败回滚（需要注入磁盘/锁故障）、真 600MB 模型的加载耗时（改用测试替身控制时序）、**HNSW 端到端**（只做了离线基准：`exactSearch` 与 HNSW 的召回/延迟对比，见 CHANGELOG v4.16；真要接 HNSW 时再补接线测试）。

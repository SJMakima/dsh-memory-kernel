# 三张函数级调用图

改任何一条路径之前先看这张图。**「失败」一栏写的是「允许怎么坏」，不是「可能抛什么」**——
这份契约的用途是：改动之后如果坏法变了（比如从"跳过这一条"变成"整批回滚"），即使测试还是绿的，也说明改错了。

三个流分别是：

| 图     | 触发频率   | 成本量级       | 写哪些表                                        |
| ----- | ------ | ---------- | ------------------------------------------- |
| A 索引  | 每条记忆一次 | O(1)       | `entries` `entries_fts` `entry_triples` `entries_vec` `vec_shards` `files` |
| B 检索  | 每轮对话一次 | O(热区)      | `activation_events` `retrieval_log`（都只增）      |
| C 巩固  | 空闲/定时   | O(当日变更 + 全域) | 上面全部 + Markdown 真相源 + git 快照                |

> 入口有两个，汇进同一张图 A：
> `kernel.remember(candidate)`（P0a 手写候选）与
> `kernel.extract({sessionId, text|messages})`（P0b，§12.1：LLM 抽取 → `sanitizeCandidates` → isUseful → 四分类，然后逐条走图 A 的下半段）。
> 两者的差别只在"候选从哪来、要不要判重"——落盘、索引、配额是同一条管线，别修出两套行为。

---

## A. 索引路径（写入 → 派生层）

```
kernel.remember(candidate)
└─ write.persistNewEntry(c, domain, { reenqueue })
   ├─ validateCandidate(c)                   超长按句拆，拆不动截到句末 → {text, overflow?}
   ├─ usefulnessIssue(c) ──有理由─────────────> stashLowUtility → return {status:'low-utility'}  ✗ 短路
   ├─ buildEntry(c, domain, cfg, now)        生命周期/trust 初值 + embedding_pending=true
   ├─ tryConsumeQuota(domain, date) ──满─────> INSERT pending_candidates → return {status:'pending'} ✗ 短路
   ├─ security.signEntry(entry)              仅 requireSignature 域
   ├─ vec.embedTexts([text]) ──null─────────> 继续（embedding=null，不重试、不阻塞）
   ├─ writeMarkdownAtomic(entry)  ──throw───> rollbackQuota + rethrow（**不投索引**）
   ├─ dbTx(upsertEntryRow(db, entry))        真相源已落，这里只是同步
   └─ indexEntries([{ entryId, mdPath, embedding }])
      ├─ upsertFtsRow(e)              → entries_fts / entries_fts_cold（按 e.cold 选表）
      ├─ writeTripleRows(e)           → entry_triples（归一化只在这里发生）
      ├─ vec.upsert(e, embedding)     → entries_vec（路径 A/B/C，见下）
      ├─ bumpShardCount(domain, d)    → vec_shards（d='inserted' 才 +1）
      ├─ UPDATE entries SET embedding_pending   ← 拿不到向量时标 1（§18）
      └─ extendVocab(domain, triples)
   └─（事务外，按批去重）files.refreshFileSha(mdPath)
```

`rebuildAll()` 是同一形状的 **O(总量)** 版本：顺序固定为 files → entries → entry_triples → FTS 热/冷 → vec + 全量对账 → `clearVocab()`。
顺序反了就没有原文可展开（entries 在前）、或者 FTS 里混进冷条目（冷表单独写）。

### 节点

| 节点                              | 入                                             | 出                                                                       | 失败                                                                                                    | 谁消费                                                          |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `validateCandidate(c)`          | 候选                                            | `{text, overflow?}`，永不抛                                                     | 无失败路径：超长只截断，**不抛**（抛 = 整条消息不落库）                                                                          | `persistNewEntry`                                              |
| `usefulnessIssue(c)`            | 候选                                            | `null` 或原因串（`emoji-only`/`link-only`/`too-short`/`no-anchor`）                | 不失败；先判形态再判长度，否则纯表情会被归到 `no-anchor`，审计里看不到真因                                                             | `persistNewEntry`                                              |
| `buildEntry(c, domain, cfg, t)` | 候选 + 域 + 配置 + 时刻                                | 完整 Entry（`embedding_pending: true`，state 块首写就完整）                            | 不失败；**一个字段都不归一化**（R-83）                                                                                  | `persistNewEntry` / `handleUpdate` / 测试                          |
| `tryConsumeQuota(domain, date)` | 域 + 本地日                                        | boolean（事务内 SELECT + UPSERT，单进程单连接够用）                                       | 不失败；**按本地日切**（`cfg.storage.timezone`）。跨进程部署时要换成条件 `UPDATE ... WHERE count < quota`                        | `persistNewEntry`                                              |
| `vec.embedTexts(texts)`         | `string[]`                                    | `(Float32Array｜null)[]`，与输入等长                                              | 单条失败 → 该位 null；整体异常 → 全 null + 吞掉。**不经由这条路径抛给写入方**（嵌入失败是降级，不是写入失败）                                       | `persistNewEntry` / `classifyNovelty` / `backfillEmbeddings` / `rebuildAll` |
| `writeMarkdownAtomic(entry)`    | Entry                                         | 落盘路径                                                                     | **抛**：`persistNewEntry` 回滚配额后向上抛。锁内判满 → 换 part-00…05 重试 → 耗尽则超限写入 + `audit/part-overflow.log`（不抛）            | `persistNewEntry` / `handleUpdate`                             |
| `upsertEntryRow(db, e)`         | Entry                                         | 无（必须在 `dbTx` 内）                                                          | SQL 错误 → 事务回滚；Markdown 已在盘上，下轮 `rebuildAll` 或 dream 第 6 步自愈                                                 | `persistNewEntry` / `handleUpdate` / `step6ConsistencyRepair` / `rebuildAll` |
| `indexEntries(tasks)`           | `{entryId, mdPath, embedding?}[]`             | 无；副作用 = 5 张派生表                                                           | 单条缺 Entry → `audit.indexMissing` + continue（**不中断整批**）；事务内失败 → 整批回滚                                            | `persistNewEntry` / `handleUpdate`                             |
| `upsertFtsRow(e)`               | Entry                                         | 无                                                                        | 不失败；两次 DELETE + 一次 INSERT（`e.cold` 变了才换表）                                                                  | `indexEntries`                                                 |
| `writeTripleRows(e)`            | Entry（`triples` 是**原文**）                         | 无                                                                        | 不失败；先 DELETE 再按 seq 插。**唯一的归一化点**：`subjectKey` / `attributeKey`                                             | `indexEntries` / `rebuildAll`                                  |
| `vec.upsert(e, embedding)`      | Entry + 向量                                    | `'inserted'｜'replaced'｜'skipped'`                                           | 无向量 / 冷条目 / vec 关闭 → `'skipped'`（不是错误）；vec0 不支持 `INSERT OR REPLACE`，必须 DELETE + INSERT                    | `indexEntries` / `backfillEmbeddings` / `rebuildAll`            |
| `bumpShardCount(domain, d)`     | 域 + upsert 返回值                                 | 无                                                                        | `'skipped'` 直接 return；`'replaced'` 只刷时间戳（用 `+0` 的 UPSERT 会给不存在的域凭空建行）                                        | `indexEntries` / `backfillEmbeddings`                          |
| `files.refreshFileSha(p)`       | 分片路径                                          | 无（**必须在事务外**）                                                             | 文件消失 → 不报错；sha 落后是"下轮 6a 会重解析"，不是错误                                                                        | `indexEntries` / `step3SyncMarkdown` / `step8ColdArchive`      |
| `backfillEmbeddings(limit)`     | 批次上限                                          | `{scanned, embedded, stillPending}`                                      | vec 关闭 → 全 0；拿不到向量 → 保持 pending + `audit/vec-backfill-deferred`，下轮再来                                          | `kernel.init`（预热后多趟扫描）/ `runDream` / `kernel.backfillVectors` |
| `rebuildAll({clean})`           | IO 依赖                                         | `{files, entries, embedded, elapsedMs}`                                  | 单个坏文件 → `audit.unknown-file-pattern` + 跳过（不写 files 行）；嵌入不可用 → 向量段整体跳过，其余照建                                  | `kernel.init`（空库/维度变更）/ `kernel.rebuild`                      |

---

## B. 检索路径（四路召回 → 注入）

```
kernel.preStep / kernel.search
└─ retrieve.retrieve(req)
   ├─ domains.routeDomain(sessionId) ──null──> emptyResult() ✗ 短路
   ├─ classifyIntent(query, vocab) + PLANS[intent]
   ├─ Promise.all 并行召回（**fts / triple / recent 三路同步，vec 一路异步**）
   │   ├─ ftsSearch(query, domain, k)                  MATCH 显式 OR，ORDER BY bm25 升序
   │   ├─ tripleSearch(query, domain, k)               词表匹配 → JOIN 热条目
   │   ├─ recentWindowSearch(domain, k)                与 query 无关的"最近"先验
   │   ├─ vec.embedQuery(query) ───────────────────────> embedding-client → worker RPC（可超时→null）
   │   └─ ftsSearch(..., 'entries_fts_cold')           仅 include_cold，单独计时
   ├─ mergeFtsRoutes(fts, cold, coldRankOffset)       冷热合成**一条** fts 路
   ├─ shouldSkipVectorChannel(intent, query, domain, tripleHits)
   │     └─ true ──> vecHits = []（三路）
   ├─ vec.search(qVec, domain, k)                     内存精确索引 → 路径 A/B/C
   ├─ weightedRRF({vector, fts, triple, recent}, plan.weights, rrfK)
   ├─（relational 才）expandBySubject(fused, domain, plan.expand)   取 max 不累加
   ├─ loadEntries(db, ranked.keys(), {includeCold, includeArchived})
   ├─ 准入 + 验签 + 打分
   │   ├─ admit(e, domain, req)           minPersistence / cold / archived / identity_scope / allowlist
   │   ├─ security.verifyEntrySignature(e, getDomain) ──false──> audit.signatureFailure + continue
   │   └─ score = rrf × (1-α+α·p) × sigmoid(trust)
   ├─ 回读复核（over-read 后降权**再**截断）
   │   ├─ reReadAndCheck(e, domain)       仅 requireSignature 域；远程 reader 直接判不可用
   │   ├─ audit.rereadShadow(...)         P1 shadow：只记，不改分（rereadEnforcePenalty=false）
   │   └─ evidence<0.5 → 排除（**这条 P1 也生效**）
   ├─ write.recordActivations(top.ids, 'retrieval', t0)
   └─（verifiedEnabled 才）INSERT retrieval_log
```

### 节点

| 节点                                        | 入                                    | 出                                                                | 失败                                                                                                    | 谁消费                                          |
| ----------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `ftsSearch(q, domain, k, table)`          | query + 域 + k + 表名                    | `{id, score:bm25}[]`（**已按 bm25 升序**，位置即名次）                        | 无 token → `[]`（单字必然空，这是 bigram 的预期行为，不是 bug）                                                            | `retrieve` / 测试                                |
| `tripleSearch(q, domain, k)`              | query + 域 + k                        | `{id, score:hits}[]`                                             | 词表无命中 → `[]`；空返回率过低说明词表匹配过宽（P2 校准指标之一）                                                                | `retrieve`                                    |
| `recentWindowSearch(domain, k)`           | 域 + k                                | `{id, score: 1/(1+Δt/halfLife)}[]`                               | 永不为空（只要有热条目）；与 query 无关，是"最近"先验                                                                      | `retrieve`                                    |
| `vec.embedQuery(q)`                       | query                                | `Float32Array｜null`                                              | 未就绪 / 超时 → `null`（**降级，不重试、不重启 worker、不计入超时统计**）                                                      | `retrieve`                                    |
| `vec.search(q, domain, k)`                | 向量 + 域 + k                          | `{id, score: 1-distance}[]`（距离降序）                                | **内存索引（R-137）命中即返回**；不可用 / 脏 / 未加载失败 → `null` 交回调用方落路径 A/B/C（**绝不返回 `[]` 冒充「无命中」**）；vec 关闭 → `[]`；路径 B 抽干时按实有量给（<k 也给）；本域命中不足 k 时宁可少给，**不拿别域凑数** | `retrieve` / `classifyNovelty`                |
| `shouldSkipVectorChannel(...)`            | intent + query + 域 + tripleHits       | boolean                                                          | 不失败；非 factual / 无三元组命中 / 词数 < 2 → 一律 false（不跳过）                                                       | `retrieve`                                    |
| `mergeFtsRoutes(hot, cold, offset)`       | 冷热两路                                  | 一条 fts 路（冷条目名次 +offset）                                         | 不失败；**分开进 RRF 会让 fts 权重翻倍**                                                                          | `retrieve`                                    |
| `weightedRRF(routes, weights, rrfK)`      | 四路 + 意图书 + rrfK                       | `[{id, fused}]`（已降序，并列补 id）                                      | 不失败；两条不变式见 `test/baseline.test.js`（单路等价、权重单调）                                                         | `retrieve`                                    |
| `expandBySubject(fused, domain, opt)`     | 融合结果 + 域                              | `Map<id, score>`（取 max，不累加）                                      | 不失败；只取前 `maxSubjects` 个种子，每主体限 `maxPerSubject`                                                          | `retrieve`（仅 relational）                       |
| `loadEntries(db, ids, opt)`               | id 列表                                | `Map<id, Entry>`（**triples 已反序列化**）                              | 缺 id → 不出现在 map 里（下游 `continue`）；**不能用裸 `SELECT *`** 代替（R-90）                                        | `retrieve` / `kernel.context` / 组装              |
| `admit(e, domain, req)`                   | Entry + 域 + 请求                        | boolean                                                          | 不失败；`minPersistence` 用 `lazyPersistence`（有时钟）—— 准入不是硬过滤，属于这一层                                        | `retrieve`                                    |
| `verifyEntrySignature(e, getDomain)`      | Entry                                | boolean                                                          | 缺失签名 = 验签失败（低信任域静默排除 + `audit/signature-failures.log`）                                                | `retrieve`                                    |
| `reReadAndCheck(e, domain)`               | Entry + 域                            | `null`（非低信任域）｜`{unavailable, evidence, reason}`                   | 读失败/超时 → `unavailable`（**保留条目、不降权**）；空三元组 → evidence 0.5（不能 return 1，否则"不吐三元组就免检"）                   | `retrieve`                                    |
| `recordActivations(ids, kind, at)`        | id 列表                                | 无                                                                | 不失败；**只记事件，不动 persistence / trust**（命中不更新 trust，ADR-11）                                               | `retrieve` / `reinforceEntry` / `postStep`     |
| `retrieve.retrieve(req)`                  | `{sessionId, query, topK?, includeCold?}` | `{domain, entries, contexts, intent, skipVec, elapsedMs, coldScanMs}` | 无域 → `emptyResult`（不是异常）；`topK` 硬上限 50                                                                 | `kernel.search` / `kernel.preStep` / 工具          |

---

## C. 巩固路径（dream）

```
kernel.dream()  =  dream.run()  →  drainPending()  →  backfillEmbeddings()
└─ dream.run(opts)
   ├─ s1 step1GitSnapshot(ts)        git add <changed> + commit（禁 -A）
   ├─ s2 step2ComputeState(ts)       纯内存：只算 recorded_at <= ts 且非冷的条目
   ├─ s3 step3SyncMarkdown(patches, ts)   **真相源先落**，按分片分组 + 锁
   ├─ s4 step4SyncSqlite(patches, pendingSet, ts)  仅 landed；微批事务
   ├─ s5 step5TtlCleanup(ts)
   ├─ s6 step6ConsistencyRepair()    6a sha 比对 / 6b 幽灵分片 / 6c orphan
   ├─ s7 step7PatternMining(ts)      P3：信号达标的域出 fact 簇 → LLM 提炼（独立配额）
   ├─ s8 step8ColdArchive(ts)
   ├─ s9a step9aFtsOptimize()        P2 开：>500 删改或 >7 天才跑，不是每轮
   ├─ s9b step9bReconcileShards(touched)  + 9c 热区告警
   ├─ s10 step10IdentityMetrics(ts)  P2 开：身份分叉采集 + 告警（对齐是 P3+ 人工动作）
   ├─ s11 step11ConsumeSignals(ts)   P3：整批结算信号（没达标的继续攒，不清零）
   ├─ auditTopActivated(domain, 10)  并列补 id（R-87）
   └─ audit.dream(result)

kernel.maybeDream()  =  §17.1 的触发判断（信号 ≥ 阈值 或 空闲 ≥ idleMs）→ 满足才 runDream()
```

**两个顺序是硬约束**：真相源（s3）先于 SQLite（s4）；事件删除与状态 UPDATE 在**同一事务、按批收敛**。

### 节点

| 节点                                          | 入                          | 出                                           | 失败                                                                                                     | 谁消费                              |
| ------------------------------------------- | -------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `step1GitSnapshot(ts)`                      | 快照时刻                        | `{committed}`｜`{skipped}`｜`{failed}`           | 非 repo / 无变更 → skipped；git 失败 → `{failed}` **不阻塞后续步骤**，下轮重试                                              | `run`                           |
| `step2ComputeState(ts)`                     | 快照时刻                        | `[{e, p, hits, activation_count, last_activated_at, changed}]` | 不失败；`hits` 只数 `(last_decay_at, ts]` 窗口内的 retrieval/reinforce                                          | `s3` / `s4`                     |
| `step3SyncMarkdown(patches, ts)`            | patches                    | `Set<entryId>`（失败分片 → 本轮不写 SQLite）            | 分片写失败 → 整片进 pending 集（本轮内存集合，**不持久化**，R-46）；组内 sha 在锁内刷                                                 | `s4`                            |
| `step4SyncSqlite(patches, pending, ts)`     | patches + pending           | landed 条数                                    | 微批事务；**事件 DELETE 与状态 UPDATE 同事务**（否则某批失败 → hits 静默归零，R-57）                                             | `run`                           |
| `step5TtlCleanup(ts)`                       | 快照时刻                        | `{verifiedEvents, retrievalLog}`             | verified 表 P1 无写入 → 删 0 行（保留而不加开关）                                                                     | `run`                           |
| `step6ConsistencyRepair()`                  | 无                          | `{reparsed, reverseUpserts, orphans}`        | 文件消失 → 删 files 行；路径不合契约 → `audit/unknown-file-pattern`；orphan **只审计不删**（可能只是还没落盘）                         | `run` / `kernel`                |
| `step8ColdArchive(ts)`                      | 快照时刻                        | `{archived}`｜`{skipped}`                     | 移动失败 → `audit/cold-move-failed` + continue（条目留在热区，下轮再试）；两个文件各刷一次 sha                                     | `run`                           |
| `step9aFtsOptimize()`                       | 无                          | `{optimized, deletesSinceLast}`｜`{skipped}`    | 触发条件：删改 > 500 或距上次 > 7 天；不满足 → `no-need`（绝不空转）。计数是进程内软状态，重启多跑一次无害                                    | `run`                           |
| `step9bReconcileShards(touched)`            | 本轮 touched 域                | `{scope, drift[], hot}`                      | 不失败；分层不抽样：首轮 + 每 N 轮全量，其余只看 touched。漂移一律 `audit/shard-drift` 并**就地修正**。9c 热区告警带当前 `mode`（`mem-exact` 等）——**纯观测点**，内存精确索引（R-137）的扫描量就是这个数，不再挂「切 ANN」建议 | `run`                           |
| `step10IdentityMetrics(ts)`                 | 快照时刻                        | `{domains, forkedGroups}`｜`{skipped}`       | 不失败；判据 = 同 (subject, attribute) 在未取代条目里存活多个值。**只采集 + 告警，不自动合并**（P3+ 人工对齐）                      | `run` / `audit/identity-fork.log` |
| `step7PatternMining(ts)`                    | 快照时刻（读未消费信号）              | `{hotDomains, mined, quotaBlocked}`｜`{skipped}` | 域信号 < 阈值 → 不发任何 LLM 调用；未注入 llm → `no-llm`；LLM 判"不是模式" → 跳过；**独立配额挡住的簇计数留痕**                 | `run` / `write.persistPattern`   |
| `step11ConsumeSignals(ts)`                  | 快照时刻                        | `{consumed, score, hot}`｜`{skipped}`       | 不失败；**整批置 consumed，但分数是积分制**——没达标的域继续累计，清零等于推迟下一次爆发                                   | `run` / `kernel.maybeDream`      |
| `auditTopActivated(domain, n)`              | 域 + n                      | `[{id, activation_count}]`                   | 不失败；并列补 id（R-87），否则 audit 不可复现                                                                         | `run`（写进 `audit/dream.log`）     |
| `drainPending(domain, opts)`                | 域                          | `{scanned, consumed, expired, dropped, blocked}` | 坏 payload → 删 + `audit/pending-bad-payload`；过期 → 删 + 留证；**配额仍满 → 停**（不越权写）                              | `kernel.drainPending` / `runDream` |
| `backfillEmbeddings(limit)`                 | 批次上限                        | `{scanned, embedded, stillPending}`          | 见 A 图；dream 里是最后一环，兜住"预热窗口写入 + 日常 RPC 超时"两类漏网                                                        | `runDream`                      |
| `dream.run(opts)`                           | `{now?}`                    | `{snapshotTs, dream, steps, topActivated?}`  | 每步独立：一步失败不影响其余（`skipped` / 计数 0 / 进 pending）。**中途重启无需处理**：下轮对所有 `recorded_at <= snapshotTs` 重新结算（R-46） | `kernel.dream` / `kernel/idle`   |

---

## 附：三张图共用的降级开关

| 条件                             | 效果                          | 日志标签                |
| ------------------------------ | --------------------------- | ------------------- |
| 没装 sqlite-vec                  | 向量路整条关闭                     | `vec:disabled`      |
| 装了但 `< 0.1.6`（无分区键）            | 路径 C：每域一表                   | —                   |
| embedding worker 未就绪            | `embedQuery → null` → 三路召回   | `vec:not-ready`     |
| embedding RPC 超时               | 该轮 null → 三路召回 + 写入标 pending | `vec:rpc-timeout`   |
| 预热后补嵌扫到 pending              | 补进向量路、清 pending、同步 shard    | `vec-backfill-deferred`（仍拿不到时） |
| shard 计数漂移                     | 9b 就地修正                     | `shard-drift`       |
| 向量路关闭时写入                      | **不标** pending（没有可补的东西）     | —                   |

> 两类标签必须分开（`vec:not-ready` / `vec:rpc-timeout`）。
> 混在一起的日志会让 P0 第一次手动测试把"模型还在加载"误诊成"RPC 有 bug"，然后去调大 `rpcTimeoutMs`——调大只是把误判推迟，不解决问题（§11.1）。

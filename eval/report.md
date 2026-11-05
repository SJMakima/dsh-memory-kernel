# P2 校准报告

生成时间：2026-10-31T04:01:29.654Z

## 1. 检索质量对比（NDCG@5 / MRR / Recall@5）

| 配置 | n | NDCG@K | MRR | Recall@K |
| --- | --- | --- | --- | --- |
| weighted-default（文档起步值） | 25 | 0.3938 | 0.3767 | 0.46 |
| equal-weight（四路等权） | 25 | 0.3745 | 0.3667 | 0.42 |
| vector-only（纯向量） | 25 | 0.4302 | 0.3947 | 0.6267 |

> ⚠ **合成集上的对比只用于验证 harness 与方向性**：合成语料的嵌入走确定性哈希（词面哈希），"纯向量"的得分高是词面重叠的伪象，**不能据此得出"该用纯向量"的结论**——真实决策必须换真嵌入模型 + 真实查询重跑（§20：参数校准只能在真实数据上定稿）。

## 2. classifyIntent 判定准确率

准确率 **0.92**（n=25）。混淆分布：

| 标注 → 判定 | 条数 |
| --- | --- |
| factual→factual | 10 |
| explanatory→explanatory | 6 |
| explanatory→factual | 2 |
| relational→relational | 7 |

## 3. rrfK 单变量扫描

| rrfK | NDCG@K | MRR | Recall@K |
| --- | --- | --- | --- |
| 20 | 0.4076 | 0.3924 | 0.46 |
| 40 | 0.4118 | 0.4033 | 0.46 |
| 60 | 0.3938 | 0.3767 | 0.46 |
| 80 | 0.3542 | 0.34 | 0.42 |
| 100 | 0.2985 | 0.2857 | 0.36 |

NDCG 峰值在 rrfK=40；曲线平台区间内取中点即可，不值得为小数点后的差异换默认值。

## 4. alpha（衰减配比）单变量扫描

| alpha | NDCG@K | MRR | Recall@K |
| --- | --- | --- | --- |
| 0 | 0.3949 | 0.3883 | 0.46 |
| 0.15 | 0.397 | 0.3833 | 0.46 |
| 0.25 | 0.397 | 0.3833 | 0.46 |
| 0.4 | 0.3766 | 0.3667 | 0.42 |
| 0.6 | 0.3152 | 0.3 | 0.4 |

## 5. 意图 × 路权重单变量扫描（±50%，相对基线 NDCG 的变化）

**减半**：

| intent.route | NDCG | Δ |
| --- | --- | --- |
| factual.vector×0.5 | 0.4086 | +0.0148 |
| factual.fts×0.5 | 0.3938 | +0 |
| factual.triple×0.5 | 0.3938 | +0 |
| factual.recent×0.5 | 0.3938 | +0 |
| explanatory.vector×0.5 | 0.3766 | -0.0172 |
| explanatory.fts×0.5 | 0.3766 | -0.0172 |
| explanatory.triple×0.5 | 0.3966 | +0.0028 |
| explanatory.recent×0.5 | 0.3966 | +0.0028 |
| relational.vector×0.5 | 0.3953 | +0.0015 |
| relational.fts×0.5 | 0.3921 | -0.0017 |
| relational.triple×0.5 | 0.4093 | +0.0155 |
| relational.recent×0.5 | 0.3938 | +0 |
| temporal.vector×0.5 | 0.3938 | +0 |
| temporal.fts×0.5 | 0.3938 | +0 |
| temporal.triple×0.5 | 0.3938 | +0 |
| temporal.recent×0.5 | 0.3938 | +0 |


**翻倍**：

| intent.route | NDCG | Δ |
| --- | --- | --- |
| factual.vector×2 | 0.3886 | -0.0052 |
| factual.fts×2 | 0.4086 | +0.0148 |
| factual.triple×2 | 0.4086 | +0.0148 |
| factual.recent×2 | 0.4086 | +0.0148 |
| explanatory.vector×2 | 0.3966 | +0.0028 |
| explanatory.fts×2 | 0.3938 | +0 |
| explanatory.triple×2 | 0.3766 | -0.0172 |
| explanatory.recent×2 | 0.3766 | -0.0172 |
| relational.vector×2 | 0.4002 | +0.0064 |
| relational.fts×2 | 0.4093 | +0.0155 |
| relational.triple×2 | 0.3921 | -0.0017 |
| relational.recent×2 | 0.3938 | +0 |
| temporal.vector×2 | 0.3938 | +0 |
| temporal.fts×2 | 0.3938 | +0 |
| temporal.triple×2 | 0.3938 | +0 |
| temporal.recent×2 | 0.3938 | +0 |


不敏感（|Δ| < 0.005）：factual.fts、factual.triple、factual.recent、explanatory.triple、explanatory.recent、relational.vector、relational.fts、relational.recent、temporal.vector、temporal.fts、temporal.triple、temporal.recent、explanatory.vector、explanatory.fts、relational.triple —— 这些权重在校准上没有抓手，保持默认。

## 5b. 差分衰减 A/B（一半语料回填 40 天后对比半衰期档位）

| 档位 | NDCG@K | MRR | Recall@K |
| --- | --- | --- | --- |
| fact=15d/pattern=75d | 0.3484 | 0.3317 | 0.42 |
| fact=30d/pattern=75d（默认） | 0.3484 | 0.3317 | 0.42 |
| fact=60d/pattern=75d | 0.3657 | 0.3417 | 0.46 |
| fact=30d/pattern=40d | 0.3284 | 0.3183 | 0.38 |
| fact=30d/pattern=120d | 0.3684 | 0.3583 | 0.42 |


NDCG 最高：**fact=30d/pattern=120d**。差分在"老化条目"上才可观测；全量灰度时按域分布加权再看。

## 6. 路径 B over-fetch 放大代价

| 域向量数 | 表总量 | 占比 | k | 单次扫描行数 | 实返 | 浪费倍数 | 路径A成本 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 120 | 0.0833 | 3 | 84 | 3 | 28 | 3 |
| 10 | 120 | 0.0833 | 5 | 140 | 5 | 28 | 5 |
| 10 | 120 | 0.0833 | 8 | 216 | 8 | 27 | 8 |
| 30 | 120 | 0.25 | 3 | 12 | 3 | 4 | 3 |
| 30 | 120 | 0.25 | 5 | 20 | 5 | 4 | 5 |
| 30 | 120 | 0.25 | 8 | 32 | 8 | 4 | 8 |
| 80 | 120 | 0.6667 | 3 | 12 | 3 | 4 | 3 |
| 80 | 120 | 0.6667 | 5 | 20 | 5 | 4 | 5 |
| 80 | 120 | 0.6667 | 8 | 32 | 8 | 4 | 8 |

**取值建议**：占比 ≤ 0.0833 的域会触发阶梯翻倍（扫描 216 行 vs 路径 A 的 k 行）→ 这类小域适合让 minPartitionVectors 兜底到路径 A；当前默认 50 是否够，取决于真实表总量（占比 = 域向量 / 全表）

## 6b. 内存精确索引 vs vec0（R-137）

| 路径 | 向量数 | 查询数 | k | P50 ms | P95 ms |
| --- | --- | --- | --- | --- | --- |
| 内存精确索引（exactSearch） | 20000 | 20 | 8 | 1.777 | 2.11 |
| vec0 MATCH（每次搬 BLOB） | 20000 | 20 | 8 | 34.737 | 42.571 |

**常驻内存**：32.1 MB。**top-k 重叠率**：1。

内存精确索引比 vec0 快 19.5481×（P50）。top-k 重叠 1——两者都是精确扫描，重叠率低于 1.0 就是 bug 不是精度差，先查 swap-remove 的 id→下标映射。

## 7. detectVerified 误报率（verifiedEnabled 的打开判据，§16.2）

| 正例 | 命中 | 负例 | 误报 | 误报率 | 正例召回 | 触发/千轮 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 20 | 15 | 39 | 0 | 0 | 0.75 | 254 | 达标 |

误报 < 5% 且触发密度达标 → verifiedEnabled=true 维持

## 8. Security Suite：抽取保真（R-157 数据集①）

| 用例 | 结果 | 实得 |
| --- | --- | --- |
| 新协议干净输出 | ✓ | 用户喜欢喝美式咖啡 |
| 代码围栏 + 前后废话 | ✓ | 用户养了只猫叫煤球 |
| 思考混入（<think> 剥离，R-140） | ✓ | 用户养了一只猫 |
| 旧协议裸数组（mood 缺席 ≠ 平静） | ✓ | 用户每周五写周报 |
| 脏字段全部丢弃（LLM 幻觉不洗白） | ✓ | 用户在学 Rust |
| 非法 entry_type 兜底 fact；缺 text 丢弃 | ✓ | 用户讨厌香菜 |
| 全废输出（解析失败）= 零候选不炸 | ✓ |  |


清洗链全部保真

## 9. Security Suite：冲突消解（R-157 数据集②）

| 矛盾对 | 结果 | 实得裁决 | 期望 |
| --- | --- | --- | --- |
| 同三元组同值 = redundant（不新增） | ✓ | redundant | redundant |
| 同三元组新值 = update（取代旧账） | ✓ | update | update |
| 完全新事实 = new | ✓ | new | new |
| 字面几乎全同（向量不够线）= literalJaccard 兜底 redundant | ✓ | redundant | redundant |
| 同句式不同实体 = uncertain（实体锚定纪律：sim ∈ (0.80, 0.92) 且字面重叠 ≥2 才进确认池） | ✓ | uncertain | uncertain |


冲突裁决全部符合预期

## 10. Security Suite：隐私红线（R-157 数据集③，CI 红灯即失败）

| 矩阵行 | 结果 | 实得可见 | 期望 |
| --- | --- | --- | --- |
| normal 不受 origin 管控 | ✓ | true | true |
| private 同会话可见 | ✓ | true | true |
| private 跨会话隐藏 | ✓ | false | false |
| private 缺出身 = 拒（fail-closed） | ✓ | false | false |
| owner 白名单 + 缺 viewer = 拒 | ✓ | false | false |
| owner 白名单 + viewer=dad 可见 | ✓ | true | true |
| owner 白名单 + viewer=他人 = 拒 | ✓ | false | false |
| shared 跨会话默认隐藏 | ✓ | false | false |
| shared 跨会话 + crossSession 开 = 可见 | ✓ | true | true |
| shared + 白名单 + 缺 viewer = 拒（nonOwnerSeesShared 关） | ✓ | false | false |
| includePrivate 自报不是凭据（铁律①） | ✓ | false | false |
| context(entryId) 不绕过准入（铁律②） | ✓ | false | false |


隐私红线全部通过（无跨会话泄漏、无白名单绕过、无自报提权）

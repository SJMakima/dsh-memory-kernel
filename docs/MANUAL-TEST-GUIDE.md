# dsh-memory-kernel · Web 手动测试指南（v4.25 全量）

> 适用版本：v4.25（含连锁记忆、语义对账、日记向量路）。
> 测试环境：dsh web（`dsh.cmd web`）+ 设置页「记忆测试」分区 + 真实实例 `~/.dsh/memory-kernel-dsh`。
> 约定：**[web]** = 设置页操作，**[chat]** = 对话里对 Agent 说，**[verify]** = 验证点（audit 文件用记事本打开即可；SQL 用附录命令）。

---

## 0. 准备

1. 同步副本后重启 web（内核改动要重启才生效）：
   ```
   npm run sync:dsh && dsh.cmd web
   ```
2. 打开设置页 → 「记忆测试」分区（order 90，在最底部）。
3. 核对**运行状态**面板：插件开、条目总数与 `~/.dsh/memory-kernel-dsh` 一致、日记篇数、最近 Dream 时间。
4. 清一次基线：记下 dream.log / diary.log / route-scores.log 的当前行数（后面对比增量）。

---

## A. 基础链路

### A1 LLM 探针
- **[web]** LLM 接入卡片 → 填好 provider/model → 点「测试」。
- **[verify]** 返回 `✓ 通了（host / deepseek-chat，xx ms）` 且**文本非空**——注意看返回内容是不是正经回答（v4.21 的教训：探针只验通不验内容，思考混入时"通"是假的）。

### A2 记忆写入 + 判重
- **[chat]** 「记住：我测试用的密码提示是 8848」→ Agent 应调 `memory_remember`。
- **[chat]** 再说一遍同样的话 → 应返回 reinforce（同三元组不重复落）。
- **[verify]** 「打开 md 文件夹」→ 新 md 有对应块；状态面板条目总数 +1。

### A3 记忆检索 + 上下文注入
- **[chat]** 新会话里问「我测试密码提示是多少」→ Agent 调 `memory_search` 后答对。
- **[verify]** `audit/route-scores.log` 最新行：intent、vector/fts/triple 三路命中数；`audit/assemble.log` 有 stable-rebuild 或注入记录。

### A4 回源（memory_context）
- **[chat]** 「把那条密码记忆的完整来源给我」→ `memory_context` 返回 entry 全文 + source_ref。
- **[verify]** locator 指向的 md 文件确实存在。

---

## B. 抽取与情绪（R-140 / R-142）

### B1 自动抽取
- **[chat]** 随便聊几句含事实的内容（如「我这周末要去看牙医」）。
- **[verify]** 下次 dream 后（或手动「执行 Dream」）条目新增；`audit/extract-failed.log` **无新增行**（有新增 = 抽取失败，看 raw 字段归因）。

### B2 情绪判读
- **[chat]** 带情绪地说：「今天真的烦死了，项目又改需求」（第一人称强表述）。
- **[verify]** SQL：`SELECT * FROM emotion_log ORDER BY ts DESC LIMIT 3` —— user 行 emotion=anger 且 strong=1；agent 行是"表现出的"情绪；note 有注脚。
- 拿不准的轮次 emotion 应为 NULL（判读纪律），不硬填。

### B3 内心自述（felt 第一手）
- **[chat]** Agent 回复后，对它说「记一下你刚才的内心活动」→ 触发 `memory_inner`。
- **[verify]** `SELECT * FROM inner_log ORDER BY ts DESC LIMIT 1`，source=self 的注脚属于她自己的视角。

---

## C. 日记（R-139 / v4.21 / v4.25）

### C1 生成日记
- **[web]** 昨天聊过天的话，点「执行 Dream」→ 状态面板日记数 +1，标注「AI 写」。
- **[verify]** `audit/diary.log` 最新行 `generatedBy:"llm"`（template = LLM 路失败，先查 llm-unparseable 事件）；md 落在 `domains/<域>/diary/日期.md`，六节齐全。

### C2 日记回溯（diaryHits）
- **[chat]** 「我有没有提过想学吉他这类的话」（无日期的关键词回溯）。
- **[verify]** route-scores 的 diary 命中；回复里引用了日记内容。

### C3 日记向量路（v4.25 新）
- **[chat]** 问一个**字面不同、语义相同**的问题——如日记里写了"煤球"，就问「我的猫生病是什么时候」（"猫"≠"煤球"字面）。
- **[verify]** 日记被召回；SQL 侧 `SELECT date, embedding IS NOT NULL AS has_vec FROM diary` 全部 has_vec=1（rebuild 后即为 1）。
- 旧行为对照：v4.24 前 FTS 只认字面，这条查询应该空——现在应命中。

### C4 当日档案（日期查询）
- **[chat]** 「回忆一下 X 月 X 号那天我们聊了什么」（明确日期）。
- **[verify]** 回复含那天日记 + 原话 + 情绪序列（当日档案是四路召回盲区的唯一通道）。

---

## D. 连锁记忆（v4.24）

### D1 声明边（extract 两遍法）
- **[chat]** 一段话里给两条强关联事实：「记住两件事：一，我下个月要去成都出差；二，就是因为去成都，我推迟了体检」。抽取 LLM 若输出 links，两条目间会落 causal/coexist 边。
- **[verify]** SQL：`SELECT * FROM entry_links ORDER BY created_at DESC LIMIT 5` —— source='extract'。注意：LLM 不一定每次输出 links（提示词"宁缺毋滥"），D3 的共现边才是量的主力。

### D2 检索走边（expandByLinks）
- **[chat]** 问「因为出差的事，我还改了什么计划」（relational 线索词：因为/所以/关系/上次）。
- **[verify]** SQL 先给种子条目插一条测试边（见附录），然后检索结果应包含边对端的条目；无关条目不被波及（边表里它没有边）。

### D3 共现边自长（s13）
- **[chat]** 同一话题连聊 3~4 轮（每轮都会写 retrieval_log，同轮命中的条目对计数）。
- **[web]** 点「执行 Dream」。
- **[verify]** SQL：`SELECT * FROM entry_links WHERE source='dream' ORDER BY created_at DESC` —— 共现 ≥3 次的对出现双向 coexist 边；单条目 dream 边 ≤8（防蜘蛛网）。
- 之后问「聊到咖啡的时候你还会想起什么」，连锁条目应顺势出现。

---

## E. 语义对账（v4.25 s14，R-120 红线）

### E1 矛盾只告警不清理
- **[chat]** 先「记住：我最喜欢的颜色是蓝色」，隔几句再「更正一下，我最喜欢的其实是红色」。
  （更正条目会经 R-120 工具描述的"先查后写"正常取代；要测**对账**需要两条**并存且互斥**的账——让 Agent 用 memory_remember 写"用户喜欢蓝色"和"用户讨厌蓝色"各一条，不让它取代。）
- **[web]** 「执行 Dream」。
- **[verify]**
  - `audit/dream.log` 最新行 s14：`{checked: N, conflicts: 1}`；
  - audit 里新增 `cross-entry-conflict` 事件，含两条文本与 note；
  - SQL：`SELECT COUNT(*) FROM consolidation_signals WHERE kind='cross-entry-conflict'` ≥1；
  - **红线验证**：两条目仍在、md 未被改（打开对应 md 对比）。
- 无 LLM 时 s14 应返回 `skipped:"no-llm"`，不报错。

---

## F. 原话与泛句（R-141 / v4.25）

### F1 原话双路召回
- **[chat]** 之前聊过的内容，换说法问：「我当时是不是发过一句关于 X 的原话」（X 与原话词面不同）。
- **[verify]** 回复引用了原话片段（transcripts 独立段）。

### F2 泛句降权（v4.25 新）
- **[verify] 前置**：SQL 找一句出现 ≥3 次的口头禅：`SELECT text, COUNT(*) c FROM transcript WHERE domain_id='dsh' GROUP BY text HAVING c>=3 ORDER BY c DESC LIMIT 5`。
- **[chat]** 问一个与口头禅无关、但 lexvec 可能泛匹配的问题（如「他聊天的时候是什么语气」）。
- **[verify]** 口头禅句即使被召回也排在**信息量更大的句子**之后；把 `transcript.demoteRepeat` 配成 0 后对比，顺序应回到降权前。

---

## G. 巩固与重建

### G1 手动 Dream 全流程
- **[web]** 「执行 Dream」→ **[verify]** `audit/dream.log` 最新行 steps：s1 快照、s2 衰减 changed 数、s5 TTL、s7 pattern（无 LLM 跳 no-llm）、s8 冷存、s12 日记、s13 `{pairs,edges}`、s14 对账结果。每步有值且无 error 即健康。

### G2 Rebuild 派生层
- **[web]** 点「Rebuild 派生层」→ 进度条走完（扫描→条目→FTS→向量→收尾）。
- **[verify]** 完成消息条目数与状态面板一致；随后 A3 检索照常命中（重建不丢记忆）；日记向量路 C3 的 has_vec 仍全 1（rebuildFromMd 回填生效）。

---

## H. 开关与安全

### H1 总开关闸
- **[web]** 功能开关面板关总开关 → **[chat]** 再问记忆问题 → Agent 检索应短路（返回里 skipped:disabled），且**历史注入的记忆也被剥离**。
- 测完记得开回来。

### H2 会话屏蔽
- **[web]** 会话面板把测试会话加入屏蔽 → 该会话内记忆工具全部返回 skipped → 解除后恢复。

### H3 新增域
- **[web]** 新增一个测试域 → 新会话落到该域（会话前缀路由）→ 该域的 md 独立目录生成 → 删除/停用不影响主域。

### H4 身份分叉
- **[web]** 分叉面板（s10 产出）——有分叉时逐条确认流程可用，无分叉显示空态。**绝不自动合并**，人工确认式对齐。

## I. 记忆检索·人类视图（v4.28，R-63 收尾）

### I1 设置页检索面板
- **[web]** 「记忆检索」面板：选域 → 输关键词（如"五一""煤球"）→ 检索。每条结果应带：信任档位（本域可信/未经确认）、entry_type、记于日期、重要度、来源、条目 id。
- **[verify]** 信任档位与注入给 LLM 的标签同一套判定：本地正常写入的条目应显示"本域可信"；若用 R-107 外部导入或 `trustedSource:false` 的域，应显示"未经确认"。检索走的管线与 Agent 相同（admit+验签），所以 Agent 能查到的这里也能查到，反之亦然。

### I2 低信任复述的口头声明（Agent 侧半边）
- **[chat]** 造一条 `[第三方内容，未经确认]` 的记忆（低信任域写入或外部导入），再问相关问题让 Agent 复述 → 她应口头带一句来源档次（"这条是我从别处记来的，还没跟你核实过"），而不是当亲历事实陈述。
- **[verify]** 抽查 GUIDE：`src/pure/assembly.js` 的 GUIDE 末尾有【来源档次】条款（"你可以被纠正，不可以被误信"）。

---

## 附录

### SQL 查询（Git Bash / PowerShell 通用，从插件目录跑）

```bash
cd ~/.dsh/plugins/dsh-memory-kernel   # 或开发目录，反正要有 better-sqlite3
node -e "
const db = require('better-sqlite3')(process.env.HOME + '/.dsh/memory-kernel-dsh/index.db', {readonly:true});
// 换成要查的语句：
console.log(db.prepare('SELECT * FROM entry_links ORDER BY created_at DESC LIMIT 10').all());
"
```

常用表：`entries`（记忆）、`entry_links`（连锁边）、`emotion_log`（情绪）、`inner_log`（内心）、`diary`（日记）、`transcript`（原话）、`retrieval_log`（检索记录）、`consolidation_signals`（巩固/冲突信号）、`pending_candidates`（待定池）。

### audit 文件含义

| 文件 | 内容 | 什么时候看 |
|---|---|---|
| dream.log | 每次 dream 全步骤结果（s1~s14） | dream 后整体体检 |
| diary.log | 日记写入（generatedBy）/ llm-unparseable / llm-failed | 日记退模板时 |
| route-scores.log | 每次检索三路命中与意图 | 检索质量排查 |
| assemble.log | 组装注入 | 记忆没进上下文时 |
| extract-failed.log | 抽取失败（含 LLM 原文前 400 字） | 条目没落时第一现场 |
| cross-entry-conflict 等 | s14 告警明细 | 语义对账触发后 |

### 常见故障速查

| 症状 | 先查 |
|---|---|
| 日记是模板不是 AI 写 | diary.log 有无 llm-unparseable（maxTokens 截断家族）；LLM 卡片探针 |
| 记了但检索不到 | route-scores 三路是否全零 → LLM/嵌入是否可用；总开关是否被关 |
| 条目没落 | extract-failed.log；usefulness（too-short/no-anchor）|
| 连锁没生效 | entry_links 有没有行（先看边生产，再问 relational 触发）；intent 是否判成 relational |
| 对账没有 pairs | 近 14 天有没有新账、向量路是否可用、llm 是否可用 |

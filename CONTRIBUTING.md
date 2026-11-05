# 贡献指南

## 先读这三份

改动内核前请先过一遍——这个项目的很多"看起来多余的代码"是在钉住已定义行为：

1. `README.md` §4（关键实现点）与 `docs/INVARIANTS.md`（I1~I12 不变量）
2. `docs/callgraphs.md`（写入索引 / 检索 / dream 三张函数级调用图）
3. `docs/host-compat-matrix.md`（宿主兼容矩阵，claimed / verified / TBD 三态）

## 规矩

- **不变量是硬的**：任何 PR 若触碰 I1~I12 覆盖的路径（fail-closed 默认、单写者锁、出身链、准入门），必须在 PR 描述里说明"动了哪条、为什么没破坏"。
- **测试跟着行为走**：修 bug 必须带回归钉子（钉住"为什么以前是错的"）；改行为必须先更新或删除旧钉子，不许静默改断言。
- **诚实性**：门禁（`npm test` / `npm run eval:privacy`）红了就是红了，禁止放宽断言或跳过用例来凑绿。CHANGELOG 只写真实发生的变更。
- **默认 fail-closed**：拿不准的错误处理一律选择拒绝，而不是"恰好能跑"的放行。

## 本地验证

```bash
npm install
npm test                       # 全量 328+ 条
npm run eval:privacy           # 隐私红线 12 项（退出码即门禁）
node --test --test-concurrency=1   # 与发布门禁同款串行模式（wall-clock 断言在并发下会抖）
```

提交前请确认上述命令在你改动后仍然全绿。

## 提交格式

标题一行说清"动了什么"；正文说明动机与取舍。涉及不变量路径的按上面的规矩附说明。

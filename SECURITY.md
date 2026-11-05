# 安全政策

## 报告漏洞

这是一个**长期记忆内核**——它存储的记忆内容可能包含用户的私人对话、个人事实与身份信息，安全问题的分量请按这个前提估。

请**不要**通过公开 GitHub Issue 报告漏洞。请私下联系仓库所有者（GitHub 个人页的联系方式），或提交一份**不公开细节**的 issue 仅注明"安全报告，详情已私信"。

我们承诺：

- 48 小时内确认收到；
- 修复期间在 docs/INVARIANTS.md 的不变量框架内评估影响面；
- 修复发布后在 CHANGELOG 致谢报告者（除非要求匿名）。

## 当前安全设计入口

审阅本项目的安全模型请从这三份文档入手：

- `docs/INVARIANTS.md`：I1~I12 不变量清单（fail-closed 是默认姿态）
- `docs/host-compat-matrix.md`：claimed / verified / TBD 三态的宿主兼容矩阵
- `eval/security-eval.js` + `npm run eval:privacy`：隐私红线对抗集（12 项，任何一项红灯即发布失败）

## 已知边界

- DSH 宿主集成的真机回归存在待验项（见 README §0.5 的验证边界声明），不代表整体不可用，但引用前请核对该矩阵的 TBD 格子。

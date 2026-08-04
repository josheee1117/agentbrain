# CLAUDE.md

## 项目定位

agentbrain：Claude Code / Codex 通用记忆机制。abrain 思想（结构性沉淀、L1 证据→L2 投影、分层读取）× pensieve 跨端配方（纯文本数据、hook 只做加速器、marker 块注入）。

## 当前状态（2026-08-04）

- 设计 v1.1 已定稿：`docs/design/20260804-agentbrain-总体设计.md`——**任何实现工作开工前先完整读它**，全部已拍板决策、三级检索栈、宿主适配、M0-M4 里程碑、abrain 架构全景参考（附录 A）都在里面。
- **实现未开始**。第一步是 M0 spike（设计 §12）：Codex notify/rollout 格式实测 + Claude Stop hook detached 拉起 `claude -p` 全链路 PoC。

## 约定

- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外的功能/抽象/防御分支；v1 明确放弃项见设计 §3，不要"顺手"实现它们。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

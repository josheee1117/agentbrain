# CLAUDE.md

## 项目定位

agentbrain：以 abrain 为架构母体的本地 Agent 记忆系统。v2 首发宿主为 Pi，核心是结构性沉淀、统一 proposition、L1 证据历史→L2 确定性投影→L3 可重建索引、分层读取、Agent Loadout 与子代理委派。TencentDB Agent Memory 只作为机制对照，不定义产品边界。

## 当前状态（2026-08-21）

- `docs/design/20260804-agentbrain-总体设计.md` 已原地升级为 **v2 architecture baseline**——任何实现工作开工前必须完整阅读。
- **实现未开始，也尚未授权。** 设计 §19 列出的 L1×Purge、Durable Work Store、Pi Worker、L2、Project Binding/Loadout/委派、Sediment、检索、迁移、Forgetting/Outcome、Operations/Recovery 和 Acceptance/Rollout Gates 必须先关闭。
- 当前路线由 GitHub Wayfinder map 管理：`https://github.com/josheee1117/agentbrain/issues/1`。未指定 ticket 时先处理其 frontier，不跳过依赖直接实施。

## 约定

- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外功能/抽象/防御分支；v2 正式范围、seam 与 out-of-scope 见设计 §4/§20，不要把 Design Gate 当作实现者自由选项。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

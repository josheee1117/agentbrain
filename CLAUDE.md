# CLAUDE.md

## 项目定位

agentbrain：以 abrain 为架构母体的本地 Agent 记忆系统。v2 首发宿主为 Pi，核心是结构性沉淀、统一 proposition、L1 证据历史→L2 确定性投影→L3 可重建索引、分层读取、Agent Loadout 与子代理委派。TencentDB Agent Memory 只作为机制对照，不定义产品边界。

**产品前提：在 Pi 上取代 abrain 现役实现，不长期并存（设计 §2.1）。** Pi-only 是替代前提而非宿主收窄。替代动机**首先是所有权脱钩**，其次是复杂度；"更好"是复合判据——脱钩 + 复杂度可量化下降（设计 §2.2：配置键 162→≤35、迁移期双写门 17→0，行数不作判据）。代码 clean-room 自写，abrain 只当规格读（§12.5）。

## 当前状态（2026-09-14）

- `docs/design/20260804-agentbrain-总体设计.md` 已升级为 **v2.4 场景基线**——开工前必须完整阅读，尤其 §15.5 的四个真实场景、§18 的切片表与 §21 v2.4 条目。
- **切片 1 已授权实施**（2026-09-14）。代码在本仓 `extension/`，经 `~/.pi/agent/extensions/agentbrain` 符号链接被 Pi 加载。切片 2-4 各需单独授权（§19.13）。
- 已裁决的物理形态：`~/.agentbrain/store.db`（L1 + work store）+ `index.db`（FTS5，可删重建）；不透明 event_id + 自增定序；L2 为纯函数；进程内 worker；来源为 Source Pointer 不存摘录。
- 已关闭或推后：§7.4 共存/切换（abrain 已卸载）、#7 迁移（可选）、Corroboration、三层链第 2/3 层、Delegation Grant、Purge 传递闭包（均在切片 4 之后）。
- 本机现役子代理宿主是 `pi-subagents`，不是 pi-astack dispatch；其子会话无持久 session 文件，按 Ephemeral 处理。

## 约定

- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外功能/抽象/防御分支；v2 正式范围、seam 与 out-of-scope 见设计 §4/§20，不要把 Design Gate 当作实现者自由选项。
- 复杂度纪律（§2.2）：预算类参数（超时、重试、批大小）默认写死在代码里，不新增配置键；确需按机器或阶段调整的才留成配置。任何"迁移期双写门"形态的开关都不得引入。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

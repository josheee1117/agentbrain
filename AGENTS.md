# CLAUDE.md

## 项目定位

agentbrain：以 abrain 为架构母体的本地 Agent 记忆系统。v2 首发宿主为 Pi，核心是结构性沉淀、统一 proposition、L1 证据历史→L2 确定性投影→L3 可重建索引、分层读取、Agent Loadout 与子代理委派。TencentDB Agent Memory 只作为机制对照，不定义产品边界。

**产品前提：在 Pi 上取代 abrain 现役实现，不长期并存（设计 §2.1）。** Pi-only 是替代前提而非宿主收窄。替代动机**首先是所有权脱钩**，其次是复杂度；"更好"是复合判据——脱钩 + 复杂度可量化下降（设计 §2.2：配置键 162→≤35、迁移期双写门 17→0，行数不作判据）。代码 clean-room 自写，abrain 只当规格读（§12.5）。

## 当前状态（2026-09-07）

- `docs/design/20260804-agentbrain-总体设计.md` 已原地升级为 **v2.2 architecture baseline**——任何实现工作开工前必须完整阅读，尤其 §21 修订记录的 v2.2 条目（23 条架构决定 + 六处已解决冲突）。
- **实现未开始，也尚未授权。** 设计 §19 仍未关闭的 gate：L1×Purge 物理身份/tombstone、Durable Work Store、Pi Worker 拓扑、L2 Contract、Project Binding/Loadout/委派、Sediment Promotion 与 §19.6 四项 Corroboration 参数、检索、Store/迁移、Operations/Recovery、运行期共存/Cutover、Acceptance/Rollout。
- **已裁决出 gate 体系**：子代理执行拓扑（§6.4 只留接缝）、自治遗忘（§10.3 出 v2 范围）。
- **P0/P1 已换序**：先做 L1/Purge 状态机 prototype（P1），Pi lifecycle prototype（P0）排后（§18）。
- **当前关键路径**：迁移源资产盘点（issue #7）。按 §12.4 的人工挑选口径，它已收窄为"提供可浏览清单供人工挑选"，隐私 gate 基本退出关键路径，但 §12.3 隐私纪律不变。
- 当前路线由 GitHub Wayfinder map 管理：`https://github.com/josheee1117/agentbrain/issues/1`。未指定 ticket 时先处理其 frontier，不跳过依赖直接实施。

## 约定

- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外功能/抽象/防御分支；v2 正式范围、seam 与 out-of-scope 见设计 §4/§20，不要把 Design Gate 当作实现者自由选项。
- 复杂度纪律（§2.2）：预算类参数（超时、重试、批大小）默认写死在代码里，不新增配置键；确需按机器或阶段调整的才留成配置。任何"迁移期双写门"形态的开关都不得引入。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

# CLAUDE.md

## 项目定位

agentbrain：以 abrain 为架构母体的本地 Agent 记忆系统。Pi、Claude Code、Codex 三个宿主平等接入（统一入口 `ab` 命令行；记忆分全局与项目两级，项目清单以 pm 的 `repos/*.md` 为准），核心是结构性沉淀、统一 proposition、L1 证据历史→L2 确定性投影→L3 可重建索引、分层读取、Agent Loadout 与子代理委派。TencentDB Agent Memory 只作为机制对照，不定义产品边界。

**产品前提：宿主无关的个人 Agent 记忆（设计 §2.1，v2.5）。** 先把记忆本身做好，首个替代对象是 Pensieve；是否接管 pm 的非记忆职责等记忆核心成熟后再定。动机**首先是所有权脱钩**，其次是复杂度；"更好"是复合判据——脱钩 + 复杂度可量化下降（设计 §2.2：配置键 162→≤35、迁移期双写门 17→0，行数不作判据）。代码 clean-room 自写，abrain 只当规格读（§12.5）。

## 当前状态（2026-10-12）

- `docs/design/20260804-agentbrain-总体设计.md` 已升级为 **v2.6 宿主无关基线**。开工前必须完整阅读，尤其 §2.1、§7、§15.5、§18 的切片表与 §21 v2.6 条目。切片 2 范围含向量检索。
- **切片 1 已实现（仅 Pi）**。代码在本仓 `src/`；Pi 侧符号链接目前停用（`~/.pi/agent/extensions-disabled-agentbrain`）。切片 1.5 已于 2026-10-10 实现；之后各切片需单独授权（§19.13）。
- **切片 2 代码完成（2026-10-10）**：correct、混合检索（RRF，门槛 0.45，召回 0.55）、`ab recall --hook` 每轮召回、Memory Card 冲突暴露（待确认纠正）、`ab get` 近邻、L2 类型集中在 `src/l2.ts`。接线样例在 `integrations/`；2026-10-12 已接入用户机器三个宿主的全局配置，§15.3 实测 Codex、Pi 通过，Claude Code hook 输出正常、模型侧因网关 400 待复验（见设计 §21 2026-10-12 条目）。评测语料在仓库外 `~/.agentbrain/eval/`。切片 2.5 需单独授权。
- **切片 3 代码完成（2026-10-12，先于 2.5，用户授权见设计 §21 同日条目）**：`ab capture --hook` 登记会话坐标（只存坐标不存正文），`ab work` 短命进程 + 单实例租约，直连 OpenAI 兼容 chat 接口抽取（用户选定 agentrouter.org `deepseek-v4-flash`，地址与模型在 `~/.agentbrain/extract.json`，key 在钥匙串 `agentbrain-extract`），送模型前与写 L1 前两次脱敏，引文逐字核对，准入矩阵无审批 inbox；`ab work --sweep` 按项目真实代码只读核验未确认的坑/事实并转正，规则/决定靠两个以上会话的用户原话印证；`ab doctor` 报积压、失败与转正。§19.3 已关闭。接线样例在 `integrations/`（含 launchd），尚未装到用户机器；真实模型调用未跑。试探召回（D3）未决。
- 切片 1.5 已删除 Pi 扩展与 `/ab bind`；宿主接线与会话身份的实测依据见设计 §7.1。
- 已裁决的物理形态：`~/.agentbrain/store.db`（L1 + work store）+ `index.db`（FTS5，可删重建）；不透明 event_id + 自增定序；L2 为纯函数；来源为 Source Pointer 不存摘录（v2.5 泛化为 host + session id + transcript + 定位点）。
- 已关闭或推后：§7.4 共存/切换（abrain 已卸载）、#7 迁移（可选）、Corroboration、三层链第 2/3 层、Delegation Grant、Purge 传递闭包（均在切片 4 之后）。
- 本机现役子代理宿主是 `pi-subagents`，不是 pi-astack dispatch；其子会话无持久 session 文件，按 Ephemeral 处理。

## 约定

- 设计/技术文档：文件名带 YYYYMMDD 日期；每主题只留一份最新文档，原地覆盖修订，变更摘要写进文档内"修订记录"，不靠多文件保历史。
- 新决策：先记入设计文档"修订记录"（含理由）；与已有决策冲突时停下问用户。
- 非平凡改动实现前必须先更新设计文档并获用户明确授权（"开始实现"/"按这个做"）。
- 范围纪律：不加任务外功能/抽象/防御分支；v2 正式范围、seam 与 out-of-scope 见设计 §4/§20，不要把 Design Gate 当作实现者自由选项。
- 复杂度纪律（§2.2）：预算类参数（超时、重试、批大小）默认写死在代码里，不新增配置键；确需按机器或阶段调整的才留成配置。任何"迁移期双写门"形态的开关都不得引入。
- 参考实现在 `~/code_me/pi-astack/extensions/{abrain,sediment,memory,_shared}`（只读参考，勿改动）。

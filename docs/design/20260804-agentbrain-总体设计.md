# agentbrain 总体设计

- 状态：**v2.2 架构基线，实施受 Design Gates 阻断**
- 最新修订：2026-09-07
- 实现状态：**未开始**
- 设计母体：abrain 的 event-first、统一命题、结构性沉淀、确定性投影、分层读取与自治纠错纪律
- 首发宿主：Pi；v2 不承诺其他宿主
- **产品前提：在 Pi 上取代 abrain 现役实现，不长期并存（§2.1）；动机首先是所有权脱钩，其次是复杂度（§2.2 定量）**
- 决策地图：[绘制以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
- 领域词汇：`CONTEXT.md`
- 主要证据：
  - `docs/reference/20260804-pi-astack-abrain-sediment-架构与实现参考.md`
  - `docs/research/20260820-tencentdb-agent-memory-调研.md`
  - `docs/research/20260821-pi-memory-集成与子代理接缝.md`
  - `docs/research/20260821-current-abrain-sediment-复核.md`
- 引用基线：pi-astack fork `ad6aa8f`（本机现役，pre-DCC）；alfadb `upstream/main` `f5e955e`（§19.3 要求先读的上游演进）；`earendil-works/pi@5cd93f6`

> 本文是一份完整的 **architecture baseline**：产品边界、领域不变量、权威模型、Pi 边界、读写路径、隐私安全、Loadout/子代理、验证和候选里程碑已经明确。本文不会把尚未验证的物理存储、Purge 身份模型、Worker 进程拓扑或检索算法伪装成已拍板；这些事项列在 §19，关闭前不得开始生产实现。

---

## 1. Destination

agentbrain v2 要交付一个以 abrain 为母体的本地记忆系统：

1. 自动从 Pi 的真实工作生命周期捕获工程证据；
2. 将来源、推断和生命周期变化写入可追踪的 L1 权威历史；
3. 以确定性方式投影出当前可读、可纠正的 L2 记忆；
4. 通过可重建 L3 索引和分层读取，为主 Agent 与子代理提供精准、受控、可解释的上下文；
5. 支持用户自然纠正、语义遗忘和受控物理清除；
6. 形成可以复现的中文检索、隔离、重建和 Pi 端到端验证体系；
7. 从 TencentDB Agent Memory 选择性吸收能补强 abrain 的机制，而不复制其团队 Memory Hub、语义 L0-L3 或分散 authority。

最终成功不是“拥有更多记忆对象”，而是以下七个场景稳定闭环：

- 项目决策延续；
- 稳定偏好延续；
- 跨会话工作连续性；
- 子代理精准交接；
- 错误和过期记忆校准；
- 重要结论来源可追踪；
- 无关项目、未激活资产和委派范围外内容不误注入。

---

## 2. 为什么重做 v1.2

v1.2 的核心价值仍成立：L1→L2→L3、结构性 sediment、分层读取和显式降级。但其产品和宿主假设已经错位：

- 以 Claude Code / Codex hooks 为首发边界；
- 默认 `~/.agentbrain/` 是 Git canonical repo；
- M0 围绕 Codex rollout 和 Claude Stop hook；
- 没有正式建模 Agent Definition、Agent Execution、Loadout 和子代理委派；
- 对 Proposal、accepted memory、冲突和人工校准的关系表达不足；
- append-only 与 Physical Purge 的冲突未进入设计；
- 把 L3 jobs/queue 与“L3 可完全丢弃”混在一起；
- 三级检索栈被提前写成实现答案，缺少固定评测集裁决。

v2 因此不是增量补丁，而是以当前 abrain 的统一 proposition 模型为起点，重新画清产品边界和运行合同。

### 2.1 替代前提（LOCKED）

**agentbrain v2 的目标是在 Pi 上取代 abrain 的现役实现，不是与它长期并存。Pi-only 不是宿主收窄，而是替代前提。**

这一句决定 §18 全部里程碑值不值得做：如果 agentbrain 只是"多一个记忆系统"，M1-M6 的成本无法证明；只有当它最终接管 abrain 在本机承担的职责，替代成本才有归宿。三条直接后果：

1. **cutover 不是 M6 末尾的收尾动作，而是前置条件轨**（§18 T0、§12.3）；
2. **运行期共存必须设计**，不能只在 store 层声明单 canonical owner（§7.4）；
3. **验收必须能回答"是不是比原来好"**，只测正确性不变量不够（§15.5）。

替代不等于功能对等复制。abrain 的复杂度有两个来源，必须分开处理：

- **场景复杂度**：多平台（Windows 原生 ACL）、双仓 implementation authority、staged rollout、生产验收。以 ADR 0046 DCC 为例，其 status 行塞满 staged install 哈希、D0-D5 切片和跨 pi-astack/pi-router 的权威划分——这些在 agentbrain 的单用户单机边界下天然掉掉大半。
- **纪律**：event-first、单一 canonical owner、确定性投影、authority 显式化、fail-closed、可逆终态。这些必须留下。

**替代动机首先是所有权。** abrain 的有效性不是痛点——正因如此它才继续作为架构母体（§1）。驱动替代的是这套系统必须是自己的：能完整读懂、能独立演进、不受上游路线牵引。次要动机是复杂度：abrain 对单用户而言过重。

因此**"更好"是复合判据：所有权脱钩 + 复杂度可量化下降**，两条都要，不是二选一。复杂度下降必须来自**掉场景复杂度**而非**掉纪律**。口径与目标值见 §2.2。

同时要诚实记账：v2 有一处是**真实增量而非简化**——abrain 至今没有 Physical Purge（其路线是内容寻址 + append-only + 可逆终态，ADR 0043 明确把"终态 cleanup 退化成物理删除"列为要规避的风险）。agentbrain 要提供受控物理清除，因此 §19.1 没有上游答案可抄，是原创设计门。

---

### 2.2 复杂度预算（LOCKED 口径与目标，实测基线）

§2.1 的"更好"是复合判据：**所有权脱钩 + 复杂度可量化下降**，两条都要，不是二选一。本节冻结后者的口径与目标值，使 §15.5 判据二可验证。

**口径 = 配置键数 + 迁移期双写门数量。行数不作判据。**

行数是最弱的口径：它会随场景复杂度免费下降，而"光靠掉场景复杂度不算数"正是 §2.1 的要求。配置键才是"太复杂"对单用户的真实痛点——每个键都是一个必须常驻脑中的决定，而复核已实测到**配置与注释都会说谎**（`_comment` 写 "remain disabled" 而值为 `true` 的情况反复出现）。

| 面 | abrain 实测基线 | agentbrain 目标 |
|---|---|---|
| 配置键（仅 agentbrain 替代范围） | **162**（sediment 83、memory 59、llmAudit 10、ruleInjector 5、canonicalGitRuntime 3、abrain 2） | **≤ 35** |
| 迁移期双写门 | **17** | **0** |

基线的分母是诚实的：全栈 341 键中，dispatch(29)、compactionTuner(24)、toolCircuitBreaker(9)、thinkingRepeatBreaker(9) 等域 agentbrain 从不拥有，不计入。

17 个双写门实测清单：`canonicalGitRuntime.mode`；`constraintEvidenceEventWriter.{mode, legacyFallbackOnEventFailure, legacyRuleWriteOnSuccessfulEvent}`；`tier2RulesLegacyWriteGate.mode`；`knowledgeEvidenceEventWriter.{mode, legacyFallbackOnEventFailure, legacyMarkdownWriteOnSuccessfulEvent}`；`knowledgeProjector.projectOnWrite`；`edgeProtocolShadow.{enabled, frozenContractAdapter.enabled}`；`executionOwner`；`daemonWorker.edgeShadowCaptureEnabled`；`forgetting.{demoteShadow, decayShadow, executorRealApplyEnabled}`；`autoLlmWriteEnabled` 三态。

双写门归零是绿地的天然红利，不是成就：这 17 个门全部只因 abrain 必须在活着的系统上增量迁移而存在。**从零开始就不该有任何一个。**

**配置预算怎么花（LOCKED）**：abrain 的 162 键里最大一块是预算类（超时毫秒、重试次数、批大小）。这类**默认写死在代码里**，不给配置键——单用户单机不会去调"第 3 步超时是 8 秒还是 12 秒"，这些数字存在的原因是 abrain 要跨多机多场景运行。代价是改一个数字要改代码并重启，这在"代码是自己的"前提下可接受。**只有少数确实需要按机器或按阶段调整的项留成配置**，§9.4.6 的两级门槛阈值是已知的一例（无真实数据不可能定准）。

---

## 3. 设计状态标记

本文使用三种标记：

- **LOCKED**：Wayfinder 已确认，实施不得自行改变；
- **GATE**：实施前必须由决策票或 throwaway prototype 关闭；
- **CANDIDATE**：建议实现形状，用于提高方案具体度，但不能作为授权依据。

如果 LOCKED 结论与后续证据冲突，必须先更新本文修订记录并重新取得用户确认。GATE 没有关闭不代表可以由实现者选择“看起来最合理”的默认值。

---

## 4. 产品范围：abrain 八区在 v2 的位置

v2 不原样复制 abrain 的八区目录，但不能笼统删除八区语义。统一原则是：**一份 canonical proposition，通过 facets 和多个 read model 服务不同消费面；独立执行资产和安全资产保持边界。**

| abrain 区域 | v2 边界 | 状态 | 理由 |
|---|---|---|---|
| `projects` | Project 是正式 semantic scope；项目决策、知识、约束、局部偏好均是核心 | LOCKED | 工程记忆的主边界 |
| `knowledge` | 以 Knowledge Claim/read view 表达，带来源、版本、有效期和冲突 | LOCKED | 记忆知识，但不扩成 Wiki/CodeGraph 平台 |
| `rules` | 以 normative proposition + Policy View 表达，不建立独立真相源 | LOCKED | 延续 ADR 0040：Policy 与 Knowledge 是读取契约差异 |
| `identity` | 支持工程协作所需的最小 Human/Agent/Profile | LOCKED | Preference、Loadout、来源主体和委派必须有身份 |
| `habits` | 稳定工程习惯映射为 Preference/Maxim/Profile 组合视图 | LOCKED | 保留价值，不建设行为监控型 Habit 平台 |
| `workflows` | 保存“怎么做”的程序性经验；不实现可执行 DAG/调度引擎 | LOCKED | 记忆与执行平台分离 |
| `skills` | 独立外部资产类型；Loadout 可持有 opaque Skill Reference | LOCKED | Skill 有代码、工具、版本和权限，不应伪装成普通 Memory |
| `vault` | 独立安全域；Memory 只做 secret detection、redaction、purge 和可选 opaque reference | LOCKED | 避免把密钥生命周期和明文释放纳入普通记忆内核 |

### 4.1 v2 正式产品面

属于 v2 正式产品面；具体物理合同和实施顺序仍受 §19 Design Gates 约束：

- L1/L2/L3 记忆核心；
- durable intake 与恢复；
- Project/Knowledge/Policy/Profile/Procedure 读取面；
- 显式 remember/correct/archive/reactivate/forget/purge；
- 自动 sediment、Proposal 与自治校准；
- Agent Loadout、Session Activation 和子代理委派；
- Pi capture、读取、注入和工具面；
- 检索、评测、doctor 和故障可见性。

### 4.2 只保留 seam，不建设完整平台

- Skill 安装、版本、执行和 marketplace；
- Workflow DAG、调度、retry/rollback；
- Wiki、CodeGraph；
- 通用 Task 平台；
- Vault 加密、密钥管理、授权释放和 tool-result 拦截；
- 管理后台与团队 Memory Hub。

---

## 5. 核心领域模型

### 5.1 权威轴：L1 / L2 / L3

`L1/L2/L3` 只表示权威和派生关系，不再表示语义抽象层级或检索阶段。

#### 证据层（L1）

L1 是权威事件历史：它权威地记录“发生过什么、谁提出了什么、系统如何处理”，但不保证每条 assertion 为真。

L1 至少需要表达：

- Source Observation；
- Assertion；
- Proposal；
- Acceptance / Rejection / Expiry；
- Correction；
- Conflict / Counter-evidence；
- Supersession / Withdrawal；
- Archive / Reactivate / Forget；
- Purge operation；
- Import provenance；
- Projector/producer metadata。

同一句“项目使用 SQLite”可能是用户声明、工具观察、模型推断或导入旧记忆；这些来源的 authority 不相同，但都可以被 L1 如实记录。

#### 记忆投影层（L2）

L2 是从 L1 确定性生成的 read model。相同 L1 集合和相同 projector 版本必须产生相同结果；生成最终 L2 字节时不得调用 LLM。

L2 不是用户直接编辑的 canonical store。用户的编辑意图必须转为 L1 correction、rescope、supersede、archive 等事件。

#### 运行索引层（L3）

L3 保存 FTS、embedding、缓存、索引水位线和可重算诊断。它必须可完全删除并从 L1/L2 重建。

**L3 不得成为以下内容的唯一存储：** durable intake、未决 Proposal、publication intent、retry/defer deadline、Purge journal 或任何 correctness-critical 工作状态。

### 5.2 Durable Work Store

v2 显式增加第四种存储职责，但不称为 L0/L4：

> **Durable Work Store**：保存尚未完成的工作意图和恢复状态，不是语义 SOT，但删除会破坏正确性。

它至少承载：

- captured intake；
- pending extraction；
- pending Proposal processing；
- publication/outbox intent；
- retry/defer/expiry；
- operation journal；
- Purge progress；
- single-writer admission/recovery metadata。

其物理形态仍是 GATE，见 §19。

### 5.3 Unified Proposition

v2 延续 abrain ADR 0040：canonical 语义对象是 unified typed proposition，而不是四个平行目录或四套 writer。

Proposition 必须保留正交 facets：

- provenance / authority；
- semantic subject；
- spatial scope；
- temporal horizon；
- trigger；
- maturity；
- contestability；
- confidence；
- sensitivity；
- consumer hints；
- causal lineage。

核心 modality：

- `descriptive`：描述世界、项目、系统或过去事件；
- `normative`：表达偏好、约束、义务、建议或工作原则；
- `meta-lifecycle`：修正 proposition 的作用域、有效性或生命周期。

### 5.4 用户可理解的 L2 读取语言

以下四种用户可理解的名称必须保留，并且只能从 unified proposition/L2 派生或选择，不能成为四个 canonical truth source：

- **Decision**：已经选择的路线、理由、替代方案和适用条件；
- **Maxim**：跨相似场景复用的原则、约束或经验；
- **Preference**：特定 Human/Agent 的显式或推断倾向；
- **Knowledge Claim**：关于项目、系统或外部领域的可验证陈述。

它们最终是物化 view、检索 facet、兼容别名，还是其中某类需要额外语义不变量，由 §19.4 L2 Contract 冻结。同一 proposition 可以出现在多个组合视图中，但只有一个 canonical identity。例如“非平凡实现先更新设计并获授权”可以同时呈现在 Project Policy、Human Profile 和 Procedure View 中，不复制为三份事实。

### 5.5 组合视图

- **Policy View**：当前消费面必须稳定看到的 normative propositions；
- **Human Profile**：工程协作相关的 Preference、Maxim 和 Habit-like 组合；
- **Agent Profile/Loadout Manifest**：Agent 的角色、默认选择策略和预算；
- **Scenario View**：围绕一类情境组织相关 propositions；
- **Context Brief**：session-start 的小型稳定上下文；
- **Procedure View**：程序性经验，即“遇到某类问题通常怎样做”。

这些视图是否全部持久物化，由 L2 合同决定；它们均不得成为新的 canonical writer。

---

## 6. 身份、作用域、Loadout 与委派

### 6.1 最小身份模型

v2 区分：

- **Human**：本地记忆服务的人；
- **Agent Definition**：稳定角色，如主开发、审查、研究；
- **Agent Execution**：某次具体运行；
- **Project**：稳定工程/知识工作边界；
- **Repository**：Project 关联的代码库身份，不必一一对应；
- **Session**：一次 Pi 会话；
- **Work Unit**：一次任务或委派边界，不实现通用 Task 平台。

Project identity 只认稳定 project ID 与显式本机 binding/registry 关系；`cwd`、目录名或 Git remote 只能作为发现候选，不能自行授予项目身份或记忆资格。同一 Project 的多个 checkout 必须可区分本机执行根。具体 binding 形态由 §19.5 冻结。

### 6.2 六个必须分开的概念

1. Ownership：谁负责治理；
2. Authorization/Capability：当前执行是否有资格读取或操作；
3. Semantic Scope：记忆描述谁、哪个项目或工作单元；
4. Loadout Attachment：Agent 默认关注什么；
5. Session Activation：本次会话启用哪些 Loadout 部分；
6. Retrieval/Injection：当前问题最终读取和呈现什么。

Loadout 不授予权限；scope 不等于 ACL；语义相似不能绕过 capability。

### 6.3 子代理委派

Pi 没有公共 subagent/delegation 身份，因此 agentbrain 自己定义 delegation contract。父 Agent 不把全部 Loadout 隐式传给子代理，而是为 Work Unit 建立：

- delegated memory slice；或
- 有明确范围、预算和有效期的 retrieval capability。

子代理默认可以：

- 读取委派范围内的 Memory Cards；
- 提交带来源的 Observation；
- 提交 Proposal。

子代理默认不可以：

- 读取父 Agent 全部个人/跨项目记忆；
- 直接确立项目 Decision；
- 修改 accepted proposition；
- 扩大自己的 scope 或 activation；
- 执行 physical purge。

#### 6.3.1 继承 ADR 0042：单层派发与五项结构性拒绝（LOCKED）

以上是**记忆面**的委派合同。一旦 agentbrain 自己实现 subagent，**执行面**的约束也落到本项目手里，因此显式继承 abrain ADR 0042（status `superseded / permanently retired`，2026-07-24 owner decision）：

- **嵌套/递归子代理派发永久禁止**。编排回到 main-session-only：worker 执行任务，不再派发、不再重新规划、不再重新编排。
- **五项结构性工具对所有子代理无例外拒绝**（preflight + SDK `excludeTools` 双重）：`dispatch_agent`、`dispatch_parallel`、`workflow_run`、`prompt_user`、`vault_release`。不存在 shadow mode、capability grant、depth-1 例外或 broker 路径可以解除其中任何一条。
- **单层 dispatch 保留**：主会话可派发一次创建 worker。
- **恢复条件**：新 owner decision + 新 ADR + 独立证据包。

继承理由：0042 的依据是**行为证据**——"multi-layer task restatement produced goal drift"（多层任务复述产生目标漂移）。这条与宿主无关，clean-room 重写同样适用，因此默认继承而非重新裁决。若日后要推翻，必须按 §3 的 LOCKED 规则先进修订记录并重新取得用户确认。

#### 6.3.2 委派血缘是接缝的必填输入（LOCKED）

pi-astack 的因果身份是事后拼出来的，代价可量化：`_shared/causal-anchor.ts` 共 **585 行**，存在的唯一目的就是重建本可以直接传入的东西。其头注释自陈两处硬伤——Pi 的 `TurnStartEvent.turnIndex` 每次 `agent_start` 归零（那是工具轮内层计数器），所以必须自建用户级计数器；以及必须把 anchor **注入子代理的 prompt**，子代理才知道自己在调用树的哪个位置。

agentbrain 不拥有执行面（§6.4），因此血缘**在合同上是一等的，在实现上不要求拥有执行器**：

- **委派方必须随 Work Unit 传入血缘**（父 Agent Execution 标识 + 委派关系）。这是接缝的必填输入，不是 agentbrain 事后推断的对象。
- **传不到就打降级标记**，记为 Delegation Lineage 缺失的 degraded evidence，**不记作"未委派"**。二者必须可区分——否则空血缘与真的没有委派长得一样，失败静默。

这条使 §6.3 最难的部分（跨扩展因果身份重建）被消掉，而不需要 agentbrain 扩张到执行面。

术语见 CONTEXT.md 的 Delegation Lineage。

### 6.4 执行面边界：只留接缝（LOCKED）

**agentbrain 只拥有记忆面。子代理如何创建、调度、传参、超时、回收，全部归 Pi 与 dispatch 所有。**

实测依据表明这个边界比预期便宜：

- **pi-astack 的 `dispatch` 扩展完全不 import 记忆栈**（零行代码依赖）。耦合只有一个工具名字符串：`dispatch/index.ts:173` 的 `DEFAULT_SUBAGENT_TOOLS = "read,grep,find,ls,web_search,web_fetch,memory_search,abrain_get,memory_decide"`。
- 因此**工具名重叠不是麻烦，它就是委派接缝本身**。agentbrain 注册同名工具即接上委派链，无需 fork 执行面。§7.4.1 那行"工具名重叠"的性质因此反转：切换期它是冲突面，稳态下它是接口。
- `createAgentSession` 确实是 Pi core 的公开导出（`dist/core/sdk.d.ts:107`），所以"只留接缝"是**本项目的选择，不是 API 限制**。

一条继承而来的硬限制：§6.3.1 禁止嵌套子代理派发，因此**子代理会话内产生的记忆无法再派一个子代理去判断它**——§9.4.5 三层链的第 1 层在该情形下只能退回 agentbrain 自有后台 worker 执行。

---

## 7. 宿主边界：Pi-only，但领域不属于 Pi

### 7.1 Pi adapter 可依赖的公开 seam

基于 `earendil-works/pi@5cd93f6`：

- `session_start`：恢复、稳定 Brief；
- `before_agent_start`：逐轮 Memory Card/marker 注入；
- `agent_end`：快速 durable capture；
- `session_shutdown`：幂等关闭 session 资源；
- session v3 JSONL 与 `SessionManager`；
- branch/compaction 语义；
- `registerTool` / `registerCommand`；
- `ctx.modelRegistry` / `ModelRuntime`；
- AGENTS.md / CLAUDE.md / SYSTEM.md / APPEND_SYSTEM.md。

### 7.2 只能留在 adapter 的内容

- Pi event payload；
- session JSONL 路径和格式；
- compaction entry；
- pi-astack `isSubAgentSession` WeakSet；
- pi-astack causal anchor；
- `createAgentSession()` 签名；
- jiti `moduleCache:false` 的共享状态技巧；
- Pi prompt marker 和 UI 文案。

agentbrain domain 接收规范化的 Source、Execution、Work Unit 和 Capability，不持久化 Pi 私有类型作为 canonical 领域对象。

### 7.3 进程拓扑

LOCKED：

- Pi 主交互路径不等待模型抽取；
- adapter 只做轻量 capture、查询和呈现；
- canonical mutation 只有一个逻辑 Writer；
- 已接收 intake 必须可恢复；
- 优化失败不阻止 Pi 对话继续。

GATE：daemon、短命 worker、Pi 进程内 worker、RPC 子进程或混合形态由 Pi prototype 决定，见 §19。

### 7.4 与 abrain 现役实现的运行期共存与切换

§2.1 把替代定为前提，因此必须回答一个 §12 完全没覆盖的问题：**切换期间两套扩展同时挂在同一个 Pi 实例上会发生什么。** §12 只在 store 层声明了单一 canonical owner，那管不到运行期——两套扩展的冲突全部发生在 Pi 的公开 seam 上。

#### 7.4.1 四个已确认的冲突面

| 冲突面 | 事实 | 后果 |
|---|---|---|
| `agent_end` 双消费 | abrain 的 sediment 以 `agent_end` 为沉淀触发（`sediment/index.ts:7201`），Pi 保证在 `agent_settled` 前 await 所有 `agent_end` listener | 同一份 transcript 被两套系统各抽取一次：双倍模型开销、双份记忆、且两边的结论会各自演化并互相不可见 |
| `before_agent_start` 注入链 | **Pi 会链式合并所有 handler 返回的 `systemPrompt`**（文档化行为，pi-astack memory 正是依赖它做幂等 marker 注入） | 两套注入块同时进 prompt：预算翻倍，且"稳定前缀、易变后缀"的 cache 纪律被另一方破坏 |
| 工具名重叠 | pi-astack 在 `memory/index.ts:362,426,537` 注册 `memory_search` / `abrain_get` / `memory_decide` | 名字重叠的实际后果未实测（`registerCommand` 重名会自动加 `/name:1` 后缀，`registerTool` 的行为未验证）；即便不冲突，模型面对两个语义相同的检索工具也会随机选择 |
| authority 互相看不见 | DCC 之后，store-present strict regime 下唯一 canonical convergence executor 是同一 LSEA holder 的 daemon-managed long-lived worker（ADR 0046） | agentbrain 的 worker 若也要求独占，两套 authority 机制互不感知：没有共同的锁、没有共同的 attestation，同时执行或同时停摆都不会被任何一方诊断出来 |

本仓研究文档已自认这一风险未验证（`docs/research/20260821-pi-memory-集成与子代理接缝.md:120`：共存"本轮未验证，列为风险项而非结论"）。v2 把它从风险项升级为**必须设计的合同**。

#### 7.4.2 必须回答的问题（GATE）

1. **互斥**：同一 Pi 实例上，两套记忆系统的写路径如何保证只有一个生效？靠总闸、靠 authority 互认，还是靠安装期互斥？
2. **灰度**：能不能读走 agentbrain、写仍走 abrain（或反之）？这是替代过程中唯一能低风险积累证据的姿态。
3. **回退**：cutover 后发现问题，如何在不丢失切换期新增记忆的前提下退回 abrain？§12.3 的"回退依靠只读备份而非双主"只覆盖 store，不覆盖运行期。
4. **诊断**：doctor 必须能报告"当前本机有几套记忆系统在消费 `agent_end`、在注入 prompt、在持有 authority"。共存期最危险的状态是静默双活。

#### 7.4.3 两个现成的形状（CANDIDATE）

- **`PI_ABRAIN_DISABLED=1` 作为切换总闸**：这是 pi-astack 已有的进程级 env 开关，abrain 的 `activate()` 第一件事就检查它，sediment、memory、context7、model-fallback 全部短路（原为 ADR 0014 invariant #6 的 sub-pi 隔离而建）。它的好处是**存量、全栈、已验证**；限制是**进程级 env，不能在同一进程内做分会话灰度**，且把它从"sub-pi 隔离"改用作"cutover 开关"属于语义借用，需要在 §19 里确认可接受。
- **仿 `canonicalGitRuntime` 的 fail-closed 单键**：abrain 用一个 schema 严格、配置缺失即抛错（不是默认 legacy）的单键，在 canonical 与 legacy 发布路径间二选一。这是"激进路线与朴素路线之间的官方逃生阀"的成熟形态，agentbrain 的运行期开关应照抄这个纪律：**显式、fail-closed、可诊断**。

两者都不是已拍板实现，最终形态与 §19.3 一并裁决。

---

## 8. 写路径：Sediment 与 Proposal

### 8.1 总体流水线

```text
Pi lifecycle
  → adapter 去除自身注入和 harness 噪声
  → 持久化前 secret/PII/path sanitizer
  → Durable Intake
  → batch/window builder
  → LLM extractor（只生成 Proposal/Assertion）
  → neighbor lookup / dedup context
  → curator decision
  → append L1
  → deterministic L2 projector
  → L3 reconcile
  → visible diagnostic/outcome
```

### 8.2 来源和默认写权

| 来源/行为 | 默认结果 |
|---|---|
| 用户显式 remember/correct | 通过安全校验后形成 accepted L1 intent/event |
| 用户原话、工具输出、代码事实 | Source Observation；不自动扩张成更宽泛结论 |
| 主 Agent 自行推断 | Proposal |
| 主 Agent 对后台已备判断的决断 | 可 accepted，见 §9.4.4 |
| 子代理观察 | Observation |
| 子代理结论/项目决策 | Proposal，不能直接 accepted |
| 旧数据导入 | `imported/unverified` proposition 或 Proposal |
| correction/supersession | 用户始终可触发；自动策略限于规则明确的低风险情况 |
| physical purge | 受控操作，失败必须显式报告 |

### 8.3 INV-INVISIBILITY

v2 保留 abrain 的 INV-INVISIBILITY：

- 用户不承担日常审批；
- 不建立“27 条记忆待确认”的常驻 inbox 作为正确性前提；
- 高风险或弱证据 Proposal 默认 inactive，可以等待更多证据、自治 reject/expire/defer；
- 只有当前任务确实依赖 unresolved Proposal 时，才允许在自然对话中询问；
- 用户主动 remember/correct/forget/purge 时系统必须立即承认并可靠执行或响亮失败。

人机校准只允许三种模式：

1. **显式意图模式**：用户主动 remember/correct/archive/reactivate/forget/purge；
2. **上下文澄清模式**：当前任务确实依赖 unresolved Proposal，系统在原对话中询问一次具体歧义；
3. **自治延后模式**：等待更多证据、reject/expire/defer，不打扰用户。

禁止建立批量记忆审批后台作为正常闭环。**Unreconciled 集合（§9.4.4）与 Ephemeral 证据（§9.5）都不得做成常驻待办列表**：它们只在检索自然命中、且当前任务确实需要时按上下文澄清模式问一次；总量由 doctor 报告（§14.3）。§9.4 的 Corroboration Count 之所以不违反本条，是因为计数在后台自行排队、不向 Human 呈现列表，只在达到门槛时才可能触发一次询问。进入 stable Policy View 的高影响 Proposal 必须经过独立证据、明确用户 directive 或另行冻结的高影响校准策略；不得仅凭单模型高 confidence 发布。

### 8.4 晋升不是一个置信度阈值

晋升策略至少考虑：

- proposition/read-view kind；
- semantic scope；
- source authority；
- 是否用户显式；
- 是否子代理推断；
- 是否有独立来源；
- 错误 blast radius；
- 是否会进入 stable Policy View。

具体策略仍由 Sediment ticket 关闭；实现不得先写一个全局 `confidence >= N` 当最终答案。

### 8.5 Acceptance 与高影响发布分离

Proposal 被 accepted 只表示它可以进入当前 proposition read model，不自动表示它可以在每个 session 启动时作为行为约束注入。Policy/Context Brief 的高影响发布必须由独立 deterministic selector/projector 生成一份严格校验、带版本和来源集合指纹的 stable view；stale 可见、invalid loud-zero，不静默回退到旧目录或原始 memory 全量。

首发是否需要 shadow publication、canary 或独立 reviewer 由 Sediment/L2 Gates 决定；但“写入慢、发布稳、注入快”和“一个读取面的授权不自动授权其他读取面”是 LOCKED 不变量。

---

## 9. 生命周期、冲突与纠错

### 9.1 两条正交状态轴

Proposal admission：

- proposed；
- accepted；
- rejected；
- expired/deferred。

Accepted proposition semantic state：

- active；
- disputed；
- superseded；
- withdrawn；
- expired；
- archived；
- purged。

置信度和来源等级不是 semantic state。

### 9.2 冲突处理

- 新内容不因时间更新就自动覆盖旧内容（§9.4.4 因此选择"认不出 supersession 就不进 L2"，而非"同主题取最新"——后者会让一条错误的新说法自动盖掉正确的旧说法）；
- 可能冲突的 propositions 同时保留并显式建立 conflict/counter-evidence；
- 能由 scope、subject、time 或 qualifier 区分时，细化为不同 proposition；
- 用户 correction 可以明确 supersede；
- 低风险、规则确定的更新才允许自动 supersede；
- 未解决冲突在 Memory Card 中必须暴露，不能静默只返回一边。

### 9.3 身份和 lineage

L2 proposition 使用不依赖正文、文件路径和 content hash 的稳定逻辑身份。正文改写不自动产生无关记忆；merge/split/supersede 保留 lineage。

L1 event/record 的物理 identity 与 Physical Purge 存在硬设计门，见 §19.1。

### 9.4 Corroboration 与 maturity 升级（LOCKED 机制，参数待定）

#### 9.4.1 记忆没有"过期"这回事

一条 proposition 不因为时间流逝而失效。"这个项目用 React 17"在写入时是真的，升级到 19 之后**两条都是真的证据**——L1 同时保留，L2 只投影当前结论。因此 v2 **不引入有效期字段**：写入时无法知道有效期，标出来的数字必然是猜的。

状态变化通过**向 L1 追加 meta-lifecycle 事件**表达，永不修改既有 L1 记录（§5.1 的 append-only 是整套架构的承重墙：正因为 L1 不可改，"同一份 L1 + 同一 projector version → 同一份 L2"和 purge 可验证才成立）。一条 proposition 的完整历史是 L1 上的一串事件——被断言 → 累积 corroboration → 升级 → 被 Human 否定 → 撤下；**当前状态是这串事件的最后一条**，由 L2 投影。要"在 L1 里看到状态"，看的就是这个尾部，不是去改历史。

#### 9.4.2 计数口径（LOCKED）

Corroboration Count 的口径是：**在多少个不同 Session 里真正被用上且未被 Human 否定。**

三条约束都是 LOCKED：

- **按 Session 计，不按检索次数计**。同一 proposition 在一个 Session 内被翻出五次也只 +1，否则一次话多的会话就能把它顶上去。
- **"被检索到"不算，"真被用上"才算**。abrain 已用代码给出这个区分：`memory/usage-telemetry.ts` 分别记 `retrieval_hit_count` 与 `cited_count`，头注释明写「「被用」≠「被检索」: citation 是 retrieval 的真子集, 信号更强」。若按检索计数，涨得最快的将是**最容易被检索到的**而非最正确的，且会自我强化：升级 → 注入更多 → 检索更多 → 涨更快。
- **"未被否定"必须是 Human 显式表示的缺席，不是模型判断**。见 §9.4.3。

`usage-telemetry.ts` 的定位说明：abrain 已经在数这个计数，但明确是"纯观测，零行为"（头注释：不做任何 demote/delete/归档）。agentbrain 的增量不是发明计数，而是**把它接上 maturity**——同时只接上行那一半。

#### 9.4.3 上行自动、下行显式（LOCKED）

| 方向 | 触发 | 是否需要 Human |
|---|---|---|
| +1 | Session 结束时，该 Session 内真被用上且无 Human 显式否定 | 否，全自动 |
| 降级 | Human 表示"这条不太行" | **是，必须显式** |
| 撤下结论 | Human 表示"这条是错的" | **是，必须显式** |

不对称的理由：自动上行判错，后果是升快了；自动下行判错，后果是丢掉正确知识。后者不可接受。

**因此系统永不从对话里推断否定。** "该 Session 内未被否定"的判定方式是查该 Session 内有无 Human 的显式降级/撤下表示，**不是**让模型判断"用户刚才那句话是否在否定某条记忆"——后者既贵又不准，且失败方向恶劣：把一句技术讨论误判为否定，会静默压低一条正确的知识而用户完全看不见。这与 §9.4.2 第三条约束和 §8.3 的人机校准三模式一致。

"撤下结论"的语义是 **Semantic Forgetting**（§10.1）：检索查不到、不注入，证据保留在 L1。不是 Physical Purge——后者只按 Purge Range 批量执行（§10.2）。同一份证据日后若被其他证据重新印证，可以按 reactivate 路径回来。

#### 9.4.4 主题归属与 Unreconciled 状态（LOCKED）

计数要求判断"这两条讲的是同一件事"，这个判断分两层，难度差距很大：

1. **认出这是关于哪个主题的**（React 版本）——较可靠；
2. **认出它推翻的是已有的哪一条**——不可靠。

处置：

- **主题归属**：由 agent 提议，但**与已有主题对齐优先**。已存在"React 版本"这一格就必须复用，不许新开近义格（否则同一件事散落三格，L2 又回到多条并排）。主题清单需要偶尔人工合并，这是已知代价。
- **supersession 归属**：认不出就**不进 L2**。该 proposition 记入 L1 并保持可读，但标记为 **Unreconciled Proposition**（见 CONTEXT.md），不投影为当前结论。这比"读取时取最新"更严，也是唯一能兑现"L2 只有结论"的做法：取最新会让一条错误的新说法自动盖掉正确的旧说法。
- **转正路径**：Unreconciled 只能由 **Human 确认它推翻了哪一条**而离开该状态。**累积 Corroboration Count 不能使其转正**——否则就绕过了本条门。
- **不建列表**：Unreconciled 集合不作为常驻待办呈现（§8.3 INV-INVISIBILITY）。只在检索自然命中它、且当前任务确实需要时，在原对话里问一次。Doctor 必须能报告当前有多少条处于该状态（§14.3），这是唯一的可见性入口。

#### 9.4.5 三层判断链（LOCKED 形状，模型分配待定）

判断"主题归属 + supersession 归属"的执行链：

1. **子 agent 用低成本模型先判**（后台，不阻塞主对话）；
2. **判不动的升级给更强模型复核**（仍在后台）；
3. **仍判不动的**，由主 agent 在下一轮对话开头就已备好的判断做决断。

主 agent 在第 3 层的决断**可以直接 accepted**（§8.2），这是它与"主 agent 自行推断只能是 Proposal"的区别：它拍的是后台已经准备好的判断，不是自己现编一条记忆。它不违反 §7.3"主交互路径不等待模型抽取"——重活已在后台完成，第 3 层只是读取一个已备结论并拍板。

需要升级到第 2、3 层的情况本应稀少：绝大多数 proposition 落进已存在的主题格，第 1 层即结束。**因此本链的成本随主题清单成熟而下降。**

设计依据是一条外部观察（2026-08-28 记录）：难易分流的可靠做法是先用便宜模型跑、失败再升级，而不是事前分类——分类器判断"这活难不难"的难度不低于原任务。abrain 现役的按角色静态分层模型配置正是"事前分类"的形态。

第 3 层是唯一允许打扰 Human 的一层，落在 §8.3 的"上下文澄清模式"内：当前任务确实依赖这个未决判断时，在原对话里问一次。

#### 9.4.6 两级门槛（LOCKED 两级结构，阈值待定）

| 门槛 | 获得什么 | 错误代价 |
|---|---|---|
| 低门槛 | 升为 Maxim View 一类的可复用准则，检索排序靠前 | 你看到了可以忽略 |
| 高门槛 | 取得 Policy View / Context Brief 的**默认注入资格** | 静默影响所有工作且用户不会注意到它在那里 |

两级而非一级的理由就是右列：一条排序靠前的错知识可被忽略，一条每次会话自动注入的错知识会持续影响全部工作而不被察觉。成本只是多一个数字。

本机制与 §8.5 的高影响发布门是**串联而非替代**：Corroboration Count 达到高门槛只是取得**候选资格**，实际进入 stable Policy View 仍须通过 §8.5 的 deterministic selector/projector。计数不能取代证据质量与 authority（见 CONTEXT.md 的 Corroboration Count 定义）。

**待定参数**（属 §19.6，不得由实现者自选）：

- 两级门槛的具体数值。定低了错知识拿到注入权，定高了好知识永不升级；**无真实数据不可能定准**，因此必须是可调配置项（§2.2 允许的少数配置之一）。
- "真被用上"的精确判定。abrain 的可用实现是"进入注入块或 decide brief"（`usage-telemetry.ts` 的 `cited`）。**未决**：一条被检索到、模型读过、但明确决定不采用的 proposition 是否计入——abrain 那套会计入，因为它只能观测到"是否进入 prompt"。

### 9.5 Ephemeral Session 的证据（LOCKED）

一次性会话（无持久 session 记录）的证据**记录并标记，不丢弃，默认不投影为结论**。

可检测性依据：`ReadonlySessionManager.getSessionFile()` 是 Pi 的公开 API，返回 `string | undefined`；`SessionManager.inMemory()` 构造出的会话该值为 undefined。因此"无持久 session 文件"是**公开可见的代理信号**。

但它只是代理信号，不是身份：**agentbrain 能观测到一个 Session 是 ephemeral，无法判断为什么**——被委派的子代理执行与用户刻意不留记录的主会话在它看来完全相同。因此不能据此推断"这是子代理"。

处置的理由：丢弃违反"证据永不丢"（§5.1）；直接投影则会让一次性上下文里的临时结论进入长期记忆。默认不投影使二者都避免。术语见 CONTEXT.md 的 Ephemeral Session。

Doctor 必须能报告这类证据的量（§14.3），否则它是完全不可见的沉默积累。

---

## 10. Archive、Forget、Purge 与 Outcome

### 10.1 必须支持的共同语义

- Correction/Supersession：保留历史，改变当前结论；
- Archive：默认读取面不选中，但仍可追踪；
- Reactivate：有新证据时恢复；
- Semantic Forgetting：保留必要审计关系，但不再检索和注入；
- Physical Purge：从 agentbrain 控制的内容存储和派生物中清除敏感正文。

非 Purge 的终态应可追溯、尽量可逆。

**usage 信号的不对称授权（LOCKED）**：usage 可以单独驱动**上行**（Corroboration Count 累积、maturity 升级，见 §9.4），不能单独驱动**下行**。任何降级、语义遗忘或撤下结论都必须有 Human 的显式表示；disuse 本身永不构成删除长期 Decision、Maxim 或 Preference 的理由。理由见 §9.4.3：自动上行判错只是升快了，自动下行判错是丢掉正确知识，代价不对称。

### 10.2 Physical Purge 边界

Purge 至少覆盖：

- L1 body；
- L2 views；
- L3 index/cache；
- Durable Work Store 中的相关正文；
- agentbrain 管理的临时文件和可访问本地副本。

只留下不含原文、秘密、可逆摘要或不必要敏感元数据的最小状态。对远端 Git 历史、外部 clone、第三方备份和 Pi transcript 只报告 best-effort，不承诺全球可验证擦除。

Purge 只能由可信 Human/operator 的显式控制路径发起；普通 transcript、记忆正文、模型输出、Agent Proposal 和外部 Skill 指令都不能触发。执行前显示将覆盖的受控存储边界，执行后逐面报告 success/partial/failure。子代理永远没有 Purge capability。

#### 10.2.1 Purge 按范围执行，不支持单条精确删除（LOCKED）

**Purge 的操作单位是 Purge Range，永不是单条 proposition 或单个 event。**

范围按写入时不可变的 facet 声明，例如时间窗、Session、原始 Project。允许可变 facet 会使范围含义随后续 rescope 漂移。

日常"删掉这条"的诉求由 **Semantic Forgetting** 承担（§9.4.3）：检索查不到、不注入、证据保留。二者不是粗细粒度之别，而是两种不同操作。

#### 10.2.2 声明是意图，枚举是回执（LOCKED）

一次 purge 必须同时写入两样东西：

- **声明**：这次要删哪个范围。它陈述意图，purge 之后仍然可读，回答"当时要删什么"。
- **枚举**：purge 实际移除了哪些记录的 ID 集合，作为可重放快照。

两者都要的理由是 meta-lifecycle rescope 的压力测试：一条 proposition 写入时属于 Project A，后被 rescope 到 B。仅有声明时，重放同一份 L1 会算出与当初不同的成员集合，**范围墓碑就不再能证明任何事**；仅有枚举时，无法回答当初的意图，也无法人工审计。

必须承认的代价：purge 事件体积变大，且枚举必须在**同一个 authority frame 内生成**，不能事后补写——事后补的枚举无法证明它与当时实际删除的集合一致。

术语见 CONTEXT.md 的 Purge Range。具体 event identity/tombstone 物理模型仍未关闭，见 §19.1。

### 10.3 自治遗忘出 v2 范围（LOCKED）

v2 必须有 explicit archive/reactivate、supersede/withdraw/expire、forget/purge 分离。

以下能力**明确不在 v2 范围内**，不是"待裁决"：

- 自动 archive executor；
- 自动 decay / demote；
- 自动 reactivate；
- 去自回声；
- resurrection-rate、kind-distribution 监控；
- archive recommendation；
- outcome 驱动 prompt/policy evolution。

理由是 abrain 作者自己的选择：ADR 0031 声称"2026-07-23 起正式全量生产"，而本机现役 `memory.forgetting.executorRealApplyEnabled` 已回退为 `false`，`_comment` 明写 "Real forgetting remains disabled"——**写这套自治执行器的人在自己机器上没有武装它**。它同时贡献 §2.2 所列 17 个双写门中的 3 个（`demoteShadow` / `decayShadow` / `executorRealApplyEnabled`）。在 §2.1 的所有权动机下，"原作者不敢开的代码"是最不该继承的一类。

v2 保留的**唯一** usage 相关机制是 §9.4 的 Corroboration Count，它与自治遗忘的关键差别是方向：只上行，不下行（§10.1）。

与 §15.5 判据一的张力必须在 [#15](https://github.com/josheee1117/agentbrain/issues/15) 逐条验证：若 abrain 现役 P0 场景中有任何一条实际依赖自治遗忘，本条构成场景回退，需要重新裁决。按上述旗标状态，当前判断为不构成。

---

## 11. 读路径与 Memory Card

### 11.1 三路交付

1. **Session Brief**：小、稳定、预算受控的 Profile/Policy/Project Brief；
2. **Per-turn Retrieval**：按当前任务自动召回相关 Memory Cards；
3. **On-demand Tools**：搜索、展开来源、查看冲突和读取完整证据。

硬性 Decision/Maxim/Constraint 不能只依赖向量相似度偶然召回。

### 11.2 检索职责顺序

```text
eligibility filter
  → candidate recall
  → rerank/score
  → conflict + state shaping
  → diversity/dedup
  → token budget
  → structured Memory Cards
```

Eligibility 至少包含：

- semantic scope；
- capability/delegation；
- Loadout；
- Session Activation；
- proposition state；
- sensitivity/provider policy。

过滤必须在 dense top-N 前执行，并在返回前复查；不能先全库召回再过滤，避免正确候选被未授权内容挤出。

### 11.3 Memory Card 最小合同

- memory/proposition ID；
- readable kind/view；
- concise content；
- subject 与 scope；
- current state 和 temporal validity；
- provenance summary；
- source expansion reference；
- conflict/supersession；
- relevance/score explanation；
- token estimate；
- composite-view 标记；
- degraded/stale/partial/low-confidence 状态。

Pi adapter 决定它被渲染成 marker block、工具结果、摘要还是按需读取入口。

### 11.4 算法候选，不是已拍板实现

Prototype 比较：

- CJK char n-gram vs 分词；
- lexical-only vs dense hybrid；
- ordered pooling vs RRF；
- single-vector vs multi-vector；
- no-rerank vs LLM rerank；
- candidate size、预算和默认 profile。

v1.2 的 Tier0/Tier1/Tier2 是候选实验矩阵，不是 v2 最终实现合同。

---

## 12. 本地 Store、同步与迁移

### 12.1 已锁定边界

- 一个本地 agentbrain store 是 canonical owner；
- correctness 不依赖 Git、远程服务或共享目录；
- 不做远程多 Writer；
- 不做长期双写；
- 敏感 L1 不默认进入代码仓；
- export/import 是受控边界；
- L3 完全可重建；
- Git 可以是可选导出、审阅或备份媒介，而不是默认 authority。

### 12.2 尚未冻结的物理选择

- store root 和目录；
- L1 一事件一文件还是其他 create-only 结构；
- JCS 是否保留；
- event ID 与 body hash；
- Durable Work Store 是文件、SQLite 或组合；
- L2 Markdown、JSON 或双输出；
- SQLite 的具体职责；
- backup/export bundle；
- schema/projector migration runner。

### 12.3 迁移纪律

- 先关闭 L1/L2/隐私合同，再盘点真实资产；
- 盘点个人 store 前必须针对具体路径和命令另行取得只读授权；
- 默认只记录 schema、数量和匿名分布，不复制个人正文；
- 可识别的 Evidence、Decision、Maxim、Preference、Knowledge 尽量映射；
- 只有派生 Markdown、无法恢复来源的内容标为 imported/unverified；
- 目标已存在不覆盖；
- 单向导入，不建设永久兼容层；
- abrain 的现役 store 作为**只读归档长期保留**，cutover 完成后也不删除；回退依靠该归档而非双主。理由：§12.4 的迁移口径是人工挑选，没有完备性保证，归档是唯一能补挑的来源。

以上纪律本身不变，但**它们的位置改了**：在 §2.1 的替代前提下，cutover 不是 M6 末尾的收尾动作，而是决定 M1-M6 值不值得做的前置条件。因此资产盘点（[#7](https://github.com/josheee1117/agentbrain/issues/7)，当前 open 且被隐私 gate 阻塞）从"迁移里程碑的一个步骤"上升为**关键路径**，见 §18 T0。

另需注意：本条的"回退依靠备份而非双主"只覆盖 store 层。运行期回退（两套扩展同挂 Pi 时如何退回 abrain 且不丢切换期新增记忆）由 §7.4 单独承担。

### 12.4 迁移口径：人工挑选 + 可重放 manifest（LOCKED）

**不做全量迁移。Human 人工挑选一批高价值记忆导入。**

排除全量 L1 迁移的理由：在 §2.1 的所有权动机和 §12.5 的 clean-room 路径下，全量吃 L1 意味着 agentbrain 的新 schema 必须能表达 abrain 的事件形状——把刚脱的钩又挂回去。

导入必须落成**可重放的 import manifest**：

- 源引用清单（挑了哪些）；
- Human 背书（谁确认的）；
- 选取理由（为什么留它）。

理由与 §10.2 的"声明是意图、枚举是回执"同源：不记 manifest，则一次 schema 迁移或一次 purge 之后就要重新人工挑一遍，而"当时为什么留这条"三个月后已不可复原。挑选时顺手记接近零成本，事后重建不可能。

导入的 proposition 以 `imported` 落地并保留"来自 abrain"的来源标识（L1 已有 `imports` 事件类型）。必须承认的代价：**人工挑选没有完备性保证**，因此 abrain 现役 store 必须作为只读归档长期保留（§12.3），它是唯一能补挑的来源。

**对 [#7](https://github.com/josheee1117/agentbrain/issues/7) 的直接影响**：本口径下 #7 不再需要 schema 完整盘点，只需要一份**可浏览清单供 Human 自行挑选**。代理侧需要接触的个人内容面因此显著收窄，隐私 gate 基本退出关键路径。#7 的隐私纪律（§12.3）不变，但其工作量与授权面按本条重估。

### 12.5 代码来源：clean-room（LOCKED）

**代码全新编写。abrain 的 ADR、架构文档、复核结论与源码当作规格读，不作代码抄。**

被否决的替代路径与理由：

- **fork-and-strip 整个记忆栈**：MIT 许可（`pi-astack/LICENSE`，Copyright alfadb）已排除法律障碍，因此判别式只剩认知所有权与维护面。继承 88,781 行未曾亲手写过的代码，法律上属你、认知上不属你；且保持上游形状会持续产生合并诱惑（`upstream/main` 已领先本 fork 50 个提交并带着 DCC），恰好治不了 §2.1 要治的脱钩。
- **只复用 `_shared` 的语义核心**（proposition / jcs / l1-schema-registry / canonical-l2-reconciler）：省得最少而改得最痛。§10.2 的 Purge Range 与 §9.4 的 Corroboration/Unreconciled 都是 abrain L1 **根本没有的词汇**——上游零 purge 机制，ADR 0043 反而把物理删除列为要规避的风险，writer 与 reconciler 全线假设 append-only。这块"语义核心"恰恰是必须改动、且不变量密度最高的代码。

**clean-room 的真实风险**是重新推导那 88,781 行踩出来的行为。挡住它的是两条已有纪律：§19 各 gate 的"先读上游再跑 prototype"，以及 §3 要求 gate 由代码切片而非论证关闭。**当规格读，不当代码抄。**

---

## 13. 安全、隐私与威胁模型

### 13.1 信任边界

可信管理边界：本地 Human 和正常运行的 agentbrain 进程。

不可信数据：

- Pi transcript；
- 工具输出；
- 模型产物；
- 导入资产；
- 记忆正文；
- 外部 Skill/Workflow 引用。

Capability-limited actors：Pi 主 Agent 和子代理。它们不会因为“是 Agent”就自动拥有全部记忆。

不在 v2 防御范围：已经控制本机 OS/文件系统的恶意进程、恶意管理员、不可信多租户。

### 13.2 必须执行的安全边界

- durable 持久化和发送远程模型前 secret/PII/path sanitizer；
- harness/system reminder/自身注入去噪；
- path traversal、symlink 和恶意导入检查；
- scope/activation/delegation 强制过滤；
- 记忆以 reference data 呈现，不能自动升级为系统指令；
- 普通日志、指标和错误不写敏感正文；
- 审计“存形状不存内容”；
- 项目可配置禁止原文离开本机；
- 默认依赖 OS/文件系统保护静态数据，不在 v2 自建加密 Vault。

### 13.3 数据最小化

- 不默认归档完整 transcript；
- 保存支持记忆所需的精确摘录和来源信封；
- 明确摘录不是完整上下文；
- rejected/expired Proposal、临时来源和模型 I/O 采用有限保留策略；
- prompt/model/input/output provenance 优先记录版本和 hash，只有解释正确性必需时才持久化正文。

### 13.4 数据生命周期类别

| 数据类别 | 默认生命周期原则 |
|---|---|
| 支撑 active/disputed proposition 的 source excerpt | 保留到 proposition 不再需要解释，或被合法 Purge；archive 不自动删除来源 |
| Durable Intake / Work Item | 保留到 terminal + 有界恢复窗口；不得无限堆积 |
| rejected/expired Proposal | 正文按有限保留策略清除，保留不含敏感内容的结果与诊断 |
| accepted proposition producer output | 作为 L1 provenance 的必要结果保留；raw prompt/input 默认不全量持久化 |
| embedding/FTS/cache | L3，可重建，模型/version 不匹配整份失效 |
| retrieval/outcome telemetry | 默认不含正文，有界保留，必须先有消费方 |
| audit/Purge tombstone | 最小、不可逆、无原文；保留期和导出策略由隐私合同冻结 |
| import staging/backup | 有明确 owner、过期和清理路径，不得成为永久影子真相源 |

具体时间长度、容量上限和用户覆盖策略属于 Privacy/Operations Gates，但任何类别都不得默认无限保留“因为以后可能有用”。

---

## 14. 故障、降级、诊断与恢复

### 14.1 可以显式降级的优化

- reranker 不可用 → hybrid/lexical；
- embedding 不可用 → lexical；
- 索引 stale → 返回旧 view 并标记 stale；
- 非关键 telemetry 失败 → 记录 best-effort 诊断。

失败不能伪装成“没有相关记忆”。结果必须携带 degraded/partial/stale 状态。

### 14.2 必须 fail-closed 的正确性操作

- canonical mutation；
- single-writer admission；
- capability/scope filtering；
- source integrity；
- purge；
- unknown lifecycle parent；
- schema/projector compatibility。

### 14.3 Doctor 必须能回答

- L1 integrity 与未知 parent；
- L2 drift 和 projector version；
- L3 rebuildability/index version；
- intake/outbox/pending Proposal 深度；
- retry/defer/expiry；
- stale/partial provider 状态；
- Loadout/delegation 越界；
- purge 进度和派生物残留；
- schema migration readiness；
- 最近 capture、projection 和 retrieval degradation；
- **共存态**：本机当前有几套记忆系统在消费 `agent_end`、在注入 prompt、在持有 authority（§7.4；共存期最危险的状态是静默双活）；
- **Unreconciled 积压**：当前有多少条 proposition 处于 Unreconciled 状态（§9.4.4）。因为 INV-INVISIBILITY 禁止把它们做成常驻待办列表，doctor 是唯一的可见性入口——否则积压完全不可见；
- **Ephemeral 证据量**：有多少证据来自 Ephemeral Session 因而默认不投影（§9.5）。

所有 hook/自动化动作必须有可诊断、可手动触发的等价操作，但具体 CLI/API 名称仍由运行接口 ticket 决定。

### 14.4 资源与预算必须有界

所有具体数值由 Operations/Retrieval Gates 通过 prototype 和 dogfood 冻结，但实现从第一天必须具备以下可配置上限和 typed exhaustion outcome：

- 单次 capture/source excerpt 大小；
- 每 session 未处理 intake 数量与总字节；
- worker 全局并发、per-project/per-session 串行键；
- retry 次数、backoff、deadline 与 poison-item terminal；
- extractor/reranker timeout、token 和日预算；
- candidate pool、Memory Card 数量、单卡和总 token；
- Durable Work Store、audit 和 telemetry 保留容量；
- archive/purge 单批操作量。

达到上限时必须选择明确的 `deferred / rejected / degraded / operator_action_required`，禁止静默 drop、无界重试或用最新任务覆盖尚未落入 durable authority 的旧任务。模型和 provider 按 extractor、curator、retrieval、review 等角色配置；代码、schema 和 prompt 不硬编码 model ID。

---

## 15. 验证体系

### 15.1 领域不变量

- 相同 L1 + projector version → 相同 L2；
- 删除 L2/L3 后恢复当前有效记忆；
- correction/conflict/supersession/archive/reactivate 正确；
- Purge 后 agentbrain 自身无法从重建、索引或缓存恢复正文；
- purge 声明与枚举在重放下一致，且 rescope 过的 proposition 归属可判定（§10.2.2）；
- L1 永不被就地修改：状态变化只表现为追加的 meta-lifecycle 事件（§9.4.1）；
- Corroboration Count 只上行；任何降级或撤下都可追溯到一次 Human 显式表示（§9.4.3）；
- 同一 Session 内重复使用同一 proposition 只累计一次（§9.4.2）；
- Unreconciled proposition 不出现在默认 L2 结论中，且不因计数累积而转正（§9.4.4）；
- Ephemeral Session 证据被记录且默认不投影（§9.5）；
- 缺失 Delegation Lineage 的证据被标记为 degraded，与"未委派"可区分（§6.3.2）；
- 未处理 Proposal 不静默 accepted；
- Loadout 不创造 capability；
- 子代理不能越过 delegated scope；
- unknown parent 和 schema drift fail-closed；
- Durable Work Store 删除被诊断为 correctness loss，而不是被当作 L3 rebuild。

### 15.2 检索评测

版本控制、中文为主、默认使用合成或匿名 fixture，至少测：

- relevant recall/precision；
- Decision 和理由找回率；
- superseded/expired 误命中率；
- conflict 暴露率；
- provenance 完整度；
- token、延迟和 provider 成本；
- lexical/dense/rerank 增益；
- rebuild 前后结果等价；
- 跨项目、未激活和子代理越界泄漏。

隔离泄漏不是普通平均分；定义为禁止读取的内容出现一次即是失败案例。

### 15.3 Pi E2E

- session capture；
- branch/compaction 重建；
- duplicate lifecycle 幂等；
- remember/correct/archive/reactivate/forget/purge；
- Context Brief 和 Memory Cards；
- Loadout/Session Activation；
- 主 Agent→子代理委派和 Proposal 回流；
- worker crash/restart；
- transcript 不存在时来源解释；
- provider 不可用时显式降级。

### 15.4 Dogfood

Dogfood 用于发现新失败场景，不替代固定 fixture 和不变量测试。没有可复现证据的“更智能”不算设计改进。

### 15.5 替代成功判据

§15.1-15.4 只测**正确性**。在 §2.1 的替代前提下，全部通过也回答不了唯一真正重要的问题：**它是不是比 abrain 现役实现更好。** 因此增加三条独立判据，任何一条不满足都不构成替代成功：

1. **场景覆盖不回退**：agentbrain 必须覆盖 abrain 在本机现役承担的 P0 场景。前置动作是把这些场景显式列出来——不是从 abrain 的代码或 ADR 反推功能清单，而是从用户实际依赖的行为出发（这与 §1 的七个闭环场景是同一件事，但必须逐条对到 abrain 现役行为上）。
2. **复杂度可量化下降 + 所有权脱钩**（复合判据，两条都要）：
   - 复杂度按 §2.2 冻结的口径衡量：**配置键 162 → ≤35，迁移期双写门 17 → 0**。行数不作判据。下降必须来自掉场景复杂度而非掉纪律。
   - 脱钩指全部代码为 clean-room 自写（§12.5），且不存在需要跟随 `upstream/main` 合并才能维持正确性的部分。
3. **领域不变量有测试**：§15.1 的每条不变量都有对应测试，而不是只写在文档里。abrain 的教训是配置和注释都会说谎（本机 `_comment` 写 "remain disabled" 而值为 `true` 的情况反复出现），因此不变量的权威只能是测试。

这三条属于 [#15](https://github.com/josheee1117/agentbrain/issues/15) 的验收门内容，与 §18 M6 的 release gate 绑定。

---

## 16. TencentDB Agent Memory：abrain-first 吸收矩阵

> **状态说明**：下表是 architecture-baseline disposition，不替代 [裁决 TencentDB 机制的 abrain-native 吸收矩阵](https://github.com/josheee1117/agentbrain/issues/12)。该票必须继续核验源码覆盖、成熟度分级、与其他合同的关系和 prototype 后果；允许细化表格，但不得改变“从 abrain 缺口出发、TencentDB 不定义产品边界”的准入规则。

| abrain 问题或缺口 | TencentDB 证据 | v2 结论 |
|---|---|---|
| 不同 Agent 不应默认共享整脑 | FixedAssetBinding、injection mode、priority | **改造吸收**为 Loadout/Activation seam；不把绑定当授权 |
| Capture 与 consolidation 需要解耦 | 每 turn L0 capture + scheduler | **改造吸收**：Pi 轻量 capture，批量 semantic processing |
| Harness/自身注入污染来源 | user-query extractor、originalUserMessageCount | **直接吸收纪律**到 Pi adapter |
| 模型生成 provenance 不足 | generation input/output refs、prompt/model/hash | **改造吸收**为 canonical L1 producer metadata，不做 best-effort 旁路真值 |
| 降级与部分成功不可见 | structured error/partial result | **直接吸收**到 Memory Card/diagnostics |
| 上下文注入成本高 | Persona push、Scene navigation、L0/L1 tool pull | **吸收思想**，用 abrain Policy/Brief + Cards + source expansion 表达 |
| 自动记忆需要人工校准 | Roadmap L1-L3 editable | **改造吸收**为 L1 correction/supersession，不直改 L2 |
| scope/authorization/loadout 混合 | team/user/agent/task + ACL + binding | **吸收教训**：六个维度严格分开 |
| 中文 lexical/dense 实现 | jieba、FTS5、embedding、RRF | **进入 prototype**，不直接选为默认 |
| destructive update/merge | 删除旧 VDB 记录再写新记录 | **拒绝**；保留 event-first 和 lineage |
| 多轨 authority | JSONL/SQLite/TCVDB/COS/Markdown | **反例**；坚持单一 canonical owner |
| Conversation→Atom→Scenario→Persona | 内容抽象层 | **不作为权威层吸收**；Scenario/Profile 只做组合视图 |
| Memory Hub/Panel/团队 ACL | 完整团队服务 | **v2 延后** |
| Proxy wire 逆向识别 | Claude/Codex/dsh adapter | **不作为 Pi-only v2 主路径** |
| README benchmark/E2E | 当前分支不可复现 | **不作为量化设计证据** |

所有引用必须继续区分：已发布实现、feature branch、roadmap、opaque private extension 和不可复现宣称。

---

## 17. v1.2 被替代的决策

| v1.2 决策 | v2 状态 |
|---|---|
| Claude Code / Codex 双首发宿主 | 被 Pi-only 取代 |
| `~/.agentbrain/` Git repo 是 canonical 运行前提 | 被 local canonical owner + sync-neutral 取代 |
| Codex rollout / Claude Stop hook 为 M0 | 被 Pi lifecycle/worker prototype 取代 |
| `claude -p` / `codex exec` 为主要 sediment 算力 | 被 Pi ModelRuntime 候选 seam 取代，拓扑待原型 |
| L1 event ID 必然等于 body hash | 降为 GATE，需与 Physical Purge 一起裁决 |
| `.state/index.sqlite` 同时承载 jobs/queue | 拆成 L3 rebuildable index 与 Durable Work Store |
| 四目录即 L2 本体 | 被 unified proposition + readable views 取代 |
| Tier0→Tier1→Tier2 是最终检索实现 | 降为 prototype 候选矩阵 |
| Git auto-push 属 M4 | 移出 v2 核心 |
| dsh/Claude/Codex adapter seam 在首发里程碑 | 移出 v2 范围 |

继续保留：结构性 capture、单 writer、L1→L2→L3、确定性 projector、分层读取、settings 驱动、手动等价操作和显式降级。

上表读起来像一次没有理由的方向替换，理由在 §2.1：v2 的目标是在 Pi 上**取代** abrain 现役实现。Pi-only 因此不是宿主收窄，而是替代前提——只有落在同一个宿主上，替代才可能发生。

---

## 18. 候选里程碑

以下里程碑是实施顺序框架，不等于实现授权；§19 Design Gates 关闭后才能冻结。

### T0：替代前置轨（与 D0 并行，不排在 M6）

§2.1 把替代定为前提后，以下三项不再是迁移里程碑的收尾步骤，而是决定 M1-M6 值不值得做的前置条件。它们与 D0 并行推进：

- **迁移源资产盘点**（[#7](https://github.com/josheee1117/agentbrain/issues/7)，当前 open 且被隐私 gate 阻塞）：不盘点就不知道要替代的存量是什么形状、provenance 质量如何、有多少映射得上。这条被隐私 gate 卡住意味着**关键路径当前是阻塞的**，必须优先解锁（先关闭 §19 的隐私合同，再针对具体路径取得只读授权，见 §12.3）。
- **abrain 现役 P0 场景清单**（[#15](https://github.com/josheee1117/agentbrain/issues/15)）：§15.5 判据一的输入。不列清单就没有替代成功的定义。
- **运行期共存与切换合同**（§7.4，[#11](https://github.com/josheee1117/agentbrain/issues/11) / [#13](https://github.com/josheee1117/agentbrain/issues/13)）：互斥、灰度、回退、诊断四问。

### D0：关闭实施前设计门

- L1 identity × Purge；
- Durable Work Store；
- unified proposition/L2 views；
- identity/project binding/loadout/delegation；
- privacy/retention/security；
- sediment promotion；
- autonomous forgetting/outcome 范围；
- local store/export/migration；
- **运行期共存与 cutover（§19.12）**；
- operations/degradation/diagnostics/recovery；
- retrieval contract；
- acceptance gates 与 rollout（含 §15.5 替代判据）。

### P1：L1 / Purge state-machine prototype（**先行**）

验证 append-only lineage、合法 range purge、missing/corrupt/purged 区分和 rebuild，以及 §10.2.2 的声明+枚举在重放下可验证。

**P1 与 P0 已换序（LOCKED）。** 理由是 §12.5 的 clean-room 路径把两侧风险对调了：

- L1 的形状是唯一一处"定错就要重写全部下游"的决定，而它恰好是唯一**没有上游答案可读**的地方——§10.2 的 Purge Range、§9.4 的 Corroboration/Unreconciled 都是 abrain L1 不存在的词汇（§19.1）。
- P0 的七项在 abrain 里全部有现役实现可读，按 §12.5 那正是"当规格读"的标本，风险从"选型"降为"读懂"，不需要用 prototype 去发现。

先做 P0 会导致在还不知道 L1 形状时就定下 capture 的 payload 形状。

**必须承认的代价**：P1 先行意味着头几周没有可 dogfood 的东西，反馈周期变长。

### P0：Pi lifecycle / worker prototype（排在 P1 之后）

- capture seam；
- branch/compaction；
- parent 退出后的 worker；
- duplicate delivery；
- user-turn/delegation lineage（按 §6.3.2，血缘是必填输入，验证的是缺失时的降级标记）；
- first-turn model registry；
- degraded behavior；
- §9.4.5 三层判断链前两层的承载形态（§19.3）。

### P2：Retrieval prototype

在固定中文 fixture 上裁决 lexical、dense、fusion、multi-vector 和 rerank。

### M1：Canonical Core

- local store；
- Durable Intake/Work Store；
- sole writer；
- L1 append；
- deterministic L2；
- L3 rebuild；
- doctor。

### M2：Explicit Lifecycle

- remember；
- correct；
- conflict/supersede；
- archive/reactivate；
- forget（Semantic Forgetting，§9.4.3）；
- range purge（声明 + 枚举，§10.2）。

### M3：Pi Read Path

- Context Brief；
- Memory Cards；
- search/get/source expansion；
- visible degradation。

### M4：Loadout 与委派

- Agent Definition；
- Session Activation；
- delegated capability；
- subagent Proposal 回流。

### M5：Autonomous Sediment

- extraction；
- Proposal；
- policy-based promotion；
- Corroboration Count 与两级门槛（§9.4）；
- 三层判断链与 Unreconciled 处置（§9.4.4-9.4.5）；
- bounded retry/defer/expiry；
- INV-INVISIBILITY。

不含自治遗忘/decay/自动 archive——已出范围（§10.3）。

### M6：Evaluation、Cutover 与 Rollout

- fixture/E2E；
- one-way import（**执行**导入；盘点已在 T0 完成）；
- dogfood；
- 运行期切换（按 §7.4 合同执行互斥/灰度/回退）；
- rollback；
- release gate（含 §15.5 三条替代成功判据）。

M6 只负责**执行**替代，不负责**发现**要替代什么——后者在 T0。

---

## 19. 实施前 Design Gates

### 19.1 L1 Identity × Physical Purge

> **没有上游答案可抄。** abrain 至今没有 Physical Purge：`upstream/main` 的整个 `extensions` 树里 `purge` 只出现两次，且都在无关的 `persistent-input-history` 扩展；ADR 0043 反向印证了这条路线——它把"终态 cleanup 会退化成物理删除或只保留 digest"明确列为**要规避的风险**，abrain 选的是内容寻址 + append-only + 可逆终态。
>
> 注意不要把复核文档 §4.4 的「audit-hmac 物理删除」误读为 purge 机制：那说的是 `_shared/audit-hmac.ts` 这个**文件**被上游删除（320 行 HMAC 完整性层换成 58 行 checksum），与记忆内容清除无关。
>
> 因此本 gate 是 agentbrain 的**原创设计门**，也是 v2 相对 abrain 的真实增量（§2.1）。P1 prototype 不可省略。
>
> **§10.2.1 的范围级口径降低了本 gate 的难度，但没有取消它。** 不支持单条精确删除，意味着不需要为每条 event 设计可独立擦除的身份；问题收窄为"如何定义并证明一个删除范围"（§10.2.2 的声明 + 枚举）。这从"最难的 gate"降为"删除范围的定义问题"，但仍需 P1 prototype 验证 lineage 在范围删除后的可读性。

必须裁决以下一种或形成更好的经过验证方案：

- opaque stable `event_id` 与 `body_hash` 分离；
- content-addressed event + 独立 Purge Manifest；
- 其他不引入普通 Memory 密钥管理的方案。

验收必须回答：

- purge 后 lineage 如何保持；
- projector 如何区分合法 purged、missing 和 corruption；
- tombstone 保留什么；
- 低熵秘密是否能从 hash 猜测；
- unknown parent 如何 fail-closed 但不把合法 purge 当损坏。

### 19.2 Durable Work Store

决定 create-only 文件、独立 SQLite 或组合，并证明：

- L3 删除不丢 intake/Proposal/retry；
- crash recovery；
- idempotency；
- single-writer admission；
- purge journal；
- 不产生第二语义真相源。

### 19.3 Pi Worker 拓扑（子代理执行拓扑已出 gate）

Prototype 裁决 daemon、短命 worker、进程内 worker、RPC 或混合；不得只凭 pi-astack 当前实现选择。

**子代理执行拓扑不再是本 gate 的一部分，也不再是任何 gate。** §6.4 已定：agentbrain 不拥有执行面，只留接缝。gate 的定义是"agentbrain 实施前必须自己裁决的事"；执行拓扑归 Pi/dispatch 所有，把它留作 gate 会错误暗示 agentbrain 有权选择。委派侧 agentbrain 唯一需要冻结的是 §6.3.2 的血缘必填接缝合同，那属于 §19.5。

本 gate 因此收窄为 agentbrain **自有后台 worker** 的进程形态。§9.4.5 的三层判断链前两层运行在此形态内，是本 gate 的新增输入。

**前置动作不是跑 prototype，是先读上游。** 原文"不得只凭 pi-astack 当前实现选择"没错，但本文 pin 的快照（`ad6aa8f`）是 **pre-DCC** 的——上游 `upstream/main` 已经把这块重做过一轮，且 Linux 生产验收：

- **ADR 0046 DCC**：store-present strict regime 下，唯一 canonical convergence executor 是同一 LSEA holder 的 daemon-managed long-lived worker；DCC 叠在 LSEA 之上而不是第二把锁；带 sibling attestation（绑定 LSEA epoch+nonce）。
- **worker 面七车道**：`global_maintenance` 把遗忘/治理车道从前台 `agent_end` 调度挪到 daemon 承载，闭集车道键、闭集状态、闭集 error_code、通知面零自由文本。
- **CSJ**：确定性 join 从设备粒度延伸到会话粒度。

读这些的目的**不是照抄**，而是执行 §2.1 的分离动作：判断其中哪些是**场景复杂度**（Windows 原生 ACL、双仓 implementation authority、staged install/rollback point、生产验收流程——agentbrain 单用户单机可以掉掉大半），哪些是**纪律**（authority 显式化、每个 canonical mutation frame 重验准入、attestation 可观测、fail-closed 而非静默降级——必须留下）。

先读上游再跑 prototype；prototype 用于验证选定形态，不用于从零选型。

参考：另见 §7.4——共存期 agentbrain worker 与 abrain LSEA/DCC holder 互不感知的问题，与本 gate 的形态选择直接相关。

### 19.4 L2 Contract

冻结 proposition envelope、facets、stable identity、四种 readable views、组合视图物化、projector version 和 schema migration。

### 19.5 Identity / Project Binding / Loadout / Delegation

冻结 stable project ID、显式本机 binding/registry、多个 checkout 的执行根区分，以及 capability 建立、收窄、过期、审计和子代理回流；禁止 `cwd`/Git remote 隐式授予项目身份。

### 19.6 Sediment Promotion 与 Corroboration 参数

冻结低风险自动晋升、高影响 Proposal、自治 reject/expire/defer、自然对话校准，以及 accepted proposition → stable Policy/Context Brief 的独立发布门；不建立人工审批 inbox。

§9.4 的机制形状已 LOCKED，本 gate 只冻结其未定参数，**不得由实现者自选**：

- **两级门槛阈值**（§9.4.6）。必须是可调配置项：无真实 corpus 不可能定准，且错误代价不对称（定低了错知识取得注入权，定高了好知识永不升级）。
- **"真被用上"的精确判定**（§9.4.2）。abrain 的可用形状是 `usage-telemetry.ts` 的 `cited`（进入注入块或 decide brief）。**未决问题**：被检索到、模型读过、但明确决定不采用的 proposition 是否计入——abrain 那套会计入，因为它只能观测"是否进入 prompt"，无法观测"是否被采纳"。
- **主题清单的维护形态**（§9.4.4）：如何合并近义主题格，由谁触发。
- **三层判断链的模型分配**（§9.4.5）：第 1、2 层各用什么档位的模型。链的形状是 LOCKED，模型选择不是。

### 19.7 Retrieval Default Profile

由中文 fixture prototype 选择默认 lexical/dense/fusion/rerank；不得把 v1.2 三级栈直接写进实现。

### 19.8 Store / Export / Migration

冻结物理布局、backup/export、schema migration，并在另行授权后盘点真实资产。

### 19.9 Forgetting / Outcome 范围（已裁决，保留供追溯）

**本 gate 已由 §10.3 关闭：自治遗忘出 v2 范围。** v2 只做显式 archive/reactivate/forget/purge，加上 §9.4 的 Corroboration Count（只上行）。

保留本条目的目的是追溯：若 [#15](https://github.com/josheee1117/agentbrain/issues/15) 的 P0 场景清单显示某条现役场景实际依赖自治遗忘，本裁决需重开。

### 19.10 Operations / Recovery

冻结运行接口、资源上限、typed degradation、retry/defer/terminal、doctor/status、手动等价操作和灾难恢复合同。

### 19.11 Acceptance / Rollout

把领域不变量、Pi E2E、隐私隔离、检索 fixture、迁移和 dogfood 组织成硬验收门，冻结 T0/D0/P0-P2/M1-M6 的最终内容和 rollback 条件；验收门必须包含 §15.5 的三条替代成功判据。

### 19.12 运行期共存与 Cutover

冻结 §7.4 的四问——互斥、灰度、回退、诊断——以及切换开关的形态（借用 `PI_ABRAIN_DISABLED` 进程级总闸，还是自建仿 `canonicalGitRuntime` 的 fail-closed 单键，或两者组合）。

本 gate 在 §2.1 的替代前提下是**关键路径**，不是收尾工作。它与 §19.3 强耦合：agentbrain worker 的进程形态决定了它能否与 abrain 的 LSEA/DCC holder 互相感知。

### 19.13 Gate → Wayfinder Ticket

| Gate | Canonical ticket |
|---|---|
| L1 Identity × Purge、Durable Work Store | [定义 L1 证据账本与 durable intake 合同](https://github.com/josheee1117/agentbrain/issues/4) + [定义本地安全、隐私、保留与 Purge 合同](https://github.com/josheee1117/agentbrain/issues/5) |
| Pi Worker × 子代理执行拓扑（同一 gate） | [原型验证 Pi Adapter 与后台 Worker 拓扑](https://github.com/josheee1117/agentbrain/issues/11) **×** [定义身份、作用域、Loadout 与子代理委派合同](https://github.com/josheee1117/agentbrain/issues/6)，交叉裁决 |
| L2 Contract | [定义 L2 记忆身份、投影与生命周期合同](https://github.com/josheee1117/agentbrain/issues/8) |
| Identity / Project Binding / Loadout / Delegation | [定义身份、作用域、Loadout 与子代理委派合同](https://github.com/josheee1117/agentbrain/issues/6)（执行拓扑部分见上一行） |
| Sediment Promotion 与 Corroboration 参数（§19.6） | [定义自动沉淀、Proposal 晋升与人工校准合同](https://github.com/josheee1117/agentbrain/issues/18) |
| Retrieval Contract / Default Profile | [定义检索、Memory Card、交付与评测合同](https://github.com/josheee1117/agentbrain/issues/9) + [原型验证中文检索与 Rerank 取舍](https://github.com/josheee1117/agentbrain/issues/10) |
| Store / Export / Migration | [定义本地 Canonical Store、同步中立与迁移合同](https://github.com/josheee1117/agentbrain/issues/13) |
| **T0 迁移源资产盘点（关键路径，当前被隐私 gate 阻塞）** | [盘点现有迁移源资产与 provenance 质量](https://github.com/josheee1117/agentbrain/issues/7) |
| **运行期共存与 Cutover** | [原型验证 Pi Adapter 与后台 Worker 拓扑](https://github.com/josheee1117/agentbrain/issues/11) + [定义本地 Canonical Store、同步中立与迁移合同](https://github.com/josheee1117/agentbrain/issues/13) |
| Forgetting / Outcome（**已裁决出范围**，§10.3/§19.9） | [定义自治遗忘、归档、复活与 Outcome 回流合同](https://github.com/josheee1117/agentbrain/issues/19)（应关票并记录裁决） |
| Operations / Recovery | [定义运行接口、降级、诊断与恢复合同](https://github.com/josheee1117/agentbrain/issues/14) |
| Acceptance / Rollout（含 §15.5 替代判据） | [定义 v2 验收门、里程碑与 rollout 决策](https://github.com/josheee1117/agentbrain/issues/15) |
| TencentDB 最终 disposition | [裁决 TencentDB 机制的 abrain-native 吸收矩阵](https://github.com/josheee1117/agentbrain/issues/12) |
| 最终设计收敛 | [合成 agentbrain v2 总体设计与 TencentDB 吸收附录](https://github.com/josheee1117/agentbrain/issues/16) |

只有上述 Gates 全部关闭、TencentDB disposition 和最终设计收敛票完成，并更新本文修订记录后，用户明确说“开始实现/按这个做”，才进入生产实现。

---

## 20. 明确 Out of Scope

- 由本文自动授权生产实现；
- v2 正式支持 dsh、Claude Code、Codex、Memory Proxy；
- 多用户团队服务、服务端认证、租户 ACL；
- 完整个人生活 Persona/数字孪生；
- Skill marketplace/执行平台；
- Workflow DAG 引擎；
- Wiki/CodeGraph；
- Vault 密钥管理和 secret release；
- 远程多 Writer、实时跨设备同步、分布式 merge；
- 默认归档完整 Pi transcript；
- 强制所有模型本地运行；
- 对 agentbrain 无法控制的外部副本承诺完全擦除；
- 在没有 corpus 和评测证据时复制 abrain 全套自治遗忘/aggregator。

---

## 21. 修订记录

- **2026-09-07 v2.2（架构决定收敛：23 条决定入文档）**：一次 grilling 会话（`/grill-with-docs 确定架构设计`）把 v2.1 留在 GATE 状态的多数根决定裁决完毕。本次修订把这些决定写入正文，并解决其中六处与既有条文的直接冲突。

  **新增决定（LOCKED）**

  1. **§2.1 替代动机重写为所有权优先**——原文把动机隐含为复杂度；实际首要动机是**所有权脱钩**（能完整读懂、独立演进、不受上游路线牵引），复杂度是次要动机。有效性不是痛点，因此 abrain 继续作为架构母体（§1）不变。"更好"的口径随之改为**复合判据：脱钩 + 复杂度可量化下降**，两条都要。
  2. **新增 §2.2 复杂度预算**——冻结口径为**配置键数 + 迁移期双写门数**，行数不作判据（行数会随场景复杂度免费下降）。实测基线：agentbrain 替代范围内配置键 **162**（全栈 341 中扣除 dispatch/compactionTuner 等从不拥有的域），迁移期双写门 **17**。目标 **≤35 / 0**。预算分配：预算类参数默认写死在代码里，只有确需按机器或阶段调整的留成配置。
  3. **新增 §6.4 执行面边界**——agentbrain 只拥有记忆面，子代理执行归 Pi/dispatch。实测支撑：`dispatch` 扩展**零 import 记忆栈**，唯一耦合是 `dispatch/index.ts:173` 的工具名字符串，因此**工具名重叠就是委派接缝本身**（§7.4.1 该行的性质在稳态下反转）；`createAgentSession` 是 Pi core 公开导出（`dist/core/sdk.d.ts:107`），故"只留接缝"是选择而非 API 限制。
  4. **§6.3.2 改写为"血缘是接缝的必填输入"**——原文的一等字段论证以"agentbrain 拥有执行面"为前提，与上条冲突。改为：委派方必须随 Work Unit 传入血缘，传不到则标记 degraded，**与"未委派"可区分**。代价量化：`_shared/causal-anchor.ts` 585 行的存在目的就是重建本可直接传入的东西。
  5. **新增 §9.4 Corroboration 与 maturity 升级**——本次最大的新增机制：
     - §9.4.1 记忆没有"过期"这回事，不引入有效期字段；状态变化通过向 L1 追加 meta-lifecycle 事件表达，L1 永不就地修改（用户原话："保留 L1 最开始 React 17 以及当前 19 的原始证据，L2/L3 是最终结论"）。
     - §9.4.2 计数口径：按 **Session** 计、必须**真被用上**、"未被否定"须为 Human 显式表示的缺席。依据 `memory/usage-telemetry.ts` 已用代码区分 `retrieval_hit_count` 与 `cited_count`（「「被用」≠「被检索」」）；按检索计数会使最易检索者而非最正确者上涨，并自我强化。
     - §9.4.3 **上行自动、下行显式**。不对称理由：自动上行判错只是升快了，自动下行判错是丢掉正确知识。系统永不从对话推断否定。
     - §9.4.4 主题归属由 agent 提议但对齐已有主题优先；**supersession 归属认不出就不进 L2**（Unreconciled），只能由 Human 确认转正，计数累积不能使其转正。
     - §9.4.5 三层判断链：便宜模型 → 强模型 → 主 agent 下一轮决断。依据一条外部观察（2026-08-28）：难易分流应"先跑便宜的、失败再升级"，而非事前分类。
     - §9.4.6 两级门槛：低门槛得准则地位，高门槛才得默认注入资格。理由是错误代价不同——排序靠前的错知识可被忽略，自动注入的错知识静默影响全部工作。与 §8.5 高影响发布门**串联而非替代**。
  6. **新增 §9.5 Ephemeral Session 证据处置**——记录并标记，默认不投影。可检测性依据 `ReadonlySessionManager.getSessionFile()` 为公开 API；但它只是代理信号，**无法区分被委派的子代理与刻意不留记录的主会话**。
  7. **§10.2 拆为 10.2.1/10.2.2**——Purge 按 **Purge Range** 执行，不支持单条精确删除；范围按写入时不可变 facet 声明。**声明是意图，枚举是回执**：两者都要，压力测试是 rescope——仅有声明则重放会算出不同成员集合，范围墓碑失去证明力；枚举必须在同一 authority frame 内生成。
  8. **新增 §12.4 迁移口径**——人工挑选而非全量迁移，落成可重放 import manifest（源引用 + 背书 + 理由）。全量吃 L1 会要求新 schema 表达 abrain 的事件形状，把刚脱的钩挂回去。**对 #7 的影响**：只需一份可浏览清单供人工挑选，代理侧接触的个人内容面显著收窄，隐私 gate 基本退出关键路径。
  9. **新增 §12.5 代码来源 clean-room**——否决 fork-and-strip（MIT 已排除法律判别式，剩下的判别式是认知所有权；保持上游形状会持续产生合并诱惑，而 `upstream/main` 已领先 50 提交并带 DCC）与"只复用 `_shared` 语义核心"（该核心恰是必须改动、不变量密度最高的部分：Purge Range 与 Corroboration 都是 abrain L1 不存在的词汇）。
  10. **P0/P1 换序**——P1（L1/Purge 状态机）先行。clean-room 路径把两侧风险对调：L1 是唯一"定错要重写全部下游"且唯一无上游答案可读的地方；P0 七项在 abrain 均有现役实现可当规格读。代价：头几周无可 dogfood 之物。

  **解决的六处冲突（原文写着旧决定，照文档实现会写反）**

  1. **§10.1 的 usage-only 禁令**（原："disuse/usage-only 不能单独静默删除长期 Decision/Maxim/Preference"）——改写为**不对称授权**：usage 可单独驱动上行，不可驱动下行。原句会让实现者直接否掉整套 §9.4。
  2. **§8.2 "主 Agent 语义推断 → Proposal"**——拆为两行：自行推断仍是 Proposal；**对后台已备判断的决断可 accepted**（§9.4.4）。不违反 §7.3，因为重活已在后台完成。
  3. **§10.3 自治遗忘从"待裁决"改为明确出范围**——依据是 abrain 作者自己的选择：ADR 0031 声称全量生产，而本机 `executorRealApplyEnabled` 已回退为 `false`、`_comment` 写 "Real forgetting remains disabled"。它另贡献 17 个双写门中的 3 个。§19.9 同步改为已裁决并保留追溯条件。
  4. **§9.4.6 与 §4/§8.5 的"准则"层级缺口**——两级门槛与 §8.5 高影响发布门显式串联，计数只提供候选资格。
  5. **§12.3 "cutover 前保留只读备份"**——改为**长期保留、cutover 后也不删**。理由：人工挑选无完备性保证，归档是唯一补挑来源。
  6. **§19.3 "Pi Worker × 子代理执行拓扑同一 gate"**——子代理执行拓扑**移出 gate 体系**（§6.4 已定不拥有执行面；留作 gate 会错误暗示有权选择）；本 gate 收窄为 agentbrain 自有 worker 形态，并新增 §9.4.5 前两层承载为输入。

  **同步更新**：§8.3（Unreconciled/Ephemeral 不得做成常驻列表）、§9.2（说明为何不选"同主题取最新"）、§14.3（doctor 新增 Unreconciled 积压与 Ephemeral 证据量，因 INV-INVISIBILITY 禁止列表，doctor 是唯一可见性入口）、§15.1（新增 8 条不变量）、§15.5 判据二（改为复合判据并写入数字）、§18 M2/M5、§19.1（范围级口径使本 gate 从"最难"降为"删除范围定义问题"，但 P1 仍不可省）、§19.6（新增四项待定参数）、§19.13 票据表。

  **CONTEXT.md 新增术语**：Corroboration Count、Unreconciled Proposition（另有 v2.1 已加的 Ephemeral Session、Delegation Lineage、Purge Range）。

  **仍未关闭**：§19.6 的四项参数（两级门槛阈值、"真被用上"的精确判定、主题清单维护形态、三层链模型分配）；§19.1 的 event identity/tombstone 物理模型；其余 §19 各 gate 不变。**实施仍未授权。**


- **2026-08-21 v2.1（替代前提与共存合同）**：对 v2 baseline 的一次评审修订，七处改动：
  1. **新增 §2.1 替代前提（LOCKED）**——agentbrain 的目标是在 Pi 上取代 abrain 现役实现，Pi-only 是替代前提而非宿主收窄；同时定义"更好"的口径为**掉场景复杂度、留纪律**。理由：§2/§17 原文读起来是一次没有理由的方向替换，而这一句决定 M1-M6 值不值得做。§17 补同向说明。
  2. **新增 §7.4 运行期共存与切换**——四个已确认冲突面（`agent_end` 双消费、`before_agent_start` 注入链式合并、工具名重叠、DCC/LSEA authority 与 agentbrain worker 互不感知）、四问（互斥/灰度/回退/诊断）、两个候选形状（`PI_ABRAIN_DISABLED` 进程级总闸、仿 `canonicalGitRuntime` 的 fail-closed 单键）。理由：原 §12 只在 store 层声明单 canonical owner，管不到运行期；本仓研究文档已自认此风险未验证，现升级为必须设计的合同。§14.3 相应增加共存态诊断项。
  3. **新增 §18 T0 替代前置轨**，M6 收缩为只负责"执行"替代——资产盘点（#7，当前被隐私 gate 阻塞，属关键路径）、abrain 现役 P0 场景清单、运行期共存合同三项从 M6 末尾提为前置条件。理由：在替代语义下 cutover 不是收尾动作。§12.3 迁移纪律本身不变，只改位置。
  4. **新增 §15.5 替代成功判据**——场景覆盖不回退、复杂度可量化下降、领域不变量有测试。理由：§15.1-15.4 只测正确性，全部通过也回答不了"是不是比原来好"。
  5. **新增 §6.3.1 继承 ADR 0042**——单层 dispatch + 五项结构性工具无例外拒绝（`dispatch_agent`/`dispatch_parallel`/`workflow_run`/`prompt_user`/`vault_release`）。理由：0042 的依据是行为证据（多层任务复述产生目标漂移），与宿主无关，clean-room 重写同样适用，故默认继承而非重新裁决。新增 §6.3.2 记录"自己拥有执行面 → 委派血缘成为一等字段"这一架构简化。
  6. **§19.3 与子代理执行拓扑合并为同一 gate**（#11 × #6 交叉裁决），前置动作改为"先读上游 DCC / 七车道 / CSJ 再跑 prototype"。理由：本文 pin 的 `ad6aa8f` 是 pre-DCC 快照，上游已重做过这块并 Linux 生产验收；prototype 应用于验证选定形态，不用于从零选型。新增 §19.12 共存 gate，原 §19.12 顺延为 §19.13 并补交叉裁决与 #7 行。
  7. **§19.1 明确没有上游答案可抄**——实测 `upstream/main` 的 `extensions` 树中 `purge` 仅 2 处命中且均在无关扩展，ADR 0043 更把"终态退化成物理删除"列为要规避的风险。**订正一处评审误读**：复核文档 §4.4 的「audit-hmac 物理删除」指的是 `_shared/audit-hmac.ts` 这个文件被上游删除，不是 purge 机制。因此本 gate 是 agentbrain 原创设计门，也是 v2 相对 abrain 的真实增量，P1 prototype 不可省略。
- **2026-08-21 v2 architecture baseline**：Wayfinder 重绘。设计母体改为当前 abrain unified proposition/event-first；首发宿主改为 Pi-only；新增 Durable Work Store、Human/Agent/Loadout/delegation、Proposal 双状态轴、Physical Purge、Memory Card、隐私威胁模型和可复现评测；八区重新映射为统一 proposition/read models 与独立 Skill/Vault seams；TencentDB 只做 abrain-first 选择性吸收；Git、Worker、Purge identity 和检索算法降为实施前 Gates；旧 M0-M4 被候选 D0/P0-P2/M1-M6 取代。理由：保留 abrain 核心纪律，同时避免宿主耦合、平行真相、平台膨胀和未经验证的实现选型。
- 2026-08-04 v1.2：增加 abrain/sediment 实现参考，未改变 v1.1 主体。
- 2026-08-04 v1.1：检索栈升级为三级阶梯并补充 abrain 架构全景。
- 2026-08-04 v1：Claude Code/Codex 通用记忆设计初稿。

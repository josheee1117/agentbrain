# agentbrain 总体设计

- 状态：**v2.6 宿主无关基线**
- 最新修订：2026-10-12
- 实现状态：**切片 1 已实现（仅 Pi，`src/`）；切片 1.5（宿主无关化，2026-10-10 已实现）；切片 2 代码完成（2026-10-10），三宿主接线 2026-10-12 完成，Claude Code 模型侧实测待复验；切片 3（自动沉淀）2026-10-12 代码完成，先于 2.5，尚未接入用户机器、未跑真实模型（§21）**
- 设计母体：abrain 的 event-first、统一命题、结构性沉淀、确定性投影、分层读取与自治纠错纪律
- 宿主：Pi、Claude Code、Codex 平等接入，任一都可作为主体会话（§7）
- **产品前提：宿主无关的个人 Agent 记忆；先把记忆本身做好，首个替代对象是 Pensieve（§2.1）；动机首先是所有权，其次是复杂度（§2.2 定量）**
- 决策地图：[绘制以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
- 领域词汇：`CONTEXT.md`
- 主要证据：
  - `docs/reference/20260804-pi-astack-abrain-sediment-架构与实现参考.md`
  - `docs/research/20260820-tencentdb-agent-memory-调研.md`
  - `docs/research/20260821-pi-memory-集成与子代理接缝.md`
  - `docs/research/20260821-current-abrain-sediment-复核.md`
- 引用基线：pi-astack fork `ad6aa8f`（本机现役，pre-DCC）；alfadb `upstream/main` `f5e955e`（§19.3 要求先读的上游演进）；`earendil-works/pi@5cd93f6`

> 本文是一份完整的 **architecture baseline**：产品边界、领域不变量、权威模型、宿主边界、读写路径、隐私安全、Loadout/子代理、验证和候选里程碑已经明确。本文不会把尚未验证的物理存储、Purge 身份模型、Worker 进程拓扑或检索算法伪装成已拍板；这些事项列在 §19，关闭前不得开始生产实现。

---

## 1. Destination

agentbrain v2 要交付一个以 abrain 为母体的本地记忆系统：

1. 自动从 Pi、Claude Code、Codex 的真实工作生命周期捕获工程证据；
2. 将来源、推断和生命周期变化写入可追踪的 L1 权威历史；
3. 以确定性方式投影出当前可读、可纠正的 L2 记忆；
4. 通过可重建 L3 索引和分层读取，为主 Agent 与子代理提供精准、受控、可解释的上下文；
5. 支持用户自然纠正、语义遗忘和受控物理清除；
6. 形成可以复现的中文检索、隔离、重建和三个宿主的端到端验证体系；
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

### 2.1 产品前提（LOCKED，v2.5 改写）

**agentbrain 是宿主无关的个人 Agent 记忆。Pi、Claude Code、Codex 任一作为主体会话，都接入同一个本地 store，读写同一份记忆。**

v2.0 到 v2.4 的前提是"在 Pi 上取代 abrain 现役实现"，Pi-only 是它的直接推论。这个前提已经失效：

- 2026-09-14 实测 abrain 已从本机 Pi 卸载（`~/.pi/agent/settings.json` 的 `_comment_pi_astack` 自述 "Uninstalled from Pi"），本机现役子代理宿主是 `npm:pi-subagents`；用户自述 abrain 实际使用不多。
- 2026-10-09 实测 agentbrain 自己的 Pi 扩展也已停用（符号链接改名为 `~/.pi/agent/extensions-disabled-agentbrain`），`~/.agentbrain/store.db` 为 0 条事件。切换宿主没有数据要迁。
- 用户日常在三个宿主之间切换。只服务一个宿主的记忆在另外两个宿主里就是断档，场景①"踩过的坑不再踩"一换宿主就失效。

v2.5 因此撤销 Pi-only，四条直接后果：

1. **先把记忆本身做好**（用户 2026-10-09 原话："第一批要完成的应该是 agentbrain 自己本身那个记忆的功能"）。§15.5 的四个场景仍是验收对象。
2. **首个替代对象是 Pensieve**：pm 等仓库 `.pensieve/` 承担的项目记忆职责（maxims、decisions、knowledge、pipelines、short-term，以及 self-improve、refine、doctor）由 agentbrain 接管，对照清单见 §15.5。用户的长期方向是 agentbrain 取代 pm；但是否接管 pm 的仓库档案、计划等非记忆职责，等记忆核心成熟后再定，不在 v2.5 范围（§20）。
3. **宿主接入只走公开 seam**：统一入口是 `ab` 命令行；会话靠各宿主全局规则文件里的一句指令、或主会话的派活说明知道要调用它，不靠给每个宿主装插件（§7.1）。回到多宿主不等于回到 v1 的机制（Git canonical、Stop hook 即 M0、四目录即 L2），见 §17。
4. **全局与项目两级记忆是核心**（§5.3），项目清单以 pm 的 `repos/*.md` 为准（§6.1）。

abrain 仍是架构母体。读它当规格时，它的复杂度有两个来源，必须分开处理：

- **场景复杂度**：多平台（Windows 原生 ACL）、双仓 implementation authority、staged rollout、生产验收。以 ADR 0046 DCC 为例，其 status 行塞满 staged install 哈希、D0-D5 切片和跨 pi-astack/pi-router 的权威划分——这些在 agentbrain 的单用户单机边界下天然掉掉大半。
- **纪律**：event-first、单一 canonical owner、确定性投影、authority 显式化、fail-closed、可逆终态。这些必须留下。

**动机首先是所有权。** abrain 的有效性不是痛点，正因如此它才继续作为架构母体（§1）。驱动重写的是这套系统必须是自己的：能完整读懂、能独立演进、不受上游路线牵引。这条对 Pensieve 同样成立。次要动机是复杂度：abrain 对单用户而言过重；Pensieve 是文档式记忆，与 §15.5 记下的三个文档痛点同类。

因此**"更好"是复合判据：所有权脱钩 + 复杂度可量化下降**，两条都要，不是二选一。复杂度下降必须来自**掉场景复杂度**而非**掉纪律**。口径与目标值见 §2.2。

替代**仪式**（运行期共存、灰度、回退、迁移盘点）对 abrain 的价值已归零：§7.4/§19.12 于 v2.4 关闭，#7 降为可选。对 Pensieve 的切换同样不做灰度：某个仓库的 Pensieve 职责由 agentbrain 接手后，停用该仓库的 Pensieve hook 与路由即为切换，`.pensieve/` 目录原地保留作只读归档（§12.3）。

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

**v2.5**：替代对象改为 Pensieve 后，上表的 abrain 基线只作参照；≤35 / 0 改为与替代对象无关的绝对预算，宿主 adapter 的配置也计入。

双写门归零是绿地的天然红利，不是成就：这 17 个门全部只因 abrain 必须在活着的系统上增量迁移而存在。**从零开始就不该有任何一个。**

**配置预算怎么花（LOCKED）**：abrain 的 162 键里最大一块是预算类（超时毫秒、重试次数、批大小）。这类**默认写死在代码里**，不给配置键——单用户单机不会去调"第 3 步超时是 8 秒还是 12 秒"，这些数字存在的原因是 abrain 要跨多机多场景运行。代价是改一个数字要改代码并重启，这在"代码是自己的"前提下可接受。**只有少数确实需要按机器或按阶段调整的项留成配置**，§9.4.6 的使用门槛阈值是已知的一例（无真实数据不可能定准）。

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
- `ab` 命令行，三个宿主的接线（全局规则文件、派活说明）、会话身份判定与 transcript 读取（§7）；
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

**v2.5：全局与项目两级范围是核心，不是后续增量。** abrain 的出发点正是 Pensieve 只绑单项目、跨项目的偏好与知识无处安放（`docs/reference/20260804-pi-astack-abrain-sediment-架构与实现参考.md` §1.1 演进史）；agentbrain 若只做项目级，替换 Pensieve 等于复刻它的局限。切片 1 的代码只有项目级（`project_id` 必填），切片 1.5 补齐。切片 1.5 实现的最小形态：

- **范围（spatial scope）**：`global` 或 `project:<id>`。abrain 的 domain/session/task 级范围保留在 facet 定义中，出现真实需求再实现。
- **可读种类**：规则（normative，Maxim/Preference 视图）、决定（Decision）、坑（带 trigger 的 normative，§5.4）、事实（Knowledge Claim）。切片 1 已有后三种（`decision`/`pitfall`/`note`），补 `rule`。Pensieve pipelines 对应的流程类（Procedure，带 trigger）在切片 2.5 加。
- **范围与种类正交**：规则可以是全局的（"实现交给 Codex"），也可以只属于一个项目（"insuranceagent 基于商业授权，禁止再发行"）。规则不是独立存储，延续 ADR 0040。
- **给谁看（consumer hints）**：默认全局记忆只进主会话，项目记忆进在该项目里工作的任何会话；个别全局规则可标"子代理也要看"（如代码风格），见 §11.1。

### 5.4 用户可理解的 L2 读取语言

以下四种用户可理解的名称必须保留，并且只能从 unified proposition/L2 派生或选择，不能成为四个 canonical truth source：

- **Decision**：已经选择的路线、理由、替代方案和适用条件；
- **Maxim**：跨相似场景复用的原则、约束或经验；
- **Preference**：特定 Human/Agent 的显式或推断倾向；
- **Knowledge Claim**：关于项目、系统或外部领域的可验证陈述。

它们最终是物化 view、检索 facet、兼容别名，还是其中某类需要额外语义不变量，由 §19.4 L2 Contract 冻结。

**坑（Pitfall，v2.4 新增可读标签）**：用户四个真实场景之首。它是带 trigger facet 的 normative proposition（"在什么情况下别做什么，因为什么"），归入 Maxim 视图，不新增第五种 canonical kind。区别于普通 Maxim 的是读路径：坑必须**主动送到 Agent 面前**（§11.1），因为 Agent 不知道自己该去搜。同一 proposition 可以出现在多个组合视图中，但只有一个 canonical identity。例如“非平凡实现先更新设计并获授权”可以同时呈现在 Project Policy、Human Profile 和 Procedure View 中，不复制为三份事实。

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

- **Human**：本地记忆服务的人；Human 范围的记忆即 v2.5 的"全局记忆"（§5.3）；
- **Agent Definition**：稳定角色，如主开发、审查、研究；
- **Agent Execution**：某次具体运行；
- **Project**：稳定工程/知识工作边界；
- **Repository**：Project 关联的代码库身份，不必一一对应；
- **Session**：一次宿主会话（Pi、Claude Code 或 Codex）；
- **Work Unit**：一次任务或委派边界，不实现通用 Task 平台。

Project identity 只认稳定 project ID 与显式本机 binding/registry 关系；`cwd`、目录名或 Git remote 只能作为发现候选，不能自行授予项目身份或记忆资格。同一 Project 的多个 checkout 必须可区分本机执行根。

**v2.5 冻结 registry 形态：项目清单就是 pm 的 `repos/*.md`。** 这是人手维护的显式清单，满足上一条"只认显式 registry"：

- 档案文件名（去掉 `.md`）是项目名；档案里的"路径"行是该项目的主执行根。`README.md` 不是项目。
- `ab` 拿当前目录查清单：先用 git 找到当前目录所属仓库的主工作树（worktree 归回主仓库），再与清单中的路径比对。对不上就是"未登记目录"，只给全局记忆，不给任何项目记忆，也不允许写项目记忆。
- store 内部仍以不透明 project ID 为身份、项目名只是 registry 键；档案改名或路径变化时，`ab status` 报告清单与 store 不一致，由 Human 处理，不自动猜测对应关系。
- 切片 1 的 `/ab bind` 与 `bindings` 表随之删除，不保留兼容路径。

这把 pm 的档案格式变成了 agentbrain 的输入接口。若日后 agentbrain 接管 pm 的档案职责（§2.1、§20），清单随之迁入 `ab`，届时再改。

### 6.2 六个必须分开的概念

1. Ownership：谁负责治理；
2. Authorization/Capability：当前执行是否有资格读取或操作；
3. Semantic Scope：记忆描述谁、哪个项目或工作单元；
4. Loadout Attachment：Agent 默认关注什么；
5. Session Activation：本次会话启用哪些 Loadout 部分；
6. Retrieval/Injection：当前问题最终读取和呈现什么。

Loadout 不授予权限；scope 不等于 ACL；语义相似不能绕过 capability。

### 6.3 子代理委派

Pi 没有公共 subagent/delegation 身份；Claude Code 与 Codex 有子代理 hook（本机 Codex `hooks.json` 已登记 `SubagentStart`/`SubagentStop`），但能否从中拿到可信委派身份未验证（§19.5）。因此 agentbrain 自己定义 delegation contract。父 Agent 不把全部 Loadout 隐式传给子代理，而是为 Work Unit 建立：

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

**子代理汇报（v2.6）**：派活说明要求子代理在汇报末尾单列「新坑 / 决定」，每条附证据（文件路径、命令、报错原文）。子代理本身不写记忆。主会话收到后用 `ab remember`（未确认）记下，来源应指向该子代理。切片 2 补 `ab remember --from-worker <宿主>:<会话id>` 之类的来源参数，形态 **CANDIDATE**。切片 3 的自动抽取从主会话 transcript 读取，子代理汇报因此自然进入沉淀输入，不需要读子代理自己的 transcript。

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

这条把血缘建立的责任交给委派方；其可信传递是否可用仍须验证，不需要 agentbrain 拥有执行面。

术语见 CONTEXT.md 的 Delegation Lineage。

### 6.4 执行面边界：只留接缝（LOCKED）

**agentbrain 只拥有记忆面。子代理如何创建、调度、传参、超时、回收，全部归宿主所有**（Pi 的 pi-subagents、Claude Code 的 Agent 工具、Codex 的子代理）。以下实测均针对 Pi，Claude Code 与 Codex 的对应事实在切片 4 前补齐。

实测依据表明这个边界比预期便宜：

- **pi-astack 的 `dispatch` 扩展完全不 import 记忆栈**（零行代码依赖）。耦合只有一个工具名字符串：`dispatch/index.ts:173` 的 `DEFAULT_SUBAGENT_TOOLS = "read,grep,find,ls,web_search,web_fetch,memory_search,abrain_get,memory_decide"`。
- 因此**工具名重叠不是麻烦，它就是委派接缝本身**。agentbrain 注册同名工具只接通调用名称；执行身份、能力与血缘仍须通过 §6.5 的可信接缝验证，不能由工具名推导授权。§7.4.1 那行"工具名重叠"的性质因此反转：切换期它是冲突面，稳态下它是接口。
- `createAgentSession` 确实是 Pi core 的公开导出（`dist/core/sdk.d.ts:107`），所以"只留接缝"是**本项目的选择，不是 API 限制**。

**2026-09-14 更正宿主事实**：本机现役子代理宿主是 `pi-subagents`（`~/.pi/agent/npm/node_modules/pi-subagents`），其前台路径用 `createAgentSession` + `SessionManager.inMemory()` 建进程内子会话（`src/runs/shared/child-session.ts:260-267`），后台路径 spawn `pi --no-extensions --no-session --mode rpc`。两条路径下子会话均无持久 session 文件，因此 §9.5 的 Ephemeral 信号对本机子代理成立；后台路径不加载全局扩展，agentbrain 工具在其中不可见。上文关于 pi-astack dispatch 的耦合事实仍然正确，但已不描述本机现役宿主。

一条继承而来的硬限制：§6.3.1 禁止嵌套子代理派发，因此**子代理会话内产生的记忆无法再派一个子代理去判断它**——§9.4.5 三层链的第 1 层在该情形下只能退回 agentbrain 自有后台 worker 执行。

---

### 6.5 委派接缝方案（CANDIDATE，排期在切片 4 之后）

> **v2.4 排期**：切片 4 的子代理配合只需"Ephemeral session ⇒ 受限能力"：只读本项目 scoped 搜索、只能提交 Observation/Proposal、不能 accept/purge、血缘标 degraded。以下 Grant 机制在出现第二个消费方之前不实现。

采用 **kernel 管理的 Delegation Grant + adapter 绑定的执行身份**。Grant 是本地记忆能力凭证，不建设独立认证服务，也不通过 prompt 中的自述授予权限。

| 所有者 | 决策职责 |
|---|---|
| Kernel | 校验父 execution 的已有能力，签发/撤销 Grant；每次读取、来源展开和写入检查范围与生命周期 |
| 宿主 adapter | 从可信宿主接缝绑定 execution，传递调用者上下文；模型参数不能覆盖调用者身份 |
| 宿主子代理机制 | 创建与结束子 execution，在首次工具调用前传入父子关系、Work Unit 和 Grant；不负责决定记忆授权 |

Grant 记录 opaque grant ID、父子 execution、Work Unit、允许的 Project/记忆切片、操作集、预算、有效期和撤销状态。子权限取父权限与请求范围的交集；Loadout/Activation 只能进一步收窄。默认允许限定范围的 search/get/source expansion 与 Observation/Proposal 提交，不允许 accepted mutation、扩大授权、再次委派或 Purge。

建立顺序：父 execution 申请 → kernel 校验并记录 Grant → dispatch/adapter 在子会话开始前绑定 child execution → 工具入口从可信上下文查 Grant → kernel 执行资格过滤。凭证不进入自然语言 prompt、记忆正文或普通日志；模型自行填写 grant ID、父 ID 或 cwd 不能建立绑定。

子 execution 结束、授权期限到达、父授权撤销或父 execution 结束时撤销 Grant。重启后不能确认仍有效的 execution/Grant 默认不可用，须由可信宿主重新建立绑定；已经 durable 接收的 Observation/Proposal 保留审计并按工作恢复合同处理，撤销不把它们自动 accepted。

缺失血缘的已接收证据按 §6.3.2 标记 degraded；缺失有效能力绑定时，受限读取和子代理写回均拒绝并返回结构化原因，不能回退成主 Agent、全项目权限或单凭 cwd 放行。血缘信息与授权失败分开报告。

验证要求：同名工具能调用但无 Grant 时被拒绝；伪造参数无效；子能力不能超过父能力；跨项目 source expansion 被拒绝；撤销/超时后旧 handle 不可用；并发读取及 Purge 按 §10.2.3 复查。若现役 dispatch 无可信 metadata 接缝，需在其 owner 侧另行授权增加最小 bridge，或保持该委派能力不可用；不能用 prompt 文本替代，也不能因此扩张 agentbrain 执行面。

---

## 7. 宿主边界：三宿主平等，领域不属于任何宿主

### 7.1 统一入口、接线与会话身份（LOCKED，v2.5）

**唯一入口是 `ab` 命令行。** 记忆核心（L1/L2/L3、投影、检索、来源展开、Purge）是不依赖任何宿主的模块；它的全部能力都经 `ab` 调用：`brief`、`remember`、`correct`、`confirm`、`recall`、`search`、`get`、`archive`、`status`（`correct`、`recall` 为切片 2 新增）。不再有 `bind`，项目身份见 §6.1。理由：

- 三个宿主都能执行 shell，CLI 不需要任何协议依赖；
- Pi 的 MCP 要经过适配器，以 MCP 为唯一入口会让 Pi 多一层；
- CLI 天然满足 §14.3 "所有 hook/自动化动作必须有可手动触发的等价操作"。

MCP 是 CANDIDATE：只有当 shell 传参（中文、引号、多行）在 dogfood 中成为实际问题时才加，且只包同一核心，不新增能力。

**接线：会话靠一句指令知道要调用 `ab`，不靠安装。** 三种会话分别由三处指令覆盖：

| 会话 | 指令在哪 | 依据 |
|---|---|---|
| 用户直接打开的会话（在 pm 或任一仓库，任一宿主） | 三个宿主的全局规则文件各加一句"开工先跑 `ab brief`"：`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.pi/agent/AGENTS.md` | 2026-10-09 实测：Codex 与 Pi 在 pm 中开会话都加载了各自的全局规则文件 |
| pm 里的主会话 | 同上；另外 pm 须有 `AGENTS.md`，否则 Codex 读不到 pm 的规则 | 2026-10-09 实测：Codex 在 pm 中只加载了全局 AGENTS.md，未加载 pm 的 CLAUDE.md；Pi 两者都加载 |
| 被派活的子代理 | 主会话写进派活说明："先在仓库里跑 `ab brief --worker`"，并附上主会话挑选的全局要点 | pi-subagents 的子代理默认**不**加载全局规则文件（其 `docs/agents.md` 写明 global context 默认排除，源码默认值 `inheritGlobalContext ?? false`）；`codex exec` 会加载全局 AGENTS.md（实测；经 codex-rescue 派出的 Codex 未单独测）；Claude Code 子代理未测。派活说明对三家都成立 |

hook 与 skill 降为后备：只有 dogfood 中发现模型漏跑 `ab brief` 时，才给对应宿主加会话开始 hook。不给 pi-subagents 打开 `inheritGlobalContext`，因为那会把整份全局规则交给子代理，与"全局要点由主会话挑选转述"相反。切片 1 的 Pi 扩展删除，Pi 与另外两家走同一条路。

**会话身份：三家都能从 shell 环境取得，且都能对上 transcript（2026-10-09 实测）。**

| | Claude Code | Codex | Pi |
|---|---|---|---|
| shell 环境变量 | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID`（与 `CODEX_SESSION_ID` 同值） | `PI_SESSION_ID` |
| transcript 位置 | `~/.claude/projects/<slug>/<id>.jsonl`，文件名即 id | `~/.codex/sessions/YYYY/MM/DD/rollout-<时间>-<id>.jsonl`，文件名末尾即 id，首行 `session_meta.id` 同值 | `~/.pi/agent/sessions/<cwd 编码>/<时间>_<id>.jsonl`，首行 `session.id` 同值 |
| 定位点 | 每条消息 `uuid` / `parentUuid` 链 | 每行 `ordinal` | 每条 entry `id` / `parentId` 链（`source.ts` 已实现） |
| 工具调用前事件（切片 2 之后可选） | `PreToolUse` | `PreToolUse` | `tool_call` |

**宿主判定不能只看环境变量。** 环境变量会被嵌套启动的下一层宿主继承：实测从 Claude Code 里启动 Pi，Pi 的 shell 里同时有 `CLAUDE_CODE_SESSION_ID` 与 `PI_SESSION_ID`。因此 `ab` 沿父进程链向上，找离自己最近的宿主进程，以它决定 host，再取该宿主的变量。会话身份只用于定位来源，不授予 capability（§13.1）。

### 7.2 只能留在 adapter 的内容

- 各宿主的 event payload、hook 输入格式和环境变量名；
- 各宿主 transcript 的路径、格式和定位点形态（Pi entry id、Claude Code 消息 id、Codex `ordinal`）；
- Pi 的 compaction entry、`createAgentSession()` 签名、jiti `moduleCache:false` 共享状态技巧；
- pi-astack `isSubAgentSession` WeakSet 与 causal anchor；
- 各宿主的 prompt marker 和 UI 文案。

agentbrain domain 接收规范化的 Source、Execution、Work Unit 和 Capability，不持久化任何宿主私有类型作为 canonical 领域对象。Source Pointer 的规范形态是 host + session id + transcript 路径 + 定位点 + 一句摘要。

### 7.3 进程拓扑

LOCKED：

- 宿主主交互路径不等待模型抽取；
- adapter 只做轻量 capture、查询和呈现；
- **多个进程会同时打开同一 store**：三个宿主里同时进行的多个会话，各自执行短命的 `ab`。canonical mutation 仍只有一个逻辑 Writer，由 SQLite 事务串行化实现；写入等待有界（代码常量），超时显式失败，不静默丢写（v2.5）；
- **任何进程读到的投影都必须包含其他进程已提交的写入**：进程内投影缓存和 L3 索引必须以 L1 水位（最大 seq）校验，不能只在本进程写入时失效（v2.5；切片 1 的 `Store` 违反此条，见 §18 切片 1.5）；
- 已接收 intake 必须可恢复；
- 优化失败不阻止宿主对话继续。

GATE：后台 worker 形态，见 §19.3（v2.5 重开）。

### 7.4 与 abrain 现役实现的运行期共存与切换（**已关闭**，2026-09-14）

> abrain 已从本机 Pi 卸载（§2.1 更正）。切换开关就是 Pi 的 package 安装/卸载；回退 = 重新 `pi install` pi-astack，agentbrain 的 store 原地保留。不做分会话灰度。以下四个冲突面与四问保留为**若日后重新安装 abrain 时**的检查清单，不再是 gate。

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
宿主 hook 登记会话坐标（每轮 UserPromptSubmit / Pi before_agent_start；触发形态见 §19.3）
  → Durable Intake：只存 host + session id + transcript 路径 + 处理到的定位点，不存正文
  → 会话已结束（SessionEnd / session_shutdown）或 transcript 静置 30 分钟
  → window builder：从 checkpoint 按轮次切窗口
  → adapter 去除宿主注入、ab 自身输出和 harness 噪声
  → secret/PII/path sanitizer（送模型前）
  → neighbor lookup / dedup context + 项目背景（仓库文档、pm 档案、已确认记忆）
  → LLM extractor（第 1 层，只生成 Proposal）
  → 确定性校验：引文逐字、角色、锚点、种类、sanitizer（写 L1 前再跑一次）
  → 每条候选单独近邻复查 → 关系判定
  → curator decision（准入矩阵，§8.4）
  → append L1 + 窗口完成 + checkpoint 推进（同一事务）
  → deterministic L2 projector
  → L3 reconcile
  → visible diagnostic/outcome（ab doctor）
```

**切片 3 落地（2026-10-12）**。intake 只存坐标，所以"持久化前脱敏"落在送模型前与写 L1 前两处：会话正文从不写进 agentbrain 自己的库，进 L1 的只有抽取出的记忆正文（已二次脱敏）和引文的 sha256。实现见 `src/{transcript,sanitize,intake,extract,work}.ts`。

### 8.2 来源和默认写权

| 来源/行为 | 默认结果 |
|---|---|
| 用户显式 remember/correct | 通过安全校验后形成 accepted L1 intent/event |
| 用户原话、工具输出、代码事实 | Source Observation；不自动扩张成更宽泛结论 |
| 主 Agent 自行推断 | Proposal |
| 主 Agent 对后台已备判断的决断 | 关系结果经过 §9.4.4 与 §8.4 统一准入后才可 accepted；不增加 authority |
| 子代理观察 | Observation |
| 子代理结论/项目决策 | Proposal，不能直接 accepted |
| 旧数据导入 | `imported/unverified` proposition 或 Proposal |
| correction/supersession | 用户始终可触发；自动策略限于规则明确的低风险情况 |
| physical purge | 受控操作，失败必须显式报告 |

**切片 1.5 的落地形态。** `ab remember` 默认记为未确认（agent 自记，对应"主 Agent 自行推断 → Proposal"）。用户明确要求记的加 `--confirmed`。未确认的条目可被 search/get 看到并标"未确认"，但不进任何 brief。用户在对话中认可后由 agent 执行 `ab confirm <id>`，追加 confirm 事件转正。默认未确认时，漏加参数的代价是一条正确记忆暂不进 brief；默认确认时，代价是错误的坑进入之后每个会话的 brief。这不是审批收件箱（§8.3）：不列待办，brief 只提示未确认条数，由主会话在用到时自然询问。

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

**切片 3 的自动转正（2026-10-12，改动本节与 §9.4 的 LOCKED 规则，理由见 §21 同日条目）**。自动沉淀的条目一律先是未确认。转正只有三条路：用户确认；`ab work` 按项目真实代码核验，拿到程序能逐字核对的代码证据（文件存在且引文在所引行内，或 commit 是 HEAD 的祖先且提交说明里有引文）；规则与决定在至少两个不同会话里都有用户原话支持，且两处原话不同（防 resume/fork 复制的历史冒充独立来源）。后两条按本节"独立证据"条款处理：代码是会话之外的独立来源；两个会话里用户各自说过是两份 Human directive，不是同一记忆的派生引用。模型的置信度、模型间一致意见、计数都不能转正。全局记忆、待确认的纠正、关系未判定的条目不走自动转正。

禁止建立批量记忆审批后台作为正常闭环。**Unreconciled 集合（§9.4.4）与 Ephemeral 证据（§9.5）都不得做成常驻待办列表**：它们在检索自然命中时带 `unreconciled`/`ephemeral` 标记进入 Memory Card，由主 Agent 自然决定问不问；系统**不**另设"当前任务是否确实依赖"的判断步骤（那本身是 §9.4.3 不信任的模型判断）；总量由 doctor 报告（§14.3）。§9.4 的 Corroboration Count 之所以不违反本条，是因为计数在后台自行排队、不向 Human 呈现列表，只在达到门槛时才可能触发一次询问。进入 stable Policy View 的高影响 Proposal 必须经过独立证据、明确用户 directive 或另行冻结的高影响校准策略；不得仅凭单模型高 confidence 发布。

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
- archived；
- purged。

`expired` 只是 Proposal admission 的终态，不是 accepted proposition 的语义状态（与 §9.4.1 "不引入有效期字段"一致）；Memory Card 的 temporal validity 只展示 temporal horizon facet。

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

### 9.4 Corroboration 与使用成熟度（LOCKED 权限边界，参数待定；**排期在切片 4 之后**）

> **v2.4 排期**：用户的四个真实场景（§15.5）没有一个依赖使用计数排序，且"真被用上"的信号尚无可靠来源。机制文本保留，前四个切片不实现；进入实现前必须先定采用信号（候选：模型 footnote 自报引用，只信其上行），否则重蹈 abrain usage-telemetry 死数据流。

#### 9.4.1 记忆没有"过期"这回事

一条 proposition 不因为时间流逝而失效。"这个项目用 React 17"在写入时是真的，升级到 19 之后**两条都是真的证据**——L1 同时保留，L2 只投影当前结论。因此 v2 **不引入有效期字段**：写入时无法知道有效期，标出来的数字必然是猜的。

状态变化通过**向 L1 追加 meta-lifecycle 事件**表达，永不修改既有 L1 记录（§5.1 的 append-only 是整套架构的承重墙：正因为普通 L1 写入不可改，"同一份 L1 + 同一 projector version → 同一份 L2"和 purge 可验证才成立）。一条 proposition 的完整历史是 L1 上的一串事件——被断言 → 累积使用 → 被 Human 否定 → 撤下；当前状态由 projector 按各状态轴的有效事件及因果顺序计算，不能用最后一条任意事件覆盖全部状态。要"在 L1 里看到状态"，看的就是这个尾部，不是去改历史。

#### 9.4.2 计数口径（LOCKED）

Corroboration Count 的口径是：**在多少个不同 Session 里真正被用上且未被 Human 否定。**

三条约束都是 LOCKED：

- **按 Session 计，不按检索次数计**。同一 proposition 在一个 Session 内被翻出五次也只 +1，否则一次话多的会话就能把它顶上去。
- **"被检索到"不算，"真被用上"才算**。abrain 已用代码给出这个区分：`memory/usage-telemetry.ts` 分别记 `retrieval_hit_count` 与 `cited_count`，头注释明写「「被用」≠「被检索」: citation 是 retrieval 的真子集, 信号更强」。若按检索计数，涨得最快的将是**最容易被检索到的**而非最正确的，且会自我强化：升级 → 注入更多 → 检索更多 → 涨更快。
- **"未被否定"必须是 Human 显式表示的缺席，不是模型判断**。见 §9.4.3。

`usage-telemetry.ts` 的定位说明：abrain 已经在数这个计数，但明确是"纯观测，零行为"（头注释：不做任何 demote/delete/归档）。agentbrain 将计数接到**使用成熟度**，不能把它解释为真实性或来源独立性。

#### 9.4.3 上行自动、下行显式（LOCKED）

| 方向 | 触发 | 是否需要 Human |
|---|---|---|
| +1 | Session 结束时，该 Session 内真被用上且无 Human 显式否定 | 否，全自动 |
| 降级 | Human 表示"这条不太行" | **是，必须显式** |
| 撤下结论 | Human 表示"这条是错的" | **是，必须显式** |

使用计数只能提高使用成熟度并影响合格候选内的排序。它不能提高证据 authority、改变 admission、把描述性知识变成规范性 Maxim，或单独获得默认注入资格。自动抬高错误记忆也会影响后续工作，因此发布不能仅靠计数；用户没有否定不等于背书。

**因此系统永不从对话里推断否定。** "该 Session 内未被否定"的判定方式是查该 Session 内有无 Human 的显式降级/撤下表示，**不是**让模型判断"用户刚才那句话是否在否定某条记忆"——后者既贵又不准，且失败方向恶劣：把一句技术讨论误判为否定，会静默压低一条正确的知识而用户完全看不见。这与 §9.4.2 第三条约束和 §8.3 的人机校准三模式一致。

"撤下结论"的语义是 **Semantic Forgetting**（§10.1）：检索查不到、不注入，证据保留在 L1。不是 Physical Purge——后者只按 Purge Range 批量执行（§10.2）。同一份证据日后若被其他证据重新印证，可以按 reactivate 路径回来。

#### 9.4.4 主题归属与关系判定（LOCKED）

主题由 Agent 提议并优先对齐已有主题。主题相同不证明结论相同，也不证明新结论替代旧结论；资格过滤后的邻居检索结果只是关系判定输入。

关系判定是独立于 Proposal admission、accepted proposition semantic state 和 publication eligibility 的一条轴：

| 关系判定结果 | 含义 | 后续动作 |
|---|---|---|
| pending | 自动链尚未完成 | 保持 Proposal，不进入当前结论 |
| resolved-new | 已完成必要邻居检查，确定没有要替代的旧命题 | 进入 §8.4 准入检查；没有 supersession target 是合法结果 |
| resolved-related | 已确定目标、关系及支持证据；关系可以是 corroboration、conflict、supersession 等 | 进入对应关系及准入检查，不因时间较新自动覆盖 |
| unreconciled | 自动链结束仍无法确定关系，包括无法判断是否需要替代 | 只记 L1 及受限证据读取，不进入默认 L2 当前结论；仅 Human 可解除 |

`resolved-*` 只表示关系已解决，不等于 accepted。accepted 也不等于 stable Policy 发布；后者单独受 §8.5 约束。关系判断和准入决定都须写入 L1，不能只存在于模型推理或后台缓存。

Unreconciled 的解除必须由 Human 明确确认“无需替代”或“与哪些命题是什么关系”，追加 resolution 事件后重新执行准入。Human 也可以拒绝该 Proposal。计数、新一轮后台复核和主 Agent 的认可均不能自行解除；追加新证据仍可保留供 Human 按需判断。

不建立常驻审批列表。仅在当前任务确实需要时询问一次，doctor 报告总量。近义主题维护不影响已存在命题的稳定身份，具体合并合同仍由 §19.6 冻结。

验收反例：

- 首条“项目使用 React 19”在完整邻居检查后可为 resolved-new，不能因为没有 React 17 而被阻塞。
- 已有 React 17，新观察来自另一 checkout；未确定适用范围前不能直接 supersede。
- 前两层不确定，第三层仍不确定：进入 unreconciled。下一会话再次命中不能靠累计使用转正。
- Human 指定替代关系后可重新准入，但不会自动获得 Policy 默认注入权。

#### 9.4.5 三层判断链（LOCKED 形状，模型分配待定；**切片 3 只实现第 1 层**）

> **v2.4 排期**：按本节自己的原则"先跑便宜的、失败再升级"，切片 3 只做第 1 层，不确定结果如实写 L1 并进 Unreconciled；测出不确定率后再决定是否加第 2、3 层。

自动链按低成本后台模型 → 更强后台模型 → 主 Agent 顺序执行；前两层由 §19.3 的自有后台 worker 承载，不依赖子代理递归派发。每层输出关系候选、目标引用、证据和明确的不确定结果。

第 3 层只消费已完成的后台结果，不同步等待抽取。没有下一轮主会话时，保持 pending 并服从有界 defer/expiry；不存在必须唤醒 Human 审批的要求。重试、升级与终态边界仍由 §19.6/§19.10 冻结。

任一层能给出可校验的关系时，可进入 §8.4 的统一准入规则；主 Agent **没有额外 authority**，模型间一致意见也不构成独立来源证据。自动链全部结束仍无法确定时才进入 Unreconciled；之后只走 §9.4.4 的 Human 解除路径。

三层的成本收益和“多数任务会在第一层结束”尚无本项目实测依据，必须在 prototype 中报告各层占比、误判与成本，不能把预期收益当成 gate 已关闭的证据。

#### 9.4.6 两级门槛（LOCKED 两级结构，阈值待定）

| 门槛 | 获得什么 | 错误代价 |
|---|---|---|
| 低门槛 | 提高使用成熟度，在已符合读取资格的候选内参与排序 | 错误候选可能更易被采用，不能扩大 scope 或改变 modality |
| 高门槛 | 触发 Policy View / Context Brief 的独立资格检查 | 检查失败必须保持无默认注入资格 |

使用计数不能代替 authority 或证据质量。显式 Human directive，或符合 §19.6 冻结策略的独立证据，才可使内容通过 §8.5 发布门；从同一记忆派生的跨 Session 引用、模型复述和多模型意见不算独立证据。高门槛不妨碍符合发布合同的显式用户约束直接取得资格。

v2 不建设通用去自回声平台，但晋升必须保留并检查来源血缘，这是发布正确性的最低条件。无法证明独立性的证据按非独立处理。验收必须包含“同一错误命题跨多个 Session 被反复注入或采用，计数增加但 authority、admission、modality 和默认注入资格不变”。

**待定参数**（属 §19.6，不得由实现者自选）：

- 两级门槛的具体数值。阈值影响排序与资格检查频率，不决定真实性或发布授权；**无真实数据不可能定准**，因此必须是可调配置项（§2.2 允许的少数配置之一）。
- "真被用上"的精确判定。进入注入块或 decide brief 只算 exposure，不自动算采用；模型明确不采用不得计入。实际采用信号及跨 Session 的幂等结算仍由 §19.6 冻结，无法证明采用时不增加计数。

### 9.5 Ephemeral Session 的证据（LOCKED）

一次性会话（无持久 session 记录）的证据**记录并标记，不丢弃，默认不投影为结论**。

可检测性依据：ephemeral 信号由各宿主 adapter 提供（§7.1）。Pi：`ReadonlySessionManager.getSessionFile()` 是公开 API，返回 `string | undefined`；`SessionManager.inMemory()` 构造出的会话该值为 undefined，因此"无持久 session 文件"是**公开可见的代理信号**。Claude Code 与 Codex 的对应信号未验证，切片 4 前关闭（§19.5）；拿不到信号的宿主按非 ephemeral 处理并在 doctor 中标明信号缺失。

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

**usage 信号的不对称授权（LOCKED）**：usage 可以单独驱动**使用成熟度上行**（权限限制见 §9.4），不能单独驱动**下行**。任何降级、语义遗忘或撤下结论都必须有 Human 的显式表示；disuse 本身永不构成删除长期 Decision、Maxim 或 Preference 的理由。该限制不阻止由显式 Purge 引起的传递依赖失效（§10.2.3）。

### 10.2 Physical Purge 边界

Purge 至少覆盖：

- L1 body；
- L2 views；
- L3 index/cache；
- Durable Work Store 中的相关正文；
- agentbrain 管理的临时文件和可访问本地副本。

只留下不含原文、秘密、可逆摘要或不必要敏感元数据的最小状态。对远端 Git 历史、外部 clone、第三方备份和宿主 transcript 只报告 best-effort，不承诺全球可验证擦除。

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

#### 10.2.3 传递依赖整体失效（LOCKED 语义；**排期在切片 4 之后**）

> **v2.4 排期**：四个真实场景无一涉及删除。切片 1 只实现范围 = Session 的 Purge：删除范围内 L1 行、写入声明 + 枚举事件、重建 L2/L3，并以不变量测试证明"删后不可从任何受控面恢复正文"。传递依赖闭包在存在派生物（切片 3 的抽取产物）之后再实现。

清除 A 时，失效集合是直接范围内的记录及所有传递依赖 A 的产物。B 属于另一 Project、经过 rescope、已被汇总或已进入稳定视图，都不能免除该依赖。无依赖关系的内容不受影响。

1. **先禁止服务和发布**：在同一 authority frame 固定范围声明、直接成员枚举和传递依赖闭包，并持久化 Purge 意图。该切点之后相关结论、来源展开、缓存和待发布结果立即失去服务资格；并发 writer、后台任务和恢复重试必须重验，不能继续发布旧结果。范围内迟到 intake 或导入重放必须被既有 Purge 记录识别和拒绝，不能绕过当时的枚举。
2. **清除受控正文**：删除直接记录正文，以及依赖它生成的 L1 摘录/模型结果、L2/L3、Durable Work Store 结果、临时文件和受控副本中的相关正文。派生记录可能同时带有其他证据；无法安全拆分时整份派生产物清除，不保留混合正文。仅保留最小无敏感内容的 lineage/tombstone。
3. **独立来源可以保留，旧结论不得直接保留**：例如 B 同时依赖 A 和独立来源 C，旧 B 整体失效；原本独立的 C 可保留。只允许从 C 重新生成候选并重新执行关系、准入及发布检查，记录新 revision/derivation，不复用旧 B 正文和准入结果，也不自动 reactivate 被清除版本。
4. **完成是逐面确认**：失效和物理清除分别记录。任何受控面未清干净都报告 partial/failure，且相关结果持续不可读；崩溃重启从 Purge journal 继续。外部宿主 transcript、第三方备份和只读 abrain/Pensieve 源归档按 §10.2 报告外部残留，不能宣称全球擦除。

所有可发布派生物必须有完整来源依赖。无法确定闭包时先阻断可能受影响的读取/发布面并报告 failure，不能猜测删除成功。物理 identity、依赖索引的权威来源、清除顺序、缓存失效屏障和迟到写入拦截由 §19.1/§19.2 的 P1 一起证明。

P1 验收包含 A→B→C 跨项目依赖、A+C→B 多来源、rescope、Purge 中途 crash、并发发布、迟到 capture、import manifest 重放、受控备份残留，以及删除 L2/L3 后全量重建。共同断言：旧派生结果不得服务，已清除正文不得从任何受控面恢复，无关独立内容仍可用。

### 10.3 自治遗忘出 v2 范围（LOCKED）

v2 必须有 explicit archive/reactivate、supersede/withdraw/expire、forget/purge 分离。

以下能力**明确不在 v2 范围内**，不是"待裁决"：

- 自动 archive executor；
- 自动 decay / demote；
- 自动 reactivate；
- 通用去自回声分析平台（发布门的来源血缘检查仍属 §9.4.6 必需合同）；
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

**开工时各会话拿到什么（v2.5）**：

| 会话 | `ab brief` 给的内容 | 能写什么 |
|---|---|---|
| pm 里的主会话 | 全局规则 + 各项目概况（每个项目几条坑、最近的变化）；要动某个项目时再 `ab brief <项目>` | 全局与任意已登记项目 |
| 直接在某仓库打开的会话 | 全局规则 + 该项目的坑与 always-show 决定 | 全局与该项目 |
| 被派活的子代理（`ab brief --worker`） | 该项目的坑与 always-show 决定 + 标了"子代理也要看"的全局规则；其余全局要点由主会话写进派活说明 | 不写；汇报末尾单列新坑与决定并附证据，主会话用未确认的 `ab remember` 记下（§6.3） |

各类 brief 只放已确认条目（§8.2）。

`ab` 目前分辨不出子代理（§19.5），所以 `--worker` 由派活说明给出；"子代理只读"在切片 1.5 同样靠派活说明约定，切片 4 再做强制。

**坑的主动投递（v2.4）**：Session Brief 只放本项目的坑与 always-show 决定，预算为代码常量（切片 1 定为约 1,500 字符）；超预算时只放最近的坑并提示用 search。切片 2 增加以用户 prompt 为 query 的每轮召回；更精准的"Agent 准备执行某命令前查该命令的坑"走宿主的工具调用前事件（§7.1 表），列为切片 2 之后的可选项。

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

宿主 adapter 决定它被渲染成 marker block、工具结果、摘要还是按需读取入口；`ab` 的命令行输出是三个宿主共用的默认渲染。

### 11.4 算法（混合检索 LOCKED，其余候选）

**检索（LOCKED，v2.6）**：FTS5 trigram + 稠密向量混合。向量以二进制 BLOB 存在 `index.db`（属于 L3，可删可重建）。查询时在进程内暴力计算余弦相似度。上限：约一万条以内毫秒级，超过再换 sqlite-vec 扩展。

**融合与门槛（切片 2 定，2026-10-10）**：

- 融合用 RRF（k=60），两路各取前 20 条。评测脚本没有对比加权融合，这一项保留 RRF 是因为没有反证，不是因为赢了加权。
- 向量路的余弦门槛默认 0.45（`ab search`）。依据是 53 条语料、121 条查询的阈值扫描：0.45 时正例召回 93%，负例误报 33%。
- 每轮召回（`ab recall`）另用 0.55。同一扫描中 0.55 负例误报 0%、召回 63%；0.50 召回 87%、误报 13%。每轮注入宁缺毋滥，所以取更严的一档。
- 两个门槛都是代码常量（§2.2），不是配置键。
- 评测脚本是 `scripts/eval-retrieval.ts`，语料在仓库外的 `~/.agentbrain/eval/`。数字取自当时写进代码注释的结果；纯 FTS 与混合的对比表没有留存，复跑需要 DashScope key。

其余仍为候选：

- CJK char n-gram vs 分词；
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

### 12.2 物理选择（v2.4 冻结大部分）

已冻结（2026-09-14，理由见 §21 v2.4）：

- store root：`~/.agentbrain/`；
- L1 与 Durable Work Store：同一 SQLite 文件 `store.db`，不同表；L1 表 append-only；
- L3：独立 SQLite 文件 `index.db`（FTS5 trigram，中文可用），删除即重建；
- event ID：不透明随机 ID + 自增序号定序；body hash 单独列，随 purge 一起删；不保留 JCS（无跨设备幂等需求）；
- L2：L1 上的纯函数投影，不落盘；需要人读时再导出 Markdown；
- 多进程访问（v2.5）：store.db 与 index.db 会被多个宿主进程和短命 `ab` 进程同时打开；WAL + 有界 busy 等待；index.db 的重建以 L1 水位为准（§7.3）。
- embedding（LOCKED，v2.6）：OpenAI 兼容接口。用户选定阿里云 DashScope `text-embedding-v4`。地址与模型名写在 `~/.agentbrain/embedding.json`，两个配置键，计入 §2.2 的配置键预算。API key 只存 macOS 钥匙串（service `agentbrain-embedding`），不进文件、不进环境变量。理由：Codex 的 `shell_environment_policy inherit = "core"` 会过滤自定义环境变量（2026-10-10 实测）。向量以二进制 BLOB 存在 index.db（§11.4）。index.db 的 meta 记录生成向量所用的模型名；模型变化即视为索引失效，全部重算。embedding 不可用（无 key、网络失败、超时）时显式降级为纯 FTS，`ab status` 报告降级原因，不阻塞 remember/brief（§14.1）。

仍未冻结：backup/export bundle；schema/projector migration runner（出现第一次 schema 变更时再定）。

### 12.3 迁移纪律

- 真实导入须先关闭 L1/L2/隐私合同；仅供人工挑选的目录清单按 §12.4 的最小授权面处理；
- 盘点个人 store 前必须针对具体路径和命令另行取得只读授权；
- 默认只记录 schema、数量和匿名分布，不复制个人正文；
- 可识别的 Evidence、Decision、Maxim、Preference、Knowledge 尽量映射；
- 只有派生 Markdown、无法恢复来源的内容标为 imported/unverified；
- 目标已存在不覆盖；
- 单向导入，不建设永久兼容层；
- abrain 的现役 store 作为**只读归档长期保留**，cutover 完成后也不删除；回退依靠该归档而非双主。理由：§12.4 的迁移口径是人工挑选，没有完备性保证，归档是唯一能补挑的来源。

以上纪律本身不变，但**它们的位置改了**：在 §2.1 的替代前提下，cutover 不是 M6 末尾的收尾动作，而是决定 M1-M6 值不值得做的前置条件。因此资产挑选清单（[#7](https://github.com/josheee1117/agentbrain/issues/7)，按 §12.4 收窄）从"迁移里程碑的一个步骤"上升为**关键路径**，见 §18 T0。

另需注意：本条的"回退依靠备份而非双主"只覆盖 store 层。运行期回退（两套扩展同挂 Pi 时如何退回 abrain 且不丢切换期新增记忆）由 §7.4 单独承担。

### 12.4 迁移口径：人工挑选 + 可重放 manifest（LOCKED）

**不做全量迁移。Human 人工挑选一批高价值记忆导入。**

排除全量 L1 迁移的理由：在 §2.1 的所有权动机和 §12.5 的 clean-room 路径下，全量吃 L1 意味着 agentbrain 的新 schema 必须能表达 abrain 的事件形状——把刚脱的钩又挂回去。

导入必须落成**可重放的 import manifest**：

- 源引用清单（挑了哪些）；
- Human 背书（谁确认的）；
- 选取理由（为什么留它）。

理由与 §10.2 的"声明是意图、枚举是回执"同源：不记 manifest，则一次 schema 迁移或一次 purge 之后就要重新人工挑一遍，而"当时为什么留这条"三个月后已不可复原。挑选时顺手记接近零成本，事后重建不可能。

**v2.5**：首个实际导入源是 pm 等仓库的 `.pensieve/`（maxims、decisions、knowledge、pipelines），口径不变，同样人工挑选并落 manifest；导入后 `.pensieve/` 原地保留作只读归档，不删除。

导入的 proposition 以 `imported` 落地并保留"来自 abrain"或"来自 Pensieve"的来源标识（L1 已有 `imports` 事件类型）。必须承认的代价：**人工挑选没有完备性保证**，因此 abrain 现役 store 必须作为只读归档长期保留（§12.3），它是唯一能补挑的来源。

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

- 宿主 transcript；
- 宿主 hook 输入与环境变量（只能用于定位来源，不能授予 capability）；
- 工具输出；
- 模型产物；
- 导入资产；
- 记忆正文；
- 外部 Skill/Workflow 引用。

Capability-limited actors：各宿主的主 Agent 和子代理。它们不会因为“是 Agent”就自动拥有全部记忆。

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
- **来源默认是指针不是摘录（v2.4，v2.5 泛化到三宿主）**：Source Observation 记录 host + session id + transcript 路径 + 当时的定位点（Pi leaf entry id、Claude Code 消息 id、Codex `ordinal`）+ 一句摘要；"还原当时怎么讨论出来的"靠按需读取 transcript 的该位置及其祖先链，agentbrain 自身不存对话原文；transcript 不存在时来源展开显式报告不可用（§15.3）；
- 明确摘录不是完整上下文；
- rejected/expired Proposal、临时来源和模型 I/O 采用有限保留策略；
- prompt/model/input/output provenance 优先记录版本和 hash，只有解释正确性必需时才持久化正文；
- **向量计算会离开本机（v2.6）**：记忆正文与切片 2 每轮召回的用户 prompt 会发送到阿里云 DashScope 计算向量。这是用户 2026-10-10 的明确选择，用户已知情。sensitivity 高的条目是否跳过向量化留作 **CANDIDATE**。
- **切片 3 的出境范围扩大（2026-10-12）**：`ab work` 把**脱敏后的会话窗口**（去掉宿主注入与 ab 输出，工具输出只留报错首尾）、有界的项目背景（仓库 AGENTS.md / CLAUDE.md / README、pm 档案、已确认记忆）、以及代码核验时模型请求读取的**仓库文件片段**（同样先脱敏）发到抽取模型的 chat 接口。用户 2026-10-12 原话"数据无所谓"，即同意这一范围。**接收方是阿里云 DashScope（OpenAI 兼容 chat 接口，模型 `qwen-plus`，2026-10-12 11:42 用户选定）**，与向量计算同一家。仍然不出境的：未脱敏的原文、仓库外的文件、`.git` 内部。

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
- embedding 不可用（无 key、网络失败、超时）→ 纯 FTS，`ab status` 报告降级原因，不阻塞 remember/brief（§12.2）；
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
- **Ephemeral 证据量**：有多少证据来自 Ephemeral Session 因而默认不投影（§9.5）；
- **宿主接线（v2.5）**：三个全局规则文件里"开工先跑 `ab brief`"那一句是否在位；pm 是否有 `AGENTS.md`；当前调用来自哪个宿主、会话身份是否取得；repos 清单中路径不存在或与 store 对不上的项目；同一仓库是否仍有 Pensieve 与 agentbrain 同时生效（静默双注入）。

所有 hook/自动化动作必须有可诊断、可手动触发的等价操作，但具体 CLI/API 名称仍由运行接口 ticket 决定。

### 14.4 资源与预算必须有界

所有具体数值由 Operations/Retrieval Gates 通过 prototype 和 dogfood 冻结；实现从第一天必须有以下明确上限和 typed exhaustion outcome。预算值默认作为代码常量，只有符合 §2.2 的机器/阶段差异才暴露配置键：

- 单次 capture/source excerpt 大小；
- 每 session 未处理 intake 数量与总字节；
- worker 全局并发、per-project/per-session 串行键；
- retry 次数、backoff、deadline 与 poison-item terminal；
- extractor/reranker timeout、token 和日预算；
- candidate pool、Memory Card 数量、单卡和总 token；
- Durable Work Store、audit 和 telemetry 保留容量；
- archive/purge 单批操作量。

达到上限时必须选择明确的 `deferred / rejected / degraded / operator_action_required`，禁止静默 drop、无界重试或用最新任务覆盖尚未落入 durable authority 的旧任务。模型和 provider 按 extractor、curator、retrieval、review 等角色配置；代码、schema 和 prompt 不硬编码 model ID。embedding 的地址、模型名与 API key 存放见 §12.2。

---

## 15. 验证体系

### 15.1 领域不变量

- 相同 L1 + projector version → 相同 L2；
- 删除 L2/L3 后恢复当前有效记忆；
- correction/conflict/supersession/archive/reactivate 正确；
- Purge 后 agentbrain 自身无法从重建、索引或缓存恢复正文；
- purge 声明与枚举在重放下一致，且 rescope 过的 proposition 归属可判定（§10.2.2）；
- L1 的普通状态变化只追加 meta-lifecycle 事件；授权 Purge 按 §10.2 清除正文并保留最小墓碑（§9.4.1）；
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

### 15.3 宿主 E2E

下列各项在 Pi、Claude Code、Codex 上**各跑一遍**；某项依赖的宿主信号不存在时，记为该宿主的显式降级，不算通过（v2.5）。切片 1.5 的最小集是：在已登记仓库中 remember → 新会话看到 Brief → search → get 展开来源。另加四条用例：
  - 跨宿主：在 A 宿主记下的坑，出现在 B 宿主新会话的 Brief 中；
  - 全局：在仓库甲记下的全局规则，出现在仓库乙的 Brief 中；在未登记目录只出现全局记忆；
  - 子代理：主会话派活后，子代理在目标仓库执行 `ab brief --worker`，拿到该项目的坑，且拿不到未标"子代理也要看"的全局规则；
  - 嵌套：从宿主 A 里启动宿主 B 时，B 中记下的来源指向 B 的 transcript，而不是 A 的。

- session capture；
- branch/compaction 重建（Pi）；
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

### 15.5 成功判据

§15.1-15.4 只测**正确性**，全部通过也回答不了唯一真正重要的问题：**它是不是比原来好。** 因此增加三条独立判据，任何一条不满足都不构成成功。v2.5 起"原来"指用户现在实际在用的记忆方式，首先是 Pensieve。

1. **场景覆盖不回退**（v2.5：四个场景在三个宿主中任一作为主体时都要成立）：**清单已由用户于 2026-09-12 给出（#15 输入）**，四个真实场景按优先级：①踩过的坑不再踩；②还原一个决策当时是怎么讨论出来的（要过程不只要结果）；③快速定位记忆；④跟子代理的配合。用户在其他项目用文档记录的三个痛点，是这四个场景的反面：不会及时更新、上下文太多浪费 token、丢失讨论过程只剩结果。abrain 在本机已卸载且实际使用不多，因此"不回退"的比较对象是这四个场景本身，不是 abrain 功能面。
2. **复杂度可量化下降 + 所有权脱钩**（复合判据，两条都要）：
   - 复杂度按 §2.2 冻结的口径衡量：**配置键 162 → ≤35，迁移期双写门 17 → 0**。行数不作判据。下降必须来自掉场景复杂度而非掉纪律。
   - 脱钩指全部代码为 clean-room 自写（§12.5），且不存在需要跟随 `upstream/main` 合并才能维持正确性的部分。
3. **领域不变量有测试**：§15.1 的每条不变量都有对应测试，而不是只写在文档里。abrain 的教训是配置和注释都会说谎（本机 `_comment` 写 "remain disabled" 而值为 `true` 的情况反复出现），因此不变量的权威只能是测试。

这三条属于 [#15](https://github.com/josheee1117/agentbrain/issues/15) 的验收门内容。

**Pensieve 替代对照清单（v2.5，切片 2.5 的验收）**。一个仓库可以停用 Pensieve，当且仅当下表每一行在 agentbrain 中都有对应且经过 dogfood：

| Pensieve | agentbrain 对应 | 所在切片 |
|---|---|---|
| `maxims/` 工程准则 | Maxim 视图（normative，无 trigger） | 2.5 |
| `decisions/` 架构决策 | Decision 视图（已有 `decision`） | 1 |
| `knowledge/` 文件位置、模块边界、调用链 | Knowledge Claim 视图（已有 `note`） | 1 |
| `pipelines/` 按触发词执行的流程 | Procedure 视图，带 trigger，经每轮召回送达 | 2 + 2.5 |
| `short-term/` 暂存与到期 refine | 不单独对应：显式 remember 直接生效；需要暂存的模型推断走切片 3 的 Proposal（§8.3），不另建暂存区 | — |
| self-improve | `ab remember`（显式）；自动沉淀在切片 3 | 1 / 3 |
| refine（triage、compress） | correct / supersede / archive | 2 |
| doctor | `ab status` / doctor（§14.3） | 1.5 |
| sync-instructions（把路由写进 CLAUDE.md/AGENTS.md） | Brief 注入与 Procedure trigger，不改写仓库指令文件 | 2 + 2.5 |
| 知识图谱（"基于 / 导致 / 相关"三类链接） | 「相关」由向量近邻替代；「基于」由 Source Pointer 与 why 替代；结论演变由 supersede / conflict / corroboration 关系边替代（§9.4.4）。不建独立图谱视图，`ab get` 展示该条的替代、冲突与近邻 | 2 / 3 |

---

## 16. TencentDB Agent Memory：abrain-first 吸收矩阵

> **状态说明**：下表是 architecture-baseline disposition，不替代 [裁决 TencentDB 机制的 abrain-native 吸收矩阵](https://github.com/josheee1117/agentbrain/issues/12)。该票必须继续核验源码覆盖、成熟度分级、与其他合同的关系和 prototype 后果；允许细化表格，但不得改变“从 abrain 缺口出发、TencentDB 不定义产品边界”的准入规则。

| abrain 问题或缺口 | TencentDB 证据 | v2 结论 |
|---|---|---|
| 不同 Agent 不应默认共享整脑 | FixedAssetBinding、injection mode、priority | **改造吸收**为 Loadout/Activation seam；不把绑定当授权 |
| Capture 与 consolidation 需要解耦 | 每 turn L0 capture + scheduler | **改造吸收**：宿主 adapter 轻量 capture，批量 semantic processing |
| Harness/自身注入污染来源 | user-query extractor、originalUserMessageCount | **直接吸收纪律**到各宿主 adapter |
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
| Proxy wire 逆向识别 | Claude/Codex/dsh adapter | **不吸收**：v2.5 起三个宿主经全局规则文件、派活说明与 `ab` 命令行接入，不做 wire 逆向 |
| README benchmark/E2E | 当前分支不可复现 | **不作为量化设计证据** |

所有引用必须继续区分：已发布实现、feature branch、roadmap、opaque private extension 和不可复现宣称。

---

## 17. v1.2 被替代的决策

| v1.2 决策 | v2 状态 |
|---|---|
| Claude Code / Codex 双首发宿主 | 被 Pi-only 取代；**v2.5 改为 Pi、Claude Code、Codex 三宿主平等**（§2.1、§7） |
| `~/.agentbrain/` Git repo 是 canonical 运行前提 | 被 local canonical owner + sync-neutral 取代 |
| Codex rollout / Claude Stop hook 为 M0 | 被 Pi lifecycle/worker prototype 取代；v2.5 起 Stop hook 重新成为切片 3 capture 触发的候选，但不再是 M0 |
| `claude -p` / `codex exec` 为主要 sediment 算力 | 被 Pi ModelRuntime 候选 seam 取代；v2.5 起 Pi ModelRuntime 不再通用，三者同列 §19.3 候选 |
| L1 event ID 必然等于 body hash | 降为 GATE，需与 Physical Purge 一起裁决 |
| `.state/index.sqlite` 同时承载 jobs/queue | 拆成 L3 rebuildable index 与 Durable Work Store |
| 四目录即 L2 本体 | 被 unified proposition + readable views 取代 |
| Tier0→Tier1→Tier2 是最终检索实现 | 降为 prototype 候选矩阵 |
| Git auto-push 属 M4 | 移出 v2 核心 |
| dsh/Claude/Codex adapter seam 在首发里程碑 | 移出 v2 范围；v2.5 起 Claude/Codex adapter 回到范围（切片 1.5），dsh 仍在范围外 |

继续保留：结构性 capture、单 writer、L1→L2→L3、确定性 projector、分层读取、settings 驱动、手动等价操作和显式降级。

上表读起来像一次没有理由的方向替换，v2.0 到 v2.4 的理由是：目标是在 Pi 上**取代** abrain 现役实现，只有落在同一个宿主上，替代才可能发生。v2.5 撤销了这一前提（§2.1），回到多宿主；但回到的只是"宿主"这一项，表中其他被替代的 v1 机制（Git canonical、四目录即 L2、三级检索栈即实现）维持被替代。

---

## 18. 里程碑：按场景切片（v2.4 重排，v2.5 插入 1.5 与 2.5）

以下取代 v2.3 的 T0/D0/P0-P2/M1-M6 框架。每个切片做完即可 dogfood，各自需要用户明确授权。v2.5 插入两个切片而不重新编号，以保持正文中"切片 3""切片 4 之后"等引用不变。原定顺序为 2 → 2.5 → 3；2026-10-12 用户授权切片 3 先做（§21），2.5 仍需单独授权。

**触发写法修订（2026-10-12）**：原表写的"Pi `agent_end`、Claude Code/Codex `Stop`"是**每轮**事件（官方文档，2026-10-12 查），不能当"会话结束"。改为首轮登记 + `SessionEnd` / `session_shutdown` 加速 + transcript 静置兜底。

| 切片 | 内容 | 覆盖场景 / 痛点 | 关掉的 gate |
|---|---|---|---|
| **1**（已实现，仅 Pi） | `/ab bind` 显式项目绑定；`memory_remember`（坑/决定，自动带 Source Pointer）；`memory_search`（FTS5）；`memory_get` 含来源展开（读 transcript）；archive；每轮注入的小型 Brief；范围 = Session 的 Purge；§15.1 对应不变量测试 | 场景②③可用；场景①可存可搜 | §19.1 身份、§19.2、§19.8 物理布局用代码验证 |
| **1.5**（v2.5，2026-10-10 已实现） | 记忆核心与 Pi 扩展拆开，删除 Pi 扩展与 `/ab bind`；`ab` 命令行（brief / brief --worker / remember / confirm / search / get / archive / status）；全局与项目两级范围、补 `rule` 种类（§5.3）；项目清单读 pm 的 `repos/*.md`、worktree 归回主仓库（§6.1）；会话身份按最近的宿主父进程判定，Source Pointer 泛化为 host + session id + transcript + 定位点，补 Claude Code 与 Codex 的 transcript 读取（§7.1）；多进程正确性（有界写入等待、投影与 L3 按 L1 水位失效，§7.3）；接线：三个全局规则文件各加一句、pm 补 `AGENTS.md`、派活说明约定（§7.1）；三个宿主各跑一遍 §15.3 最小集与四条附加用例；在 pm 与 agentbrain 两个仓库 dogfood | 场景①②③在三个宿主、直接开与子代理两种会话中可用；跨项目规则可用 | §19.5 会话身份部分（已于 2026-10-09 实测关闭）；§19.5 registry 形态 |
| **2**（2026-10-10 代码完成，2026-10-12 三宿主接线，Claude Code 模型侧待复验） | 以用户 prompt 为 query 的每轮召回（坑主动投递）。这一步规则文件做不到，需要 hook：Claude Code/Codex 用 `UserPromptSubmit`，Pi 用一个只调用 `ab` 的几行扩展（`before_agent_start`）；correct/supersede/reactivate；Memory Card 冲突暴露；混合检索（向量）+ 用 pm `repos/*.md` 中已有的真实坑造检索测试集，对比纯 FTS 与混合的命中率 | 场景①完整；痛点"不及时更新"的可见性 | §19.4 L2 合同以类型冻结 |
| **2.5**（v2.5） | 带 trigger 的 Procedure 可读种类；从 pm 的 `.pensieve/` 人工挑选导入（§12.4 manifest）；把散在四处的全局规则（`~/.claude/CLAUDE.md`、Claude 自动记忆、`~/.codex/AGENTS.md`、`~/.pi/agent/AGENTS.md`）人工挑选收进全局记忆，三个文件最后只留 `ab` 那一句；通过 §15.5 Pensieve 对照清单后停用 pm 的 Pensieve hook 与路由 | 首个替代对象落地 | — |
| **3**（2026-10-12 代码完成，先于 2.5；未接线） | 首轮登记（Claude Code/Codex `UserPromptSubmit`、Pi `before_agent_start`）+ 会话结束加速（Claude Code/Codex `SessionEnd`、Pi `session_shutdown`）+ 静置 30 分钟兜底 + launchd 定时 `ab work --sweep` → durable intake → 单层 extractor（带项目背景）→ Proposal → 准入与 Unreconciled；按代码核验与跨会话印证自动转正 | 痛点"不及时更新" | §19.3（已关闭）；§19.6 单层部分 |
| 4 | Ephemeral session ⇒ 受限能力；子代理可用 scoped search；三个宿主的 ephemeral/子代理信号 | 场景④ | §19.5 最小形态 |
| 之后 | Corroboration；三层链第 2、3 层；Delegation Grant；Purge 传递闭包；backup/export。使用成熟度计数因缺可靠"真被用上"信号继续后置（§9.4） | — | §19.6/§19.7 其余 |

原 P1 的 L1/Purge 状态机不再是 throwaway：它就是切片 1 的 `store.ts` 及其测试。原 T0 三项：#15 已由用户口述关闭；#7 降为可选（真有值得搬的记忆手动录入）；§7.4 已关闭。

---

## 19. 实施前 Design Gates

### 19.1 L1 Identity × Physical Purge（身份已裁决；tombstone/传递闭包排期在切片 4 之后）

> **v2.4 裁决**：event_id 为不透明随机 ID，自增序号定序；body hash 单独列。理由：内容寻址的唯一收益是跨设备幂等，v2 已放弃多设备（§12.1）；不透明 ID 使墓碑不泄露低熵秘密。切片 1 实现范围 = Session 的 Purge 并测试。

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

### 19.2 Durable Work Store（已裁决：`store.db` 内独立表）

> **v2.4 裁决**：与 L1 同一 SQLite 文件、不同表；事务保证 outbox 与 L1 原子；L3 在另一文件，删除不影响本表。切片 3 首次使用时补 crash/idempotency 测试。

决定 create-only 文件、独立 SQLite 或组合，并证明：

- L3 删除不丢 intake/Proposal/retry；
- crash recovery；
- idempotency；
- single-writer admission；
- purge journal；
- 不产生第二语义真相源。

### 19.3 后台 Worker 拓扑（**2026-10-12 关闭**）

> **2026-10-12 裁决**（用户授权见 §21 同日条目）：
>
> 1. **谁来消费 intake**：短命的 `ab work` 进程，单实例租约（`store.db` 的 `work_lease`，10 分钟过期，持有者 pid 已死可接管）。三个入口：会话结束 hook 拉起分离的 `ab work --session`；launchd 每 30 分钟 `ab work --sweep`（静置会话、漏登记扫描、代码核验、过期归档）；手动 `ab work`。不做 daemon，不在 `ab brief`/`recall` 的热路径上补跑。
> 2. **算力**：`ab work` 直连 OpenAI 兼容 `/chat/completions`。`~/.agentbrain/extract.json` 写 `model`（必填）和 `baseUrl`（可选，+2 配置键，§14.4 不写死 model ID）；有 `baseUrl` 时 key 读钥匙串 `agentbrain-extract`，没有时沿用 embedding 的地址与 `agentbrain-embedding` 的 key。用户 2026-10-12 选定 DashScope `qwen-plus`，不写 `baseUrl`，沿用 embedding 的地址与 key（§21）。不用会内子代理、`claude -p`、`codex exec`：不抢主会话额度，没有 hook 递归，抽取调用没有工具，transcript 里的注入驱动不了任何操作。代码核验另给只读、限定仓库根的五个工具（search/read/list/git log/git blame），没有写、没有网络。
> 3. **业务理解**：每次抽取带有界的项目背景（仓库 AGENTS.md / CLAUDE.md / README 合计 ≤6000 字、pm `repos/<项目>.md` ≤3000 字、本项目与全局已确认记忆 ≤3000 字、近邻 ≤12 条），都是代码常量。
>
> 以下为重开时的问题陈述，保留供追溯。

> **v2.5 重开时的问题**：
> v2.4 的"进程内后台任务"只对常驻的 Pi 扩展成立；v2.5 删除了 Pi 扩展，三个宿主里都只有短命的 `ab` 进程，会话结束后没有可承载后台抽取的 agentbrain 进程。仍然成立的部分：durable intake 先落 `store.db`（§19.2）；daemon/DCC/LSEA 式多进程收敛仍属场景复杂度，不做。需要裁决的是两件事：
>
> 1. **谁来消费 intake**。候选：会话结束 hook 写入 intake 后拉起一个分离的 `ab work` 进程排空队列，用单实例锁保证同一时刻只有一个；或在下一次任意会话执行 `ab brief` 时补跑。会话结束的触发点本身也要定：各宿主的 Stop/`agent_end` hook，或不用 hook、由下次会话补跑。
> 2. **抽取用什么算力**。Pi `ModelRuntime` 不再通用。候选：`claude -p`、`codex exec`、直接调用模型 API。按 §14.4，代码与 schema 不硬编码 model ID。
>
> 下文"先读上游"仍作为切片 3 的前置阅读。

> **v2.4 裁决（已被 v2.5 重开，保留追溯）**：Pi 为常驻 TUI，后台抽取在扩展进程内执行，durable intake 先落 `store.db`，`session_start` 恢复未完成项。daemon/DCC/LSEA 属多进程收敛的场景复杂度，v2 不做。

Prototype 裁决 daemon、短命 worker、进程内 worker、RPC 或混合；不得只凭 pi-astack 当前实现选择。

**子代理执行拓扑不再是本 gate 的一部分，也不再是任何 gate。** §6.4 已定：agentbrain 不拥有执行面，只留接缝。gate 的定义是"agentbrain 实施前必须自己裁决的事"；执行拓扑归宿主所有，把它留作 gate 会错误暗示 agentbrain 有权选择。委派侧 agentbrain 唯一需要冻结的是 §6.3.2 的血缘必填接缝合同，那属于 §19.5。

本 gate 因此收窄为 agentbrain **自有后台 worker** 的进程形态。§9.4.5 的三层判断链前两层运行在此形态内，是本 gate 的新增输入。

**前置动作不是跑 prototype，是先读上游。** 原文"不得只凭 pi-astack 当前实现选择"没错，但本文 pin 的快照（`ad6aa8f`）是 **pre-DCC** 的——上游 `upstream/main` 已经把这块重做过一轮，且 Linux 生产验收：

- **ADR 0046 DCC**：store-present strict regime 下，唯一 canonical convergence executor 是同一 LSEA holder 的 daemon-managed long-lived worker；DCC 叠在 LSEA 之上而不是第二把锁；带 sibling attestation（绑定 LSEA epoch+nonce）。
- **worker 面七车道**：`global_maintenance` 把遗忘/治理车道从前台 `agent_end` 调度挪到 daemon 承载，闭集车道键、闭集状态、闭集 error_code、通知面零自由文本。
- **CSJ**：确定性 join 从设备粒度延伸到会话粒度。

读这些的目的**不是照抄**，而是执行 §2.1 的分离动作：判断其中哪些是**场景复杂度**（Windows 原生 ACL、双仓 implementation authority、staged install/rollback point、生产验收流程——agentbrain 单用户单机可以掉掉大半），哪些是**纪律**（authority 显式化、每个 canonical mutation frame 重验准入、attestation 可观测、fail-closed 而非静默降级——必须留下）。

先读上游再跑 prototype；prototype 用于验证选定形态，不用于从零选型。

参考：另见 §7.4——共存期 agentbrain worker 与 abrain LSEA/DCC holder 互不感知的问题，与本 gate 的形态选择直接相关。

### 19.4 L2 Contract

**切片 2 部分关闭（2026-10-10）**：已实现的形状以 `src/l2.ts` 的类型冻结，未冻结项见 §21 同日切片 2 条目第 7 条。

**切片 3 扩展（2026-10-12）**：`RememberBody` 增加 `origin`、`basis`、`trigger`、`evidence[]`（锚点 + 角色 + 引文 sha256）、`window_id`、`relation`、`unreconciled`；新增事件 `evidence`（重复时给已有条目追加来源）与 `verify`（代码核验结论，带 HEAD 与代码证据）；`confirm` 事件体可带 `by: corroboration`；`archive` 可带 `reason: expired`。投影新增 `confirmed_by`、`extra_sources`、`code_evidence`、`stale`、`expired`。旧事件缺字段时按原语义投影。

冻结 proposition envelope、facets、stable identity、四种 readable views、组合视图物化、projector version 和 schema migration。

### 19.5 Identity / Project Binding / Loadout / Delegation

冻结 stable project ID、显式本机 binding/registry、多个 checkout 的执行根区分，以及 capability 建立、收窄、过期、审计和子代理回流；禁止 `cwd`/Git remote 隐式授予项目身份。

**v2.5 新增**：
- **会话身份（2026-10-09 实测关闭）**：三个宿主在模型执行 shell 时都提供会话 id，且都能对上 transcript 文件，见 §7.1 表。嵌套启动会继承上层宿主的变量，因此按最近的宿主父进程判定 host。会话身份只用于定位来源，不授予 capability（§13.1）。
- **Project registry（v2.5 冻结）**：pm 的 `repos/*.md`，见 §6.1。
- **ephemeral/子代理信号（切片 4 关闭）**：三个宿主各用什么信号区分子代理会话，见 §9.5。候选：Claude Code 的 `CLAUDE_CODE_CHILD_SESSION` 环境变量（本机存在，语义未验证）、Codex 的 `SubagentStart` hook、Pi 子会话无持久 session 文件。切片 4 之前，子代理身份由派活说明的 `--worker` 约定承担。

### 19.6 Sediment Promotion 与 Corroboration 参数

冻结低风险自动晋升、高影响 Proposal、自治 reject/expire/defer、自然对话校准，以及 accepted proposition → stable Policy/Context Brief 的独立发布门；不建立人工审批 inbox。

§9.4 的机制形状已 LOCKED，本 gate 冻结其未定参数、采用信号与发布策略，**不得由实现者自选**：

- **两级使用门槛阈值**（§9.4.6）。按真实 corpus 标定排序和检查频率；任何数值都不能覆盖证据与发布权限合同。
- **实际采用信号与结算合同**（§9.4.2/§9.4.6）：进入 prompt 仅算 exposure，明确不采用不得计数；未知不加计数。冻结跨 Session 幂等、来源血缘检查，以及高影响发布的独立证据策略。
- **主题清单的维护形态**（§9.4.4）：如何合并近义主题格，由谁触发。
- **三层判断链的模型分配**（§9.4.5）：第 1、2 层各用什么档位的模型。链的形状是 LOCKED，模型选择不是。

**切片 3 关闭的部分（2026-10-12）**：第 1 层模型由用户选定为 DashScope `qwen-plus`（2026-10-12 11:42，用户直接选择，未用评测定；写在 `~/.agentbrain/extract.json`）；跨会话印证的门槛为至少 2 个不同会话的用户原话（代码常量，见 §21）；自动沉淀提议的过期为 90 天（代码常量）。两级使用门槛、采用信号、主题清单仍未定。

### 19.7 Retrieval Default Profile

由中文 fixture prototype 选择默认 lexical/dense/fusion/rerank；不得把 v1.2 三级栈直接写进实现。

### 19.8 Store / Export / Migration（物理布局已裁决，见 §12.2）

backup/export 与 schema migration 在出现第一次 schema 变更时再冻结；真实资产盘点（#7）降为可选。

### 19.9 Forgetting / Outcome 范围（已裁决，保留供追溯）

**本 gate 已由 §10.3 关闭：自治遗忘出 v2 范围。** v2 只做显式 archive/reactivate/forget/purge，加上 §9.4 的 Corroboration Count（只上行）。

保留本条目的目的是追溯：若 [#15](https://github.com/josheee1117/agentbrain/issues/15) 的 P0 场景清单显示某条现役场景实际依赖自治遗忘，本裁决需重开。

### 19.10 Operations / Recovery

冻结运行接口、资源上限、typed degradation、retry/defer/terminal、doctor/status、手动等价操作和灾难恢复合同。

### 19.11 Acceptance / Rollout

把领域不变量、宿主 E2E（§15.3）、隐私隔离、检索 fixture、迁移和 dogfood 组织成硬验收门，冻结 T0/D0/P0-P2/M1-M6 的最终内容和 rollback 条件；验收门必须包含 §15.5 的三条替代成功判据。

### 19.12 运行期共存与 Cutover（**已关闭**，见 §7.4）

冻结 §7.4 的四问——互斥、灰度、回退、诊断——以及切换开关的形态（借用 `PI_ABRAIN_DISABLED` 进程级总闸，还是自建仿 `canonicalGitRuntime` 的 fail-closed 单键，或两者组合）。

本 gate 在 §2.1 的替代前提下是**关键路径**，不是收尾工作。它与 §19.3 强耦合：agentbrain worker 的进程形态决定了它能否与 abrain 的 LSEA/DCC holder 互相感知。

### 19.13 Gate → Wayfinder Ticket

| Gate | Canonical ticket |
|---|---|
| L1 Identity × Purge、Durable Work Store | [定义 L1 证据账本与 durable intake 合同](https://github.com/josheee1117/agentbrain/issues/4) + [定义本地安全、隐私、保留与 Purge 合同](https://github.com/josheee1117/agentbrain/issues/5) |
| 自有后台 Worker（v2.5 重开，执行拓扑不属本项目）；委派接缝需交叉验证 | [原型验证 Pi Adapter 与后台 Worker 拓扑](https://github.com/josheee1117/agentbrain/issues/11) **×** [定义身份、作用域、Loadout 与子代理委派合同](https://github.com/josheee1117/agentbrain/issues/6)，交叉裁决 |
| L2 Contract | [定义 L2 记忆身份、投影与生命周期合同](https://github.com/josheee1117/agentbrain/issues/8) |
| Identity / Project Binding / Loadout / Delegation | [定义身份、作用域、Loadout 与子代理委派合同](https://github.com/josheee1117/agentbrain/issues/6)（候选接缝见 §6.5） |
| Sediment Promotion 与 Corroboration 参数（§19.6） | [定义自动沉淀、Proposal 晋升与人工校准合同](https://github.com/josheee1117/agentbrain/issues/18) |
| Retrieval Contract / Default Profile | [定义检索、Memory Card、交付与评测合同](https://github.com/josheee1117/agentbrain/issues/9) + [原型验证中文检索与 Rerank 取舍](https://github.com/josheee1117/agentbrain/issues/10) |
| Store / Export / Migration | [定义本地 Canonical Store、同步中立与迁移合同](https://github.com/josheee1117/agentbrain/issues/13) |
| **T0 人工挑选清单（具体个人目录读取仍须授权）** | [盘点现有迁移源资产与 provenance 质量](https://github.com/josheee1117/agentbrain/issues/7) |
| **运行期共存与 Cutover** | [原型验证 Pi Adapter 与后台 Worker 拓扑](https://github.com/josheee1117/agentbrain/issues/11) + [定义本地 Canonical Store、同步中立与迁移合同](https://github.com/josheee1117/agentbrain/issues/13) |
| Forgetting / Outcome（**已裁决出范围**，§10.3/§19.9） | [定义自治遗忘、归档、复活与 Outcome 回流合同](https://github.com/josheee1117/agentbrain/issues/19)（范围已决；票据状态由 GitHub 路线维护） |
| Operations / Recovery | [定义运行接口、降级、诊断与恢复合同](https://github.com/josheee1117/agentbrain/issues/14) |
| Acceptance / Rollout（含 §15.5 替代判据） | [定义 v2 验收门、里程碑与 rollout 决策](https://github.com/josheee1117/agentbrain/issues/15) |
| TencentDB 最终 disposition | [裁决 TencentDB 机制的 abrain-native 吸收矩阵](https://github.com/josheee1117/agentbrain/issues/12) |
| 最终设计收敛 | [合成 agentbrain v2 总体设计与 TencentDB 吸收附录](https://github.com/josheee1117/agentbrain/issues/16) |

**v2.4 开工规则**：不再要求全部 gate 关闭后才开工。每个切片（§18）单独取得用户明确授权；切片只能使用已裁决的物理形态，触及未裁决 gate 时停下写修订记录再问。切片 1 已于 2026-09-14 授权（用户原话"按你的来"）。**v2.5**：切片 1.5 与 2.5 同样逐个授权；v2.5 修订本身只授权改文档。

---

## 20. 明确 Out of Scope

- 由本文自动授权生产实现；
- v2 正式支持 dsh、Memory Proxy，或 Pi、Claude Code、Codex 之外的宿主；以 wire 逆向方式接入任何宿主（v2.5 起 Claude Code、Codex 已在范围内）；
- 接管 pm 的仓库档案、计划、跨仓库调度等非记忆职责（记忆核心成熟后再议，§2.1）；
- 多用户团队服务、服务端认证、租户 ACL；
- 完整个人生活 Persona/数字孪生；
- Skill marketplace/执行平台；
- Workflow DAG 引擎；
- Wiki/CodeGraph；
- Vault 密钥管理和 secret release；
- 远程多 Writer、实时跨设备同步、分布式 merge；
- 默认归档完整宿主 transcript；
- 强制所有模型本地运行；
- 对 agentbrain 无法控制的外部副本承诺完全擦除；
- 在没有 corpus 和评测证据时复制 abrain 全套自治遗忘/aggregator。

---

## 21. 修订记录

- 2026-10-15 agent 的 `ab remember` 也走候选区（v3）：用户发现 Claude Code 主模型仍按全局说明在干活中直接 `ab remember`，绕过了"快模型抽取 → 后台审稿"的流程（#53 只改了自动抽取）。现在不带 `--confirmed` 的 `ab remember` 写进候选区（`candidate`），等审稿；`--confirmed`（用户明确要记）照旧直接生效；新增 `--direct` 只给人工迁移数据用（写入事件带 `direct: true`，`ab audit agent-remember` 不会把它当成 agent 自记移进候选区）；`AB_STAGING=off` 同样回到旧行为。brief 提示改为"干活时不用记，后台会自动抽取并审稿；只有用户明确要你记时才用 `ab remember --confirmed`"。新增 `stage` 事件（stage/unstage，可撤销，用户确认过的条目投影时忽略）、`ab stage <id> [--undo]` 和 `ab audit agent-remember --since <时间> [--apply]`，用来把候选区上线后 agent 直接写进正式库、未经用户确认的条目移回候选区。
- 2026-10-13 Pensieve 导入的关系判定可补判：首次真实导入时有 2 批判定调用出错，而重导时导入条都是"未变"，原先不会再判，出错的就永远漏判。现在未变的导入条只要还没有关系判定结果（related 为空）就重新进判定；判定出错把原因（前 5 条）打印出来。没有足够相近邻居的条目只做向量近邻查询，不调模型。
- 2026-10-13 Pensieve 导入试运行后的两处修正：(1) 结论段第一段以冒号收尾（"关键设计点："后接列表）时把下一段并入正文，避免只剩半句；没有结论段的 decision 取"决策"段，跳过"**日期**: …"这类元数据块；(2) knowledge 判为坑的条件收紧为标题含禁止/不要/陷阱/根因/NPE 等措辞，或结论点名是坑/根因/NPE；原先"失败""异常""必须"也算，规范和架构说明有 13 条被误标为坑。另外隐藏文件（macOS 的 ._xxx）和 .migrated/.bak 备份副本不再读取。
- 2026-10-13 新增 Pensieve 导入（ab import pensieve <仓库目录>... [--global <目录>] [--skip-file <文件>] [--dry-run]，用户批准迁移）。只读 .pensieve/{maxims,decisions,knowledge} 里 status=active 的文件，pipelines、short-term、.state 不导，不改 Pensieve 文件。映射：maxim→rule，decision→decision，knowledge→note（标题或结论讲"禁止/不要/坑/会导致"之类陷阱的记 pitfall）。正文=标题＋一句话结论，why=Context/Problem（maxim 取 Guidance/Boundaries，knowledge 取 Content）压成一段，去掉代码块、表格、标题和 [[链接]]，均限 400 字；含密钥的整条跳过。项目按目录走现有项目解析，未登记目录跳过，--global 指定的目录记全局；同一 id 且内容相同的文件出现在多个仓库，只导一次并记为全局。导入条直接是已确认（用户自己写下的知识），origin=import。L1 出处新增 import_ref {system:"pensieve", id, path（原文件完整路径）, sha256, also（其他相同副本路径）}，ab get 显示，view 标"导入"。幂等：按 pensieve id＋项目找已导入的现役条目，sha 相同不动；文件内容变了就写一条 supersedes 旧条的新导入（纠正）；导入条被归档过就不再导。导入后走关系判定：近邻（同项目、相似度≥0.7、非导入条）里是用户确认条目的重复，就把导入条并进去、确认条目不动；是其他条目的重复，就把对方的来源挂到导入条上并把对方并入归档；冲突只标记、列在输出里，由用户处理。--skip-file 每行"id 理由"，用来跳过 Pensieve 默认模板和评审后认为过时或琐碎的条目。全部可撤销（ab archive --reactivate）。
- 2026-10-13 取消日调用/token 上限（用户决定："不用设置上限"）。去掉 DAILY_MAX_CALLS、DAILY_MAX_TOKENS 和给代码核验预留的份额，抽取、关系判定、核验都不再因日用量停下；work_budget 仍按天记录调用数和 token，doctor 显示为"今日用量（只记录，不设上限）"。保留的单次运行限制（只为控制一次运行的时长）：MAX_WINDOWS_PER_SESSION_RUN、BACKLOG_WINDOWS_PER_SWEEP（每次 sweep 补登记会话最多 10 个窗口）、MAX_VERIFY_PER_RUN（每次 3 条）、关系判定每次最多 10 次调用。旧数据里因 budget_exhausted 延后到次日的窗口不再等待，下次运行立即重做。
- 2026-10-13 去噪层补剥宿主注入：清洗后的轮次里还混着 Pi/Claude 注入的 skill 正文（<skill name="…">…</skill>）、后台任务通知（<task-notification>）、Codex app 页面事件（<external_codex_apps_…>）、<user-prompt-submit-hook>，以及 Pi 子代理的整行提示 "Subagent updates above."。它们占窗口、还会被当成用户发言。现在在 stripInjected 里统一剥掉；skill 块要求带 name 属性，避免误伤用户自己打的 "<skill>" 字样；"Subagent updates above." 只剥独占一行的。
- 2026-10-13 抽取只记有背景、有价值的内容。审计 30 条自动记忆：decision/rule 里约一半的 why 只是"用户明确要求"之类的复述，看不出当时发生了什么；真实会话里用户顺口说的小偏好（"要有事实依据""给我直接浏览器打开"）有一半没抽到。改动：(1) 抽取提示要求 decision/rule 的 why 写背景（当时发生了什么、为什么这样定），依据要在引文里看得到；(2) 小偏好仍记成 rule（不新增 kind），提示里给出汇报方式、查看方式、工作流、语气四类例子，说明没有"以后"二字也算；(3) 加价值测试：下次会话的助手知道这条后不会做出不同动作就不记；(4) validate 对 decision/rule 做确定性兜底：why 缺失、少于 8 字、只是"用户要求…/用户的…要求"式复述、或被 text 包含，丢弃并计为 no_why。pitfall 不受此限。逐字引文核对不变。
- **2026-10-13（`ab view`：本地 HTML 记忆浏览页）**：用户 2026-10-13 问能否看到向量化后的记忆、有没有网页能看已有记忆。新增 `ab view [--out <路径>] [--no-open]`：只读打开 store，用现有投影（`Store.project()`）与 index.db 里已存且与当前文本一致的向量，生成一个自包含 HTML（无服务器、无外部资源，数据以 JSON 内嵌，`<` `>` 转义防截断），默认写到 `~/.agentbrain/view.html`，权限 0600，macOS 下 `open` 打开。页面：全部 L2 条目（默认只显示有效，可切换显示已归档/已替代），按项目/全局、类型、状态（用户确认/代码核验/跨会话印证/未确认/与代码不符）、宿主、自动/手动筛选并全文搜索；卡片显示正文、为什么、背景摘要、触发、来源会话、关系（并入/合并自、补充/被补充、冲突、替代链、待确认纠正）、向量近邻 top 5（与 `neighbors()` 同口径：本项目加全局，构建时余弦计算，不发网络请求）；概览按项目/类型/状态计数，向量地图为构建时 PCA（幂迭代，确定性）前两主成分的 SVG 散点，按项目着色、悬停看内容、点击跳卡片。不另造投影；不读 transcript：L1 里用户引文只存了哈希与定位点，页面也只显示这些，原话仍用 `ab get --expand` 看。投影没有"更新时间"字段，页面只显示记录时间。

- **2026-10-13（D3 定案：有用户原话的未确认规则/决定可进每轮召回）**：用户 2026-10-13 让按抽查结论实施 D3。`ab recall` 在已确认命中（最多 3 条）之后，最多再加 1 条未确认条目，标"（未确认）"。门槛：kind 是规则或决定；依据是 user_directive / user_confirmed，且至少一条用户引文；不在关系未判定、与代码不符、冲突、待确认纠正之中，本身也不是纠正。agent 推断的坑和事实不进，要等代码核验转正（转正后走已确认路径）。仍受召回相关度门槛与字数预算约束；未确认那条排在最后，预算不够时先被挤掉。全局条目沿用 for_workers 要求，自动沉淀的全局条目因此不进。依据：§21 同日抽查精确率约 83%（宽口径 90%），错的集中在 agent 推断的坑。这改变了 §8 "未确认条目不进 brief/recall" 中 recall 的部分，brief 不变。

- **2026-10-13（未确认自动条目质量抽查；冲突裁决；prompt 补一条排除项）**：用户 2026-10-13 让自行裁决关系判定找出的 8 对冲突，并抽查未确认条目质量。
  1. **冲突裁决**（按真实代码 → 用户更晚的说法 → 用户确认优先，`ab archive` 归档可撤销）：归档 7 条，第 8 对因对方已归档而自然消解。ai-data 的 e2e 以 2026-10-13 worktree 代码为准（playwright 自拉起、专用端口 3100/4200、真实 Harness worker、真实 Trino 与向量），保留用户确认的"不走 mock"。data-asset 槽位以代码为准：后端先剔除空维度哨兵，`querySql.js` 不剔除，"前端为权威、逐条等价"一条归档。
  2. **抽查**：190 条未确认自动条目里按 id 等距抽 30 条，尽量对照代码。25 条值得记且准确；2 条价值偏低（常识或过于琐碎）；3 条不该记：都是"本项目代码里刚发现的具体缺陷"（agent 推断的坑），其中 1 条代码里已修好、测试已覆盖，1 条只是代码事实。按严格口径精确率约 83%，宽口径约 90%。kind / scope 没有发现明显错误。
  3. **改动**：抽取 prompt 的"不要记"补一条"本项目代码里刚发现、修好就不再成立的具体缺陷"。不改准入规则：代码核验本就会把这类条目标"与代码不符"。
  4. **D3 建议（未实施，待用户定）**：未确认条目进每轮召回时，只放有用户原话依据（user_directive / user_confirmed）的规则与决定，标"未确认"，每轮最多 1 条；agent 推断的坑要等代码核验转正后才进。

- **2026-10-13（纠正只有用户确认才生效）**：#26 合入后 Mac 上仍有 1 条被标"已被替代"：抽取时（2026-10-12）记成待确认纠正的条目，今天被第 2 层并入重复后跨会话印证转正，投影按"已确认的纠正"让它替代了旧条目。这违反 §8.4 第 551 行"待确认的纠正不走自动转正"。修正：(1) 投影里纠正只有 `confirmed_by = user` 时才替代旧条目，被印证或代码核验转正的纠正仍只标"待确认的纠正"；(2) 带 `supersedes` 的条目不走跨会话印证（抽取路径与第 2 层都改）；(3) 用户确认一条已被自动转正的条目时，`confirmed_by` 改记为 user。投影得出，无需补写事件，合入后那条自动恢复有效。

- **2026-10-13（关系判定第 2 层的修正：冲突只标记、不替代）**：PR #25 在 Mac 上首跑后发现，第 2 层判 conflicts 时写的是 `supersedes`；本条当时未确认只算"待确认纠正"，但同一次运行里稍后它被别的条目并入、跨会话印证转正，投影就把对方标成"已被替代"——包括一条用户亲手确认的条目（ai-data"不走 mock、全用真实模型"）。这违反"已确认条目从不被自动修改"。修正：(1) relate conflicts 改记 `conflicts_with`，投影只把本条挂到对方的冲突标记上，从不产生 supersede，不论本条日后怎么转正；(2) 有冲突标记（自己指向别人或被别人指向）的条目不走跨会话印证转正；(3) 第 2 层落地前再查一次本条仍未确认。因为 L1 只追加、替代关系由投影得出，修正合入后那 4 条被误标"已被替代"的条目自动恢复，不需要补写事件。

- **2026-10-13（切片 3：关系判定第 2 层落地；改动 §9.4.4/§9.4.5 的 LOCKED 规则）**：用户 2026-10-13 授权处理"关系未判定"积压（Mac 上 60 条）与重复的自动条目（228 → 273，其中不少来自当天 `--redo` 测试），并指出正常使用里同一件事在不同会话换个说法也会产生近重复，要一个常驻机制而不是一次性清理。
  1. **改动 LOCKED 规则**。§9.4.5 原定切片 3 只做第 1 层（抽取时的模型判断 + 向量复查），不确定就直接进 Unreconciled。现在补上第 2 层：抽取时被标"关系未判定"的条目，在第 2 层判过之前视为 §9.4.4 的 pending，不是终态；第 2 层仍判不出（unsure）才是真正的 Unreconciled，之后照旧只有用户能解除。§9.4.4 里"新一轮后台复核不能自行解除"针对的是这个终态，第 2 层每条只判一次，判过 unsure 不再复核。第 2 层用的是同一个抽取模型，不是"更强模型"：它只看条目正文与近邻两两比较，任务比抽取窄得多；是否换更强模型等测出误判率再定。
  2. **机制**。`ab work` 每次（非 dry-run）处理完会话后跑一遍：挑出自动沉淀、未确认、active、没判过、且有余弦 ≥0.70 近邻的条目（每对只从较新的一侧判；近邻已确认或是手记的也算），每条最多带 3 个近邻，6 条一批交给模型，每次运行最多 10 次调用，计入日预算（抽取份额）。0.70 取自 §21 2026-10-12 的实测：无关对 p90 0.533，"相关但不同"最低 0.757。
  3. **结论怎么落地**，全部写 L1 新事件 `relate`（结论、目标、理由、模型）：duplicate → 给旧条目追加 `evidence`（复用重复追加来源的路径，因而参与跨会话印证：只数不同会话、同一句原话不算），再把本条 `archive {reason: duplicate, into}`，`ab archive --reactivate` 可撤销（已追加的来源不撤）；refines / unrelated → 解除关系未判定，refines 在 `ab get` 显示"是 [x] 的补充"；conflicts → 本条成为目标的待确认纠正（§9.2），目标不论是否已确认都不被改；unsure → 保持关系未判定。模型输出编号越界、缺 target 的不写 L1，下次再判。已确认条目从不被自动修改；自动条目照旧保持未确认，唯一的转正仍是已有三条路。
  4. **`--redo` 幂等**。重跑同一会话换了措辞抽出的近重复，在同一次运行的第 2 层里与旧条目判 duplicate 并入归档，不再留下第二条。
  5. **已知缺口**。A 并入 B 之后 B 又被判为 C 的重复时，A 追加在 B 上的来源不会转到 C，跨会话印证可能少算；目前不处理。

- **2026-10-13（切片 3：引文对不上的排查；只加调试开关，不改校验与 prompt）**：用户 2026-10-13 让查"引文对不上"（doctor 近 7 天整条丢弃里最多的一项）。
  1. **调试开关**。`AB_DEBUG=1 ab work …` 时，每个窗口把送模型的轮次（已脱敏、带 #编号与角色）和模型原始回复（再脱敏一次）写到 `~/.agentbrain/debug/<host>-<session>-<窗口>.json`，文件权限 600；默认关闭。
  2. **证据**。按窗口更新时间拆分 Mac 上的回执：引文对不上、角色不符、编号越界**全部**出在 2026-10-12 11 点（SGT）那一批，当时用 qwen-plus、尚未合入 PR #22 的逐条证据判定。换成方舟 deepseek-v4.1-flash 且合入 #22 之后约 190 个窗口，三项都是 0。2026-10-13 用 `AB_DEBUG=1 --redo` 重跑 1 个 Codex、4 个 Claude 会话（9 个窗口），模型给的 33 条引文 33 条在对应编号的原文里**逐字**命中、角色全对，没有一条靠空白归一才过。唯一例外：当天 09:39 重跑 codex:01a12526 一次出现 4 条引文对不上，此后同一会话重跑 4 次都是 0，那次没开调试，原因未知。
  3. **决定**。不放宽校验（没有证据说明校验过严，放宽只会多放进改写），也不改 prompt。doctor 的近 7 天丢弃数还含旧批次，会随 7 天窗口自然滚掉。再出现时先开 `AB_DEBUG=1` 取原始回复再定。

- **2026-10-13（切片 3：Codex 子 agent 会话不抽取；hook 时未落盘的 transcript 事后补找）**：用户 2026-10-13 让排查 Codex 窗口证据编号越界。依据 Mac 真实数据（Codex 88 个窗口）：
  1. **根因**。17 条"证据编号越界"全部来自 Codex guardian 审批会话（`session_meta.payload.source.subagent.other = "guardian"`）。这类会话的"user"消息是 Codex 塞给审批模型的另一份完整会话记录（单条 4 万字），里面带着自己的编号，模型照着内层编号引用，于是越界；同理带来角色不符和引文对不上。`thread_spawn` 子 agent 的"user"是父 agent，也不是用户原话。`src/transcript.ts` 的编号本身没有错。
  2. **决定**。凡 `source.subagent` 存在的 Codex 会话都按 ephemeral 处理：`ab work` 读到就标 ephemeral、不调模型；扫描兜底不补登记；doctor 的"疑似漏登记"不计 ephemeral（之前 14 个里 12 个是 thread_spawn 子 agent，子 agent 本就不触发 hook）。与 Claude 的 `isSidechain` 同一思路。已经由这类会话产生的未确认条目不追删，等定期代码核验或 90 天过期。
  3. **transcript 为 null**。hook 登记时 rollout 还没落盘的 Codex 会话，`ab work` 处理时按 session id 在 `~/.codex/sessions` 下再找一次 `rollout-*-<id>.jsonl`，找到就补上路径（仍过 `allowedTranscript`）；找不到照旧跳过。`~/.codex/memories*` 下的 Codex 内部会话没有 rollout 文件、也不在登记项目里，本就跳过，不另加规则。

- **2026-10-12（切片 3 质量修正：证据、近重复、预算）**：用户 2026-10-12 授权"把切片 3 完整做完"，依据 2026-10-12 首次真实运行（Mac，qwen-plus，60 次调用，83 条候选：提议 17、丢弃 66——引文对不上 34、证据编号越界 17、角色不符 13、过长 2）。均在 LOCKED 规则之内：
  1. **证据逐条判定**。过不了校验的证据条目只丢那一条；剩下的证据仍满足 basis 的要求（user_directive / user_confirmed 要有用户原文，observed_failure 要有工具输出，rule 要有用户原文）就保留候选。留下的每条引文仍由代码逐字核对（§8.1 硬门不变），丢掉的引文不进 L1。丢弃计数拆成两层：证据级（anchor_outside / role_mismatch / quote_mismatch / quote_length / secret）与候选级（新增 no_evidence、basis_unsupported）。锚点解析放宽到 `#3`、`[#3 user]`、`#3 user` 三种写法，引文去掉首尾引号与省略号后再核对；核对本身不放宽。prompt 改为引文 ≤80 字、逐字照抄连续片段、给出锚点正反例。
  2. **近重复**。(a) 同一窗口内的候选两两比较正文向量，余弦 ≥0.80 且关系相同（同为新提议，或指向同一旧条目的同一种关系）视为同一件事，只留一条——关系不同不合并，免得纠正信号被新提议吞掉：优先 kind 与 basis 对得上的（user_directive→rule、user_confirmed→decision、observed_failure→pitfall），其次证据多的，证据取并集。(b) 与已有条目：原先只有"没给模型看过的"高相似近邻才判 unreconciled；实测模型看过近邻仍标 new（P13/P16 余弦 0.917 都进了库），改为不论是否给模型看过，模型标 new / unsure 而已有条目余弦 ≥0.80 时判 unreconciled（§9.4.4：关系未判定，不进 brief/recall），不由向量自动合并。(c) 门槛 0.80 用 17 条真实提议复核（候选正文向量 vs 已存 text+why 向量，即复查同口径）：同一件事的对 0.917、0.846/0.839、0.815、0.795；相关但不同的对 0.836/0.816（告警判定 vs 通知展示）、0.757、0.623；无关对中位数 0.391、p90 0.533。0.80 能分开大多数，0.795 那对漏判、0.836 那对会被判 unreconciled（可接受：只是不进 brief，等用户裁决）。维持 0.80，不改常量。
  3. **预算**。日预算里给代码核验保留 12 次调用、30 万 token（抽取用到 48 次 / 220 万 token 即停，核验可用到 60 / 250 万）；补登记来的会话（扫描登记，非 hook）每次 sweep 最多处理 10 个窗口，hook 登记的会话先处理、不受此限；`ab doctor` 的"hook 可能没生效"只统计开始时间晚于第一次 hook 登记（work_meta `first_hook_at`，只写一次；任一宿主——这样 Codex 未信任 hook 时它的会话仍会被报出来）的扫描补登记会话；hook 后来碰到的扫描会话改记 hook，装 hook 前的历史会话单独计为"补登记历史会话"。另加 `ab work --session <id> --redo`：重置该会话的处理进度重跑；已入库的候选按幂等键不重复，近重复走上面 (b)。

- **2026-10-12（切片 3：抽取模型定为 DashScope qwen-plus，撤回 agentrouter）**：用户 2026-10-12 11:42 SGT 决定抽取与代码核验用 DashScope `qwen-plus`，`extract.json` 只写 `{"model":"qwen-plus"}`，沿用 `embedding.json` 的地址和钥匙串 `agentbrain-embedding`。原因：用户在 Mac 上用真实 key 测试 agentrouter.org，返回 401 `unauthorized client detected`，证实它拦截非官方客户端（上一条的风险成立）；`ab work` 不伪装客户端。§13.3 的出境方因此回到 DashScope 一家。`extract.json` 的可选 `baseUrl` 与 `agentbrain-extract` 钥匙串路径保留（代码与测试都在），当前不用。兼容性（DashScope 文档，2026-10-12 查）：OpenAI 兼容模式下 qwen-plus 支持 `tools`（仅 function 类型）与 `response_format: json_object`，后者要求 messages 里出现 "JSON" 字样，抽取与核验的 prompt 都满足；两者不同时传（核验在工具轮只传 tools，结论轮只传 json_object）。

- **2026-10-12（切片 3：抽取模型改用 agentrouter.org）**：用户 2026-10-12 11:37 SGT 决定抽取与代码核验改用 agentrouter.org 的 OpenAI 兼容接口、模型 `deepseek-v4-flash`，不与 embedding 共用 DashScope。这也了结了 flash 还是 plus 的未决项。
  1. `extract.json` 增加可选 `baseUrl`。有它时 key 读钥匙串 service `agentbrain-extract`；没有时沿用 `embedding.json` 的地址与 `agentbrain-embedding`。仍不读环境变量、key 不进文件，钥匙串读取 3 秒超时。配置键 +1（`baseUrl`）。
  2. §13.3：脱敏后的会话窗口、项目背景、代码核验读取的仓库片段改发 agentrouter.org（上游按模型名转发 DeepSeek）；记忆正文与召回 prompt 的向量计算仍发 DashScope。
  3. 兼容风险（2026-10-12 查，未用真实 key 验证）：OpenAI 兼容地址为 `https://agentrouter.org/v1`，鉴权只需 `Authorization: Bearer`；但 agentrouter 对非白名单客户端返回 401 `unauthorized client detected`，社区报告只放行 Claude Code、Codex 等官方客户端。`ab work` 不伪装客户端请求头；若真实 key 也被拦，需要用户换地址或退回 DashScope。

- **2026-10-12（切片 3 自动沉淀：授权、裁决与对已定条文的改动）**：
  1. **授权与顺序**。用户 2026-10-12 11:05 SGT 原话："abwork 直接调 api 的话会不会出现不理解到底什么值得沉淀的问题（不理解业务） 数据无所谓、未确认是一种临时状态，是不是可以定期根据现有项目的真实code（只有真实 code 才是最准确的说明）来决定是否变成正式呢。不用跑一周，直接完整干完。"据此切片 3 一次做完（不分 3a/3b），并**先于切片 2.5**，偏离 §18 原定的 2 → 2.5 → 3。切片 2.5 仍需单独授权。
  2. **§19.3 关闭**：短命 `ab work` + 单实例租约 + 直连 OpenAI 兼容 API（DashScope），见 §19.3 裁决。理由：不抢主会话额度（10-12 已遇 429/520/400），没有 hook 递归，抽取无工具、注入驱动不了操作，三宿主共用一份代码。
  3. **业务理解**：用户担心直连 API 的模型"不理解业务"。处置：每次抽取带项目背景（仓库文档、pm 档案、已确认记忆、近邻），预算为代码常量；prompt 明确"空输出最常见""用户面向以后的指令不能漏"。
  4. **§13.3 出境范围扩大**：脱敏后的会话窗口、项目背景、代码核验读取的仓库片段发往 DashScope。依据是上面原话里的"数据无所谓"。
  5. **§8.1 落实方式**：intake 只存坐标、不存正文，sanitizer 放在送模型前与写 L1 前两处。意图与 §8.1 一致，文字顺序不同。
  6. **§18 触发写法**：`Stop` / `agent_end` 每轮都触发，改为首轮登记 + `SessionEnd` / `session_shutdown` 加速 + 静置 30 分钟兜底 + launchd 每 30 分钟定时。Codex 的 `SessionEnd` 已按 2026-10-12 官方文档核实（关闭、归档、空闲 30 分钟触发，不对子代理，默认 1 秒最多 3 秒）。
  7. **改动 LOCKED 规则：自动转正（§8.3、§8.4、§9.4）**。用户提出"未确认是临时状态，按真实代码决定是否转正"。实现为三条：(a) 坑与事实由 `ab work --sweep` 用只读、限定仓库根的工具核验，结论必须带程序能逐字核对的代码证据，verified → 追加 `verify` 事件并转正，contradicted → 标"与代码不符"、保持未确认，代码无法核验或证据不足 → 只记在 work store；(b) 规则与决定（理由、用户偏好）代码证明不了，保持未确认，直到用户确认，或在至少 2 个不同会话里都有用户原话支持且原话不同（追加 `confirm {by: corroboration}`）；(c) 全局记忆、待确认的纠正、关系未判定的条目不自动转正。这改变了 §8.2 切片 1.5 落地形态里"未确认条目只有用户认可后 `ab confirm` 才转正"的做法，也改变了切片 3 方案初稿的"首发没有任何自动转正路径"。依据是 §8.3 的"独立证据"条款：代码是会话之外的独立来源；两个会话的用户原话是两份 Human directive。§9.4.6 不算独立证据的"同一记忆派生的跨 Session 引用、模型复述、多模型意见"仍然不算：模型置信度从不参与，引文相同的会话按复制历史处理。§9.4 的使用计数（Corroboration Count）仍排期在切片 4 之后，与此处的跨会话印证不是一回事。
  8. **§19.4 L2 合同扩展**：见 §19.4 切片 3 段。`unreconciled` 条目在 search/get 带"关系未判定"标记，不进 brief/recall，只有用户 confirm 或 archive 能解除（§9.4.4）。
  9. **预算常量**（§2.2，均为代码常量）：静置 30 分钟；窗口 ≤48,000 字，前置 4 轮只读上下文；每窗口 ≤5 条候选；每会话每次 ≤6 个窗口；每日 ≤60 次调用、≤250 万 token；抽取超时 90 秒；重试 4 次（1/5/30/120 分钟）；租约 10 分钟；近邻复查门槛 0.80；代码核验每次 ≤3 条、每条 ≤8 次工具调用、单次输出 ≤6,000 字、合计 ≤30,000 字，同一 HEAD 不重复、24 小时内不重复；提议 90 天过期；终态窗口保留 30 天、会话坐标 90 天。
  10. **未做 / 未决**：试探召回（未确认条目进每轮召回，D3）未决、未实现；评测集（§10 方案）未入库、未跑；真实 DashScope 调用未在 box 上跑（没有 key）；三宿主接线未装到用户机器；Pi 的 `getSessionId` / `session_shutdown` 上下文形状按文档写、未实测；未登记目录的会话只登记不抽取。

- **2026-10-12（切片 2 接线实测；只记事实，无新决策）**：用户授权后在用户机器上追加 hook，原有 hook 保留。Claude Code（`~/.claude/settings.json`）和 Codex（`~/.codex/hooks.json`）的 `UserPromptSubmit` 命令都是 `/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab recall --hook`，超时 5 秒。用绝对路径是因为宿主的 PATH 不一定能找到 `ab` 和 Node ≥ 24。Pi 链接了 `~/.pi/agent/extensions/agentbrain-recall.ts`。§15.3 实测：Codex、Pi 的模型收到并引用了召回；Claude Code 的 hook 执行并输出了召回块，但模型那一轮被网关返回 400 拒绝，需要复验。Codex 日常会话要先在 `/hooks` 里信任这条 hook。因为 agentbrain 项目里还没有记忆，实测用的是 ai-data 项目里一条已确认的坑。

- **2026-10-10（切片 2 收尾）**：
  1. **授权**。用户 2026-10-10 18:05 SGT 原话："用 pstack 继续完成 brain"，指让 agent 接着把切片 2 做完。在此之前的切片 2 提交（`b5e73bf`、`1ced6e1`、WIP `5c4e6b9`）没有找到授权原话记录，是否追认由用户确认。切片 2.5 与 3 仍需单独授权。
  2. **§11.4 检索参数定稿**：保留 RRF k=60；`VEC_MIN_SIM` 0.35 → 0.45；每轮召回门槛 0.55。数字与依据见 §11.4。没有做加权融合对比。
  3. **评测语料不在仓库里**。语料在 `~/.agentbrain/eval/{corpus,queries}.json`，取自 pm `repos/*.md` 的真实坑。§15.2 要求测试集纳入版本控制并默认用合成或匿名 fixture，因此这一条目前不满足。是否把匿名版放进仓库由用户决定。
  4. **每轮召回接线**（§7.1、§18）：`ab recall --hook` 读 stdin 的 `{prompt, cwd}`，命中时输出 `hookSpecificOutput.additionalContext`。Claude Code 与 Codex 用 `UserPromptSubmit`，Pi 用 `integrations/pi/agentbrain-recall.ts`（`before_agent_start`）。接线样例与安装说明放在 `integrations/`，不改任何全局配置；三个宿主的实测（§15.3）留给用户机器。Codex 的官方文档写明支持这一输出格式，但本机未实测。
  5. **Memory Card 冲突暴露（§9.2、§11.3）**：切片 2 里唯一能出现的未解决冲突，是未确认的纠正与它要替代的已确认条目并存。投影给被纠正的条目加 `pending_corrections`，`get`、`search`、`recall`、`brief` 都标出"有待确认的纠正"，不再只返回一边。其他关系边（conflict、corroboration）由切片 3 的关系判定产生（§9.4.4），切片 2 不另造写入命令。
  6. **`ab get` 展示替代、冲突与近邻（§15.5 图谱一行）**：替代链与待确认纠正之外，再列至多 3 条向量近邻。近邻只用 index.db 里已存的向量，不发网络请求；范围限于该条所在项目加全局，只列 active 条目；门槛用 `VEC_MIN_SIM`。没有向量时明说近邻不可用。
  7. **§19.4 L2 合同以类型冻结（部分）**：L1 事件体、Proposition、Projection 与投影函数移到 `src/l2.ts`，作为唯一的类型来源。冻结的是已实现的部分：stable identity（不透明 event id）、四种可读种类、两级范围、state 轴、替代与待确认纠正关系。未冻结：§5.3 中尚未实现的 facets（temporal horizon、maturity、confidence、sensitivity 等）、组合视图物化、projector version 与 schema migration。这几项设计里没有具体形态，留作开放问题。

- **2026-10-10 v2.6（检索与子代理汇报；只授权改文档）**：
  1. **§11.4 检索锁定为 FTS5 trigram + 稠密向量混合**。向量以 BLOB 存 index.db（L3）；进程内暴力余弦；约一万条以内毫秒级，超过再换 sqlite-vec。融合方式与召回门槛仍为 CANDIDATE，由切片 2 测试集对比。分词 / n-gram、rerank 等保持候选。
  2. **embedding（§12.2，§14.1 / §14.4 引用）**：OpenAI 兼容接口，用户选定阿里云 DashScope `text-embedding-v4`。地址与模型名在 `~/.agentbrain/embedding.json`（两个配置键，计入 §2.2）。API key 只存 macOS 钥匙串（service `agentbrain-embedding`），不进文件、不进环境变量。理由：Codex 的 `shell_environment_policy inherit = "core"` 会过滤自定义环境变量（2026-10-10 实测）。index.db 的 meta 记录模型名，模型变化即索引失效、全部重算。不可用时降为纯 FTS，`ab status` 报告原因，不阻塞 remember/brief。
  3. **§13.3**：记忆正文与切片 2 每轮召回的用户 prompt 会发到 DashScope 计算向量。用户 2026-10-10 明确选择且已知情。sensitivity 高的条目是否跳过向量化留作 CANDIDATE。
  4. **§6.3 子代理汇报**：派活说明要求汇报末尾单列「新坑 / 决定」并附证据；子代理不写记忆；主会话用未确认的 `ab remember` 记下，来源指向该子代理。`--from-worker` 形态 CANDIDATE，切片 2。切片 3 抽取读主会话 transcript，不读子代理 transcript。
  5. **§15.5** 增补 Pensieve 知识图谱一行：相关 → 向量近邻；基于 → Source Pointer 与 why；结论演变 → supersede / conflict / corroboration（§9.4.4）。不建独立图谱视图。切片 2 / 3。
  6. **§18**：切片 2 加入混合检索，并用 pm `repos/*.md` 的真实坑造测试集，对比纯 FTS 与混合的命中率。顺序为 2 → 2.5 → 3。「之后」去掉检索 prototype（已并入切片 2）。使用成熟度计数继续后置。

- **2026-10-10（切片 1.5 实现）**：
  1. **切片 1.5 实现完成**。pi 实现主体，Codex 只读 review 提出 10 条（高 5 中 5），修 8 条。未修两条：按 ID 跨项目 get/archive（有意，pm 需管理全部项目）；status 的接线语义检查和 Pensieve 共存检查（价值低）。
  2. **修复要点**：Purge 后 L3 立即同步；范围屏障移入同一事务并拒绝该 session 的迟到写入；index 写入在 BEGIN IMMEDIATE 内重读水位、水位只进不退，index 水位高于 store 时视为 store 被换、旧索引作废；宿主检测失败不再当作 ephemeral（显式 remember 一律非 ephemeral）；Codex transcript 只过滤已知宿主注入标记；anchor 不存在返回来源不可用；brief 多行条目不截断、超预算整条跳过。
  3. **实测事实**：Claude Desktop 进程 comm 为含空格的完整路径，`ps` 解析须把 comm/args 放最后一列整行取；Codex 的 `shell_environment_policy inherit = "core"` 会过滤 `AB_HOME` 等自定义环境变量；E2E 中 Codex 读到全局规则但未遵守、Pi 遵守。brief 送达不等于遵守。
  4. **新增 `--confirmed` 与 `ab confirm`**（§8.2）。

- **2026-10-09 v2.5（宿主无关基线；只授权改文档）**：经过一轮讨论与实测后定稿。
  1. **§2.1 撤销 Pi-only**。用户提出 agentbrain 不应指定 Pi、Claude Code 或 Codex，三者都能作为主体接入。理由：Pi-only 唯一的依据是"在 Pi 上取代 abrain"，而 abrain 已卸载；实测 agentbrain 的 Pi 扩展也已停用（`~/.pi/agent/extensions-disabled-agentbrain`），store 为 0 条事件，切换没有数据要迁；用户日常在三个宿主间切换，也会直接在项目仓库里开会话。
  2. **先做好记忆本身，首个替代对象是 Pensieve**。用户原话："第一批要完成的应该是 agentbrain 自己本身那个记忆的功能……如果完善以后甚至可以反过来不代替 pm，只代替 pm 里面现有的记忆插件 pensieve 了"。长期方向是取代 pm，非记忆职责记入 §20。§15.5 新增 Pensieve 对照清单。
  3. **全局与项目两级范围提为切片 1.5 的核心**（§5.3）。用户指出 abrain 本就区分全局记忆、规则和项目记忆；参考文档 §1.1 记载 abrain 正是为解决 Pensieve 只绑单项目而生。修订过程中曾把全局记忆排到后续切片，已更正。规则与范围正交，不单独存储。
  4. **入口与接线（§7.1）**：唯一入口是 `ab` 命令行（用户选定 SQLite 为权威、`ab` 读写）。接线不靠安装：直接打开的会话由三个全局规则文件各一句指令覆盖；被派活的子代理由主会话的派活说明覆盖（`ab brief --worker`）；pm 补 `AGENTS.md`。hook/skill 降为后备，Pi 扩展删除。MCP 降为 CANDIDATE。依据均为 2026-10-09 实测：Codex 在 pm 中只加载全局 AGENTS.md、不加载 pm 的 CLAUDE.md；Pi 两者都加载；pi-subagents 子代理默认不加载全局规则文件。
  5. **项目清单 = pm 的 `repos/*.md`（§6.1）**，删除 `/ab bind`。worktree 归回主仓库；未登记目录只给全局记忆。
  6. **会话身份实测关闭（§7.1、§19.5）**：`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID` / `PI_SESSION_ID` 在 shell 中可得，且与各自 transcript 文件名或首行 id 一致。嵌套启动会继承上层变量（实测从 Claude Code 启动的 Pi 同时看到两家的 id），因此按最近的宿主父进程判定 host。
  7. **§7.3 补多进程合同**。多个会话的短命 `ab` 进程会同时打开 store：写入等待有界、超时显式失败；投影与 L3 必须按 L1 水位失效。切片 1 的 `Store` 只在本进程写入时失效缓存，且未设写入等待（`openDb` 只设了 WAL 与外键），两处在切片 1.5 修正。实测：同一 store 开两个 `Store` 实例，A 写入一条坑后 B 的 `project()` 仍为 0 条，而 B 的 `search` 已能命中（index.db 共享），即"搜得到、`memory_get` 取不到"。
  8. **§19.3 重开**。"进程内后台任务"只对常驻 Pi 成立；其余宿主没有常驻进程。消费者形态与抽取算力在切片 3 前裁决，`claude -p` / `codex exec` 回到候选（§17 同步）。
  9. **§18 插入切片 1.5（宿主无关化 + 两级范围）与 2.5（替代 Pensieve + 合并四处全局规则）**，不重新编号以保持正文引用。
  10. **泛化 Pi 专属表述**：Session、Source Pointer（host + session id + transcript + 定位点）、§9.5 ephemeral 信号、§11 交付与渲染、§13 信任边界、§14.3 doctor、§15.3 改为三宿主 E2E 并加跨宿主/全局/子代理/嵌套四条用例、§16、§20。§6.3 至 §6.5 的 Pi 实测保留为 Pi 事实。CONTEXT.md、README、CLAUDE.md、AGENTS.md 同步。
  11. **不变**：L1/L2/L3、物理布局（§12.2）、clean-room、复杂度预算数值、执行面边界（§6.4）、所有 LOCKED 记忆语义。

- **2026-09-14 v2.4（真实场景基线 + 按场景切片；授权切片 1）**：
  1. **§15.5 判据一的输入已由用户给出**（2026-09-12）：四个真实场景（坑不重踩 / 决策讨论过程还原 / 快速定位 / 子代理配合）与文档式记忆三痛点（不及时更新 / token 浪费 / 丢过程）。用户自述 abrain 实际用得不多。
  2. **实测更正两项宿主事实**：abrain 已从本机 Pi 卸载；现役子代理宿主是 pi-subagents（进程内 inMemory 子会话或 `--no-extensions --no-session` 后台进程）。§2.1/§6.4 补记。
  3. **§7.4/§19.12 关闭**：切换 = package 安装/卸载，不做灰度；回退 = 重装 pi-astack，store 保留。
  4. **§13.3 来源改为指针**：session 文件 + leaf entry id + 一句摘要；展开按需读 transcript。理由：讨论过程本就完整在 Pi 会话文件里，缺的只是一根线；这同时把 agentbrain 自存正文降到最少。
  5. **§12.2/§19.1/§19.2/§19.3/§19.8 以决定关闭物理形态**：`~/.agentbrain/store.db`（L1 + work store）+ `index.db`（FTS5 trigram）；不透明 event_id + 自增定序 + 独立 body hash；L2 为纯函数；进程内 worker。理由：单用户单机、无多设备、git 非 authority，abrain 的一事件一文件/JCS/OFD 锁/daemon 全是为跨设备收敛服务的场景复杂度。
  6. **§18 重排为四个切片**，取代 T0/D0/P0-P2/M1-M6；P1 不再 throwaway。**§19.13 开工规则改为按切片授权**。
  7. **推后但不删**：§9.4 Corroboration 排序效果、§9.4.5 第 2/3 层、§6.5 Delegation Grant、§10.2.3 传递闭包，均排在切片 4 之后。理由：四个场景无一依赖。
  8. **§5.4 新增"坑"可读标签**（带 trigger 的 normative，归 Maxim 视图）；**§11.1 坑必须主动投递**，Brief 预算为代码常量。
  9. **两处内部矛盾修正**：§9.1 从 accepted 语义状态移除 `expired`；§8.3 Unreconciled/Ephemeral 命中即带标记进卡片，不设"确实依赖"判断步骤。
  10. **切片 1 授权实施**（用户原话"按你的来"），代码位于本仓 `extension/`，通过 `~/.pi/agent/extensions/agentbrain` 符号链接加载。

- **2026-09-08 v2.3（开工评审后的语义裁决）**：本轮授权修订设计，未授权生产实现。
  1. **修正 §9.4 的使用计数权限**：使用不是独立证据，用户没有反对也不等于用户背书。计数只改变使用成熟度和合格候选内的排序，不改变 proposition modality、证据 authority、admission 或高影响发布资格。高门槛只触发发布资格检查，不能产生资格；§8.5 发布仍须显式 directive 或满足已冻结的独立证据策略。理由：同一错误记忆可以跨 Session 被反复采用，按 Session 去重不能防止自回声。
  2. **冻结 §9.4.4 关系判定顺序**：自动三层判断链全部发生在 Unreconciled 之前；确定无旧结论需要替代是合法的新命题。三层仍不确定才进入 Unreconciled，之后只有 Human 可解除；主 Agent 不因已读后台结果而获得额外 authority。理由：拆开“尚未判完”和“已判定无法自动解决”，消除绕过人工解除门的路径。
  3. **冻结 §10.2.3 Purge 依赖失效语义**：直接范围及其传递依赖产物全部先失效；无关内容保持有效。正文清除包括派生内容和待发布结果；独立剩余证据只能重新生成并重新准入，不能保留旧结论继续服务。理由：仅删除源事件仍可能从派生物或恢复队列复活正文。
  4. **新增 §6.5 委派候选合同**：kernel 持有能力授权，adapter 绑定可信执行身份，dispatch 负责生命周期传递；同名工具不能承担身份或授权。该方案供审阅，仍受 #6/#11 接缝验证约束，不标为 LOCKED。
  5. **同步清理**：预算默认代码常量；Gate 表移除子代理执行拓扑；#7 按人工挑选清单收窄；自治遗忘范围已裁决，票据状态同步不等于其他 gate 完成。完整生产开工门保持 §19.13，不因本轮设计修订自动解除。

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

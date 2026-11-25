# agentbrain 总体设计

- 状态：**v2.6 宿主无关基线**
- 最新修订：2026-10-30（§11.10 场景标签实现并合并；合并 PR #70、#71；章节改号：提示词版本 8.8→8.10、场景分组目录 11.8→11.11）
- 实现状态：**切片 1 已实现（仅 Pi，`src/`）；切片 1.5（宿主无关化，2026-10-10 已实现）；切片 2 代码完成（2026-10-10），三宿主接线 2026-10-12 完成，Claude Code 模型侧实测待复验；切片 3（自动沉淀）2026-10-12 代码完成，先于 2.5，尚未接入用户机器、未跑真实模型（§21）**
- 设计母体：abrain 的 event-first、统一命题、结构性沉淀、确定性投影、分层读取与自治纠错纪律
- 宿主：Pi、Claude Code、Codex、opencode 平等接入，任一都可作为主体会话（§7）。opencode 接线合同见 §7.5。
- **产品前提：宿主无关的个人 Agent 记忆；先把记忆本身做好，首个替代对象是 Pensieve（§2.1）；动机首先是所有权，其次是复杂度（§2.2 定量）**
- 决策地图：[绘制以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
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
- **Context Brief**：session-start 的小型稳定上下文。

这些视图是否全部持久物化，由 L2 合同决定；它们均不得成为新的 canonical writer。Scenario View 的候选物理形态见 §11.11。它只在 L3 存标题与成员 id，不生成新的记忆结论。

2026-10-15 用户决定不由 agentbrain 提炼可复用做法（Skill / SOP），因此删除 Procedure View，边界见 §20。冲突仍待裁决：§4 的 `workflows` 行仍是 LOCKED，写着保存程序性经验。本次不改该行。§4.1、§5.3、§5.4、§15.5 和 §18 还引用 Procedure 或 pipelines，对应内容须随该冲突一起裁决，不能把这些旧引用当成实现授权。记住用户的规则与决定，不等于生成可执行做法。

### 5.6 容易混的词

- `ab review` 是到期复审（未确认、过了预计有效期、期间没被注入过的条目）；`ab curate` 是模型审稿，`~/.agentbrain/review.json` 是它的配置；`--scene review` 是规则的评审场景标签，与这两件事无关。
- "未确认"是可信程度（§8.8）；"待确认的纠正"是一条还没生效的纠正，`ab get` 列在目标条目下；Pi 状态栏的"待确认 N"是到期待复审的条数（`ab status --line`），不是未确认条目的总数。
- `note` 在界面上显示为"事实"（`KIND_LABEL`）。
- L1 / L2 / L3 是存储权威层（§5.1）；"关系判定第 1 层、第 2 层"是判断条目关系的两步（§9.4.5）：第 1 层是抽取模型顺带判的，第 2 层是之后单独调模型（`src/relate.ts`），两者不是一回事。

---

## 6. 身份、作用域、Loadout 与委派

### 6.1 最小身份模型

v2 区分：

- **Human**：本地记忆服务的人；Human 范围的记忆即 v2.5 的"全局记忆"（§5.3）；
- **Agent Definition**：稳定角色，如主开发、审查、研究；
- **Agent Execution**：某次具体运行；
- **Project**：稳定工程/知识工作边界；
- **Repository**：Project 关联的代码库身份，不必一一对应；
- **Session**：一次宿主会话（Pi、Claude Code、Codex 或 opencode）；
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

上述父 execution 与子 execution 的记录关系就是 **Delegation Lineage（委派血缘）**。

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

**Host Adapter** 是 `ab` 内部按宿主分的那一层：判定调用者是哪个宿主（取最近的宿主父进程，因为嵌套宿主会互相继承环境变量）、读该宿主的 session id、按该宿主的格式读 transcript 和展开来源（§7.1）。宿主是五个：Pi、Claude Code、Codex、opencode、Antigravity CLI（agy，§7.7），功能支持范围因功能而异，不按"四个宿主都支持"一刀切。各宿主怎么触发 `ab`：Claude Code 与 Codex 配 hook，Pi 装扩展（`integrations/pi/agentbrain-recall.ts`），opencode 和 agy 装插件（§7.5、§7.7），都只调用 `ab`，不直接读写记忆库；开工指令仍由全局规则文件那一句给出（§7.1），hook 与扩展只负责每轮召回、会话登记、话题边界和状态栏。宿主私有类型只留在这一层。

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

### 7.5 opencode 接线（2026-10-20 用户授权实现）

opencode 是第四个宿主。插件只调用 `ab`，不读 agentbrain 的库。插件使用 v2 的 `setup(ctx)` 和 `ctx.session.hook("context")`。它对最新用户文本调用 `ab recall --hook`，将返回的上下文追加为 `{type:"text",text}` 系统上下文。同一条用户消息的工具循环复用本轮结果，新用户消息重新召回。没有命中、调用失败、超时都不修改上下文。插件同时调用 `ab capture --hook --host opencode` 登记会话。

来源继续使用现有 `SourcePointer`，但 `transcript` 保存 `opencode://session/<id>`，不是文件路径。新增 `src/opencode.ts` 集中处理引用校验、SQLite 会话元数据和消息读取。它只读打开 `~/.local/share/opencode/opencode.db`，拒绝任意数据库路径、伪造引用和不存在的 session。capture 使用数据库中的 directory 判定项目，不相信请求中的 cwd。数据库使用 `session_v2`、`session_message`。用户定位点是 message.id，助手定位点加 content 下标。只读取该 session 的 user、assistant 文本和压缩后的工具错误，不读 reasoning、synthetic 或压缩摘要。

SQLite 读取直接生成现有轮次，不导出 JSONL。导出会多存一份对话正文，也会增加缓存一致性和删除责任。opencode 的 `parent_id` 非空表示子会话，capture 标 ephemeral，sweep 不补登记，work 不抽取。插件从宿主 session API 判断子会话，召回带 worker 标记，子会话不会拿主会话偏好。

sweep 查询近 7 天 time_updated，只有 directory 属于已登记项目的主会话才补登记。静置时钟使用该会话的 time_updated，不使用整个数据库的 mtime。读取和来源展开再次验证引用。数据库无法读取时，hook 静默放行，work 报 source_unavailable。

opencode 没有和 Pi session_shutdown 完全相同的公开事件。插件在 session 归档、宿主实例销毁时登记 SessionEnd，在压缩前登记 PreCompact。硬关进程仍靠既有 `ab work --sweep` 的静置兜底，不新增定时器、不启动 launchd。话题模式对 opencode 使用现有 API 抽取器，不借用其他宿主的 CLI 额度，本次不扩展审稿 CLI 后端。

插件安装为 `~/.config/opencode/plugins/agentbrain-v2.js` 的符号链接。安装前保存插件目录清单和已有配置备份，不修改其他插件或 opencode 配置。默认命令是本机绝对 Node 与 ab 路径，缺失才使用 PATH。插件在 `ctx.shell.hook("create.before")` 有 sessionID 时传入当前 opencode 会话 id，使手动 `ab remember` 的来源指向 opencode，而非嵌套启动它的宿主。

### 7.6 Codex 压缩会话（已授权，2026-11-03 用户授权实现）

**问题。** Codex 0.162.1 会把 7 天没动的会话文件 `rollout-…-<id>.jsonl` 压成同目录的 `rollout-…-<id>.jsonl.zst`，原文件消失；恢复（resume）时解压回 `.jsonl` 并删掉 `.zst`（`rust-v0.162.1` 的 `compression.rs`、`compression/path_metadata.rs`）。agentbrain 只认 `.jsonl`，已记录的路径随之失效。截至 2026-11-03 11:00 本机只读实测：

| 项目 | 数字 |
|---|---|
| `~/.codex` 文件 | `sessions` 872 个 `.jsonl.zst`、72 个 `.jsonl`；`archived_sessions` 69 个全是 `.jsonl.zst`；同名并存 0 |
| 压缩文件解压 | 941 个全部成功，首行都是 `session_meta`；解压后最大 66 MB，单个最慢约 40 ms |
| 已登记 Codex 会话（321 个） | 153 个只剩 `.zst`，48 个仍是 `.jsonl`，26 个两种都没有，94 个没记路径 |
| 只剩 `.zst` 的 153 个 | 46 个已处理过；48 个 ephemeral；59 个未处理且不是 ephemeral |
| 这 59 个未处理的 | 37 个没有项目，不会抽取；**可抽取 22 个、约 20 个窗口、33.6 万字，全是 hook 登记** |
| 已处理的 46 个 | 只剩约 2.6 万字新内容；1 个定位点对不上，继续报 `source_unavailable` |
| L1 里 Codex 的 Source Pointer | 306 条，227 条指向只剩 `.zst` 的文件，`ab get --expand` 展开不了；解压后 227 条全部成功，定位点不受压缩影响 |

Claude Code 和 Pi 目录里没有 `.zst`。Codex 源码压缩时保留 mtime，但本机 941 个里有 581 个 mtime 和最后写入时间差一天以上，所以方案不依赖 mtime 是否变化。

**决定。**

1. **不迁移数据。** L1 只追加，Source Pointer 写的是当时的路径，继续保持原样；`capture_sessions.transcript` 也不改写，否则下一次压缩或恢复又会失效。所有读取在读时解析，不增加字段、配置键和数据修复脚本。
2. **文件层只有一个入口。** 新增 `src/transcript-file.ts`，只做文件层的事，不解析内容：
   - `resolveTranscript(path)`：先试 `x.jsonl`，再试 `x.jsonl.zst`，和 Codex 自己的顺序一致（`path_metadata.rs`）；都没有返回 null。
   - `readTranscript(path, maxBytes?)`：不给 `maxBytes` 就读全文；给了就只读开头。
     - 全文：`.zst` 用 `node:zlib` 的 `zstdDecompressSync` 解压，不加依赖。解压上限写死 256 MB（实测最大的约 4 倍），超过抛错。
     - **完整性必须单独查。** Node v25.9 的 `zstdDecompressSync` 对截断帧不报错，只返回已解出的部分：实测去掉最后 1 字节，9362088 字节只解出 9306112 字节且无异常。解压前按 zstd 格式走一遍帧头和块头（约 15 行），确认最后一块存在且文件正好结束，否则抛错，由调用方记 `source_unavailable`。不用帧头里的原始长度，因为本机 941 个里有 17 个没有这个字段。实测 941 个全部通过，每个文件切掉 1、3、100 字节和一半共 3764 次全部查出。
     - 开头：只读压缩文件前 256 KB，用同一个函数解压，再按 `maxBytes` 截取。这里故意利用“截断返回部分数据”，且不查完整性；开头只用来取元数据。保持同步，调用方不用改成异步。实测 941 个的前 16 KB 和全文解压完全一致，平均 0.86 ms。这个行为由单测盯住，Node 改了会失败。
   - `allowedTranscript(host, path, sessionId?)`：从 `work.ts` 移到这里，语义见第 4 条。
3. **调用点全部改走这个入口**，别处不再判断扩展名：

   | 位置 | 现在 | 改成 |
   |---|---|---|
   | `source.ts` 的 `linesOf` | `readFileSync` | `readTranscript`（`cleanTranscript`、`modelOf`、来源展开都经过它） |
   | `source.ts` 的 `expandSource`、`latestAnchor` | `existsSync` | `allowedTranscript`，见第 4 条 |
   | `work.ts` 的 `headLines`、`transcript.ts` 的 `isWorkerTranscript`、`isPiWorkerFile` | `openSync` 读开头 | `readTranscript(path, n)` |
   | `work.ts` 的 `sessionStart`、`transcriptMtime`、`scan` 的 mtime | `statSync` | `statSync(resolveTranscript(path))`；`sourceClock` 的缓存键用解析后的路径 |
   | `host.ts` 的 `locateTranscript` | Codex 只找 `sessions` 下的 `.jsonl` | 先 `sessions` 后 `archived_sessions`；每个目录先精确找 `.jsonl`，再找 `.jsonl.zst`，不靠目录遍历顺序 |
   | `work.ts` 的 `walk`、`scan` 的 id 解析、`cli.ts` 的 `codexOrClaudeId` | 只认 `.jsonl` | Codex 也认 `.jsonl.zst` |

   已逐个查过 `curate`、`audit`、`view`、`telemetry`、`topic`、`status`、`intake.reclassifyScanned`，都经过上面这些函数。`citecheck`、`pensieve` 读的是代码和文档，不碰 transcript。
4. **准入每次读都查，不只查登记时。** 现在 `processSession` 读库里的路径时只对 opencode 重查（`work.ts`），实测：登记后把文件换成指向 HOME 外的 `.jsonl.zst` 符号链接，文件正文会被送进抽取模型，进度还会推进。改成：
   - `allowedTranscript` 先解析实际文件，再做 `realpath` 和根目录检查，返回实际路径。只有 Codex 放行 `.jsonl.zst`，其他宿主照旧拒绝。两种都不存在时维持现状（Claude 的 transcript 可能晚于第一次 hook 才落盘）。
   - `processSession` 读之前对所有宿主调一次，替换现在的 opencode 特判；不过关记 `source_unavailable`。
   - `expandSource`、`latestAnchor` 同样先过一次，L1 里的路径也不算可信。
5. **sweep 的范围不变。** `scan` 不扫 `archived_sessions`，也仍只看 mtime 近 7 天的文件。已登记的会话直接跳过；未登记的走既有的 backfill 路径和每次 sweep 10 个窗口的限制。
6. **历史积压自然消化，不写一次性任务。** 不带 `--session` 的 `ab work`（launchd 每 30 分钟的 sweep）会遍历全部会话，包括带 `source_unavailable` 的，成功后错误码自动清掉。所以修好后下一次 sweep 就会补抽上面那 22 个会话。它们是 hook 登记的，不受 10 个窗口的限制，一次跑完。

**明确不做。** 不解压到磁盘缓存（多一份对话正文，还要管一致性和删除，理由同 §7.5）；不改 L1 里的路径；不处理 26 个两种都没有的会话（文件确实没了）；不改 Codex 的压缩行为。不把 `statusLine` 改成不读文件：那会改变“到期”的算法，开头只读 256 KB 后也没必要。

**补抽。** 这批补抽会花约 20 个窗口的抽取额度，用户 2026-11-03 接受。

**验收。**

- 单测先红后绿，全部用 `zstdCompressSync` 生成的真压缩文件和临时 HOME：`locateTranscript` 找到 `sessions` 和 `archived_sessions` 下的压缩文件，并存时取未压缩那份；`allowedTranscript` 放行 Codex 压缩文件、拒绝 Claude 和 Pi 的压缩文件、拒绝指向根目录外的符号链接；超过解压上限、坏帧、截断帧都按读取失败处理且进度不推进；开头读取在大文件上和全文开头一致；hook 遇到坏文件不抛错。
- 真实路径：隔离库里 `ab capture codex:<id>` 不带 `--transcript` 成功；假模型跑 `ab work --session` 能产出条目；`ab get --expand` 展开压缩文件里的讨论；登记时是 `.jsonl`、之后被压缩、再恢复成 `.jsonl` 的会话不丢进度、不重复抽；登记后换成目录外符号链接的会话不会把内容送给模型。
- 不带 `--session` 的 `ab work` 能恢复带 `source_unavailable` 的压缩会话，错误码清掉。
- 正式库副本：`ab work --dry-run` 的窗口数和上面的数字同一量级；`ab get --expand` 抽 5 条真实 Codex 记忆能展开；正式库不变。
- `node --test`、类型检查、`verify.sh run` 通过，功能地图加上这条。

### 7.7 Antigravity CLI（agy）接线（已授权，2026-11-18 用户授权实现）

**结论。** agy 是第五个宿主（`Host` 加 `"agy"`）。注入已经由插件做完（`integrations/agy/`，c736bdf）；本节补上登记、抽取、来源展开和 `ab doctor` 一行，做法和 Pi 一样：读 agy 自己落盘的 JSONL，不导出、不加表、不加配置键。

**现场事实（agy 1.5.10 / 1.5.11，本机 2026-11-18 只读实测）。**

| 项目 | 事实 |
|---|---|
| 会话 id | `conversationId`。钩子 stdin 给；工具 shell 里是 `ANTIGRAVITY_CONVERSATION_ID`；宿主进程 `comm` 是 `agy` |
| transcript | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/` 下两份：`transcript.jsonl` 把超过约 1800 字的字段截断（含用户输入和回答，记在 `truncated_fields`）；`transcript_full.jsonl` 不截断（9 个会话 0 处截断）。同目录 `chunks/` 是分片副本，`brain/<id>/scratch/` 是模型写的草稿 |
| 每行一步 | `step_index`、`type`、`source`、`created_at`、`content`。`USER_INPUT`：用户原话在 `<USER_REQUEST>…</USER_REQUEST>` 里，后面跟 `<ADDITIONAL_METADATA>`、`<USER_SETTINGS_CHANGE>` 等宿主块。`PLANNER_RESPONSE`：`content` 是回答，`tool_calls` 是 `[{name,args}]`（无 call id），`thinking`、`model` 另列。`GENERIC`：工具输出，按顺序跟在调用后面，可带 `error`。`SYSTEM_MESSAGE`：钩子注入（`<agentbrain-brief>`、`<agentbrain-prefs>`）和宿主通知 |
| cwd | transcript 里没有。钩子 stdin 给 `cwd`；`~/.gemini/antigravity-cli/conversation_summaries.db` 的 `workspace_uris` 有，`parent_conversation_id` 标子会话 |
| 钩子事件 | `SessionStart`、`PreInvocation`（每次调模型前）、`Stop`（每轮结束，`continuationActive` 为真表示还会接着跑）、工具前后。没有会话结束事件 |
| 钩子给的路径 | `transcriptPath` 实测就是 `transcript_full.jsonl`（1.5.11，会话 `d98cb742-…`）；准入仍把截断版换成完整版，防宿主改动 |

**决定。**

1. **canonical transcript 是 `transcript_full.jsonl`。** 截断版会把长原话和长回答切掉，不能当证据。
2. **准入（`allowedTranscript("agy", …)`）只认一种形状。** 真实路径必须正好是 `<brain 根>/<id>/.system_generated/logs/transcript_full.jsonl`；给的是同目录 `transcript.jsonl` 时换成 `transcript_full.jsonl` 再查。带 `sessionId` 时 `<id>` 必须相同。`chunks/`、`scratch/` 和其他路径一律拒绝。文件还没写出来时按字面路径查（同 Claude）。
3. **读法（`cleanTranscript("agy")`，新函数 `readAgy`）。** 定位点是 `step_index`。
   - `USER_INPUT` → user 轮，只取 `<USER_REQUEST>` 内文；没有这个标签时取全文去掉宿主块。
   - `PLANNER_RESPONSE` → assistant 轮：`content` 加每个工具调用一行（`CommandLine` 当命令、`Path` 当路径，`ab` 命令照旧省略）。没有工具调用且有 `content` 的标 `final`。`thinking` 不读。
   - `GENERIC` → tool 轮，按先进先出配上前面的调用；配到 `ab` 调用的输出丢掉。
   - `SYSTEM_MESSAGE` → 整条丢掉，计入 `stripped`。
   - worker：首个用户轮带 `ab brief --worker`，或注入里有 `<agentbrain project="…" worker>`（插件在 `PM_JOB_ID` 下跑 `brief --worker`，pm 队列的 agy 任务提示里没有这个标记）。
4. **插件加两处登记，都转成现有的 snake_case 钩子输入，`ab capture --hook` 不改格式。**
   - `PreInvocation` 且是新用户消息（已有的去重分支）：`hook_event_name: "UserPromptSubmit"`，只登记。
   - `Stop` 且 `continuationActive !== true`：`hook_event_name: "SessionEnd"`，登记为结束并拉起 `ab work --session agy:<id>`。agy 没有会话结束事件，每轮结束就算一次结束；用户接着发消息时 `last_touch` 晚于 `ended_at`，按现有规则不再算结束（`work.ts` 的 `settled`）。代价：交互会话每轮可能多一次抽取调用（无信号的窗口不调模型）。
5. **其余接点。**

   | 位置 | 改动 |
   |---|---|
   | `host.ts` | `pickHost` 认 `agy`，取 `ANTIGRAVITY_CONVERSATION_ID`；`locateTranscript` 直接拼路径 |
   | `cli.ts` 的 capture / `telemetryCtx` | 从路径取 id（`brain/<id>/…`） |
   | `work.ts` 的 `scan` | 列 `brain/*/…/transcript_full.jsonl`（不用 `walk`，否则会扫进 `chunks/`）；cwd 和子会话从 `conversation_summaries.db` 只读取，读不了就跳过 agy，不影响其他宿主；`sessionStart` 认 `created_at` |
   | `source.ts` | `expandSource`、`latestAnchor` 走 `cleanTranscript("agy")` |
   | `telemetry.ts` 的 `modelOf` | 取 `PLANNER_RESPONSE.model` |
   | `status.ts`（doctor） | 加一行 `agy: 插件在位 / 未安装`，在位时再报 brain 目录可读与否 |

**明确不做。** 不给 agy 加话题模式的命令行子模型：话题模式打开时 agy 会话退回普通抽取（同 opencode，`work.ts` 的分流处）；不读 `chunks/`、截断版和 `conversation_summaries.db` 里的对话正文；钩子路径不查子会话（`parent_conversation_id` 只在 sweep 补登记时用，钩子登记的子会话按普通会话抽）；不改 `ab setup` 的宿主安装步骤（插件仍手动 `agy plugin install`）。

**验收。**

- 单测先红后绿（临时 HOME）：准入放行 `transcript_full.jsonl`、把 `transcript.jsonl` 换成它，拒绝 `chunks/`、`scratch/`、id 不符、根目录外符号链接；`readAgy` 得到用户轮和助手轮，`SYSTEM_MESSAGE` 和 `<USER_REQUEST>` 外的宿主块不进轮次，`ab` 调用和它的输出省略，worker 两种标记都认；`capture --hook --host agy` 写进 `capture_sessions`，`SessionEnd` 拉起 `work --session`；`scan` 补登记 agy 会话、不扫 `chunks/`；插件 `Stop`（`continuationActive` 假）发 `SessionEnd`，为真时不发。
- 真实宿主：装好插件后在已登记仓库跑一次 `agy`，store 里有 `host=agy` 的登记，`ab work --session agy:<id>` 窗口处理成功（隔离库 + 假模型或正式抽取模型二选一，写进验证证据）。
- `npm test`、`tsc`、`verify.sh run` 通过，功能地图加 agy。

### 7.8 Antigravity 三处对话接入记忆（CANDIDATE，2026-11-23，待用户授权实现）

首版基线是方案 A：三处 sweep、定位、去噪和分处诊断，共用 `host=agy`、现有 JSONL 读取器和 `ab`。不增加宿主类型、配置键、表、列或事件种类。CLI、IDE 的既有钩子继续修接线；T3 不以插件为前提。方案 B 只是在隔离 ACP 真测通过后共享插件的可选项，不是实现首版的条件。本节仍是 CANDIDATE，不授权代码或正式宿主改动。

#### 7.8.1 现场依据

数量保留上一轮 2026-11-23 18:23 的快照。六份摘要库及存在的 WAL、SHM、正式 store.db 当时先复制到 `/tmp/agy-wiring-readonly.irMq8a/` 再查询。本轮日志先复制到 `/tmp/agy-wiring-design-fix.ROCwp5/`，只在副本上核实。安装命令无效的结论采用主会话与审查的隔离实测，本轮不重装插件；ACP 加载能力仍未证实。

下表的日志尾均为 `.system_generated/logs/transcript_full.jsonl`。完整路径是 `<应用根>/brain/<会话 id>/<日志尾>`。

| 存储 | 应用根与摘要库 | 摘要行 / 完整日志 / 已登记 |
|---|---|---|
| CLI | `~/.gemini/antigravity-cli`，根下 `conversation_summaries.db` | 27 / 17 / 17 |
| IDE | `~/.gemini/antigravity`，根下 `conversation_summaries.db` | 50 / 15 / 0；brain 目录有 34 项，目录数不等于可读对话数 |
| T3 | `~/.t3/userdata/providers/antigravity/<实例>/antigravity-acp`，各根下 `conversation_summaries.db` | 实例 `120bf1cf…` 为 22 / 2 / 0，`42082fb6…` 为 24 / 4 / 0，`60c7502f…` 为 21 / 3 / 0，`ac0a3dfd…` 为 22 / 2 / 0 |

六份摘要库的 21 列同构。CLI 的 27 个摘要 id 全部也在 IDE 摘要库中，T3 实例之间各有 17 个共同摘要 id。实际 43 份完整版日志的 id 互不重复。因此不能把摘要行数当作本处对话数，也不能先按摘要 id 去重再找日志。副本的 `capture_sessions` 只有 CLI 的 17 行 agy 登记；库版本为 1，没有 `worker` 列。

| 核实对象 | 结果与位置 |
|---|---|
| T3 环境和进程 | `60c7502f…` 的会话 `d92d7fb3-82f5-4c67-9fcd-cee60a2f684b` 日志第 132 行工具输出给出 `GEMINI_HOME=<实例根>`、`ANTIGRAVITY_APP_DATA_DIR=<实例根>/antigravity-acp`、`ANTIGRAVITY_CONVERSATION_ID`、`ANTIGRAVITY_AGENT=1`、`ANTIGRAVITY_LS_VERSION=cli-1.5.13`、`AGY_ACP_FORCE_FILE_STORAGE=1`。`ps` 核实 PID 1823、28894 的 comm 都是 `~/.local/bin/agy`，各自的 `GEMINI_HOME` 指向不同 T3 实例 |
| 当前发现和定位 | `src/agy.ts:15-25,41-65` 只认 CLI；`src/work.ts:221-244` 再拼 CLI 路径；`src/host.ts:35-45,92-95` 能认 T3 的 agy 进程，但不能找到上述 T3 会话 |
| 当前路径准入 | `src/transcript-file.ts:165-185` 只放行 CLI 的固定日志路径，IDE、T3 路径都会被拒绝 |
| 插件 | `~/.gemini/config/plugins/agentbrain/hooks.json` 在位；四个 T3 实例均无 `config/plugins/`，但其 `config/skills` 已由 T3 软链到 `~/.gemini/config/skills`。主会话隔离复现与审查均证明 `agy plugin install` 忽略 `GEMINI_HOME`，只装到 `$HOME/.gemini/config/plugins/`；不能据此宣称共享插件已被 IDE 或 ACP 加载 |
| T3 派出的 Pi 子会话 | 上一轮仅测 `01a207ec-cdcf-7366-a18b-1e4e06fa094a`，其第 8 行有 `ab brief --worker`，两种检查为 true。这不代表 T3 Pi 全覆盖。现行 `src/transcript.ts:59-65` 仅匹配该字面标记，首轮只有 T3 工具前缀而无开工标记时返回 false；本轮用同形输入调用生产函数复现 |
| 项目解析 | 对本分支目录运行 `git rev-parse --path-format=absolute --git-common-dir` 得到 `~/code_me/agentbrain/.git`，现有 `resolveProject` 返回 agentbrain。对 `~/code_me/pm` 返回 pm，`isRegistryHome=true`。实现是 `src/registry.ts:48-73` |
| 定时兜底 | `launchctl print gui/501/com.agentbrain.work` 显示任务已加载、`run interval = 1800 seconds`。仓内样例为 `integrations/launchd/com.agentbrain.work.plist:14-15`；静置门槛为 `src/work.ts:30,703-709` 的 30 分钟 |

#### 7.8.2 发现、只读和去重

`src/agy.ts` 统一枚举应用根，供 sweep、准入、定位与 doctor 共用。固定根只有 CLI 和 IDE；每次再列 `~/.t3/userdata/providers/antigravity/` 的直接子目录，取其 `antigravity-acp/`。不写死四个实例，不递归扫整个 `.t3`，不保存账号清单。某处失败不影响其他处。

每个根按以下规则发现会话：

1. **先验证原路径，再复制。** 应用根的 realpath 必须仍在允许的固定根或 T3 单层实例布局内。摘要库和存在的 `-wal`、`-shm` 各自的 realpath 必须落在该根内，拒绝逃逸后才复制。不能只检查 `/tmp` 副本，不能因复制跟随软链而绕过 `src/agy.ts:43` 的原路径检查。副本用 `DatabaseSync(..., {readOnly:true})` 只查 id、workspace、parent、修改时间，结束后清理；不读 `raw_summary`。
2. 摘要库不存在且没有完整日志的新实例显示“0 对话，尚无摘要库”，不报坏库。有日志但无摘要库或对应行时，保留日志计数并报“缺会话元数据”，不猜 cwd。无权限或损坏显示“无法读取”，不显示 0。
3. 摘要行先与同根实际完整版日志相交，形成 `{id, cwd, parent, transcript, modifiedAt}`。跨库同步而本根没有日志的摘要不参与收录。近 7 天用会话 `last_modified_time`，时间坏了才用本文件 mtime；去掉目前的摘要时间和文件 mtime 双重过滤（`src/work.ts:53,178,225-232`）。已登记会话不受发现窗口限制。
4. 同 id 在多个根都有完整版时直接报冲突，本次跳过该 id 的登记、定位和抽取。不读全文、不比前缀、不选最长或按时间换来源。现有登记和 L1 指针保持原样。
5. **agy 路径固定。** 对 agy，upsert 在短写事务里读已有行：原路径为空可首次补齐；非空时只接受同一规范路径。另一根的路径或无法确认本根的输入返回冲突，不改 transcript、last_touch、ended_at、processed_anchor 或该行其他字段；`captureHook` 遇到这个结果不再拉起 work（`src/cli.ts:1144-1158`）。同根 touch 与 Stop 沿原语义更新。路径失效报来源不可用，不自动替换。

只改变 agy 的覆盖规则。Codex 编辑消息会换 rollout 文件，`codexContinues` 要靠新文件首 ordinal 大于旧进度来接续（`src/work.ts:279-286,324-330`）。现有测试显式换文件后从 635 接到 644（`src/work.test.ts:1687-1719`）；本轮生产函数探针也确认 upsert 能换路径，chunk 能从旧进度接入新文件。Codex 和其他宿主的覆盖行为保持不变；空路径事后补找仍沿 `src/intake.ts:164-167`。

引用扫描同样以 agy 的非空 `capture_sessions.transcript` 为准，不再让 `sessionsToScan` 的跨表 `MAX(transcript)` 选另一根（`src/telemetry.ts:265-274`）。没有登记基线时，只有唯一合法路径才可补找，多根则报冲突跳过。非 agy 的选择规则不在本节修改范围。

parent 非空的子会话仍不由 sweep 补登记。全部日志数、非子会话数与可抽取数分开计。普通扫描沿既有 scan/backfill 分类及每次 10 个积压窗口的预算（`src/work.ts:237-240,39`）。

#### 7.8.3 登记、会话身份与项目

会话 id 保留 `conversationId` 原值，路径携带应用根，三处共用 `host=agy`。不把账号或实例 hash 拼进 id，不迁移现有 CLI 会话键。

- `pickHost` 仍从最近的宿主父进程向外找。T3 的进程本来就是 agy，无需凭 `GEMINI_HOME` 改判宿主。IDE 增加 `Antigravity`，以及 comm 位于 `Antigravity.app` 内或参数含 `--override_ide_name antigravity` 的 `language_server`。不认所有 `language_server`；IDE 内启动 Pi、Claude Code、Codex 时仍取内层宿主。IDE 特征来自旧切片 `7c92d6f` 的已测进程链；当前 `pickHost` 回放该链返回 null，实现验收还须真测 IDE 工具 shell。
- `locateTranscript("agy", id)` 先核验 `ANTIGRAVITY_APP_DATA_DIR` 是否属于枚举出的应用根；仅有 `GEMINI_HOME` 时只接受已发现的 T3 实例，并使用其 `antigravity-acp`。无论有无根提示，多根有同 id 完整版都按 7.8.2 报冲突跳过；无冲突才从提示根或唯一候选定位。日志未落盘可保留规范坐标，不靠遍历顺序选“第一份”，不放行任意环境路径。
- 钩子传 `session_id`、`transcript_path`、`cwd`，路径中的 id 必须与传入 id 相同。sweep 从该根的 `workspace_uris[0]` 经 `fileURLToPath` 得到 cwd，保留 §7.7 的首工作目录口径。多个 workspace 不扩成多个项目，宿主摘要的 `project_id` 不作为 agentbrain 项目身份（当前读法见 `src/agy.ts:53-62`）。
- 项目继续只由 `repos/*.md` 登记路径决定。普通 worktree 经 `git-common-dir` 归回登记仓库，pm 会话仍归 pm，不因对话提到其他仓库就改归属。抽取按目标项目归属沿 §8.11。目录已删或未登记时只留坐标，不抽取项目记忆，doctor 分列原因；本节不新增执行根映射。

不增加 `capture_sessions.worker`，库版本保持 1，但必须补共用识别逻辑。上一轮单条 Pi 阳性不足以证明覆盖；`ephemeral=0` 只表示有持久文件。`src/transcript.ts:49,59-65,342-345` 的首轮判断同时接受以下 T3 前缀，并保留宿主原有子会话信号和开工标记：

- `[T3 Code: the agent in T3 thread "…" sent this message, not the user.]`
- `[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]`

匹配发生在首个真实输入上、剥包装之前，不因正文任意位置提到 T3 就判 worker。开工标记允许 `ab brief <项目> --worker` 的参数顺序。这个判断供 agy、Pi 的全文与读头路径共用，影响 `cleanTranscript`、每轮偏好和 audit/curate 调用方；不是只修 agy，也不改变 Claude、Codex、opencode 原有信号。两类首轮都是父代理输入，不能当用户原话。

`cmdRecall` 必须先经 `telemetryCtx` / `allowedTranscript` 得到完整版规范路径，再判 worker，不能直接检查钩子传来的截断版（`src/cli.ts:239,246`）。agy 读头仿 Pi，必要时从 16,384 字节扩到 262,144 字节；首行仍不完整时只对首条消息的原始 JSON 文本匹配已知标记，不能因解析失败就判主会话。Pi 的共用回退也补齐两类标记（`src/transcript.ts:392-424,427-445`）。没有完整首轮、也没有阳性标记时保持身份待定，不先注入主会话偏好。这是来源分类，不授予能力。

#### 7.8.4 钩子、安装和延迟

方案 A 不要求 T3 插件。实现第 1 步先在 `/tmp` 隔离实例探活方案 B：隔离 HOME、GEMINI_HOME、AB_HOME、AB_REGISTRY 和钩子 shell，使用仅记录测试标记的钩子，通过 `agy acp --gemini-dir <隔离实例> --app-data-dir antigravity-acp` 验证 ACP 是否读取该实例的 `config/plugins/` 并触发钩子。同时测软链到隔离 HOME 的 `.gemini/config/plugins/agentbrain`，核对实际钩子标记与注入，不只看插件清单。此步本轮不执行，不用真实账号改正式配置。

`agy plugin install` 只认 `$HOME/.gemini/config/plugins/`，删掉按 GEMINI_HOME 安装的命令。ACP 探活成功才保留 B：只装一份共享插件，各实例软链到它；失败或未证实，本版删除 B，继续 A，不绕到另一套安装机制。给真实实例创建 `config/plugins/agentbrain` 软链会写 `~/.t3`，必须由用户另行点头；不覆盖已有入口，不由 sweep 自动建链。`config/skills` 的现成软链只是形态参考，不是 plugins 能加载的证据。

CLI、IDE 的既有插件使用原有三个事件（`integrations/agy/hooks.json:3-5`）。新会话无首轮时暂不注 brief；首个 PreInvocation 身份明确后，在模型调用前注入。恢复会话已有 SYSTEM_MESSAGE 中的 `<agentbrain-brief>` 时不重复注。此合同只在 B 成立后扩到 T3 ACP。

brief 状态与现有 prompt 去重状态分开。插件在自己的数据目录按“规范应用根 + 会话 id”保存 pending/done 标记，不存正文、不加配置键。ab 返回非空 brief 且插件成功输出后才置 done；失败或空输出保留 pending，下一次 PreInvocation 重试，不能被 prompt 已 seen 的提前返回挡住。同一 prompt 的 pending 重试只读取会话状态，不再次 capture，也不再次注入 recall 的偏好和提醒。恢复时即使标记丢失，转录中的已注入块也能判 done。插件不自行解析 JSONL。

共用判断由 ab 完成。agy 插件的 `recall --hook` 传 `session_id`、`transcript_path` 和 `want_session_state:true`，返回除原有上下文外的 `agentbrain.session` 元数据，包含 `worker`（true、false 或待定 null）与 `brief_present`。这不是配置键，也不落库；未请求的调用输出不变。插件据它选择 `brief --worker` 或 `brief`，待定时不注主会话规则。先取得身份和状态，再输出本次 brief 与偏好，不复写一份解析器到 `.mjs`。`brief_present` 只检查 SYSTEM_MESSAGE 的 content，不在 USER_INPUT 或整份原文里搜索；读头上限为 262,144 字节。最后一行截断时，先确认行首对象的 type 为 SYSTEM_MESSAGE，再检查已读到的注入标签。身份与 brief 状态分别判断，均使用准入后的完整版路径。

钩子只保证 stdin 坐标，不能假定环境已有会话 id。调用 ab 子进程时补 `ANTIGRAVITY_CONVERSATION_ID=hook.conversationId`。规范应用根优先取 `hook.transcriptPath` 匹配 `/^(.*)\/brain\/[^/]+\/\.system_generated\/logs\/transcript(?:_full)?\.jsonl$/` 的根；否则取 `ANTIGRAVITY_APP_DATA_DIR`；再否则取存在的 `<GEMINI_HOME>/antigravity-acp`。存在的根用 realpath；无根时不硬塞空环境坐标。brief 标记与 seen 文件都以 `sha1(规范应用根 + "\0" + conversationId)` 命名，无根时用空串与 id。ab 再核验根与 id，宿主仍按父进程链判定。这样 `brief` 的 `detectCtx` 能写带坐标的 inject_log；recall 与 capture 同样补传坐标。

T3 只靠 A 时没有自动开工或偏好注入，需主动 `ab brief` / `ab search`。30 分钟静置加每 30 分钟巡检，在正常运行、无积压或模型故障时，最后一条消息后约 30 至 60 分钟开始抽取，不承诺完成时间。巡检没加载须报告；积压仍每次最多 10 个窗口。

#### 7.8.5 transcript 格式与稳定定位点

三处都使用 §7.7 的每行一步格式，字段为 `step_index`、`type`、`status`、`created_at`、`content`，助手另有 `model`、`thinking`、`tool_calls`。只读对比的真实片段如下，路径使用 7.8.1 的应用根与日志尾：

| 日志 | 片段 |
|---|---|
| CLI `14244976-2d08-4627-be75-b4cd19d8fb3f` | 第 1 行为 `step_index=0, USER_INPUT, status=DONE`，`<USER_REQUEST>` 内是“只回答一个字：好”；第 5 行为 `PLANNER_RESPONSE, status=DONE, content="好"` |
| IDE `63892cce-332b-464d-8483-b7ba8c7d45df` | 第 77、86 行都是 `step_index=76, USER_INPUT`，用户正文相同，差异是宿主元数据时间；这是从 84 回滚到 76 后重跑，不是新输入。15 份 IDE 日志中 4 份有重复 step，当前该文件有 5 个重复轮次定位点 |
| T3 `60c7502f…/c1bda9bb-129b-49cd-8407-96991bb7c982` | 第 1 行为 `step_index=0, USER_INPUT, status=DONE`，包装含 `<t3_code_instructions>`、`<user_request>`、`<runtime_info>`；第 2 行为 `PLANNER_RESPONSE, status=DONE`。CLI、11 份 T3 日志都未发现重复 step |

读取和来源展开仍共用 `cleanTranscript("agy")`（`src/source.ts:142-147,198`），不另写 IDE 或 ACP 解析器。保留 USER_INPUT、PLANNER_RESPONSE、GENERIC 的原有映射；SYSTEM_MESSAGE、thinking 不读，CHECKPOINT、ERROR_MESSAGE 不冒充用户原话或完成回答；`status=DONE` 且无工具调用、有正文才算完成回答（`src/transcript.ts:317-338`）。

定位点仍在遍历原始 JSONL 时生成。首次出现保留数字字符串，第 n 次用 `<step>#<n>`，包括之后被去噪丢掉的步骤。保留回滚前的旧行，不按时间重排或合并，否则旧处理进度会失配。每次 `step_index <= prevStepIndex` 先清空 pending，再处理当前行；原有 USER_INPUT 清空也保留。`#n` 同时隔离工具调用与 abCalls 的键，但防 FIFO 错配靠清 pending，不能只改 id（`src/transcript.ts:317-339`）。

T3 输入按以下顺序处理，读取和来源展开共用结果：

1. 外层 USER_REQUEST 按宿主结构取出，结束位置取尾部零或多个全大写宿主块前的最后一个闭标签。尾随块包括 ADDITIONAL_METADATA、USER_SETTINGS_CHANGE；没有尾随块时锚定文件尾。不被用户正文里的同名字面标签提前截断。若有 T3 包装，从 `</t3_code_instructions>` 后首个 `<user_request>`，取到紧贴 `<runtime_info>` 前的末个 `</user_request>`；不使用第一个闭标签。先识别委派前缀，再剥包装。
2. 开头为 `Context handoff (full_thread_summary):` 时，从最后一个 `\n\nUser message:\n` 取当前消息。只有这类宿主交接头才走此分支，普通用户正文里的 `User message:` 不切。缺边界则整轮丢弃、计 stripped，不让摘要成为用户证据。
3. 规范化后以 `Delegated task node:delegated-task:… in child thread …` 开头的完成通知，以及有明确 T3 后台任务唤醒头的合成 USER_INPUT，整轮不生成 user，计 stripped。不是按正文含“completed”就丢弃。裸消息同样检查，不能把“无包装”直接当成真实用户输入。实例 `60c7502f…/d92d7fb3…` 第 45、60 行是必测样本；当前第 60 行经过 `ownUserText` 仍保留 7117 字（`src/extract.ts:149-166`）。
4. `<assistant_citations>` 只提取 `citation.comment`，不取 text、prefix、suffix、定位数据或 `[assistant-quote-N]` 占位符。解析其说明文字后的 JSON 数组，缺 comment 返回空，坏 JSON 不回退为整块原文。实例 `ac0a3dfd…/adb838bc…` 第 144 行数组是 `[{id,citation:{text,comment,...}}]`，只保留“是这个”。在用户证据检查入口补同样的 comment 例外，避免 `stripPasted` 再丢掉它；复用 `QUESTION_REPLY` 的提取方式，不放宽其他引用块（`src/extract.ts:131-147`）。

其他无包装且不命中明确宿主消息结构的输入继续按 §7.7。单测包含用户正文自带 `</user_request>`、`User message:`、引用块和唤醒字样的反例。定位点唯一性供 chunk、来源展开共用（`src/work.ts:324-330`、`src/source.ts:142-147`）；宿主改写导致旧定位点无法对应时报告来源不可用。当前通用去噪入口为 `src/transcript.ts:101-111`。

#### 7.8.6 诊断与不做

`ab status` 和 `ab doctor` 共用入口（`src/cli.ts:1763`），每个根只显示一行，例如 `agy IDE: 日志 15（可抽 N），已登记 0，插件在位`。CLI、IDE、T3 每实例各一行，不再展开八项指标，不新增统计表。只靠 sweep、新实例尚无对话或无法读取就在该行注明；异常详情只进顶部“要处理”。

计数重新发现实际日志，再与固定的登记路径对齐，不能依赖已登记行才发现当前全零断档。同 id 冲突跳过且单列异常，不重复计数。每个 cwd 的 `resolveProject` 单独捕获 ENOENT，计为目录已删并排除可抽取数，不让整份 status 崩溃（`src/registry.ts:48-58`）；已存在但未登记的目录另计。新实例无摘要库且无日志是 0；有日志无摘要库是缺元数据；坏库或无权限是无法读取。某处有可抽取主会话但已登记为 0 必须进“要处理”，不能被 CLI 插件正常覆盖。

诊断不补登记、不调模型、不装插件，`status --line` 不变。回退整个实现提交不需要反向迁移，版本仍为 1；旧代码读不到新增路径或 `#n` 定位点时报告来源不可用。回退代码不删除已抽出的记忆，撤销产出仍用现有 archive。若 B 获准，只撤本次建的插件软链或恢复原入口，不删除共享插件、skills 链或其他配置。

本节不做：

- 新配置键、安装监控器、新宿主类型、会话命名空间、`worker` 列或版本迁移。未来确需新增表、列或事件种类时，必须重开 §12.6.1 的升级设计；旧代码只读的单向门后果不能绕过。
- 新执行根登记、bare hub 映射、账号身份或委派能力协议。
- 解码缺日志对话的私有存储、读取 chunks/scratch、归档完整 transcript、超过 7 天的未登记历史全量回填。34 个 IDE brain 项不等于承诺补出 34 份日志。
- 改抽取模型、话题模式、转正规则、召回排序，或替用户自动确认。
- 在本次设计任务中写正式库、改宿主配置、安装插件或跑真实模型验收。

#### 7.8.7 实现后的验收

先维护 `.agents/skills/verify-agentbrain/features/agy-host.md` 和 `SKILL.md`，将 CLI 单处功能地图扩成三处。现有 `verify.sh run` 的 `cli-agy` 只覆盖 CLI（该功能地图第 14-15 行），不能用它一项通过宣称 IDE、T3 已接通。

| 场景 | 输入、结果和证据 |
|---|---|
| 离线单测 | 同时隔离 HOME、AB_HOME、AB_REGISTRY，临时目录先 realpath。新增实例、无摘要空实例、缺元数据、坏库、已删 cwd、DB/WAL/SHM 和日志逃逸软链均覆盖。多根同 id 直接冲突跳过；agy 异根 touch/Stop 不改任何会话字段、不触发 work，引用扫描仍取固定路径；Codex 换文件覆盖与接续不变。Pi、agy 的两类 T3 前缀、带项目参数的 worker 标记、截断路径规范化、16KB 以上首行及 262KB 原文回退均测试。身份待定不注主会话规则。库版本保持 1 |
| 去噪与工具配对 | `d92d7fb3` 第 45、60 行不能生成 user 或提供用户证据；`adb838bc` 第 144 行只剩“是这个”。嵌套闭标签和普通 User message 字样不误切；handoff 无末尾边界整轮去噪。IDE 回滚产生 `76` / `76#2`，旧进度仍可定位；另造非 USER_INPUT 回跳，pending 必须清空，GENERIC 不能配到旧 ab 调用 |
| 三处真实会话的隔离重放 | 各选一份非子会话、有可抽取信号的完整日志，先记录 id、真实路径、原 cwd 与项目。初始测试库没有这三个 id。将副本放在隔离 HOME 的三类根，摘要沿用真实 cwd，隔离 registry 显式登记对应项目；假 chat 只放模型边界，真实 `runWork(..., {sweep:true})` 发现、登记、处理。三处各产出一条引用真实原话、通过生产校验的条目；精确查会话坐标、处理定位点及窗口终态。真实 CLI 的 status/doctor、`work --dry-run` 核对已登记结果；dry-run 不负责首次发现（`src/work.ts:1426-1429`）。再跑一次，登记行、已完成窗口和相同候选不增加 |
| 既有钩子与可选 B | CLI、IDE 验证 SessionStart 无输入、首 PreInvocation、ab 失败重试和恢复不重注；brief done 与 prompt seen 独立。去掉钩子继承的坐标环境，仍须靠 stdin 补 env，让 inject_log 的 brief 和 recall_runs 对齐同一会话。T3 钩子只在隔离 ACP 确认加载并触发后才验；未证实就删除 B，不作为 A 的失败或通过证据。真实软链另获授权，仍按 `hosts.ts` 隔离 hook、shell、会话目录和库 |
| 只靠 sweep 的实例 | 测试实例不装插件，静置时钟用可控时间而非真实等一小时；一次 sweep 登记并处理。新增一个实例后下一次能发现。CLI 插件在位时 IDE 或一个 T3 实例仍有对话且 0 登记，status/doctor 必须逐处报“要处理”；坏库不能显示成 0 |
| 项目与来源 | 真实 worktree 归登记仓库，pm 归 pm；已删和未登记目录不出项目记忆。三处各一次 `ab get --expand` 能打开对应日志定位点，路径不能串到另一实例。T3 的非子会话不能因实例目录被判 worker；有明确派活标记的不能按用户原话抽取 |
| 完整验证与副作用 | `npm test`、`npm run typecheck`、`.agents/skills/verify-agentbrain/verify.sh run` 全过，再跑上述三处专项。证据写到 `~/.cache/verify-evidence/agentbrain/<运行时间>-agy-wiring/`。重拷正式库，按本轮新增测试 id 逐表确认 0 收录，检查正式宿主配置和源 transcript 未变。无独立隔离启动办法的 IDE 或 ACP 项记 BLOCKED，并列出缺失的证据 |

本轮只修候选设计，不执行验收或 ACP 探活。用户说“开始实现”才推进 A；只有探活证明 B 成立、用户再同意正式软链，才改真实 T3 实例。

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

### 8.6 话题结束时一步式沉淀（**已批准，实现中**，2026-10-16；新触发默认关闭）

> 状态：**2026-10-16 用户批准实现**（PR #58 第 10 点四个问题，用户回"实现"）。决定见第 10 点。新触发做成**默认关闭**的开关：等 `docs/eval/07`（一步式 vs 两步式，需 Claude 额度，10-17 01:00 SGT 恢复）补跑完、且第 11 点的验收评测显示话题窗口确实更好，才由用户打开。开关关着时 `ab work` 的行为和现在完全一样。
>
> 原候选依据：用户 2026-10-15 提出"一个主题的对话完了再抽，子代理读这部分上下文和背景去抽"（"可以"），以及 pstack 复核后的简化方向（抽取和判断合成一个后台子模型一次完成，候选区只当审计记录和撤销手段）。

**1. 现在的做法和问题**

现在 `ab work` 从处理进度（checkpoint）往后按轮次切窗口，每块最多 48000 字（`WINDOW_MAX_CHARS`），附前 4 轮当背景（`CONTEXT_OVERLAP_TURNS`）。会话结束、或 transcript 30 分钟没动（`SETTLE_IDLE_MS`）时，最后不满 48000 字的那块才处理。问题：

- 窗口按字数切，不按话题切。一个话题经常被切成两半，抽取器看不到前因后果。
- 前文只有 4 轮，用户在话题开头讲的理由经常落在窗口外。
- `docs/eval/07` 的中期结果显示，现在的短板是**抽取漏掉有用内容**，不是判断不严（只审原候选 Haiku 15/16、astra 13/16；重新抽取后一步式 7/16、两步式 5/16）。给抽取器完整的话题是补这个短板最直接的办法。

**2. 什么时候算"一个话题结束了"**（三个触发，哪个先到用哪个）

| 触发 | 为什么算话题边界 |
|---|---|
| 静置约 20 分钟 | 用户 20 分钟没说话，通常这件事告一段落 |
| 上下文压缩 | 压缩后前面的内容会从主会话里消失，是天然的话题边界 |
| 会话结束 | 会话里的内容不会再变 |

**3. 三个宿主今天能拿到的事件**（2026-10-15 查官方文档和本机安装版本的类型定义）

| | 会话结束 | 上下文压缩 | 每轮结束 | 静置 |
|---|---|---|---|---|
| Claude Code（本机 2.1.295） | `SessionEnd`，`reason` 为 `clear` / `resume` / `logout` / `prompt_input_exit` / `other`；所有 SessionEnd hook 共用约 1.5 秒预算 | `PreCompact` / `PostCompact`，matcher 为 `manual` / `auto` | `Stop` | 没有可配时长的静置事件。`Notification` 的 `idle_prompt` 是"等你输入"的提醒，不是 20 分钟计时 |
| Codex（本机 0.162.1） | `SessionEnd`，`reason` 目前只有 `other`；默认 1 秒、最多 3 秒，总是同步执行。**会话闲置 30 分钟且没有任何客户端打开时也会触发** | `PreCompact` / `PostCompact`，字段 `trigger` 为 `manual` / `auto`；压缩后还会跑 `SessionStart`（`source: "compact"`） | `Stop` | 只有上面那条"闲置 30 分钟后 SessionEnd" |
| Pi（本机 pi-coding-agent 1.2.0） | 扩展事件 `session_shutdown`，`reason` 为 `quit` / `reload` / `new` / `resume` / `fork` | `session_before_compact` / `session_compact`，`reason` 为 `manual` / `threshold` / `overflow` | `agent_end` / `agent_settled` | 没有 |

来源：Claude Code <https://code.claude.com/docs/en/hooks>；Codex <https://developers.openai.com/codex/hooks>；Pi 为本机 `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`。实现前要在三个宿主里各实测一次事件真的会来、transcript 在压缩后仍保留压缩前的原文（这是从会话文件补读话题的前提）。

**4. 静置怎么判断**（宿主都没有现成的 20 分钟事件）

- **候选 B（建议先做）：下一轮再判断。** 用户发下一句话时，`UserPromptSubmit` / `before_agent_start` 已经在跑 `ab capture --hook`。这时如果距上一轮（`last_touch`）已超过 20 分钟，就把"处理进度到上一轮结束"这段当作一个已结束的话题，拉起分离的 `ab work --session` 去处理，不阻塞本轮。好处：不加新 hook、不加新进程种类、不需要 launchd（用户要求 `com.agentbrain.work` 保持不加载）。代价：用户不回来时，要等会话结束（或 Codex 的闲置 30 分钟 SessionEnd）才处理。
- **候选 A（以后再说）：每轮结束定一个闹钟。** `Stop` / `agent_settled` 时拉起一个分离的 `ab work --settle <宿主>:<会话> --after 20m`，每个会话只留一个，新一轮把截止时间往后推；醒来时确认 transcript 20 分钟没动才触发。会多一种常驻几十分钟的进程，还要处理机器睡眠、重复闹钟。
- `SETTLE_IDLE_MS` 从 30 分钟改成 20 分钟（代码常量，不加配置键，§2.2）。

**5. 话题窗口怎么切**

- 话题窗口 = 从处理进度到触发点（静置：上一轮最后一条；压缩：压缩前最后一条；结束：会话最后一条）。
- 另附话题开始前的若干轮当背景，放在 `<context_only>` 里（只供理解，不能当依据，现有提示词已有这条规则）。建议从 4 轮放宽到"最多 8 轮且不超过 6000 字"，代码常量。
- 话题太长（超过约 120000 字，常量）时仍按轮次边界拆开，每段都附它前面的背景，记 `part: k/n`。拆开是兜底，不是常态。

**6. 谁来跑：后台宿主子模型，一次完成抽取和判断**

- 提示词和输出校验已有：`src/onepass.ts`（PR #54）。模型读话题窗口 + 背景 +《好记忆的标准》+ 附近已有记忆，一次给出 0～8 条结论（原为 5 条；2026-10-19 起按 §8.7 召回修法 1–3 改为 8 条，并去掉偏少倾向、加按类清单，§8.7 见下节），每条是"新记"或"并入已有某条"。
- 用哪个模型：哪个宿主的会话就用哪个宿主的命令行子模型和它自己的额度——Claude Code 用 `claude -p` Haiku 5.5 max；Codex 用 `codex exec`，模型取 `~/.codex/config.toml` 的 `review_model`（没有就 gpt-6-astra）、推理 max；Pi 用 `pi -p`，模型取 reviewer 子代理配置（本机 openai-codex/gpt-6-astra）、thinking max。和 `ab setup` 的宿主审稿人默认一致（PR #54 `hostReviewerDefault`）。
- 防自激沿用 `AGENTBRAIN_REVIEWER=1`：子模型的会话不登记、不召回、不再触发抽取。
- 额度用完：窗口留在队列里，记下恢复时间（PR #54 已能认出 Claude 的 "resets Oct 17 at 1am" 格式），到时再跑；不悄悄改用别的宿主的额度。
- **前提**：`docs/eval/07` 补跑完，一步式仍然不比两步式差。如果补跑后结论反转，本节改成"话题窗口 + 两步式"，其余各点不变。

**7. 写进库的东西和记录**

- 每条结论写一条 `remember`，`origin: "extract"`，未确认；按简化方向直接进正式库（不再等审稿团）；每次运行写一份报告当审计记录（写了哪些事件），可整次撤销，单条也能用 `ab stage <id>`（移回候选区）或 `ab archive` 撤回。是否直接进正式库还是先进候选区，**待用户定**（见第 10 点）。
- 每条记下：来源会话和消息定位点范围（`source.anchor` 起止：Claude 消息 uuid、Codex 行序号、Pi 条目 id）、`window_id`、触发方式（`idle` / `compact` / `session_end`）、`prompt_version`（`ONE_PASS_SYSTEM` 全文的短哈希，提示词一改就变）、模型（`宿主:模型@推理强度`）。
- "并入已有某条"：不改目标正文。目标是用户确认过的，只给它追加一条 `evidence`（来源指针），合并后的写法进本次报告供用户看；目标未确认的，同样只追加证据，改写交给用户或下次审查。这一点继承 §5.5 / LOCKED"不悄悄改用户确认的条目"。
- 引文逐字核对、写 L1 前二次脱敏照旧（§8.1）。

**8. 和现有 hook、队列的关系**

- 现有 `UserPromptSubmit`（`ab recall --hook` + `ab capture --hook`）和 `SessionEnd`（`ab capture --hook`，结束时拉起 `ab work --session`）不变，候选 B 只在 `capture` 里多一个"距上一轮超过 20 分钟"的判断。
- 新增：Claude Code / Codex 各加一个 `PreCompact` hook 跑 `ab capture --hook --host <宿主>`（`hook_event_name` 为 `PreCompact` 时，把当前最后一条记为话题边界并拉起 `ab work --session`，自己立刻返回，不挡压缩）；Pi 扩展加 `session_before_compact` 处理，同样只登记、拉起、立即返回。`ab setup` 的 `mergeHooks` 相应多写这一条（写前备份、给 diff、确认后写，现有流程）。
- 队列：`capture_windows`（`window_id` 主键、状态、重试次数、下次时间）照用。话题窗口就是一行窗口记录，只是边界来自触发点，不来自 48000 字。单实例租约（`work_lease`）照用。

**9. 不重复、不漏**

- `window_id = sha256(宿主|会话|起点|终点)`，同一段只处理一次；处理进度和写 L1 在同一事务里推进（现有）。
- 压缩和会话结束先后到达：第二个触发的起点是已推进的处理进度，只处理剩下的部分，不会重抽。
- 两个触发同时拉起 `ab work`：租约保证只有一个在跑，另一个直接退出，留给下一次。
- 会话结束后又 resume：现有规则 `ended_at < last_touch` 视为未结束。
- 候选去重键 `sha256(window_id|kind|正文)` 照用；提示词换了版本，旧窗口不自动重跑，要重跑用 `ab work --session <key> --redo`。

**10. 用户的决定**（2026-10-16，原"待用户定"四问）

1. 静置门槛：**20 分钟**。
2. 静置判断：**候选 B**（下一轮进来时判断，不加闹钟进程），另加压缩、会话结束两个触发。
3. 一步式结果：**直接进正式库**，状态未确认、可撤销；候选区只当审计记录和撤销手段。
4. 现在就实现，但新触发**默认关闭**，等 `docs/eval/07` 补跑完和第 11 点验收评测证明更好再打开（原建议"等评测完再开工"改为"先实现、后打开"）。

**11. 怎么验收**（打开开关前先做评测，写进 `docs/eval/`；脚本与方法见 `docs/eval/11-topic-windows.md`）

用 90 条标注里能找回窗口的 42 条：按本节规则重新切成话题窗口，和现在的 48000 字窗口各跑一遍一步式，看"有用"留下几条（这次的短板）、"没用"挡住几条、每个话题的花费和耗时。话题窗口要在"有用留下"上明显更好才值得改。

**12. 实现说明**（2026-10-16，PR #59 `feat/topic-end-extract`，基于 PR #54；和上面写法不一样的地方逐条列出理由）

- **开关**：`~/.agentbrain/extract.json` 的 `"topic": true`，默认没有＝关。这是 1 个配置键，按 §2.2 属于"按阶段调整"的少数项；它本质上是新旧两条路径的切换门，评测定下来以后应删掉开关、只留一条路径（§2.2 双写门目标为 0）。不用环境变量：hook 在宿主进程里跑，拿不到用户 shell 的环境。
- **静置门槛**：话题模式用 `TOPIC_IDLE_MS = 20 分钟`；旧路径的 `SETTLE_IDLE_MS` 保持 30 分钟不动，开关关着时行为完全不变（第 4 点原写"改成 20 分钟"）。
- **静置边界怎么定**：hook 热路径不读 transcript，所以 hook 只负责"该看看了"（距上次登记 ≥ 20 分钟就拉起 `ab work --session`）；真正的边界由 `ab work` 读 transcript、看相邻两轮的时间戳差 ≥ 20 分钟决定，加上压缩标记和会话结束（或 transcript 20 分钟没动）。这样同一段 transcript 每次切出来的边界一样，`window_id` 稳定。
- **压缩标记**存在 `work_meta`（键 `topic_marks:<宿主>:<会话>`），不加表、不改 schema。标记**处理完也不删**，和会话坐标同生共死（会话坐标按保留期删掉时一起删，审查第 2 轮）：`ab work --session --redo` 清掉进度重切时还要用它，切出来的窗口和 `window_id` 才和第一次一样，相同输出不会重复写（审查第 1 轮 P2-5）。标记的读改写在写事务里做（hook 和 `ab work` 是不同进程，P2-6）。标记第一次切窗口时**定到具体轮次**（记 `anchor`），之后重切都用这一轮，不再按时间重找——否则没有时间戳的转录会被同一个旧标记反复切在新的末尾（第 2 轮）。
- **"并入已有某条"不写库**（第 7 点原写"给目标追加一条 evidence"）：evidence 事件没有撤销手段，违反"每个改动都可撤销"；而且一步式输出没有引文，追加的只是一个空指针。改为只记在运行报告的 `merges` 里（含目标是否用户确认），给用户看、由用户决定。
- **没有逐字引文**（第 7 点原写"引文逐字核对照旧"）：`docs/eval/07` 测的一步式提示词不要求引文，为了和评测一致没改提示词。所以写入的条目 `basis` 一律记 `agent_inference`、`evidence` 为空——不声称"用户原话"。后果：这些条目按 §21 2026-10-13 的门槛**不进每轮召回**（未确认条目要有用户引文才进），只能 `ab search` 到、brief 里计数；用户 `ab confirm` 后正常生效。要它们进召回，得给提示词加引文要求（`prompt_version` 会变）并重测。
- **写入正文、为什么、场景、报告里的模型文字**写 L1/落盘前都再脱敏一次（§13.2）；条目都记在项目范围（一步式输出没有 scope 字段）。
- **额度/限流**：不算失败尝试（否则额度用完几小时会把话题判成终态失败丢掉）；窗口延后到恢复时间，宿主冷却时间记到 `work_meta`（`topic_cooldown:<宿主>`），恢复前别的会话、下一次 `ab work` 都不再给这个宿主发请求。
- **租约**：子模型单次调用可能超过 10 分钟租约，调用期间每 60 秒续一次。
- **整次撤销**：`ab work --undo <run>`，以 L1 为准（每条 `remember` 带 `topic.run`）；只归档本次写入、之后没被动过（无 archive/reactivate/stage/curate 事件、没并入别的来源、没判过关系）的条目，用户确认过的、已自动转正的不动。每条的检查和归档在同一个写事务里（防止检查完、写入前用户刚 `ab confirm`，P1-3）；后台 `ab work` 拿着租约时拒绝撤销（防止撤一半后面又写进来，P2-4）；话题窗口写库的事务里再确认一次租约还在自己手里，租约过期被接管后，暂停后恢复的旧进程不能再写（第 2 轮）。运行报告 `~/.agentbrain/topic/<run>.json` 是审计记录；候选区不再参与。
- **Claude 压缩摘要**（`isCompactSummary`）不当成用户的一轮：它是宿主写的前文复述，否则压缩后会把前一个话题再抽一遍。这一条对旧路径也生效（同样是去噪）。旧版可能把处理进度存在摘要那一轮上：读到这种进度时换成它前面那一轮（同一事务条件更新），不会报 `source_unavailable` 卡住整个会话（P1-1）；`--dry-run` 只在内存里换，不改库（第 2 轮）。
- **第 2 层关系判定（`relatePass`）不碰话题沉淀写的条目**（审查第 1 轮 P1-2）：判成重复时它会给旧条目追加来源、把新条目归档，这一步整次撤销撤不回，等于绕过了上面"并入只进报告"的决定。话题条目和库里高相似（≥0.8）时已标"关系未判定"交给用户。
- **子模型只用宿主命令行**（P2-7）：`review.json` 的 `hostReviewers.<宿主>` 配成 API 的，话题沉淀不用它（数据会发给别的服务、用别的额度），也不悄悄换成宿主默认，报 `no_config`、窗口延后，等用户改配置。
- 第 3 点要求的"三个宿主各实测一次事件真的会来"**还没做**：需要在用户机器上装 hook，本 PR 不碰用户的宿主配置。已离线核对本机 transcript：Claude（`compact_boundary` + `isCompactSummary`）、Codex（`compacted`）、Pi（`compaction` 条目）压缩后都保留压缩前原文。

### 8.7 一步式沉淀的召回修法（修法 1–3 **已实现并合并**，2026-10-19；合并 2026-10-19）

> 状态：**修法 1–3 已实现并合并**（2026-10-19 用户说"改吧"；PR #54 合并提交 `012a971`、PR #59 合并提交 `25c761f`，进入 `docs/agentbrain-v2-design`）。只批准下表第 1–3 行：提示词与 V1（版本 `eea066fc04d0`）逐字相同，上限 8 是代码常量；第 4 行仍等完整结果再定，第 5、6 行不做。实现在 PR #54（`src/onepass.ts`），并同步到 PR #59。下面"开工前要定的事"第 1 条的评测照常跑完，作为合并前的验收数据；话题开关仍默认关闭，打不打开另由用户定。原 CANDIDATE 文字保留如下。依据见 [评测 12](../eval/12-recall-misses.md)。一步式沉淀本身（`src/onepass.ts`、话题结束触发）已随 PR #54（`012a971`）、#59（`25c761f`）合并，文档随 PR #58 合并；话题开关仍默认关闭。

**问题**：拿原窗口重抽，用户标"有用 / 部分有用"的 26 条只留下一半左右（第 7、11 篇）。逐条查下来，20 条被漏过的条目里 15 条是"没挑出来"：同一模型按同一套标准单独问时会记，正常跑时没输出。一步式每窗口平均不到 2 条（原抽取器 4.6 条），上限 5 条几乎从没碰到；从工具输出里观察到的坑一步式 0/5。标准不让记的只有 4 条，且 3 条是"部分有用"、对应有意的排除项。

**修法排序**（收益 / 复杂度，越靠前越先做）：

| # | 修法 | 对症的漏检 | 复杂度 | 建议 |
|---|---|---|---|---|
| 1 | 去掉提示词里"宁缺毋滥 / 大多数会话没东西"的偏置，改成"漏记和错记一样有代价；长会话常有好几条合格的，不要只给最显眼的一两条；没有合格的照样给空" | 没挑出来（15/20） | 只改提示词几句 | 先做 |
| 2 | 任务说明里加"先逐类过一遍"清单：用户对干活方式的要求（含派活提示里的通用方法）、设计决定和理由、**工具输出里的失败和意外**（含环境、分支、构建来源、宿主差异这类排查陷阱）、用户机器和环境的具体事实 | 坑和观察到的失败（B 0/5）、一个窗口多条只给一条 | 只改提示词一段 | 和 1 一起做 |
| 3 | 每窗口上限 5 → 8（代码常量，不加配置键，守 §2.2） | 防止 1、2 生效后被上限截断 | 改一个常量 | 和 1、2 一起做 |
| 4 | 若 1–3 跑完仍漏得多：同一次调用里先在草稿字段按类列出所有候选，再逐条按标准取舍（仍是一个模型、一次调用） | 没挑出来 | 改输出格式和解析，中 | 等 1–3 的完整结果再定 |
| 5 | 放宽《好记忆的标准》 | 标准不让记（4/20，3 条是部分有用） | 改用户定过的标准文字（v4 标准，2026-10-14 用户定） | **不做**：对应的是有意的排除项（凭据保管套话、修好就不再成立的具体缺陷、通用常识）。唯一可议的 80099904（分支/构建来源排查陷阱）由修法 2 的清单覆盖 |
| 6 | 换切窗口方式、再加一层审稿或第二遍抽取 | — | 新增层或调用 | **不做**：第 11 篇话题窗口不更好、调用多 70%；第 7 篇两步式不如一步式；漏检不是判断不准 |

**修法 1–3 的试跑（V1，提示词版本 eea066fc04d0）**：《好记忆的标准》和判断要点一字不改，只替换上面三处。astra max 原窗口重跑，两次因 Codex 额度用完中断，跑完 22/38 个窗口（24 条可比标签）：有用留下 9/10（现提示词 5/10），有用类留下 10/14（现 6/14），没用挡掉 8/10（现 10/10），总对 18/24（现 16/24）；补回的 4 条里 3 条是坑，没有现提示词留下而 V1 漏掉的；覆盖原抽取器候选 45/105（现 24/105）；每窗口产出 4.4 条 vs 1.5 条、耗时约 1.9 倍；多出来的 62 条新产出执行者读过 50 条合格、12 条存疑、没有明显不该记的。剩下 15 个窗口 astra 额度用完，改用火山 deepseek-v4-pro（max）同模型跑现提示词和 V1 两遍（17 条可比标签）：有用留下 4/7（现 2/7），有用类 5/12（现 2/12），没用挡掉 4/5（现 5/5），总对 9/17（现 7/17），坑 1/5（现 0/5）；每窗口产出 2.9 条 vs 1.3 条、耗时约 1.3 倍；26 条新产出 20 条合格、6 条存疑、0 条不该记。两组合计（混模型，仅供参考）：有用 13/17 对 7/17，没用挡掉 12/15 对 15/15，总对 27/41 对 23/41，坑 4/10 对 0/10，没有一条现提示词留下而 V1 漏掉。见评测 12。

**开工前要定的事（GATE）**：
1. 跑完剩下 27 个窗口（astra，等 Codex 额度恢复；不用 Claude），并按 §8.6 的设计用宿主子模型（Claude Code 是 Haiku 5.5）再跑一轮——后者要花 Claude 额度，由用户决定。
2. 接受的代价：产出约翻倍、每窗口耗时约翻倍、没用条目可能多进一些（都是未确认、可按批撤销）。是否接受由用户定。
3. 验收口径建议：有用类留下率明显高于现提示词（第 7 篇 B 13/26、第 11 篇 L 11/26），没用挡掉率不低于 14/16。

### 8.8 去掉候选区：状态和可信程度分开（**已批准**，用户 2026-10-22 15:03 新加坡时间说"直接开始实现"；改动 §21 2026-10-15 那条 LOCKED 规矩）

**问题（证据取自正式库，只读查询，2026-10-22）**

- 2026-10-15 起，`ab work` 自动抽取和 agent 不带 `--confirmed` 的 `ab remember` 都写成候选（`candidate`），要等 `ab curate --apply` 转正。`ab curate` 没有排程，`ab work`、hook、launchd 都不调它，本机也没有 `review.json`，跑了也会直接退出。
- 结果：候选 62 条（自动抽取 60 条、agent 自记 2 条），从 10-15 13:58 到 10-22 14:35 一条没动过；库里 `curate` 事件 0 条；10-15 以后自动抽取直接进正式库的 0 条。
- 搜索（`store.ts` 三处 `state !== "active"`）和每轮召回（`recall.ts` 只取 active）都看不到候选。10-15 以前抽取的未确认条目照常能搜到、能进召回，以后的看不到。能不能看到按日期分，不按质量分。
- 真实案例：用户问"阿里云 sls mcp 权限登录用什么命令"，答案在 [35670cf8] 的"为什么"里（"用户用 aliyun configure --mode OAuth 登录"）。"为什么"本来就参与检索，只是这条是候选，搜索和召回都不返回。
- 现成评测：第 6 篇里效果最好的审稿配置丢掉没用条目 58%～67%，有用的留下 77%～90%，审稿本身还会误删一到两成有用条目。第 7、11、12 篇的短板都在抽取漏东西，不在噪音多。

**决定（方案 B）**

- `state` 只表示还在不在用：`active | archived | superseded`。去掉 `candidate`。
- 可信程度单独看：`trustOf(p)` 返回 `user | code | corroboration | unconfirmed`，由 `confirmed` / `confirmed_by` 推出，不另存字段。看板的"用户确认 / 代码核验 / 跨会话印证 / 未确认"四类就是它。
- 转正只有原来三条路（§8.4、§9.4 不变）：用户 `ab confirm` 或 `ab correct --confirmed`；`ab work --sweep` 按代码核验；跨会话印证。审稿不再是转正的路。
- 未确认条目进每轮召回的规矩不变（§21 2026-10-14 放宽 D3）：坑、规则、决定，没有冲突、没有待确认纠正、关系已判定、与代码相符、本身不是纠正；每轮最多 1 条、标"未确认"、排在已确认之后。子代理仍按 D3 原规矩，只放有用户原话的规则或决定。
- 搜索：有效条目全部能搜到，未确认的带"[未确认]"标记。

**模块**

- 新增 `src/visibility.ts`：`trustOf(p)`、`searchable(p)`、`recallable(p, worker)`、`isConfirmedCorrection(p)`、`RECALL_KINDS`。搜索、近邻、每轮召回都只调这里，原来 `l2.ts` 的 `recallableUnconfirmed` 和 `recall.ts` 的 `perTurnUnconfirmed` 合成 `recallable` 一个函数，用 `worker` 区分。
- `store.ts` 导出 `indexText`（正文 + 为什么），召回的字面通道复用它，不再自己拼。
- 全文索引加 `index_version`。投影规则变了（旧索引里候选行的 state 是 `candidate`），版本不对就整表重建，升级后不用等下一次写库就能搜到。
- "场景"（trigger）进检索：**不在这次范围内**。它会改每条的向量哈希，全库要重新算一遍向量；这次的案例靠"为什么"已经能搜到。以后有漏召回的证据再单独做。

**删掉的**

- `Proposition` 的 `candidate`、`staged`、`curated` 三个字段，`fold` 里的 `stagedBeforePromote`，以及 stage、curate 两段投影分支。旧的 `stage` / `curate` 事件照常重放，但不改状态；旧 `remember` 事件里的 `candidate: true` 投影时忽略。
- `AB_STAGING` 开关、`WorkDeps.staging` 和 `admit` 里的候选分支（重复条目照常给目标追加来源、触发跨会话印证）。
- `ab stage`、`ab audit agent-remember`、`ab remember --direct`。
- `ab status` 的"候选区"一行，`ab get` / 关联行 / 看板里的"候选"标记。

**`ab curate` 的去留**：保留，改成可选的"建议归档"工具。审的范围从"候选"改成"未确认的有效条目"。结论是"留下"时不写状态事件（条目本来就有效），只在认定是干活偏好时打 guidance；"丢弃 / 改写 / 并入"照旧归档，`--undo` 照旧能撤。仍然只手动跑、默认 dry-run。不删它的理由：`ab setup` 的审稿人配置、`scripts/curate-eval.ts` 和第 6 篇评测都靠它，删掉要连带改一大片，而它不再挡任何东西。已知缺口：它不记"审过哪些"，每次手动跑都会从最早的未确认条目开始审，用 `--limit` 控制量。

**迁移**

- 不写任何迁移事件。新投影直接忽略候选标记和 stage/curate 事件，62 条（含 agent 自记的 2 条）升级后就是有效的未确认条目。重放几遍结果都一样，回退到旧代码也还是原来的候选。
- 升级前先备份 `~/.agentbrain/store.db`（`sqlite3 store.db ".backup <备份路径>"`）。
- 对照报告（只读）：`AB_HOME=<库或副本> node scripts/staging-report.ts`，列出旧候选在新代码下的状态、可信程度、能不能进召回。

**LOCKED 规矩的改动**

- 旧（§21 2026-10-15）："现在不带 `--confirmed` 的 `ab remember` 写进候选区（`candidate`），等审稿；`--confirmed`（用户明确要记）照旧直接生效；新增 `--direct` 只给人工迁移数据用……`AB_STAGING=off` 同样回到旧行为。"
- 新："不带 `--confirmed` 的 `ab remember` 和 `ab work` 自动抽取都直接写进正式库，状态未确认、带'未确认'标记，能搜到，没争议的坑、规则、决定按 §21 2026-10-14 的规矩进每轮召回。`--confirmed`（用户明确要记）照旧直接生效且已确认。没有候选区，也没有 `--direct` 和 `AB_STAGING`。"

**验收（都有测试，`src/visibility.test.ts`、`src/cli.test.ts`）**

1. 旧版本写成候选的条目，新代码下是有效的未确认条目；"aliyun configure OAuth 登录"能搜到它。
2. 同一条在相关提问时被每轮召回，标"（未确认）"。
3. 旧的 stage / curate 事件重放后条目仍有效；归档再恢复也是有效。
4. 可信程度四类分得开；有争议的未确认条目能搜到，但不进召回。
5. agent 不带 `--confirmed` 的 `ab remember`：输出"已记住"，搜索标"[未确认]"，不进 brief，用户 confirm 后进 brief；`ab stage` 已不存在。
6. 旧版本留下的全文索引在升级后自动重建。
7. 真实库副本上：`ab search "阿里云 sls mcp 权限登录用什么命令"` 第 1 条是 35670cf8；`ab recall "aliyun configure --mode OAuth 登录后 sls mcp 权限过期"` 注入 35670cf8。旧代码同样两条命令都没有它。
8. 不再需要"候选卡住"的告警：没有这一档，也就不会卡。

**风险和怎么量**

- 约 60 条没审过的条目进入召回候选池，噪音可能多一点。这和 10-15 以前用了很久的那档一样，每轮最多 1 条未确认、排在后面。
- 怎么量（小评测，记到 `docs/eval/18-*.md`）：从这 62 条的来源会话和近期提问里挑约 20 个提问，旧代码和新代码各跑一遍 `ab recall`，看新注入的未确认条目里有几条对题、有几条挤掉了原来对题的条目。同时看一周的 `prop_usage`，统计这批条目被注入几次、是否被 `ab-used` 引用过（看板上线后）。挤掉对题条目的比例明显上升，就把未确认的召回门槛收紧（比如只放有用户原话的），不回到候选区。

**同时修的：额度用完后能不能自己接着做**

- 抽取（默认两步式）：429 原来每次都算一次失败尝试，4 次（约 2.6 小时）后窗口判成失败、这段内容永久跳过。现在 429 不算尝试，按 Retry-After 延后，额度恢复后接着抽（和 §8.6 话题模式的做法一致）。
- embedding：错误正文里有 429 / quota / rate limit 的归成限流，同样延后不算失败；其他 embedding 故障照旧按退避用完转失败。没算上向量的条目在下一次同步（搜索、记忆写入、`ab work`）时补上，原本就是这样，这次加了测试。
- 代码核验：原来出错（含 429）后，同一 HEAD 24 小时内不再重试；现在出错的照样在下次重试。撞上 429 时本轮停下，不再给后面的条目逐条发请求。
- hook 拉起的单会话 `ab work` 顺带重试别的会话里已到期的延后窗口。原来只有 launchd 的 `--sweep` 会去碰别的会话，launchd 没开时这些窗口没有机会重跑。代码核验仍只在 `--sweep` 里跑，launchd 不开就不会跑，这一点没改。

### 8.9 历史会话严格抽取（CANDIDATE，2026-10-15，10-22 复核）

现状：§21 的 2026-10-12 质量修正已区分历史会话与漏登记，但没有按来源收紧抽取标准。`via` 仍有 hook、scan、backfill、manual 四值（`src/intake.ts:29-30`）。扫描按首次 hook 时间与会话开始时间区分 scan/backfill（`src/work.ts:248-260`）；两者目前只共同参与积压预算（`src/work.ts:640`），没有严格提示词。

只对开始处理窗口时登记为 `via=backfill` 的会话使用严格版。hook、scan、manual 沿用普通版。backfill 是安装 hook 前的历史，批量导入容易把旧的临时推断一起收进来；scan 只是近期会话漏登记，不能因 hook 漏报就降低它的召回。来源未知或开始时间不足时，沿用当前登记结果，不另猜历史身份。hook 后来触达旧会话会把 via 改为 hook（`src/intake.ts:89-94`），后续新处理窗口随新值用普通版；已完成窗口不重抽。

在当时启用的抽取系统提示词末尾追加以下要求。两步式、一步式以及后续替代提示词都必须适用，不能只修改 `extract.ts`。它只收紧抽取准入，不新增审稿步骤。

```text
这是历史会话回填。以下收紧规则只适用于本次回填，优先于普通版的宽松准入。
拿不准就不记。只收用户本人原话支撑的 rule 或 decision。
basis 必须是 user_directive 或 user_confirmed，并提供可定位、可逐字核对的用户引文。
保留具体的适用场景和当时的理由。一次性任务授权、临时状态、已经撤回的旧说法不记。
父 agent 的派活提示、模型复述、工具输出都不能冒充用户确认。
不收 pitfall 或 note，不把 agent_inference 换个 basis 混入。
没有满足全部要求的条目就返回空结果。
```

落层：新增准入条件在确定性校验中再次执行，不能只靠提示词。只允许 rule/decision、两个 user basis，并核验至少一处用户引文。继续使用去噪、逐字核对、写 L1 前脱敏和普通价值标准；不把历史回填等同于用户当前确认。合格产出沿当前路径写 L1，带 §8.10 的严格版版本。若当前路径有候选区就仍进候选区；若走一步式则仍是未确认。L2 的确认、关系与发布门不变，L3 的索引和召回资格不变。拒绝原因与数量沿现有窗口回执显示在 `ab work`、`ab doctor`，不另写被拒正文到 L1。`ab get` 看提示词版本与依据，不新增严格标记。

前置缺口必须先关闭：一步式当前只有 new/merge 输出，没有 basis 与引文，写库一律 `agent_inference`、`evidence: []`（`src/onepass.ts:49`、`src/work.ts:1000-1003`，§8.6 第 12 点）。严格版必须扩展输出以提供真实用户依据和引文，再做逐字校验。未补齐时不能把所有历史候选静默丢掉后宣称支持，也不能改造 basis 冒充原话。普通一步式的行为不在本条授权内。

与已批准方向的张力：§8.7 为提高召回刚去掉"宁缺毋滥"偏置。本条仅对历史回填另组严格版，不把那段偏置塞回普通版，不改变已钉住的 V1 普通提示词。严格版需要独立评测。代价是历史中的真实坑与环境事实也会漏掉，本候选接受该损失，用户以后仍可显式记下。

不做全局收紧，不按年龄扫描并重写已有记忆，不自动清理旧产出，不给 scan 加严，不照搬腾讯的 Skill 分类、评分或写文件工具。

验收：固定同一窗口分别标 hook、scan、backfill、manual。三个普通来源的系统提示词和现有输出规则不变，只有 backfill 使用严格版。各抽 10 个历史与近期窗口，同一模型比较普通版和严格版，由人工逐条核对产出及原话。严格版产出必须 100% 符合种类、basis、逐字引文要求，零父 agent 冒充用户，零一次性授权。预先人工标出的合格历史规则与决定至少保留 90%；合格样本不足 10 条时继续补样，不用空产出冒充通过。分别记录被排除的坑与事实数量，交用户确认代价。重跑、恢复与严格 hash 的检查复用 §8.10，不改普通窗口幂等键。

---

### 8.10 模型产出的提示词版本（已授权，2026-10-26 用户授权）

现状：已在 §8.6 第 7、12 点覆盖一步式抽取的版本记录。本节只补齐其他模型写入路径和读取展示，不把已有实现重新标成待实现。`RememberBody.topic.prompt_version` 已存在（`src/l2.ts:87-105`），写入点是 `src/work.ts:994-1028`。普通抽取的 `remember` 与去重追加的 `evidence` 没有模型版本记录（`src/work.ts:501-548`）；`VerifyBody` 与 `RelateBody` 只记 `model`（`src/l2.ts:118-123`、`src/l2.ts:155-160`），代码核验的系统提示词在 `src/codeverify.ts:166`。10-13 的 190 条抽 30 条、严格精确率约 83% 是混合历史结果，不能事后按提示词分组。

本次改动如下，适用于当前启用的抽取器，不绑定两步式或一步式。只记录，不改抽取、关系判定、核验或准入行为。

范围例外（2026-10-26 主会话决定）：`ab curate --apply`（`src/curate.ts:134`）改写产生的 `remember` 本次不带 `model` / `prompt_version`，`ab get` 显示“未记录”。改写可能来自多位审稿人一致结论、主审或仲裁，记录哪个模型、哪个提示词需要先设计，留到以后单独授权。本单只覆盖普通抽取、一步式、重复追加证据、关系判定和代码核验五条链路。

- 模型写入的 `remember`、`evidence`、`relate`、`verify` 事件体统一带 `model` 与 `prompt_version`。这两个字段是新增的事件元数据，不是新的事件类型。`evidence` 也要带，因为普通抽取判重复时可能只写它、不写新记忆。关系判定供 work 与 Pensieve 导入共用（`src/relate.ts:95-123`），两处都覆盖。确定性派生的 archive、confirm 不冒充新的模型判断，通过同次来源结论追踪。
- `prompt_version` 取实际发送的系统提示词全文，以 UTF-8 计算 SHA-256，取十六进制前 12 位。不 trim、不去空白、不混入会话或项目正文。模块加载时对当前系统提示词计算一次。§8.9 的严格版尚未授权，本次不组装也不启用。将来获授权后，严格追加段也在系统提示词内，hash 自然不同，不另加严格模式布尔字段，也不手填版本号。
- 当前一步式的 hash 口径并不完全符合这条建议。`src/topic.ts:61` 算的是 `ONE_PASS_SYSTEM + 换行 + ONE_PASS_WORKER_NOTE`，而 worker note 在 user 消息里（`src/onepass.ts:52-59`）。本次实现改为仅 hash 实发的 system 内容。旧 hash 仍按旧口径解释，不能重新计算后覆盖。新事件只写统一顶层字段，不再重复写 `topic.prompt_version`；旧事件继续读取原字段。这是读旧格式，不是迁移期双写门。

落层：L1 与模型结论原子写入元数据，不能只记在工作报告里。L2 确定性保留每次产出对应的事件 id、类型、模型与版本，不能用最新核验版本覆盖原抽取版本。旧事件缺字段时显示"未记录"；已有 `topic.prompt_version` 原样可读。不回填、不迁移、不自动重抽。L3 如缓存这些展示数据，只从 L1/L2 重建，不从当前提示词猜旧版本。

`ab get` 当前不显示版本（`src/cli.ts:508-550`）。候选显示如下，值均为示意，不是本次实测版本：

```text
模型产出记录:
  [事件 id] 抽取: model-a，提示词版本 0123456789ab
  [事件 id] 关系判定: model-b，提示词版本 abcdef012345
  [事件 id] 代码核验: model-b，提示词版本 未记录
```

按版本统计仍待定。建议先只做 `ab get`，需要比较抽样质量时再加近 7 天按"产出类型、模型、版本"分组的事件数，不冒称精确率。当前 `ab status` 和 `ab doctor` 是同一输出入口（`src/cli.ts:1336`），沉淀统计也共用 `src/status.ts:42-60`。若用户批准统计，两者一起显示，不另拆一套报表；`status --line` 不加字段。

不做提示词全文归档、手工版本号、旧事件迁移、自动提示词优化。12 位 hash 用于区分版本，不是秘密校验或真实性证明。§8.6 的现有版本字段保留历史含义，改变记录口径需随实现评测，不能将旧评测的版本号换成新值。

验收：对普通抽取、一步式、重复追加证据、关系判定、代码核验各产生一条模型结论，逐条核对 L1 与 `ab get` 的模型及版本。相同系统提示词在重启后版本相同；改一个字符或追加严格段就不同；只换会话正文不变。缺字段旧事件显示"未记录"，旧 topic 版本保持原值。删掉 L3 重建后展示一致，L1 行数与内容不变。模型失败或不写 L1 的结果不补造产出事件。

### 8.11 决定记成决策卡、项目知识进抽取、按目标项目归属、搜索带上相关项目（CANDIDATE，2026-10-30）

> 状态：用户 2026-10-30 定"agentbrain 要完全替代 Pensieve：不能只记一句话的规则，项目知识、某个场景下讨论后定的业务和技术决定都要有；图谱靠向量检索代替，检索撑不住再做；我跨项目跨业务，别的项目要能用上"。同日主会话核实后给了 5 条修法，用户选 1–4（第 5 条"调大宿主对话保留期"没选）。来龙去脉见 pm `docs/agentbrain/2026-10-30-knowledge-decisions/README.md`。

#### 8.11.1 现状（2026-10-30 核实）

1. **决定还原不了当时的背景。**
   - 条目只有 `text`（自动抽取 ≤200 字，`src/extract.ts:12`）、`why`、一句来源摘要和原对话指针。用户原话在抽取时已逐字核对、过滤密钥（`src/extract.ts:462-489`），但只存 `quote_sha256`（`src/l2.ts:44-48`），原文丢掉。
   - 原对话文件归宿主管：库里引用的 306 个对话文件已缺 45 个（Codex 10-12 那批 29 个全缺）；Claude Code 默认 30 天清理。缺文件时 `ab get --expand` 只剩"来源不可用"。
   - 抽取提示词要求决定也写成"一句可照着做的原则（不写本次/日期/内部 id）"（`src/onepass.ts` 任务段、`src/extract.ts:338`），具体定了什么丢失。例：`86d0583d` 当时定的是"pi-ops main 只要求 evidence-gate，final 改成只显示、不拦合并"，库里记成"先统计它拦下过什么……再决定停用还是降级"，范围还落成全局。
   - 否掉了哪些方案、为什么否，没有地方放。
2. **项目知识没有来源。** 抽取只许 rule / decision / pitfall（`src/onepass.ts:87`、`src/extract.ts:338`）；库里的 note 全部来自 Pensieve 导入或手记。10-12 到 10-30 自动抽取：坑 718、规则 309、决定 90、知识 0。Pensieve 导入的正文和理由各截到 400 字（`src/pensieve.ts:14-15`），原 md 平均约 6KB。
3. **归属只能是会话所在目录的项目。** `project_id` 由会话目录决定（`src/work.ts:242,257`），候选只能选 `project | global`（`src/extract.ts:332`）。pm 主会话讨论别的仓库的事，只能落成 pm 或全局。
4. **跨项目搜得准但默认不搜。** pm 目录里 `ab search` 默认全库（`src/cli.ts:505-508`），项目目录里只搜本项目 + 全局。`--all` 的语义检索可用：换说法问"保险理赔率之类的比值口径应该怎么落库"命中 ai-data 的 `2018b871`。但模型很少主动查（§11.9.4 评测），更不会加 `--all`。

#### 8.11.2 数据

- **证据**：`EvidenceRef` 加 `quote?: string`、`said_at?: string`。`quote` 是抽取逐字核对、过滤密钥之后实际算哈希的那段（`src/extract.ts:471-491` 的 `kept`），长度沿用现有校验（`src/extract.ts:14-15`，不提高下限，"按你的方案来"这类短认可照样能存）；`said_at` 是这段原话所在轮的时间，没有就缺省，显示为"时间未知"，不拿条目的 `said_at` 代替。不变量：`sha256(quote) === quote_sha256`。每条候选最多 6 条证据：超过只取前 6 条并记 `evidence_truncated`，引用被截掉证据的方案在下面按整项丢掉，不整条丢（2026-11-02）。
- **追加证据也完整保存**：`ExtraSource` 的 `quote_sha256: string[]` 换成 `evidence: EvidenceRef[]`（`src/l2.ts:179-185,362-370`）。旧事件只有哈希，投影出不带 `quote` 的引用。这是同一份证据只留一个来源，不另存一份。
- **`RememberBody.body?: string`**：详情正文，decision、note、pitfall 能带（Pensieve knowledge 有一部分映射成 pitfall，`src/pensieve.ts:253`），rule 不能带（规则必须一行说清）。上限 `BODY_MAX_CHARS = 40000`（data-asset 的 137 篇 Pensieve 文档中位 3957 字、p90 8010、最长 35179，全部放得下，不截断）。抽取侧另有 5000 字上限（`src/extract.ts` 的 `MAX_BODY_CHARS`），超出只丢正文并记 `body_dropped`，存储上限仍是 40000。`text` 仍是一行标题。显示和向量输入另行截短，不影响存储。
- **`RememberBody.alternatives?: { option: string; rejected_because: string; evidence: number }[]`**：只有 decision 能带，≤5 项，文字各 ≤200 字。`evidence` 是本条 `evidence[]` 的下标，指向支撑"为什么否掉"的那段原话；`null` 或非整数当作没有引用，保留方案；负数、越界或指向被删证据的整项丢掉并记 `alternatives_dropped`，不悄悄丢。
- 背景仍放 `why`，不另加 context 字段；归属仍是事件的 `project_id`。
- **补详情事件 `detail`**：`{ body?, alternatives? }`，只给已有条目补上原来没有的详情，不换 id、不改确认状态和关联。现在只有 Pensieve 重导用它（见 8.11.5）。投影时若条目已有 body，`detail` 不覆盖（fail-closed，计 orphans 同类诊断）。
- **投影**：`Proposition.body: string | null`、`alternatives: …[]`，旧数据为 `null` / `[]`。
- **向量文本**：从 `text + why`（`src/store.ts:144`）改为 `text + why + body`，超过向量模型输入上限时截 body。body 改变要重算向量。全文索引和字面召回用 `text + why + 完整 body`，只有向量输入截短；`text_hash` 只按向量那份算，正文超出上限的部分变化不触发重算（`src/store.ts` 的 `indexText` / `vectorText` / `vectorTextOf`）。
- **同一个脱敏边界**：`text`、`why`、`body`、`alternatives`、`quote` 在写入 L1 之前统一过 `hasSecret`（含代码块；Pensieve 旧映射先删代码块再检查 text、why，看不到代码块里的密钥，`src/pensieve.ts:73-80,186-190`）。命中时：CLI 报错退出 1；抽取丢掉该字段并记 flag，不丢整条；导入不写这个字段，并在报告里列出。手写、导入、抽取三条入口都过这一处。body 发往 DashScope 算向量，接收方和数据类别（记忆正文）与 §13.3 v2.6 条一致；实际出境的内容会变多（细节和代码片段），这一点在 §13.3 注明。

#### 8.11.3 抽取

**本节只改普通窗口抽取（`extract.ts`）。** 话题一步式（`onepass.ts`，§8.6）现在默认关闭（本机 `extract.json` 没有 `topic: true`）。它既不输出证据，merge 也不写 L1（`src/onepass.ts:61-100`、`src/work.ts:987-990`）。在它也按本节输出证据、merge 改成写可撤销的 `evidence` 事件之前，不得打开；这一步另立任务。

1. **kind 增加 note（知识）**：模块职责和边界、某个功能落在哪几个文件、调用链、业务口径、外部系统的事实。`text` 是标题，`body` 写清楚。只记"要读好几处才拼得出来"的结论，一次 grep 就能找到的不记。
   - 证据：正常工具输出在抽取前已被替换成"工具输出 N 字，已省略"（`src/transcript.ts:113-119`），所以 note 的证据是助手自己在会话里写出这段结论的原话（`basis=agent_inference`，role 为 assistant）。不为它保留工具输出。
   - 核验：note 照旧进代码核验（`CODE_VERIFIABLE` 已含 note，`src/work.ts:50`），但核验输入要加上 `body`（现在只送 text、trigger、why，`src/codeverify.ts:166-198`）。核验员对 body 里每个可核对的断言给证据；只要有一处 contradicted，整条标 stale；全部可核对断言都 verified 才算代码转正；说的是代码之外的事（外部系统）就是 `not_verifiable`，保持未确认。
2. **decision 改写法**：
   - `text` 写具体定了什么，点名对象（项目、模块、接口、配置），可以写日期，不写内部 id；
   - `why` 写当时的问题和理由；
   - 讨论过别的方案就填 `alternatives`，每项指向支撑它的原话；
   - 细节（数字、范围、回滚办法）写 `body`；
   - 同一段讨论里能推广到别处的教训，合格的话另出一条 rule，不把决定本身改写成原则。
   - `basis=user_confirmed` 的决定除了用户认可的原话，还要至少一段助手提出该方案的原话，否则"按你的方案来"说明不了认可的是什么。
   - rule 和 pitfall 的写法不变；《好记忆的标准》里"一句话、不写日期"的要求（`src/standard.ts:60`）对 decision 注明例外。
3. **原话存原文**：证据校验通过后把 `kept` 和所在轮时间写进 `quote` / `said_at`。duplicate 时追加的 `evidence` 事件同样带上。
4. **按目标项目归属**：
   - 候选的 `scope` 改成 `project`：已登记的项目名或 `global`，缺省是会话所在项目。提示词附已登记项目清单（名字 + `~` 形式的仓库路径，与 `src/sanitize.ts` 处理后的窗口同一口径）。
   - 指向非会话项目时，候选必须给 `project_anchor`：本窗口或前置背景里的一轮，其中出现该项目名或仓库路径（同口径比较）。前置背景只用来解析"这个仓库"这类指代，不能当结论的证据。
   - 名字未登记、没给 `project_anchor` 或那一轮里找不到名字和路径：候选留在会话项目，带 flag `project_unresolved`，搜索和 `ab get` 显示「[归属未定]」，不悄悄当成会话项目的事实。
   - 已知局限：确定性校验只能证明"提到过"，"参考 pi-ops 的做法，别改 pi-ops"这种句子仍可能被模型错归到 pi-ops。`ab get` 显示"会话在 X，抽取判定归属 Y"，方便人工纠正。
5. **归属定下后，关系链按最终项目重算**：
   - 生成前给模型的已有记忆：会话项目 + 全局 + 窗口里出现名字或路径的已登记项目；
   - 候选解析出最终项目后，近邻去重和关系判定都在最终项目 + 全局里做；
   - `admit` 拒绝把候选当成别的项目条目的重复（`src/work.ts:490-527`），这种情况按新条目处理；跨会话印证只在同一项目内发生。
6. **去重看完整内容**：
   - 同窗口候选键从 窗口 + kind + text（`src/extract.ts:519-526`）改为 窗口 + 最终项目 + kind + text + body 哈希 + 方案哈希；没有方案的候选不拼方案段，键与旧口径完全一样，窗口重跑不会多写入库（2026-11-02）；
   - 向量去重用 text + why + body；
   - 关系判定（`src/relate.ts:38-40`）的输入加上 body 和 alternatives，正文有实质差异就不能判 duplicate。输入里的正文只去掉首尾空白，内部换行和缩进保留（比较时算内容），仍按 2000 字截断（2026-11-02）；
   - 第 2 层判 duplicate 时会归档一条：被归档那条带正文或方案、且两边详情不完全一致（完整正文和方案逐项比）时，不归档，改记 `refines`，两条都留着（`ab get` 双向显示关联）；详情完全一致才按 duplicate 归档（2026-11-02）；
   - 第 1 层显式判 duplicate、但详情不同被降级成新条目时，首次写入就标 `unreconciled`；第 2 层给出确定结论才解除，`unsure` 和判定出错都保持未决（2026-11-02）。
7. 每窗口条数上限不变；`body` 不占 `text` 的 200 字。改提示词按 §8.10 自动换版本号。

#### 8.11.4 读

- **`ab get`**：依次显示 text、why、alternatives（每项后面附它引用的原话）、body、全部原话（含追加来源的，带角色和时间）、归属说明，然后是关联和近邻。`--expand` 在原对话还在时照旧展开；不在时，先列库里存的原话，再说明原对话已不可用。
- **`ab search`**：前 8 条全文里，decision / note / 带 body 的 pitfall 显示 body 前 300 字和"`ab get <id>` 看全文"。
- **跨项目段**：
  - 什么时候出：在已登记项目目录里搜索，没给 `--project` / `--all`，结果末尾多一段「其他项目里相近的：」。pm 目录本来就搜全库，不加这一段。
  - 怎么取：候选先限定为其他项目的 searchable 条目，再按与查询的向量相似度排序，取 ≥0.65 的前 3 条，一行一条带项目名，照常记交付。不从全库 top-N 里事后筛。阈值是 `src/store.ts` 的 `CROSS_PROJECT_MIN_SIM = 0.65`，由 `docs/eval/21-cross-project-threshold.md` 的评测定下。
  - 向量不可用：查询向量算不出（degraded）时不出这一段，并在降级提示里说明。候选里有向量还没补齐的条目（`pending>0`，`src/store.ts:491-513`）时，段尾注明"另有 N 条其他项目的记忆还没算向量，可能漏"。
  - 主会话和子代理都能看到这一段（用户 2026-10-30 选 A，见 8.11.8），`ab search` 不加 `--worker` 之类的参数。
- brief 不变。

#### 8.11.5 手写、纠正、整理、导入

- **`ab remember`** 加 `--body-file <文件>` 和可重复的 `--alternative "<方案>::<否掉的原因>"`。手写没有原话可指，`alternatives[].evidence` 缺省。
- **`ab correct`** 也接受这两个参数，**不继承** body 和 alternatives（它们是结论内容，标题改了，详情照搬会自相矛盾）。要沿用旧详情就显式重给。新条目通过已有的纠正关联指向旧条目，旧详情在 `ab get` 里能看到。这样也不会把会话 A 的正文复制进会话 B 的版本，purge A 时不留副本。
- **`ab curate`** 改写和自动合并都只针对没有 body、没有 alternatives 的条目。带详情的条目跳过并写进报告（改写会丢详情；合并会把正文或否掉的方案并丢）。审稿输入仍不带详情（2026-11-02）。
- **Pensieve 重导**：
  - 不靠源文件哈希触发（原文件没变时现在直接算 unchanged，`src/pensieve.ts:253-256`），也不改 `import_ref.sha256` 的含义；
  - 重导时，已导入条目缺 body、源文档有正文的，追加一条 `detail` 事件补上全文（≤40000 字，过脱敏边界），不换 id，确认状态、场景、关联、`inject_log` 历史都留在原条目上，避免"新版本被并入后旧版本复活"（`src/l2.ts:406-418`）；
  - 源文件变了的照旧走现有替代流程，新条目直接带 body；
  - 有文档因密钥或超长没补上 body 时，报告列出，**这些仓库的 `.pensieve/` 不能删**。

#### 8.11.6 验收

1. **单测先红后绿**：
   - 投影：quote、said_at、body、alternatives、`ExtraSource.evidence` 的投影，以及旧数据缺省；
   - 写入口：`detail` 补详情及"已有 body 不覆盖"；各字段的种类限制和长度上限；
   - 脱敏边界：三条入口各有一例，包括 Pensieve 代码块里的密钥；
   - 原话：`quote` 与哈希一致；duplicate 追加的证据带原话；`user_confirmed` 决定缺助手原话被拒；alternatives 下标越界的项被丢；
   - 归属：成功一例；未登记、缺 anchor、anchor 里找不到名字三种情况都退回并带 `project_unresolved`；`admit` 拒绝跨项目重复；跨会话印证只在同项目内发生；
   - 去重：同窗口同标题、不同 body 的两条都保留；
   - note 核验：带 body 送检，body 里一处矛盾就标 stale；
   - 读：`ab get` 显示顺序，以及原对话缺失时列出原话；跨项目段的阈值、最多 3 条、先限定再排序；pm 目录、`--project`、`--all` 不出，degraded 不出，pending 有提示；
   - correct / curate：correct 不继承详情；curate 跳过带详情的条目；
   - Pensieve 重导：只补 body 不换 id，源文件未变也能补上。
2. **抽取评测**：用三段真实会话跑新提示词，人工检查：
   - 素材：本节起因的 pi-ops 门禁讨论、场景标签讨论、一段读代码摸清调用链的会话；
   - 决定写出了具体对象，否掉的方案带了原话；
   - 至少产出一条 note，并且通过代码核验或被正确判为不可核验；
   - pm 会话里讲 pi-ops 的决定落到 pi-ops，或标「归属未定」，不落成 pm。
3. **还原测试**：在隔离库挑 3 条新抽出的决定，删掉对应的原对话文件。只凭 `ab get` 要能答出：当时什么问题、定了什么、否掉了什么、谁说的原话。
4. **跨项目阈值评测**：用于定 0.65 这个阈值，另起一组独立的测试题，不和开发时用的查询重复：
   - 正例：在 data-asset 目录搜"比率指标怎么建模"，跨项目段要出现 ai-data 的 `2018b871`，另外再找 4 个类似的正例；
   - 负例：至少 5 个"术语相同、业务含义不同"的查询，再加 5 个和其他项目完全无关的查询；
   - 报告每个查询出了哪些条目、相似度多少，再据此调阈值。
5. **Pensieve 替代**：在 data-asset 上重导后，对 `.pensieve/knowledge` 里随机 5 篇，`ab get` 的 body 与原文一致（脱敏处除外）。

#### 8.11.7 不做

- 不做图谱：先用向量近邻和现有的补充 / 合并 / 纠正 / 冲突关联；8.11.6 第 4 条评测不过再议。
- 不归档完整对话，也不为 note 保留工具输出（§13.3、§20 不变），只存核对过的短原话。
- 不回填旧条目的原话（旧引文只有哈希，算不回原文）；旧对话文件照样会被宿主清理（用户没选调大保留期）。
- brief 仍不推送项目决定和知识，交付另议。
- 本节不改一步式抽取，改造前它保持关闭（8.11.3 开头）。
- 不做从会话提炼 SOP / Skill（§20，用户 2026-10-15 定）。

#### 8.11.8 已定：子代理也能看到跨项目段（用户 2026-10-30）

§6.3 原本不让子代理默认读跨项目记忆。主会话给了两个选项：A 都给；B 只给主会话（`ab search --worker`，没带的子代理仍能看到）。用户选 A，理由是知识本来就是给自己用的，而大部分代码是子代理写的。代价是其他项目（包括 ai-data 这类公司项目）的条目会进到子代理用的第三方模型，用户已知情。§6.3 的默认值在 `ab search` 跨项目段上按此放开，`ab brief --worker` 的范围不变。

### 8.12 少记没用的：抽取改用同一份标准，不再假设后面有人审（**切片 1 已授权**，用户 2026-11-05 说"同意，开始切片 1"，同意标注、§8.12.5 的上线条件和不做自动归档；切片 2、3 另行授权）

**结论**：线上抽取提示词有两处跟现状对不上：还说"后面有审稿人，拿不准可以写"，也没用审稿在用的《好记忆的标准》。先统一这两处，用逐条对比和新标注验证。不按模型标记删条目，不限子代理条数，不做自动归档。

#### 8.12.1 现状（2026-11-05 只读查询，事件水位 4136）

| 指标 | 数字 |
|---|---|
| 活跃条目 | 1693，其中自动抽取 1386 |
| 近 7 天提议 | 887（滚动 7 天） |
| 后台工作用量 | 今日约 200 万 token，含抽取、关系判定和代码核验，不全是抽取 |
| 自动抽取条目被引用过 | 10-20 前写入 15/299；10-26 起写入 47/1026 |
| 按证据类型（活跃，引用/总数） | 用户原话 32/319，用户认可 3/30，工具报错 14/475，助手推断 17/562 |
| 按宿主（活跃，引用/总数） | claude 70/479，codex 9/180，pi 30/850。宿主不等于主/子会话 |
| 带 `phase` / `findable=true` | 48 / 37，有 2 条重叠 |
| 审稿试跑 40 条（11-04，未写库） | 合并 18、改写 14、丢弃 8、原样留下 0 |

局限：引用记录 10-29 起才稳定，10-26 后写入的条目还太新，引用率只能当参考。这些数字说明"量大、用得少"，不能证明哪些条目没用。

#### 8.12.2 根因

1. **提示词还以为有审稿。** `src/extract.ts:288,304` 写"之后有独立的审稿人""拿不准时可以写""审稿人通常会丢"。§8.8 后 `ab curate` 只手动跑，这些条目直接生效。
2. **两份标准。** `standard.ts` 的《好记忆的标准》只给 `onepass.ts` 和 `review.ts` 用；`extract.ts` 有自己一份旧写法（第 293-296、323 行）。审稿按新标准判，抽取按旧标准写，所以试跑 40 条没有一条能原样留下。

一步式（`onepass.ts`）默认关闭（§8.11.3），本节不动。

#### 8.12.3 方案

**① 提示词（`extract.ts`，走 §8.10 的版本号）**

- 价值标准改为直接引用 `GOOD_MEMORY_STANDARD`，删掉 `extract.ts` 里重复的那份。输出格式、证据、relation 等合同不动。
- 删掉审稿人相关说法，改成"这里写的直接进库，不合标准的就不写"。
- 明确保护三类：用户说的长期要求、具体设计决定和背景、只在本项目成立的经验。"能迁移"指换个任务、换一天，不是换个项目。

**② 不加硬拦截**

- `phase`、`findable` 是模型判断，不是事实。`42e571e8`（用户指定模型优先级）被标 `findable=true`，`c40af79e`（标签接口的设计决定）被标 `phase`，都是该留的。
- 这两个字段继续记录，只用于观察。
- 子代理窗口不设更低上限。`c66d4f13` 这类有用的坑是某窗口的第三条，上限 2 会丢掉它。如果 ①上线后子代理产出仍然过多，再单独实验。

**③ 看得见（`ab status` 加两行）**

- 近 7 天每天新增，分主/子会话。
- 写入满 30 天的条目被引用比例，按证据类型和主/子会话分开。

**④ 存量（切片 3，另行授权）**

- 现在的 `ab curate --apply --limit` 不能用：只按未确认取最早一批（`src/cli.ts:1443-1444`），没有引用过滤；`discard` 还在带正文的保护之前（`src/review.ts:507`）。
- 要加两处小改动：`ab curate --ids <文件>` 只审指定条目；有引用或带正文的条目不进清单，`discard` 也跳过。
- 流程：先出固定的 id 和动作清单，用户抽查后再执行。第 6 篇测过审稿会误删约两成有用条目（留下 38/48），所以不按标记批量归档，也不一次全清。

#### 8.12.4 不做

| 不做 | 为什么 |
|---|---|
| 未使用 30 天自动归档 | §10.3 LOCKED、§9.4.1 不设自动过期；引用数据才一周。等 ③ 有两个月数据，用户想要再重开裁决 |
| 按 `phase` / `findable` 丢弃或清理 | 见 ② |
| 用产量下降当上线条件 | 把有用的一起删也能达标 |
| 恢复候选区或常驻审稿 | §8.8 刚因"没人审、卡死、搜不到"去掉；常驻审稿等于 §10.3 的 archive recommendation |
| 坑要出现两次才算数 | 当前有效的跨会话印证只有 7 条，会挡掉几乎所有坑，违背场景①"踩过的坑不再踩" |
| 现在改搜索排序 | 还没有证据。先用第 18 篇的问题改走 `ab search` 测一次（原脚本走 `recall --hook`，该入口已不检索） |

#### 8.12.5 验证和上线门槛

**环境**：正式库副本，同时隔离 `HOME`、`AB_HOME`、`AB_REGISTRY`。新旧提示词用同一模型、同样的窗口、近邻和上下文。

**数据**

- 旧标注：第 12 篇的 38 个窗口、42 条。note 为 0，且已不算干净的留出集，只当回归参考。
- 新标注：从近期主、子会话窗口取约 40 条，覆盖规则、决定、坑、note，由用户标有用/没用，开跑前存盘。

**上线条件（建议，用户定）**

1. 逐条列出"旧版有、新版没有"和"新版才有"，主会话逐条看。总数不互相抵消。
2. 用户标有用的规则和决定，一条都不能丢；丢了要逐条说明并由用户放行。
3. 用户标有用的坑和 note，丢失不超过 1 成。
4. 用户标没用的条目，挡掉数要明显多于旧版。这条不过就没必要上线。
5. 产量只观察，不作条件。

**回退**：回退整个提交。已处理的窗口不会自动重抽（空产出也记完成，`src/work.ts:816-822`），所以按 `prompt_version` 列出受影响窗口，用户授权后定向重放（`ab work --session <id> --redo`）。代码回退和补回漏记分开说。

**单元测试**：提示词含 `GOOD_MEMORY_STANDARD`、不含"审稿人"；版本号变化；`phase`、`findable` 仍然留下。

#### 8.12.6 切片和要定的事

| 切片 | 内容 | 动正式库 |
|---|---|---|
| 1 | ①写好，只回放出对比报告，附搜索测量 | 否 |
| 2 | 过门槛后上线，加 ③ | 新写入变化 |
| 3 | ④ 存量清理 | 是，逐批授权 |

要用户定：① 是否愿意标约 40 条；② 上线条件是否照建议；③ 是否同意不做自动归档。

### 8.13 冲突看得清、能处理（2026-11-09，用户同日授权最简版实现）

**结论**：已判出的冲突要能被看清、被处理，不加新服务、新事件、新命令、新表。只改两处：冲突按"对"记录，不再互相覆盖；search、get、brief、status 把冲突和"待确认纠正"分开写清楚。处理冲突用现有命令。

#### 8.13.1 现状（2026-11-09 只读，事件水位 4832）

| 事实 | 依据 |
|---|---|
| 当前冲突 30 对、涉及 57 条，两边都有效；同一对按最新判定取（49 条冲突事件 ≠ 49 对，有同一对正反两个方向判过的） | 两轮 review 只读重放；`src/relate.ts:122-123,150-155` |
| 这些条目被注入过 824 次（brief 587、search 209、get 17、recall 11），被引用 11 次 | `inject_log` |
| **冲突只能存一个对象**：`conflicts_with` 是单值，后一次 `relate` 覆盖前一次 | `src/l2.ts:261,447` |
| brief 把冲突写成"有待确认的纠正"：投影把冲突塞进 `pending_corrections`，`disputed` 只看这个列表 | `src/l2.ts:455-459`；`src/present.ts:11-13`；`src/brief.ts:31` |
| 处理办法已经有：`ab archive` 归档错的一条，`ab archive --reactivate` 撤销；`ab correct` 加 `ab confirm` 让新条替代旧条；`ab get` 已提示"作废哪条就 ab archive 哪条" | `src/cli.ts:692-695,742-837` |

#### 8.13.2 方案（两项）

**① 冲突按对记录（`src/l2.ts`）**

- `conflicts_with: string | null` 换成 `conflicts: string[]`：从 `relate` 和 `remember.relation` 派生，按排好序的 id 对归一，同一对取 seq 最新的判定；两端都能看到对方。
- 冲突不再塞进 `pending_corrections`；那个列表只放真正未确认的 `supersedes`。
- 读这个字段的地方一次改完（品味规范 D2）：`links.ts:43-45`、`view.ts:313,318`、`cli.ts:694`、`recall.ts:166`、`visibility.ts:22,27`。原来靠 `pending_corrections` 判"有争议"的地方，改成同时看 `conflicts.length`，行为不变（有冲突的未确认条目照旧不进常驻注入）。

**② 写清楚（`present.ts`、`brief.ts`、`status.ts`）**

- search、get、brief 都写"与 [x] 冲突"，和"有待确认的纠正 [y]"分开。
- `ab status` 加一行：`冲突 N 对，最老 D 天，挂着期间被注入 M 次；处理：ab get 看双方，ab archive 错的一条`。年龄取这对最新冲突判定的时间，注入数取那之后的 `inject_log`（借鉴群友看板的"最老等待"）。

**处理**：只留一条用 `ab archive`，替代用 `ab correct` 再 `ab confirm`，反悔用 `ab archive --reactivate` 或归档新纠正。归档是整条生效的，被归档那条跟别的记忆的冲突也一起消失，`ab get` 会列出它所有的冲突，处理前能看到。

**代价**：两条在不同条件下都成立时没有专门出口。可以不处理（冲突继续标着），或用 `ab correct` 把条件写进新正文再确认。真的经常碰到再单独设计。

#### 8.13.3 收窄检查

| 新增或改动 | 防的真实问题 | 依据 |
|---|---|---|
| `conflicts[]` 替换 `conflicts_with` | 多方冲突被覆盖、悄悄丢失 | `e36330f9` 同时跟两条有关系；`src/l2.ts:447` |
| 冲突和待确认纠正分开写 | brief 把冲突说成纠正，看的人不知道要处理 | `src/present.ts:11-13` |
| `ab status` 一行 | 30 对冲突挂着、被注入 824 次，没人知道 | `inject_log` |

能删（三轮 review 里出现过、这一版不做）：`rev`、`resolve` 事件、版本令牌、专用撤销、`ab review --conflicts`、建议表、`stale_current`、一次性补判 78 对、自动化、离线耗时基准。它们带出的并发、Purge、撤销、后台优先级问题随之不存在。

#### 8.13.4 不做

| 不做 | 为什么 |
|---|---|
| 后台整理工序、建议队列 | 冲突已经在写入时判出，缺的是看清和处理；§8.8 候选区没人处理的教训 |
| "两条都成立"的正式裁决 | 需要新事件，引出双端撤销、Purge、后台优先级一串问题；没有证据说现在需要 |
| 过期检查、旧对补判、摘要、全库扫描、自动合并 | 收益未证实，误伤风险高 |

#### 8.13.5 验收

1. A/B 冲突后又判出 A/C 冲突：`ab get A` 同时列出 B、C；B、C 各自也能看到 A。
2. 同一对后来判成 `refines`：这对不再显示冲突，A 跟别的条目的冲突不受影响。
3. brief 里普通冲突写"与 [x] 冲突"，只有真正未确认的 `supersedes` 才写"待确认的纠正"。
4. `ab archive B` 后默认读取不再返回 B，`ab status` 冲突对数减少；`ab archive --reactivate B` 后 B 和 A/B 冲突都恢复。
5. 有冲突的未确认条目照旧不进常驻偏好注入（改字段前后行为一致）。
6. 正式库副本上改前改后各跑一次 `ab status`、`ab get` 抽 5 条、`ab brief`，冲突数和显示符合 1–5，耗时没有肉眼可见的变化。

#### 8.13.6 顺带发现，另外处理

| 发现 | 依据 |
|---|---|
| `fold` 把不认识的事件当成"恢复有效" | `src/l2.ts` 末尾 `target.state = r.kind === "archive" ? "archived" : "active"` |
| `relatePass` 续租不看返回值，租约被接管后旧进程仍会提交 | `src/work.ts:1133` |
| 8 个抽取窗口卡在延后状态，最早从 10-14 起，重试时间早已过去但一直没重试 | `capture_windows` 只读查询 |
| `ab search` 不记耗时和有没有结果；`recall_runs` 的 83ms 测的是提醒钩子 | `src/cli.ts:220-242` |

### 8.14 到期复审：摘要推到 brief（2026-11-10 用户选替代方案 A）

> 2026-11-10 用户选替代方案 A：原草案（模型先筛 + 15 天自动归档）经 kimi k3.1 pro 只读 review 报 2 阻断后放弃。阻断 1：自动归档推翻 §10.3 锁定合同和 §8.12「未使用 30 天不自动归档」决定。阻断 2：自动召回已关闭（`ab recall --hook` 只给常驻偏好），「没被注入」不等于「没被需要」，模型判「没用」的依据不可靠。替代方案：保留 `ab review` 人工处理，只把清单摘要推到 brief（跟 §8.13.7 冲突提醒同一路径）。原草案全文见 git 历史。

**结论**：`ab brief` 末尾加一行到期清单摘要 `到期未复审 N 条（最老超期 D 天）：ab review 看清单，ab confirm 留用，ab review --archive 归档。`，只统计本次 brief 范围（全局 + 当前项目）内、未确认、过有效天数没被注入的条目。没有到期条目不加。跟冲突提醒同级进固定预算。

**实现**：复用 `expiry.ts` 的 `reviewList`，按 brief 范围过滤（全局 + 当前项目），取条数和最老超期天数。不调模型、不改状态机、不动 `ab review` 人工路径。

#### 8.14.1 验收

1. 有到期未确认条目时，`ab brief` 末尾出现摘要行，条数和最老超期天数跟 `ab review` 一致。
2. 没有到期条目时不加这行。
3. 范围外的到期条目（其他项目）不计入。
4. 条目超预算时先截条目，摘要行完整保留（跟冲突提醒同级）。

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

**它和 `confirmed_by: corroboration` 是两回事。** 后者是 §8.8 的一个可信程度：同一结论在至少两个不同会话里都有用户原话支持，就自动转正；它已经实现，不数使用次数。Corroboration Count 数的是"在多少个会话里真被用上且没被否定"，用来排使用成熟度，排期在切片 4 之后，`src/` 目前没有实现——`prop_usage` 只记"被注入"的次数，供到期复审用，不参与排序。

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

处置的理由：丢弃违反"证据永不丢"（§5.1）；直接投影则会让一次性上下文里的临时结论进入长期记忆。默认不投影使二者都避免。这种不留持久 session 记录的会话就是 **Ephemeral Session（一次性会话）**。

Doctor 必须能报告这类证据的量（§14.3），否则它是完全不可见的沉默积累。

### 9.6 适用范围变化与历史叙述（CANDIDATE，2026-10-15，10-22 复核）

现状：已在 §9.2 覆盖按 scope、subject、time 区分命题，§21 的 2026-10-13 修正也明确冲突只标记、不自动替代。但两层提示词都缺少"适用范围变化"与"历史不是当前主张"规则。第 1 层集合仍在 `src/extract.ts:32`，类型在 `src/l2.ts:36`；第 2 层在 `src/relate.ts:11-12`。一步式已合并，目前只有 new/merge（`src/onepass.ts:37-49`）。

任务单的"第 2 层只处理关系未判定"与当前代码不符。`src/work.ts:1028-1037` 挑的是未确认、active、未判过且有近邻的自动条目，没有按 `unreconciled` 过滤，也排除了话题条目。因此不能假设第 1 层判 refines 的一定会或一定不会被第 2 层修正。两层必须各自遵守规则，且本条不借机改变第 2 层队列。

规则 A：建议新增关系值 `boundary_change`，中文显示"适用范围待确认"。它指同一规则的适用条件收窄或放宽，例如"所有项目都要 X"变为"只有 ai-data 要 X"。它不是把记忆的 `project_id` 自动从全局搬到项目。先识别当前主张，再拆出规则内容与适用条件。规则内容不变、仅条件变化才归本类；同一适用条件内结论相反仍是 conflicts。主体不同或本来就能按条件并存，不猜一次范围调整。拿不准仍判 unsure。

候选共享集合为 `new / duplicate / refines / conflicts / boundary_change / supersedes / unrelated / unsure`。这是两层共同理解的集合，不是要求每条都跑两层。new 表示完整邻居检查后没有相关旧命题，unrelated 表示给出的近邻只是主题相近，两者都不改目标；duplicate、refines、conflicts、boundary_change、supersedes 都必须引用已提供且仍存在的目标。保留原有值，不把旧事件改名。supersedes 仍只是替代建议，只有用户明确确认才能改变目标状态。第 2 层新增可表达值不增加自动替代权，new/unrelated 只结束关系检查，supersedes 只保留待确认建议，其他关系沿原有动作落地。

一步式的 new/merge 是写入动作，不是上述关系集合。候选方案要让它同时表达关系，不把范围变化压成 merge，也不新增一次模型调用。普通抽取与关系判定共用这些规则。§8.6 已定的一步式 merge 只进报告、话题条目不进后台第 2 层，均保持不变；改变提示词须重跑 §8.7 的质量评测，不能直接覆盖已批准的 V1。

落层与准入如下：

- L1 新条目照常写 `remember`，`relation.type` 可为建议新增的 `boundary_change`。同一事务另写一条 `relate`，其 `target_id` 指新条目，事件体的 `target` 指旧条目，`outcome` 为 boundary_change，保留 reason、model 与 §8.10 版本。第 2 层判出时只追加这条 relate。第 1 层已落同一结论后不重复调第 2 层。候选区条目只在受限读取面展示，不借关系事件提前发布。话题路径自产的这条 relate 也要归入同次撤销范围，撤销只归档提议、保留审计关系；若仍沿当前"判过关系就不撤"的限制，必须标为未满足 §8.6 的可撤销合同，不能宣称完成。
- 不给目标追加 evidence，不生成 supersedes，不改目标正文、范围、确认来源或 active 状态，无论目标是否已确认。L2 从关系事件为双方生成双向关联，在目标卡片挂"适用范围待确认"。标记只表示有提议，不表示旧规则失效，也不自动撤下旧规则。
- 处于该未决关系中的提议不自动转正；目标若未确认也不自动转正。明确记录双方，检查指向和被指向两种情形，避免另一次 duplicate 印证绕过标记。已确认目标保留原读取资格，但凡输出它就同时输出提示，不能只显正文。新提议不进入默认 brief 或每轮召回，按需读取仍可见。L3 只索引有资格的 L2 条目及标记，删除后可重建。
- 用户选择改旧条目时，用显式 correction 写新的带范围条目，再归档原提议。选择并存或否决时，追加 §9.4.4 所述的用户 resolution，记目标与选择。它是候选事件设计，当前代码尚无该命令；CLI 形式待用户在实现前确认。单纯 `ab confirm` 只确认内容，不等于接受范围调整。归档提议后不再显示活动提醒，历史关系仍可查。不得用自动确认、重新判 unrelated 或场景分组来解除。

展示示意如下，id 和正文均为合成示例。`ab view` 卡片用同样的标记与双向关系，不增加常驻审批列表。

```text
$ ab get a1111111
[a1111111] 全局 规则: 所有项目的 e2e 都使用真实服务。
适用范围待确认: [b2222222] 提议只在 ai-data 要求真实服务。
旧条目未改。请核对原话后决定纠正、并存或否决，确认提议内容不会自动改旧条目。

$ ab get b2222222
[b2222222] ai-data 规则 未确认: 只有 ai-data 的 e2e 要求真实服务。
关系: 对 [a1111111] 提议适用范围变化，待用户裁决。

ab view 卡片:
所有项目的 e2e 都使用真实服务。 [适用范围待确认]
范围变化提议 [b2222222]，可打开对方卡片；旧条目仍有效。
```

规则 B：两层提示词都只比较当前主张。若新条目讲"以前 A，后来改 B"，而已有条目已经是 B，判 duplicate；历史提供了值得保留的理由或适用条件时可判 refines。不要把 A 单独当成现在仍坚持的主张。若文本仍主张 A，或时间关系不清楚，仍可判 conflicts 或 unsure。本规则不改 duplicate/refines 的落地逻辑，一步式的 merge 仍只进报告。

不做自动 rescope、自动修改已确认记忆、自动仲裁或关系清理。不重判已有终态 unsure，不扩大普通抽取或导入的写权。第 1 层当前 conflicts/supersedes 走待确认纠正（`src/work.ts:540-543`），第 2 层 conflicts 走独立冲突标记；本次只新增 boundary_change 的共同落法，不顺带改旧关系。§9.4 的权限边界不变。新增关系用于表达待定范围，不是 §11.6 已否决的检索图扩展。

验收：固定 12 对人工标注样例，覆盖范围收窄/放宽各 2 对、已同步历史的重复/补充各 2 对、真正当前冲突 2 对、范围不明 2 对。每条启用路径各跑一遍，12 对关系正确且目标引用正确，历史组零冲突。对已确认、未确认目标各测试一次落 L1、投影、`ab get` 与 `ab view`；改动只能是新提议、关系与展示标记，目标正文、范围和确认状态逐字段不变。再追加跨会话印证、用户只确认提议、归档提议、显式 resolution，检查只有后两类用户处置能解除提醒。删 L3 重建后同样成立。对全局与项目、子代理读取分别验证，不可读提议不得泄漏正文或 id。

### 9.7 代码变更驱动的记忆重核与需求收口更新（CANDIDATE，2026-11-23 定稿，2026-11-25 实测修订；单 1、2 已授权实现）

> 来源：用户 2026-11-23 提出「需求做完后知识库要在某个节点自动更新，要解决粒度、核验和各层联动」。原方案经 Claude Opus 与 Gemini Neon 两轮评审定稿，记录在 pm `docs/agentbrain/2026-11-23-kb-change-reverify/`（`final-plan.md` 与 `reviews/`）。2026-11-25 在正式库只读副本、隔离沙箱与 6 个近期真实交付需求上实测复核后，补齐了 cherry-pick 非祖先平移、标识符共变预筛、存量决定补锚点、`quotepath=false`，以及用户拍板同意的三项补充（需求收口正向提炼、未确认草稿退场、pm 侧收尾门禁），拆为 6 张单按单逐张授权推进。本节写 agentbrain 侧设计与两仓拆单总账；pm 侧实现落 pm 仓库。

**结论**：反向侧，代码改了就找出引用或锚定了被改文件的旧记忆，只读主干代码重新核验；核出不符的按确认来源决定还给不给 agent 看。正向侧，需求收尾清灶时单次提炼 ≤3 条带锚点的定稿候选，并允许未确认自动草稿被同项目新草稿退场而不触碰任何已确认条目。零新表，不升 `SCHEMA_VERSION`，配置键新增 0。

#### 9.7.1 现网断点（2026-11-23 基线 + 2026-11-25 实测复核）

| # | 现象 | 位置 |
|---|---|---|
| 1 | `verify_queue` 实际是死路径：§11.9 取消每轮自动召回后，只剩手动 `ab recall <文本>` 会往里放；正式库 0 行。pm ADR 0033 删掉的 `tools/board`、`features/board.md` 相关 30 条代码转正条（含无引文共 71 条）仍是 active | `Store.queueReverify`（`src/store.ts`）、`cmdRecall`（`src/cli.ts`） |
| 2 | 入队项没有 `code_evidence` 就被直接出队；代码核验只认坑和事实 | `verifyStep` / `CODE_VERIFIABLE`（`src/work.ts`） |
| 3 | 被判与代码不符（`stale`）的已确认条目照常注入：`recallable()` 在看 stale 之前因 `confirmed` 返回 true；`brief()` 不滤也不标 stale；`ab confirm` 遇到已确认直接退出，`fold()` 的 `confirm` 事件也不清 stale，误判无法回滚 | `recallable`（`src/visibility.ts`）、`brief`（`src/brief.ts`）、`fold`（`src/l2.ts`）、`cmdConfirm`（`src/cli.ts`） |
| 4 | 核验读原目录工作区，而 pm ADR 0028 规定原目录停在测试分支；主干前进而原目录 HEAD 没动时，要么核错分支，要么当成提交没变跳过 | `verifyStep`（`src/work.ts`） |
| 5 | 入队项不走 §12.6.12 的退避，只比 `last.head === head`；无法核验和证据不足的条目会随每次无关提交重新入队 | `verifyStep`（`src/work.ts`） |
| 6 | 仅靠单会话自动抽取会产生大量相互矛盾的未确认过程草稿且漏抽需求最终决定；同一需求内新草稿写 `supersedes` 后，旧未确认草稿仅挂 `pending_corrections` 仍占召回与待确认视图 | `fold`（`src/l2.ts`）、`recallable`（`src/visibility.ts`） |

单 2 已实现断点 2、4、5 的修补。队列接受无代码证据的条目和决定，核验读取只读主干提交，入队项遵守无法核验与证据不足退避。首次未确认的决定核验仍留给单 3。每日扫描默认关闭，不能把代码合入当成正式库首扫授权。

#### 9.7.2 和原方案相比

| 原方案 | 本节 | 依据 |
|---|---|---|
| 两阶段节点挂在 pm_new 的需求收口和上线 | pm_new 已停用。反向主触发是 `ab work --sweep` + pm `tools/req log 上线` 后台加速；正向提炼挂在 `req log 清灶` 与 `ab synthesize` | pm 和 agentbrain 自身直接提交主干，不经过 `req log`；2026-11-25 实测仅单会话抽取会产生 114 条碎片并漏掉核心架构决定 |
| 收口时自动改仓内文档（L0/L1） | 不做。文档由项目 agent 随需求分支改，pm 拆线、初验与 `req log 清灶` 机械门禁检查 | pm 分工：主会话和负责人不改业务仓 |
| 另起 G0/G1/G2 粒度分档 | 记忆失效只看 diff，不分档；正向提炼在需求收口节点固定产出 ≤3 条定稿候选 | 改一行常量也可能让引用它的坑过时 |
| 4 路召回加模型裁决 | 首版做路径、锚点反查与离线存量 `decision` 一次性补锚点，不做每次上线的模型裁决与语义召回 | 存量 321 条项目 `decision` 100% 无代码证据，2026-11-25 实测仅 1 次离线调用（~20.7k tokens/96 条）即可补锚点，运行时零 LLM 成本 |
| 规则和决定一起处理 | 规则不进代码失效，决定进 | 抽样 30 条规则，80% 是流程或偏好；抽样 30 条决定，83–90% 和代码挂钩，其中至少 3 条已过时 |

保留不变：只追加事件，不原地改写；对已确认条目的替代只进待确认纠正（`fold` 里 `pending_corrections` 不变）；历史设计稿不回头改；用户确认过的条目（含跨会话印证与代码转正）永不自动归档或自动降为 `superseded_draft`。

#### 9.7.3 判定「可能过时」

每条记忆自带基线，不设项目级水位。所有执行路径列出或 diff 的 Git 命令必须带 `-c core.quotepath=false`，避免中文文件名（如本设计文档）被八进制转义导致路径匹配失真。

- 基线 `base` 取以下三者中最新的一个：`code_evidence.head`、`anchor_head`、`verify_attempts` 里最近一次非出错的 head。
- 目标 `trunk-ref`：主干名取 pm `repos/<项目>.md` 的「- 主干：」行。`origin/<主干>` 和本地 `<主干>` 互为祖先时取较新的那个，分叉时取 `origin/<主干>`。
- 若 `base` 是 `trunk-ref` 的祖先：计算 `git -c core.quotepath=false diff --name-only <base> <trunk-ref> -- <引文路径 ∪ 锚点路径>`，非空即命中；同一个 `base` 的条目一起跑。
- 若 `base` **不是** `trunk-ref` 的祖先（常见于功能分支合并或 cherry-pick 进主干）：不再一刀切跳过，先算 `mb = merge-base <base> <trunk-ref>`，按主干真实内容三分支判定（2026-11-25 正式库 237 条非祖先记忆实测：`169` 条 71.3% 已被 cherry-pick 到主干且引文完好、`32` 条 13.5% 主干分叉后已改坏引文、仅 `36` 条 15.2% 属真正未合主干）：
  1. 若所有引文在 `trunk-ref` 上仍逐字存在（已 cherry-pick 合入且未改坏）：不跳过，将该条核验基线平移吸附到 `trunk-ref`（记一条当前 `trunk-ref` 的 `verify_attempts`），后续主干再改动即可正常触发。
  2. 否则若文件在 `trunk-ref` 存在且 `merge-base..trunk-ref` 改过该路径（或引文已断 / 有锚点命中）：照常命中，交由预筛/入队在 `trunk-ref` 上重核。
  3. 否则（`merge-base..trunk-ref` 未碰该文件，或文件尚未合入主干）：视为分支独有未上线代码，跳过，等合入主干或手动 `ab verify <id>`。

其余跳过/降级规则：

| 情形 | 处理 | 实测（2026-11-23） |
|---|---|---|
| 路径在 base 的树里本来就不存在（被 gitignore 或没进 git） | 跳过这条路径 | 21 条 |
| base 已被 gc 或 rebase 掉（`git cat-file` 失败） | 不跳过，改为对 trunk-ref 做机械核对 | 0 例 |
| 上次结果是无法核验，或还在 §12.6.12 的退避期内 | 不入队，只能手动 `ab verify <id>` | — |

pm 实测：273 条有引文，54 个不同 head，命中 160 条，约 0.35 秒；board 相关 30 条全部命中。

#### 9.7.4 机械预筛和入队上限

- 有引文的条目先做零成本核对：只有当文件在 `trunk-ref` 存在、引文逐字还在、`git -c core.quotepath=false diff -U0` 旧侧改动行与引文 `[行首-3, 行尾+3]` 不交叠，**且本次 diff 增删行中不包含引文里的任何非常规标识符（长度 ≥4、剔除语言保留字后的词元）**时，才跳过模型。按 base 批量跑。
  - 2026-11-25 实测依据：全库 `141` 条被 `±3 行` 跳过的条目中，抽样 `14` 条调真实模型重核，标识符共变组抓到远距离契约变更失效 `[d16d321e]`（`ai-data` `packages/contracts/src/index.ts`，改动距引文超 25 行，仅标识符共变命中），无标识符共变组 `contradicted` 为 `0/6`；全库放行增量 `80` 条，运行时零 LLM 成本。
- 只有锚点的条目没有行号，不预筛，直接入队。
- 单次 `--changed` 最多入队 20 条（代码常量）。超出时按以下顺序取，并报出截掉的数量：文件被删 > 引文断裂 > 锚点命中 > 改动行交叠或标识符共变。
- 消费仍由 `ab work --sweep` 按 `MAX_VERIFY_PER_RUN = 3`（`src/work.ts`）来；同一条在同一个 head 上不重复核。
- 上线前回放必须从被跳过的条目里抽 10 条人工判断，报出预筛漏报率。

#### 9.7.5 核验与止损

- 核验只读 `trunk-ref`（`git -c core.quotepath=false` 驱动的 `show` / `grep` / `ls-tree` / `log` / `blame`），不切换、不改动工作区。
- 入队核验接受 `decision`。单 2 保留首次未确认核验的 `CODE_VERIFIABLE` 为坑和事实；单 3 再加入决定。决定核出 verified 时只写代码证据、清 stale，不把未确认的决定自动转正；坑和事实的自动转正不变（§8.4、§9.4 不变）。
- 核出 contradicted 后，按确认来源处理：

| 确认来源 | `ab brief` / 每轮召回 | 其他 |
|---|---|---|
| 用户确认、跨会话印证 | 照常注入，正文前加 `[与代码不符@<短sha>，待用户核实]`；brief 末尾加一行汇总 | `ab status`「要处理」列出 |
| 代码核验转正，或未确认 | 不注入（含 `guidanceBlock`、不计入 `inject_log`） | `ab search`、`ab get`、`ab status` 仍可见 |

  理由：用户确认的条目被判不符，可能是决定被推翻，也可能是代码偏离了决定（实测一例正是 bug），也可能是误报。只凭一次模型判断就拿掉，等于替用户撤销决定。代码转正的条目唯一的依据已经被同一机制推翻，留着只会占 `BRIEF_MAX_CHARS` 和 `RECALL_MAX_ITEMS` 的预算。现网 `confirmed && stale` 为 0 条，这条规则是首扫之前先装好的护栏。
- 回滚有两条路：`ab verify <id>` 强制重核（绕过 stale 和同 head 去重），通过就清 stale；`ab confirm <id>` 对 stale 条目写 `confirm({ by: "user", override_stale: true })` 清掉 stale，并优先在只读主干 head 记一条 `verify_attempts`（`verified`）。主干无法解析时回退 stale 的 head，再回退本地 HEAD。无论能否得到 head 都出队，防止确认后重复重核。
- **未确认草稿退场（2026-11-25 用户批准）**：在 L2 投影 `fold()` 中，当一条活跃且未确认的条目 `p` 带 `p.supersedes = old.id`，且 `old` 同时满足 `old.state === "active"`、`!old.confirmed`、`old.origin === "extract"`、`old.project_id === p.project_id` 时，给 `old` 派生 `superseded_draft = p.id`（L1 不追加修改旧条目的事件，原 `old.pending_corrections` 保持不动；若把 `p` 归档，重新投影后 `old.superseded_draft` 自动恢复为 `null`）。
  - 带有 `superseded_draft` 的旧草稿不再进入 `recallable()`、`brief` 待确认计数与 `expiry` 到期待复审清单，但在 `ab search`、`ab get` 仍可查到并标 `[已被草稿 <8位id> 替代]`。
  - 若 `old` 已被任何来源确认（`user` / `corroboration` / `code`）或 `origin !== "extract"` 或跨项目，严禁设置 `superseded_draft`，仍按原有待确认纠正规则保留不动。

#### 9.7.6 触发

| 入口 | 做法 |
|---|---|
| `ab work --sweep`（主，反向） | 每个项目每天最多扫一次，不联网，用本地已有的 ref；扫描日记在 `work_meta` 的 `verify_scan_day:<project>`。**代码合入时默认关**，正式库首扫经用户放行后才打开 |
| pm `tools/req log <需求> 上线 --lane <线>`（加速，反向） | 按 `lane.repo` 在后台另起进程跑 `git fetch origin <主干> && ab verify --changed <repo>`，限时 15 秒，失败写 `work.log`，不影响 `req log` 的退出码。多仓需求按线逐仓触发 |
| 需求收口正向提炼（`ab synthesize`，单 4） | `pm tools/req log <需求> 清灶` 后（或手动执行 `ab synthesize <project> --spec <文件>... [--diff-base <ref>]`）单次调模型，输入需求定谱/README/ADR、`git -c core.quotepath=false diff --stat` 与命中路径/主题的存量记忆，产出 ≤3 条带合法 `anchors` 与可选 `supersedes` 的**未确认候选**写入 L1，终端打印候选确认指令与同主题未确认过程草稿清理提示；不自动转正、不自动归档 |
| 手动 | `ab verify --changed <project>`、`ab verify <id>`、`ab synthesize ...` |

#### 9.7.7 接口和数据形状

```text
ab verify --changed <project> [--ref <git-ref>] [--run] [--dry-run] [--json]
    默认只入队、不调模型；--run 同步最多核 3 条
    输出：trunk-ref、命中数、各类跳过数、基线平移数、预筛跳过数、入队数、截掉数
ab verify <id-prefix> [--ref <git-ref>]
ab remember | correct ... [--anchor <relpath | repo:relpath>]...   最多 5 个
ab tag <id-prefix> [--anchor ... | --anchor none]
ab confirm <id-prefix>        对 stale 条目写 override_stale
ab synthesize <project> --spec <file>... [--diff-base <ref>] [--dry-run] [--json]   需求收口提炼（单 4）
```

```ts
RegistryEntry.trunk: string | null            // repos/<项目>.md 的「- 主干：」
RememberBody.anchors?: string[]; RememberBody.anchor_head?: string
TagBody.anchors?: string[]                     // 整组替换，[] 清空，缺省不动
ConfirmBody.override_stale?: boolean           // by === "user" 时投影清 target.stale
Proposition.anchors: string[]                  // 缺省 []
Proposition.superseded_draft: string | null    // 仅由未确认 extract 草稿被同项目未确认 supersede 时派生
work_meta: "verify_scan_day:<project>" → "YYYY-MM-DD"
```

- 锚点只收仓内相对路径或 `<repo>:<relpath>`，拒绝绝对路径、`..`、`.git`、以 `/` 结尾的目录。`--changed <repo>` 同时匹配本仓路径和全库带 `<repo>:` 前缀的跨仓锚点。
- 所有 Git 路径枚举/diff 调用固定带 `-c core.quotepath=false`。
- 和 §12.6.1 纪律的关系：只在已有事件体里加可选字段，复用已有的 `work_meta` 表，不加事件种类、表或列，所以不升版本号。旧代码读到新字段会忽略它：看不到锚点，也不会因 `override_stale` 清掉 stale，结果只是保守，不会写坏。
- 和 §2.2 的关系：20 条、5 个锚点、15 秒、每天一次、收口提炼上限 3 条都是代码常量，配置键新增 0。

#### 9.7.8 拆单、验收和授权

| 单 | 仓 | 内容 | 验收 |
|---|---|---|---|
| **1 止损护栏与草稿退场**（2026-11-25 已授权开始实现） | agentbrain | 9.7.5 注入规则（brief、召回、常驻偏好、status、展示）、`ab confirm` `override_stale`、未确认 `extract` 草稿 `superseded_draft` 投影与过滤、`ab verify <id> [--ref]`（含只读 ref 工具与决定不自动转正） | 三类确认来源与未确认条被标 `stale` 后，brief/recall/guidance 与 `inject_log` 符合上表；`ab confirm` 一键清 `stale` 并防同 head 复发；`ab verify <id> [--ref]` 不改脏工作区且决定不转正；未确认草稿退场可逆且绝不伤及已确认条目 |
| **2 变更驱动重核**（2026-11-25 已授权开始实现） | agentbrain | 只读 `--ref`、trunk-ref 选取、9.7.3 三分支非祖先基线判定、9.7.4 `±3 行 OR 标识符共变` 预筛、`-c core.quotepath=false`、修断点 2/4/5、`ab verify --changed`、sweep 每日一次（默认关） | 负例：改无关行且无标识符命中 0 入队；删文件/改常量/远距离改同标识符必入队；非 cherry-pick 未合入分支和 gitignore 路径不入队；cherry-pick 原文完好自动平移基线；原目录停在别分支有脏改动仍按主干核。在 `/tmp` 副本回放 pm ADR 0033、0034 与 cherry-pick 仓库，报压缩比与漏报率 |
| **3 锚点、决定核验与存量补锚点**（待单独授权） | agentbrain | `anchors` / `anchor_head`、`--anchor`、决定纳入核验但不自动转正；一次性离线脚本为存量 ~321 条项目级 `decision` 生成补锚点预览单，经用户确认后写入 `tag` 事件 | 锚点格式校验（含中文路径）、跨仓匹配、决定入队消费不转正；存量回填预览单幂等生成与用户确认写入 |
| **4 需求收口正向提炼**（待单独授权） | agentbrain | `ab synthesize` CLI 与结构化提炼流程（喂入定谱/ADR、`diff --stat`、存量记忆，产出 ≤3 条带锚点未确认候选 + 草稿清理提示） | 隔离库回放真实已收尾需求：产出 ≤3 条候选、锚点 100% 合法、可提 `supersedes` 但零自动转正/零自动归档 |
| **pm-1 流程接线**（不在本仓） | pm | `req log 上线` 后台 `ab verify --changed` 加速器；`req log 清灶` 接 `ab synthesize`；拆线/初验模板补活文档与候选决定锚点提示 | 由 pm 验收（`ab` 不可用时 `req log` 照常） |
| **pm-2 收尾机械门禁与忽略告警**（不在本仓） | pm | `req log 清灶` / `pm_tidy.py` 零模型检查：`README.md`「可复用」禁止留模板占位词、`repos/*.md` 禁多段 `## 现状` 堆叠且超 7 天告警；`verify-status` 发现 `.gitignore` 忽略 `.agents/skills/verify-*` 时报错 | 由 pm 验收（临时仓库与真实档案校验通过） |

顺序 `ab-1 → ab-2 → ab-3 → ab-4`；`pm-2` 可随时与 `agentbrain` 并行，`pm-1` 在 `ab-2` 之后（其 `synthesize` 接线等 `ab-4`）。每张 `agentbrain` 单开工前由用户说「开始实现」。

需要用户点头的节点：

1. 每张单的「开始实现」（单 1 已于 2026-11-25 获批）。
2. 单 2 合入后：先交 `/tmp` 副本的回放报告，用户放行后才在正式库首扫（预计写入 150 条以上 `verify` 事件），并打开每日扫描。
3. 单 3 离线存量 `decision` 补锚点：先交预览单，用户放行后再写 `tag` 事件。

#### 9.7.9 首版不做

- 自动改写仓内文档（L0/L1/L2 仅做提醒与门禁，不代写正文）。
- 规则（`rule`）的代码失效。
- 全库无锚点记忆的语义分桶召回、需求到会话的血缘、每次上线的模型裁决。
- pm 看板读 `store.db`。
- 自动归档或自动改写已确认条目（包括跨会话印证与代码转正）、自动从项目级升到全局。

#### 9.7.10 第二版的触发条件（满足任一）

1. 补齐首版锚点并跑满 2 周或 10 次真实上线后，仍出现至少 3 起「无代码指针的纯概念决定因架构调整过时且误导 agent」：试点针对无锚点决定的语义召回。
2. 多次出现「跨文件或重命名符号导致单文件标识符共变预筛仍漏检」：引入跨文件符号引用反查。
3. `override_stale` 次数超过 contradicted 总数的 20%：先收紧代码核验提示词，暂停扩大召回。

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

声明加枚举这一对就是 **Purge Range（清除范围）**。具体 event identity/tombstone 物理模型仍未关闭，见 §19.1。

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

### 11.5 两个读路径小改动（**已批准，实现中**，2026-10-16）

> 2026-10-16 用户对 PR #58 回"实现"，本节两项随 §8.6 一起实现。

依据：场景目录评测（`docs/eval/10`）结论是"不如一次 `ab search`"，PR #56 搁置；用户同意改走两个更直接的办法。

**(i) brief 里提醒 agent 在哪几类问题上先 `ab search`**

现在 brief 只说"搜索用 ab search，看一条用 ab get"，没说什么时候该搜。改成点出几类问题。

改前（`src/brief.ts` 当前那一行，主会话版本）：

```text
干活时不用记记忆，后台会从会话里自动抽取并审稿；只有用户明确要你记时才用 ab remember --confirmed。搜索用 ab search，看一条用 ab get。
```

改后：

```text
干活时不用记记忆，后台会从会话里自动抽取并审稿；只有用户明确要你记时才用 ab remember --confirmed。
遇到这几类情况先 ab search <关键词> 再动手：用户提到"上次/之前/我们定过"；要改不熟悉的模块或配置；报错看不出原因；要做设计取舍。看一条的来龙去脉用 ab get。
```

- 多约 70 字，仍在 `BRIEF_MAX_CHARS`（2000）以内；超出时按现有规则先截后面的条目，不截这行。
- 子代理版本同样加这一行（子代理也能 `ab search`）。
- 怎么验收：拿 `docs/eval/10` 的开工背景题目，比较加这行前后 agent 实际调用 `ab search` 的次数和答对率。

**(ii) `ab search` 结果显示全文，不只第一行**

现在每条只打印正文第一行（`src/cli.ts` 的 `h.text.split("\n")[0]`），"为什么"和"场景"要再 `ab get` 一次才看得到，agent 常常不去看。

改前（2026-10-15 用当前代码在临时库里实跑的输出）：

```text
$ ab search e2e
[0270ece3] 全局 坑: 改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码
```

改后（示意）：

```text
$ ab search e2e
[0270ece3] 全局 坑: 改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码
  为什么: 上次 e2e 全绿但页面没变，查了半小时才发现 dev server 没热更新到构建产物
  场景: 当改完前端代码要跑 e2e 时
```

- 正文全部打印；"为什么"最多 200 字，超出截断加"…"；有场景（`value.scenario` 或 `trigger`）才打"场景"行。
- 条数上限不变（混合检索默认 8 条）。8 条全展开约 1500～2500 字，比现在多 2～3 倍，仍在一次工具输出可接受的范围。
- 不加开关（§2.2 复杂度纪律）；要看来源和近邻仍用 `ab get`。
- 怎么验收：同 (i) 的题目，比较 agent 读完搜索结果后还要不要再 `ab get`、答对率有没有变。

### 11.6 搜索结果带上被截掉的候选和双向关联（**(i)(ii)(iii) 已实现并合并**，2026-10-19）

> 状态：(i)(ii)(iii) 与 why 重复打印修正已实现，PR #62 合并提交 `1d83866`（2026-10-19）。验收见 [评测 14](../eval/14-linked-recall-impl.md)。

> 2026-10-19 16:02（SGT）用户批准实现 (i)(ii)(iii) 和 why 重复打印的修正："按你说的来，但是要能够真实测试通过，而不是为了通过而通过"。关联**默认显示**（每个关联一行：id + 关系 + 对方正文一句 + 已归档/已替代状态，不展开全文）。"不做的"第 3 条（抽取在 why 里写被否掉的方案）不在本次范围。
>
> 为什么默认显示不违反第 8 篇的决定：第 8 篇否掉的是**每轮召回**沿关联扩 1 跳、把对方条目当成召回结果注入（每轮 3 条预算被非目标挤占）。本节只改按需工具（`ab search`、`ab get`）的显示：每轮召回和 brief 一字不改；关联只列 id 和一句话，不把对方变成结果行，不沿关联继续走，所以不占任何召回名额；agent 要看对方全文仍需再 `ab get`。第 8 篇"要做只做成按需工具的可选参数，默认关闭"那句是针对"扩展成结果"说的，这里不是扩展，用户确认默认打开。

> 用户 2026-10-19 问"场景、记忆、决策之间的关联能否很好的适配到，不然很可能召回不全面"。依据是 `docs/eval/13-linked-recall.md`。本节只是设计，用户说"开始实现"后才写代码。

**结论先说**：召回不全主要不是缺关联。无偏的 43 道多条题里，`ab search` 缺了 26 个槽，其中 17 个排在第 9–24 名，只是被 8 条上限截掉了；显式关联只能补 5 个。专挑有关联的 34 道题里，显式关联能补 9/14，补上的主要是"旧版本已归档、默认搜不到"的历史题。所以不做图谱层，不加新的关系类型，也不做每轮扩展（第 8 篇的决定不变）。只改两处显示，外加一处展开来源，数据都已经在库里。

**(i) `ab search` 第 9–16 名给一行**

- 前 8 条照旧显示全文、为什么、场景（§11.5 (ii)）；第 9–16 名每条只给一行：`[id] 范围 种类: 正文第一行前 60 字…`，最后提示"看全文用 ab get"。
- 顺手修一个 §11.5 (ii) 的显示问题：`searchHybrid` 返回的 `text` 已经把 why 拼在正文后面（`indexText`），`searchDetail` 又打一行"为什么"，所以 why 现在会打印两遍。改成只用正文 `p.text`。
- 数字（评测 13）：无偏组"答全"22→33/43（test 5→10/13）；关联题 22→24/34。修掉重复后再加这一段，输出中位长度约 2900 字，和现在（约 2700～2900 字）差不多。
- 16 是代码常量（§2.2），在 tune 上和 24 比过，24 只多 1～2 题。

**(ii) `ab search` 和 `ab get` 显示双向的显式关联**

- 关联指已经存在的 refines、merged_into、supersedes / superseded_by、conflicts_with、待确认纠正，两个方向都显示，目标是已归档或已替代的也显示，并标出状态。`ab view` 已经这样算了（`src/view.ts` 97–117 行），`ab get` 现在只显示记在本条上的那一半。
- 不做的事：不展开对方全文，不沿关联继续走，不进每轮召回和 brief。同窗口、同会话、向量近邻这些"隐式关联"不显示（评测 13：每补一题要多带十几到上百条无关条目）。
- 数字（评测 13）：在 (i) 的基础上，关联题再 +7（24→31/34，test 9→14/17）；无偏组 +1（33→34/43）。
- 和第 8 篇的关系：第 8 篇定的是"不做每轮图扩展；要做只做成按需工具的可选参数，默认关闭"。本节只在按需工具里列出 id 和一句话，不把对方条目展开成结果行，所以默认打开。如果用户认为这也算"扩展"，就改成 `ab search --links` 才显示，`ab get` 照样默认显示。

**(iii) Pensieve 导入的条目，`ab get --expand` 打开原文件**

- 现在 76 条 Pensieve 导入的决定没有 transcript，`--expand` 只能说"来源不可用"，但 `import_ref.path` 指向的原 md 文件 76/76 都还在。改成 `--expand` 时读这个文件，原样打印（同样走脱敏，最多 4000 字），文件不在或哈希变了就说清楚。
- 数字：active 决定里能展开原始讨论的从 41/124 变成 117/124。没有测答题效果。

**改前（2026-10-19 用 `fd75d6b` 在库副本上实跑，节选）**

```text
$ ab search 派生维度槽位规则以前端为准还是后端为准 --project data-asset
[9888aac0] data-asset 坑[未确认·自动沉淀]: 派生指标槽位不要假定前后端逐条等价：后端 DerivedDimensionSlots 先剔除「空维度」哨兵再排槽位，前端 querySql.js 让哨兵占 dimN，…
  契约要求剔除哨兵，前端排序时未剔除；评审发现这是阻断验收的槽位契约冲突，不能宣称两边逐条一致
  为什么: 契约要求剔除哨兵，前端排序时未剔除；评审发现这是阻断验收的槽位契约冲突，不能宣称两边逐条一致
  场景: 对照后端导出的槽位与前端复制 SQL，或导出含「空维度」哨兵的派生指标时
[8b6bf402] data-asset 决定[未确认]: 派生维度槽位：后端 DerivedDimensionSlots 先剔除空维度哨兵（与 developmentScript.js 写数一致），…以后端为准，记入契约，前端不改。…
  querySql.js:7 不过滤哨兵，developmentScript.js:30 过滤；用户要求前端不改
  为什么: querySql.js:7 不过滤哨兵，developmentScript.js:30 过滤；用户要求前端不改
…（共 8 条，后面是另外 6 条不相干的坑和事实）

$ ab get 8b6bf402
[8b6bf402] data-asset 决定 未确认（agent 自记）: 派生维度槽位：…以后端为准，记入契约，前端不改。…
为什么: querySql.js:7 不过滤哨兵，developmentScript.js:30 过滤；用户要求前端不改
来源: data-asset 阶段 1 Codex review 的唯一阻断项（claude）  记录于 2026-10-12
相关（向量近邻）:
  [9888aac0] … （0.85）
  [a1722951] … （0.72）
  [42e426c3] … （0.66）
```

问的是"以前是怎么定的、为什么变了"，但之前那条"以前端 querySql.js 为权威、逐条等价"（`ea278497`，用户确认过，10-13 冲突裁决时归档）在两条输出里都看不到：冲突关系记在已归档的那条上，`ab get 8b6bf402` 不显示；`9888aac0` 是 `8b6bf402` 的补充，也只在 `9888aac0` 那边能看到。

**改后（示意）**

```text
$ ab search 派生维度槽位规则以前端为准还是后端为准 --project data-asset
[9888aac0] data-asset 坑[未确认·自动沉淀]: 派生指标槽位不要假定前后端逐条等价：…
  为什么: 契约要求剔除哨兵，前端排序时未剔除；评审发现这是阻断验收的槽位契约冲突，不能宣称两边逐条一致
  场景: 对照后端导出的槽位与前端复制 SQL，或导出含「空维度」哨兵的派生指标时
  关联: 补充了 [8b6bf402]
[8b6bf402] data-asset 决定[未确认]: 派生维度槽位：…以后端为准，记入契约，前端不改。…
  为什么: querySql.js:7 不过滤哨兵，developmentScript.js:30 过滤；用户要求前端不改
  关联: 被 [9888aac0] 补充；与 [ea278497]（已归档）冲突
…（前 8 条）
更多（第 9–16 名，看全文用 ab get）:
  [xxxxxxxx] 坑: （第 9 名正文第一行前 60 字）…
  …（最多 8 行）

$ ab get 8b6bf402
[8b6bf402] data-asset 决定 未确认（agent 自记）: 派生维度槽位：…以后端为准，记入契约，前端不改。…
为什么: querySql.js:7 不过滤哨兵，developmentScript.js:30 过滤；用户要求前端不改
被补充: [9888aac0] 坑: 派生指标槽位不要假定前后端逐条等价：…
冲突（对方已归档）: [ea278497] 规则: 语义目录槽位规则的权威实现是前端 querySql.js 的 getSortedDimensions 等，后端…
来源: data-asset 阶段 1 Codex review 的唯一阻断项（claude）  记录于 2026-10-12
相关（向量近邻）:
  [a1722951] … （0.72）
  [42e426c3] … （0.66）
```

- "关联"行在搜索里只列 id 和关系，每条最多 3 个，超出写"另有 N 个，ab get 看"；`ab get` 里每个关联一行，带对方正文前 60 字和状态。
- 已经作为关联列出的条目，不再在"相关（向量近邻）"里重复。

**不做的（以及为什么）**

- 图谱层 / 新关系类型（如"决定引出的坑"）：无偏组里显式关联补不上的 21 槽中，只有约 3 槽属于"同主题但字面差得远"，这正是已搁置的场景分组（第 9、10 篇）要解决的，那两篇结论都是不如一次 `ab search`。
- 每轮召回带关联：每轮只有 3 条 / 600 字，本来就不是用来答多条题的（评测 13：全 3/34）；第 8 篇也测过每轮扩展 test 0 救回。
- 让抽取在 why 里写被否掉的方案（124 条决定里只有 17 条写了）：要改评测 12 钉死的 V1 提示词，必须另做一轮评测，先不动。

**怎么验收**：用评测 13 的两组题，按改后的实际输出重跑 `linked.ts` + `score_linked.py`，test 上关联题 ≥14/17、无偏组 ≥10/13，且输出中位长度不超过现在的 1.2 倍；`ab get` 对 34 道关联题里的历史题（9 道）都能看到旧版本 id。

### 11.7 Pi 底部状态栏显示 agentbrain（**已批准方案 B，实现中**，2026-10-20）

> 2026-10-20 10:20（新加坡时间）用户说"开始实现"。裁决：选方案 B；"待确认"只算每日复审清单（`ab review` / `reviewList`，即"到期待复审"的未确认条目），不算候选区；`/ab` 命令一起做。

**问题**：Pi 底部状态栏里 MCP、ponytail 都有一段状态，agentbrain 没有。用户看不出这一轮有没有召回、有没有东西等自己确认、后台抽取有没有坏。

**依赖的 Pi 接口（Mac 本机实读，pi-coding-agent 1.3.0）**
- `ctx.ui.setStatus(key, text | undefined)`：往状态栏放一段文字，传 undefined 清掉（`dist/core/extensions/types.d.ts:84`）。
- 内置 footer 把所有 status 按 key 字母序拼成一行（`dist/modes/interactive/components/footer.js:252`）。
- 用户实际用的是 pi-cc-extensions 1.0.4 的自定义 footer：没在布局配置里的 key 默认放第 2 行、按字母序（`footer-layout.ts:32,124`），所以 key `agentbrain` 会排在 `mcp`、`ponytail` 前面；**而且它把每段 status 的颜色剥掉、统一灰色**（`footer.ts:211 colorUsageChip = theme.fg("dim", stripAnsi(text))`）。所以状态只能靠文字和符号区分，不能靠红/黄。
- ponytail 的写法可参照：`c.ui.setStatus("ponytail", … theme.fg("muted", …))`（ponytail `pi-extension/index.js:86-98`）。
- 刷新时机用已有事件：`session_start`、`before_agent_start`（召回已在这里）、`agent_end`（`types.d.ts:1189,1209`）。`pi.registerCommand` 可加 `/ab` 命令。终端里状态栏不能点。

**显示什么（推荐方案 B）**

| 状态 | 文字 | 数据来源 |
|---|---|---|
| 本轮召回 N 条 | `🧠 ab 3` | 召回 hook 已返回的结果，扩展数条数，零额外开销 |
| 没召回到 | `🧠 ab 0` | 同上 |
| 召回失败 | `🧠 ab ⚠ 召回超时` / `⚠ ab 不可用` | 现在 `ab()` 出错时直接吞掉返回空，需要区分出错和没命中 |
| 有待确认 | `· 待确认 12` | 新 `ab status --line`（见下），0 时不显示 |
| 后台抽取有失败 | `· ⚠ 抽取失败 3` | 同上，取 `ab status` 里已有的窗口失败数；0 时不显示 |
| 话题开关、上次抽取时间等 | 不放状态栏，放 `/ab` | `/ab` 用 `ctx.ui.notify` 打 `ab status` 摘要 |

示意图（改前 / 改后各状态）：`assets/pi-status/all.png`，分图 `before.png`、`after-recalled.png`、`after-nohit.png`、`after-error.png`、`after-work-failed.png`。

**三个方案**
- A 只显示本轮召回条数：不加任何 ab 命令，零开销；但看不到待确认和后台失败，后者正是最容易被忽略的。
- **B（推荐）**：A + 待确认数 + 抽取失败数。待办数来自新加的只读 `ab status --line`，只在 `session_start` 和 `agent_end` 后台跑（不阻塞本轮，超时 3 秒就保留旧值），不在 `before_agent_start` 跑。
- C 再加话题开关、上次抽取时间、向量是否可用：太长，状态栏宽度有限，会把 ponytail 挤出屏幕；这些放 `/ab`。

**约束**
- 不加配置键（§2.2）：不提供开关，想隐藏用 pi-cc-extensions 自己的 `/ccstyle` 隐藏 key。
- 不读库：扩展照旧只调 `ab`。`ab status --line` 只读、输出一行 JSON（`{pending, work_failed}`），不触发 work。
- 不改召回内容和预算；条数只来自已经要注入的那段文字。为了数准，召回 hook 输出里补一个机器可读的条数字段，或扩展按固定条目前缀计数，实现时二选一并写测试。
- 子代理（inMemory 会话）不设状态。

**实现时的决定（2026-10-20，见评测 15）**
- 条数：Pi 扩展在 stdin 里传 `want_count: true`，ab 只在这时往 hook JSON 里加 `agentbrain: {recalled}`；没命中时输出 `{agentbrain:{recalled:0}}`。Claude/Codex 不传，输出逐字不变。常驻偏好不算召回条数。
- 抽取失败只数近 7 天的失败窗口（老失败要 30 天才被清掉，不能一直亮警告）。
- 扩展自己发起的 custom 轮次不召回，状态栏不变；旧版 ab 不给条数时显示"🧠 ab"；cwd 用 Pi 会话的 `ctx.cwd`。

**怎么验收**
1. 单测：扩展在命中 / 未命中 / ab 出错 / ab 超时四种情况下 `setStatus` 的文字；`ab status --line` 在空库、有待确认、有失败窗口时的输出。新测试在改前代码上必须失败。
2. 计时：在库副本上量 `ab status --line` 耗时（目标中位 < 300ms），以及加状态前后 `before_agent_start` 耗时不变。
3. Mac 实测：用临时 `AB_HOME` 起一个 pi，截图核对与示意图一致，且在 pi-cc-extensions footer 和内置 footer 下都能看到。

### 11.8 记忆看板：手动生成的 `ab view` 报告页（**已批准，实现中**，2026-10-21）

> 2026-10-22 pstack 复审后（用户同意修复）改动，覆盖下文对应文字：
> - 召回 hook 先输出召回内容，再在一个事务里写统计；锁等待 30ms，拿不到锁就不记这一轮（宿主要等 hook 进程退出，不能被 `ab work` 的写事务拖 5 秒）。只有 `--hook` 调用记 `recall_runs` 和召回注入；手动 `ab recall` 不记。
> - `inject_log` 只记 `recall` 和 `brief` 两种路径：常驻偏好不再逐次记（`prop_usage` 已有累计），`search`/`get` 从未写入，删掉；`rank` 列删掉。brief 不再扫进程认宿主，记成无会话的行，不计入"注入会话数"。
> - 标注率按召回轮一一对应：带有效 `ab-used` 的回复归到它之前最近的一次召回，那次是命中才记 `recall_runs.marked=1`；分子分母都来自 `recall_runs`，不会超过 100%。
> - `ab-used` 解析：段尾允许标点；分号总是分隔，顿号、逗号紧跟 `(id)` 时也算分隔。eval 16 的 69 行 `ab-used` 用新旧解析结果完全相同，数字不变。
> - 90 天清理挪到每次 `ab work`（非 dry-run）结尾，不再只在 `ab view` 时做。
> - 抽取时只去掉 `ab-used` 行，不删整轮（旧进度可能停在只有这一行的回复上）。
> - 托管块不再含 ab-used 两条，引用指令只在召回块里；`ab setup --cite on|off` 只改开关，不动宿主文件；`--notes` 先算好四个文件的计划再逐个用临时文件改名写入，`--adopt` 只换到下一个一级或二级标题为止。这改了 11:34 / 11:44 "宿主指令文件加说明、按开关写三条还是五条"的决定（用户 2026-10-22 同意按复审清单删）。注意：eval 16 的 on 组四个宿主文件里都有含 ab-used 的托管块，所以"只有召回块指令"的标注率和精确率没测过；打开开关前要补测。
> - `--share`、`--exclude-project` 和力导向布局移出本 PR（保留在 `feat/memory-viewer-share` 分支）；关联图改为每个连通块一个圆、块排成网格。11.8.6 暂不实现。

> 2026-10-21 11:55（新加坡时间）用户说"开始实现"。实现与本节文字的差异（实现时决定，待用户确认）：
> - 引用扫描放在 `ab view` 生成时做（读有召回注入的会话的 transcript），不放在会话抽取里；抽取输入里照样去掉 `ab-used` 行（`work.ts`）。理由：只手动生成，看板要的数在生成时才需要；不改抽取流程。
> - 托管块用独立命令 `ab setup --notes [--dry-run] [--adopt]` 安装，`ab setup --cite on|off` 会顺带同步；交互式的整套 `ab setup` 不自动迁移。
> - 宿主侧超时（如 Pi 扩展 3 秒杀进程）不经过 `ab`，`recall_runs` 记不到，看板上注明。
> - 首页"被注入过"只看新明细表；老 `prop_usage` 累计数单独显示，不混算。

> 2026-10-21 11:08（新加坡时间）用户裁决："用上"选 (b) 模型自报引用（注入格式改动见 11.8.9，因涉及 §11.3 仍待确认）；`inject_log`、`recall_runs` 两张表都加；只手动生成，不做过期自动重建、不用 launchd；分享只在内部，默认带正文、不遮项目名，`sanitize.ts` 脱敏始终开。整节仍是 CANDIDATE，等"开始实现"。
>
> 状态：CANDIDATE，未实现。用户 2026-10-21 提出：周期生成一个页面，看现在有哪些记忆、记忆之间的关联、每条的召回次数和使用情况；目的一是持续调 agentbrain 的准确率和可用率，二是对外分享时拿得出手。本节只写方案，等用户说"开始实现"再动代码。

**不新造页面，扩 `ab view`**。`ab view`（§21 2026-10-13，`src/view.ts`）已经是只读、自包含、无外部资源、0600 的 HTML，已有：条目卡片、筛选搜索、双向关联、向量近邻 top 5、PCA 向量地图、按项目/类型/状态计数。本方案在它上面加三块：**健康概览**、**关联图**、**注入/使用统计**，再加一个**分享模式**。

#### 11.8.1 现在库里有什么数据（2026-10-21 11:01 新加坡时间，正式库只读快照实测）

取数方式：在 Mac 上用 `sqlite3 "file:…?mode=ro" ".backup"` 把 `store.db`、`index.db` 拷到临时目录，对拷贝跑 `buildViewData`；正式库只做只读查询。

| 项 | 实测 |
|---|---|
| L2 条目 | 901 条；有效 557（decision 124 / note 55 / pitfall 242 / rule 136），候选 37，已归档 299，已替代 8 |
| 有效条目的确认状态 | 用户确认 220，未确认 318，代码核验 17，跨会话印证 1，与代码不符 1 |
| 有效条目来源宿主 | pi 175，claude 116，codex 83，无宿主（Pensieve 导入等）183 |
| 关联（`buildViewData` 双向计） | merged_into/merged_from 各 156，refines/refined_by 各 100，conflicts 18，supersedes 19 / superseded_by 8，待确认纠正 6；有效条目里带至少一条关联的 152 条 |
| supersedes 19 vs superseded_by 8 的原因 | 不是数据坏了，是投影规则：`src/l2.ts:445-458` 只有**有效且用户确认**的纠正才把旧条目改成"已替代"并写 `superseded_by`；未确认的纠正只挂到旧条目的待确认纠正上；纠正本身已归档、是候选或已被替代的直接跳过。19 条带 supersedes 的分布（2026-10-21 11:1x 只读快照）：有效+用户确认 5、有效未确认 7（目标有效 4、目标已归档 3）、已归档 2、候选 1、已被替代 4（用户确认 3、印证 1）。展示问题：`view.ts` 对后几类仍画"替代"箭头且不标状态，看板实现时要标出"未生效的替代"。 |
| 向量 | 901 条都有与当前文本一致的向量（可画地图） |
| L1 事件 | remember 901，relate 365，archive 299，evidence 174，unconfirm 72，confirm 31，verify 25，tag 5 |
| 抽取会话 | capture_sessions：pi 328，codex 231，claude 64，opencode 14；error_code=source_unavailable 14；capture_windows：done 262，deferred 7 |
| 注入计数 `prop_usage` | 138 条有记录，合计 3464 次，单条最多 546 次；最早 2026-10-14 10:56，最新 2026-10-21 10:54（新加坡时间）；有效条目里 425 / 557 条一次都没被注入过 |

**已有但口径要说清的：`prop_usage` 记的是"注入"，不是"召回"，更不是"用上"。**
- 写入点只有两处：`ab recall`（`src/cli.ts:182`）和 `ab brief`（`src/cli.ts:230`）。`ab recall` 的 `used` 数组在召回之后还会追加**常驻偏好**（`cli.ts:167` 注释：常驻偏好不算召回），然后整体 `markUsed`。所以单条 546 次这种高值，很可能是每轮都注入的常驻偏好，不是相似度召回出来的（未逐条核实）。`ab search`、`ab get` 不计。
- 只有累计数和最后一次时间：不知道哪次会话、哪个宿主、哪条路径（召回 / 常驻偏好 / brief）、排第几。
- 2026-10-14 才开始记，之前的使用没有。

**缺的：**
1. **注入明细**。要分路径、按会话计数（§9.4.2 LOCKED：按 Session 计，不按次数计），必须有逐次记录。
2. **"用上"没有可靠信号**。§9.4 已写明"真被用上"的信号尚无来源。页面上**不能**把注入次数标成"使用次数"。
3. 召回超时 / 失败次数没有落库（Pi 状态栏只显示当轮）。

#### 11.8.2 要补的记录（CANDIDATE）

新表放 `store.db`（工作区表，与 `prop_usage` 同类；**不进 L1**，它是遥测不是记忆，不参与投影；purge 时随范围一起删）：

```
inject_log(ts, host, session_id, project_id, prop_id, path, rank)
  path ∈ recall | pref | brief | search | get
recall_runs(ts, host, session_id, project_id, outcome, n_hits, ms)
  outcome ∈ hit | nohit | timeout | error
```

- 有界：保留 90 天，生成报告时顺手删旧行（§14.4 资源有界）。不存查询原文，避免把对话内容再落一份。
- `prop_usage` 保留不动，作为老数据的累计值。
- 写失败 fail-open，不影响召回。

**"用上"怎么诚实地量**，三个选项（都只做观测，不驱动任何状态变化）：
- (a) **不量**。页面只显示"注入次数 / 注入会话数"，"使用"一栏写"未测"。最诚实，零成本。
- (b) **模型自报引用**：注入块里给每条带短 id，提示模型用上时在回答里写 `[ab:xxxx]`；会话抽取时数回答里出现的 id。这是 §9.4 已列的候选信号。缺点：模型会漏写或乱写，只能信"写了"（上行），不能信"没写=没用"。
- (c) **回答文本重叠**：比较回答和注入条目的相似度。便宜但不准，技术讨论里重叠很常见，**不推荐**。

**用户已选 (b)**（2026-10-21）。具体格式、解析见 11.8.9。用户 2026-10-21 11:34 裁决：**不设精确率门槛**，模型标了就算"用上"并直接上页面，标错由用户反馈纠正；页面同时显示标注率，供用户判断可信度。

#### 11.8.3 页面内容与每块的数据来源

| 面板 | 显示 | 数据来源 | 现在能否做 |
|---|---|---|---|
| 顶部 KPI | 有效条目数、本周新增、待复审、注入覆盖率（7 天内被注入过的有效条目占比）、抽取失败数 | `Store.project()`、`reviewList`、`inject_log`/`prop_usage`、`capture_sessions`/`capture_windows` | 覆盖率按 7 天要新表，其余能 |
| 构成 | 类型 × 状态堆叠条、项目分布、宿主分布 | 投影 | 能 |
| 增长曲线 | 每天新增 / 确认 / 归档 | L1 `events` 按 ts 分组 | 能 |
| 关联图 | 节点=条目（大小=注入会话数，颜色=类型，描边=确认状态），边=refines / merged / supersedes / conflicts；默认只画有关联的条目；点击进详情 | `buildViewData().links` | 能（无需新数据） |
| 向量地图 | 现有 PCA 散点 | 已有 | 已有 |
| 单条详情 | 正文、为什么、来源会话、关联、近邻、注入时间线（30 天）、按路径拆分 | 已有卡片 + `inject_log` | 时间线要新表 |
| 调优清单 | 见 11.8.5 | 多处 | 大部分能 |
| 召回健康 | 每天召回次数、命中率、超时率、p50/p95 耗时 | `recall_runs` | 要新表 |

#### 11.8.4 怎么生成、多久生成一次

生成：`ab view`（已有），新增 `--share`（11.8.6）。仍是单个自包含 HTML，图用内嵌 SVG + 少量手写 JS（不引外部库、不联网，延续 `ab view` 的约束）。关联图布局在构建时算好坐标，浏览器只负责画。

**只手动生成**（用户 2026-10-21 裁决）：跑 `ab view` 才生成，不在会话开始时自动重建，不装 launchd。生成时间写在页面右上角，并显示"距今 N 天"，避免把旧数据当新的。90 天清理旧统计行也在 `ab view` 时顺手做。

#### 11.8.5 帮助调准确率的指标（"调优清单"面板）

每项都是**只给用户看的建议清单**，不自动改任何条目（§10.1 usage 不对称授权 LOCKED：disuse 不能驱动下行）。

1. **从未被注入的有效条目**（现 425/557）：分"太新"（<7 天）和"老而不用"。后者可能是 trigger 太窄、文本太长或本来没用，由用户决定归档还是改写。
2. **高频注入**：注入会话数前 20，标出其中未确认的（未确认却天天注入，最该先确认或纠正）。
3. **注入了但没用上**：等 11.8.2 (b) 有了才显示；之前显示"未测"。
4. **冲突未解决**：conflicts 18 + 待确认纠正 6。
5. **替代链**：链条长度、仍在被注入的已替代条目（应为 0，非 0 就是 bug）。
6. **抽取失败**：`source_unavailable` 14 个会话、deferred 7 个窗口，按宿主分。
7. **复审积压**：`reviewList` 条数和最老一条的天数。
8. **近重复**：向量余弦 ≥ 0.92 但没有任何关联的条目对（合并漏网；阈值需在测试库上定）。

#### 11.8.6 分享模式与隐私

`view.html` 里有完整正文、项目名、会话 id、家目录路径，**不能直接发出去**。`ab view --share --out <路径>`：
用户 2026-10-21 裁决：只在内部分享。
- **默认带正文和真实项目名**。
- **脱敏始终开、不能关**：所有正文、为什么、背景摘要过一遍 `src/sanitize.ts`（api_key / bearer / jwt / pem / credential / email / phone / id_card / home_path），再去掉会话 id、绝对路径、cwd。
- 可选 `--exclude-project <名>` 排除某个项目整组条目（例如客户项目）。
- 页面固定水印"分享版 · 已脱敏 · 生成时间"。
- 生成后打印"本页包含了什么"（条目数、带正文的项目、命中脱敏的次数），发出前自己看一眼。脱敏是规则匹配，不保证抓全，命令输出要明说。

#### 11.8.7 与 LOCKED 规则的关系

- **§9.4.2 计数口径 / §9.4 排期**：注入计数**只做展示**，不接使用成熟度、不影响排序和转正；单位以"会话数"为主，与 §9.4.2 一致。
- **§10.1 usage 不对称授权**：调优清单只给建议，"从未注入"不触发任何归档。
- **§13 安全隐私**：分享模式见 11.8.6；普通模式维持 0600、本地文件、无外部资源。
- **§2.2 配置预算**：不加配置键；保留天数、过期阈值写死，分享相关用命令行参数。
- **§5.1 L1 append-only**：注入记录不进 L1。
- 暂未发现直接冲突。张力：11.8.9 改动注入块（§11.3 合同的渲染），要用户确认后才算数；引用数据只做展示，若将来想拿它驱动 §9.4 的使用成熟度，必须按 §9.4.2 只信"写了"、按会话计、另行裁决。

#### 11.8.9 "用上"的测法：注入块里让模型标引用（**CANDIDATE，改 §11.3 渲染，待用户确认**）

**现状**：注入块已经给每条带了 8 位短 id（`src/recall.ts:150`、`:208`，`short()` 取 id 前 8 位），但没有要求模型用它。所以改动只是**加一句指令 + 事后解析**，条目本身格式不变。

**改前（现在实际注入的样子，条目为示例）**

```
<agentbrain-prefs>
用户的干活偏好（每轮常驻）：
- [3e1a9c0d] 说人话，结论写在回复正文里
</agentbrain-prefs>
<agentbrain-recall>
- [7f3c2a1b] 规则: 调用 pi 或 codex 做测试时，AB_HOME 指到临时库，并用 </dev/null 关掉 stdin
- [b81d44e7] 坑: 不要在 node_modules 里有全局软链的目录跑 npm i
</agentbrain-recall>
```

**改后**

```
<agentbrain-prefs>
用户的干活偏好（每轮常驻）：
- [3e1a9c0d] 说人话，结论写在回复正文里
</agentbrain-prefs>
<agentbrain-recall>
- [7f3c2a1b] 规则: 调用 pi 或 codex 做测试时，AB_HOME 指到临时库，并用 </dev/null 关掉 stdin
- [b81d44e7] 坑: 不要在 node_modules 里有全局软链的目录跑 npm i
（本轮回答若实际依据了上面某条，在回复最后单独一行写：ab-used: 简短标题 (id)，多条用；分隔。没用上就不写。）
</agentbrain-recall>
```

回复末尾的样子（示例）：

```
ab-used: 调 pi/codex 测试用临时库 (7f3c2a1b)；含全局软链的目录不跑 npm i (b81d44e7)
```

- 标题是给用户看的，方便一眼判断标得对不对；**程序只认括号里的 id**。
- 指令只放在 `<agentbrain-recall>` 里；常驻偏好不要求标（每轮都在，标了也说明不了相关性）。偏好的"使用"不进统计，页面单列"常驻"。
- 指令行不计入 `RECALL_MAX_CHARS`（600）预算，免得挤掉条目。

**怎么解析（按宿主）**：会话抽取本来就逐个宿主读对话（`src/transcript.ts` 的 `cleanTranscript`，opencode 走 `src/opencode.ts` 读 SQLite），在同一处加一步：取**助手回复**里以 `ab-used:` 开头的最后一行，按 `；` / `;` 切开，每段取末尾括号里的 `[0-9a-f]{8}`（全角半角括号都认），再与同一会话 `inject_log` 里**本轮之前确实注入过**的 id 求交集；不在注入记录里的 id 丢弃（防编造）。
- Claude Code：transcript jsonl 里 assistant 消息的 text 块。
- Codex：rollout jsonl 里 assistant 的输出消息。
- Pi：session jsonl 里 assistant 消息。
- opencode：SQLite 里 assistant 消息的 text part。
- **标题与 id 对不上时**：信 id，记一个 `title_mismatch` 标记（标题与该 id 正文的字面重合太低，阈值实现时定，只做提示），页面上在该次引用旁显示"标题不符"，供用户纠正时参考；不因此丢弃引用。括号里没有合法 id 的段丢弃。
- 写到 `inject_log` 增加列 `cited INTEGER`（0/1）、`cited_at`、`cited_title`、`title_mismatch`；按会话聚合时，一个会话内引用过就算 1（§9.4.2 按会话计）。
- 抽取时 `stripInjected` 已会去掉注入块；`ab-used:` 行也要从抽取输入里去掉，免得被当成内容沉淀。具体每个宿主的消息字段名在实现前按真实样本核对，当前未逐一验证。

**模型不照做时**：不写 = 记为"未标"，**不等于"没用上"**。页面显示"用上（模型自报）"次数/会话数，并按宿主、模型显示标注率（有召回的回合里写了 `ab-used` 的比例），不设门槛、不灰显。

**宿主指令文件里的说明（双保险）**：每轮召回块里的指令是准绳；另外在各宿主的全局指令文件里加一段 2–3 行说明，让模型提前知道这个约定。由 `ab setup`（已有 `src/setup.ts`，含 `backup()`）统一安装：
- 用标记块包起来，可重复运行、不重复插入；内容有变就整块替换；`ab setup --remove-notes`（命名待定）整块删除。
- 改之前按 `backup()` 现有做法备份原文件。
- **只动标记块内部**，块外用户自己写的内容一字不改。

2026-10-21 在 Mac 上只读核实的路径：

| 宿主 | 文件 | 现状 |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | 30 行，已有用户手写的"## 记忆（agentbrain）"段（无标记） |
| Codex | `~/.codex/AGENTS.md` | 11 行，已有同样的手写段 |
| Pi | `~/.pi/agent/AGENTS.md`（Pi 的 `resource-loader.js:116` 在 agentDir 下找 AGENTS.md / CLAUDE.md） | 77 行，第 73 行起是手写段 |
| opencode | `~/.config/opencode/AGENTS.md` | 9 行，只有 pstack 段，没有 agentbrain |

**托管块（用户 2026-10-21 11:39 裁决：现有手写段也收归 `ab setup` 管理）**

2026-10-21 在 Mac 上只读比对：三份手写段（`~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md`、`~/.pi/agent/AGENTS.md`）逐字相同，各 5 行（标题、空行、三条），且都在文件末尾。所以"并集去重"就是这三条，再加 used-note 两条（原三条合并了重复的 recall 说明）。托管块全文：

```
<!-- agentbrain:begin managed v1（由 ab setup 维护，勿手改；ab setup --remove-notes 可删除） -->
## 记忆（agentbrain）

- 记忆在本机 agentbrain 库（`~/.agentbrain/`）。按范围分全局和项目（项目即 pm 的 `repos/<项目>.md`），按种类分规则、决定、坑、事实；用户的干活偏好每轮常驻注入（`<agentbrain-prefs>`）。
- 怎么用：开工先跑 `ab brief`（子代理跑 `ab brief --worker`）；每轮相关记忆自动注入（`<agentbrain-recall>`）；要查用 `ab search <关键词>`、`ab get <id>`。与现场证据冲突时信现场。
- 干活时不写记忆：后台会从会话里自动抽取，直接生效并标未确认；审稿是可选的手动操作。只有用户明确要你记某件事时，才用 `ab remember --confirmed`（参数见 `ab --help`）。
- `<agentbrain-recall>` 里每条前面的 `[8 位 id]` 是它的编号。回答若实际依据了其中某条，在回复最后单独一行写：`ab-used: 简短标题 (id)`，多条用；分隔，例如 `ab-used: 调 pi/codex 测试用临时库 (7f3c2a1b)`。没用上就不写，不要为了写而硬套。
- `<agentbrain-prefs>` 里的常驻偏好不用标。
<!-- agentbrain:end managed -->
```

开关：最后两条（ab-used 说明）只在引用开关打开时写入（见下文"上线开关"）；开关关闭时托管块只含前三条，与现在手写段内容一致。

**迁移步骤（`ab setup` 首次运行）**
1. 对四个文件逐个：存在则先用 `backup()` 备份（与现有 hooks 备份同一套做法）；opencode 的文件不存在则新建。
2. 定位：
   - 已有 `agentbrain:begin managed` 标记 → 只替换标记之间的内容（幂等：内容相同则不写、不备份）。
   - 没有标记、但有**与上面三条逐字相同**的手写段（`## 记忆（agentbrain）` 起到下一个 `## ` 或文件末尾）→ 用托管块整段替换。
   - 有 `## 记忆（agentbrain）` 但内容**与已知文本不同**（用户改过）→ 不替换，报告差异，要用户加 `--adopt` 才替换（替换前已备份）。
   - 都没有 → 追加到文件末尾（opencode 走这一条）。
3. `ab setup --dry-run`：不写任何文件，逐个文件打印统一 diff 和将要做的动作（替换 / 追加 / 跳过 / 需 --adopt）。默认的非 dry-run 运行也先打印同样的 diff 再写。
4. 写完复读一次，确认文件里恰好一对标记。
5. `ab setup --remove-notes`：只删除标记块（含标记行），不恢复备份、不动块外任何内容；手写段因已被替换，不会自动回来（要回到旧状态用备份文件）。

**上线开关（用户 2026-10-21 11:39 裁决）**：引用指令（召回块里那一行 + 托管块里 ab-used 两条）实现时放在开关后面，**默认关**。开关打开前必须完成下面的上线前评测并经用户看过结果。开关的形式见 11.8.10 待定问题。

**成本**：每轮召回多一行指令，约 70 个汉字字符（粗估几十 token，按实际 tokenizer 实现时实测）；回复多一行。没召回的轮次零成本。

**对回答质量的风险**：
1. 回复末尾多一行机器标记，用户能看到。Pi/终端里不会隐藏。
2. 模型可能为了"标点什么"而硬套记忆（迎合）。
3. 模型可能标了但其实没用（虚报），或用了没标（漏报）。

**上线前评测（必做，用户 2026-10-21 11:39 裁决；结果记进 `docs/eval/`，约 20 个有召回的回合）**：
- 在临时库（`AB_HOME` 指临时目录、stdin 关闭）上，用测试集问题跑两组：不带指令 vs 带指令，同一模型（pi 的 `cpa/glm-5.3`、`cpa/deepseek-v4-pro`，最高推理等级）。
- 人工标注（我标、用户抽查）：每轮注入的每条记忆，回答是否真依据了它。
- 指标（按宿主、模型分开报）：引用**精确率**（标了的里有多少真用了）、**召回率**（真用了的里有多少被标了）、标注率；以及回答质量是否变差（沿用 eval 14 的评判方式，同时注意评判噪声）。
- 页面显示不设精确率门槛（11:34 裁决）；但**开关默认打开**要等评测完成、用户看过结果再定。评测只在测试库上跑，模型调用走 pi，AB_HOME 指临时目录、stdin 关闭。

#### 11.8.10 待用户回答的问题
已定（2026-10-21 11:34）：`ab-used` 行放回复末尾、带标题和 id；不设精确率门槛；宿主指令文件加标记块说明。

已定（11:39）：手写段收归 `ab setup` 托管；上线前评测必做；引用指令默认关，评测和用户审阅后再开。

已定（11:44）：
- **开关**：`ab setup --cite on|off`，状态存 store.db 的 `work_meta`（键 `cite`），默认 off。不占 §2.2 配置键预算。`ab setup` 按此状态决定托管块写三条还是五条；召回时读同一状态决定加不加指令行。
- **评测**：四个宿主（Claude Code、Codex、Pi、opencode）都跑真实会话。全部 `AB_HOME` 指临时库、stdin 关闭。Pi 用 `cpa/glm-5.3` 与 `cpa/deepseek-v4-pro`，最高推理档；其余三个用各自已配置的模型、最高 effort。每个宿主把确切参数（版本、模型名、effort、命令行）写进 eval 文档。

仍未定：无。等用户说"开始实现"。

#### 11.8.8 样图

box 上 `/workspace/agentbrain-review/viewer/`：`overview.png`、`graph.png`、`detail.png`、`mockup.html`。样图里的总数、类型/状态/宿主分布、关联数、抽取失败数、注入覆盖取自 11.8.1 实测；条目正文、关联图节点、时间线、召回健康曲线是**示例数据**，页面上标了"示例"。

### 11.9 记忆用没用要看得见，什么时候查由模型定（**已批准，实现中**，2026-10-29）

> 状态：用户 2026-10-29 说"开始改吧"，11.9.6 三问按推荐定；入口对比评测改为 Claude Code、Codex、Pi 三个宿主（用户同日指定）。本节替换 2026-10-28 的初稿（初稿推荐保留自动召回，没对准痛点）。方案经 astra（`cpa/gpt-6-astra` xhigh）只读讨论，主会话逐条对代码核实后定稿，讨论记录见 pm `docs/agentbrain/2026-10-28-memory-visibility/tasks/01-astra-plan-discussion.md`。

**实现与本节文字的差异（2026-10-29 review 修复）**：
- 查询发生与条目交付分开记录。`memory_queries` 保存 search/get 的宿主、会话、时间、来源路径；零结果 search 也记录，不在 `inject_log` 里伪造 id。主动查询率按查询事件算。
- 宿主解析器标记完成回答。Claude Code 认 `stop_reason=end_turn`；Pi 认 `stopReason=stop`；Codex 认 `phase=final_answer` 或无错误 `task_complete.last_agent_message`；opencode 认已完成且无错误、不是工具继续执行的消息。只有这些回答进入报告与引用结算，进度、模型失败、仍在运行的轮不进入。
- 钩子记录先按用户轮的时间边界一一匹配，包括没有完成回答的轮。没有对应钩子的轮不继承上一轮的显示开关，查询起点不再使用 5 秒容差。报告和引用在同一事务里清除旧派生值后重建。
- 真实宿主验证统一使用 `.agents/skills/verify-agentbrain/hosts.ts`（`verify.sh hosts [claude codex pi opencode]`）。它显式隔离测试库，按每次运行的会话断言，并只读核查正式库没有这些测试会话。场景：主动查询、常驻偏好、明确未用、缺报告、零结果搜索；Pi 另用本机 mock 提供商造出“进度 + 工具 + 模型失败”的轮，断言它不结算成报告。宿主没登录或额度用完记 BLOCKED，不冒充通过。

**第一轮实现核对**：
1. **采用报告持久化结构**：方案 11.9.3 留待实现决定数据落点。实现采用独立工作表 `memory_reports`（按轮记录状态、开关、主动查询标志）与 `memory_report_ids`（按条记录自报 id、对应 prop_id、是否核对通过与标题吻合度），不挤压 `recall_runs`，直接聚合报告率、采用率、主动查询率和无法核对数。
2. **主动查询率分母对齐**：看板四个指标中，报告率、采用率、主动查询率的分母均对齐为开关开启的轮次数（`citeReps`），确保分子不超过分母且指标口径统一。
3. **交付记录识别容错**：`ab brief`、`ab search`、`ab get` 交付时异步检测宿主与会话编号；检测失败或无法归属时 host 与 session_id 记 NULL，不猜、不影响原命令正常输出。

#### 11.9.1 痛点（按重要性）

1. **回答结束时看不出记忆起了什么作用**。用户想看到的是"这次沿用了哪个决定、避开了哪个坑、遵守了哪条偏好"，而不是去理解召回、注入和统计表。
2. **没有标注时只能猜**。现在回答末尾没有那一行，可能是没有相关记忆、模型没采用、模型忘了标，也可能是开关没生效或统计没扫描，几种情况看起来一样。
3. **按这一句话的字面相似度替模型挑记忆不合适**。"继续""先改设计文档"这类话要结合前文才知道该查什么，应该由模型按整个任务决定查不查、查什么。
4. **显示是个人喜好，记录是另一回事**。不想在回答里看到标注，不应该连记录也一起丢掉。

#### 11.9.2 核实到的现状（2026-10-29 只读）

- 引用开关 10-28 07:28Z 打开后，到 08:48Z 最后一次扫描为止：Claude 召回 23 轮、命中 4 轮、标注 0 轮；Pi 10 轮、命中 7 轮（1 轮失败）、标注 2 轮；另有 6 轮召回没有宿主身份。
- 标注只覆盖召回块：引用指令只挂在召回块末尾（`src/telemetry.ts:12`），核对只认本会话 `path='recall'` 的注入（`:172`），偏好、brief、模型自己 `ab search` 查到的都没法标。
- 统计会过时：引用扫描只在 `ab view` 时跑（`src/cli.ts:809`），`ab status` 不扫；`sessionsToScan` 只看有召回注入的会话（`src/telemetry.ts:207`）。
- `ab` 在 shell 里能拿到会话编号：四个宿主的环境变量见 `src/host.ts:24-29`（初稿说拿不到，错）。本会话的 Claude Code shell 里实测有 `CLAUDE_CODE_SESSION_ID`；opencode 的 shell 里有没有 `OPENCODE_SESSION_ID`，实现前要实测。
- 会话清洗会把 ab 命令和它的输出整个去掉（`src/transcript.ts:131`、`:160-171`），不能拿清洗后的记录去找"模型查过什么"。
- eval 17 最新数字：Pi 19/19、Codex 18/19（`docs/eval/17-cite-recall-only.md:54-75`），而且只在测试库里测过。这说明模型愿意标，不说明自动召回比模型自己查更好。

#### 11.9.3 方案

**每轮钩子注入什么**

1. 常驻偏好：不变（用户 2026-10-28 已定）。
2. **不再按本轮提问自动检索、注入记忆**。召回代码保留，下面 A 组评测要用。
3. 一句提醒，查不查由模型定：

```
<agentbrain-recall>
要不要查历史记忆由你判断：涉及以前的决定、陌生模块或可能踩过的坑时，先 ab search；上下文已经够了就不用查。
</agentbrain-recall>
```

4. 显示开关打开时，再加一句报告要求（见下）。这句不再依赖召回命中，每轮都有。

开工的 `ab brief` 不变（用户 2026-10-28 已定）。

**用户看到什么（显示开关打开时）**

每个最终回答末尾固定一行，模型自报：

```
记忆：沿用"前端槽位不改"的决定 (8b6bf402)；遵守"汇报写在正文"的偏好 (2352b4ab)
```

没用上任何记忆时也要写：

```
记忆：本轮未用
```

- 范围包括常驻偏好、brief、模型自己查到的和前几轮已经拿到的记忆，不只是本轮刚查到的。
- 只有真正影响了结论或做法的才写；看过、提到、驳斥过的不算。
- 因为规定开关打开时每轮都有这一行，**缺了这一行本身就说明"模型没报告"**，不会再和"没用记忆"混在一起。第一版不另做宿主侧的漏报提示。
- 程序只认括号里的 8 位 id，标题是给人看的（沿用 §11.8.9）。旧的 `ab-used:` 行继续能解析。

显示开关关闭：不加报告要求，回答末尾什么也不加。

**记录什么**

1. **交付记录**（程序知道，不需要模型配合；开关开不开都记）：`ab brief` / `ab search` / `ab get` 在命令里按 `src/host.ts` 的会话环境变量，把实际返回的 id 写进 `inject_log`（`path` 记 brief/search/get，带宿主和会话）。拿不到会话编号就记成"无法归属"，不猜。常驻偏好不逐次记（`prop_usage` 已有累计），核对时把当前的常驻偏好 id 算作已交付。
2. **采用报告**（模型自报；只有开关打开时才有）：按轮记一条，状态分三种：采用（带 id）、明确未用、未报告。id 必须在本会话之前交付过，或者是常驻偏好；对不上的记"无法核对"，保留下来，不再一律当成编造丢掉。
3. **扫描时机**：引用扫描除了 `ab view`，也在 `ab work --sweep`（launchd 每 30 分钟）里跑；要扫的会话从"有召回注入"放宽到"有任何交付记录或登记过的会话"。看板显示最后一次扫描的时间。
4. 统计口径：报告率（每轮有没有那一行）、采用率、主动查询率分开算。不再拿"命中轮里有没有 `ab-used`"代表"用没用上"。

**Pi 状态栏**

自动召回去掉后，"本轮召回 N 条"没有意义了，去掉这一项；待确认、抽取失败等其他项不变。

**不做**

- 隐藏模式下也记录"用了什么"（`ab use` 自报命令）：可以做，代价是每轮多一次工具调用和一次模型往返，而且工具调用照样会出现在界面的工具记录里。用户自己是开着显示的，等真有人要关显示时再做（见 11.9.5 第 2 问）。
- 不加 MCP 服务，不用后台模型或相似度去猜"用了哪条"，不用 Stop 钩子逼模型补写。

#### 11.9.4 上线前验证

1. **查询入口对比**：在 Claude Code、Codex、Pi 三个宿主上跑三组（A 组用改动前的提交，不为评测加开关），显示和报告规则相同：A = 现有自动召回；B = 只靠 brief 里的搜索说明，模型自己查；C = B 加每轮一句提醒。
   - 准备 12 个任务，覆盖：明说"以前定过"的；没提历史但确实有相关旧坑的；完全不需要记忆的；多轮里的"继续 / 按那个改"；只受常驻偏好影响的；查到了但不该采用的。
   - 先定任务、标出需要哪些事实，再看检索结果，不按记忆原文反过来出题。
   - 指标：需要记忆的任务做没做对；该查没查的比例；不需要却去查或硬套的比例；报告完成率；自报和回答内容是否一致；工具调用次数、token、耗时。
   - 判定：C 比 B 没有少漏查，就去掉提醒；B/C 漏掉了 A 能挡住的重要旧坑，把具体例子交给用户裁决，不偷偷留下自动召回。
2. **四个宿主各跑一遍真实闭环**（临时 HOME 和测试库；Codex 要确认 shell 和钩子都指向测试库）：只用了偏好；只用了 brief；没提醒也主动查到并采用；查到了但没采用；采用的是前几轮拿到的；故意不写那一行，记成"未报告"；两个会话同时跑不串号。证据放 `~/.cache/verify-evidence/agentbrain/`。
3. 报告完成率（含"本轮未用"）目标 ≥95%。这是提议的验收线，不是已有结果。采用是否准确按 eval 16 的方法逐条核对，用户抽查。

#### 11.9.5 成本

| 项 | 变化 |
|---|---|
| 每轮上下文 | 去掉命中时 ≤600 字符的召回块和每轮的向量请求；加一句提醒；开关开时再加一句报告要求 |
| 主动查询 | 模型需要时才发生；`ab search` 返回前 8 条全文加 8 行摘要，单次比召回块长 |
| 显示开时 | 回答多一行，不多调模型 |
| 记录 | 本地写库，不调模型 |

没实测之前，不承诺总 token 或耗时会下降。

#### 11.9.6 用户拍板（2026-10-29：三问都按推荐，"开始改吧"）

1. 同意默认关掉按本轮提问的自动召回，改成"偏好常驻 + brief + 模型自己查 + 一句提醒"吗？提醒要不要留，由 11.9.4 第 1 项的对比来定。
2. 隐藏模式下记录"用了什么"这次先不做（每轮要多一次工具调用），同意吗？
3. 摘要行覆盖偏好、brief 和主动查到的记忆，没用上时也写"记忆：本轮未用"，同意吗？

### 11.10 规则按场景打标签，开工按场景加载（**已实现并合并**，2026-10-30）

> 状态：用户 2026-10-30 提出"品味规范不是所有场景都要全量加载，按 tag 区分，召回时有针对性"，同日选"开始做场景标签：写设计、派 astra review、再派实现"。来龙去脉见 pm `docs/agentbrain/2026-10-30-scene-tags/README.md`。

#### 11.10.1 痛点（2026-10-30 核实）

1. **规范进不了开工摘要**。用户 10-30 定稿的 23 条全局品味规范（总纲 G、设计 D、开发 C、review R，`ab search 品味规范`）全是全局规则。brief 每段按 seq 倒序、放不下整条跳过（`src/brief.ts:20-31`），全局段只有 2000 字总预算里均分的一份（`:7`、`:40-50`）。实测 pm、data-asset、ai-data 三处：全局段被 G、D 占满，C、R 一条都显示不出来，原有的其他全局规则（推 main、MySQL 767 字节、派活走 herdr）全被挤掉。
2. **场景不对的规则是噪音**。调研、验证、写 pm 文档的活用不上设计和 review 规范；review 只需要检查清单。
3. **模型不会自己去查**。§11.9.4 评测：看起来像普通编码题时，B/C 组几乎都不 `ab search`（pm `docs/agentbrain/2026-10-28-memory-visibility/tasks/10-eval-resume-codex.md`）。规范正是这类，靠提醒拉不动，要在已知场景的地方推给模型。
4. **场景在哪儿已知**。主会话写的派活单都有 `- 类别：` 行（编码 / review/代码 / review/方案 …），`tools/herdr-dispatch` 已经读它（`card_category`）。主会话自己的场景随轮次变，开工时不知道。

#### 11.10.2 方案

**数据**：条目多一个 `scenes`，取值只有 `design`（设计）、`code`（开发）、`review`，可多选；空表示不分场景。和 `guidance` 一样走现有 `tag` 事件改元数据，不改正文：

- `RememberBody.scenes?: Scene[]`、`TagBody.scenes?: Scene[]`（整组替换，`[]` 清空）；投影 `Proposition.scenes: Scene[]`，旧数据缺字段为 `[]`。
- 写：`ab remember … --scene design,code`；改：`ab tag <id 前缀> --scene design,code`，`--scene none` 清空。取值在 CLI 边界校验，未知值直接报错退出。tag 事件按字段是否出现更新：没给 `scenes` 不动，给 `[]` 才清空（不能写成 `b.scenes ?? []`）。
- 只对规则有意义（坑和决定本来就按项目给）；`--scene` 配非 rule 报错。
- 不和常驻偏好叠加：`scenes` 非空与 `guidance=true` 互斥，`ab tag --scene` 和 `ab guidance` 两个入口都检查并报错。写入方绕过了这两处检查时也不到每轮注入：`guidanceBlock` 跳过 `scenes` 非空的条目（兜底）；`ab curate` 遵守同样合同，带场景的条目转正时不打 guidance，改写生成的新条目复制旧条目的 `scenes`（和 `correct` 一样），带场景时不带 guidance。
- 纠正继承：`ab correct` 把旧条目当时的 `scenes` 写进新的 remember 事件（和现在复制 `for_workers` 一样，`src/cli.ts:654-661`）；要换标签另跑 `ab tag`。Pensieve 重导的替代（`src/pensieve.ts`）同样复制。

**brief**：

- 带场景的规则**不进通用全局段 / 项目段**，原来被挤掉的规则回来。
- 场景只来自 `--scene <s>[,<s>]` 参数（不读环境变量：环境变量跟进程走，`send` 换任务和嵌套启动都会带错场景）。
- **先定范围再筛场景**：项目目录（或显式项目名）取全局 + 本项目的规则；pm 目录和未登记目录只取全局。`--worker` 时全局规则要求 `for_workers`，本项目规则不要求（项目记忆本来不能带 `--for-workers`）。
- 有场景时多一段「场景规则（<场景>）：」，收范围内 `scenes` 与之相交的已确认规则，按 seq 倒序，整条取舍；单独预算 `BRIEF_SCENE_MAX_CHARS = 2000`（写死），放不下的计入提示 `ab search --scene <场景>`。整个 brief 的上限改为 `BRIEF_MAX_CHARS + BRIEF_SCENE_MAX_CHARS`，各段先按自己的预算整条取舍，末尾硬截断只作兜底；`markUsed` / `inject_log` 记的必须是最终实际输出的 id。
- 没有场景时只多一行索引（用同一范围计数）：`场景规则：设计 N / 开发 N / review N 条；进入该场景先 ab search --scene <场景>`（N 为 0 的场景不列；一条都没有时整行不出）。
- 头标签带上场景，便于核对：`<agentbrain project="x" worker scene="code">`。

**search**：`ab search --scene <s>` 列出范围内该场景的全部规则（全文，按 seq 倒序，直接遍历投影，不走混合检索），照常记交付。`--scene` 不和关键词同用（同用报错）：混合检索两条通道都先截断再融合，事后过滤会漏（review 第 3 条）；场景内条目少，全列即可。

**派活**：`tools/herdr-dispatch` 在 `start` 和 `send` 时按派活单类别算场景，在发出的文本里加一行显式指令「开工跑 `ab brief --worker --scene <场景>`（代替不带 --scene 的那次）」。这一行放在 pstack 命令前缀**之后**、单子正文之前，`/pstack`、`/skill:pstack-*` 仍在第一位（Pi 只认开头的斜杠命令）；opencode 的前缀是自然语言，同样放其后。

| 类别 | 场景 |
|---|---|
| `编码`、`编码/*` | `code` |
| `review/代码` | `review` |
| `review/方案`、`review/技术`、其他 `review/*` 和 `review` | `design,review` |
| `调研*`、`验证*`、空 | 不加这一行 |

**主会话**：pm `CLAUDE.md` 加一句：写方案前 `ab search --scene design`，验收 review 前 `ab search --scene review`。

**23 条规范的标签**（实现合并后由主会话用 `ab tag` 打）：G1–G3 → `design,code,review`；D1–D3、D7 → `design`；D4–D6、D8 → `design,code`（D8 是动手改表、接口前的门槛）；C1–C8 → `code`；R0–R3 → `review`。R2 先 `ab correct` 成自带判断标准的检查清单（不再只写 D2、C3 这类编号），review 场景就不用加载 D、C 全文。

#### 11.10.3 不做

- 不在每轮钩子里按提问猜场景自动注入（§11.9 刚去掉自动召回；先看派活这条路的效果）。
- 不做通用自由标签。场景是封闭的三值，派活类别到场景的映射写在 `herdr-dispatch` 一处。
- 不改导入的 data-asset 原条目；它们去留另行决定。

#### 11.10.4 验收

1. 单测（先红后绿）：投影 `scenes`（remember、tag 替换、没给字段不动、`none` 清空、旧数据缺省、correct 继承）；brief 有场景 / 无场景 / `--worker` / pm 目录 / 未登记目录 / 项目目录，项目甲的场景规则不出现在项目乙；带场景规则不出现在通用段；场景段预算、提示和总上限；`markUsed` 与实际输出 id 一致；`--scene` 非法值、配非 rule、与 guidance 同用报错；search `--scene` 列全、与关键词同用报错。`herdr-dispatch`：类别到场景的映射和指令行位置（带 pstack 前缀时仍在前缀之后）。
2. 真实库：给 23 条打标签后，`ab brief data-asset` 的全局段恢复显示 29f68f98 等原规则，并有索引行；`ab brief data-asset --worker --scene code` 含 G、C、D4–D6、D8，不含 R。
3. 真实派活：用 `herdr-dispatch` 派一个 `review/代码`、`- pstack：` 非「无」的免费模型试运行单，pi 会话记录里 pstack 技能照常展开，`ab brief --worker --scene review` 的输出含 `scene="review"` 和 R0；再派一个 `调研` 单，没有场景指令行。按坑 3bf3029b，再看 review 单的回答有没有按 R0 回答"会不会重选路线"。

### 11.11 场景分组目录（CANDIDATE，2026-10-15，10-22 复核；继续搁置）

现状：已在 §5.5 覆盖 Scenario View 不成为 canonical writer，§11.5 已记场景目录评测后改走搜索提示。本节补齐候选分组的合同，不恢复 PR #56 的实现授权。`BRIEF_MAX_CHARS` 仍为 2000（`src/brief.ts:7`），超预算仍显示"还有 N 条放不下"（`src/brief.ts:68`）。任务单给的 data-asset 184、ai-data 131、全局 112 是 10-15 的 active 数，不是本次实测，也不等于有资格进入 brief 的条数。当前 brief 只展开已确认的规则与坑，决定和事实另给计数（`src/brief.ts:100-115`）。

已有反证不能略过。[评测 09](../eval/09-scene-simulation.md) 不支持每轮场景扩展；[评测 10](../eval/10-scene-directory-session-start.md) 的 15 道 test 中，brief 加打开场景得分 0.667，一次搜索为 0.767～0.80，场景输出字符约为搜索的三倍。PR #56 因此搁置。目录仅保留"知道未展开内容有哪些方面"这一候选用途，不替代 search，也不进每轮召回。下面的分组抽查合格只是必要条件，重新启用仍需新的概览任务证据及用户明确授权。

#### 11.11.1 只存分组，不生成记忆

一个场景的语义内容只有标题与成员条目 id。全局单独一组范围，每个项目各自分组，不混成跨项目场景。正文、why、引文与来源完全不变，标题不是可引用的事实或用户指令。成员可以是已存在的 rule、decision、pitfall、note，不产生新的 kind。

L1 不写场景事件，不反向修改成员。L2 只提供当前有效成员及读取资格，不调用模型生成场景。L3 在 `index.db` 存标题、成员 id 与必要的缓存键和构建水位（`src/store.ts:5`，§12.2）。这里的表结构是候选设计，当前分支没有场景表。删除该库后可以从 L1/L2 和重新计算的向量恢复分组；模型标题允许重建后换措辞，不承诺非确定性标题逐字一致。记忆正文和同样输入下的确定性成员分组必须一致。

分组先沿用评测 10 测过的算法作为候选基线，不宣称它已经更好：按范围使用已有记忆向量的余弦相似度，叠加 scenario 二字词 Jaccard 相似度的 0.15 倍，以 average linkage 合并，门槛 0.50。Jaccard 指两份 scenario 二字词集合的交集大小除以并集大小；average linkage 指两组间所有成员对的平均相似度。按成员 id 排序并在同分时用 id 定序，避免遍历顺序改变结果。参数为代码常量，需用下面的抽查验证，不加配置键。只在固定算法与向量模型版本内要求结果一致。

scenario 取 L2 的 `value.scenario`，缺时使用已有 trigger；抽取 schema 见 `src/extract.ts:338`，一步式存储见 `src/work.ts:1009`。不从原会话重抽场景。没有 scenario 或当前向量的条目暂列"未分组"，不得从数量里消失，也不让模型补写场景。每个资料齐全的条目只归一个场景，孤立条目可以独成一组，不为压目录数量硬合并。

模型只看脱敏后的成员 scenario 与短正文，起一个不超过 24 字的标题，没有写文件或改记忆工具。按"范围、排序后的完整成员 id 集合"缓存标题，成员不变就不重新起名。模型失败时，用该组按 id 排第一条的已有 scenario 作临时标题并注明"待命名"；它不是新的事实。成员集合变化后不用旧标题，先显示临时标题。模型标题写库前仍做脱敏，标题和缓存都纳入 Purge 的清除范围。

#### 11.11.2 重建与上限

候选入口是 `ab work` 完成关系判定、核验后维护 L3，另给手动等价操作 `ab scene --rebuild`。`ab scene` 是本节拟议命令，当前基线没有实现。沿用已有 CLI，不加常驻服务或定时器。

以下变化使受影响范围失效：成员新增、归档、恢复、替代、纠正、Purge、准入或确认状态变化、scenario 或向量内容变化。L3 缺失、算法版本或向量模型版本变化也要重建。用 L1 水位检查跨进程写入，用分组输入的指纹避免无关事件导致重算。读 brief 不计算向量、不调用标题模型。它只读当前缓存并复查成员资格。

单次维护的候选上限全部写成代码常量：最多重建 2 个范围，每个范围最多 1000 条有效成员；每次最多 1 次标题调用，处理最多 10 个场景、输入合计不超过 6000 字，超时 60 秒，不在同次运行重试。范围轮转，未处理部分记为可重算的待建状态，不影响 intake、L1 或 work 已完成的结果。范围超过 1000 条时不发布截掉尾部的分组，报告"场景目录超出单次构建上限"并继续用搜索；届时按实际规模再评估算法。

分组与命名分开发布。确定性分组完成即可带临时标题供读，模型失败不导致丢成员。提交 L3 前复查 L1 水位与输入指纹，变了就丢弃本次结果、下次再建，不发布旧快照。Purge 或资格变化后，受影响场景的标题与缓存先停止服务，不能只删成员却保留泄漏原内容的标题。重建失败不回写 L1、不影响原有 search，doctor 报待建、未分组与失败数量；这些诊断随 L3 删除可重算，不是权威工作队列。

#### 11.11.3 brief 与按需打开

brief 的总预算仍是 2000 字符。保留 §11.5 搜索提示、未确认计数及原有读取资格；目录只统计有权读取、已确认、当前有效而未在 brief 展开的成员。决定和事实可以进入目录，不能把所有 active 数当成"放不下"。候选区与未确认条目不经目录泄漏标题或数量。

拟议格式为 `范围 [场景编号] 标题（N 条未展开）`。N 是当前调用者可读且未展开的成员数，不是完整场景大小。编号由范围与完整成员集合的 hash 得到，显示 12 位前缀，不用每次重建会重排的序号；前缀不唯一时显示更长前缀。缓存失效的旧编号只提示重新读取目录，不能指向另一组。

为目录预留最多 400 字符，最多 6 行，先按未展开条数降序，同数按范围和编号排序。超出的写"另有 N 个场景、M 条未展开，用 ab scene 查看目录"。一个场景有部分不可读成员时不复用全组模型标题，改用可读成员已有 scenario，并且不暴露不可读成员数量。子代理沿用 for_workers 与项目边界，未登记目录只给全局。未分组成员单列"未分组（N 条）"，计入同一目录预算。缓存缺失或失效时显式显示"场景目录待重建，仍有 N 条未展开，可用 ab search"，不在开工热路径上补建，不把缺目录伪装成没有记忆。

`ab scene` 列当前范围目录，`ab scene <编号>` 打开原条目，`ab scene --project <项目>` 选择登记项目，子代理使用 `--worker`。展示沿用 search 的正文、为什么、场景与状态，进一步来源展开仍用 `ab get --expand`。打开完整场景时会包括已在 brief 展开过的可读成员，所以同时显示完整可读成员数。每页最多 20 条，剩余用拟议 `--offset` 继续，不把大场景一次全塞进上下文。命令在返回前重新检查成员存在、状态和读取范围，不把成员自动跟随到跨范围的新条目。

下面是合成数据的前后示意，省略相同的已有规则正文与尾部提示。不是本次运行输出，也不是功能已上线。

改前：

```text
<agentbrain project="ai-data">
全局规则与坑：
[此处为已展开的规则]
ai-data 的坑与规则（最近在前；与现场证据冲突时信现场）：
[此处为已展开的坑]
决定 4 条、事实 2 条：用 ab search 查，ab get 看当时的讨论。
还有 12 条放不下，用 ab search 查。
[保留原有的搜索提示与未确认计数]
</agentbrain>
```

改后：

```text
<agentbrain project="ai-data">
全局规则与坑：
[此处为已展开的规则]
ai-data 的坑与规则（最近在前；与现场证据冲突时信现场）：
[此处为已展开的坑]
未展开的已确认记忆。目录不是新规则，用 ab scene <编号> 看原条目：
- ai-data [0123456789ab] 当验证 e2e 时（8 条未展开）
- ai-data [abcdef012345] 当排查查询结果时（6 条未展开）
- 全局 [123456789abc] 当汇报验证结果时（4 条未展开）
[保留原有的搜索提示与未确认计数]
</agentbrain>
```

示意中 12 条未放下的规则与坑，加上 6 条未展开的决定与事实，合计 18 条。实际实现要先扣目录预算再排条目，再计算未展开数；缩短目录时不能丢计数或截断单条命令。没有遗漏就不显示目录。

#### 11.11.4 验收与不做的事

先抽查全局、data-asset、ai-data 各 4 个场景，每个范围取最大组、最小多成员组，再以固定种子 20261015 随机取 2 组；不满 4 组就全查。每组最多检查 10 个成员，由人分别回答"是否属于标题描述的同一类使用情境"和"标题是否引入成员没有说过的内容"。通过标准为至少 90% 成员符合情境、至少 11/12 个标题贴切，范围与权限泄漏为 0，正文/引文/来源改动为 0。样本少于 12 组时标题通过率仍需达到 90%。记录样本 id 与逐条判据，不能只给模型打分均值。

再验证空库、无 scenario、无向量、命名超时、1001 条范围、归档/恢复/Purge、worker 过滤与跨进程失效。brief 必须不超过 2000 字符，目录各场景未展开数、未分组数与尾部汇总之和等于所有合格未展开成员数。删除 index.db 后按限额多次重建，原记忆与成员集合不变。全部命名完成后再连续跑两次，成员不变时标题调用数为 0；尚未命名的组仍按上限补做。Purge 后旧标题不得恢复。场景维护本身只涉及派生数据，不能在这些检查的原有生命周期事件之外新增 L1 事件。

只有上述检查仍不足以重新启用。另固定 20 道需要至少两条记忆的概览题，三个范围都覆盖，由用户先确认标准答案。比较"当前 brief 加一次 search"与"目录加打开一个场景"，后者答全率至少多 2 题，输出中位长度不超过前者的 1.2 倍，才建议重开。未达标继续搁置，不靠调整 test 标注或不断试门槛取得通过。评测 10 的单条题继续作为对照，不把新评测伪装成对旧结果的推翻。

不写叙事，不推断隐性信号，不合并或删除记忆，不新增热度计数。叙事改写、隐性推断与合并删除会破坏逐条对回原始证据的要求；现有一步式无引文的条目不能因此被补称为用户原话。不新增 heat 的理由不同，`prop_usage` 已存在（`src/store.ts:81`、`src/store.ts:263-276`），重复计数既无需求也不是分组依据。标题只用于导航，不能转成 Skill / SOP、用户画像或新的写入源。

---

### 11.12 记忆看板重做：只重做首页（2026-11-10 用户同意简化方案）

> 2026-11-10 用户同意简化方案：原三视图草案经 kimi k3.1 pro review 报 2 阻断后收窄。阻断 1：「真实引用」不是记忆之间的关系，`memory_report_ids` 只存「回复 × 记忆」，没有「记忆 × 记忆」的边，画不出真实引用网络。阻断 2：新增 `view-standalone.html` 没继承 §11.8.6 的分享隐私合同。简化：只重做首页，保留现有分析页，删掉视图 3 和双输出。

**结论**：现有 `ab view` 首页是一堆 KPI 数字，用户说「太垃圾了」。只重做首页：一句话概览 + 90 天时间轴 + 类型×项目矩阵 + 一个标明「模型判定的关系」的力导向图。保留现有分析页（关联图、记忆列表、向量地图）不动。单文件输出，不新增依赖。

#### 11.12.1 用户要答的问题（2026-11-10 原话整理）

| 优先级 | 问题 | 现有看板 |
|---|---|---|
| 1 | 炫酷，能给别人展示 | 5MB 单文件、朴素表格，不能 |
| 2 | 哪些**类型**的记忆被召回得多 | 只有总数，没有按类型拆 |
| 3 | 记忆有没有**真的**关联起来（真实引用，不是模型判的关系） | 关联图是模型判的关系，不是真实引用 |
| 4 | 每个项目下有哪些类型的记忆，全局的长什么样 | 有项目筛选但没有项目×类型交叉视图 |
| 5 | 记忆之间的真实引用网络 | 向量地图是 PCA 投影，不是引用关系 |

#### 11.12.2 首页内容

1. **一句话概览**：「N 条有效记忆，M 个项目，过去 90 天召回 X 轮」。召回轮数按 `recall_runs` 算，不按 `inject_log` 条目数（一轮召回 5 条算 1 轮）。
2. **90 天时间轴**：每天新增记忆数 + 召回轮数，双线图。数据来自 `recall_runs` 和 L1 事件时间。
3. **类型 × 项目矩阵**：热力图表格，行是项目（含全局），列是类型（坑/规则/决定/事实），单元格显示「总数 / 被交付数」，颜色深浅 = 交付率。「被交付数」= `inject_log` 里该条目出现的次数（含 brief/search/get/recall），不叫「被召回」，因为 brief/search/get 不是召回。点单元格展开该组合下的记忆列表。
4. **力导向关系图**：节点是记忆，边是**模型判定的关系**（`refines`/`merged_into`/`conflicts`/`supersedes`），节点大小 = 被交付次数，颜色 = 类型。图上方标明「关系由模型判定，未经人工核实」。复用现有 `view.ts` 的关联图布局算法（每个连通块一个圆、块排成网格）。

#### 11.12.3 技术方案

- 保持单文件 `~/.agentbrain/view.html`，自包含、无外部资源。
- 不引入 Cytoscape.js 或其他外部依赖，力导向布局用现有 `view.ts` 的 `graphLayout`。
- 深色主题，配色跟现有一致。
- 时间轴默认 90 天。

#### 11.12.4 不做

- 不做「真实引用网络」：现有数据结构（`memory_report_ids` 只存「回复 × 记忆」）不支持，等将来有明确的边来源再立项。
- 不做目录版 + 单文件版双输出，保持单文件。
- 不做实时刷新、编辑功能、移动端适配。
- 不改数据口径，`inject_log`、`prop_usage`、`memory_report_ids` 的定义和写入路径不动。
- 现有分析页（关联图、记忆列表、向量地图）不动。

#### 11.12.5 验收

1. 首页有一句话概览、时间轴、类型×项目矩阵、力导向图。
2. 矩阵单元格「被交付数」跟 `inject_log` 实际行数一致。
3. 时间轴召回轮数跟 `recall_runs` 一致，不是 `inject_log` 条目数。
4. 力导向图标明「模型判定的关系」。
5. 单文件自包含，无外部资源。
6. 现有分析页功能不变。

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

backup 与库版本号已在 §12.6 定下（2026-11-17）。仍未冻结：export bundle。

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

### 12.6 项目组共用之前：单机加固与展示重构（2026-11-17 用户授权实现）

> 2026-11-17 用户原话："一个项目组中所有人共用一套 ab……但是 ab 本身要够好用才行"，并在目标确认里选定：不做服务器和账号，先把单机版做好，给每条写入记下"谁、哪台机器"。确认目标即授权实现。依据是 `docs/research/20261117-企业级差距分析.md`，编号（B1、I2 等）沿用那份报告。

**结论**：这一节补四块。数据安全（清除、备份恢复、库版本号、文件权限），后台可查错，事件带操作者和机器，文字输出和看板的展示问题。不新增配置键，不改转正规则，不做服务端。

#### 12.6.1 库版本号与未知事件（B2）

| 项 | 做法 |
|---|---|
| 版本号 | `store.db` 的 `PRAGMA user_version`。代码常量 `SCHEMA_VERSION = 1`。旧库是 0 |
| 库比代码旧 | 打开时在一个写事务里补列并写版本号。0 到 1 补三列：`events.actor`、`events.machine`、`capture_windows.error_detail` |
| 库比代码新 | 这个连接设 `PRAGMA query_only=ON`，所有写入报错"库版本 N 比代码支持的 M 新，拒绝写入"。读照常。`ab status` 报出 |
| 未知事件种类 | 投影只认 `archive` 和 `reactivate` 改状态。其余不认识的种类不动条目，计入 `unknown`，`ab status` 报数 |
| 纪律 | 新增事件种类、表或列必须加版本号。旧代码遇到新库就只读 |

已知限制：这次之前的代码不查版本号，它们仍会往新库里写。保护从本版本起生效。

#### 12.6.2 操作者和机器（为共用留字段）

- `events` 加两列 `actor`、`machine`。每条新事件写入时填：`actor` 是操作系统登录名，`machine` 是主机名。旧事件为空，照常投影。
- 这不是身份认证。在 agent 会话里执行的命令，`actor` 仍是登录名。是否在会话里执行看事件的 `session_id`，读路径把两者一起显示。
- 投影给每条记忆带上写入者，以及让它转正的那条事件的操作者、机器、会话和时间。
- 不加配置键。以后有服务端时，`actor` 改由服务端认证给出，列不变。

#### 12.6.3 清除（B1）

命令：`ab purge --session <宿主:会话id>`。

| 项 | 做法 | 对应条文 |
|---|---|---|
| 谁能执行 | 只在终端里由人执行：标准输入必须是终端，并要手动输入会话 id 前 8 位确认。不是终端时只打印将覆盖的范围，不执行 | §10.2 只能由人发起 |
| 范围 | 一个会话。成员是该会话写的事件，加上指向这些记忆的后续事件（详情、关系判定、代码核验、去留）。声明和枚举在同一事务写入 | §10.2.1、§10.2.2 |
| 同一事务清掉 | 事件正文、哈希、操作者、机器；统计表里这些记忆的行（使用计数、注入记录、核验记录、候选键、引用报告） | §10.2 受控面 |
| 之后 | 全文索引删表重建，两个库各做 `VACUUM` 和 WAL 截断；删掉 `view.html` 和该会话的调试文件 | §10.2 L3 与临时文件 |
| 逐面报告 | 每个面报 成功、部分、失败。报告和备份里仍含这些记忆的文件列出路径，`--drop-backups` 删掉含该会话的备份 | §10.2.3 第 4 条 |
| 重跑 | 已清除的会话再跑只补做没完成的面，不重复写声明 | |

§10.2.3 的传递闭包这次只做到"指向被清除记忆的事件"。别的会话里内容相近的记忆不算依赖，不动。外部副本（宿主的会话文件、手工复制的库）只报告，不承诺擦除。

#### 12.6.4 备份与恢复（B3）

| 项 | 做法 |
|---|---|
| `ab backup` | `VACUUM INTO` 写到 `backups/ab-backup-<时间>.db`，权限 0600。写完打开核对完整性和事件数。记下最近一次备份的时间 |
| 保留 | 只管自己命名的文件，留最近 14 份（代码常量）。手工复制的文件不动 |
| 自动 | `ab work --sweep` 发现距上次备份超过 24 小时就做一次 |
| `ab restore <文件> --yes` | 先核对备份文件（完整性、版本不高于代码），拿后台租约，把现库另存一份 `pre-restore`，再换入。索引删掉重建 |
| 清除不回潮 | 恢复后，把现库里已有的清除声明对恢复出来的库重做一遍 |

恢复会丢掉备份之后的写入，所以要 `--yes`，并且先另存现库。其他正在运行的会话要先关掉，命令会提示。

#### 12.6.5 文件权限（I8）

数据目录和 `backups/` 是 0700，`store.db`、`index.db`、`work.log` 是 0600。每次打开库时发现不对就改。

#### 12.6.6 后台可查错（I2、I3、I4）

| 问题 | 做法 |
|---|---|
| 失败原因没存（I2） | 窗口表加 `error_detail`：HTTP 状态码加脱敏后的上游报错前 300 字。关系判定和代码核验出错时，`ab work` 的输出多一段"出错明细"，每类最多 10 行 |
| 钩子拉起的进程没有日志（I2） | 输出追加到 `work.log`。文件超过 5 MB 时改名为 `work.log.1` 再写 |
| 401、403 被算成失败尝试 | 密钥失效时所有窗口 4 次后都会被永久跳过。改成和没配密钥一样：延后，不计次数 |
| 失败窗口被永久跳过（I3） | 窗口用完重试次数时，如果多于一轮且超过 8000 字，对半拆成两个窗口各自重试，原窗口记为 `split`。拆到不能再拆仍失败才是终态失败。话题模式（默认关）不拆 |
| 僵尸延后窗口（I4） | 并入 feature-20261109-stuck-windows 分支的做法：进度越过的延后窗口记为 `superseded`，不再算延后。本节不重做 |
| 失败记录 30 天后被删 | 真正失败的记录保留到会话记录过期（90 天）。`split` 和 `superseded` 仍按 30 天清 |

错误详情只存状态码和脱敏后的短报错，不存请求内容（§13.2）。

#### 12.6.7 文字输出的问题清单

基线是 2026-11-17 三个宿主真实会话里的输出，存在 `~/.cache/verify-evidence/agentbrain/20261117-team-ready/baseline/`。

| 编号 | 命令 | 基线里的实例 | 改法 |
|---|---|---|---|
| T1 | `ab brief` | 项目坑一段里，代码核验转正的和用户确认的长得一样。上次分析时注入的 5 条项目坑全是模型写入、模型转正 | 非用户确认的条目末尾标 `（代码核验）` 或 `（跨会话印证）`，段标题说明没标的是用户确认过的 |
| T2 | `ab search` | 已确认的条目没有任何来源标记，只有未确认的有 | 每条都标确认来源：`[用户确认]`、`[代码核验]`、`[跨会话印证]`、`[未确认]` |
| T3 | `ab search` | 搜"灰度开关"得到 8 条，1 条相关，其余 7 条是全局的无关条目，每条好几行，看不出为什么命中 | 每条标命中方式：`字面` 或 `相似 0.52`。不改排序和门槛 |
| T4 | `ab get` | `来源: 验收用：灰度开关（未知宿主）（无 transcript）`。Codex 被问"谁确认的"，回答"确认者显示为未知宿主" | 加两行：`写入:` 谁、哪台机器、经哪个会话；`确认:` 确认来源、谁、何时、是否在 agent 会话里执行。`未知宿主` 改成 `命令行` |
| T5 | `ab status` | 36 行，没有结论；16 行"孤立项目"刷屏；"延后 14，最早 2026/10/14 重试"是一个月前的；`沉淀（切片 3）`、`doctor:` 是内部说法；看不到代码版本、库版本、备份、失败原因 | 开头加"要处理"清单，没有就写"没有要处理的事"。新增 `代码:`、`库:`、`备份:`、`失败窗口:` 四行。孤立项目超过 3 个折成一行。两处说法改成 `后台抽取:` 和 `投影:` |
| T6 | 用法报错 | Pi 写错 `ab remember --confirmed "…"`，得到 60 多行的全部用法 | 只打印出错的那个子命令的用法 |
| T7 | `ab brief`、`ab confirm` | 末尾写"用户认可后 ab confirm <id>"。15 个用户确认事件里 14 个是 agent 在会话里执行的 | 文字改成"用户明确说认可才执行，不要自己确认"。在会话里执行 `ab confirm` 时，输出注明这次记为用户确认、由哪个会话执行 |

T1 到 T4 是报告 I7 里"只改显示"的部分。排序、注入资格、转正规则都不动（§8.4、§9.4 不变）。

#### 12.6.8 看板的问题清单

| 编号 | 基线里的实例 | 改法 |
|---|---|---|
| V1 | 首页右半边是一张只有一个按钮的"记忆关系图"卡片 | 换成"运行状况"卡片：代码和库版本、最近备份、失败和延后窗口及原因、未知事件数。关系图入口并进导航 |
| V2 | 看不到确认来源的总体分布 | 首页加一条"确认来源"：用户确认、代码核验、跨会话印证、未确认、与代码不符 各多少 |
| V3 | 记忆详情没有谁写的、谁确认的 | 详情加"写入"和"确认"两行，内容同 `ab get`。列表加按操作者筛选 |
| V4 | 90 天时间轴左边六成是空的，库才用了 5 周 | 从有数据的第一天画起，最少 14 天 |
| V5 | 失败窗口只有一个计数 | "运行状况"里列最近 10 个失败和延后窗口：宿主、时间、错误码、详情 |

页面仍是单文件、无外部资源。分享口径沿用 §11.8.6：内部分享，多出来的操作者和机器照常显示。

#### 12.6.9 与已定条文的关系

| 条文 | 关系 |
|---|---|
| §2.2 配置键预算 | 新增 0 个。保留份数、间隔、阈值都是代码常量 |
| §8.4、§9.4 转正规则 | 不变，只改显示 |
| §10.2 清除只能由人发起 | 用"必须是终端并手动输入确认"落实 |
| §10.2.1、§10.2.2 | 范围是会话；声明和枚举同一事务 |
| §10.2.3 传递闭包 | 只实现到指向被清除记忆的事件，其余仍待排期 |
| §12.1 一个本地库是权威 | 不变。操作者和机器只是字段 |
| §12.2、§19.8 | 备份形态和版本号在本节定下。export bundle 仍未定 |
| §13.2 日志不写敏感正文 | 错误详情先脱敏再截短 |
| §14.2 版本兼容必须拒绝执行 | 库比代码新时只读 |
| §20 不做多用户服务 | 不变。本节不含服务端、账号、权限 |

#### 12.6.9a 实现记录（2026-11-18，feature-20261117-team-ready 分支，未合并）

| 项 | 落在哪 | 与上文的出入 |
|---|---|---|
| 版本号、未知事件、操作者 | `src/store.ts`、`src/l2.ts` | 无 |
| 清除、备份、恢复 | `src/admin.ts`、`src/store.ts`、`src/cli.ts` | 恢复不换库文件：在一个事务里把各表内容换成备份的，别的进程开着也安全；事件序号只进不退。清除要先拿后台租约 |
| 清除后的投影 | `src/l2.ts` | 新增一条规则：指向已清除记忆的事件算“已清除”，不算 orphan（§19.1 要求合法清除不当成损坏） |
| 后台可查错 | `src/llm.ts`、`src/intake.ts`、`src/work.ts`、`src/cli.ts` | 无。I4 来自并入的 stuck-windows 分支 |
| 文字输出 T1–T7 | `src/present.ts`、`src/brief.ts`、`src/status.ts`、`src/cli.ts` | T1 的说明行只在范围里有自动转正的条目时才出现，算进固定预算 |
| 看板 V1–V5 | `src/view.ts` | 备份只显示文件名，页面不带本机数据目录 |
| 类型检查 | `tsconfig.json` 的 `lib` 提到 es2024 | 修掉 `src/transcript.ts:115` 的 TS2550 |

验收证据在 `~/.cache/verify-evidence/agentbrain/20261117-team-ready/`。合并和把线上 `ab` 切过去由用户决定。切过去之后，旧版本的代码（另两个 worktree）仍能往库里写，但不会带操作者和机器，也不受版本号保护。

#### 12.6.12 核验退避（2026-11-18 用户同意只做这一项）

没结论的代码核验不再每次仓库有新提交就重跑。

| 上次结果 | 下次什么时候再核 |
|---|---|
| 代码无法核验 | 不再核。说的是代码之外的事，换一次提交也不会变成能核 |
| 证据不足，第 1 次 | 仓库提交变了，并且过了 1 天 |
| 第 2、3 次 | 提交变了，并且过了 2 天、4 天 |
| 第 4 次起 | 提交变了，并且过了 8 天。间隔不再加长 |
| 出错（限流、网络） | 照旧，下次就重试，不进这个退避 |
| 这次改动之前留下的「证据不足」 | 按已经重复过算，等 8 天且提交变了才再核，避免上线后把积压再核一遍 |

同一份提交不重复核。从没核过的排在重核前面。每天核几条的上限不变（每次巡检 3 条）。不设日调用上限，这是 2026-10-13 的决定。次数记在 `verify_attempts.outcome` 里（`inconclusive:2`），不加表、不加配置键。

#### 12.6.10 不做

- 服务端、账号、租户权限、同步。
- 报告里的 I5 增量索引、I9 脱敏规则、I10 禁止出境开关。I6 核验退避已在 §12.6.12 做。
- 改排序或注入资格让用户确认的条目优先。这会改变注入内容，要用户另定。
- 给每条事件记代码版本。写入热路径上不值得为它调 git。

#### 12.6.11 验收

1. 清除后两个库文件里搜不到被清除的明文；未知种类的事件不改条目状态。
2. 备份后恢复到临时目录，事件数和投影一致；恢复不让已清除的内容回来。
3. 假模型服务返回 4xx 和 5xx 时，库里能查到状态码和脱敏报错；超大窗口被拒后拆小重试成功。
4. T1 到 T7、V1 到 V5 每条有改前改后的对照。
5. Pi、Codex、Claude Code 各一轮真实会话，库用正式库副本：开工注入、会话内搜索和查看、会话结束后抽取入库且事件带操作者和机器、会话内 `ab status` 有新增各行。驱动是 `.agents/skills/verify-agentbrain/team.ts`。

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
- **例外（2026-10-30，§8.11）**：抽取时逐字核对、已滤密钥的原话片段随证据存原文（含追加证据），原对话被宿主清理后仍能说明当时的依据；完整对话仍不归档。记忆正文多了 body（详情）后，发往 DashScope 算向量的内容会变多（细节、代码片段），接收方与数据类别不变；所有正文字段写入前过同一个脱敏边界；
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
| 模型生成 provenance 不足 | generation input/output refs、prompt/model/hash；`jev-gate.ts:15` 的 `JEV_PROMPT_VERSION` | **已授权，§8.8**：补齐抽取、关系判定、代码核验的 L1 提示词版本；用系统提示词全文 SHA-256 前 12 位，不照搬手工版本号。一步式已有部分记录 |
| 适用范围变化被当成补充或冲突；历史叙述误报冲突 | `jev-gate.ts:19` 的 `boundary_change` 与 historical statements 规则 | **CANDIDATE，§9.6**：两层共用关系集合；范围变化只挂待确认标记，不改目标；已同步的历史只判重复或补充 |
| 批量历史会话可能淹没有用记忆 | `skill-review-prompt-strict.ts:4-14` 区分冷启动与实时抽取 | **CANDIDATE，§8.9**：仅 `backfill` 收紧，只收用户原话支撑的规则与决定；不借 Skill 评分体系，不收紧 `scan` |
| 降级与部分成功不可见 | structured error/partial result | **直接吸收**到 Memory Card/diagnostics |
| 上下文注入成本高 | Persona push、Scene navigation、L0/L1 tool pull；`scene-extraction.ts:560-561` 的场景目录输入 | **CANDIDATE，§11.11**：brief 给未展开记忆的场景标题与数量，按需打开原条目。评测 10 不如直接搜索，继续搁置，不替代 §11.5 的搜索提示 |
| 自动记忆需要人工校准 | Roadmap L1-L3 editable | **改造吸收**为 L1 correction/supersession，不直改 L2 |
| scope/authorization/loadout 混合 | team/user/agent/task + ACL + binding | **吸收教训**：六个维度严格分开 |
| 中文 lexical/dense 实现 | jieba、FTS5、embedding、RRF | **进入 prototype**，不直接选为默认 |
| destructive update/merge | 删除旧 VDB 记录再写新记录 | **拒绝**；保留 event-first 和 lineage |
| 多轨 authority | JSONL/SQLite/TCVDB/COS/Markdown | **反例**；坚持单一 canonical owner |
| Conversation→Atom→Scenario→Persona | 内容抽象层；`scene-extraction.ts:55-65`、`:120-123`、`:175-186` 的叙事、合并删除与隐性推断 | **不作为权威层吸收**。§11.11 仅保留可重建的 L3 分组；不改正文、引文、来源，不生成叙事、Persona 或 Skill / SOP |
| Memory Hub/Panel/团队 ACL | 完整团队服务 | **v2 延后** |
| Proxy wire 逆向识别 | Claude/Codex/dsh adapter | **不吸收**：v2.5 起三个宿主经全局规则文件、派活说明与 `ab` 命令行接入，不做 wire 逆向 |
| README benchmark/E2E | 当前分支不可复现 | **不作为量化设计证据** |

所有引用必须继续区分：已发布实现、feature branch、roadmap、opaque private extension 和不可复现宣称。上表新增的文件引用均指 TencentDB `feat/server_team` 提交 `37b1629`，完整路径与取舍见调研文档的"2026-10-15 增补"。

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

2026-11-23：§9.7 代码变更驱动重核不占上表的切片编号，按它自己的拆单（2026-11-25 修订为 agentbrain 4 张单 + pm 2 张单）逐张授权推进。
2026-11-23：先推进 §7.8 的 Antigravity 三处接入，再推进 §9.7；§7.8 已合入 `docs/agentbrain-v2-design`（`b535bf6`），2026-11-25 用户授权开始 §9.7 单 1（`ab-1`）。

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
- v2 正式支持 dsh、Memory Proxy，或 Pi、Claude Code、Codex、opencode 之外的宿主；以 wire 逆向方式接入任何宿主（opencode 的公开插件接入于 2026-10-20 获授权，见 §7.5）；
- 接管 pm 的仓库档案、计划、跨仓库调度等非记忆职责（记忆核心成熟后再议，§2.1）；
- 多用户团队服务、服务端认证、租户 ACL；
- 完整个人生活 Persona/数字孪生；
- Skill marketplace/执行平台；
- 从会话里提炼可复用做法（Skill / SOP）。用户 2026-10-15 决定这不属于记忆职责。与 §4 workflows 的 LOCKED 条文冲突，本次只记录新决定、不改旧锁定条文，见 §5.5；
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

- 2026-11-25 用户授权实现 §9.7 单 2。`registry` 读取主干名，扫描与 sweep 核验只读本地已有主干提交。扫描复用 `verify_queue` 和 `verify_attempts`，按祖先关系选基线，保留非祖先三分支判定、缺失基线回退和机械预筛。预筛跳过不更新核验记录，保留旧侧行号。队列中的决定及无代码证据条目进入核验，首次未确认核验仍只处理坑和事实。入队退避复用无法核验、同 head 和证据不足的规则，新 head 上的确定结论不受 24 小时限制。CLI `verify --changed` 默认只入队，`--run` 持租约消费最多 3 条。stale 确认优先记录主干 head，无论仓库可用与否都出队。每日本地扫描用代码常量默认关闭。零新表、列、事件种类或配置键，`SCHEMA_VERSION` 保持 1，不改 `src/l2.ts`。本单验证只使用隔离库、临时 Git 仓库和本地 HTTP mock，不运行正式库回放或首扫。

- 2026-11-25 按 fix-ab1-review 修复单 1 的核验边界。只有仍 active、没有待确认纠正或未判定关系的坑与事实能因 verified 自动转正。规则和非 active 条目不能手动核验，已退场草稿不进入 sweep 核验。撤销自动转正的原契约保持不变。手动核验在仓库工具和模型调用边界报错，并复用既有证据不足计数。回归测试先红后绿，再跑隔离 CLI 和精简审查。无新表、列、事件种类或配置键。

- 2026-11-25 按已授权的 §9.7 单 1 实现止损护栏与草稿退场。`brief`、`recall` 和常驻偏好按确认来源处理 stale，用户确认及跨会话印证保留警告，代码转正及未确认停注。`confirm` 用可选 `override_stale` 清除标记，并在能解析本地 HEAD 时同事务记录核验和出队。单条 `verify [--ref]` 强制重核，ref 工具只读提交树，决定只补代码证据而不自动转正。撤销过自动转正的条目维持原契约，不保存新核验证据也不再转正。L2 在既有替代状态计算结束后派生 `superseded_draft`，只让同项目未确认 extract 草稿退场。只认最终仍 active 的替代草稿，归档替代草稿后恢复。测试先失败后修复，真实 CLI 使用隔离库、临时 Git 仓库和本地模型替身。库版本仍为 1，无新表、列、事件种类或配置键。变更扫描、锚点和需求提炼不在本单范围。

- 2026-11-25 用户批准修订 §9.7 并授权单 1（`ab-1`）开始实现：基于正式库只读副本与 6 个真实交付需求核查结论，补入 cherry-pick 非祖先三分支基线判定（237 条中 71.3% 原文已在主干、13.5% 主干分叉改坏）、`±3 行 OR 非常规标识符共变`机械预筛（抓到 `[d16d321e]` 远距离失效）、Git 路径 `-c core.quotepath=false`、单 3 附带存量 ~321 条项目决定离线补锚点；采纳用户拍板三项：① 新增单 4 `ab synthesize` 需求收口正向提炼（≤3 条未确认候选，零自动转正/归档）；② `fold()` 新增同项目未确认 `extract` 草稿被未确认 `supersedes` 替代时派生 `superseded_draft`（不改已确认条目、可逆）；③ pm 侧拆出 `pm-2` 收尾机械门禁与 `.gitignore` 忽略技能告警。拆单更新为 `ab-1..ab-4` + `pm-1..pm-2`，其余单仍按单授权。

- 2026-11-24 用户按 fix-recall-state 单授权修复状态合同。斜杠命令仍不注入偏好和召回提醒，也不写 recall_runs；只有显式请求 `want_session_state:true` 时返回空 additionalContext 与 worker、brief_present，避免 agy 插件一直保持 pending。会话定位和身份判断纳入 store 的 try/finally；定位后的非 opencode、非 agy 文件在 realpath 时消失则将 transcript 置 null。验证先红后绿，覆盖斜杠命令状态组合、异常关闭和插件与真实 CLI 联调，再跑全量测试、类型检查及隔离 CLI 验证。不改插件实现、配置或库结构，库版本保持 1；代码可用 git 回退。

- 2026-11-24 用户按 agy-plugin-brief 单授权实现 §7.8.4。SessionStart 返回空对象，PreInvocation 只消费 `agentbrain.session` 的 worker 三态与 brief_present。brief pending/done 与 prompt seen 分开；同一 prompt 重试不重复 capture 或 recall 上下文。规范应用根按 transcript、环境提示、GEMINI_HOME 下 acp 目录依次推导，存在的根取 realpath；标记和 seen 共用根与 id 的键，避免跨根串扰。验证先红后绿，再用隔离 stdin 跑仓库插件与真实 CLI。不改事件集合、宿主配置、库结构或配置键，代码可用 git 回退。

- 2026-11-24 用户按状态合同单授权实现 §7.8.4。`want_session_state:true` 仅新增 `agentbrain.session`，旧 hook 输出不变。brief 状态只读 SYSTEM_MESSAGE，避免派活正文里的字面标签误判；读头与身份判断共用 262,144 字节上限。telemetryCtx 从检测结果补 transcript，stdin 会话 id 覆盖环境 id 时按合并后的 id 重新定位，保留多根冲突的 null。验证先红后绿，覆盖三态、恢复、截断路径、读头截断、三处环境坐标与真实 CLI 的日志对齐。不改变偏好筛选和排序，不新增配置、表或列，库版本仍为 1；代码可用 git 回退。

- 2026-11-24 用户按 denoise-anchors 单授权实现 §7.8.5。原始步骤首次保留数字定位点，重复步骤使用 `<step>#<n>`；所有带 step_index 的行参与计数，回跳先清空工具配对队列。外层 USER_REQUEST 取尾部零或多个全大写宿主块前的最后一个闭标签，兼容 USER_SETTINGS_CHANGE 和无尾随块。T3 请求以 runtime_info 前的末个闭标签为边界，交接只取末尾当前消息。明确完成通知不生成用户轮；后台唤醒只匹配宿主源码的 `Background task completed.`，不按正文关键词过滤。助手引用只保留非空 citation.comment，并清除行内占位符；去噪和用户证据校验共用提取函数。验证先红后绿，再重放真实日志副本和隔离 CLI 的三处来源展开。不新增配置、表或列，库版本仍为 1，代码可用 git 回退。

- 2026-11-24 用户按 fix-status-review 单授权修正分处诊断。status 跳过 appData 不存在的 CLI、IDE，其他读取异常保留根并报告；已安装的空根和 T3 新实例仍显示尚无对话。resolveProject 恢复目录异常抛错，只在 status 分类处理：ENOENT、ENOTDIR 计目录已删，EACCES、EPERM 计工作目录无法读取，均排除可抽数；未知异常照抛。当前目录无法解析时显示未登记目录。可抽主会话全部超过七天且零登记时说明巡检不会补登记，有近七天可抽主会话时仍提示检查巡检。理由是避免把未安装应用报成空实例、把异常目录登记成全局会话，以及把旧日志误报为巡检停转。回归先红后绿，隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY，走真实 status、doctor 和完整验证。不新增配置、表或列，库版本仍为 1；代码可用 git 回退。

- 2026-11-24 用户按 fix-worker-review 单授权修正四类身份误判。Pi、agy 的对象与截断读头共用首轮起点函数，仅从输入开头剥宿主请求框和闭合 skill 块，再匹配派活标记。T3 说明块或 skill 块超出读头窗口时保留 null，普通正文中部的同名标签不剥。Codex 的 session_meta 独立返回身份，截断元数据无阳性信号时返回 false，不再误走 Pi 判断；Claude 截断 user 行按行首 isSidechain 判定。回归先红后绿，隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY 走真实 recall --hook，验证主会话偏好与 worker 隔离。不新增解析器、配置、表或列，不改公开签名，库版本仍为 1；代码可用 git 回退。

- 2026-11-24 用户按 status-per-root 单授权实现 §7.8.6。status 和 doctor 复用发现接口统计所有完整日志，按固定登记路径分别对齐 CLI、IDE 和 T3 各实例；不改变 sweep 的七天窗口。已删 cwd 排除可抽数，已存在但未登记的项目另报；冲突日志跳过计数并集中报异常。CLI、IDE 检查共享插件，T3 检查实例根的插件入口。验证覆盖四根计数、空实例、缺元数据、坏库、权限拒绝、目录已删、冲突和真实 CLI 的只读副作用。status --line 和库版本 1 不变；代码可用 git 回退。

- 2026-11-24 用户按 worker-identity 单授权实现 §7.8.3 的共用身份判断。`workerIdentity` 返回 true、false 或 null，分别表示已知 worker、完整首轮无标记、首轮待定；既有 `isWorkerTranscript` 和 `cleanTranscript.worker` 保持 boolean。Pi、agy 共用两类 T3 首轮前缀、带项目参数的开工标记和 262,144 字节读头上限。`recall --hook` 先规范路径，身份待定不调用 `guidanceBlock`，全局规则读取和提醒不变。测试覆盖截断路径、超长首行及未知身份，并用隔离 HOME 和临时库走真实 CLI。不加配置、表或列，库版本仍为 1；代码可用 git 回退。

- 2026-11-24 用户按 agy-path-pin 单授权实现 §7.8.2 第 5 条。agy 登记在短写事务内核验已有路径，返回 new、touched 或 conflict；异根、无法确认本根及多根完整日志冲突均不改会话行，hook 不启动 work，手动 capture 明确失败。合法提示指向未落盘的另一根也不能替换已有路径。引用扫描优先使用已登记路径，没有基线时只补找唯一合法来源；读取前复用 agy 准入，失效软链不能串根。非 agy 保持原选择规则，Codex 换文件与旧进度接续不变。验证覆盖逐字段回读、work.log 不存在、真实 get --expand、全量测试与 verify.sh run。只使用隔离 HOME 和临时库，不新增配置、表或列，库版本仍为 1；代码可用 git 回退。

- 2026-11-24 用户按 fix-roots-review 单授权修正发现异常报告。有不可读完整日志时不报 0 对话；同根日志和摘要库失败合成一条 unreadable，count 只计不可读日志，可选 summariesUnreadable 标明摘要库也失败，kind 枚举不变。不新增配置、表或列，库版本仍为 1。回归覆盖权限拒绝、逃逸链接、合并报错及真实 sweep 输出；代码可直接回退。

- 2026-11-24 用户按 agy-locate 单授权实现 §7.8.3 的定位与 IDE 宿主识别。`agyLocate` 只在枚举应用根中检查指定 id 的完整版，先判跨根冲突，再采用合法根提示或唯一候选；合法提示允许日志未落盘时保留规范坐标。`GEMINI_HOME` 只匹配已发现的 T3 实例。宿主链新增 Antigravity 特征，仍取最近的宿主。定位调用方跳过冲突，保留未落盘坐标，不改变其他宿主。验收覆盖隔离文件根、真实 CLI 登记与来源展开；缺独立 IDE 工具 shell 时记 BLOCKED。无新配置、表或列，库版本仍为 1；代码可用 git 回退，不写正式数据。

- 2026-11-24 agy-roots 末轮返工获用户授权。跨根冲突在 redo 重置前拦截，既有处理进度和窗口保持原样，其他宿主的 redo 不变。合并摘要主库的重复存在性检查，保留权限及软链边界；新增冲突加 redo 的回归断言，重跑三处 CLI 驱动和完整验证。

- 2026-11-24 用户按 agy-roots 单授权实现 §7.8.2 第 1–4 条。新增 `agyRoots` / `agyDiscover`，枚举 CLI、IDE 与 T3 直接实例，先核验原摘要库及 WAL、SHM，再复制并只读查询。发现以本根完整日志为准，缺元数据保留日志和空 cwd，冲突先于七天过滤判定。`scan` 使用发现结果，work 跳过冲突会话；准入共用根枚举，不改其他宿主。验收使用隔离 HOME、临时文件库和真实 `work --sweep` / `work --dry-run`。不新增配置、表、列，库版本仍为 1。定位、路径固定和分处诊断留给各自工作线。代码可直接回退，测试不写正式数据。

- 2026-11-23 新增并按异家审查修订 §7.8（CANDIDATE，待用户授权实现）：CLI、IDE、T3 共用 agy，首版基线为三处 sweep、定位、去噪、诊断。删除无效安装命令，B 先隔离验证 ACP 共享软链，正式建链另获授权。补 agy 固定路径与异根钩子拒绝，保留 Codex 换文件；Pi、agy 共用两类 T3 标记、完整版准入与有界读头；补唤醒和引用去噪、回滚清 pending、brief 状态与坐标。复制前验证软链，诊断处理空实例、已删 cwd，每处一行，同 id 冲突跳过。版本保持 1，配置键新增 0，不加 worker 列。审查在 pm `docs/agentbrain/2026-11-23-agy-wiring/tasks/02-review-design.reply.md`，本轮核实副本在 `/tmp/agy-wiring-design-fix.ROCwp5/`。排在 §9.7 前。
- 2026-11-23 新增 §9.7（CANDIDATE，用户同日同意写入设计，实现按 4 张单逐张授权）：代码变更驱动的记忆重核。每条记忆以自带的核验 head 为基线，和主干比它引用的文件或锚点改没改；排除开发分支上的 head、gitignore 路径、无法核验和退避中的条目；先做机械预筛，单次最多入队 20 条；核验只读主干；决定纳入核验但不自动转正；被判不符时，用户确认的照常注入并加标记，代码转正和未确认的不注入；`ab confirm` 可清 stale。主触发是 sweep 每日一次（默认关），pm `req log 上线` 只在后台加速。零新表，不升版本号，配置键新增 0。依据是 Claude Opus 与 Gemini Neon 两轮评审，记录在 pm `docs/agentbrain/2026-11-23-kb-change-reverify/`。
- 2026-11-18 用户授权实现 §7.7（"按你说的干"）。实现后实测：钩子给的 `transcriptPath` 已是完整版；隔离库真实会话登记 host=agy、窗口完成 1。
- 2026-11-18 新增 §7.7（CANDIDATE，待用户授权）：agy 作为第五个宿主接入登记和抽取。读 `transcript_full.jsonl`（截断版会切掉长原话），准入只认这一种路径形状；插件在新用户消息时登记、在 `Stop` 且不再继续时按会话结束登记并拉起抽取，因为 agy 没有会话结束事件；sweep 的 cwd 从 `conversation_summaries.db` 只读取。§7.2 宿主数改为五个。
- 2026-11-18 §12.6.12（用户同日说「好」，只做这一项）：代码核验对「无法核验」不再重跑，对「证据不足」按 1、2、4、8 天退避，且提交没变不重跑。从没核过的排在前面。不加配置键，不改日上限。I5、I9、I10 仍不做。
- 2026-11-18 §12.6 实现完成（feature-20261117-team-ready 分支，未合并）：新增 §12.6.9a 实现记录，写明与设计的三处出入（恢复改为事务内换表、指向已清除记忆的事件不算 orphan、brief 的说明行按需出现）。Pi、Codex、Claude Code 各一轮真实会话验收通过，证据在 `~/.cache/verify-evidence/agentbrain/20261117-team-ready/`。
- 2026-11-17 新增 §12.6（用户同日授权实现）：项目组共用之前的单机加固与展示重构。库版本号和未知事件处理、事件带操作者和机器、`ab purge`、`ab backup`、`ab restore`、文件权限、后台错误详情和失败窗口拆分、文字输出 7 条和看板 5 条问题清单。不做服务端和账号，不改转正规则，配置键新增 0。§12.2 的"仍未冻结"相应收窄。依据见 `docs/research/20261117-企业级差距分析.md`。同日并入 feature-20261109-stuck-windows 分支（延后队列能退出）。
- 2026-11-10 §11.12 改为简化方案（用户同日同意）：原三视图草案经 kimi k3.1 pro review 报 2 阻断后收窄。阻断 1：「真实引用」在现有数据结构上不存在（`memory_report_ids` 只存「回复 × 记忆」，没有记忆间边）。阻断 2：双输出没继承 §11.8.6 分享隐私合同。简化：只重做首页（一句话概览 + 时间轴 + 类型×项目矩阵 + 标明「模型判定的关系」的力导向图），保留现有分析页，单文件无外部依赖。
- 2026-11-10 §8.14 改为替代方案 A（用户同日拍板）：原草案（模型先筛 + 15 天自动归档）经 kimi k3.1 pro review 报 2 阻断后放弃。阻断 1：自动归档推翻 §10.3 和 §8.12。阻断 2：自动召回已关闭，「没被注入」不等于「没被需要」。替代方案：只把到期清单摘要推到 brief，保留 `ab review` 人工处理。
- 2026-11-10 新增 §8.13.7（用户同日授权，主会话轻量路径）：`ab brief` 末尾加一行冲突汇总 `冲突 N 对未解决（最老 D 天）：ab get 看双方，ab archive 错的一条；ab status 看全部。`，只统计与本次 brief 范围（全局 + 当前项目）有关的冲突对。跟 SEARCH_HINT 同级进固定预算，超预算先截条目不截这行。不查 `inject_log`（那是 `ab status` 的事，brief 每轮都跑）。依据：38 对冲突挂了 28 天没被处理，原因是现有机制只在 `ab status` / `ab view` 报数，用户不会主动跑；brief 是每次开工的必经入口。实现：`src/brief.ts` 新增 `conflictReminder`，在 `contentBudgets` 调用前把提醒行 push 进 `tails`。验证：`src/brief.test.ts` 加 2 个用例（范围过滤、超预算不截）。
- 2026-11-09 实现 §8.13 最简版（用户同日授权）。用无方向 id 对的最新 seq 判定派生 `conflicts[]`，在替代投影完成后只保留两端 active 的冲突。投影同时保留当前对的判定时间供 status 统计，不新增表。期间注入次数按 `inject_log` 实际行计，同一条卷入多对时不重复计数。读取方同批迁移，含 `work.ts` 的印证资格检查。验证见 `src/conflicts.test.ts` 和验证技能 `features/conflicts.md`。正式库副本事件水位 4848，独立重放算出 32 对。对照水位 4832，只算 relate 为 30 对，加入 remember.relation 后为 31 对；水位 4848 两种口径分别为 31、32 对。差额来自初次 remember 判定的一对，以及之后新增的一对。
- 2026-11-09 新增 §8.13 草案，用户同日随后授权最简版实现。初稿是后台整理工序加三类建议；astra xhigh 两轮只读 review（pm `docs/agentbrain/2026-11-09-memory-tidy/tasks/01`、`02`）后一度加成 `rev`、`resolve` 事件、版本令牌的裁决协议。用户指出偏离初衷，kimi k3.1 从最初问题重看（`tasks/03`）后收窄为最简版：冲突按对记录、和待确认纠正分开写清楚、`ab status` 报数，处理用现有 `ab archive` / `ab correct`，不加新事件、命令、表。当前冲突 30 对（不是 32，事件数 ≠ 对数）。
- 2026-11-05 新增 §8.12（CANDIDATE，用户同日说"先写设计"，未授权实现）：抽取提示词还假设后面有审稿人，也没用《好记忆的标准》，改成引用同一份标准，逐条对比和新标注验证后才上线。按 astra xhigh 只读 review（pm `docs/agentbrain/2026-11-05-capture-precision/tasks/01-review-design.md`）撤掉初稿的硬拦截和子代理上限 2（会误删 42e571e8、c40af79e、c66d4f13 这类条目），门槛改成逐条对比，存量改成固定清单。不改 §10.3，不做自动归档。
- 2026-11-03 删除 `CONTEXT.md`（用户同日决定）：它来自 09-07 一次 grill，之后没人维护，`AGENTS.md`、代码和验证技能都不引用。逐条对照 47 个术语：44 个设计正文已有（含中文别名，如证据层 L1），1 个补进 §7.2（Host Adapter，按现状写明四宿主接法，并改掉"什么都不装进宿主"），2 个丢弃（Procedure View、Workflow Reference，用户 2026-10-15 决定不做 Procedure，§20 把 Workflow 引擎列为 out of scope）。同时按代码改掉两处过期说法（宿主是四个、Pi 装扩展）和一处混淆（`confirmed_by: corroboration` 与 Corroboration Count 不是一回事）。原指针改为正文定义（§6.3.2、§9.5、§10.2.2），新增 §5.6 收容易混的词。
- 2026-11-03 新增 §7.6（用户同日授权实现）：Codex 会把会话文件压成 `.jsonl.zst`，已登记的 321 个 Codex 会话里 153 个路径失效，L1 里 227 条来源展开不了。方案是读时解析，不迁移数据；文件层只留 `src/transcript-file.ts` 一个入口。按只读 review 修订：准入改成每次读都查；解压前单独查完整性，因为 Node 对截断帧不报错；读开头只读文件前 256 KB。
- 2026-11-03 候选键升级兼容（`feat/knowledge-decisions`）：main 的键是 `sha256(windowId|kind|norm(text))`，本分支改成带最终项目、正文和方案哈希的新键，旧库里已记录的旧键新代码不认识。旧窗口用 `ab work --session <id> --redo` 重跑时，模型给出同样候选会被当成新的：旧条目还有效就重复追加证据，旧条目已被用户归档就以新 id 重新处于 active。修法：候选额外带一个旧键（算法与 main 一致）；没有正文也没有否掉方案的候选，旧键已在 `capture_candidates` 里就当已处理、不写入；带详情的照常写入（main 的条目没有详情，算新内容）。判断收在 `intake.freshAdmissions` 一处，抽取窗口与一步式两条路径共用。不删旧键、不迁移数据、不改新键算法、不加配置。同一修法还要盖住 duplicate 分支里的跨会话印证：confirm 事件与它跟的那条证据同生共死，证据按旧键算已处理时 confirm 也跳过；否则重跑会把会话 A 的条目转正，而会话 B 的证据并没写进去。
- 2026-11-02 §8.11 修掉会悄悄丢内容的路径（round4，用户先定方案再实现）：① 每条候选证据上限 3 → 6，超过只取前 6 条并记 `evidence_truncated`，引用被截掉证据的方案整项丢掉，不再整条丢候选；提示词写明上限。② 关系判定输入保留正文内部的换行和缩进（只去首尾空白，仍 2000 字截断）。③ 第 2 层判 duplicate 时，被归档那条带详情且两边详情不一致就改记 `refines`，两条都留。④ 同窗口候选键加上方案哈希，没有方案的候选键不变。⑤ 第 1 层显式 duplicate 因详情不同降级成新条目时首次写入就标 `unreconciled`。⑥ 抽取侧方案长度改按存储侧的口径（先查密钥、再脱敏、按脱敏后 200 个码点），删掉抽取自己的 100 字检查和常量。⑦ 抽取正文先查密钥脱敏，再按脱敏后 5000 字判。⑧ 方案条数上限改用存储侧的 5 项，超出只取前 5 项并记 `alternatives_dropped`。⑨ `ab curate` 带详情的条目连自动合并也跳过。
- 2026-10-30 新增 §8.11（CANDIDATE）：决定记成决策卡（具体定了什么、背景、否掉的方案、长正文），抽取新增知识（note）并带长正文，原话片段存原文（§13.3 加例外），候选可按已登记的目标项目归属，项目目录里搜索带上其他项目的相近条目。起因是用户要求完全替代 Pensieve。
- 2026-10-30 §8.11 按 astra 方案 review（pm `docs/agentbrain/2026-10-30-knowledge-decisions/tasks/01-design-review.md`）修订：追加证据也存原话、引文带各自时间；note 证据用助手原话并且核验送 body；Pensieve 用补详情事件、不截断；归属失败标「归属未定」、关系链按最终项目重算；去重含 body；correct 不继承详情、curate 跳过带详情条目；统一脱敏边界；跨项目段先限定再排序并提示向量未补齐；一步式抽取在补证据前不得打开；子代理是否可见跨项目段待用户定。
- 2026-10-30 §8.11.8 用户选 A：主会话和子代理都能看到跨项目搜索段。
- 2026-10-30 合并 PR #70（refactor-batch1）、#71（prompt-version）后章节号重复，用户同意改号：「模型产出的提示词版本」8.8 → **8.10**（挪到 8.9 之后），「场景分组目录」11.8 → **11.11**（挪到 11.10 之后，小节 11.11.1–4）。「去掉候选区」仍是 8.8、「记忆看板」仍是 11.8。文内、调研文档、`prompt-version.test.ts`、`topic.ts`、`topic.test.ts` 的引用一并改；更早修订记录里的旧编号已就地改并注明。
- 2026-10-30 新增 §11.10：规则按场景（design / code / review）打标签；带场景的规则移出 brief 通用段，按 `--scene` 单独成段加载，没有场景时只给一行索引；`herdr-dispatch` 按派活单类别在发出的文本里加显式 `--scene` 指令。用户同日提出并同意"写设计、派 astra review、再派实现"。astra xhigh 只读 review 报 6 重要 2 次要，主会话核实后全部采纳：场景段先按项目范围筛、correct 继承标签、search `--scene` 只列举不配关键词、去掉 `AB_SCENE` 改显式指令且放在 pstack 前缀之后、D8 加 code 并把 R2 改成自带标准的清单、总预算合同与实际交付 id、scenes 与 guidance 互斥。同日实现后代码 review 又核实 4 条并修掉：`guidanceBlock` 兜底跳过带场景条目、`curate` 转正不打 guidance 且改写复制 `scenes`、`search --scene` 不再过滤未确认规则、`--scene` 配 `--kind` 非 rule 或 `--archived` 在 CLI 边界报错。
- 2026-10-29 用户授权修复 §11.9 review 核实的问题。查询事件独立记录、最终回答按宿主结束字段识别、钩子与用户轮一一归属、引用事务重建，宿主验证合为技能内的隔离断言驱动。不优化全量重扫，不改正式库和宿主全局配置。

- 2026-10-29 用户批准实现 §11.9（"开始改吧"），11.9.6 三问按推荐定；入口对比评测改为 Claude Code、Codex、Pi 三宿主。
- 2026-10-29 §11.9 改为最终版（CANDIDATE，只有文档）：先写清用户的四个痛点（看不出记忆起了什么作用；没有标注时分不清原因；按字面相似度挑记忆不合适；显示和记录是两回事）。方案：每轮不再自动召回，改成偏好常驻 + brief + 模型自己查 + 一句提醒；显示开关打开时每个回答末尾固定一行"记忆：…"（没用上写"本轮未用"）；brief/search/get 在命令里按会话环境变量记交付，采用报告分采用、明确未用、未报告三种；扫描并入 `ab work --sweep`。隐藏模式下记录采用这次不做。初稿（10-28）里"shell 里拿不到会话编号""ab status 会扫描"两处说错了，已更正。方案经 astra 只读讨论、主会话核实。待用户回答 11.9.6 的三问并说"开始实现"。
- 2026-10-26 用户授权实现 §8.10「模型产出的提示词版本」（原编号 8.8，2026-10-30 改号）。普通抽取、一步式、重复追加证据、work 与 Pensieve 共用的关系判定、代码核验在 L1 结论事件顶层记录 model 和 prompt_version。版本只取实发系统提示词全文的 UTF-8 SHA-256 前 12 位。L2 按事件保留产出记录，ab get 展示。旧 topic 的模型与版本只读原值，不回填、不迁移。提示词内容、判断行为、archive 与 confirm 不变。§8.9、§9.6、§11.11 场景目录仍为 CANDIDATE，不做按版本统计或提示词归档。合入 294bfb8 时保留现分支同编号的已批准章节，以章节标题区分，未重编号。实现沿现有事件体和 fold 投影扩展，不新增存储表或配置。2026-10-26 主会话明确本单只覆盖上述五条链路。`ab curate --apply` 改写的 remember 本次不带 model / prompt_version，ab get 显示“未记录”；多位审稿人一致结论、主审与仲裁如何归属模型和提示词，留待设计后单独授权。

- 2026-10-26 用户授权实现 refactor-batch1，仅做四项。① 将 `work.ts` 两处跨会话印证转正的资格与 confirm 事件体生成合为一个函数，以含 `unreconciled` 检查的规则为准。这是行为修正，防止关系未判定的目标被新窗口重复证据自动转正，落实 §8.3。② 一步式输入直接组装并明确传入 worker 说明，公共判断要点与各自输出格式要求分开定义，避免整段替换误改仓库背景或靠正则裁剪规则。正常输入的提示词逐字不变，系统提示哈希 `eea066fc04d0` 与话题版本 `1afa045d9d7c` 保持不变。③ 删除 #69 后无调用方的 `CurateBody`、`StageBody`、`rememberEventsSince`，保留旧事件 kind 的识别和跳过。④ 删除 `projectIdByName` 包装并直接调用 `store.ensureProject`，合并两处宿主会话解析并保留各自错误文案与首个冒号之后的完整 session id，删除话题切块中无人消费的 marks 结果及中间变量。第四项只减少重复和无用数据，不改变外部行为、话题重跑、标记保留或首次定锚。
- 2026-10-22 去掉候选区（§8.8）。用户 15:03（新加坡时间）选方案 B 并说"直接开始实现"，同意改动 2026-10-15 那条 LOCKED 规矩：agent 不带 `--confirmed` 的 `ab remember` 和自动抽取都直接进正式库、标未确认。依据：62 条候选从 10-15 起没人转正（`ab curate` 无排程、无 `review.json`），搜索和召回看不到它们。同时修了额度用完后的自动恢复（抽取、embedding、代码核验）。
- 2026-10-21 11:55 用户批准实现 §11.8；实现差异记在 §11.8 开头。
- 2026-10-21 11:44 用户裁决：开关用 `ab setup --cite on|off`（work_meta，默认 off）；评测四宿主真实会话。§11.8 无待定问题。
- 2026-10-21 11:39 用户最终裁决 §11.8.9：手写的"## 记忆（agentbrain）"段收归 `ab setup` 托管（备份、dry-run 预览、幂等、--remove-notes 只删块）；上线前 20 轮评测必做；引用指令默认关，评测和用户审阅后再开。
- 2026-10-21 11:34 用户再裁决 §11.8.9：`ab-used` 带标题和 id（程序只认 id，标题不符只标记）；不设精确率门槛，标了即算用上；四个宿主全局指令文件由 `ab setup` 加标记块说明（幂等、备份、可删）。人工标注评测是否做仍待定。
- 2026-10-21 11:08 用户对 §11.8 裁决："用上"选 (b) 模型自报引用（新增 11.8.9 注入格式改动，涉及 §11.3，待确认）；两张统计表都加；只手动生成；内部分享默认带正文和项目名、脱敏常开。顺带查明 supersedes 19 / superseded_by 8 是投影规则所致（见 11.8.1）。仍是 CANDIDATE。
- 2026-10-21 新增 §11.8（CANDIDATE）：记忆看板。扩 `ab view`，加健康概览、关联图、注入统计、调优清单和脱敏分享模式；实测现有 `prop_usage` 只记注入累计数（含常驻偏好、brief），没有逐次明细，"用上"无信号；提出 `inject_log` / `recall_runs` 两张有界工作表。未实现，等用户裁决。
- 2026-10-22 补录 10-15 借鉴方案。逐项按 `9cb3d5b` 复核，新增内容均为 CANDIDATE，不构成实现授权。§8.6 已有一步式版本记录，§8.7 已合并召回版提示词，§11.5 已记场景目录搁置，不能按 10-15 的旧现状重新立项。用户确认本次以 `9cb3d5b` 验收，只改本设计与腾讯调研两份文档，只提交一次、不 push。
- 2026-10-15 用户批准四条腾讯机制进入设计，待审阅并说"开始实现"后才写代码。补录位置为 §8.10 提示词版本、§9.6 适用范围变化与历史叙述关系、§8.9 历史会话严格抽取、§11.11 只存标题和成员的场景目录，状态均为 CANDIDATE。参考 `feat/server_team` 的 `37b1629`，不是原调研的 `97f9465`。用户同时决定不从会话提炼可复用做法（Skill / SOP），理由是它不属于记忆职责，§5.5 删除 Procedure View，§20 加排除项。与 §4 的 workflows LOCKED 条文有冲突，本次保留原条文并在 §5.5 明示，待用户单独裁决。§8.9 的严格版与 §8.7 普通版分开；§11.11 保留后来评测搁置的结论，不重开 PR #56。

- 2026-10-20 安装后的默认共享服务仍缓存第一次加载失败的模块。`opencode reload`、更换链接名和源文件名后，日志仍报默认导出不是对象，新会话也未收到召回。新起的 `--standalone` 服务读取同一插件能成功。为避免中断其他活动会话，本次没有重启共享服务，默认启动方式的接线仍有这一阻塞。插件安装项最终为 `agentbrain-v2.js`。
- 2026-10-20 实测 opencode v2.0.30 与 `~/.config/opencode/node_modules/@opencode-ai/plugin` 的旧式类型声明不同。旧插件报 `Plugin must export a default definition with an id and an effect or setup function.`，旧 `session` 表也不含本次新会话。按正在运行的 v2 改用 `setup`、context hook、`session_v2` 与 `session_message`。真实会话 `ses_ea7577936ffegXRW17PRkM0lGI` 的回答逐字输出 `[873b78e2]` 与 `[3bf3029b]` 的召回块，store 登记 `host=opencode, via=hook`，退出后处理进度推进至 `msg_158a887290012MTps7ekQjqqTa:1`。第一次失败的验收不算通过。
- 2026-10-20 用户要求把 opencode 装上 agentbrain，并授权实现、安装和真实会话验收。新增 §7.5，撤销 §20 对 opencode 的范围排除。SQLite 来源使用固定数据库中的真实会话引用，不导出正文。子会话按 ephemeral 跳过。宿主进程检测仍以最近父进程为准。分支基线由用户纠正为 `docs/agentbrain-v2-design`，不是尚无实现的 `main`。本次不启用话题开关、不加载 launchd、不扩展 CLI 审稿后端，不改变其他宿主行为。

- 2026-10-20 文档同步：§8.7 修法 1–3、§11.6 (i)(ii)(iii) 状态由"实现中"改为已实现并合并（#54 `012a971`、#59 `25c761f`、#62 `1d83866`）；§8.6 指向 §8.7 的"在 PR #60"改为"见下节"；评测 12、13 文档并入主线（原 PR #60、#61 由本次取代）；重新脱敏两份已合并的评测数据（`eval/topic-windows/runs/astra1.jsonl`、`eval/onepass-replay/run1-meta.json`），评测 07、11 汇总数字复现不变。不改任何规则和代码。
- 2026-10-19 16:02 用户批准 §11.6 (i)(ii)(iii) 与 why 重复打印修正，关联默认显示（一行，不展开）；与第 8 篇不冲突的理由写在 §11.6 开头。抽取写被否方案（"不做的"第 3 条）不在范围。
- 2026-10-19 新增 CANDIDATE §11.6（未授权实现）：搜索结果第 9–16 名给一行、`ab search`/`ab get` 显示双向显式关联（含已归档/已替代的对方）、Pensieve 导入条 `ab get --expand` 打开原 md 文件；顺带记下 §11.5 (ii) 的 why 重复打印问题。依据 `docs/eval/13-linked-recall.md`：无偏 43 道多条题里 `ab search` 缺的 26 槽，显式关联只补 5、17 槽排在第 9–24 名被截掉；不做图谱层、新关系类型和每轮扩展。
- 2026-10-19 §8.7 修法 1–3 获批（用户："改吧"），状态改为已批准、实现中：一步式提示词换成 V1（`eea066fc04d0`，逐字相同），上限 5→8 为代码常量；修法 4 待定，5、6 不做；不改 LOCKED 规则、不改《好记忆的标准》。实现见 PR #54 / #59。
- 2026-10-19 新增 §8.7 一步式沉淀的召回修法（CANDIDATE，只有文档，不改代码）：评测 12 逐条查了一步式重抽漏掉的有用记忆，主因是"没挑出来"（20 条里 15 条），不是标准太严、不是匹配员漏认；建议先只改提示词（去掉少给的偏置、加按类清单、上限 5→8），不放宽标准、不加新层。召回版提示词试跑只完成 11/38 个窗口（Codex 额度用完），待跑完再定。（同日续跑到 22/38：有用 9/10 对 5/10，没用挡掉 8/10 对 10/10，总对 18/24 对 16/24；剩下 15 个窗口换火山 DeepSeek 同模型补跑完：有用 4/7 对 2/7，总对 9/17 对 7/17，见评测 12。）不改任何 LOCKED 规则。
- 2026-10-16 §8.6 / §11.5 由用户批准实现（PR #58 四个问题回"实现"）：话题结束时一步式沉淀落地在 `src/topic.ts` 与 `ab work` 的话题模式，**默认关闭**（`extract.json` `"topic": true` 打开），等 `docs/eval/07` 补跑与 `docs/eval/11` 验收后由用户打开；和原文不同的几处（并入只进报告不写库、无引文记 agent 推断、旧路径 30 分钟不动、压缩标记存 work_meta、额度不算失败尝试）见 §8.6 第 12 点。§11.5 两项（brief 提示何时先 `ab search`、搜索结果显示全文）同批实现，不加开关。
- 2026-10-15 新增两个 CANDIDATE 设计（未授权实现，用户说"开始实现"后才写代码）：§8.6 话题结束时一步式沉淀——静置约 20 分钟、上下文压缩、会话结束三个触发，整段话题加前文交给宿主自己的子模型一次完成抽取和判断（`src/onepass.ts`），记下来源定位点范围、触发方式、`prompt_version` 和模型；三个宿主今天能用的事件已按官方文档和本机版本核对（Claude Code `PreCompact`/`SessionEnd`、Codex `PreCompact`/`SessionEnd`（闲置 30 分钟也触发）、Pi `session_before_compact`/`session_shutdown`），都没有现成的 20 分钟静置事件，建议在下一轮的 capture hook 里判断。§11.5 两个读路径小改动——brief 点出几类先 `ab search` 的情况；`ab search` 结果显示正文全文、为什么、场景，附改前改后示例。依据：用户 2026-10-15"一个主题的对话完了再抽""可以"、pstack 简化方向、场景目录评测（`docs/eval/10`）不如一次 `ab search`。一步式与两步式对比（`docs/eval/07`）还没跑完，§8.6 第 6 点以它为前提。
- 2026-10-15 评测记录归档：把截至今天的所有评测（检索门槛 v1、每轮召回准确率与资格策略、防记错一次性授权、预检与引用核验、价值标准抽取门、审稿评审团 v1～v6/主审/单审/Haiku、一步式与两步式重放（未完成）、图 1 跳、场景层模拟、场景目录开工背景评测）整理到 `docs/eval/`：一篇索引加每项一篇，写明问题、数据（怎么构造、种子、划分、谁标注）、方法、复现命令、结果、结论和据此做的决定、保留意见。数据和脚本在 `eval/<名称>/`，均已脱敏；库快照、完整记忆导出和转录不进仓库，只留在本地。场景目录（PR #56）评测结论是不如一次 `ab search`，PR 搁置。
- 2026-10-15（已被 2026-10-22 §8.8 撤销）agent 的 `ab remember` 也走候选区（v3）：用户发现 Claude Code 主模型仍按全局说明在干活中直接 `ab remember`，绕过了"快模型抽取 → 后台审稿"的流程（#53 只改了自动抽取）。现在不带 `--confirmed` 的 `ab remember` 写进候选区（`candidate`），等审稿；`--confirmed`（用户明确要记）照旧直接生效；新增 `--direct` 只给人工迁移数据用（写入事件带 `direct: true`，`ab audit agent-remember` 不会把它当成 agent 自记移进候选区）；`AB_STAGING=off` 同样回到旧行为。brief 提示改为"干活时不用记，后台会自动抽取并审稿；只有用户明确要你记时才用 `ab remember --confirmed`"。新增 `stage` 事件（stage/unstage，可撤销，用户确认过的条目投影时忽略）、`ab stage <id> [--undo]` 和 `ab audit agent-remember --since <时间> [--apply]`，用来把候选区上线后 agent 直接写进正式库、未经用户确认的条目移回候选区。
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

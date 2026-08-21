# agentbrain 总体设计

- 状态：**v2 架构基线，实施受 Design Gates 阻断**
- 最新修订：2026-08-21
- 实现状态：**未开始**
- 设计母体：abrain 的 event-first、统一命题、结构性沉淀、确定性投影、分层读取与自治纠错纪律
- 首发宿主：Pi；v2 不承诺其他宿主
- 决策地图：[绘制以 abrain 为母体的 agentbrain v2 路线](https://github.com/josheee1117/agentbrain/issues/1)
- 领域词汇：`CONTEXT.md`
- 主要证据：
  - `docs/reference/20260804-pi-astack-abrain-sediment-架构与实现参考.md`
  - `docs/research/20260820-tencentdb-agent-memory-调研.md`
  - `docs/research/20260821-pi-memory-集成与子代理接缝.md`
  - `docs/research/20260821-current-abrain-sediment-复核.md`

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
| 主 Agent 语义推断 | Proposal |
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

禁止建立批量记忆审批后台作为正常闭环。进入 stable Policy View 的高影响 Proposal 必须经过独立证据、明确用户 directive 或另行冻结的高影响校准策略；不得仅凭单模型高 confidence 发布。

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

- 新内容不因时间更新就自动覆盖旧内容；
- 可能冲突的 propositions 同时保留并显式建立 conflict/counter-evidence；
- 能由 scope、subject、time 或 qualifier 区分时，细化为不同 proposition；
- 用户 correction 可以明确 supersede；
- 低风险、规则确定的更新才允许自动 supersede；
- 未解决冲突在 Memory Card 中必须暴露，不能静默只返回一边。

### 9.3 身份和 lineage

L2 proposition 使用不依赖正文、文件路径和 content hash 的稳定逻辑身份。正文改写不自动产生无关记忆；merge/split/supersede 保留 lineage。

L1 event/record 的物理 identity 与 Physical Purge 存在硬设计门，见 §19.1。

---

## 10. Archive、Forget、Purge 与 Outcome

### 10.1 必须支持的共同语义

- Correction/Supersession：保留历史，改变当前结论；
- Archive：默认读取面不选中，但仍可追踪；
- Reactivate：有新证据时恢复；
- Semantic Forgetting：保留必要审计关系，但不再检索和注入；
- Physical Purge：从 agentbrain 控制的内容存储和派生物中清除敏感正文。

非 Purge 的终态应可追溯、尽量可逆；disuse/usage-only 不能单独静默删除长期 Decision、Maxim 或 Preference。

### 10.2 Physical Purge 边界

Purge 至少覆盖：

- L1 body；
- L2 views；
- L3 index/cache；
- Durable Work Store 中的相关正文；
- agentbrain 管理的临时文件和可访问本地副本。

只留下不含原文、秘密、可逆摘要或不必要敏感元数据的最小状态。对远端 Git 历史、外部 clone、第三方备份和 Pi transcript 只报告 best-effort，不承诺全球可验证擦除。

Purge 只能由可信 Human/operator 的显式控制路径发起；普通 transcript、记忆正文、模型输出、Agent Proposal 和外部 Skill 指令都不能触发。操作必须指定精确目标和范围，执行前显示将覆盖的受控存储边界，执行后逐面报告 success/partial/failure。子代理永远没有 Purge capability。

具体 event identity/tombstone 模型尚未关闭，不能实施。

### 10.3 自治遗忘和 Outcome 范围

v2 必须有 explicit archive/reactivate、supersede/withdraw/expire、forget/purge 分离。

以下能力由 Wayfinder 继续裁决，可只做 shadow instrumentation：

- 自动 archive executor；
- 自动 reactivate；
- retrieval/injection outcome；
- 去自回声；
- resurrection-rate；
- kind-distribution；
- archive recommendation；
- outcome 驱动 prompt/policy evolution。

没有真实 corpus 和消费方证据时，不默认复制 abrain 全套 aggregator、多模型 reviewer 和自治遗忘执行器。

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
- cutover 前保留只读备份，回退依靠备份而非双主。

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
- 最近 capture、projection 和 retrieval degradation。

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

---

## 18. 候选里程碑

以下里程碑是实施顺序框架，不等于实现授权；§19 Design Gates 关闭后才能冻结。

### D0：关闭实施前设计门

- L1 identity × Purge；
- Durable Work Store；
- unified proposition/L2 views；
- identity/project binding/loadout/delegation；
- privacy/retention/security；
- sediment promotion；
- autonomous forgetting/outcome 范围；
- local store/export/migration；
- operations/degradation/diagnostics/recovery；
- retrieval contract；
- acceptance gates 与 rollout。

### P0：Pi lifecycle / worker prototype

- capture seam；
- branch/compaction；
- parent 退出后的 worker；
- duplicate delivery；
- user-turn/delegation lineage；
- first-turn model registry；
- degraded behavior。

### P1：L1 / Purge state-machine prototype

验证 append-only lineage、合法 purge、missing/corrupt/purged 区分和 rebuild。

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
- forget；
- purge。

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
- bounded retry/defer/expiry；
- INV-INVISIBILITY。

### M6：Evaluation、Migration 与 Rollout

- fixture/E2E；
- authorized inventory；
- one-way import；
- dogfood；
- rollback；
- release gate。

---

## 19. 实施前 Design Gates

### 19.1 L1 Identity × Physical Purge

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

### 19.3 Pi Worker 拓扑

Prototype 裁决 daemon、短命 worker、进程内 worker、RPC 或混合；不得只凭 pi-astack 当前实现选择。

### 19.4 L2 Contract

冻结 proposition envelope、facets、stable identity、四种 readable views、组合视图物化、projector version 和 schema migration。

### 19.5 Identity / Project Binding / Loadout / Delegation

冻结 stable project ID、显式本机 binding/registry、多个 checkout 的执行根区分，以及 capability 建立、收窄、过期、审计和子代理回流；禁止 `cwd`/Git remote 隐式授予项目身份。

### 19.6 Sediment Promotion

冻结低风险自动晋升、高影响 Proposal、自治 reject/expire/defer、自然对话校准，以及 accepted proposition → stable Policy/Context Brief 的独立发布门；不建立人工审批 inbox。

### 19.7 Retrieval Default Profile

由中文 fixture prototype 选择默认 lexical/dense/fusion/rerank；不得把 v1.2 三级栈直接写进实现。

### 19.8 Store / Export / Migration

冻结物理布局、backup/export、schema migration，并在另行授权后盘点真实资产。

### 19.9 Forgetting / Outcome 范围

冻结 v2 只做显式 archive/reactivate + instrumentation，还是纳入自治 archive、reactivation、outcome 和 monitor；任何自动执行器都必须有真实 corpus、消费方和可复现指标支持。

### 19.10 Operations / Recovery

冻结运行接口、资源上限、typed degradation、retry/defer/terminal、doctor/status、手动等价操作和灾难恢复合同。

### 19.11 Acceptance / Rollout

把领域不变量、Pi E2E、隐私隔离、检索 fixture、迁移和 dogfood 组织成硬验收门，冻结 D0/P0-P2/M1-M6 的最终内容和 rollback 条件。

### 19.12 Gate → Wayfinder Ticket

| Gate | Canonical ticket |
|---|---|
| L1 Identity × Purge、Durable Work Store | [定义 L1 证据账本与 durable intake 合同](https://github.com/josheee1117/agentbrain/issues/4) + [定义本地安全、隐私、保留与 Purge 合同](https://github.com/josheee1117/agentbrain/issues/5) |
| Pi Worker | [原型验证 Pi Adapter 与后台 Worker 拓扑](https://github.com/josheee1117/agentbrain/issues/11) |
| L2 Contract | [定义 L2 记忆身份、投影与生命周期合同](https://github.com/josheee1117/agentbrain/issues/8) |
| Identity / Project Binding / Loadout / Delegation | [定义身份、作用域、Loadout 与子代理委派合同](https://github.com/josheee1117/agentbrain/issues/6) |
| Sediment Promotion | [定义自动沉淀、Proposal 晋升与人工校准合同](https://github.com/josheee1117/agentbrain/issues/18) |
| Retrieval Contract / Default Profile | [定义检索、Memory Card、交付与评测合同](https://github.com/josheee1117/agentbrain/issues/9) + [原型验证中文检索与 Rerank 取舍](https://github.com/josheee1117/agentbrain/issues/10) |
| Store / Export / Migration | [定义本地 Canonical Store、同步中立与迁移合同](https://github.com/josheee1117/agentbrain/issues/13)；真实资产盘点另见其受隐私 gate 阻塞的子任务 |
| Forgetting / Outcome | [定义自治遗忘、归档、复活与 Outcome 回流合同](https://github.com/josheee1117/agentbrain/issues/19) |
| Operations / Recovery | [定义运行接口、降级、诊断与恢复合同](https://github.com/josheee1117/agentbrain/issues/14) |
| Acceptance / Rollout | [定义 v2 验收门、里程碑与 rollout 决策](https://github.com/josheee1117/agentbrain/issues/15) |
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

- **2026-08-21 v2 architecture baseline**：Wayfinder 重绘。设计母体改为当前 abrain unified proposition/event-first；首发宿主改为 Pi-only；新增 Durable Work Store、Human/Agent/Loadout/delegation、Proposal 双状态轴、Physical Purge、Memory Card、隐私威胁模型和可复现评测；八区重新映射为统一 proposition/read models 与独立 Skill/Vault seams；TencentDB 只做 abrain-first 选择性吸收；Git、Worker、Purge identity 和检索算法降为实施前 Gates；旧 M0-M4 被候选 D0/P0-P2/M1-M6 取代。理由：保留 abrain 核心纪律，同时避免宿主耦合、平行真相、平台膨胀和未经验证的实现选型。
- 2026-08-04 v1.2：增加 abrain/sediment 实现参考，未改变 v1.1 主体。
- 2026-08-04 v1.1：检索栈升级为三级阶梯并补充 abrain 架构全景。
- 2026-08-04 v1：Claude Code/Codex 通用记忆设计初稿。

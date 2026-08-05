# pi-astack abrain / sediment 架构与实现参考（移植对照本）

- 状态：参考文档（read-only 快照整理，不承载 agentbrain 决策）
- 快照基线：pi-astack HEAD `ad6aa8f`（2026-07-30），覆盖至最新提交 `1bd156a`（LSEA foreground capture-only fix）
- 素材来源：`docs/architecture/*.md`（7 份现状规格全文）、`docs/adr/`（37 篇全部过读，0039/0040/0043 全文精读）、`extensions/{abrain,sediment,memory,_shared}` 源码精读（含导出符号地图与关键实现核对）
- 与主设计的关系：`20260804-agentbrain-总体设计.md` 附录 A 是"采纳映射级"摘要；本文是"实现级"深挖——字段级 schema、流水线细节、状态机、prompt 设定、每个决策的抉择过程。**移植取舍时读本文，无需再翻 pi-astack 源码。**
- 阅读提示：pi-astack 处于高速演进态，本文严格区分「现役」「已退役」「目标态未实施」三类，标注以 2026-07-30 快照为准。

---

## 1. 系统总览：四件套分工

abrain 记忆体系由四个 extension 目录构成，职责严格分离：

| 目录 | 角色 | 一句话 |
|---|---|---|
| `extensions/abrain/` | 壳 / 宿主集成 | 目录布局、项目绑定、git 同步、规则注入、vault、prompt_user |
| `extensions/sediment/` | 唯一 writer | agent_end 结构性触发 → 提取 → 裁决 → append L1 → 投影 L2 |
| `extensions/memory/` | 只读检索面 | memory_search 检索栈、注入器、数据模型解析、治理工具 |
| `extensions/_shared/` | 存储基座 | L1 证据原语、proposition 管线、canonical git 运行时、锁/原子写 |

规模感（2026-08-04 盘点）：约 133k 行，其中仅 195 行（0.15%）真正触碰 pi 宿主 API，宿主契约仅 3 个方法。**可移植的是思想与写入纪律，不是整库照搬**——这也是 agentbrain 立项的前提判断。

### 1.1 八阶段演进史（overview.md 的官方叙事）

理解"为什么长这样"的最短路径。每一阶段都是被上一阶段的真实失败逼出来的：

1. **Pensieve 阶段**：项目内 `.pensieve/{maxims,decisions,knowledge,pipelines}`。价值=知识有类型；局限=绑定单项目，跨项目偏好/技能/secrets 无处安放。
2. **专门向量库阶段（gbrain/Postgres/pgvector）**：暴露的问题——基础设施重、"记忆真相"和索引实现绑死、为搜索设计存储反过来腐蚀认知模型。**gbrain 退出主路径**。
3. **回到 Markdown + Git**：人必须能读、变化必须能审计、git 提供历史回滚、**搜索索引不应是真相源**。
4. **Abrain 出现**：问题从"这个项目记住什么"变成"这个人跨项目长期记住什么"→ `~/.abrain/` 七区数字孪生 + strict project binding（不凭 cwd 猜身份）。
5. **Event-first**：直接改"当前事实"会让历史证据和当前结论混杂 → L1 Evidence Event（真相源）→ L2 确定性投影（当前该信什么）→ L3 可重建索引。解决冲突/supersede/archive/timeline/审计/重建。
6. **写权从主 Agent 拿走**：主 agent 有 `memory_write` 会导致每句话都记、错误总结固化、用户被迫管理记忆 → 主会话只读，sediment 经 `agent_end` 单写。
7. **多 Agent 能力**（dispatch/workflow，agentbrain 不涉及）。
8. **Mission Control 方向**（该 fork 的下一步，agentbrain 不涉及）。

对 agentbrain 的直接启示：**阶段 2 的教训（不要向量库当本体）与阶段 3/5/6 的三条支柱（纯文本 git / event-first / 结构性单写）就是 agentbrain 设计原则的出处。**

---

## 2. ADR 决策演进史：四条链 + 已退役清单

> 本章是"抉择过程"的浓缩。每条按【问题 → 决策 → 为什么 → 否决了什么】展开，标注 ADR 编号与现役状态。pi-astack 的 ADR 有独特的生命周期管理：机制正文会被 ADR 0034 的 ingest lane 分解为 typed entry 存入 abrain 自身（吃自己的狗粮），ADR 原文退化为审计残桩；`status: archived/superseded` 不代表方向被推翻，常常只是"机制细节已入库、方向已上提到 direction.md"。

### 2.1 写路径链：从机械 gate 到 LLM curator，再到 event-first

**ADR 0003（主会话只读，现役）**
- 问题：主 agent 可随手写记忆 → 每句都记 / 错误固化 / 用户被迫管理。
- 决策：主会话 LLM tool 面**架构性缺席**任何 brain mutation 工具（层 1 mechanic）；经 bash/edit/write 间接触达是**显式接受的有界 residual**（层 2 best-effort），靠输出脱敏 + 事后审计补偿，**不机械封堵**。
- 2026-06-16 修订：撤销了 sub-agent 的 env 闸（`PI_MULTI_AGENT_ALLOW_MUTATING`）——单用户威胁模型下运行时机械闸防的是不可达威胁；真实威胁（恶意 extension）是供应链信任问题，非运行时护栏职责。**"不要为低概率低损失事件建机械防护"是贯穿全库的反模式警惕。**

**ADR 0010（三模型投票 sediment，已归档）→ ADR 0016（LLM curator，现役）**
- 0010 记录了多模型投票方案的 5 个失败根因（共享投票 prompt 破坏模型独立性、强制 JSON 破坏 LLM 输出健壮性、skip 判定占成本大头、无 checkpoint 导致无界重载、盲法定去重反而写重复）→ 结论：**单 agent + lookup tools 胜过多模型投票**。
- 0016 定型：sediment = **LLM curator + 最小硬 gate**。语义判断（写不写/kind/status/confidence）全归 LLM；机械 gate 全部永久删除，只留两类硬 gate：①确定性 secret sanitizer（typed redaction，`[SECRET:<type>]` 占位后**继续提取**，不整轮阻断）②存储完整性（path/schema/lint/lock/atomic/audit/git）。
- 知识库**自演进**：curator 操作集 = `create/update/merge/archive/supersede/delete/skip`；create 前必先 memory_search 找邻居。

**ADR 0018（curator 防御层实验，已归档——重要反面教材）**
- 两次 P0 数据丢失（trigger_phrases 被整体替换、承重 section 被覆盖）后尝试加机械门（body 缩水字节门、H2 section 保留门）。
- 结论：**机械 gate 会静默拒绝 curator 的正当修复，制造永久 stale 的死条目**——最终"退回信任 LLM curator 自演进"（`retreat-to-trusting-llm-curator-self-evolution`），改为修 prompt（update 必须保留 body 契约、trigger_phrases 取并集不替换）。
- 对 agentbrain 的启示：遇到 LLM 语义错误，第一反应是修 prompt 和 examples，不是加代码门。

**ADR 0013（三车道不对称信任，现役）→ ADR 0028（ground-truth 分层，现役）**
- 0013：写入按 **trust × blast-radius** 拆 lane——Lane A（用户手输 `MEMORY:` fence）/ Lane C（LLM auto-write）/ Lane D（auto-promote，**永久禁止**）；不同 lane 失败模式不同，不平摊统一 gate；Lane A 不因 Lane C 的失败教训收紧。
- 0028 的根因发现：**把"用户显式指令"与"LLM 推断假设"当同一信号类，是静默丢失的根**。分流：classifier 管 directive→Tier-1（provenance-gated：verbatim quote 必须结构性源自 USER-role + is_directive + durable；README 里写的 "always use Yarn" 不算 Tier-1——源门挡 transcript 内容注入）；extractor 管 inferred→Tier-2。router/curator 对 Tier-1 的输出空间**排除 skip/stage**（显式指令永不静默丢弃）。
- 0039 修订写入形态后：Tier-1 = 确定性 append witnessed Evidence Event（不再是实时提交 active rule）；**provenance tier 与 compilation maturity 是正交轴**。

**ADR 0024（隐身自治第二大脑，现役——哲学总纲）**
四条硬不变量，是所有后续设计的总边界：
- **INV-INVISIBILITY**：用户不参与大脑管理（不审批/不裁决/不归档/不定期审查）。判别口诀：系统**告诉**用户大脑做了什么=✓健康反馈；系统**要求**用户为大脑做什么=✗违反。
- **INV-AUTONOMY**：大脑不替用户决定。
- **INV-ACTIVE-CORRECTION**：自然对话中"以后用 X / 忘掉那条"是一等纠错信号（提醒不阻止）。
- **INV-IMPLICIT-GROUND-TRUTH**：不把未确认猜测当事实。
经 7 轮多模型评审 + 用户两次元层校正（R5 重定义用户角色、R6 重定义防错范式）才稳定。

**ADR 0031（自治遗忘，现役）**
- 背景：abrain 是"只进不出"的积累系统，corpus 单调膨胀 → 近重/陈旧/噪声上升，抵消检索质量收益。
- 决策：**人类设零可调策略**、大脑全自治自标定、一条不可调结构下限（可逆基座：终态仅全文 `archived`，永不物理删除）。
- 演进（多次 walk-back 收敛）：四开关收敛为两个语义开关（`memory.forgetting.enabled` + `instrumentation`）；evidence-first + kind prior——自动 archive 硬门=`op=archive` 且证据∈{superseded_by, contradicted, version_stale}，**disuse/usage-only 永不单独触发遗忘**；fact/smell 允许弱信号，anti-pattern/maxim/preference/decision/pattern 是长尾桶需强 supersede 信号；`review_required` 指自治 reviewer 复核（**不是人审**）。
- 双门授权（2026-07-23 起正式全量生产）：`executorRealApplyEnabled===true`（字面布尔，字符串永远无效）AND `sediment.autoLlmWriteEnabled=true`，任一门不能单独授权。5/batch、20/day、CAS、corpus floor、resurrection backoff 作为熔断器（不是 canary）。
- 自校准回路：resurrection-rate monitor——复活率异常=遗忘过激的报警输入（但低复活率不能证明安全）。

**ADR 0039（统一证据架构，现役——存储基座总纲）**
- 根因：高不确定性的语义裁决（合并/scope/去重/归档）被放在高影响的实时写入路径（`agent_end` 直改 active 文件），每个边界案例都催生局部补丁。这不是 Constraint 一个域的问题，是所有域共有的结构问题。
- 决策：**唯一低风险写原语 = append Evidence Event**。L1 内容寻址一事件一文件 immutable canonical JSON（RFC8785/JCS；`event_id = sha256(JCS(body))`；路径 `l1/events/sha256/ab/cd/<hex>.json`）；L2 确定性投影（拓扑排序+稳定 tiebreak，固定模板/UTC/LF，手改=dirty derived view 阻断 push，merge 冲突的 L2 直接丢弃重投影）；L3 SQLite 可重建索引（不入 git）。
- 存储基座选型 **HYBRID_MD_GIT_PLUS_DB** 的否决清单：禁止 LLM merge；禁止同步 SQLite/二进制库；禁止 Postgres/Neo4j/Kuzu/LanceDB 当真相源（只有真实负载证据才允许拆分，且拆出后仍是可重建派生）；首期禁止跨设备共享 append 的 NDJSON（会破坏确定性 git merge——这就是"一事件一文件"的存在理由）。
- 安全门与语义门分层：secret/PII/path/注入检查在 **append 前**；merge/scope/dedup/冲突裁决在**投影时**。LLM 产物入 L2 前必须先固化为 L1 event（记 model/prompt_hash/input_hash/output_hash）；**最终 L2 字节生成禁止直接调用 LLM**。
- 显式用户信号不得因 classifier 不确定而静默丢失——进 unclassified/queued event，不丢。

**ADR 0040（统一命题证据模型，现役——当前架构的 keystone）**
- 事故根因：task/session 一次性指令被误判为持久规范内容；provenance、空间 scope、时间视界、always 注入资格被耦合成单一"规则"事实；缺生产撤销闭环——错误进入 compiled/always 注入面后只能靠代码补丁清理。
- 决策（六厂商 T0 三轮收敛 + 用户 ratify）：
  - 取消独立 Rule/Constraint 本体——**Knowledge 与 Policy 的差异是读取契约差异，不是真相源差异**。统一 typed proposition：`descriptive`（描述性主张）/ `normative`（偏好/约束/义务）/ `meta-lifecycle`（retract/rescope/supersede/archive/reactivate）。
  - **正交 facets 不得压扁**：provenance/authority、spatial scope、temporal horizon、trigger、maturity、contestability、confidence、sensitivity、consumer hints、causal lineage。`normative` 只表示"可能影响行为"，**不自动等于"必须 session_start 注入"**——`injectMode`/always 资格是 projector 的**派生读取决策**，不是写时事实。
  - 共享生命周期协议：五种动作全部是追加 `meta-lifecycle` L1 event + `causal_parents` 精确引用；projector 先解析生命周期关系再形成有效命题集合；未知 parent fail-closed。
  - **No-migration cutover**（用户拍板）：旧 rules/compiled rules 全部不迁移不转换不自动激活，只留冷审计；新 policy view 从 genesis 边界重新长——"迁移兼容会把旧事故根因带入新架构"。
  - 逐读取面授权：ADR 通过不授权代码切换；一个读取面的 cutover 不授权其它面。Policy/session-start 面 2026-07-20 获 full flip（无回退，失败策略=loud zero injection）。
  - 平台硬边界（密钥/权限/路径/工具参数）**不是可学习 proposition**，不能被 normative evidence 放宽。
- 被拒绝方案（§10 原文明列）：独立 Rule ontology/graph/lifecycle ledger（重新制造真相分裂）；所有消费面合成单一 projector（pull 与 push 的 freshness/风险/预算/失败语义不同）；injectMode 固化为写时事实；hard safety 写成可撤回记忆规则；为旧规则做迁移层；一次性全域 read flip。

**ADR 0043（生命周期收敛与可逆终态，现役）**
- 问题：三类长期工作项（provisional-correction staging / multiview-pending / lifecycle proposals）各自记 retry/defer/terminal，失败项可无限悬挂。
- 决策：统一 read model `lifecycle-convergence.json`（确定性、可丢弃重建，**无反向写权**）；所有非终态项必须同时有下一触发和 deadline（禁止 `pending + no schedule + no deadline`）；失败分类表（provider/transient/parse/conflict/writer/semantic_defer/none）各配调度语义；**E2（superseded 无有效 successor）固定为自治 evidence-defer，不是 review queue**；终态必须保留全文且可逆（禁止 unlink、禁止 digest-only tombstone）。

**ADR 0044（中心 sediment / 边缘 authority，目标态）→ ADR 0045（worker 安全 RPC，Stage A 机制已实现）**
- 0044 动机：多实例/多设备下接收权威、执行器、publication、git 协调都在设备上，难单点观测修复。T0 R4 批准：edge 只保证 **source 不丢 + 交互不阻塞**（awaited 路径 p99<100ms：agent_end/agent_settled 只做本地 durable capture/TerminalWitness）；中心成为 source/job/decision 权威；禁止永久双主；git 降为异步导出/灾备。关键概念：candidate ≠ settled；C6 因果身份 `(session_id, turn_id, subturn, sub_agent_label, parent)` 与 `run_generation` 执行代际**严格分离**。
- 现状（务必分清）：**当前生产权威仍是本地 intake+queue+publication**；Pi 侧 capture-only protocol shadow 已实现且**默认关**（生产验收 v3 已过：300 samples、end p99=57.7ms / witness p99=18.6ms）；Stage A/B/C 未实施。
- 0045：daemon 托管的短命 headless worker——`PI_ASTACK_SEDIMENT_WORKER_MODE=1` 下 sediment extension 只注册 3 个 RPC 命令（capabilities/run/maintenance），无普通生命周期 hook。LSEA（local executor authority）single-entry admission：任务准入前 read-lock-read 校验 authority 记录（防 ABA），失败码闭集 `unavailable/revoked/stale` 全部 retryable、全局暂停（不逐条 deadletter）。**authority store 存在时前台 Pi 一律 capture-only**（最新提交 1bd156a 的行为）。

### 2.2 读路径链：从 grep 到三级检索栈

**ADR 0015（LLM-driven retrieval，已归档但框架现役）**
- 问题：token TF-IDF + boosts 的字面检索对中英混合记忆语料失效；"patch grep 解决不了语义等价"。
- 决策：双阶段——stage1 高召回粗筛 + stage2 高精度 LLM 精排；query 是自然语言 prompt 不是关键词；**禁止 result cache**（破坏记忆新鲜度，KV cache ≠ result cache）；检索质量直接决定 sediment 去重质量（search 是 sediment 的 lookup kernel）。
- **REQ-009 accuracy 合同**在此确立：精排模型不可用 = hard error，禁止 grep/BM25 冒充结果。

**ADR 0035（embedding 候选召回，现役）**
- 触发事故：stage1 候选面切到 full-body（全库 2215 条全文塞进 flash prompt）当天，单日 104 次 search 消耗 5290 万 token / $7.97，KV cache 命中率 99.8%→12.5%。成本 = O(库规模×搜索频率)。
- 决策：stage0 向量粗召回（余弦 top-N，N=100 起步，实测 related-recall 98.0%）+ 精确字段 sparse 补盲（trigger_phrases/slug/ADR 编号等 embedding 盲区）→ 只喂 N 条给后续。**反方向澄清**：不走"库治理压缩"缩小候选面——自演进保证库高质量但不保证库变小，**检索架构本身必须 sublinear**。
- embedding 模型是可替换实现参数（settings 配置），架构决策只是"候选面走向量"。

**ADR 0036（两阶段坍缩 + hybrid，现役）**
- 发现：stage0 的 dense 已把候选排好序，stage1 LLM 再从 400 选 50 是在**重做 dense 已经做得更好的事**——该删而非压缩（P8 压缩尝试被 5×T0 判定为绕路）。
- 决策：`stage0 hybrid → top-K → stage2 full-body 精排`，删 stage1（`stage1Skip=true`，仅 verdict=none 时作低频安全网）；BM25 复活为 **char n-gram（CJK bigram/trigram，纯 JS 零依赖）**补 dense 的精确符号/短 query/中文盲区——**是候选召回的一部分，不是降级 fallback**；多向量解 3500 字符截断（单向量截断正是强迫 stage1 存在的根因之一）；sediment dedup 走 dense-only top-10~20（false-merge 比漏召严重）。
- 2026-07-21 实现对齐 walk-back：生产不是 rank-score fusion，而是**固定顺序组池**——dense 先占窗口（扣 freshness reserve 给 stale/missing 条目按更新时间插位）→ 剩余 dense → BM25 sparse → 剩余 stale；allow-set 去重；`stage0MaxCandidates` 封顶（`llm-search.ts::orderStage0Candidates`）。
- 文档教训：ADR 里开放性的"例子"会被读成契约，实现对齐后必须回填 walk-back 注记。

**ADR 0037（facade + profile registry，现役）**
- 问题：检索内核已统一（全部汇到 `executeSearch`），但 5 个调用方各自手搓 `status/limit/stage1Skip/model` 策略。两次真实事故：curator 去重手搓 `status:["all"]` 静默绕过 stage0 优化（每 candidate ~915K token）；全局 `stage1Skip` flip 泄漏进最脆弱的去重路径。
- 决策：typed SearchProfile registry + 单入口，策略集中可审计；明确**不做 God-Facade**（不吞 loadEntries 等基础设施）。

### 2.3 注入链：从 rules 区到 policy stable-view

**ADR 0023（session-start 规则注入，方向现役、机制已被 0040 重写）**
- 问题：pull-only memory 不够——行为规则必须**每会话可见**（push）。
- 原型：rules 作为 abrain 第 8 区（`always` 全文注入 / `listed` 目录行）；无 `/rule add`——规则从自然对话学（sediment classifier 路由 zone/inject-mode/lifecycle op）；注入幂等（nonce fence）；sub-pi 经 `PI_ABRAIN_DISABLED` 隔离。
- 0039/0040 重写后：rules 区不再是写时 source-of-truth 文件集合；**现役注入源唯一是 proposition-policy-stable-view**（content-addressed bundle，`.state/sediment/proposition-policy-stable-view/v1/latest` 指针）。session_start **不调 LLM、不扫 L1、不实时裁决**——只读上一份严格校验的稳定 bundle；stale 可注入但发诊断；invalid/missing = **loud zero**（响亮的零注入，不回退旧源）。设计动机一句话：**注入快、裁决慢、两者解耦**。
- Tier-1 自然纠正的最小闭环（2026-07-25 落地）：纠正 → constraint evidence → dynamic policy proposition → durable pending marker（仅 event id）→ 异步 stable-view force republish。

### 2.4 身份/绑定/同步链

**ADR 0017（strict binding，现役）**
- 核心不变量：项目身份**只认 project_id**，cwd/git remote 永不隐式授予身份。三件套全匹配才 bound：`<repo>/.abrain-project.json`（可携身份声明）+ `~/.abrain/projects/<id>/_project.json`（存在证明）+ `~/.abrain/.state/projects/local-map.json`（**本机路径授权，不入 git**——伪造 manifest 拿不到 vault/sediment）。
- non-bound 态 fail-closed 拒绝项目级写；active project 是 boot-time snapshot（会话中 `cd` 不切换）；migration 不决定身份（`--project` 参数被废弃拒收，先 bind 再 migrate）。

**ADR 0019（vault 自管身份，决策核心现役）**
- 三个根因否决了"复用系统 ssh key 当加密身份"：①每台设备的 default ssh key 通常是不同的 key（路径重名内容不同）→ A 机加密的 master B 机永远解不开；②`.vault-backend` 硬编码设备本地绝对路径，跨设备即失效；③passphrase-only 能 init 不能 unlock（reader stdin 'ignore'）。
- 决策：Tier 1 = `abrain-age-key` 自管 age keypair（secret 0600 + gitignored，pubkey 进 git）；OS keychain 降为 Tier 2 优化层；ssh-key/gpg-file/passphrase-only 降为 explicit-only legacy（带 stderr 警告）；auto-detect 终结者从 passphrase-only 改为 `disabled`（裸环境响亮失败 + 安装提示，不静默滑进解不开锁的后端）。

**ADR 0020（多设备自动收敛，现役）**
- 前提：用户已 clone + 配置 upstream；pi-astack 只继承 remote/认证/transport，不创建不改写不猜测。
- Fast path：fetch 后 `HEAD^{commit}` 与 `@{upstream}^{commit}` 两个 exact OID 严格相同才 noop（禁止用 ahead/behind count/tree equality 替代）；大仓库 noop 成本只允许由 fetch + 两次 OID resolution 主导。
- Divergence：**deterministic device join**，不是通用 git merge——L1 两侧必须 add-only（删除/mode 变化/blob 变化一律 typed fail-closed）；注册 L2 不取任一父提交，从 union L1 **整体重建**；固定 identity/message/date 的 `commit-tree -p H -p U` 保证相同输入产出相同 merge commit；**禁止 git merge-tree/rebase/force push/LLM merge**。真实内容冲突 typed fail-closed 走 runbook，不升级为人工日常合并。
- push rejection → 有界 `fetch → join → exact-OID push` + jitter 重试。

### 2.5 已退役 / 已被推翻清单（勿当现役参考）

| 项 | 曾经 | 退役原因与出处 |
|---|---|---|
| gbrain / Postgres / pgvector | 记忆后端 | 基础设施重、索引绑死真相（overview 阶段 2） |
| 三模型投票 sediment | 写入裁决 | 5 根因实证失败（ADR 0010） |
| 机械防御 gate（body-shrink/section-loss 等） | curator 防护 | 静默拒绝制造死条目（ADR 0018→0016） |
| Lane B/D promote（project→world 晋升） | 0013 车道 | 七区下直接路由，无晋升概念（ADR 0014 D3） |
| `dispatch_hub` 动态编排 | 多 agent | 采用率≈0 + 两级有损转述（ADR 0030 retired 2026-07-22） |
| 嵌套 dispatch 委派 | 多 agent | 多层转述目标漂移，永久禁止（ADR 0042 retired 2026-07-24） |
| `prompt_user` timeout 合同 | 交互 | 沉默≠合成终态，改无限等待（ADR 0041 窄 supersede 0022） |
| rules 区写时 active 文件 + compiled-view / D3 注入 | 注入源 | 0040 no-migration cutover 后全部退役为冷审计（2026-07-20 full flip；近期提交 cfc206a/543f561/8c2b9d4 物理清除 runtime 残留） |
| 全库 full-body stage1 | 检索 | 单日 $8 成本事故（ADR 0035） |
| stage1 LLM 粗筛 | 检索 | 与 dense 排序冗余（ADR 0036 坍缩，保留为 verdict=none 安全网） |
| `/memory rebuild --index/--graph`、`/about-me` slash | 命令面 | 自然语言优先，slash 存活率≈0（ADR 0033 实证） |
| `memory_get` 工具名 | 工具面 | provider 对 `memory_search+memory_get` 组合收 extra usage 400，改名 `abrain_get`（2026-07-23） |
| REQ-009 之外的 grep/BM25 降级检索 | 检索 | accuracy-is-contract（ADR 0015/0039 §6） |

---

## 3. 存储基座（`_shared`）：L1/L2/L3 与 canonical git 运行时

### 3.1 L1 证据事件：物理格式（ADR 0039 §4.1/§4.2 + 实现核对）

- 路径：`l1/events/sha256/ab/cd/<hex64>.json`（按 hash 两级分片）；一事件一文件、immutable、永不二次编辑。**首期明确禁止跨设备共享 append 的 NDJSON/分段日志**——内容寻址一事件一文件让跨设备新增天然是不相交文件集合，git merge 零冲突；同路径不同内容 = 硬错误（不是语义冲突）。
- 编码：UTF-8、LF、RFC8785/JCS canonical JSON。文件 = **hash 信封 + body**：信封记 `schema / canonicalization / hash_alg / event_id / body_hash`（信封不参与 hash；reconcile/push 前校验信封、文件名、body hash 三者一致）；`event_id = body_hash = sha256(JCS(body))`。
- body 最小字段集：`event_schema_version / event_type / created_at_utc / device_id / device_event_seq|producer_nonce / actor / causal_parents[] / session_id / turn_id / source / intent|operation / payload / sanitizer / producer`。`created_at_utc` 进 hash 但只用于审计与同层排序，**不作为唯一因果依据**（因果靠 `causal_parents`）；`device_event_seq` 防同设备同时刻语义相同事件被内容寻址误合并。
- LLM 产物入 L1 时 body 必须记 `model / prompt_hash / input_hash / output_hash / sanitizer / acceptance`。
- `jcs.ts`（3.2KB，零依赖）是所有内容寻址的地基：递归 key 排序、拒绝 `undefined`/非有限数/非 plain object/孤立代理项、`-0→0`。**移植时原样拷，不要自写 canonical JSON。**
- 写入原语 `durable-write.ts::durableAtomicCreateFile` 三态返回：`created | identical | collision`——同内容=幂等成功、异内容=硬冲突。这是内容寻址写入的正确形状（shadow chain 的 slot 抢占、intake 去重都靠它）。

### 3.2 L2 确定性投影：contract + reconciler（可移植性最高的算法层）

**版本坐标（`canonical-l2-contract.ts`，55 行）**：冻结常量对象记录 `reconcilerVersion / projection / projector / projectorVersion / templateVersion / entrySchemaVersion / manifestSchemaVersion / canonicalRoot`（如 `l2/views/knowledge/latest`）。纪律：**live 指针（`CURRENT_KNOWLEDGE_L2`）可以前移到 v2，但 v1 reconciler 必须永久保留**——历史 commit 里的 L2 字节自带 v1 版本签名，重验历史必须能用 v1 规则重投影。`assertCanonicalL2ReconcilerCoverage` 把这条纪律代码化：指针前移而没写新 reconciler，任何 join/历史分类立即抛错。

**确定性 fold 算法（`canonical-l2-reconciler.ts`，364 行——ADR §4.3 的唯一完整参考实现，直接可抄）**：

1. 按 `knowledgeIdentityKeyV1`（`world::<slug>` 或 `project:<id>:<slug>`）分组。
2. `topoSortKnowledgeEventsV1`：按 `causal_parents` Kahn 拓扑排序；同层 tie-break key = `created_at_utc \0 device_id \0 seq.padStart(20,"0") \0 eventId`，用**纯 code-unit 比较**（全仓库零 `localeCompare` 参与字节生成——locale 是确定性的天敌）。
3. winner = 排序最后一个；`created` 取最早事件、`updated` 取 winner（**从不 `Date.now()`**）。winner 的 `operation_hint === "delete"` → 不产文件（墓碑生效）。
4. `inputEventSetHash`：单事件=eventId；多事件=`sha256(JCS(sortedIds))`。
5. **self-hash 两遍渲染**：先用空串渲染取 `sha256(withoutHash)`，再塞回 `sediment_output_hash` 渲染第二遍。
6. frontmatter key 顺序硬编码；裸 `---` 行改 ` ---` 防误判分隔符。

**"L2 冲突 = 丢弃重投影"的真实实现**：reconciler 不做冲突检测，它只产"期望字节"。跨设备 join（`device-join-coordinator.ts`）在分叉时**压根不 diff 两侧 L2**——无条件丢弃两侧全部注册 L2 路径，从 L1 union 全量重建（候选树里两侧原 L2 一个都不进）；L1 要求两侧 add-only（改动/删除/mode 变化 typed fail-closed）。线性推进则是**校验**：候选 commit 的 L2 必须已等于重投影结果。历史审计（`recovery-history-classifier`）逐 commit 重投影比对 blob OID，不符报 `RECOVERY_L2_PROJECTION_DRIFT`。

### 3.3 canonical git 运行时：git 是审计链，不是真相源

- **exact cohort commit**（`git-exact-cohort.ts`，一次落盘事务的核心链）：`mkdtemp` 临时 `GIT_INDEX_FILE`（共享 index 全程不碰）→ `read-tree frozen` → 逐条 `hash-object -w` + `update-index` → `write-tree` → **`diff-tree` 逐路径/逐 blob OID/逐 mode 精确比对 plan（多一条少一条都 fail）** → `commit-tree` → `update-ref` **CAS** 发布（`cas_conflict` 时 ref 与工作树完全不动）→ 只收敛 cohort 路径的共享 index 条目（非 cohort 条目指纹前后必须逐字节不变）。**没有 `reset --hard`、没有 force checkout、工作树永远不碰。**
- **确定性 commit 身份**：author=committer=`pi-astack-local-drain <local-drain@pi-astack.invalid>`；date=**父 commit 的时间戳**（不是当前时间）→ 同输入 bit-identical commit OID。message 确定性生成（`protocol + manifest sha256`），调用方传的 message 故意排除在 commit 字节外（仅诊断用）。
- **锁的三层结构**：①进程内 `gitSingleFlight`（promise 尾链，per-repo key；`fn` 同时作 onFulfilled/onRejected 防前序失败阻塞后续，尾巴存吞异常副本防链毒化；状态挂 `globalThis[Symbol.for(...)]`——因为 pi 用 jiti `moduleCache:false`，模块级 Map 会让各 extension 各持一把假锁）；②跨进程 `retained-directory-ofd-lock`（对 abrain 目录本身 OFD flock）；③ALS 租约做重入检测（已持锁直通，防自死锁）。顺序固定：先 singleflight 后 OFD。
- **⚠️ 移植地雷**：OFD 锁 **Linux-only**（经 `/proc/self/fd` 执行 pinned `/usr/bin/flock`；macOS 直接抛 `OFD_LOCK_UNSUPPORTED`）。实测 `~/.abrain` 的 18 个 drain commit 全是 v2 协议零 v3——当前代码的 canonical 路径在 macOS 上从未跑通。**agentbrain 必须换锁**（`O_EXCL` 锁文件 + pid 探活 + stale 检测；注意抄 pi 细节：pid 存在但已死立即抢锁，不等 staleMs）。Node 核心没有 flock 绑定——这是 pi 被迫写 C 插件的根因，记入"已知不可得能力"。
- **mutation 前置检查**（值得整体移植的 ~250 行思想）：HEAD 必须 attached 且精确等于配置 ref；存在 `MERGE_HEAD/rebase-apply/...` → 拒绝；unmerged index → 拒绝；发现 `.git/index.lock` → 停下**且永不删除它**；路径黑名单（`.git/.state` 禁入 cohort；**L1 delete 永久禁止**）；`pruneNoops`（字节与 HEAD 相同就不进 cohort）。
- **git 环境隔离**：剔除所有 `GIT_*` 环境变量 + `LANG=C LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`，只读命令加 `GIT_OPTIONAL_LOCKS=0`——一步消掉"用户 git 配置污染确定性"整类 bug。
- **push/pull 完全分离在 `abrain/git-sync.ts`**（ADR 0020）：`git push <remote> <oid>:<ref>` 推确切 OID 不推分支名；push 被拒 → fetch + deterministic join → 重试；写入侧用 `withoutCanonicalMutationBarrierContext(() => void pushAsync(...))` 把 push 甩出锁上下文 detached 执行。
- **git-z-parser.ts（91 行，零依赖）**：NUL 分隔输出安全解析——fatal UTF-8、**NFC 归一强制**（macOS NFD 陷阱）、拒绝 `..`/绝对路径/盘符/反斜杠、porcelain v1 `-z` rename 双记录（目标在前源在后）。**原样拷。**

### 3.4 Proposition 家族：ADR 0040 的实现形态（`proposition*.ts`，约 30 文件）

**核心类型（`proposition.ts`）**——命题证据的字段级 schema：

- 三个信封 schema：`proposition-evidence-envelope/v1`、`proposition-lifecycle-envelope/v1`、`proposition-genesis-envelope/v1`（body schema 各对应 `*-event/v1`）。
- `PropositionModality = descriptive | normative | meta-lifecycle`；生命周期操作 = `retract | rescope | supersede | archive | reactivate | cutover`（比 ADR 多一个 `cutover`——no-migration 切换本身也是事件）。
- **10 个正交 facet 的具体字段**（每个都带 `unknown` 逃生值，不强迫编造）：
  - `provenance_authority`: `source_kind(user|assistant|tool|file|system|projector|operator|unknown)` + `authority_kind(user_attested|operator_attested|observed|inferred|derived|unknown)` + `source_event_id` + `quote_sha256`
  - `spatial_scope`: `scope_level(global|project|domain|session|task|unknown)` + `project_id` + `domain`
  - `temporal_horizon`: `horizon(durable|bounded|session|task|unknown)` + `valid_from/until`
  - `trigger`: `trigger_kind(user_directive|observation|correction|manual|system_event|unknown)` + `trigger_ref`
  - `maturity`: `state(draft|candidate|accepted|deprecated|unknown)` + `review_state`
  - `contestability`: `status(uncontested|contested|requires_review|unknown)` + `counterevidence_event_ids[]`
  - 另有 `confidence / sensitivity / consumer_hints / lineage`。
- **genesis epoch binding**：生产 genesis event id 是硬编码常量（`3975b8c7…`）——no-migration cutover 的"新纪元起点"物理锚点；每条 proposition 携带 `{epoch_id, genesis_event_id}` 绑定。
- 管线阶段（文件名前缀即阶段名）：`p1a-dossier`（证据档案）→ `p1b-production`（preview/execute 两段式生产）→ `policy-push`（shadow preview → shadow publication → live publication，每段都有 preview/plan/execute 分离）→ `policy-stable-view`（contract/preview/publisher/recovery/root，产出 content-addressed bundle + `v1/latest` 指针）。**shadow→live 两段式的存在理由**：发布是高影响动作，先在影子路径产出完整字节并校验，再原子切换指针。
- `proposition-tier1-policy-writer.ts`：Tier-1 自然纠正的最小闭环写入端（2026-07-25 armed）——纠正 → constraint evidence → dynamic policy proposition → durable pending marker（仅 event id）→ 异步 force republish。
- 消费端 `abrain/rule-injector/proposition-policy-stable-view-reader.ts`：session_start 严格校验 bundle（hash/schema/provenance/预算）后注入；stale 注入+诊断；invalid/missing loud zero。runtime audit 落 `selected_valid / item_count / view hash` 证据行。

### 3.5 写入可靠性原语：哪些真的在用，哪些是"激进路线"的产物

精读后的关键发现（**校正直觉**）：真正经受住现实检验的 abrain 记忆基质写法极其朴素——

| 真实写者 | 写法 |
|---|---|
| `outcome-collector.ts` | `fs.appendFileSync(ledger, lines.join(""))` |
| `writer.ts::appendAudit` | `fs.appendFile(audit, JSON.stringify(row)+"\n")` |
| `entry-telemetry.ts` | `fs.writeFileSync(file, ..., {flag:"wx"})` |
| `evolution-ledger.ts` | 全文件重写 |

**无轮转、无 HMAC、无 OFD、无 native**；读侧一律有界尾读 + 逐行 try/catch + corrupt 计数 + 外层兜底空返回。这套已跑出 366 行 outcome-ledger / 6.8MB 证据索引。五个"重原语"属于 canonical-git/proposition/多设备这条激进路线，与 agentbrain v1 放弃项高度重合。逐个判词：

- `retained-directory-ofd-lock`（174 行）：Linux-only，上游已迁编译型 C 插件。v1 用 `sync-file-lock` 形态（O_EXCL + stale + pid 探活 + token 校验，best-effort）即覆盖需求。
- `keyed-detached-queue`（222 行）：**detach 是 `setImmediate` 不是子进程**——语义可参考（每 key 一 active 一 pending、新 pending 覆盖旧、dedupeKey 抑制），代码不可照抄：Claude Stop hook 进程毫秒级退出，进程内队列会丢每一个任务。**同 key 串行必须搬到文件级机制**（每 key 锁文件/marker），这是 M0 spike 应验证的点。
- `rotating-jsonl`（878 行）：大小 OR 年龄双触发轮转 + 5 阶段可崩溃恢复事务 + 自描述归档名。但**没有任何 reader 读归档，真实 abrain 账本压根不轮转**——v1 直接 `fs.appendFile` + 诊断返回值即可，账本过 ~10MB 再说。值得抄的只有 fail-open 纪律：**轮转失败也照样把这一行写进 active**（宁可文件超长，不丢数据）。
- `audit-hmac`（304 行）：**不是哈希链**（无 prev_digest/序号，检测不了删除重排）——是字段级 MAC（隐私保护的等值令牌，用于不存原文时的去重关联）+ 流式滚动 MAC（对字节序列做承诺）。密钥与数据同目录，威胁模型（同机异 uid 篡改）对本地记忆系统不成立。**v1 的防篡改靠 git commit 链，不靠 HMAC**；值得留的只有 `frame()` 长度前缀 + 域分离约定（8 行，防 `update("a","bc")==update("ab","c")` 碰撞）。
- `llm-audit`（1151 行）：审计 pi 自己的 LLM I/O，agentbrain 无对应物（Claude 自己调模型）。**必须原样搬走的是 60 行脱敏纪律**：`FORBIDDEN_AUDIT_KEYS` 集合 + key 归一化（camelCase→snake 再匹配，防 `rawResponseText` 绕过）+ token 级判定（含 prompt/signature/credential/base64 的键一律丢）+ **"存形状不存内容"**（`{chars,bytes}` 代替字符串本体）+ 错误文本五组 API-key 正则清洗 + `ensureProjectGitignoredOnce`（首写状态目录前确保已 gitignore——忘了就等于 `git push` 外泄）。

### 3.6 L3 与 DB 假设：结论是"语义上零依赖"

- 唯一 SQLite：`l1-validated-scan-cache.ts`（`node:sqlite`，`.state/canonical/l1-validated-scan-cache/v2/cache.sqlite`）。文件头自白："Non-authoritative, rebuildable. **Never recovery / semantic / leader authority.**" 只有 canonical startup 用（避免每次重解析上万 L1 JSON），drain 路径不用；Node 没编 sqlite 直接降级不用缓存。
- `ready.json`（fail-closed 最后就绪指纹）是 JSON 不是 DB：head + statusHash + inventoryFingerprint + implementationFingerprint 等六项全等才跳过冷启动。
- 所有真相判定（fold/投影/所有权/恢复分类）直接读 L1 JSON 文件。**agentbrain v1 无 DB 完全可行**；memory_search 生产运行时甚至还在用 JSON sidecar embedding 索引（`.state/memory/embeddings.json`），ADR 0039 的 L3 SQLite 是目标边界的 partial 实例。
- 有趣细节：provenance 冻结——canonical runtime 启动时对 31 个自身源文件算 hash，每次 mutation 前重算，**跑一半你改了代码，写入立即停**（`PROVENANCE_DRIFT`）。

### 3.7 _shared 移植取舍总表

| 文件 | 判词 | 一句话理由 |
|---|---|---|
| `jcs.ts` | **核心必移植，原样拷** | 所有内容寻址的地基 |
| `git-z-parser.ts` | **核心必移植，原样拷** | NFC/fatal-UTF8/rename 双记录，细节别处想不对 |
| `canonical-l2-contract.ts` | **核心必移植**（改常量） | 版本坐标纪律成本≈0，第一天就该建 |
| `canonical-l2-reconciler.ts` | **核心必移植**（砍 constraint 域 ~90 行） | 确定性投影唯一完整参考实现 |
| `git-exact-cohort.ts` | **核心必移植**（543→~300 行） | git-as-审计链的技术底座 |
| `git-singleflight.ts` | **核心必移植**（178→~60 行） | 防并发 git 的最小正确实现 |
| `canonical-mutation-barrier.ts` | **保留骨架，锁实现整换**（→~120 行） | 结构对（hook 并发场景需要），OFD 锁 macOS 不可用 |
| `durable-write.ts` | **核心必移植**（三态原语） | 内容寻址写入的正确形状 |
| `git-tree-snapshot.ts` | 按需后移 | 历史重放校验时才需要，届时必需 |
| `canonical-git-runtime.ts`（3061 行） | **砍 ~85%**，只留 5 个概念 ~250 行 | recovery 状态机/启动状态机/TUI 桥全是 pi 特有 |
| `canonical-shadow-chain.ts`（1798 行） | 不移植；抽 2 个模式 | 一次性上线证明工具；"前后快照零 delta 验收"很适合 M0 |
| proposition 家族（~30 文件） | 思想采纳，实现不搬 | agentbrain v1 无独立 policy push 面；facet schema 留作 L1 payload 设计参考 |
| `rotating-jsonl / audit-hmac / llm-audit / keyed-detached-queue / retained-directory-ofd-lock` | 可砍；各抽一条纪律 | 见 §3.5 逐条判词 |

---

## 4. abrain 扩展（壳）：布局、绑定、注入、同步、vault

### 4.1 模块地图（22 个 ts 文件，10,323 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.ts` | 3421 | 扩展入口：注册 `/abrain` `/secret` `/vault` 三个 slash 命令 + `vault_release` 等 tool；session_start 布局自举 + 规则注入接线；canonicalAutoCommit 路径 |
| `brain-layout.ts` | 487 | 八区目录自举（幂等，0o700）；`.state/` gitignore 维护；遗留 pre-push hook 清理 |
| `bind-intent.ts` | 630 | 绑定意图 outbox（见 4.3） |
| `backend-detect.ts` | 384 | vault 后端探测链（ADR 0019 四 Tier） |
| `git-sync.ts` | 434 | exact-OID push + fetch→join→retry（ADR 0020） |
| `rule-injector/index.ts` | 741 | session_start 注入（现役=policy stable-view 唯一源） |
| `rule-injector/proposition-policy-stable-view-reader.ts` | 800 | bundle 严格校验读取器 |
| `rule-injector/…runtime-audit.ts` | — | 注入运行时审计行（selected_valid / item_count / view hash） |
| `vault-{authorize,bash,reader,writer}.ts` | ~2100 | vault 四件套（见 4.6） |
| `keychain.ts` | 306 | OS keychain 封装（Tier 2 优化层） |
| `redact.ts` | — | 凭证脱敏原语（`redactCredentials`/`redactSecretAnswer`，git-sync 与 prompt_user 共用；注释明确"为什么不放 _shared：跨扩展 API 需独立安全评审，只有一个仓外消费者时不晋升"——**rule-of-three 纪律的实例**） |
| `reconcile-gate.ts` | — | pre-push 前的 L1/L2 一致性门（重投影比对，超时 120s fail-closed；含 override 通道 + 审计） |
| `prompt-user/*` | ~7 文件 | `prompt_user` 工具（ADR 0022/0041）：结构化提问 UI、无限等待、secret 占位符 |
| `i18n.ts` | — | 文案 |

### 4.2 磁盘布局（`brain-layout.ts` 权威）

八区 + lane 归属（`BRAIN_ZONES` 常量原文）：

```text
~/.abrain/
├── identity/     # Lane G（about-me 声明）
├── skills/       # Lane G
├── habits/       # Lane G
├── workflows/    # workflow lane（独立锁+审计+commit 路径）
├── projects/     # Lane C target（per-project memory；.pensieve 迁移目标）
├── knowledge/    # Lane A（跨项目 world 知识）
├── vault/        # Lane V（age 加密 secrets）
└── rules/        # ADR 0023-R5 读路径遗留（现仅 readonly 诊断邻居）
（另有 l1/ l2/ .state/ ——见 §3；.state/ 由布局代码强制维护进 .gitignore）
```

自举幂等（每次 boot 调用，只建缺失目录）；目录 mode 0o700。遗留 ADR0039 pre-push hook 的清理逻辑值得注意：按 marker + 逐字节比对历史模板才删（`preserved_non_exact` 状态保护用户自改的 hook）——**清理别人目录里的东西前先证明它确实是你写的**。

### 4.3 项目绑定（ADR 0017 三件套 + bind-intent outbox）

- 三件套（§2.4 已述）。bound 判定 = 三层全匹配；active project 是 boot-time snapshot。
- 实现上有第四个部件 **bind-intent outbox**（`bind-intent.ts`）：绑定动作先写 durable intent（`.state/…/bind-intent/{pending,done,failed}/<itemId>.json`，itemId 内容寻址、写入三态 created/identical/collision），再 apply——绑定本身也走"先证据后执行"的纪律，崩溃可恢复、重复幂等。
- `planAbrainBind`（纯计划）与 `applyAbrainBindIntent`（执行）分离；`assertAbrainBindIntentTrackedPaths` 校验 intent 只触碰声明过的路径。

### 4.4 rule-injector：现役注入面

- 头注释即现状："Production authority is the content-addressed **Policy stable-view only**. Legacy rules/ on disk remain a readonly diagnostic neighbor… Compiled-view, dual-read audit, and self-heal scheduling are **retired and unreachable**."
- 流程：session_start（仅 persisted main session；ephemeral/subagent 排除，经 `isSubAgentSession` 判定）→ 读 `.state/sediment/proposition-policy-stable-view/v1/latest` → 严格校验（hash/schema/provenance/路径越界/预算）→ 注入；stale=注入+可见诊断；invalid/missing=**loud zero**。每次注入落 runtime audit 行。
- 命名教训：注入预算轴叫 **inject-mode**（always/listed），特意从"tier"改名——避免与写路径的 GTier（Tier-1/2 provenance 谓词）撞名。**两个正交概念共用一个词是事故温床。**
- 对 agentbrain 的对照：agentbrain 的 `context` 硬层注入=这里的极简版（无 bundle 一致性校验，预算截断即可），但"stale 可见、invalid 响亮失败、不静默降级"三条语义值得保留。

### 4.5 git-sync（ADR 0020 实现）

- `exactPushOnce`：`git push <remote> <oid>:<mergeRef>`——**推确切 OID 不推分支名**（防 push 瞬间本地 ref 又动了）。
- push 被拒 → `fetchAndJoinUnlocked`（fetch + deterministic device join，§3.2）→ 重试，有界 + jitter。
- 触发：写入完成后 detached fire-and-forget（甩出 mutation barrier 上下文）；网络/认证失败只写 `.state` 审计 + warning，**永不阻断本地写入或启动**。
- 实测：单机未配 remote 时整条路径静默不参与。

### 4.6 vault 子系统（agentbrain 明确放弃项，只记边界）

- 存储：`vault/<key>.age`（全局）、`projects/<id>/vault/<key>.age`（项目，需 strict binding）；身份 `.vault-identity/master.age`（0600、gitignored）+ `master.age.pub`（进 git）。
- 后端探测链（ADR 0019）：env override → Tier1 `abrain-age-key`（自管 age keypair）→ Tier2 keychain（macos/secret-service/pass，包装 Tier1）→ Tier3 explicit-only legacy（ssh-key/gpg-file/passphrase-only，带 stderr 警告）→ Tier4 `disabled`（响亮拒绝+安装提示）。
- 读边界：`vault_release(key)` 工具弹窗授权后明文才进 LLM 上下文；bash 注入 `$VAULT_<key>`（项目优先）/`$PVAULT_`/`$GVAULT_` 供子进程用 secret 而不进上下文；注入运行的输出默认扣留，放行前对 text part 做字面脱敏。**依赖 pi 独有的 tool_call/tool_result 拦截——这正是 agentbrain 放弃 vault 的原因。**
- vault 写完**不自动 commit**（用户手动 git commit）；vault 命令不加入 canonical startup barrier（独立执行域）。
- sub-pi 隔离：dispatch 子代理带 `PI_ABRAIN_DISABLED=1`，abrain/vault 工具不注册。

### 4.7 prompt-user 子系统（借鉴价值：交互原语的形状）

- `prompt_user`（决策暂停）与 `vault_release`（凭证释放）是**独立工具、独立审计 lane、共享 PromptDialog UI**——工具名本身承载语义。
- 1-4 问/次；`type:secret` 答案只回 `[REDACTED_SECRET:<id>]` 占位（raw 永不进 LLM/audit，只记 lengthBucket）；并发硬门 1。
- ADR 0041 拍板：**无 deadline**——沉默=还在等，不合成 timeout 终态（超时会让 agent 拿着假答案继续跑）。终止事件仅：用户提交/拒绝/Esc、turn abort、session shutdown。

### 4.8 pi 耦合度

- 强耦合（不可移植）：vault 全套（tool 拦截）、prompt-user UI（pi 对话框）、footer 状态、`ExtensionAPI` 注册面、`isSubAgentSession` 等 pi-internals。
- 可移植逻辑：brain-layout 自举模式、bind-intent outbox、backend-detect 探测链形状、redact 原语、reconcile-gate 的"push 前重投影比对"思想、git-sync 的 exact-OID push。

---

## 5. sediment 写路径：从 agent_end 到落盘的完整流水线

> 本章对应 agentbrain M3。现役合法写入通道只有：①自然对话经 `agent_end` 背景抽取（唯一正常产品路径）；②显式 `MEMORY:`/`MEMORY-ABOUT-ME:` fence（兼容/诊断通道，非产品路径）；③worker RPC（daemon 场景）；④维护 slash 命令；⑤vault Lane V（不走 sediment）。

### 5.1 端到端流水线（阶段契约，顺序语义）

```text
agent_end
  → durable intake（同步、毫秒级，唯一 awaited 步骤）
  → agent-end-queue（按 key 合并调度）
  → checkpoint/run-window（读 transcript 走出当前分支）
  → explicit fence extractor（fence-aware）
  → sanitizer（任何 LLM/audit/write 边界前的 typed redaction）
  → LLM extractor（无显式 fence 且 autoLlmWriteEnabled 时）
  → memory_search lookup（query 先脱敏；找邻居）
  → curator 裁决 / event writer / projector
  → writer validate/lint/lock/atomic write（仅 legacy markdown 域）
  → audit → best-effort git commit
```

**逐段细节：**

**① durable intake（`intake.ts`，schema `sediment-intake/v2`）**——`agent_end` 路径本身不做任何 canonical mutation（p99<100ms capture 合同）。create-only + fsync 写 `~/.abrain/.state/sediment/intake/pending/<windowId>.json`。记录内容是**不可变坐标而非转录副本**：pi session 文件路径 + branch tip、canonical `sourceProjectRoot`（bind/git root，**永不用启动子目录**）、capture 诊断、digests。`windowId = sha256(稳定源坐标)`（**无墙钟**——同窗口重试天然幂等）。恢复时用 pi 的 JSONL parser 沿 `parentId` 重建**精确的冻结分支**。capture 写失败 = 审计 + 通知，**不入队**（宁可显式丢失也不假装成功）。目录组：`pending/ acked/ status/ claims/`。

**② 队列（`agent-end-queue.ts`）**——只是调度优化，durable intake 才是恢复权威。语义：per-key 最新合并（同 session 多轮只留最新）、同 key 串行、跨 key 并发上限、`more` 续跑、错误隔离。`session_start` 恢复 pending 时**只认当前 boot 物理项目根**（严格路径相等，不做全局 projectId 扫描）——同 project_id 的两个 checkout（如 `pi-router` 与 `pi-router2`）严格隔离，本实例不得 LLM 评估外根的记录。

**③ checkpoint / run-window（`checkpoint.ts`）**——per-session checkpoint 记录已处理水位；`buildRunWindow` 从 transcript 构造本轮窗口；lineage key（`computeBranchLineageKey`）处理分支切换；`buildDurableCandidateKey` 保证同一候选跨重试幂等。**checkpoint 只在 terminal success 后推进**（ADR 0010 的教训）；近期三个 fix（4842e2c/93a333f/efb5a06）都在堵"checkpoint 提前推进"的逃逸路径：deferred candidate 后不得推进、重试逃逸关闭、post-pass checkpoint 不可读时 fail-closed（`checkpoint_state_unknown_after_pass`）。

**④ extractor 两条线**——显式 fence（`extractor.ts::parseExplicitMemoryBlocks`，确定性解析）；LLM 提取（`llm-extractor.ts`）：`buildBranchTranscript` 规范化分支 → bounded window（`maxWindowChars`，prompt 固定开销预留 80k 字符）→ 结构化 draft 输出。DI 接缝就在这里：`ModelRegistryLike` 窄接口（agentbrain 的 `LlmInvoker` 即借此形状）。

**⑤ sanitizer（`sanitizer.ts`）**——确定性 secret/credential 正则集，typed redaction：命中不阻断整轮，raw 替换为 `[SECRET:<type>]` 继续提取。边界语义（sediment.md §8 原文）："raw secret 不进入第三方 LLM、audit JSONL 或 memory markdown；保留语义价值的上下文与占位符"。prompt 同时要求 LLM 不得复制 raw secret、不得还原占位符原值。

**⑥ curator（`curator.ts`）**——决策类型 7 种：`create/update/merge/archive/supersede/delete/skip`。先 `memory_search` 找邻居（neighbor lane：project/world/workflow/rules 四路）；`relevantEntriesForCurator` 过滤；`applyTaskLocalBeltFilter`（task-local 上下文腰带过滤——防任务态噪声进 durable）；`buildCuratorPrompt` 组装；`parseDecision` 解析（markdown 终止符格式，**不是强制 JSON**——ADR 0010 教训：forced JSON breaks LLM output robustness）。ADR 0016 后**没有** readiness/rate/sampling/G2-G13 机械门。

**⑦ writer（`writer.ts`，6450 行）**——落盘路由中枢。当前生产拓扑（B5 cutover 后）：**不再写 `<project>/.pensieve/`**；Knowledge/Constraint 走 **event_first**（append L1 成功后跳过 legacy markdown 直写，读侧 `projection_only`）；project entry / workflow 仍可落 markdown 区（保留为 rollback/debug surface）。核心导出面：`writeProjectEntry / updateProjectEntry / mergeProjectEntries / archiveProjectEntry / supersedeProjectEntry / deleteProjectEntry`（soft/hard 两种 delete，curator 只能 soft）+ `writeAbrainWorkflow / writeAbrainRule / writeAbrainAboutMe`。审计两处：项目侧 `<projectRoot>/.pi-astack/sediment/audit.jsonl`，abrain 侧 `~/.abrain/.state/sediment/audit.jsonl`。

**⑧ event-first 接受路径（sediment.md §2.1，2026-07-23 生产验收）**——最精密的一段，核心不变量：
- 顺序固定 **outbox → L1**：一个 canonical mutation barrier 内，先 durable 入队 create-only publication item（只含 eventId + 路由元数据，**不复制 event body**），再以 event-id 幂等 append 精确 L1。outbox 失败则 L1 零写；L1 失败则 pending 保留重试。两者都 durable 后才返回 `durable_pending`。
- 准入等锁上限 1s（worker 预算只能收紧）；争用返回 `canonical_busy` 关闭拒绝，零写、不推进 checkpoint。
- `created_at_utc` 必须来自**真实不可变源时间戳**（window tip / entry frontmatter / staging created / multiview capture / 遗忘授权链），缺失 = 终态 `source_timestamp_unavailable`，**无墙钟 fallback**。
- **frozen-batch publisher**：单次非阻塞 OFD 内冻结 ≤64 个 ready 项（merge 原子组永不拆分；超 64 的原子组单独整批）；HEAD 经 `ls-tree`+`cat-file --batch` 读取（冻结后的 worktree/outbox 尾巴进不了 fold）；纯确定性 plan 渲染受影响 L2 + manifest；exact-cohort 单事务提交；busy/CAS/瞬态 HEAD 异常 = 整批 pending 重试，只有内容/schema/身份类确定性终态才移 `failed/`。
- crash-replay 顺序：`outbox+L1 → checkpoint → intake ack → L2/Git`。

**⑨ git commit**——best-effort 审计链：失败不回滚已写数据，尽力清理 index 防 ghost changes；push 与 outbox ack 解耦。

### 5.2 staging 生命周期（低置信候选区）

- 来源：active-correction classifier 产出"已判 durable 但无法归因到现有条目"的 provisional 假设（`correction-pipeline.ts::buildProvisionalStagingEntry`），或 curator 低置信候选。
- **staging-resolver**（prompt 原文要点）："你的工作是 **TRIAGE 不是删除**"——`plausible`（默认，疑义时必选）/ `likely_noise`（仅在明确确信是 classifier 过度解读时；**不删除**，只降优先级，仍正常 age-out）+ `promote_candidate` 旗标（清晰 durable 且强归因时，交给独立的 multi-view 验证路径升级）。
- **staging-promotion**：promote_candidate → multi-view 验证 → 正式条目。
- **staging-ageout**：~30 天未解决的条目由 age-out reviewer 处理（时间兜底与 triage 分离）。
- ADR 0043 后所有 staging 项进统一生命周期 read model（有界 pending + deadline + 可逆终态 `abandoned/` 全文保留）。

### 5.3 multi-view 交叉验证（高影响操作的双盲评审）

- 触发（`shouldTriggerMultiView`）：高影响 op——create conf≥8、archive、supersede、merge、hard delete、跨 scope。
- **pass1 盲评**：独立 reviewer **看不到 proposer 的决定**（防锚定）；要求跨模型家族（`MultiViewReviewerDiversity = cross-vendor | same-vendor-cross-model | same-model` 递降）；prompt 内置四个偏差警告：helpfulness bias（skip 是成功不是懒惰）、pattern-match override（同话题≠update，只有精化同一 claim 才 update）、correction over-weight（classifier 可能错，读它的 `most_likely_error` 字段）、scope confusion。
- **pass2 揭示**：看到 proposer 决定后，**唯一合法的改判理由是"proposer 指出了你 pass1 漏掉的具体证据引用"**——"他们的推理更全面/更自信/更常规"都是锚定偏差信号，命中即回退 pass1 结论。即使双方一致也不自动通过：要跑 devil's-advocate check（想象第三个不同 RLHF 训练的怀疑派会提什么最强反对）。
- 所有分类/验证 prompt 共享 **reasoning-normalization-preamble**：固定五段推理结构 `QUOTE（逐字引用，引不出来本身就是不自信信号）→ CLAIM → ALTERNATIVE（用引文构造最强反方）→ UNCERTAINTY（什么观察会翻转结论）→ RESOLVING EVIDENCE`——归一化不同基模型的推理表面，让 pass2 能比实质而不是比文风。
- 失败语义：multi-view replay **永不静默回退到 proposer 意见**（`multi-view-replay-never-silent-fallback-to-proposer`）。

### 5.4 主动纠错管线（correction-pipeline）

- classifier v3 识别三类信号：①更新大脑认知的自然语句；②对既有记忆的显式 curate 指令（合并/supersede/归档）；③建立未来/默认/跨项目行为的 USER 直接指令（**即使不纠正任何既有记忆**）。
- 正例词表（v3 原文）："以后用 X"、"我换了，现在用 pnpm"（无"以后"标记也算）、"忘掉那条"、"你怎么记成 Y 了"、"这个项目用 X，但平时用 Y"（scoped durable）。
- v1→v3 的关键演进：加入 **SEMANTIC PRIORITY**——"active correction is rare" 的基率先验**不得压过用户直接的 durable 指令**；保守零假设只适用于真歧义。默认规则链：durable vs task-local 拿不准 → task-local；task-local 纠错 vs 普通任务指令拿不准 → no signal；debug 抱怨 vs durable 偏好拿不准 → no signal；**但 USER 亲口说未来/默认/全项目行为 → 必须 signal_found=true**。
- 路由：`isTier1Directive` → Tier-1 确定性 append（排除 skip/stage）；`shouldEscalateToCurator` → curator 裁决；无法归因 → provisional staging。

### 5.5 worker RPC 与 LSEA（ADR 0045，daemon 场景）

- worker 模式（`PI_ASTACK_SEDIMENT_WORKER_MODE=1`）只注册 3 命令：`/sediment-worker-capabilities`（零副作用探针，声明 `local_executor_authority_process_lifetime_v1`）、`/sediment-worker-run`、`/sediment-worker-maintenance`。无生命周期 hook/队列/恢复/定时器。
- 安全 env：`SEDIMENT_WORKER_COPY_STORE_ROOT`（sidecar 库，路径形状 `<root>/records/<id>/sidecar.bin`，`O_NOFOLLOW` + fstat）+ `ALLOWED_OWNER_ROOTS`（realpath 白名单）。manifest ≤64KiB 严格未知字段拒绝；sidecar ≤8MiB。
- 预算：默认 600s（60s..3600s 闭区间），5s 收尾预留 + AbortController 自返回（不靠 daemon kill）；进度通知闭集 stage + 分桶计数（**无自由文本、无 ID/路径**——通知面防泄漏）。
- 幂等收据：真实 checkpoint 推进 + backlog 排空（`more=false`，预算 16 轮）后才写 processed receipt；确定性跳过（`project_not_bound/settings_disabled/empty_window/ephemeral_session`）无推进 = `retryable=false`；毒化码闭集（如 `deadline_after_checkpoint_advanced`＝推进了却没写收据）→ daemon 必须 kill-and-wait 再重试。
- LSEA 准入（`local-executor-authority.ts`）：authority store `<ABRAIN>/.state/sediment/local-executor-authority/{authority.lock, authority.json}`（严格平面 string 对象、0600、≤64KiB、拒 symlink）；worker 单点准入 = 读记录 → 观察物理锁 → 重读记录，**两次读字节相同且文件身份相同**（防原子替换的 ABA）+ mode=held + holder=daemon + epoch/nonce 匹配。三个失败码全部"全局暂停"语义。**前台分类**：store 存在（无论 held/free/corrupt）→ capture-only；只有干净 ENOENT → legacy 全功能。

### 5.6 成本与门槛

- `per-turn-cost.ts`：扫描 per-turn 成本行，直方图分桶——喂给 aggregator 的 watchdog 信号。
- 廉价门槛在队列/checkpoint 层：空窗口、ephemeral session、未绑定项目直接跳过，不拉 LLM。
- 多模型 settings（`settings.ts`）：extractor/classifier/curator/aggregator/stagingPromotion/multiView.synthesis 各自配模型；**代码零硬编码 model id**；`autoLlmWriteEnabled` 三态（true/"true" 有效；`staging-only`/false/缺失/malformed 均关闭）是全局写权威急停。

### 5.7 sediment prompts 全集（11 个文件，2128 行）

| prompt | 角色 | 一句话核心 |
|---|---|---|
| `reasoning-normalization-preamble-v1` | 所有分类/验证前缀 | 五段固定推理结构（quote→claim→alternative→uncertainty→evidence） |
| `active-correction-classifier-v3`（v1 留档） | 纠错识别 | 三类信号；基率先验不压直接指令；默认规则链 |
| `aggregator-skeptical-historian-v1`（668 行，最大） | 跨会话趋势观察 | "零 advisory 是成功运行"+ **REVERSE-ANCHOR 双向警告**（RLHF 既可能谄媚多报也可能谄媚少报；压掉真信号前必须点名你选择折价的证据）；产物只进内部 ledger，**禁止产出要用户 review 的文本**（INV-INVISIBILITY 的 prompt 级执行） |
| `multi-view-pass1-blind-v1` / `pass2-reveal-v1` | 双盲评审 | 见 5.3 |
| `staging-resolver-v1` | staging triage | plausible 默认；likely_noise 只降权不删除 |
| `staging-ageout-reviewer-v1` | 30 天兜底 | 时间兜底与 triage 分离 |
| `archive-reactivation-reviewer-v1` | 复活评审 | 归档条目被自然对话再次触及时的复活裁决 |
| `aggregator-decay-shadow-v1` | 衰减影子评估 | ADR 0031 Phase 1B 的 would_demote 评估附录 |

**移植提示**：prompt 里最值钱的不是格式而是**校准语句**——"empty output is the modal correct output"、"skip is a SUCCESSFUL run"、双向 RLHF 警告、"唯一合法改判理由"。这些是多轮实证调出来的防偏差装置，agentbrain 的单一提炼 prompt 应继承这类语句而不是重新发明。

---

## 6. sediment 治理与生命周期子系统

### 6.1 条目生命周期状态机（合并 ADR 0031/0043 与实现）

```text
                    ┌──────────────── reactivate（archive-reactivation reviewer）─────────────┐
                    ▼                                                                          │
draft/candidate → active ──(curator supersede)──→ superseded ──(E2: 无有效 successor)──→ deferred_until_new_evidence
   │                │                                   │                                      │
   │                │ (curator/遗忘 executor archive)    │ (E1: frontmatter_superseded          │ 三种自治迁移：
   │                ▼                                   │  + execution_ready, 有界重试≤3)      │ ①发现 successor edge → E1
   │             archived（全文留盘，sparse 可达，        └──→ 遗忘 executor real apply ──→ archived  ②不再 superseded → terminal
   │              运行时复活面 = 不可调结构下限）                                               ③独立归因证据 → 重开
   └─(staging)→ provisional → staging triage(plausible/likely_noise) → promotion/age-out → abandoned/（全文保留，可逆）
```

- **终态永远可逆**：自治终态仅全文 `archived`；staging 终态原子 move 到 `abandoned/` 保留完整 candidate+provenance；**禁止 unlink、禁止 digest-only tombstone**（ADR 0043 §4 原文列举的三种非法 cleanup）。
- **遗忘触发是证据驱动不是使用率驱动**：自动 archive 硬门 = `op=archive` 且 `demote_evidence_type ∈ {superseded_by, contradicted, version_stale}`；disuse/usage-only **永不单独触发**。kind 分层：fact/smell 接受弱信号（version_stale）；anti-pattern/maxim/preference/decision/pattern 是长尾桶需强 supersede 信号 + 自治 reviewer lane。
- **executor 防伪**：入口从磁盘重读 kind（`kind_mismatch` → review_required 入 ledger）；前后 hash 校验源/durable/demote/reactivation 不变。
- **熔断器**（不是 canary）：5/batch、20/day、CAS、corpus floor、resurrection backoff。
- **复活通道独立**：archive-reactivation 由 `autoLlmWriteEnabled` 管理，**不受遗忘开关连带关闭**——否则削弱可逆自治的运行时复活面（ADR 0031 walk-back 明文）。
- **resurrection-rate-monitor**：复活率是遗忘过激的报警输入；**低复活率不能证明安全**（只能作正向报警输入之一）。
- **kind-distribution-monitor**：archived vs active 的 kind 分布比对——某 kind 被系统性错杀的走偏信号（direction §4 走偏 #9）。

### 6.2 outcome 回流（写-only 环的闭合，ADR 0028）

- `outcome-collector.ts`：收集"注入/检索出去的条目实际有没有用"——`recordPathAInjectedOutcomes`（path-A 注入的条目在本轮的使用结果）、`collectOutcomes`、`writeOutcomeLedger`（append-only jsonl）、`RuleOutcomeEdgeRow`（规则→结果边）。
- `outcome-evidence.ts`：outcome 固化为 L1 证据。DroppedFootnote 语义：**宁可显式丢失也不猜测**（`outcome-footnote-loss-prefer-loss-over-guess`）。
- 消费方：aggregator（趋势观察）、遗忘系统（矛盾降权）、entry-telemetry。**自回声先减**：条目被注入后 agent 复述它不算独立证据（echo-chamber 断路器思想同源）。

### 6.3 aggregator（跨会话趋势观察）

- 调度：drain-loop 上防抖定时（`runAndWriteSedimentAggregatorIfDue`）。
- 输入（`AggregatorSummary`）：audit、outcome ledger、staging、search metrics、classifier health、per-turn cost、结构上下文（`STRUCTURAL_CONTEXT` 硬编码的系统自描述）、前 N 次 aggregator 运行、L1 演化假设。P15 watchdog 信号扫描。
- 输出：`aggregator-ledger.jsonl` + `evolution-ledger.jsonl`（蒸馏的自我状态，供下次 aggregator 读——**大脑的内部时间线记忆**）+ lifecycle proposals + prompt-revision proposals（提议改自己的 prompt，进 `prompt-revision-proposals.ts` 排队，人不在环但可观测）。
- 性格设定：skeptical historian（见 §5.7）。

### 6.4 constraint 子系统：现存 vs 已退役（2026-07-27 清理后）

**现存（离线/手动基质 + 证据层）：**
- `constraint-evidence/`：Tier-1 纠正的证据层——`hash-envelope`（JCS 信封+hash）、`append`（三态幂等写）、`read`、`audit-replay`（重放校验）、`integration`（接入 writer）。**现役**：是 Tier-1 → policy proposition 闭环的第一段。
- `constraint-compiler/`：event-scan → llm-compiler → validate-decision → projection → render 管线 + `merged-source-verifier`（双重校验：LLM 编译结果再经独立 verifier 核对源覆盖）。**保留为 manual/offline substrate**（cfc206a 提交信息原文），auto-refresh 只在 canonical 路径挂 needs_refresh marker。
- `adr0039-l3.ts`：L3 SQLite 表边界实现（partial production 实例）。

**已退役（runtime 不可达，勿当现役写）：**
- D3 shadow 控制面：`proposition-lifecycle-freshness-shadow.ts` 1310 行 + 两个 smoke 共 2409 行删除（8c2b9d4）——确认无生产 v1 root 无 runtime 消费者后整体删除。
- compiled-view 注入 + dual-read audit + liveCanary + self-heal scheduler（cfc206a）；compiled runtime gate 残留（543f561）。
- 两处 compiled-view 物化（`l2/views/constraint/latest/` 与 `.state/sediment/constraint-shadow/latest/`）= 历史投影/离线冷审计残留，**无 runtime authority**。

### 6.5 中心-边缘部件（ADR 0044 的本仓切片）

| 部件 | 角色 | 状态 |
|---|---|---|
| `publication-outbox.ts` | Knowledge 接受路径的 durable 投递箱（pending/done/failed 目录 + metadata-only 计数 API） | **现役**（本地 publication 的核心） |
| `edge-protocol-shadow.ts` | capture-only 协议影子：per-session append-only journal（`producer_seq`=文件名扫描 max+1，崩溃后仅凭文件名恢复）+ content-addressed raw sidecar + TerminalWitness；pair admission key=`(session_id, terminal leaf id)` | 已实现，**默认关**；与 local intake 完全独立、互不阻塞 |
| `edge-shadow-frozen-contract-adapter.ts` | 冻结合同适配 | 随影子，默认关 |
| `tier1-held-decision.ts` | Tier-1 写入在 canonical 未 ready 时的 held 决策（`CANONICAL_STARTUP_BLOCKED` → 后续 settle） | 现役 |
| `local-executor-authority.ts` | LSEA worker-first 准入（见 §5.5） | 现役（最新功能） |

### 6.6 治理子系统移植取舍

| 子系统 | 判词 | 理由 |
|---|---|---|
| 生命周期可逆终态三原则（全文保留/禁 unlink/禁 digest tombstone） | **核心必移植**（纪律，非代码） | 成本≈0，防不可挽回错误 |
| staging + resolver triage | **必移植**（agentbrain 已规划 staging/） | 低置信候选防丢弃防误归的关键 |
| 证据驱动遗忘 + kind 分层 | 有价值可后移 | v1 corpus 小，遗忘不急；但"disuse 永不单独触发"应现在就写进设计 |
| outcome 回流 | 有价值可后移 | 需要注入/检索面先跑起来才有数据 |
| aggregator/evolution-ledger | 可后移 | 自我观察层，v1 无消费者 |
| multi-view 双盲 | v1 明确放弃（主设计 A.7） | 投入产出比；但 prompt 反锚定技术留档备用 |
| constraint-compiler | 不移植 | 已被 0040 policy 管线取代为离线基质 |
| edge-protocol-shadow / LSEA | 不移植 | 中心化路线，v1 无 daemon |
| publication-outbox 的 outbox→L1 顺序不变量 | **思想必移植** | agentbrain 的"queue → L1 → 投影"链同构；先 durable 意图后执行是崩溃安全的根 |

---

## 7. memory 读路径：检索栈与数据模型

> 31 个 ts + 3 个 prompt，~25.7k 行。一句话结论：**除检索/合成/改写三处 LLM 调用外，整个模块（解析、图谱、lint、doctor、迁移、rename 事务、provenance）全部是确定性纯逻辑，零 pi 依赖——移植的最大红利**。

### 7.1 检索栈现役形态

`stage0 混合召回（dense 向量 + BM25 稀疏 + freshness 保底）→ [stage1 已坍缩跳过] → stage2 LLM 全文精排`，上层由 5 个 profile 统一策略。

**profile 对照表（`search-profiles.ts`）：**

| profile | 调用方 | status | limit | 特殊 | 频率 |
|---|---|---|---|---|---|
| `toolSearch` | `memory_search` 工具 | LLM 定（默认排 archived+superseded） | 默认 10 | 唯一走精确直查快路径 | 高 |
| `decideSearch` | `memory_decide` | active | 8 | 后接合成 LLM | 中 |
| `pathAInject` | path-A 每轮注入 | active | 5 | 前置 query rewriter | **最高频** |
| `sedimentDedup` | sediment 去重 | **all** | 5 | `bestEffortOnNone:false` + `dedupChunk0Aggregation:true`（唯一专属 pin）+ archived 向量可见（tombstone 候选面） | 高 |
| `correctionSearch` | sediment 纠错 | active | 10 | — | 低 |

要点：profile 只声明检索策略，不吞调用方的前/后处理；limit 用 resolver 函数不用冻结常量；**profile 由调用方硬编码字符串选定**，降级链在内核层不在 profile 层。

**stage0 参数与排序（生产默认）**：`stage0PoolLimit=300`（dense topN；200 时中文 query coverage 在 94-95% 临界波动，离线 oracle 收敛到 300）、`stage0MaxCandidates=400`、`stage1Limit=50`（**坍缩后这是控 stage2 成本的主旋钮**）、`stage2Limit=10`、`staleFloorRatio=0.1`。`orderStage0Candidates` window-aware 五步（纯函数直接可搬）：

```text
windowSize=50, floorReserve=ceil(50×0.1)=5
(1) dense 占窗口 45 槽 → (2) 最近变更的未索引条目(stale)填 5 个保底槽
→ (3) 剩余 dense 补到 400 → (4) BM25 sparse 补 → (5) 剩余 stale 补
每步 bounded dedup
```

窗口=直通 stage2 的切片；5 个保底槽兑现"新写条目下次 search 立即可召回"的 freshness 不变量。**不做 rank-score fusion**（无 RRF 无加权和）——有序拼接+去重靠位置表达优先级，相关性判断全交 stage2；刻意避免调两套不可比分数的融合权重。

**BM25 sparse（生产已开，纯 JS 零依赖直接可搬）**：tokenizer = ASCII 标识符 + **CJK bigram**；标准 BM25（k1=1.2, b=0.75）+ 高信号字段（slug/title/trigger_phrases）tf ×3。旧的朴素子串实现对中文零匹配（保留为 flag-off 路径）。

**完整降级链（每级都显式可见）**：
```text
① 正常：stage0 → slice(0,50) → stage2 → verdict/hits
② verdict=none 或 pool<5：扩召至 400 + 强制启用 stage1 LLM 救场（仅结果更好才采纳）
③ 仍 none 且 bestEffortOnNone（生产已开）：返回 stage0 top-K，score=0.15，
   rank_reason 明写 best-effort 低置信 + lowConfidence:true
④ query embed 失败：mode=sparse_fallback（禁止回退全库 full-body），retrievalDegraded:true
⑤ sparse 也空：有界 recency 采样
⑥ LLM 挂：直接抛错，无 grep 降级（REQ-009 硬契约）
```

**精确直查快路径**（仅 toolSearch）：query 恰为 slug 或 `adr-NNNN` 唯一命中 → 单条 score=1，跳过全部 LLM；约束"永不抑制召回"，无匹配 fall-through。已修的坑：路由必须先过 status 过滤，否则默认搜索会漏出 archived 的精确 slug。

**典型端到端 6-35s**：一次 query embed（10s 短超时不重试）+ 一次 stage2（50 条全文 ≤12k 字符/条，180s）。三层缓存都**不是** query→结果缓存：entry 向量缓存（content-hash keyed）、provider prompt 前缀缓存（stage2 固定指令在前、stage1 候选面在 query 前）、进程内归一化缓存。

### 7.2 embedding 基建（agentbrain M4 调参的直接参考）

- **生产配置**：dashscope `text-embedding-v4`/1024 维、batch 10、TPM 600k、`entryEmbedMaxChars=3500`、`multiVector:true` `maxChunks:4`（代码默认 doubao/2048 维——**以生产快照为准，不是 DEFAULT_**）。pi 无 vector API，extension 自己裸 fetch OpenAI 兼容 `/embeddings`，零 npm 依赖。
- **索引格式**（`.state/memory/embeddings.json`，实测 93MB）：`{version:2, model, dim, entries:{<裸slug>:{hash:<sha256前16>, vecs:[[..]..], scope:"world"|"project:<id>", scheme:"s"|"m"}}}`。**model/dim 不匹配整份丢弃强制重建**（绝不混用跨模型向量）；scheme 折进 freshness 判定而非 contentHash（toggle multiVector 触发 re-embed，回滚零成本）。
- **分块**：`contentBasis = title\nsummary\ncompiledTruth\ntimeline`（**刻意排除 status/confidence——元数据改动不作废向量**）；≤3500 单块；否则切最多 4 块、**首块外每块前缀 title**（尾段脱离标题会嵌到泛化点）；超 14000 字符丢弃。
- **打分**：默认 maxsim（late-interaction，各 sub-vector 与 query 余弦取 max）；dedup 用 `chunk0`（只用首块——maxsim 会让共享 boilerplate 的不同条目浮成近重候选，实测新增邻居 -74%）。**filter-before-topN 硬约束**（after-topN 过滤会把正确条目挤出去=丢 recall）。纯 JS 线性扫描 + Float32Array 归一化缓存，~5 万条内可接受。
- **增量**：content-hash gate 只 embed 变化条目；**prune 与 embed 解耦**（provider 宕机也能清孤儿）；scope tag 单独刷新；文件锁串行化 read-modify-write。
- **入索引条件**：`(active || archived) && zone!=="rules"`——archived 是合法 tombstone 不被 prune；**rules 区显式排除在向量索引外**（规则走推送面，记忆走检索面，两条路不重叠）。

### 7.3 stage2 prompt 的排序策略（可直接复用）

- **"Be conservative on relevance_verdict"**：仅当至少一条会**实质改变**称职助手的回答才 `has_relevant`；话题相邻/关键词重合 → `none`。
- 必须同时读 compiled_truth **和** timeline；**timeline 可以修订/取代/作废 compiled_truth**，排序要反映。
- 现状类 query 优先新条目，但**不得仅因更新就压过高置信 maxim**；被取代条目排在取代者之下。
- 解析容错四级（`unwrapJsonText`）：直接 parse → 去围栏 → 截取 → 正则捞顶层对象逐个 parse（maxTokens 截断不丢整个候选集）。verdict 与 picks 互相校正。

### 7.4 query 改写 v1→v2（path-A 前置）

用户指令触发的改版（"不能单凭用户输入判断"）：输入从仅当前消息 → **最近 4 轮历史+当前**；输出 40-200 字符 → 200-800 字符 briefing；成本取向**反转**（v1"宁可 useful:false 省钱" → v2"**cost is NOT a criterion**，漏召回比多跑一轮 stage2 更糟"）；新增**反误框架**整节：「我决定用 X」≠「X vs Y 选型」（已决定，查用法）；「yarn 慢死了」≠「包管理器选择」（在吐槽性能）；「这个函数有 bug」不升维成「代码质量规范」；兜底 "err on the side of staying close to what the user literally expressed"；Don't expand the search space（查 A 别加 B/C/D）。任何错误返回 `useful:false` 异常不外逸。

### 7.5 path-A 注入器与 rule-injector 的分工

path-A 每轮 `before_agent_start`：rewriter（useful:false 跳）→ 检索（verdict=none 跳）→ **hydration**（工具面卡片故意不含 compiledTruth，注入前必须按 slug 回填完整 entry——早期漏了这步导致注入块全空，dogfood 数据整批作废的 P0）→ marker 包裹注入，语气"是 reference materials 不是命令；与现场证据冲突时信现场"。任何失败静默跳过；sub-agent 一律跳过；注入块 `wrapVolatile`（逐轮变化内容挪到 prompt 尾部保住前缀缓存）。**每次调用都写一行 path-a-ledger.jsonl**（9 种 outcome + causal anchor，与 outcome-ledger join 归因）。

| | memory path-A | abrain rule-injector |
|---|---|---|
| 内容 | 检索到的相关记忆（参考资料） | 规则/约束（指令） |
| 选择 | 每轮 LLM 改写+两阶段检索 | 读 policy stable-view bundle |
| 变化 | 每轮变（volatile 后缀） | 会话级稳定 |
| 成本 | 每轮 1 rewriter + 1 stage2 | 零 LLM |
| 失败 | 静默跳过 | loud zero + error notify |

这个"推送面/检索面正交"分工 = agentbrain 硬层/知识层分层读取的直接原型。

### 7.6 数据模型（frontmatter 逐字段）

- 规范枚举：`kind ∈ maxim|decision|anti-pattern|pattern|fact|preference|smell`（7 种）；`status ∈ provisional|active|contested|deprecated|superseded|archived`；`provenance ∈ user-expressed|assistant-observed|content-in-transcript`。
- 归一化折叠：`pipeline→pattern`、`knowledge→fact`、`deprecated→superseded`、`in-progress→provisional`；**未知 kind→fact、未知 status→provisional（刻意——降级条目仍可被搜到，不落 archived）**。默认 confidence：maxim 7 / fact,preference 5 / decision,pattern,anti-pattern 3 / smell 2。
- 其他字段：`id`（`project:<pid>:<slug>`/`world:<slug>`）、`title`、`confidence 0-10`、`created/updated`（无格式校验，比较走**语义时间戳比较**——修过混合精度与跨时区两个真实 bug，勿用字典序）、六个关系键（`relates_to/derives_from/superseded_by/applied_in/contested_with/references`，值走 wikilink 解析）、`trigger_phrases`、`schema_version`、`source_ref`（ADR 出处，刻意与 derives_from 分开）、8 个 `sediment_*` 投影溯源字段。
- body：`compiledTruth`（H1 起）+ `## Timeline`（唯一结构化段；行格式 `- <ISO> | <session|sediment> | <verb> | <note>`）。frontmatter 是**迷你 YAML 不支持嵌套 map**——`direction_impact` 因此设计成扁平管道串 `"<relation> | <ref> | <escalation>"`，读写共用同一 total parser 防漂移。
- 必需性三份口径不一致（parser/lint/writer 各一套）——移植时统一成一套。

### 7.7 治理工具与迁移

- **lint 16 条规则**（纯函数可搬）：7 必需字段、status 枚举、confidence 范围、direction-impact 红线（narrows/weakens/conflicts + escalation=none 即 error）、Timeline 结构 8 条（必须是最后一个 H2、唯一、无标题/代码围栏/表格、bullet 格式、时序）。零 auto-fix。
- **doctor 5 block**（只读聚合）：lint / graph（dead-link=error）/ index / migration pending / sediment audit 观测面板。
- **rename-entry 事务**（**整批代码里最有普适价值的设计**）：git clean 检查 → 写事务 marker（baseHead+plannedPaths）→ 写新文件 → **全库入边改写**（正文 wikilink + 6 个关系键；code fence 内不动）→ 向量索引 renameSlug → 最后删旧文件 → postcheck → commit → 删 marker；失败按 marker 回滚；幂等判定 already_completed。
- **migrate-go 九阶段**中值得偷的：**时间戳三角定位**（`created=min(frontmatter, git-first-add, fs.birthtime)`、`updated=max(git-last-touch, frontmatter, dirty?mtime)`）——agentbrain `import-pensieve` 的既定参考；frontmatter 越狱防御（正文 `---` 行改 ` ---`）；目标已存在一律 failed 绝不覆盖。
- **provenance-liveness**（零依赖可整搬）：7 种判词严格优先级（unparseable/file_missing/source_superseded/source_ingested/source_proposed/heading_missing/live），核心价值是把"预期的 ingest 压缩"从"真 drift"里摘出来（否则 251 条里 142 条误报淹没系统）。限制：`@sha` 解析但不用——检测的是文件/章节层失效，不是内容漂移。

### 7.8 ADR 摄入与 memory_decide

- 摄入链**没有任何结构解析器**——ADR 全文塞 prompt，切分/kind 全由 LLM 决定 + 自报 coverage，代码只做 advisory 校验（刻意 AI-Native：不加"每 ADR ≥N 条"机械门）。分解规则："One ADR is NOT one entry"、"prefer <1500 chars"、只分解机制不分解方向。⚠️ 两个缺口：**完全没有去重**（同 slug 静默覆盖）；生产 LLM 从未接线（真实迁移走脚本吃人工确认过的 JSON）。
- `memory_decide` 合成 prompt 的可借鉴段落："You are speaking to the user's LLM — NOT to the user"；**echo-chamber 处理**（decisive_streak≥5 → "助手行为已被这条塑形，这不是用户重新确认"，措辞降级为 pending reconfirmation）；"Weighting is judgment, not arithmetic"（明令禁止硬阈值）；零结果一句话 STOP，"Do not invent advice from thin air"。

### 7.9 usage-telemetry 的警示（死数据流）

`usage-metrics.json`（retrieval_hit/cited 计数）**下游消费者为零**——遗忘/衰减读的是另一套 `entry-telemetry.jsonl`（来自 outcome-collector 链）。**教训：先确定消费方再定埋点 schema，否则会复刻这条平行真值。**

### 7.10 生产 flag 快照（与代码默认值的差异）

```jsonc
search:    { stage1Skip:true, sparseBM25:true, queryRouting:true, bestEffortOnNone:true, autoReconcile:true }
embedding: { multiVector:true, multiVectorMaxChunks:4 }
forgetting:{ enabled:true, instrumentation:true, executorRealApplyEnabled:false→true(2026-07-23) }
```

所有 dark-launch flag 生产已翻开。**注意一处漂移**：stage1/stage2/decide/rewriter 四处全指向同一个高端模型（无便宜模型分层），与 rewriter 注释假设的 flash 便宜模型已不符——agentbrain 定成本模型时以此为鉴（配置与注释都会说谎，看生产快照）。

### 7.11 注册面与 pi 耦合

- 5 tool：`memory_search / abrain_get / memory_list / memory_activity / memory_decide`；1 命令 `/memory {lint|migrate|doctor-lite|check-backlinks}`；3 hook（session_start 捕获 modelRegistry、before_agent_start ×2：footnote 协议 + path-A）。hook 注册顺序有硬要求（causal anchor 绑定必须先于 path-A，注释明写勿加注册守卫——曾因守卫导致全线 anchor_missing）。
- 必须替换的 pi API 集中在：模型调用（`streamSimple`→自建 LlmInvoker）、`modelRegistry`（→凭证解析器）、causal anchor（**必须自建等价物，跨层 join 的唯一 key**）、session 历史读取（→transcript adapter）、注册面（→CLI/hook）。其余 90% 纯逻辑直接搬。

---

## 8. 移植总览：跨切面结论

> 逐模块取舍表见各章末（§3.7 存储基座、§6.6 治理、§7.11 读路径）；主设计附录 A.7 的采纳映射不变。本节只记跨切面的结论。

### 8.1 十二条最值钱的移植纪律（多次事故换来的）

1. **机械门是死条目制造机**：LLM 语义错误第一反应是修 prompt/examples，不是加代码门（ADR 0018 两次 P0 的结论）。硬 gate 只留两类：确定性 sanitizer + 存储完整性。
2. **显式用户指令与 LLM 推断是不同信号类**，权限不相交；显式指令的输出空间排除 skip/stage，classifier 不确定时进 queued 不丢（ADR 0028）。
3. **唯一低风险写原语 = append 证据事件**；语义裁决全部后移到投影时；LLM 产物先固化为 L1 才能进 L2；**L2 字节生成禁止调 LLM**（ADR 0039）。
4. **注入快、裁决慢、两者解耦**：session 启动只读上一份稳定投影，stale 可见、invalid 响亮归零、永不静默降级（ADR 0040）。
5. **确定性的三件套**：JCS 规范化 + code-unit 排序（零 localeCompare）+ 无墙钟（时间戳全部来自事件 body；commit date 用父提交时间）。破坏任何一件，跨设备幂等就没了。
6. **git 是审计链不是真相源**：临时 index + 精确 diff-tree 校验 + CAS 发布 + 工作树永不碰 + git 环境隔离（剔 `GIT_*`，锁 locale）。
7. **终态必须可逆**：全文 archived / abandoned，禁止 unlink、禁止 digest-only tombstone；复活通道不被遗忘开关连带关闭（ADR 0031/0043）。
8. **检索必须 sublinear 且降级显式**：候选面走向量不走全库；BM25 是召回臂不是 fallback；每级降级都带可见标记；"库自演进保证质量不保证变小"。
9. **策略集中可审计**：per-caller 手搓 policy 会漂移、全局 flag 会泄漏进最脆弱路径（两次真实事故）→ profile registry 单点声明（ADR 0037）。
10. **先确定消费方再定埋点**（usage-metrics 死数据流教训）；**同一概念两个名字/两个真值源是事故温床**（inject-mode vs tier 改名、平行 usage 真值）。
11. **审计脱敏是搬运项不是重写项**：FORBIDDEN keys + key 归一化 + 存形状不存内容 + API-key 正则清洗 + 状态目录先 gitignore 再写。
12. **prompt 里的校准语句是资产**："空输出是模态正确答案"、双向 RLHF 警告、"唯一合法改判理由"、"cost is NOT a criterion"（改写侧）——这些比 prompt 结构本身更难重新发明。

### 8.2 宿主耦合面终判

- 2026-08-04 盘点结论成立且被本次精读加强：133k 行中真正触碰 pi API 的 ~195 行（0.15%），集中在：模型调用（`streamSimple`/`modelRegistry`）、注册面（tool/command/hook）、session 历史读取、UI（footer/notify/对话框）、causal anchor 生命周期。
- **最大的两个非 pi 移植障碍**反而是平台性的：①OFD 锁 Linux-only（macOS 必须换锁实现）；②pi 的进程内 detach（`setImmediate`）假设常驻进程——Claude hook 毫秒级退出，**同 key 串行/去重必须改为文件级机制**（M0 spike 验证项）。

### 8.3 对 agentbrain 既定设计的印证与提醒

- 印证：三级检索栈（=stage0 sparse/dense + stage2 精排的凭证分级版）、L1 schema 简化保留 `causal_parents/schema_version`、staging+`_unbound` 认领区、"显式分级降级"替代 REQ-009 hard error、单 LlmInvoker 替代六角色模型——全部与 pi-astack 的演进方向或教训一致。
- 提醒（不改变已拍板决策，仅供实现时注意）：
  1. `context` 注入块应带 marker + "与现场证据冲突时信现场"语气（path-A 的实证措辞）。
  2. 沉淀 prompt 应继承 correction-classifier v3 的默认规则链与 SEMANTIC PRIORITY。
  3. `search` 卡片如做 best-effort 返回，务必带 lowConfidence 标记与显式 rank_reason（对齐 §7.1 降级链）。
  4. embedding 索引第一天就带 model/dim 版本戳 + content-hash 增量 + "不匹配整份重建"不变量（§7.2）。
  5. metrics 先建 `stage0_best_dense_rank / stage0_pool_hit / retrievalDegraded` 三个探针再调参（M4）。
  6. doctor 的 drift 检查直接用 §3.2 的重投影比对思想（reconciler 纯函数 + blob hash 比对）。

## 9. 修订记录

- 2026-08-04 v1：初稿。基线 pi-astack `ad6aa8f`（2026-07-30）。素材：7 份架构现状文档全读 + 37 篇 ADR 全读（0039/0040/0043 全文）+ 四扩展源码精读（含 6 路并行子代理阅读成果汇总与本地实测核对）。

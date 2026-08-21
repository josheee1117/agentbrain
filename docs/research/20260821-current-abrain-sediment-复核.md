# 复核：当前 abrain 与 sediment 的现役架构和演进差异

- 日期：2026-08-21
- 任务：对照 `docs/reference/20260804-pi-astack-abrain-sediment-架构与实现参考.md`（下称“参考”），复核 `~/code_me/pi-astack`（read-only，未做任何修改）当前 HEAD、源码/文档/ADR，以及本地非敏感 feature flags 的匿名化结构
- 复核方法：git 提交/refs 级比对 + 关键源码逐条 grep/精读验证（所有 file:line 均为本次实测，非转抄参考）
- 一句话结论：**本仓快照与参考基线逐字节相同（参考对代码的描述仍然准确，仅一处 localeCompare 表述过度）；真正发生"演进差异"的有两处——①本机生产设置文件已被重写（遗忘 real-apply 关回、模型分层重排、且存在一个参考从未记载的 `canonicalGitRuntime.enabled=false` 总闸，本机现役 git 发布路径因此是 legacy 而非 canonical）；②上游 alfadb `upstream/main` 已领先本 fork 50 个提交（2026-07-30 之后），核心是 ADR 0046 DCC（daemon-owned canonical convergence，Linux 生产已验收）、worker 端 global_maintenance 七车道、CSJ 会话级合并原语、audit-hmac 物理删除、Windows 原生存储支持。**

---

## 1. 基线判定（git 证据）

| 事实 | 证据 |
|---|---|
| 本仓 HEAD = `ad6aa8f`（2026-07-30），与参考声明的快照基线**同一 commit** | `git rev-parse HEAD` = `ad6aa8f8ba15a86af63e351e1fc9934dff3c72ac`；参考文档第 4 行自述基线即 `ad6aa8f` |
| 基线之后零新提交 | `git rev-list ad6aa8f..HEAD --count` = 0 |
| 工作树干净（仅 untracked `.idea/`，非代码） | `git status --porcelain` |
| fork 的 origin/main 与 HEAD 完全同步 | `git rev-list --left-right --count HEAD...origin/main` = `0 0` |
| 上游 alfadb `upstream/main` = `f5e955e`，领先 HEAD 50 个提交（本地 HEAD 另有 3 个 fork 自有提交：`4b50c85` Pi SDK host-runtime fix、`6d1213b`/`1c882cf` 两笔 docs） | `git rev-list --left-right --count HEAD...upstream/main` = `3 50` |
| 上游 50 提交中触及记忆栈（abrain/sediment/memory/_shared/docs）的有 21 笔，合计 51 文件 +8080/-1000 行 | `git log --oneline HEAD..upstream/main -- extensions/abrain extensions/sediment extensions/memory extensions/_shared docs/adr docs/architecture`；`git diff --stat HEAD upstream/main -- <同路径>` |

**推论**：参考对"本仓代码"的一切描述对当前 checkout **逐字节成立**（同一 commit、干净工作树）。因此下文第 2 节只需验证参考"读得对不对"，第 4 节才是真正的"演进差异"。

---

## 2. 参考对代码的描述：逐条验证结果（对 HEAD `ad6aa8f`）

### 2.1 仍然准确（已实测核对，代表性证据）

| 参考的主张 | 实测证据 |
|---|---|
| 统一 typed proposition 三模态（descriptive/normative/meta-lifecycle）仍为现役语义模型 | `extensions/_shared/proposition.ts:21-22`（`PROPOSITION_MODALITIES`）；facet 校验 ：54（authority_kind 六值）、:59（scope_level 六值）、:63-64（temporal_horizon）、:69（trigger_kind 五+unknown）、:48（genesis 绑定） |
| genesis epoch 硬编码常量 | `extensions/_shared/proposition-evidence-writer.ts:31`（`3975b8c76dba…4b27d3`），:77 写入、:257 校验唯一性 |
| L2 reconciler：拓扑排序 + 输入集哈希 + 删除墓碑 + 两遍 self-hash | `extensions/_shared/canonical-l2-reconciler.ts:62`（`topoSortKnowledgeEventsV1`）、:151-152（`inputEventSetHash`、`operation_hint==="delete"` 不产文件）、:126（`sediment_output_hash` 二次渲染）、:32（`compareCodeUnits` 纯码元比较） |
| 检索 5 profile 与参数（toolSearch LLM 定 / decideSearch active/8 / pathAInject active/动态 limit / sedimentDedup all/5 + 两个专属 pin + archivedDenseCandidates / correctionSearch active/10） | `extensions/memory/search-profiles.ts:18-58` 逐条吻合 |
| rule-injector 头注释"Production authority is the content-addressed Policy stable-view only…retired and unreachable" | `extensions/abrain/rule-injector/index.ts:1-8` 原文逐字吻合 |
| `autoLlmWriteEnabled` 三态、代码默认 true | `extensions/sediment/settings.ts:241`（类型 `boolean | "staging-only"`）、:479（默认 true） |
| edge-protocol-shadow 默认关、由调用方 gate | `extensions/sediment/settings.ts:495-501`（默认 false）、`extensions/sediment/edge-protocol-shadow.ts:1223`（"Caller gates enabled=true"） |
| LSEA：authority store 存在（无论 held/free/corrupt）前台一律 capture-only，仅干净 ENOENT 走 legacy | `extensions/sediment/local-executor-authority.ts:53,60`（regime/posture 类型）、:145（ENOENT→absent）、:468-471（store 非 absent 即 `capture_only`） |
| 本地 ADR 共 37 篇、0039/0040/0043/0044/0045 均在 | `ls docs/adr/ | wc -l` = 37（含 README） |
| 架构现状文档 7 份 | `docs/architecture/`：abrain / central-sediment-edge / local-sediment-executor-authority / memory / overview / sediment / vault |
| 扩展规模量级 | 实测：abrain 24 ts/13266 行、sediment 81 ts/62633 行、memory 30 ts/12882 行、_shared 69 ts/44498 行（参考的 133k 总量级成立） |

另：参考 §3.5/§7.10 的以下判断被上游后续动作**事后证实**（见 §4）：audit-hmac"可砍"→上游真的删了；"当前生产权威仍是本地前台"→本机 `executionOwner:"foreground"`。

### 2.2 一处表述过度（参考的小错误）

参考 §3.2 称"**全仓库零 `localeCompare` 参与字节生成**"。实测不成立（但影响极小）：

- `extensions/_shared/canonical-l2-reconciler.ts:352-355`：`buildCanonicalL2V1` 对 **constraint 域**（`constraint-projection-envelope/v1`）选 latest 行时用了 `localeCompare`（`created_at_utc` 与 `eventId` 两级），其结果直接决定 `renderConstraintL2V1` 产出的 canonical L2 字节（:357 写入 expected map）。
- **knowledge 域 fold 本身干净**：tie-break 走 `sameLayerKeyV1`（:57）+ `compareCodeUnits`（:32），无 localeCompare。
- 影响评估：constraint L2 属参考已正确判定的"离线/冷审计残留"（参考 §6.4），且参考本就建议移植时"砍 constraint 域 ~90 行"（§3.7）。对 agentbrain 移植零影响，但"全仓库零 localeCompare"这一绝对化表述应修正为"knowledge 域 fold 零 localeCompare"。

### 2.3 参考的一处**结构性缺口**（非错误，是漏记）

参考通篇未记载 `canonicalGitRuntime` 总闸，而它在 HEAD 代码中真实存在且被广泛 gate：

- 定义：`extensions/_shared/canonical-git-runtime.ts:452-486`——只接受 schema 严格的 `{enabled: boolean, mode: "local_convergence_v2"}`；**显式合法的 `enabled:false` 选择 "legacy boundary"**；配置缺失/非法直接抛 `CANONICAL_GIT_SETTINGS_INVALID`（fail-closed，不是默认 legacy）。
- Gate 面（grep `canonicalGitRuntimeEnabled`）：`extensions/sediment/writer.ts:779,2235,2339,2424,2488,4380,5773`（git 发布路径二选一：canonical `canonicalCommitExplicitPaths` vs `legacyPublication(withLegacyWriterCommitBarrier(...))`，见 writer.ts:2339-2348）、`extensions/abrain/index.ts:226,1506,3046`（canonicalAutoCommit/绑定）、`extensions/abrain/git-sync.ts:207`（push 直接短路）、`extensions/memory/{rename-entry,migrate-go,ingest-adr}.ts`（事务前置于 canonical 判定）。
- 结合 §3 的生产设置（本机 `enabled:false`）：**本机现役的 git 发布/同步路径是 legacy writer commit barrier，canonical exact-cohort/设备 join 路径在本机处于编译在但被闸死的状态**。参考 §3.3/§4.5 把 canonical git 运行时描述为现役技术底座，对"代码存在性"成立，对"本机生产行为"不成立。

---

## 3. 本地 feature flags 匿名化现状 vs 参考 §7.10（2026-08-20 快照）

| 项 | 参考快照（2026-08-04 记载） | 当前实测 | 判定 |
|---|---|---|---|
| `memory.forgetting.executorRealApplyEnabled` | `false -> true`（2026-07-23 起正式全量生产） | **`false`**（`memory.forgetting = {enabled:true, instrumentation:true, executorRealApplyEnabled:false}`；`memory._comment` 明言 "Real forgetting remains disabled"） | **实质差异**：遗忘 real-apply 双门在本机当前未武装。ADR 0031 的代码语义未变（`extensions/memory/settings.ts:185-194` 默认仍 false），变的是本机生产旗标 |
| LLM 模型分层 | 四处（stage1/stage2/decide/rewriter）同指一个高端模型、无便宜分层（§7.10 漂移注记） | **已重排为真实角色分层**：检索侧使用低延迟模型，sediment extractor/classifier/curator 使用另一模型族，aggregator、规则矛盾确认和 multi-view reviewer 再按角色分配，并配置跨厂商 fallback；本文不记录本机 provider alias | **实质差异**：参考的“无分层”漂移注记已过时（跨厂商评审配置也已成文） |
| `canonicalGitRuntime` | 未记载 | `{enabled:false, mode:"local_convergence_v2"}`，注释 "Disabled until Abrain Git storage, recovery and manual memory writes are verified." | **参考缺口**，见 §2.3；本机现役 git 发布=legacy |
| `sediment.executionOwner` | 未记载（当时无此键？HEAD 代码已有：settings.ts:307,501） | `"foreground"` | 与参考"生产权威仍是本地前台"一致 |
| `sediment.edgeProtocolShadow.enabled` | 默认关 | `false`（frozenContractAdapter 也 false） | 一致，shadow 仍未开 |
| `autoLlmWriteEnabled` | true | `true`（但 `sediment._comment` 仍写 "remain disabled"——注释与值再次背离） | 值一致；再次印证参考"配置与注释都会说谎"的警告 |
| search flags（stage1Skip/sparseBM25/bestEffortOnNone/queryRouting/autoReconcile） | 全开 | 全部 true | 一致 |
| embedding（dashscope text-embedding-v4/1024/batch10/TPM600k/3500/multiVector4） | 同左 | 逐项相同 | 一致 |
| event-first 写器族 | constraintEvidence/knowledgeEvidence event_first、projection_only | `knowledgeEvidenceEventWriter={enabled:true,mode:"event_first",…}`、`constraintEvidenceEventWriter` 同构、`knowledgeProjector={canonicalReadMode:"projection_only",projectOnWrite:true,hotOverlayEnabled:true}`、`tier2RulesLegacyWriteGate.mode="block"`、`rulesAsReadonlyNeighborsEnabled:true` | 与参考 §5.1⑦/§6.4 的 B5 cutover 描述一致；**注意**：这些 `_comment` 同样写着 "Disabled until … verified" 而值为 `enabled:true`（注释滞后） |

结论：参考 §7.10 需按上表三处修订（遗忘旗标、模型分层、canonicalGitRuntime 总闸）。

---

## 4. 上游演进差异（alfadb `upstream/main` 领先的 50 提交中与记忆栈相关者）

> 本地 fork **尚未合并**其中任何一笔。以下均出自 `git show upstream/main:…` / `git diff HEAD upstream/main`，属"上游已发生、本仓快照与参考均未覆盖"的差异。

### 4.1 ADR 0046：Daemon-Owned Canonical Convergence（DCC）——最大的架构演进

- `docs/adr/0046-daemon-owned-canonical-convergence.md`（上游新增，369 行）：status **Accepted / implemented / Linux production accepted（2026-07-31）**。
- 决策要点：authority store present 的 strict regime 下，**唯一 canonical convergence executor = 同一 LSEA holder 的 daemon-managed long-lived worker**；TUI/前台不再执行 whole-L1 startup，且 settings=foreground / authority free / unavailable 均不授予 TUI 执行权；新增 sibling attestation（`<ABRAIN>/.state/sediment/canonical-convergence/attestation.json`，strict v1 schema，绑定 LSEA epoch+nonce）；**DCC 叠在 LSEA 之上，不是第二把 authority lock**。
- 实施证据：`62e515d`（daemon canonical convergence control）、`cc22636`（complete daemon-owned canonical cutover，含 abrain 前台 cutover：`extensions/abrain/index.ts +421`、`bind-intent.ts +476`、`brain-layout.ts +511`、`rule-injector/proposition-policy-stable-view-reader.ts +231`）、`extensions/sediment/canonical-control.ts`（上游 2445 行新文件）；DCC 每个真实 canonical mutation frame 重跑 `admitLocalExecutorAuthority`（read-lock-read 防过期）。
- **明确的未完成项（ADR 原文自述）**：Windows DCC attestation native writer/verifier 仍 pending（当前切片 fail-closed：`unavailable/attestation_unavailable`）；**未**声称业务写全量迁移、formal Stage A、ConsumerAck、center primary、retention 完成。
- 对参考 §2.1（ADR 0044 条目）的修正：参考写"Stage A/B/C 未实施；当前生产权威仍是本地 intake+queue+publication"。**对本地 fork 与本机生产仍成立**（executionOwner=foreground、store 缺失走 legacy）；但上游已把 0044 目标态中的"convergence executor 所有权"切片实现并 Linux 生产验收。0044 的 center primary / publication 权威上移仍是目标态。

### 4.2 worker 面 R6：global_maintenance 七车道（遗忘/治理车道 daemon 化）

- ADR 0045 上游修订：`/sediment-worker-maintenance` 的 `kind` 从仅 `publication_outbox` 扩为闭集 `publication_outbox | global_maintenance`；后者在同一 LSEA 准入 + canonical mutation authority frame + 全局串行下运行 **7 条 agent_end 全局车道**：`forgetting | aggregator | staging_resolver | staging_ageout | staging_promotion | multiview_replay | archive_reactivation`（closed lanes 键、closed 状态 `idle|ran|skipped|failed|budget|unknown`、闭集 error_code 枚举、计数分桶，通知面零自由文本/零身份）。
- 新文件 `extensions/sediment/global-maintenance.ts`（上游 856 行，头注释即上述契约）；`worker-rpc.ts +637`；`pass-telemetry.ts`（167 行新）。
- 对参考的影响：参考 §5/§6 描述的"全局车道跑在 TUI/前台 agent_end 调度"在上游已获得 daemon 侧承载面；遗忘/归档/复活**语义**（证据驱动硬门、可逆终态、复活通道独立）未见改变，变的是执行位置。

### 4.3 CSJ（Canonical Session Join）：确定性 join 向会话粒度延伸

- `43fa19b`（2026-08-02）新增 `_shared` 原语族：`csj-eligibility.ts`（596 行）、`csj-prospective-merge.ts`（830）、`csj-artifact-binding.ts`（392）、`csj-blocked-memo.ts`（174）、`csj-closed-reason.ts`（144）、`canonical-ref-move.ts`（442）；`canonical-git-runtime.ts +246`、`git-exact-cohort.ts +74`、`device-join-coordinator.ts +19`。
- 语义：在 ADR 0020 设备级 deterministic join 之下，增加带 witness mint / 资格判定 / prospective merge / artifact 绑定的会话级合并。参考 §3.3 对设备 join 的描述对 HEAD 成立，但"join 粒度=设备"这一隐含上限已被上游突破。

### 4.4 audit-hmac 物理删除（参考 §3.5 判词被上游证实）

- `e215e74`（2026-08-11）"refactor(audit): remove local HMAC layer"：`extensions/_shared/audit-hmac.ts` 整文件删除（320 行），新增 58 行 `audit-checksum.ts`；`llm-audit.ts -37`、dispatch/web-search 相应改造。
- 参考判词"v1 的防篡改靠 git commit 链，不靠 HMAC；audit-hmac 可砍"——上游已照此执行。

### 4.5 Windows 原生 durable 存储（OFD 锁困局的域内解法，非 macOS）

- `c83dd4f` "feat(windows): add native durable storage support" + 多笔 native artifact 构建提交；新文件 `extensions/sediment/edge-protocol-shadow-windows-native.ts`（571 行）；DCC Windows attestation 仍 pending 且 fail-closed。
- 参考的移植警告"OFD 锁 Linux-only、macOS 必须换锁"对 **macOS 依然成立**（上游走的是 Windows 原生插件路线，未触及 macOS）；`e7dc27c`（align compatibility with Pi 0.84.1）顺带触及 abrain。

### 4.6 其它上游变更

- `docs/architecture/overview.md` 整体重写（221→83 行）：八阶段演进叙事改为"设计愿景（alfadb 的第二大脑/Jarvis substrate）/演进主线/当前架构分层/current source of truth/不再作为 current path 的旧概念/Roadmap"。**参考 §1.1"八阶段演进史（overview.md 的官方叙事）"对本地 HEAD 成立，对上游已过时。**
- `e370f1d` feat(memory): aggregate footnote self-reports——`outcome-collector.ts +130`、`outcome-evidence.ts +13`、`memory/index.ts +15`（path-A footnote 自报聚合进 outcome 回流）。
- `2f55dc9` remove goal extension / `f085923` 归档其设计文档（与记忆栈无关，但本地 fork 仍带 goal extension，合并时需注意）。
- `d92ee57`：ADR 0046 增补 "ready due probe deep scheduling"。
- `docs/adr/0003` 仅一处文字修订（ADR 0033 标注"已归档"），主会话只读不变量无变化。
- `docs/architecture/{central-sediment-edge,local-sediment-executor-authority,sediment}.md` 各小幅增补：全部是 DCC overlay 的交叉引用与"每个 mutation frame 重验 authority"的表述更新，LSEA admission 合同本体未改。

---

## 5. 按焦点轴的现役性判定总表

| 焦点轴 | 现役生产行为（本机 + 本 fork HEAD） | 上游已变（fork 未合并） | 目标态未实施 |
|---|---|---|---|
| 统一 typed proposition + 正交 facets | **现役不变**：proposition.ts:21-69 与参考描述逐字段吻合 | 未变 | — |
| L1 证据/proposal/acceptance/事件形态 | **现役不变**（JCS 信封、内容寻址、outbox→L1 顺序） | CSJ 新增会话级合并原语（4.3） | — |
| L2 确定性投影/stable view | **现役不变**（reconciler/版本坐标/policy stable-view 唯一注入源） | abrain 前台 cutover 改动 stable-view-reader（+231） | — |
| sediment lanes / sole-writer | **现役不变**（agent_end 单写、主会话只读） | 全局治理车道新增 daemon 承载面（4.2） | — |
| invisibility/autonomy（ADR 0024） | 不变（ADR 原文未动） | 未变 | — |
| promotion/calibration（staging/multi-view） | 不变 | daemon 侧调度面（4.2）；multiView 评审家配置已成文（§3） | — |
| 遗忘/archive/reactivation/outcome | **语义不变**；但本机 `executorRealApplyEnabled` 已回 **false**（real-apply 未武装）；resurrection/kind 监控代码仍在 | 车道 daemon 化（4.2） | — |
| 检索 profiles / 注入 | **现役不变**（5 profile、三级栈、BM25、embedding 参数逐项相同） | footnote 自报聚合（4.6） | — |
| 主/子代理边界 | 不变（PI_ABRAIN_DISABLED、isSubAgentSession 排除） | 未变 | — |
| local vs central authority | 本机：**executionOwner=foreground、edge shadow 关、canonicalGitRuntime 关（legacy 边界）** | DCC 已实现并 Linux 生产验收；Windows attestation fail-closed（4.1） | 0044 的 center primary / publication 上移 / formal Stage A / ConsumerAck / retention（ADR 0046 明文未声称） |

退役代码清单（参考 §2.5）逐条未变：compiled-view/D3 注入、gbrain、三模型投票、机械 gate、stage1 粗筛等在 HEAD 中仍为已删除/不可达状态，上游亦无复活迹象（`overview.md` 重写版还新增"不再作为 current path 的旧概念"专节）。

---

## 6. 对 agentbrain 的直接影响（简短）

1. **参考文档不需要因本仓重写**——它描述的代码就是本仓 HEAD。需要修订的只有三处：①"全仓库零 localeCompare"改为"knowledge 域 fold 零 localeCompare"（§2.2）；②§7.10 生产快照按 §3 表更新（遗忘旗标回 false、模型已分层、canonicalGitRuntime 总闸）；③ADR 0044 条目加一句"上游已有 ADR 0046 DCC 切片落地（Linux 生产验收），fork 未合并"。
2. **canonicalGitRuntime 总闸值得进 agentbrain 设计视野**：上游用一个 schema 严格、fail-closed 的单键在 canonical 与 legacy 发布路径间二选一——这是"激进路线"与"朴素路线"之间的官方逃生阀，形态比参考记载的任何单一路径都更接近真实生产姿态。
3. **遗忘双门在本机并未武装**：引用 ADR 0031"2026-07-23 起正式全量生产"作依据时，应注明当前生产旗标已回退为 false。
4. OFD/macOS 移植警告不受上游 Windows 原生路线影响，仍然成立。
5. 若日后 fork 合并 upstream（+50 提交），参考的 overview 八阶段叙事与"join=设备粒度"表述将同时过时。

## 7. 证据索引（全部本次实测）

- git：`ad6aa8f`（HEAD=基线）；`f5e955e`（upstream/main）；`0/0` vs origin；`3/50` vs upstream；上游关键提交 `62e515d`、`cc22636`、`43fa19b`、`e215e74`、`c83dd4f`、`e370f1d`、`d92ee57`、`e7dc27c`。
- 代码（本仓 HEAD）：`extensions/_shared/proposition.ts:21-69`；`proposition-evidence-writer.ts:31`；`canonical-l2-reconciler.ts:32,57,62,126,151-152,352-357`；`canonical-git-runtime.ts:452-486`；`extensions/sediment/writer.ts:2339-2348`；`extensions/sediment/settings.ts:241,286,307,495-501`；`extensions/sediment/local-executor-authority.ts:53,145,458-471`；`extensions/memory/search-profiles.ts:18-58`；`extensions/memory/settings.ts:185-194`；`extensions/abrain/rule-injector/index.ts:1-8`。
- 上游文档：`docs/adr/0046-daemon-owned-canonical-convergence.md`（新增）；`0045`（修订 diff）；`docs/architecture/overview.md`（重写 diff）；`central-sediment-edge.md`/`local-sediment-executor-authority.md`/`sediment.md`（overlay 增补 diff）。
- 本地 feature flags：2026-08-20 匿名化快照；只记录架构相关开关和角色分层，不记录 provider alias、密钥或其他配置正文。

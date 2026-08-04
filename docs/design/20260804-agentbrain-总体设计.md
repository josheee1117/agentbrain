# agentbrain 总体设计

- 状态：v1 设计定稿，**未开始实现**（按 Design Gate，实现需用户明确授权）
- 日期：2026-08-04
- 决策来源：2026-08-04 评估会话（abrain 耦合面盘点 + pensieve 跨端配方盘点），关键数字与 file:line 证据见该会话记录
- 参考系统：`pi-astack/extensions/{abrain,sediment,memory}`（思想来源）、`Pensieve` skill（跨端配方来源）

## 1. 背景与问题

两套现存记忆系统各有一半答案：

- **pensieve**（指令式 skill）：跨 Claude Code / Codex 可用，但沉淀是**意志性触发**——依赖主 agent 在任务尾"想起来"执行 self-improve。实测漏沉淀严重（需要 CLAUDE.md 专门写规则催促、short-term 条目长期滞留）。
- **abrain**（pi-astack）：沉淀是**结构性触发**（`agent_end` 生命周期事件 + 专职 curator），写入纪律完整（evidence→projection），但绑定 pi 宿主。耦合面盘点结论：133k 行中仅 195 行（0.15%）真正触碰宿主 API，宿主契约仅 3 个方法；**可移植的是思想与写入纪律，不是整库照搬**。

agentbrain 的定位：**用 pensieve 验证过的跨端配方，承载 abrain 的核心思想**，做一个 Claude Code 和 Codex 通用的记忆机制。

## 2. 已拍板决策（2026-08-04，用户确认）

| 决策点 | 结论 |
|---|---|
| 仓库 | `josheee1117/agentbrain`，私有起步 |
| SOT 位置 | 中心 `~/.agentbrain/` git 仓（abrain 同构），不放项目内 |
| 沉淀算力 | **headless 宿主子进程为主**（`claude -p` / `codex exec`，复用宿主订阅）；**`api` adapter 同时保留入口**（直连 API，独立 key，供多订阅场景切换）；无 hook 环境降级为会话内指令式 |
| 读取分层 | 硬约束（maxim / active decision）session 启动时**选择性注入**；业务知识**按需检索**，触发时机由宿主 LLM 自己判断 |

## 3. 设计原则：继承什么、放弃什么

**继承自 abrain：**

1. **结构性触发**：记忆写入挂在生命周期事件（hook）上，100% 发生，不经过主模型"自觉"。
2. **canonical = 投影**：L1 证据事件 append-only 是唯一语义 SOT；L2 markdown 是确定性投影，禁止手改；纠错/撤回/归档一律追加新 L1 事件（ADR 0039 简化版）。
3. **writer 纪律**：主会话不直改 L2；所有写入走 CLI（append L1 → projector 重投影）。
4. **分层读取**：注入层（小、预算受控、启动即达）与检索层（大、按需、宿主判断）分离。
5. **settings 驱动**：模型、预算、adapter 选择全在配置，代码零硬编码 model id。
6. **DI 接缝**：LLM 调用抽窄接口（借 `pi-ai-invoker.ts` 的 `ModelRegistryLike`/`StreamSimpleLike` 形状），adapter 可替换。

**继承自 pensieve 跨端配方（盘点确认的四条硬条件）：**

1. 数据是宿主无关纯文本（markdown + YAML frontmatter + 一事件一文件 JSON）。
2. **hook 只做加速器**：每个 hook 自动化动作都有等价手动 CLI 命令，且命令印在生成产物头部——无 hook 宿主降级是"少自动化"不是"少功能"。
3. 对外只暴露少量环境变量契约 + 不依赖环境变量的多级 fallback。
4. 宿主指令文件（CLAUDE.md / AGENTS.md）用 marker 块注入，宿主间只差文件名。

**明确放弃（不移植）：**

- vault 全套（bash 密钥注入 / stdout 扣留 / TUI 授权）——依赖 pi 独有的 tool_call/tool_result 拦截。
- p99<100ms durable journal/seal 合同——hook 外部进程模型承诺不了，quick-capture 尽力而为即可。
- REQ-009 硬 LLM 精排合同——降级为"确定性候选召回 + 宿主 LLM 在会话内判断"（无独立模型依赖）。
- 中心 memory service（ADR 0044 形态）——单用户单机起步，不做 daemon。

## 4. 数据布局：`~/.agentbrain/`

```text
~/.agentbrain/                     # git 仓；remote 私有仓可选（M4 auto-push）
├── config.json                    # worker adapter / 模型 / 预算 / 触发门槛
├── l1/events/sha256/ab/cd/<hex>.json   # append-only 证据事件，内容寻址，一事件一文件，immutable
├── projects/<id>/                 # 项目 L2 投影区
│   ├── maxims/ decisions/ knowledge/ preferences/
│   ├── staging/                   # 低置信候选（未 bound 项目的沉淀也落这里，不丢弃）
│   └── _index.md                  # 派生索引（可重建）
├── global/                        # 跨项目 L2：maxims/ preferences/
└── .state/                        # 不入 git（.gitignore=*）：queue/ locks/ index.sqlite / audit.jsonl
```

- **L1 event 最小 schema**：`{schema_version, event_type(observe|correct|archive|explicit), created_at_utc, host(claude|codex|manual), session_id, project_id?, payload, source_quote?, causal_parents[], body_hash}`。`event_id = sha256(canonical_json(body))`；文件名即 hash，跨设备 git merge 天然无冲突（借 ADR 0039 §4.2，去掉 device_seq 等多机字段，留 schema 位）。
- **L2 frontmatter**：`id / kind(maxim|decision|knowledge|preference) / status(active|provisional|archived|superseded) / scope(project|global) / confidence / trigger_phrases / created / updated / derived_from(L1 event ids)`。由 projector 确定性渲染（固定模板、固定排序、UTF-8/LF），文件头注明"由 projector 生成，手改会被 doctor 报 drift"。
- **L3**：`.state/index.sqlite`（`node:sqlite` 内置 `DatabaseSync`，零外部依赖，表边界借 `adr0039-l3.ts`）：`search_corpus`（FTS5）、`chunks` / `embeddings`（多向量，含 model/dimension/hash）、`projector_state`（投影水位线）、`jobs` / `diagnostics`。完全可重建，不入 git。**不采用 abrain 现状的 JSON sidecar embedding 索引双轨**——agentbrain 无历史包袱，向量直接进 sqlite，一步到位到 ADR 0039 的目标边界。

## 5. 项目绑定

简化 abrain 三件套为两件（v1 单机，去掉 local-map）：

- 项目仓内 `.agentbrain.json`：`{"project_id": "<id>"}`（git 可见、可迁移）。
- `~/.agentbrain/projects/<id>/_project.json`：注册侧。
- 双向匹配 = bound；未 bound 时 sediment 不拒绝也不误归——candidate 落 `staging/_unbound/<cwd-hash>/`，`agentbrain bind` 后可认领。cwd/git remote 永不隐式授予 project 归属（借 ADR 0017 的核心不变量，砍掉执行复杂度）。

## 6. 读路径（核心需求：分层触发，宿主自己确认时机）

**硬层——选择性注入（推 push）：**

- 内容：bound 项目的 active maxims 全量 + active decisions 的标题行摘要 + global maxims；预算上限（默认 ≤4KB，config 可调），超限按 `confidence × updated 新鲜度` 截断并注明"已截断，完整列表用 `agentbrain context`"。
- Claude Code：`SessionStart` hook 输出 `additionalContext`。
- Codex：`user_prompt_submit` hook 注入（用户环境已验证支持）；hooks 不可用时由 AGENTS.md marker 块指令宿主在会话开始先跑 `agentbrain context`。
- 等价手动命令：`agentbrain context [--project <id>]`。

**知识层——按需检索（拉 pull）：**

- 不注入。宿主指令文件的 marker 块写清触发时机：设计/取舍/排障/接外部 API 前先 `agentbrain search "<完整检索意图>"`。
- `search` 返回：候选条目卡片（path / kind / title / status / confidence / 命中摘要）；**默认最终判断留给宿主 LLM**（读命中文件、决定采信哪条）。

### 6.1 检索栈：三级阶梯，按凭证与配置分级启用

对标 abrain 最新检索架构（stage0 有序 hybrid + stage2 LLM 精排，ADR 0035/0036/0037），按"凭证可得性"拆成三级，`config.json` 的 `retrieval.profile` 选择：

| Tier | 内容 | 启用条件 | 对应 profile |
|---|---|---|---|
| **Tier0 sparse**（始终可用） | sqlite FTS5 BM25（char n-gram 分词，中英混合友好）+ `trigger_phrases` 精确命中 + 文件名/`id` 匹配 | 无 | `fast` |
| **Tier1 dense hybrid** | embedding 多向量召回（每 entry ≤ `multiVectorMaxChunks` 个 sub-vector，长条目分块）与 Tier0 融合：dense 先占候选窗口（扣除 **freshness reserve** 配额，给 stale/missing 条目按 `updated` 插位），再补 BM25 sparse；allow-set 去重；`stage0MaxCandidates` 封顶 | `retrieval.embedding` provider + key 已配置 | `hybrid` |
| **Tier2 LLM 精排** | 候选全文交给 `LlmInvoker`（§8 任一 adapter）做相关性精排与 verdict；`none` 时可显式返回 Tier0/1 排序的低置信 top-K（对齐 abrain `bestEffortOnNone`，卡片标注"未经精排确认"） | 任一 LLM adapter 可用 | `reranked` |

- **索引维护**：向量索引存 `.state/index.sqlite`（`chunks` + `embeddings` 表），search 时 **auto-reconcile** 增量补齐（新增/变更条目现场补嵌入，超预算留待 `agentbrain index --rebuild`）；全量重建命令等价（配方规则：hook/自动化必有等价手动命令）。
- **降级语义（与 abrain 的关键差异，有意为之）**：abrain 有 REQ-009 硬合同——精排模型不可用直接 hard error、禁止降级。agentbrain 是多宿主工具，改为**显式分级降级**：embedding 不可用 → 收窄为 sparse-only 并在输出注明"仅稀疏召回"；LLM 不可用 → 返回 Tier0/1 候选并注明"未精排"。降级永远可见，不静默装作全量结果。
- embedding provider 复用 `api` adapter 的凭证配置块（§8），模型/维度/分块参数全 config 驱动。

## 7. 写路径（sediment）

**快路径（hook capture，同步、毫秒级）：**

```text
Claude Stop hook / Codex notify(turn-ended)
  → stdin/argv JSON {session_id, transcript_path, cwd}
  → 追加 intake 记录到 ~/.agentbrain/.state/queue/<session>.jsonl
  → 廉价门槛判断（本轮有无工具调用/编辑/用户纠错词）不达标则只入队不拉进程
  → setsid 拉起 detached worker，立即返回
```

**慢路径（detached worker，`agentbrain sediment-run`）：**

```text
锁（.state/locks/sediment.lock）→ 合并队列（同 session 多轮合并，借 agent-end-queue 思路）
  → 读 transcript → 规范化为统一 TranscriptEntry[]（每宿主一个 adapter，见 §10）
  → LLM 提炼候选（prompt 独立 md 文件，输出结构化 JSON：kind/scope/quote/理由/confidence）
  → 安全门（路径/秘密扫描，不合格丢弃并审计）→ append L1 events
  → projector 重投影受影响的 L2 → git commit（消息含 event ids）
  → 低置信(<阈值)候选落 staging/，高置信直接入区；解析失败不重试、写审计、不打扰用户
```

**显式写**：`agentbrain remember "<fact>" --kind decision --scope project` 与纠错 `agentbrain correct <id> "<原因>"`——同样 append L1 再投影，**绝不直改 L2**。

**防自触发与降级**：worker 进程带 `AGENTBRAIN_WORKER=1`，hook 脚本首行检测即退出；无 hook 环境降级为会话内指令式（宿主按 marker 块指令在任务尾跑 `agentbrain sediment-run --from-transcript <path>`），命令完全等价。

## 8. Worker LLM adapter（本次拍板重点）

```ts
interface LlmInvoker {
  complete(req: { system?: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<string>;
}
```

`config.json` 的 `worker.adapter` 三选一：

| adapter | 实现 | 凭证 | 适用 |
|---|---|---|---|
| `headless-claude`（默认） | spawn `claude -p --model <cfg.model> --allowedTools "Read Write(~/.agentbrain/**)"` | 复用 Claude Code 登录态/订阅 | 默认路径 |
| `headless-codex` | spawn `codex exec` | 复用 Codex 登录态 | Codex 为主力时 |
| `api` | 直连 Anthropic / OpenAI-compatible（key 取 `env AGENTBRAIN_API_KEY` 或 config） | 独立 key、独立计费 | 多订阅/不占交互额度场景 |

模型 id、maxTokens、每日预算、触发门槛全部 config 驱动；代码内零默认 model（借 sediment `settings.ts:549` 纪律）。三个 adapter 共用同一提炼 prompt 与输出 schema，切换不改行为语义。

**凭证配置块**（`config.json`）供 `api` adapter 与 `retrieval.embedding` 共用：`{ baseUrl, apiKeyEnv | apiKey, model }` 各一份——沉淀用生成模型、检索用 embedding 模型，key 可以同源（同一订阅）也可以分开。

## 9. CLI 命令面

`agentbrain` 单命令入口（TypeScript / Node ≥22，仅用内置模块，无运行时依赖）：

```text
init                      # 初始化 ~/.agentbrain（git init + 布局 + config 向导）
bind [--project <id>]     # 项目绑定（写两侧文件）
status                    # 绑定状态 / 队列深度 / 最近沉淀 / drift 检查摘要
context [--project <id>]  # 输出硬层注入内容（hook 的等价手动命令）
search "<intent>"         # 候选召回卡片
remember / correct        # 显式写入 / 纠错（append L1）
sediment-run [--from-transcript <path>]   # worker 主体（hook 的等价手动命令）
project [import-pensieve <dir>]           # 迁移入口（M4）
doctor                    # 结构体检：L2 drift、坏 frontmatter、队列积压、schema 版本
sync-instructions --host claude|codex     # 维护 CLAUDE.md / AGENTS.md marker 块
install-hooks --host claude|codex         # 幂等写 hook 配置
```

## 10. 宿主适配层

| 能力 | Claude Code | Codex |
|---|---|---|
| 硬层注入 | `SessionStart` hook → `additionalContext` | `user_prompt_submit` hook（注入 JSON 形状与 Claude hook 输出同形，已有 pensieve-codex-hook.py 先例） |
| 沉淀触发 | `Stop` hook（stdin 带 `transcript_path`） | `notify` turn-ended / hooks 事件 |
| transcript 适配 | 会话 JSONL，`parentUuid` 父链 → 取当前分支 | rollout JSONL；**格式与分支语义为 M0 验证项** |
| 指令文件 | CLAUDE.md marker 块 | AGENTS.md（或 AGENTS.override.md）marker 块 |

- transcript 统一形状：`TranscriptEntry { role, text, toolUse?, ts, id?, parentId? }`；宿主 adapter 各自实现"取本分支最近 N 轮"。
- **版本身份**（吸取 pensieve 双 clone marker 互踩教训）：agentbrain 单一安装（npm global 或 `~/.agentbrain/bin`），两宿主共用同一份可执行；数据仓只记 `schema_version`，不记宿主侧版本。doctor 负责报数据 schema 与 CLI 版本的兼容性，不做互踩式预检。

## 11. 与现存系统的边界

- `~/.abrain`（pi）：不读不写不迁移，两系统并行；pi 宿主不在 agentbrain v1 范围。
- 各仓 `.pensieve/`：不动；M4 提供 `import-pensieve`（frontmatter 归一化借 abrain migrate 的 kind 推断 + created/updated 三角测量思路）。
- data-asset 双头（.pensieve vs ~/.abrain/projects/data-asset）收敛是**独立决策**，不在本仓 scope，不被本设计隐式决定。

## 12. 里程碑（每个用户可验收）

- **M0 spike（先行验证，出结论即停）**：① Codex notify/hook payload 与 rollout 文件格式实测；② `claude -p` 被 Stop hook detached 拉起的全链路 PoC（含防自触发）。M0 结论可能修订 §7/§10 细节。
- **M1**：存储布局 + L1 append + projector + 绑定 + `init/bind/status/doctor`。
- **M2**：读路径双端——`context/search/sync-instructions/install-hooks`（先 Claude 后 Codex）。
- **M3**：sediment 双端 headless——快路径 hook + `sediment-run` + `headless-claude`/`headless-codex` adapter。
- **M4**：`api` adapter、Tier1 dense hybrid + Tier2 `reranked` profile（激活依赖独立凭证到位；embedding 模型与分块参数在此调定）、`import-pensieve`、git auto-push。

## 13. 风险与未验证项

| 项 | 状态 | 处置 |
|---|---|---|
| Codex notify/rollout 格式、hook 是否携带足够 transcript 信息 | **未验证** | M0 spike，最高优先 |
| Claude Stop hook 在 compaction / subagent / `claude -p` 场景的触发语义 | 未验证 | M0 spike 一并测；worker 环境变量守卫兜底 |
| token 成本（每轮触发） | 已知风险 | 廉价门槛 + 队列合并 + 便宜模型 + 每日预算熔断（config） |
| headless 子进程权限 | 已知风险 | `--allowedTools` 白名单限制只写 `~/.agentbrain/**` |
| 多机 git 冲突 | v1 不处理 | L1 内容寻址天然不相交；L2 冲突=丢弃重投影（借 ADR 0039 §4.4），M4 之后再验 |
| Tier0-only 阶段召回面窄 | 接受（过渡态） | 检索栈已按三级设计（§6.1），Tier1/2 激活只差凭证配置；embedding 选型与语料分块为 M4 调参项，不再是设计缺口 |

## 附录 A：abrain / sediment 最新架构全景（2026-08 快照，后续参考）

> 二手快照：整理自 pi-astack 的 ADR 0003/0014/0016/0017/0023/0024/0039/0040/0044/0045、`docs/architecture/{abrain,memory,vault}.md`、迁移 runbook 与 2026-08-04 耦合面盘点（133,279 行 / 195 行宿主调用 / 67% 纯库）。**实施状态以 pi-astack 代码为准**；本附录用于 agentbrain 后续迭代时"抄哪里、为什么不抄"的对照。

### A.1 存储基座：HYBRID_MD_GIT_PLUS_DB（ADR 0039）

三层分工，统一写入纪律是"**唯一低风险写原语 = append Evidence Event**"：

- **L1 Evidence Event SOT**：内容寻址、一事件一文件、immutable 的 canonical JSON（RFC8785/JCS 规范化；信封记 `schema/hash_alg/event_id/body_hash`，`event_id = sha256(JCS(body))`；路径按 hash 分片 `l1/events/sha256/ab/cd/<hex>.json`）。body 必含 `event_type/created_at_utc/device_id/causal_parents/session_id/turn_id/source/payload/sanitizer/producer`。纠错、撤回、遗忘、归档、复活、矛盾**都是追加新事件**，永不覆写；安全门（secret/PII/路径/注入）在 append 前，语义裁决（merge/scope/dedup/冲突）在投影时。LLM 产物入 L2 前必须先固化为 L1 event（记 `model/prompt_hash/input_hash/output_hash`）。
- **L2 Markdown View**：确定性 renderer 从 L1 派生（拓扑排序 + 稳定 tiebreak；固定模板/标题层级/key 序/UTC/LF）。**不是用户管理界面**——手改 = dirty derived view，reconcile/pre-push 阻断；用户意图必须转成 L1 correction event 再重投影；git merge 冲突的 L2 直接丢弃、合并 L1 后重投影。文件携 machine-readable provenance（projector/template 版本、input set hash、output hash）。
- **L3 Operational DB/Index**：本地 SQLite（`adr0039-l3.sqlite`，表边界：`l1_events` mirror / `event_edges` / `projector_state` 水位线 / `l2_views` / FTS5 / `chunks`+`embeddings` / `graph_nodes`+`graph_edges` / `jobs` / `diagnostics`）。不入 git、可丢弃、可从 L1+L2 重建；**现状双轨**：`memory_search` 生产运行时仍主要用 JSON sidecar embedding 索引（`.state/memory/embeddings.json`），SQLite 是目标边界的 partial production 实例。
- **数据拓扑**：`~/.abrain/` 七区（identity/skills/habits/workflows/projects/knowledge/vault）+ 第 8 类 `rules/`；项目记忆在 `~/.abrain/projects/<id>/`（旧 `<repo>/.pensieve/` 已废止为只读迁移源）。

### A.2 写路径：sediment（ADR 0003/0016/0024/0039）

- **不变量**：主会话只读（LLM tool 面没有任何 brain mutation 工具）；sediment 是唯一 writer；INV-INVISIBILITY（用户不管理记忆，唯一合法弹窗是 vault_release）；INV-ACTIVE-CORRECTION（自然对话中"以后用 X / 忘掉那条"是一等纠错信号）；显式用户指令不得因 classifier 不确定而静默丢失（进 queued/unclassified，不丢）。
- **管线**：`agent_end` → durable intake 记录（崩溃可恢复）→ agent-end-queue（按 key 合并、并发 4）→ 回读宿主 transcript 沿 `parentId` 走出当前分支 → LLM extractor 结构化提取 → 安全门 → append L1 → projector 投影 L2 → git commit。`agent_end` 路径本身**不做任何 canonical mutation**（p99 < 100ms capture 合同）。
- **多模型 settings 驱动**：extractor / classifier / curator / aggregator / stagingPromotion / multiView.synthesis 各自配模型，代码零硬编码；prompt 全部是独立 markdown 文件（skeptical-historian、multi-view blind/reveal、staging-resolver、active-correction-classifier 等）。
- **staging 生命周期**：低置信候选入 staging，由后台 LLM 做 promotion / ageout / 冲突解决；高影响动作（跨 scope、merge/supersede、demote）走 multi-view 交叉验证（pass1 盲评 + pass2 揭示）。
- **Lane 模型**：A（explicit MEMORY fence）/ C（agent_end 自动）/ G（about-me → identity/skills/habits）/ V（vault，同步路径不走 sediment）；B/D promote 概念已废——七区内直接路由，无"晋升"。

### A.3 规则注入（ADR 0023 → 0040）

- 现产 session rule authority 是 **proposition-policy-stable-view**：content-addressed bundle（`.state/sediment/proposition-policy-stable-view/v1/latest` 指针），`session_start` 严格校验后注入；stale 可注入但发诊断，invalid/missing = loud zero（不注入也不回退旧源）。早期 constraint-shadow compiled-view 已退役为离线审计残留。
- 设计动机：把"哪些规则该进 session"的裁决从写时/注入时移到后台 compiler，注入路径只读上一份稳定投影——**注入快、裁决慢、两者解耦**。

### A.4 读路径：memory_search（ADR 0015/0035/0036/0037）

- 只读工具面：`memory_search / abrain_get / memory_list / memory_activity / memory_decide`；facade 不向 LLM 暴露 backend/scope/source_path（仅 exact lookup 可见）。
- **stage0 有序 hybrid 召回**：dense（多向量，每 entry ≤ multiVectorMaxChunks 个 sub-vector）先占候选窗口、扣除 freshness reserve 给 stale/missing 条目按更新时间插位 → 剩余 dense → char n-gram BM25 sparse → 剩余 stale；allow-set 去重、`stage0MaxCandidates` 封顶。
- **stage1 默认跳过**（`stage1Skip=true`，仅 verdict=none 或候选池过小时作为安全网）；**stage2 全文 LLM 精排**产出最终 cards。
- **REQ-009 accuracy 合同**：精排模型不可用 = hard error，禁止 grep/BM25 冒充结果；embedding 不可用只熔断为 sparse-only 候选（召回面收窄但仍须精排）；`bestEffortOnNone` 允许显式返回未确认低置信 top-K。
- 索引维护：search 时 autoReconcile 增量补嵌入 + `embed-corpus-init.mjs` 全量重建；`_index.md`/graph/metrics 全部可重建派生物。

### A.5 项目绑定（ADR 0017）

三件套全匹配才 `bound`：`<repo>/.abrain-project.json` + `~/.abrain/projects/<id>/_project.json` + `~/.abrain/.state/projects/local-map.json`（本机路径授权，不入 git）。cwd / git remote 永不隐式授予项目身份；active project 是 boot-time snapshot，会话中 `cd` 不切换；未 bound 时项目写入 fail closed。

### A.6 中心化方向（ADR 0044/0045，目标态）

长期记忆的"接收/排队/裁决/发布"权威迁往中心 memory service（pi-router + `pi_memory_*`）；edge（每台设备的 pi）只保证 source 不丢、交互不阻塞、因果身份不漂移。关键概念：candidate ≠ settled（`agent_end` 只产 candidate，`agent_settled` 写 witness）；C6 因果身份 `(session_id, turn_id, subturn, sub_agent_label, parent)` 与 `run_generation` 执行代际严格分离；禁止永久双主（`local_primary/central_shadow/central_primary/rollback_draining` + authority_generation）；Git 降为异步导出/灾备。现状：Pi 侧 capture-only protocol shadow 已实现、默认关；Stage A/B/C 未实施。**对 agentbrain 的意义**：未来若多宿主并发写入冲突成为真实痛点，"中心服务 + 薄 edge"是已经过 T0 评审的演进方向，agentbrain 的 hook capture + queue 形态与 edge 合同天然对齐。

### A.7 agentbrain 采纳映射

| abrain/sediment 机制 | agentbrain v1 | 理由 |
|---|---|---|
| L1 内容寻址一事件一文件 | 采纳（schema 简化，留 `causal_parents`/`schema_version` 位） | 跨设备 git merge 天然无冲突 |
| L2 确定性投影 + 禁手改 | 采纳（doctor 报 drift，不做 pre-push 硬阻断） | drift 可检可修，单人场景不需要 push 门禁 |
| L3 SQLite（FTS/向量/水位线） | 采纳，且不搞 JSON sidecar 双轨 | `node:sqlite` 零依赖，无历史包袱 |
| sediment 结构性触发 | 采纳（hook + detached worker 版） | 意志性触发漏沉淀是 pensieve 实证缺陷 |
| agent_end 只 capture、语义裁决后移 | 采纳（快/慢路径分离） | 同 abrain 动机：写路径低风险 |
| stage0 hybrid + stage2 精排 | 采纳为三级阶梯（§6.1），激活按凭证分级 | 多宿主工具不能假设凭证必在 |
| REQ-009 hard error | **放弃**，改显式分级降级 | 同上；降级必须可见，不静默 |
| 多模型 settings（6 种角色模型） | 简化为单 `LlmInvoker` + 单提炼 prompt | v1 一个模型角色足够，复杂度后置 |
| staging 低置信区 | 采纳（含 `_unbound` 认领区） | 防丢弃、防误归 |
| multi-view 交叉验证 / meta-curator | 放弃 | 投入产出比不成立（v1） |
| policy stable-view bundle 校验注入 | 简化为 `context` 预算注入 | 单机无 bundle 一致性诉求 |
| strict binding 三件套 | 简化为两件（去 local-map） | v1 单机 |
| vault / rules 第 8 类 / C6 / journal seal 合同 | 放弃 | 宿主能力不支持或场景不需要 |
| 七区数字孪生 | 收窄为 `projects/` + `global/` | agentbrain 定位是工程记忆，不是个人孪生 |

## 14. 修订记录

- 2026-08-04 v1.1：检索栈升级为三级阶梯（Tier0 FTS → Tier1 dense hybrid → Tier2 LLM 精排，profile 驱动，激活按凭证分级）；L3 表边界细化并明确不采用 JSON sidecar 双轨；新增附录 A「abrain / sediment 最新架构全景」与采纳映射表。
- 2026-08-04 v1：初稿。三项用户拍板（仓名/中心 SOT/headless 为主 + api 入口）；分层读取模型定稿；M0-M4 里程碑。

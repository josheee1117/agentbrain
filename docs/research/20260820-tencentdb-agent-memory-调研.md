# TencentDB Agent Memory 调研笔记

- 日期：2026-08-20
- 调研对象：本地克隆 `/tmp/tencentdb-agent-memory`，分支 `feat/server_team`，commit `97f94654280b2932c35ba4806a491999ed244cc9`（README 自称 v2.0.0；`MemoryCore/package.json` 为 `2.0.0-beta.1`；`CHANGELOG.md` 最新条目 `2.0.1-beta.1`，2026-08-13）
- 对比基线：`docs/design/20260804-agentbrain-总体设计.md`（v1.2）
- 方法：通读根级 README/INSTALL/CHANGELOG/ROADMAP + MemoryCore / MemoryProxy / MemoryKnowledge 源码精读（抽样；该分支约 19 万行 TypeScript/Python）；本文为只读调研，未改动设计文档与实现代码
- 定位提醒：TencentDB Agent Memory（下称 TAM）是**团队记忆服务**（多用户、多 Agent、面板管控、云服务化），agentbrain 是**单用户本地工具**。目标不同，本笔记聚焦机制层证据与可迁移结论，不直接评判产品定位

## 1. 总览：四件套 + 双部署形态

| 模块 | 角色 | 关键路径 |
|---|---|---|
| MemoryCore | 记忆内核（Gateway HTTP 服务 + OpenClaw 插件 + Hermes 插件 + context offload 模块） | `MemoryCore/src/{core,gateway,offload,offload_server,metadata,services}` |
| MemoryProxy | LLM API 反向代理：拦截 Claude Code / Codex / CodeBuddy / WorkBuddy / DSH 请求，注入记忆、写回对话 | `MemoryProxy/src/{handler,injection,agent-adapters,session,tdai,skill,memory}` |
| MemoryPanel | Hub 管控面板（团队/Agent/资产管理 Web UI） | `MemoryPanel/{web,src,config}` |
| MemoryKnowledge | Wiki（LLM 结构化文档 + 链接图谱）与 CodeGraph（代码符号/调用关系索引）服务 | `MemoryKnowledge/src/{engines/wiki,engines/code,store}` |

两种部署形态共享同一 Gateway 代码（`README.deployment.md`）：

- **Standalone**：SQLite（`sqlite-vec` 向量 + FTS5）+ 本地文件，数据目录 `~/.memory-tencentdb/memory-tdai/`（`vectors.db`、`conversations/`、`records/`、`scene_blocks/`、`persona.md`、`checkpoint.json`），零外部存储依赖。
- **Service**：TCVDB（向量）+ COS（对象存储）+ Redis（分布式锁/队列），面向多副本、多租户部署，按 `x-tdai-service-id` 路由实例。

分层模型：L0 原始对话 → L1 原子记忆 → L2 场景块 → L3 用户画像，README 与代码一致。

> **不要按层号硬对齐。** TAM 的 L0–L3 是“内容抽象层级”：原话逐步抽象成 atom / scenario / persona；agentbrain 的 L1–L3 是“权威与派生层级”：Evidence SOT / Markdown View / Search Index。两套数字描述的维度不同，TAM 的 L1 atom 不是 agentbrain 的 L1 evidence，TAM 的 L3 persona 也不是 agentbrain 的 L3 index。

## 2. SOT 与数据模型（与 agentbrain 最大分歧点）

**没有 canonical event sourcing，也没有确定性投影纪律；有 best-effort 生成溯源。** 主要存储是多轨的：

- **L0/L1 JSONL**：append-only 日分片（`records/YYYY-MM-DD.jsonl`、`conversations/…`），文件头注释自称"JSONL is the append-only persistent store (source of truth for backup/recovery)"（`MemoryCore/src/core/record/l1-writer.ts`）。
- **VectorStore（SQLite/TCVDB）**：同一 legacy writer 又称 VectorStore 是主要检索引擎，update/merge 会实时删除旧检索记录；standalone JSONL 还可被 retention cleaner 按日清理。service 路径则明确允许 TCVDB/COS 承担 authority。更准确的结论不是“两个并列 SOT”，而是：**authority 随部署模式和调用路径变化，缺少 agentbrain 那种统一 canonical event contract，部分源码注释对 JSONL 与 DB 的角色存在漂移。**

要点：

- **L1 record schema**（`l1-writer.ts` `MemoryRecord`，v3）：`id/content/type/priority(0-100，-1=全局硬指令)/scene_name/source_message_ids/metadata/timestamps/createdAt/updatedAt/version(单调递增)/sessionKey/sessionId/taskId` + 三维租户字段 `teamId/userId/agentId`。type 含 chat 侧 `persona|episodic|instruction` 与 work 侧 `work_fact|work_task|work_method|work_artifact`（`MemoryType`）。
- **SQLite 检索层**（`MemoryCore/src/core/store/sqlite.ts`）：`l1_records`(:626)、`l0_conversations`(:748)、`l1_vec/l0_vec`（sqlite-vec vec0 虚表，:684/:806）、`l1_fts/l0_fts`（FTS5，:1088/:1111）；embedding 模型/维度变更靠 `embedding_meta`(:553) 检测并触发 reindex。
- **L2 场景块**：markdown 文件 + 自定义 `-----META-START-----/-----META-END-----` 分隔符头（`created/updated/summary/heat`，`MemoryCore/src/core/scene/scene-format.ts`），**由 LLM 通过文件工具直接读写**，无确定性 projector、无 drift 检测。
- **L3 画像**：单文件 `persona.md`，LLM 重写 + `BackupManager` 保留 N 份备份（`persona-generator.ts`，backupCount 默认 3）。
- **审计**：`memory_audit` 表只追加记录 L1/L2/L3 的 update/delete（`record_id/layer/action/version/updated_at_ms`），但不保存旧值——它是操作审计，不是可回放的事件溯源。
- **生成溯源（本分支的重要增强）**：`memory-generation-logs/v1/**` 追加保存每次 L1/L2/L3 生成的 `input_refs`、`output_refs`、prompt id/version/hash、model、时延和身份作用域；`memory_generation_refs` 将当前输出映射到最近一次生成日志（`core/memory-generation-log/{types,store}.ts`、`pipeline-factory.ts`）。这比普通审计强，能回答“当前输出由哪批输入、哪版自定义 prompt 生成”；但它通过 `writeGenerationProvenanceBestEffort()` 写入，失败不影响记忆生成，ref 是 upsert 的当前映射，日志不保存完整输入快照/旧内容，而且 builtin prompt 的 `prompt_sha256` 目前为空，所以仍不是 canonical event SOT，也不足以确定性重放。
- **元数据/资产模型**（`MemoryCore/src/metadata/types.ts`，完整业务模型在 metadata 模块，core/store 里的 `entity_*` 是简化版）：`meta_assets`（asset_type = `skill|llm_wiki|code_graph|chat_memory`，visibility/status/version/confidence/usage_count/content_ref）、`FixedAssetBinding`（agent↔asset 绑定，injection_mode = `direct|summary|tool|reference` + priority）、ACL（subject = user/team_role/agent，effect 目前仅 allow）、TeamMember（admin/member/reviewer）、用户 API Key。
- **自定义提炼 prompt**：`memory_prompts`/`memory_prompt_settings` 按 instance→team→agent 三级解析覆盖（`memory-prompt/resolver.ts`），带版本与变更日志。

对照 agentbrain §4：TAM 没有“L1 内容寻址事件 = 唯一语义 SOT、L2 = 确定性投影”的等价物。更具体地说，`writeMemory()` 的 update/merge 顺序是：先删除 VectorStore 旧目标，再 append JSONL，再计算 embedding/upsert 新记录；JSONL append 和新索引写均可 non-fatal 失败。因此它不是一条原子、可回放的 canonical mutation，中间失败可能让旧事实已从检索面消失而新事实尚未完整进入。agentbrain 不应照搬这种 destructive update 顺序。

## 3. 摄取 / 提炼 / 整合 / 更新 / 删除

**触发模型：turn 级，不是会话结束级。**

- OpenClaw 宿主：`auto-capture` hook 每轮写 L0（本地 JSONL + 可选 L0 向量）并通知 pipeline 调度器，"Extraction is NOT triggered here. The pipeline manager decides when"（`MemoryCore/src/core/hooks/auto-capture.ts` 头注释）。
- Proxy 宿主：每轮请求转发后由 `recordTdaiTurn` 写 L0（`MemoryProxy/src/tdai/recorder.ts`），带 pending-writes 重试（`tdai/pending-writes.ts` `withL0Retry`）。值得注意的是**写 L0 前先剥离 harness 噪声**：`user-query-extractor.ts` 只保留 `<user_query>` 正文，避免 `<additional_data>`/`<system_reminder>` 污染记忆（recorder.ts 头注释）；OpenClaw 侧 `CompletedTurn.originalUserMessageCount`（`core/types.ts`）同样用于定位被注入内容污染的 user 消息。
- 调度：standalone 进程内 `MemoryPipelineManager` 默认新会话 warm-up 阈值 `1→2→4→…→5`，稳定后每 5 个 conversation round 触发 L1，或空闲 30 秒触发；L1 完成后默认延迟 90 秒推进 L2，L2 最短间隔 15 分钟、最长 60 分钟；L3 在 L2 后按 persona trigger 判断（`config.ts`、`utils/pipeline-manager.ts`、`persona-trigger.ts`）。service 模式使用队列 worker、锁续租/丢锁 abort 与恢复扫描（`MemoryCore/src/services/pipeline-worker.ts` / `timer-scanner.ts`）。

**L1 提炼管线**（`core/record/l1-extractor.ts` → `l1-dedup.ts` → `l1-writer.ts`）：

1. 读最近消息（背景 + 新增），**单次 LLM 调用**同时做场景分段与记忆抽取（结构化 JSON，"Kenty's prompt"）。
2. `batchDedup`：每条新记忆先做候选召回（向量余弦为主，FTS5 BM25 降级），再一次 LLM 批量裁决 `store|update|merge|skip`（支持多目标合并，`target_ids`）。**三级降级：向量 → FTS → 直接全部 store（跳过去重）**；Jaccard 全文件扫描回退已删除（l1-dedup.ts 头注释）。
3. `writeMemory`：update/merge 先从 VDB 实时删除目标记录再 append 新记录；JSONL 只追加；VDB 双写失败不阻断 JSONL。

**Skill 沉淀**（`core/skill/`，与 chat memory 并行的资产线）：conversation-add 路径按会话缓冲，归档时"**先落 archive 文件再登记 task**"（顺序变更有血泪注释：曾因 COS 写慢于 worker BRPOP 导致 ghost 判定静默丢任务，`skill/conversation-add/trigger-service.ts` 头注释）；Redis 队列 + worker pool + LLM 抽取（带 skill_list/skill_view/skill_manage 工具）、review prompt、版本化（`skill-versioning.ts`）、权限（`skill-permission.ts`）、FTS/vec 检索（`skill-store-ddl.ts`）。

**更新/删除**：v2 HTTP API 提供 `conversation/delete`、`atomic/delete`、`scenario/rm`、`persona/write` 等，均记 `memory_audit`；面板当前只支持查看/删除，L1-L3 可编辑列在 ROADMAP。未发现 **Chat Memory canonical write path** 上类似 agentbrain `staging → review/promotion` 的生命周期；`AssetEntity.confidence` 虽存在，但不是 Chat Memory staging 机制。L1 抽取一般直接进入 dedup 的 `store|update|merge|skip`。

对照 agentbrain §7：TAM 的“每轮 capture + 调度器决定何时提炼”与 agentbrain“快路径入队 + 慢路径 worker”同构但触发粒度不同。TAM 有文本清洗、sandbox、路径校验等分散防线，但在 Chat Memory L1 入库前未发现与 agentbrain 预期的“secrets/path 扫描 + 拒绝并审计”同位置、同等级的完整安全门。

## 4. 检索与排序

- **召回策略**：`keyword`（FTS5 BM25）/ `embedding`（语义相似）/ `hybrid`（两路 RRF 融合，`RRF_K=60`）；TCVDB 可走服务端 native hybrid，SQLite 走客户端并行召回 + RRF。中文 FTS 在 `@node-rs/jieba` 可用时写侧/查侧统一分词；依赖缺失则退回 Unicode regex/原文，中文二字召回质量会明显下降。L1 `priority` 会随结果返回，但当前 Chat Memory RRF merge 不把它作为 ranking boost。
- **预算控制**：`maxCharsPerMemory`/`maxTotalRecallChars` 逐条截断 + 截断标注（"已截断；可用 tdai_memory_search … 查看详情"，auto-recall.ts:840-915）。
- **注入分层（重要演进）**：早期每轮自动召回 L1；现 MemoryProxy 路线改为——L3 persona 全文注入 system prompt（稳定、短）；L2 只注入 **Scene Navigation 索引**（路径 + summary），正文由 LLM 按需调工具读；L0/L1 收敛为**静态按需检索工具**（cache 友好），通过 `<memory-bridge>` 让 LLM 用 Bash curl 只读子路径（`MemoryProxy/src/memory/memory-bridge.ts`，`ALLOWED_SUBPATHS` 白名单仅 search/query/ls/read，写操作一律走主链路且 body 里的身份字段被 session 强制覆盖防伪造）。`MemoryProxy/src/injection/injectors/tdai-profile-memory-injector.ts` 头注释明确动机："大幅降低首轮 token 消耗……让 LLM 按需取文，而不是被无关的场景污染上下文"。
- **工具调用纪律**：注入 memory-tools-guide，提示模型将 `tdai_memory_search` + `tdai_conversation_search` 合计控制在每轮 3 次以内；这是 prompt-level guidance，不是工具执行层硬限额。
- **缓存**：injector 声明 `cacheStrategy: "session_init"`，L2/L3 快照会话级缓存 + prewarm（hookCacheRepo）。
- **没有统一的 LLM 精排层**：Chat Memory 的 L0/L1 search 止于 BM25/向量/RRF（+阈值），裁决交给主 agent；L1 写入去重另有 LLM judgment，但它不是查询 reranker。Skill routing 和 Wiki graph search 又是独立算法。评价时应按资产线分别看，不能把三条路径合成一个“统一检索栈”。

## 5. 作用域 / ACL / 团队 / Agent

- **多维租户隔离**（team/user/agent + 可选 session/task）：v3 router 具备 `team_id + agent_id + user_id` 缺项返回 422 的 strict path，session 可选；读路径 `IsolationFilter` 下推并做召回后复查，dedup 候选也带 filter。但开源 Gateway 的 `V3_STRICT_ISOLATION` **运行默认值是 OFF**（`utils/env-config.ts#resolveV3StrictIsolation`），注释只说 production should enable；router 在未显式传 flag 的直接调用/测试中才默认 true。并且 `assertIsolation()` 本身不读取 `config.enforce`、不会抛错，而是补 `default`。因此这里是“提供了严格模式”，不是“所有默认入口天然强隔离”；生产部署和任何直连 store/helper 的入口都必须单独验证。
- **资产权限**（`metadata/service/permission-checker.ts`）：判定序 `资源存在 → owner 全允许 → 团队成员 → visibility → 角色默认（admin: read/write/assign/share；member: read）→ 显式 ACL → deny`。`private` 语义 2026-07 收紧为**严格私密（连团队 admin 也不可见）**；`restricted` 走 user/team_role/agent 三主体 ACL；`canBindAsset` 单独校验资产能否挂到 agent。
- **data-plane isolation 不等于用户授权**：L0–L3 `/v2`/`/v3` 路径的 auth context 只有 Gateway Bearer + `serviceId`；`team/user/agent` 来自 body/header，strict path 只检查是否存在，不把 `user_id` 绑定到 `x-tdai-user-key`。`chat-memory-handlers.ts` 甚至明确说明内核数据面将该 Bearer 视作管理员级可信凭据，Owner 校验由 Panel backend 在转发前完成。若 `server.apiKey` 未配置，外层校验默认关闭，router 只要求任意非空 Bearer。完整三件套可由 Proxy/Panel 收紧，但 MemoryCore 不能单独被描述为端到端用户级 ACL 数据面。
- **用户可见性**：system_admin 账号对他人默认隐藏，仅 bootstrap 密钥或本人可见（`metadata/service/user-visibility.ts`）。
- **抽象层的 scope 收窄要警惕**：L0/L1 可带 team/user/agent/session/task，但 `buildProfileIsolationScope()` 明确让 L2/L3 只按 `team+agent` 聚合，忽略 user/session/task。这样有利于团队 Agent 跨会话积累“operating doctrine”，也可能把某个用户/任务的私有信息蒸馏进共享 persona/scenario；如果借鉴语义金字塔，必须给每一层写清允许丢弃哪些 scope 维度，并在提升前做隐私/归属校验。
- **Agent loadout**：FixedAssetBinding 将资产以 `direct|summary|tool|reference` 模式和 priority 装配给指定 Agent；Proxy 首轮交互让用户选 team → agent → task，再按绑定加载。控制面模型是完整的，但执行语义仍分散：chat memory 借入路径只取同 team 的绑定并截取最多 2 个来源 Agent，没有统一按 `priority/injection_mode` 编排；Skill/Knowledge 又各走自己的 injector/tool。会话级 `session_init` cache 也意味着资产变化通常要 `mem:sync` 或新会话才反映。可借鉴的是 binding seam，不应照抄当前执行细节。
- **这里的 Agent 不是 subagent runtime。** `MemoryCore/README.md` 明确说明 Agent 只是调用方和受管元数据实体，MemoryCore 不托管、调度或执行 Agent。仓库没有 dispatch/spawn/worktree/父子会话编排；“Agent Team”指多 Agent 身份共享/借入资产，不是 pi/dsh 那种 Commander 派发 Worker。因此它能补我们的 loadout/共享记忆设计，但不能替代子代理模块。

## 6. 宿主集成：协议代理 vs hook

TAM 主推**反向代理**：把 agent 的 LLM base URL 指向 MemoryProxy，"No plugin, hook, or MCP server is required"（README）。实现：

- 双协议 adapter（Anthropic/OpenAI）+ host/profile 识别，按 URL 路径前缀和 wire 特征区分 Claude Code、Codex、CodeBuddy、WorkBuddy、dsh 等客户端。
- **请求分类部分依赖宿主内部 wire 细节和抓包经验**：例如 Claude Code fork/side-query、Codex aux endpoint / `thread_source` / encrypted response id、dsh 首帧元数据消息与 `reasoning_content`。aux 请求（compaction/标题生成）会短路不注入，避免污染，但这类兼容逻辑比正式 hook/plugin contract 更易随宿主升级破裂。
- 另有两条非代理集成线：OpenClaw 插件（hooks：auto-capture/auto-recall + context offload）与 Hermes 插件 v1（自管 Gateway 子进程 + 看门狗）/ v2（外部 Gateway + Python SDK `tdai-memory`，含熔断器）。
- Proxy 同时承担可观测（Opik/Langfuse、ClickHouse）、限流和计费上报。README 所说“按 Agent 配模型降本”的 Cost Guard 只公开了动态桥接层，核心实现来自未开源的可选包 `@context-proxy/cost-guard`；不能把它当成该仓库可直接复用的模型路由实现。

对照 agentbrain §10：两种路线正交。TAM 的 Proxy 路线可以让支持自定义 API base URL 的客户端无需安装记忆插件，但仍需改 endpoint/key、完成 session identity 绑定，部分模式还依赖交互式表单；dsh headless 在无 `ask_user_question` 时会直接 bypass 团队资产。它减少了宿主插件依赖，代价是依赖 wire 细节，宿主升级可能破坏兼容。agentbrain hook/plugin 路线依赖正式生命周期 seam，语义面更窄；未来可把 Proxy 保留为一种 edge，而不是唯一集成层。Codex adapter 对 `memory_consolidation` 等 aux 信号的处理仍是 M0 spike 的有价值情报。

## 7. 部署与依赖

- 一键起三件套：`deploy/global-images/start-all.sh`（自动 init-admin、生成 `sk-mem-` 管理密钥、自检后打印可粘贴的 `claude` 启动命令）；面板 8125、Gateway 8420/3100。
- standalone 运行时依赖仍不少（`MemoryCore/package.json`）：ai-sdk、`sqlite-vec`、`@node-rs/jieba`（中文分词喂 BM25）、js-tiktoken、OTel 全家桶、zod 等；service 模式再加可选 COS/ioredis/kafkajs/mongodb/clickhouse/opik。Node ≥ 22.16。
- 对照 agentbrain §9 "仅用内置模块，无运行时依赖"目标：TAM 的复杂度主要来自服务化（多租户、分布式队列、可观测），不全是记忆机制本身。

## 8. 可重建性 / 可移植性

- **局部可重建**：SQLite 的 embedding/FTS 可从当前 DB 行 reindex，scene index 可从当前 Markdown 重扫。TCVDB 的 `reindexAll()` 当前明确是未实现的占位（server-side embedding 路径直接 skip）；迁移/导出脚本不等价于通用 rebuild contract。
- **整体不可从单一底座重建**：standalone 有 JSONL mirror/fallback，但 service 路径明确可将 TCVDB/COS 作为 authority；L0/L1 可按 retention 清理，update/merge 会从检索库删除旧记录；L2/L3 又由 LLM 直接改文件。即使 generation log 保存输入/输出引用，也无法仅凭一份 immutable SOT 重建当前全系统，更不能保证同输入重放得到相同 persona/scenario。Profile sync 使用 stable id + version/baseline/MD5 的 optimistic sync，但存储后端仍有 eventual-consistency/last-writer-wins 路径，未见与 agentbrain 目标中的 causal merge 等价物。
- **可移植**：L0/L1 JSONL mirror 与 L2/L3 markdown 可读，但数据 authority 依部署模式分散在 SQLite/TCVDB/COS；资产元数据和 SDK/HTTP API 与 Agent 框架解耦。它的“跨框架”主要是同一服务被多种 adapter/proxy 客户端消费，不等于把所有记忆复制成一个自包含纯文本仓。

## 9. 测试与评估（README 宣称 vs 仓库现实，重要缺口）

- **该 commit 的 Git tree 不包含可执行测试套件**：未发现 `*.test.ts`/`*.spec.ts`/`__tests__/`；而 `MemoryCore/package.json` 声明的 `vitest run`、`test:standalone:*` 指向本 tree 不存在的目标。`README.deployment.md` 宣称的 E2E 通过数在本 commit 无法复现。这只说明公开的 `97f9465` 快照缺少对应资产；实际远端 `main` tree 可见 7 个相关测试文件、`feat/server` 可见 21 个，因此不能外推为整个项目或腾讯内部没有测试。
- **该 commit 的 PR CI 不跑测试**：`.github/workflows/pr-ci.yml` 只有 install / npm pack / manifest / 包体积 / skill 队列隔离红线。隔离红线本身值得借鉴，但不足以验证记忆行为。
- **PersonaMem 基准（48%→76%，+59%）**：仓库内无任何评估代码或数据，仅 README 两个表格，不可复现。
- `package.json` 还声明了 `smoke:skill:*`、`test:standalone:*` 等脚本，但本分支对应的 `scripts/smoke-skill/`、`__tests__/standalone/` 等目标也不在 Git tree；不能将 script 名视为可运行证据。

引用 TAM 任何量化结论（基准、E2E 通过率）时应注明"来源宣称、本仓库不可验证"。

## 10. 演进治理

- CHANGELOG（Keep a Changelog + semver）+ ROADMAP（v2.0.1：agent 模板、`mem:` 会话命令扩展、L1-L3 可编辑、L0/L1 面板搜索、Cursor 支持）。
- 版本号口径不一：README 说 "Current release is v2.0.0"，CHANGELOG 已到 2.0.1-beta.1，package.json 是 2.0.0-beta.1。
- 代码注释大量引用**内部设计文档**（`docs/design/2026-07-30-cc-request-routing-plan.md`、`docs/design/2026-06-16-skill-extract-queue.md`、`docs/l0l3-tenant-isolation-design.md`、`08-metadata-migration-and-permission-design.md` 等），但这些文档**均不在仓库**——设计治理内网化，开源侧只有 CHANGELOG 粒度。注释里的决策记录（如 private 语义收紧、skill 归档顺序变更史、CR-2 guard）质量很高，是本调研最有价值的信息源之一。
- git 历史为浅克隆单提交，无法考察演进过程。

## 11. README 宣称 vs 实现核对表

| 宣称（README/INSTALL/CHANGELOG） | 实现状态 | 证据 |
|---|---|---|
| 一键部署完整服务组合 | ✅ | `deploy/global-images/start-all.sh` + verify.sh |
| 多类客户端经 Proxy/插件接入 | ✅（但 dsh headless 会因无交互表单能力而 bypass 团队资产；部分识别依赖 wire 细节） | `MemoryProxy/src/**`、`MemoryCore/{hermes,openclaw}-plugin/` |
| L0→L1→L2→L3 分层管线 | ✅ | `core/{conversation,record,scene,persona}` |
| LLM 提取 + 去重（update/merge/skip） | ✅ | `l1-extractor.ts`/`l1-dedup.ts`/`l1-writer.ts` |
| BM25 + 向量 + RRF hybrid | ✅ | `auto-recall.ts`、`search-utils.ts`（RRF_K=60） |
| 注入预算控制（条数/字符/超时） | ✅（字符预算实证；条数/超时为配置项） | auto-recall.ts:840-915 |
| 四类资产 + Owner/版本/状态/可见性/ACL/绑定 | ✅ | `metadata/types.ts`、`permission-checker.ts`、FixedAssetBinding |
| Skill 提取/版本/审核 | ✅；导出能力由 CHANGELOG 宣称 | `core/skill/**`、CHANGELOG |
| Wiki + CodeGraph 异步构建 | ✅ | `MemoryKnowledge/src/engines/**`（CodeGraph 基于 colbymchenry/codegraph） |
| PersonaMem +59% | ⚠️ 在该 commit 不可验证 | 未公开对应评估代码/数据 |
| E2E 16/16、23/23 | ⚠️ 在该 commit 不可复现 | 对应测试资产不在 Git tree；该 commit CI 不跑测试 |
| "私有仓/SSH CodeGraph 仍在完善" | 自认局限 | README Notes |
| "fully automated memory routing 仍迭代中"（资产绑定目前手动） | 自认局限 | README Notes |

## 12. 执行对比：TAM vs agentbrain

本表的“agentbrain 设计”列以**当前已定稿但未实现的 v1.2 文档**为准；前一轮讨论中的“host-neutral kernel + pi-first + dsh-later”仍只是候选修订方向，尚未写入设计 SOT、也未获实现授权。涉及宿主策略时，评注会单独标出该候选方向。

| 维度 | TencentDB Agent Memory | agentbrain 当前设计 v1.2 | 评注 |
|---|---|---|---|
| 形态 | 中心服务（Gateway + Proxy + Panel）+ 多部署形态 | 单机本地 `~/.agentbrain/` git 仓 + CLI | TAM 是 agentbrain 附录 A.6 中心 memory service 方向的**完整服务化工程样本**，展示了 Redis/TCVDB/COS/锁/恢复等复杂度；不据此声称其生产成熟度 |
| 语义 SOT | authority 随部署模式分布在 SQLite/TCVDB/COS，另有 JSONL mirror/fallback 与 best-effort generation log；update/merge 破坏性更新当前检索状态 | L1 内容寻址事件唯一 SOT，L2 确定性投影 | 根本分歧；TAM 能追踪部分生成来源，但不能从 canonical evidence 回放纠错 |
| 数据格式 | SQLite/TCVDB/COS 为主要运行存储，另有 JSONL/Markdown 可读层 | 一事件一 JSON + Markdown 投影 + `.state/index.sqlite` | 两者都保留人可读产物；agentbrain 将纯文本证据提升为 canonical，TAM 更偏服务数据库 |
| 触发 | 每轮 capture + 调度器（N 轮/idle/interval）+ 会话归档（skill） | Stop hook / notify turn-ended + detached worker | 两者都做到"结构性触发"；TAM 粒度更细，token 成本控制靠调度参数 |
| 提炼 | 单 LLM 调用（分段+抽取）+ 单 LLM 批量 dedup | 单 LLM 提炼 prompt + 写前安全门 + staging 低置信区 | TAM Chat Memory path 未见等价 staging，安全防线分散；agentbrain 计划把两者做成显式合同 |
| 更新/纠错 | dedup 裁决 update/merge；面板删除；可编辑在 roadmap；`correct` 类显式纠错命令无 | append correct 事件重投影；`agentbrain correct` | TAM 缺 agentbrain 的"自然纠错为一等信号"设计 |
| 读路径分层 | L3 全文注入 + L2 索引注入 + L0/L1 按需工具（Proxy 当前路径）；字符预算 + prompt 建议 3 次检索 | 硬层选择性注入（≤4KB）+ 知识层按需检索 | **高度同构**，TAM 从每轮 L1 自动召回转向按需工具，反向验证 agentbrain §6 的 push/pull 分层 |
| 检索栈 | FTS5 BM25 / 向量 / hybrid RRF；dedup 候选召回三级降级 | Tier0 FTS → Tier1 dense hybrid → Tier2 LLM 精排，显式分级降级 | TAM 无 Tier2 精排；其三级降级（向量→FTS→跳过）与 agentbrain 降级哲学一致但更激进（跳过即不去重） |
| 项目绑定 | 无对应物（task 维度近似但语义不同） | `.agentbrain.json` 两件套 + staging `_unbound` 认领 | TAM 的"记忆属于 team/agent/task"与 agentbrain"记忆属于项目"是两种归因模型 |
| 多租户/ACL | metadata plane 有用户 ACL；memory data plane 主要是管理员级 Bearer + caller-supplied isolation，strict 默认 off；完整安全依赖 Proxy/Panel + 部署配置 | v1 单用户，明确不做团队 ACL | TAM 证明 isolation、authorization、loadout 必须分层建模，不能用 scope 字段冒充权限 |
| 多 Agent | Agent 是身份/资产 loadout；可借入其他 Agent 的 chat memory（最多 2 个），不执行/调度 Agent | 目标还包含 Commander/Worker 子代理协作 | 可借鉴 loadout 与共享边界，不能替代 dispatch/subagent seam |
| 宿主集成 | LLM API 反向代理 + 插件双线；部分客户端兼容依赖 wire 逆向 | 原设计是 hook + marker 块；新方向是 pi/dsh 薄适配器 | Proxy 是第三种可选 edge，但不应成为唯一权威集成层 |
| 依赖 | 大量运行时依赖 + 外部服务（service 模式） | 零运行时依赖（node:sqlite） | 形态决定 |
| 可重建 | FTS/向量/scene index 局部可重建；全系统无单一重放底座，纠错不可回放 | L1 全量可重投影，L3 可重建 | agentbrain 纪律更强 |
| 测试/评估 | 该 commit 未公开可执行测试资产，PR CI 不跑行为测试，基准不可复现 | 设计要求每里程碑用户可验收（M0-M4） | 只能评价当前公开快照；引用 TAM 数字需谨慎 |
| 治理 | CHANGELOG/ROADMAP；设计文档内网不外发 | 设计文档 + 修订记录入库，Design Gate | — |

## 13. 可行动启示（仅为调研结论，**不构成已授权的实现变更**）

1. **分层读取被独立验证**：TAM 从"每轮自动召回 L1"演进到"L3 push 全文 + L2 push 索引 + L0/L1 pull 工具 + 每轮 3 次调用上限 + 截断必须标注"（memory-bridge.ts / tdai-profile-memory-injector.ts 头注释写明动机是 token 与上下文污染）。agentbrain §6 的预算注入与按需检索设计与此互证；"工具调用次数上限写进注入文案"与"截断处提示等价手动命令"两个运营细节可直接吸收进 §6/§9 的 `context`/`search` 输出规范。
2. **降级语义互证**：TAM dedup 的向量→FTS→跳过三级降级、recall 的 H-15 结构化失败信号（`RecallResult.error/partial`）与 agentbrain §6.1 "降级永远可见，不静默" 同哲学；其"部分成功"标志位是 agentbrain 输出卡片可借鉴的小设计。
3. **M0 spike 的免费情报**：`MemoryProxy/src/agent-adapters/codex.ts` 逆向整理了 Codex 客户端的 aux 请求信号（`/responses/compact`、`/memories/trace_summarize`、`x-openai-memgen-request` 头、`thread_source=memory_consolidation`）——说明 Codex 自带记忆整编后台请求，且其 rollout/compaction 请求形态已被同行逆向过一遍，M0 验证 Codex transcript 格式时可对照。
4. **写前去噪是实战教训**：TAM 在写 L0 前剥离 `<system_reminder>`/`<additional_data>` 等 harness 噪声（user-query-extractor.ts），并处理注入内容对 user 消息的污染（originalUserMessageCount）。agentbrain §7 的 transcript 规范化（`TranscriptEntry[]`）应把"harness 元数据剥离 + 自身注入内容剥离"列为 adapter 职责——这点设计文档目前未显式覆盖。
5. **durable intake 应按 turn 捕获、语义 consolidation 可按 session/batch**：TAM 每轮先原子推进 capture cursor，再让 N-turn/idle scheduler 批量提炼，优于只依赖 Stop/进程正常结束。若 agentbrain 宿主能提供稳定 turn-end，应评估每轮只追加轻量 intake、session-end 只做 flush；前提是有稳定 `turn_id`、幂等去重和明确的 compaction/subagent 边界。原始对话仍只是 intake，不升级成长期记忆 SOT。
6. **生成 provenance 值得吸收，但不能降格 SOT**：TAM 的 generation log 把 input/output refs、prompt 版本/hash、model 和作用域连起来，比 agentbrain 当前只在 L1 event 留 `source_quote` 更完整。我们可在 L1 event producer metadata 中加入 `prompt_hash/input_hash/model/adapter`，但应作为 canonical event 的一部分写成功后才发布 L2，而不是 best-effort 旁路日志。
7. **多路径 authority 是反面教材**：TAM 的 JSONL/SQLite/TCVDB/COS 角色随部署与调用路径变化，再靠 cleaner/迁移/profile sync 维持，是 agentbrain 坚持单一 SOT + 派生物可重建的活体论据。
8. **Agent loadout 是明确的新设计输入**：TAM 证明“不同 Agent 不该默认读取同一整脑”，Fixed Binding + visibility + injection mode + priority 比单纯 scope filter 更贴近子代理团队。agentbrain 不需要 v1 上完整 ACL，但候选 host-neutral kernel 至少应评估 entry/asset 的 `audience` 或 binding seam，让 pi/dsh adapter 能给 Commander、Coder、Reviewer 不同读面。
9. **中心化形态的成本标尺**：TAM 展示了中心服务方向落地所需的队列、锁、恢复、权限和控制面。在当前“单用户、先验证 pi 日用闭环”的约束下，agentbrain 候选修订方向应保持 kernel-first / pi-first，不提前复制 Hub；若目标改为短期多人共享，这个判断需要重开设计决策。
10. **检索实现应实验而不是信仰**：TAM 用 jieba 写侧/查侧分词 + BM25/向量 RRF，没有独立 LLM reranker，也形成可用闭环。这给 agentbrain 三个待验证选择：Tier0 用 deterministic CJK n-gram 还是引入 `@node-rs/jieba`；Tier1 用 RRF 还是现设计的 ordered hybrid；Tier2 rerank 是否只有在固定检索集显著提升 recall/nDCG/任务成功率时才启用。不要把 Tier2 当“功能完整”的默认条件。
11. **记忆产品类型应与存储层级解耦**：TAM 把 Chat Memory、Skill、Wiki、CodeGraph 分成独立资产线是对的。agentbrain 可以保留统一 evidence substrate，但不要把可执行 Skill、文档知识和代码图谱硬塞进同一种 `knowledge` entry；它们应通过独立 projection/tool 或未来插件扩展。
12. **引用纪律**：TAM README 的 PersonaMem 数字与 E2E 通过率在该公开 commit 不可复现；后续引用必须标注“来源宣称、当前快照未验证”。
13. **scope 与 authorization 分开**：TAM 证明了 team/user/agent/session/task 这些数据维度很有用，也暴露了把它们当授权边界的危险。agentbrain v1 虽是单用户，也应在接口命名上区分 `scope filter`、`audience binding` 与真正 `permission`，避免未来服务化时从错误抽象迁移。
14. **scope 不得在语义合成中悄悄丢失**：TAM L2/L3 从 user/session/task 收敛到 team+agent 是一个明确产品取舍。agentbrain 若未来增加 Atom→Scenario→Profile，应把它建模为单独的 **semantic consolidation/curation stage**，先追加带来源与 scope-lift 决策的新 evidence event，再由 deterministic projector 渲染；隐私/归属校验不能只靠 prompt。
15. **反例确认写入纪律的差异化价值**：无 staging、无写前秘密扫描、纠错不可回放、L2/L3 由 LLM 直写——TAM 为服务化产品接受这些取舍，恰好说明 agentbrain 的 append-only evidence + deterministic projection + doctor 不是多余抽象。

## 修订记录

- 2026-10-15 增补（2026-10-22 落文并复核）：固定 `feat/server_team` 的 `37b1629`，比原快照多 46 个提交。记录四条机制借鉴与 Skill / SOP 出范围决定，对应总体设计 §8.8、§9.6、§8.9、§11.8，均为 CANDIDATE。一步式已有版本记录，场景目录已评测搁置，补缺口而不重新授权。此前各节仍是 8 月快照的历史结论，不外推到新提交。
- 2026-08-20 v1.1：复核修订。区分内容抽象层与 authority 层；补 generation provenance、Agent 非 runtime、loadout 执行边界、scope lift 风险、v3 strict 默认关闭、分支测试资产差异；收紧对 SOT、生产成熟度和“零改造”的表述。
- 2026-08-20 v1：初稿。基于 commit `97f9465`（feat/server_team）只读调研；README 宣称与实现差异、当前 commit 测试资产情况已逐项核对。

## 14. 2026-10-15 增补

本次复核 `TencentCloud/TencentDB-Agent-Memory` 的 `feat/server_team` 提交 `37b1629`。相对原调研 `97f9465` 多 46 个提交，[GitHub 比较页](https://github.com/TencentCloud/TencentDB-Agent-Memory/compare/97f9465...37b1629) 显示 `Commits 46`。2026-10-22 按固定提交读取以下源码，不追随今天的分支头。它们是 feature branch 的机制证据，不证明已发布或效果更好。本次没有重新运行腾讯项目或复核其全部测试。

派活单的四条借鉴实际只引用了三个不同文件，版本和关系两条都来自 `jev-gate.ts`。为核实实时与历史的差异，另读普通版 `skill-review-prompt.ts`，以下明确列为第四个对照文件，不将其冒称为原单独立引用。

| 固定提交下的文件 | 核实内容 | agentbrain 的取舍 |
|---|---|---|
| [`MemoryCore/src/core/persona/jev-gate.ts:15-19`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/37b1629/MemoryCore/src/core/persona/jev-gate.ts#L15-L19) | `JEV_PROMPT_VERSION` 是手写字符串 `l3-memory-change-v1`。`JEV_INSTRUCTIONS` 区分 boundary_change，并说明已经同步的新结论不能因历史叙述被判冲突 | §8.8 为三类模型产出的 L1 事件补版本，采用系统提示词全文 SHA-256 前 12 位，不照搬手工版本。§9.6 两层共用关系集合，范围变化只记关系与待确认标记；已同步历史判 duplicate 或 refines。不借腾讯的 Persona 触发优先级改写旧记忆 |
| [`MemoryCore/src/core/skill/prompts/skill-review-prompt-strict.ts:4-24`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/37b1629/MemoryCore/src/core/skill/prompts/skill-review-prompt-strict.ts#L4-L24) | 头注释把严格版用于冷启动、批量历史导入，称宽松版会产生大量低价值 Skill，严格版采用 `When in doubt, silence` | §8.9 只对 via=backfill 收紧；scan 是近期漏登记，不收紧。只收用户原话支撑的 rule/decision，不搬 Skill 分类、可执行能力门或 72 分评分标准 |
| [`MemoryCore/src/core/skill/prompts/skill-review-prompt.ts:4-35`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/37b1629/MemoryCore/src/core/skill/prompts/skill-review-prompt.ts#L4-L35) | 普通版 v2 明写优先 capture，接受 SOP、Background、Preference，并去掉严格评分门。这是严格版注释所指的对照 | 只借按输入来源区分标准的理由，不声称腾讯做过 agentbrain 的 backfill/scan 评测。其注释里的 18/39 数字未在本次复现，不作为本项目收益证据 |
| [`MemoryCore/src/core/prompts/scene-extraction.ts:55-65`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/37b1629/MemoryCore/src/core/prompts/scene-extraction.ts#L55-L65)、`:120-123`、`:175-186`、`:560-561` | 场景摘要目录供模型读取；场景正文要求连贯叙事、推断隐性信号，满额时合并删除，并累计 heat | §11.8 只借"目录在前、原条目按需打开"。场景只存标题与成员 id，放 L3 index.db，不写 L1、不成为 canonical writer。不生成叙事、隐性信号，不合并删除原记忆，不重复造热度计数 |

四条均先写设计，状态 CANDIDATE。用户审过并说"开始实现"后，才另行实施。当前设计与代码核对后需要保留以下差异：

- 第 1 条已在 §8.6 覆盖一步式 `prompt_version`，本次补其他路径与 `ab get`。当前 hash 还包含 user 消息里的 worker note（`src/topic.ts:61`、`src/onepass.ts:52-59`），与拟议的 system 全文口径不同。旧版本保留，不回填。
- 第 2 条不能再假定 refines 条目不进后台第 2 层。当前选择条件没有检查 `unreconciled`，但排除话题条目（`src/work.ts:1028-1037`）。新规则必须分别覆盖当时启用的抽取提示词与后台关系提示词，不改变一步式 merge 只进报告的决定。
- 第 3 条不能只追加提示词。一步式当前没有引文与 basis，写库时记 agent_inference（`src/work.ts:1000-1003`）。严格路径要先能提供并校验用户原话，不能伪造依据。§8.7 普通版提高召回的已批准修改保持不变。
- 第 4 条已做过 [场景模拟](../eval/09-scene-simulation.md) 与 [场景目录评测](../eval/10-scene-directory-session-start.md)。目录不如一次搜索，PR #56 搁置。本次仅补可审阅合同与概览任务验收，不因引用腾讯就重开实现。

用户另定可复用做法（Skill / SOP）不归 agentbrain 管。总体设计 §5.5 删除 Procedure View，§20 加范围排除；§4 workflows 的 LOCKED 旧条文保持原样，冲突待用户裁决。记忆中的用户规则仍可保留，但不把它加工成可执行流程。标题目录不改变原始证据，现有无引文条目也不能因此被称作有用户原话支持。

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
- **L3**：`.state/index.sqlite`（`node:sqlite` 内置，零外部依赖，借 `adr0039-l3.ts` 的建表边界）承载 FTS 候选召回；完全可重建，不入 git。

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
- `search` 返回：候选条目卡片（path / kind / title / status / confidence / 命中摘要），由 sqlite FTS(BM25) + trigger_phrases + 文件名匹配产生；**最终判断留给宿主 LLM**（读命中文件、决定采信哪条）——这是对 abrain LLM 精排的务实降级，换来零独立模型依赖。
- embedding 召回留接口不实现（v2，见 §13）。

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
- **M4**：`api` adapter、`import-pensieve`、git auto-push。

## 13. 风险与未验证项

| 项 | 状态 | 处置 |
|---|---|---|
| Codex notify/rollout 格式、hook 是否携带足够 transcript 信息 | **未验证** | M0 spike，最高优先 |
| Claude Stop hook 在 compaction / subagent / `claude -p` 场景的触发语义 | 未验证 | M0 spike 一并测；worker 环境变量守卫兜底 |
| token 成本（每轮触发） | 已知风险 | 廉价门槛 + 队列合并 + 便宜模型 + 每日预算熔断（config） |
| headless 子进程权限 | 已知风险 | `--allowedTools` 白名单限制只写 `~/.agentbrain/**` |
| 多机 git 冲突 | v1 不处理 | L1 内容寻址天然不相交；L2 冲突=丢弃重投影（借 ADR 0039 §4.4），M4 之后再验 |
| embedding 召回缺失导致 search 召回面窄 | 接受 | FTS + trigger_phrases 起步，v2 评估 embedding（届时复用 `api` adapter 凭证） |

## 14. 修订记录

- 2026-08-04 v1：初稿。三项用户拍板（仓名/中心 SOT/headless 为主 + api 入口）；分层读取模型定稿；M0-M4 里程碑。

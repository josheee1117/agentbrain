# 宿主接线（切片 2 每轮召回 + 切片 3 自动沉淀）

本目录只放样例，不改任何全局配置。装到用户机器上之前要先得到用户同意，改之前先备份。


四个宿主在用户每次发 prompt 时调用 `ab recall --hook`。它从 stdin 读宿主给的 JSON（只用 `prompt` 和 `cwd`），命中当前项目的坑、规则、决定或标了 for_workers 的全局记忆时，输出一行：

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<agentbrain-recall>…</agentbrain-recall>"}}
```

没有命中、prompt 太短、以 `/` 开头或出任何错时，什么都不输出，退出码为 0，宿主这一轮照常进行。最多 3 条、600 字符，embedding 超时 3 秒，都是代码常量。

前提：Node ≥ 24（要用 `node:sqlite`）。

样例里写的是通用命令 `ab recall --hook`。宿主（尤其从 GUI 启动的）跑 hook 时的 PATH 可能找不到 `ab`，或者 `#!/usr/bin/env node` 解析到低于 24 的 node，这时 `ab` 直接报错退出、召回静默失效。所以实际安装时建议写成绝对路径，例如本机装的是：

```sh
/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab recall --hook
```

超时 5 秒。本目录只放样例，不改任何全局配置。

## 切片 3：会话登记与 `ab work`

切片 3 在每个宿主上加两类事件，外加一个定时任务：

| 宿主 | 登记（每轮，毫秒级，不读 transcript） | 会话结束（只用来加快处理） |
|---|---|---|
| Claude Code | `UserPromptSubmit`：`ab capture --hook --host claude` | `SessionEnd`：同一条命令，拉起分离的 `ab work --session` |
| Codex | `UserPromptSubmit`：`ab capture --hook --host codex` | `SessionEnd`：同上 |
| Pi | 扩展的 `before_agent_start` | 扩展的 `session_shutdown` |
| 定时 | launchd 每 30 分钟 `ab work --sweep` | |

`ab capture --hook` 从 stdin 读宿主给的 `session_id`、`transcript_path`、`cwd`、`hook_event_name`，只把这几个坐标写进 `~/.agentbrain/store.db`，不输出、不报错，退出码总是 0。transcript 路径必须在该宿主自己的会话目录下（`~/.claude/projects`、`~/.codex/sessions`、`~/.pi/agent/sessions`），否则不登记，防止借它把任意文件送出本机。2026-10-12 在 Linux box 上测 30 次，单次耗时（含 Node 启动）p50 120 ms、最大 155 ms。

`ab work --sweep` 做四件事：处理静置 30 分钟或已结束的会话；扫描三宿主近 7 天的会话目录，补登记 hook 没生效的会话（只补 cwd 在已登记项目里的）；按仓库代码核验未确认的坑和事实；归档 90 天未确认的自动沉淀。hook 拉起的分离进程即使被宿主杀掉，定时任务也会接上（租约 10 分钟过期后可被接管）。

### 前提

- `~/.agentbrain/extract.json`：抽取与代码核验用的模型。用户 2026-10-12 选定 DashScope `qwen-plus`，不写 `baseUrl`，地址与 key 沿用 `embedding.json` 和钥匙串 `agentbrain-embedding`：

  ```json
  {"model": "qwen-plus"}
  ```

  将来要换到别的 OpenAI 兼容地址时才写 `baseUrl`，这时 key 从钥匙串 service `agentbrain-extract` 读（3 秒超时，不读环境变量、不进文件）：

  ```sh
  security add-generic-password -U -s agentbrain-extract -a "$USER" -w
  ```

  （`-w` 不带值时 `security` 会交互提示输入，key 不进 shell 历史。）不写 `baseUrl` 时沿用 `embedding.json` 的地址和 `agentbrain-embedding` 的 key。没有这个文件、缺 key 时窗口延后，`ab doctor` 的"抽取模型"一行会写明原因和当前用的地址与钥匙串 service。

  注意：agentrouter.org 拦截非官方客户端（2026-10-12 用户用真实 key 实测 401 `unauthorized client detected`），不能作为 `baseUrl`；`ab work` 不伪装客户端。

### 用户机器上要改的地方（本机绝对路径）

命令统一写成 `/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab …`，理由见上文 PATH 一节。

1. `~/.claude/settings.json`：在现有 `UserPromptSubmit` 的 hooks 数组里追加一项，并新增 `SessionEnd`：

   ```json
   {"type": "command", "command": "/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab capture --hook --host claude", "timeout": 5}
   ```

   ```json
   "SessionEnd": [{"hooks": [{"type": "command", "command": "/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab capture --hook --host claude", "timeout": 1}]}]
   ```

   Claude Code 的所有 SessionEnd hook 共享 1.5 秒预算，这条命令只登记并拉起分离进程，不等抽取。

2. `~/.codex/hooks.json`：同样追加 `--host codex` 的两条，`SessionEnd` 超时写 3（Codex 默认 1 秒，最多 3 秒）。改完在 Codex 的 `/hooks` 里**重新信任**这两条，不信任会被跳过（扫描兜底会补登记，但会晚到 30 分钟以上）。

   - 依据：<https://developers.openai.com/codex/hooks>（2026-10-12 读）。`SessionEnd` 在正常关闭、归档或删除仍打开的会话、空闲 30 分钟且没有客户端打开时触发；不对子代理触发；总是同步执行，输出不影响 Codex；stdin 带 `session_id`、`transcript_path`、`cwd`、`reason`。

3. Pi：`~/.pi/agent/extensions/agentbrain-recall.ts` 已经链接到本仓的 `pi/agentbrain-recall.ts`，`git pull` 后自动带上 `session_shutdown`。扩展优先用上面的绝对路径，找不到才退回 PATH 上的 `ab`。`getSessionFile()` 为空的会话（子代理）按 ephemeral 登记、不抽取（§9.5）。`getSessionId` 没有时 `ab` 从文件名 `<时间>_<id>.jsonl` 取 id。这两个 API 的形状按 pi.dev 文档写，本机未实测。

4. launchd：

   ```sh
   cp launchd/com.agentbrain.work.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentbrain.work.plist
   ```

   日志在 `~/.agentbrain/work.log`。每次 sweep 先处理 hook 登记的会话，扫描/补登记来的历史会话每次最多 10 个窗口；日预算 60 次调用里留 12 次给代码核验。要重跑某个会话：`ab work --session <host>:<id> --redo`（已入库的同一候选不会重复）。撤掉：`launchctl bootout gui/$(id -u)/com.agentbrain.work` 并删掉 plist。读钥匙串若弹出授权框，选"始终允许"；`security` 调用有 3 秒超时，钥匙串锁着时本次窗口延后，不会卡住。

### 装完后的验收

- 在已登记仓库里开一个新会话，发一句"以后……"之类面向以后的要求，正常结束会话。几秒后 `ab doctor` 里"窗口: 完成"加 1，`ab search` 能看到 `[未确认·自动沉淀]` 的条目。
- 不正常结束的会话（直接关终端）30 分钟后由 launchd 处理。
- `ab doctor` 里"近 7 天靠扫描补登记"大于 0，说明某个宿主的 hook 没生效（多半是 Codex 未信任）。

## Claude Code

把 `claude-code/settings.example.json` 里的 `hooks.UserPromptSubmit` 合并进 `~/.claude/settings.json`。不要整文件覆盖，已有的 hooks 要保留。

- 格式依据：<https://code.claude.com/docs/en/hooks>（2026-10-10 读）。`UserPromptSubmit` 不支持 matcher；JSON 输出里的 `hookSpecificOutput.additionalContext` 会作为 system reminder 放在 prompt 旁边。
- 这个事件的命令默认超时 30 秒，样例设为 5 秒。超时时输出被丢弃，prompt 照常发出。
- 用 shell 形式（`"command": "ab recall --hook"`），和 Codex 样例是同一条命令。
- 2026-10-12 在用户机器上实测：hook 执行并输出了召回块；模型那一轮被网关返回 400 拒绝，模型是否收到召回尚待复验。
- 验证：`claude --debug` 启动，在已登记仓库里发一句含已知坑关键词的话，debug 日志里能看到这个 hook 的输出。

## Codex

把 `codex/hooks.example.json` 的内容合并进 `~/.codex/hooks.json`（没有这个文件就直接复制）。然后在 Codex 里打开 `/hooks`，审阅并信任这条 hook。Codex 按 hook 定义的哈希记录信任，没信任的 hook 会被跳过；以后改了命令要重新信任。

- 格式依据：<https://developers.openai.com/codex/hooks>（2026-10-10 读）。文档写明 `UserPromptSubmit` 接受 `hookSpecificOutput.additionalContext`，作为额外的 developer context 加入；纯文本 stdout 也会被加入。hooks 默认开启（`config.toml` 的 `[features].hooks`）。
- 2026-10-12 在用户机器上实测：模型收到并引用了注入的召回（§15.3）。日常会话仍需先在 `/hooks` 里信任这条 hook。已知社区反馈：这段 context 以 developer 消息的形式出现在用户 prompt 之后，而且可能在 transcript 里可见（openai/codex#16933、#40680）。
- 超时单位是秒，样例设为 5 秒。

## Pi

Pi 用 `pi/agentbrain-recall.ts`，在 `before_agent_start` 调 `ab recall --hook`，把 `additionalContext` 作为隐藏消息注入。把这个文件链接进 `~/.pi/agent/extensions/`：

```sh
ln -s "$PWD/pi/agentbrain-recall.ts" ~/.pi/agent/extensions/agentbrain-recall.ts
```

- 2026-10-12 在用户机器上实测：单文件扩展能被加载，模型收到并引用了注入的召回。扩展里调用的是 PATH 上的 `ab`，同样受上面 PATH/Node 版本的影响。

## opencode v2

本机验证版本是 `opencode v2.0.30`。插件是 `opencode/agentbrain-v2.js`，默认导出带 `id` 和 `setup` 的对象。旧 `@opencode-ai/plugin` 的 `chat.message` 类型声明不适用于这个版本。

在仓库根安装。先备份现有配置，不覆盖其他插件：

```sh
mkdir -p ~/.config/opencode/backups/agentbrain-20261020
cp -p ~/.config/opencode/opencode.json ~/.config/opencode/backups/agentbrain-20261020/
cp -p ~/.config/opencode/opencode.jsonc ~/.config/opencode/backups/agentbrain-20261020/
ln -s "$PWD/integrations/opencode/agentbrain-v2.js" ~/.config/opencode/plugins/agentbrain-v2.js
```

重新启动 opencode。若后台服务曾加载旧版同名插件，本机实测 `opencode reload` 未清除旧模块，需在新进程中加载。可用 `opencode --standalone` 验证，不停止其他会话的共享服务。

- `ctx.session.hook("context")` 在模型请求前调用召回，追加本轮系统上下文。同一用户消息的工具循环不重复调用，新一轮重新召回。命令优先用 `/opt/homebrew/bin/node /Users/hejiayuan/.local/bin/ab`，不存在才退回 PATH。调用超时 5 秒，任何失败静默放行。
- capture 只接受 `opencode://session/<id>`。`ab` 从固定的 `~/.local/share/opencode/opencode.db` 只读查询 `session_v2`、`session_message`。不存在的 session、不同 session 的引用、任意文件路径都拒绝。项目以数据库中的 directory 为准。来源展开用 `ab get --expand`。
- `parent_id` 非空的会话按 ephemeral 登记，不抽取。sweep 只补近 7 天、已登记项目的主会话。读取不包含 synthetic、reasoning 和压缩摘要。静置时钟取会话 time_updated，不取数据库文件 mtime。
- 插件销毁或 session 归档时登记结束，拉起现有 `ab work --session`。直接杀进程时仍靠手动或已有定时 `ab work --sweep`。本次不启用 launchd，也不打开话题开关。opencode 使用现有 API 抽取器，不借其他宿主的 CLI 额度。
- `ab doctor` 的 opencode 行检查插件路径和 SQLite 读取。它不证明当前已启动的后台服务成功加载了插件，模型回答和 store 登记才是端到端证据。本机默认共享后台服务仍缓存安装中第一次失败的模块，`opencode reload` 和更换链接名没有解决。不能据 doctor 显示正常就当成共享服务接线通过。当前真实通过的是新起的 `opencode --standalone`。重启共享服务需要先处理其中的其他活动会话，本次未重启。

2026-10-20 最终安装项的真实验收在 Herdr 新 tab 中运行 `opencode --standalone`。会话 `ses_ea7463e1dffetnDViut8I7eJLc` 的助手消息 `msg_158b9c245001EhW5HTgFbbQxKr` 输出了包含 `[873b78e2]` 的 `<agentbrain-recall>` 块。`capture_sessions` 登记 host=opencode、project=agentbrain、via=hook。退出后后台完成一个窗口，处理了 2 轮、84 字，6245 token，零候选、无错误，处理进度到该助手消息的 `:1` 文本。测试 tab 已关闭。

## 每轮召回装完后的验收（设计 §15.3）

在三个宿主里各做一次：在已登记仓库里 `ab remember --confirmed --kind pitfall …` 记一个坑，开新会话，发一句和这个坑相关的话，确认模型收到了 `<agentbrain-recall>` 块。某个宿主做不到时记为该宿主的显式降级，不算通过。

## v3 第 2 阶段：审稿团 `ab curate` 与上手向导 `ab setup`

- `ab setup` 一步步问快模型、按宿主的审稿人（默认 Claude Haiku 5.5 max、Codex gpt-6-astra max、Pi 默认模型，也可选经 cpa 的 astra）主审稿配置（默认 1 家主审；panel 模式建议 3 家不同厂商加仲裁）、每个模型的 key（经 `security -i` 的 stdin 写进钥匙串，配置只记条目名）、接哪些宿主（写之前先备份并给出 diff，确认后才写），最后做连通测试。`--only fast,reviewers,panel,keys,hosts,test` 只重做其中几步。
- 配置 `~/.agentbrain/review.json`，样例见 `review.example.json`。
  - **审稿成员两种后端**：`type: "cli"`（默认样例，2026-10-15 用户认可）用宿主自己的命令行无头跑，用宿主自己的账号额度，不用 key：
    - Claude Code：`claude -p --model haiku --effort max`（haiku = claude-haiku-5-5），关工具、不读设置源（hook 不跑）、不存会话；
    - Codex：`codex exec -m gpt-6-astra -c model_reasoning_effort=max --ephemeral -s read-only --disable hooks`（gpt-6-astra 是 codex 模型目录里的第二档）；
    - Pi：`pi -p --no-session --no-tools --no-extensions`，`model` 写 `provider/id`（不写用 Pi 的默认模型），`effort` 走 `--thinking`。
    - 审稿子进程带 `AGENTBRAIN_REVIEWER=1`，`ab capture/recall --hook` 看到就什么都不做，审稿会话不会被登记、抽取或再触发审稿；在空临时目录里跑。
    - `type: "api"`（不写 type 时的默认）照旧直接调 OpenAI 兼容接口，例如经 cpa 的 gpt-6-astra：`{"name":"astra","baseUrl":"http://127.0.0.1:8317/v1","model":"gpt-6-astra","keyService":"codex-cpa-local-api-key","extraBody":{"reasoning_effort":"medium"}}`。
  - `hostReviewers`：每个宿主一个审稿人。`ab curate --host claude` 只审从 Claude Code 会话抽出来的候选，用这个宿主配的审稿人当唯一主审。没配的宿主、手动 `ab curate`、不属于任何宿主的候选走主配置（`mode`/`panel`）。
  - 会话结束自动审稿和多审稿人认领/租约**暂不做**（2026-10-15 用户定）：目标设计改为话题结束时一个后台子模型一次决定新记/并入/不记（见 `src/onepass.ts`），staging 只留作审计和撤销。审稿要几分钟，审完按此刻的库重新规划，期间被用户确认或归档的条目跳过。
  - `mode` 有两种：
    - `primary`（默认）：只有 `primary` 一位主审定结论。panel 里可以另加成员当参考意见（先各自给意见，附给主审、写进报告，不投票，不仲裁）；90 条标注评测里参考意见没带来提升，默认不加。没有参考成员时主审的提示词和普通审稿人一样。主审没给出有效结论的条目算未决，不执行。
    - `panel`：各成员投票，一致就执行，有分歧交仲裁（三票都要留、只是写法不同时，仲裁只定写法）。`arbiter` 可以写 panel 成员的 name，也可以写一个完整的模型对象。不写 `mode` 时按 panel 处理。
  - API 成员的推理强度经 `extraBody.reasoning_effort` 传（cpa 会校验级别）。每个成员可选 `extraBody`（只对 API）。超时（API 300 s、CLI 600 s）、每个成员并发 1、每批 10 条、一次最多 3 批都写死在代码里（设计 §2.2：预算类参数不给配置键），`review.json` 里写了也不读。
- `ab curate` 默认 dry-run，只把每条候选的三家判决、仲裁结论和要做的动作写进 `~/.agentbrain/curate/<run>.json`。`--apply` 才写库，而且只在配置里的审稿成员都连得上时生效（panel 模式还要满 3 家）：
  - 一致沉淀 → `curate` 事件把候选转正（A 类同时打 guidance 标记）；
  - 改写 → 新条目（origin=curate，仍未确认），原候选归档并指向新条目；
  - 并入 → 候选归档并指向目标，**不改目标正文**；目标是用户确认的，合并建议只进报告的复核清单；
  - 丢弃 → 归档（reason=curate，带理由）。
  - 用户确认过的条目一律跳过。`ab curate --undo <run>` 整次撤销。
- 离线评测：`AB_HOME=<库副本> node scripts/curate-eval.ts <items.json> <out.json>`，只读。

## 话题结束时一步式沉淀（设计 §8.6，2026-10-16 实现，**默认关闭**）

打开前提：`docs/eval/07`（一步式 vs 两步式）补跑完，且 `docs/eval/11`（话题窗口 vs 48000 字窗口）验收显示话题窗口更好。打开由用户决定。

**开关**：`~/.agentbrain/extract.json` 里加一个键 `"topic": true`（其他字段不变）。删掉这个键或改成别的值就是关。关着时下面新加的 hook 什么都不做，`ab work` 行为和以前一样。

**每个宿主要加的事件**（`ab setup` 的宿主一步会把这条一起合进去，写前备份、给 diff、确认后才写；不跑 setup 就手动合并样例）：

| 宿主 | 新增 | 作用 |
|---|---|---|
| Claude Code | `PreCompact`：`ab capture --hook --host claude`（超时 5 秒） | 压缩前记一个话题边界，拉起分离的 `ab work --session`，立即返回，不挡压缩 |
| Codex | `PreCompact`：`ab capture --hook --host codex`（超时 5 秒；改完要在 `/hooks` 里重新信任） | 同上 |
| Pi | 扩展的 `session_before_compact`（`pi/agentbrain-recall.ts` 已带） | 同上；不取消、不改压缩 |

已有的 `UserPromptSubmit` / `SessionEnd`（Pi：`before_agent_start` / `session_shutdown`）不用改：开关打开后，`UserPromptSubmit` 时如果距这个会话上次登记已超过 20 分钟，就顺便拉起 `ab work --session`（候选 B，不加闹钟进程）。

**话题怎么切**：transcript 里相邻两轮相隔 ≥ 20 分钟、压缩标记、会话结束，三者都是边界；还在聊的最后一段不处理。每个话题窗口附前面最多 8 轮、6000 字当背景；超过 120000 字按轮次拆成 k/n。

**谁来判断**：该会话所在宿主自己的命令行子模型和额度——`review.json` 的 `hostReviewers[宿主]` 配了就用它，否则用 `ab setup` 的宿主默认（Claude `claude -p` haiku max；Codex `codex exec` review_model 或 gpt-6-astra max；Pi reviewer 子代理模型 max）。子进程带 `AGENTBRAIN_REVIEWER=1`，它的会话不登记、不召回、不再触发抽取。额度用完时窗口延后到恢复时间，不算失败，不借别的宿主额度。

**写进库的**：一步式判为"新记"的直接写进正式库，未确认、`origin: extract`、依据记为 agent 推断（一步式输出没有逐字引文）；每条带 `topic`（运行、窗口、触发方式、定位点起止、拆分序号、提示词版本、模型）。判为"并入已有某条"的不改目标、不写库，只记在运行报告里给你看。

**审计和撤销**：每次运行一份报告 `~/.agentbrain/topic/<run>.json`；`ab work --runs` 列出运行，`ab work --undo <run>` 整次撤销（只归档本次写入、之后没被动过的条目；你确认过的、已自动转正的、后来被移进候选区/归档过的不动）。单条用 `ab archive <id>` 或 `ab stage <id>`。

**没有实测的**：三个宿主的压缩事件真的会来（需要在你的机器上装 hook 才能测，本 PR 没装）。已离线核对本机 transcript：Claude（`compact_boundary` + `isCompactSummary` 摘要）、Codex（`compacted`）、Pi（`compaction` 条目）压缩后都保留压缩前的原文，从会话文件补读话题的前提成立；Claude 的压缩摘要不当成用户的一轮。

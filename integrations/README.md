# 宿主接线（切片 2 每轮召回 + 切片 3 自动沉淀）

本目录只放样例，不改任何全局配置。装到用户机器上之前要先得到用户同意，改之前先备份。


三个宿主在用户每次发 prompt 时调用 `ab recall --hook`。它从 stdin 读宿主给的 JSON（只用 `prompt` 和 `cwd`），命中当前项目的坑、规则、决定或标了 for_workers 的全局记忆时，输出一行：

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

## 每轮召回装完后的验收（设计 §15.3）

在三个宿主里各做一次：在已登记仓库里 `ab remember --confirmed --kind pitfall …` 记一个坑，开新会话，发一句和这个坑相关的话，确认模型收到了 `<agentbrain-recall>` 块。某个宿主做不到时记为该宿主的显式降级，不算通过。

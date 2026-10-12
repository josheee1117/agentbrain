# 每轮召回接线（切片 2）

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

## 装完后的验收（设计 §15.3）

在三个宿主里各做一次：在已登记仓库里 `ab remember --confirmed --kind pitfall …` 记一个坑，开新会话，发一句和这个坑相关的话，确认模型收到了 `<agentbrain-recall>` 块。某个宿主做不到时记为该宿主的显式降级，不算通过。

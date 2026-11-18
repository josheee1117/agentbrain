# agy（Antigravity CLI）宿主支持（设计 §7.7）

## Sub-features
- 插件 `integrations/agy/`：SessionStart 注入 `ab brief`，PreInvocation 新用户消息注入 recall 并登记（`UserPromptSubmit`），Stop 且 `continuationActive` 不为真时按 `SessionEnd` 登记、拉起 `ab work --session agy:<id>`
- 准入：只认 `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`；截断版 `transcript.jsonl` 换成完整版；`chunks/`、`scratch/`、id 不符、目录外链接拒绝
- 读法：`USER_REQUEST` 内文是用户轮，`PLANNER_RESPONSE` 是助手轮（工具调用压成一行），`GENERIC` 是工具输出，`SYSTEM_MESSAGE`（钩子注入）不读
- sweep 补登记：cwd 和子会话从 `conversation_summaries.db` 只读取
- 宿主识别：进程名 `agy`，会话 id 取 `ANTIGRAVITY_CONVERSATION_ID`；`ab doctor` 有 `agy:` 一行

## How to get to it (user POV)
- `agy plugin install "$PWD/integrations/agy"` 后，在已登记仓库里用 agy；每轮结束后台抽取，`ab search` 看到 `[未确认·自动沉淀]`

## Driving it with verify.sh
- `verify.sh run` 的 `cli-agy-capture` / `cli-agy-work` / `cli-agy-work-text`：隔离 HOME 里造 agy 目录，钩子给截断版路径，dry-run 应报 `待处理窗口 1`
- 单测：`src/agy.test.ts`（准入、读法、来源展开、sweep、capture、doctor），`src/agy-plugin.test.ts`（插件登记时机）

## Real-host evidence
- 2026-11-18 隔离库真实会话 `d98cb742-0aa7-4f0a-89ce-a61ccb04a6c8`：`capture_sessions` 有 host=agy、via=hook、已结束；窗口完成 1，抽出 1 条规则；`ab get --expand` 展开原话。证据 `~/.cache/verify-evidence/agentbrain/20261118-agy-capture/`

## Gotchas
- 钩子跑的是插件目录里复制的脚本：改了 `integrations/agy/` 要重新 `agy plugin install`
- 真机验证要把 `AGENTBRAIN_AB`、`AB_HOME`、`AB_REGISTRY` 传给 agy 进程（钩子继承环境），否则会写进正式库或用 `~/.local/bin/ab`
- 测试会话文件刚写出时不算静置，dry-run 不切最后一个窗口：把 mtime 设到 30 分钟前

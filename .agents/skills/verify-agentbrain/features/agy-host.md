# agy（Antigravity）宿主支持（设计 §7.7、§7.8.2）

## Sub-features
- 插件 `integrations/agy/`：SessionStart 注入 `ab brief`，PreInvocation 新用户消息注入 recall 并登记（`UserPromptSubmit`），Stop 且 `continuationActive` 不为真时按 `SessionEnd` 登记、拉起 `ab work --session agy:<id>`
- 准入：只认 CLI、IDE 与 T3 实例应用根内的 `brain/<id>/.system_generated/logs/transcript_full.jsonl`。CLI 根为 `~/.gemini/antigravity-cli`，IDE 根为 `~/.gemini/antigravity`，T3 根为 `~/.t3/userdata/providers/antigravity/<实例>/antigravity-acp`。截断版换成完整版；`chunks/`、`scratch/`、id 不符和逃逸软链拒绝。
- 读法：`USER_REQUEST` 内文是用户轮，`PLANNER_RESPONSE` 是助手轮（工具调用压成一行），`GENERIC` 是工具输出，`SYSTEM_MESSAGE`（钩子注入）不读
- sweep 补登记：`agyRoots` 动态枚举 T3 直接实例，`agyDiscover` 先发现本根完整日志，再与摘要行相交。原库及 WAL、SHM 先核验路径，复制后只读查询 id、首 workspace、parent 和修改时间，不读摘要正文。
- 发现状态：空实例没有摘要库报告 0；有日志但缺元数据保留日志和空 cwd，不补登记；坏库或无权限报告无法读取；同 id 多根完整日志冲突时不登记、不抽取。已登记会话不受七天窗口限制，未登记按摘要时间过滤，坏时间退回文件 mtime，子会话不补登记。
- 宿主识别：进程名 `agy`，会话 id 取 `ANTIGRAVITY_CONVERSATION_ID`；`ab doctor` 有 `agy:` 一行

## How to get to it (user POV)
- `agy plugin install "$PWD/integrations/agy"` 后，在已登记仓库里用 agy；每轮结束后台抽取，`ab search` 看到 `[未确认·自动沉淀]`

## Driving it with verify.sh
- `verify.sh run` 的 `cli-agy-capture` / `cli-agy-work` / `cli-agy-work-text`：隔离 HOME 里造 agy 目录，钩子给截断版路径，dry-run 应报 `待处理窗口 1`
- `verify.sh run` 的 `cli-agy-roots`：`node --test src/agy-roots.test.ts` 在隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY 下造三处应用目录，真实 `work --sweep` 后回读 `capture_sessions`，断言三处路径与 cwd；再跑 `work --dry-run`，逐个断言待处理窗口 1。无模型时窗口延后，不用抽取成功冒充发现成功。
- 单测：`src/agy-roots.test.ts` 覆盖动态新增实例、空实例、缺元数据、坏库与无权限、DB/WAL/SHM 和日志逃逸、只读 WAL 副本、七天窗口、子会话与冲突。冲突加 `--redo` 的用例断言既有会话全部字段和已完成窗口均不变。`src/agy.test.ts` 覆盖既有 CLI 准入、读法、来源展开、capture、doctor，`src/agy-plugin.test.ts` 覆盖插件登记时机。
- 当前定位函数和 doctor 单行仍沿 CLI 口径。IDE/T3 定位与逐处诊断由后续工作线实现，不属于此处已验收范围。

## Real-host evidence
- 2026-11-18 隔离库真实会话 `d98cb742-0aa7-4f0a-89ce-a61ccb04a6c8`：`capture_sessions` 有 host=agy、via=hook、已结束；窗口完成 1，抽出 1 条规则；`ab get --expand` 展开原话。证据 `~/.cache/verify-evidence/agentbrain/20261118-agy-capture/`

## Gotchas
- 钩子跑的是插件目录里复制的脚本：改了 `integrations/agy/` 要重新 `agy plugin install`
- 真机验证要把 `AGENTBRAIN_AB`、`AB_HOME`、`AB_REGISTRY` 传给 agy 进程（钩子继承环境），否则会写进正式库或用 `~/.local/bin/ab`
- 测试会话文件刚写出时不算静置，dry-run 不切最后一个窗口：把 mtime 设到 30 分钟前

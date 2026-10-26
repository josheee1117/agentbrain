# recall-hook (宿主每轮召回与上下文注入)

## Sub-features
- 宿主每轮静默召回 (`ab recall --hook`)，根据输入的 prompt 与 cwd 自动匹配相关规则与坑
- 召回内容：已确认的坑/规则/决定，另可带最多 1 条无争议的未确认条目（标"未确认"，排在已确认之后）；子代理只放有用户原话的未确认规则/决定
- 宿主集成接口支持：Claude Code hook (UserPromptSubmit)、Pi 扩展 `agentbrain-recall`、Codex 注入
- 结果格式化输出：生成 `<agentbrain-recall>` 与 `<agentbrain-prefs>` 注入块，支持 `want_count` 参数输出命中条数
- 容灾与静默退出机制：未命中、超时或内部异常时自动接住，以退出码 0 静默退出，绝不阻断宿主正常对话

## How to get to it (user POV)
- 用户在宿主（Claude Code、Pi、Codex）中发送消息时，宿主钩子自动以 stdin 管道调用 `ab recall --hook`，将相关坑与规则静默注入系统提示或上下文区

## Driving it with verify.sh
- `printf '{"prompt":"验证规范","cwd":"%s"}\n' "$REPO" | env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts recall --hook`
- Proof: 退出码 0，标准输出返回包含 hookSpecificOutput.additionalContext 的 JSON，且内含 `<agentbrain-recall>` 块

## Gotchas
- 钩子内部必须自我 swallow 异常，异常逃逸会导致宿主阻断，因此必须保证 exit code 0
- 向量不可用或未命中时，输出可能为空字符串或无 additionalContext，退出码仍必须为 0
- 去掉候选区后（§8.8），agent 自记和自动抽取的未确认条目也能进召回；有争议的不进（有冲突、待确认纠正、关系未判定、与代码不符、本身是纠正）

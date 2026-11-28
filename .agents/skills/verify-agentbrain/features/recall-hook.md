# recall-hook (宿主每轮钩子与上下文注入)

## Sub-features
- 宿主每轮钩子 (`ab recall --hook`)：不再按本轮提问全量被动检索注入，也取消泛化的每轮固定提醒噪音；改为输出常驻偏好 (`<agentbrain-prefs>`) + 轻量本地 BM25 条件触发器（`<2.5ms` 零网络）：常规提问完全静默（`additionalContext` 不拼召回提醒），仅在命中窄域高区分词时输出 `[shortId] 种类（线索：…）→ 动手前先跑 ab get <id>`；引用开关开启（`cite=on`）时保留回答报告指令
- 身份入口先通过 `telemetryCtx` / `allowedTranscript` 规范路径，再调用 `workerIdentity`。只有完整首轮无标记才确认主会话；待定时不调用 `guidanceBlock` 与条件触发器，`raw.worker=true` 可强制 worker。
- 文本检索保留：`ab recall <文本>` 仍支持按关键词和向量召回记忆（供手动查或对照评测使用）
- 宿主集成接口支持：Claude Code hook (UserPromptSubmit)、Pi 扩展 `agentbrain-recall`、Codex 注入
- 结果格式化输出：生成 `<agentbrain-recall>` 与 `<agentbrain-prefs>` 注入块，不再输出 `want_count`
- 容灾与静默退出机制：未命中、超时或内部异常时自动接住，以退出码 0 静默退出，绝不阻断宿主正常对话

## How to get to it (user POV)
- 用户在宿主（Claude Code、Pi、Codex）中发送消息时，宿主钩子自动以 stdin 管道调用 `ab recall --hook`，将常驻偏好与按需查询提醒注入系统提示或上下文区

## Driving it with verify.sh
- `printf '{"prompt":"验证规范","cwd":"%s"}\n' "$REPO" | env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts recall --hook`
- Proof: 退出码 0，标准输出返回包含 `hookSpecificOutput.additionalContext` 的合法 JSON；常规提问无噪音泛化提醒，命中窄域高区分词或开启 `cite` 时内含 `<agentbrain-recall>` 块

## Gotchas
- 钩子内部必须自我 swallow 异常，异常逃逸会导致宿主阻断，因此必须保证 exit code 0
- Pi 扩展的异步回调（状态栏刷新）拿到的 ctx 可能在 newSession / reload 后失效，读 sessionManager 要包 try/catch，否则整个 Pi 进程崩掉
- 钩子不再自动检索历史坑与规则；模型遇到陌生模块、踩坑或需查历史决定时，由模型主动调用 `ab search` 或 `ab get` 查询
- 斜杠命令（以 `/` 开头）与审稿子进程环境下钩子静默不输出

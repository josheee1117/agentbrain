# agy（Antigravity）宿主支持（设计 §7.7、§7.8.2）

## Sub-features
- 插件 `integrations/agy/`：SessionStart 注入 `ab brief`，PreInvocation 新用户消息注入 recall 并登记（`UserPromptSubmit`），Stop 且 `continuationActive` 不为真时按 `SessionEnd` 登记、拉起 `ab work --session agy:<id>`
- 准入：只认 CLI、IDE 与 T3 实例应用根内的 `brain/<id>/.system_generated/logs/transcript_full.jsonl`。CLI 根为 `~/.gemini/antigravity-cli`，IDE 根为 `~/.gemini/antigravity`，T3 根为 `~/.t3/userdata/providers/antigravity/<实例>/antigravity-acp`。截断版换成完整版；`chunks/`、`scratch/`、id 不符和逃逸软链拒绝。
- 读法：`USER_REQUEST` 内文是用户轮，`PLANNER_RESPONSE` 是助手轮（工具调用压成一行），`GENERIC` 是工具输出，`SYSTEM_MESSAGE`（钩子注入）不读
- sweep 补登记：`agyRoots` 动态枚举 T3 直接实例，`agyDiscover` 先发现本根完整日志，再与摘要行相交。原库及 WAL、SHM 先核验路径，复制后只读查询 id、首 workspace、parent 和修改时间，不读摘要正文。
- 发现状态：空实例没有摘要库报告 0；有日志但缺元数据保留日志和空 cwd，不补登记；坏库或无权限报告无法读取。不可读日志不能算成 0 对话，同根日志和摘要库失败只报一条，注明不可读日志数量及摘要库失败。同 id 多根完整日志冲突时不登记、不抽取。已登记会话不受七天窗口限制，未登记按摘要时间过滤，坏时间退回文件 mtime，子会话不补登记。
- 宿主识别：进程名 `agy` 或 `Antigravity`，以及位于 `Antigravity.app` 内或带 `--override_ide_name antigravity` 的 `language_server`。链上最近的宿主优先，IDE 内嵌 Pi、Claude Code、Codex 不改判。会话 id 取 `ANTIGRAVITY_CONVERSATION_ID`；`ab doctor` 有 `agy:` 一行。
- 定位：`agyLocate` 检查枚举根里的指定 id 完整版，多根命中返回冲突；`locateTranscript` 返回 null。`ANTIGRAVITY_APP_DATA_DIR` 只匹配应用根，只有 `GEMINI_HOME` 时只匹配已枚举的 T3 实例。合法提示允许保留未落盘规范坐标；无提示只取唯一候选，没有候选返回 null。无路径 capture 遇到冲突不登记、不刷新。
- 子代理识别：Pi、agy 共用首个原始输入的两类 T3 前缀和 `ab brief <项目> --worker` 标记。读头从 16,384 字节扩至 262,144 字节，首条输入仍不完整时仅匹配其原始 JSON 已知标记。`workerIdentity` 在无完整首轮且无阳性信号时返回 null，recall 不注主会话偏好。
- 路径固定：agy 的 upsert 在短写事务内返回 `new`、`touched` 或 `conflict`。空路径首次补齐，同根 touch / Stop 更新；异根或多根完整版冲突不改任何会话字段、不启动 work。合法提示指向未落盘的另一根也不能换路径。引用扫描使用登记路径，无基线时只补找唯一合法来源；Codex 换文件语义不变。

## How to get to it (user POV)
- `agy plugin install "$PWD/integrations/agy"` 后，在已登记仓库里用 agy；每轮结束后台抽取，`ab search` 看到 `[未确认·自动沉淀]`

## Driving it with verify.sh
- `verify.sh run` 的 `cli-agy-capture` / `cli-agy-work` / `cli-agy-work-text`：隔离 HOME 里造 agy 目录，钩子给截断版路径，dry-run 应报 `待处理窗口 1`
- `verify.sh run` 的 `cli-agy-roots`：`node --test src/agy-roots.test.ts` 在隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY 下造三处应用目录，真实 `work --sweep` 后回读 `capture_sessions`，断言三处路径与 cwd；再跑 `work --dry-run`，逐个断言待处理窗口 1。无模型时窗口延后，不用抽取成功冒充发现成功。
- 单测：`src/agy-roots.test.ts` 覆盖动态新增实例、空实例、缺元数据、坏库与无权限、DB/WAL/SHM 和日志逃逸、只读 WAL 副本、七天窗口、子会话与冲突。冲突加 `--redo` 的用例断言既有会话全部字段和已完成窗口均不变。不可读日志且无摘要库的用例断言不报 0，同根双重失败的用例断言只报一行并驱动真实 `work --sweep`。`src/agy.test.ts` 覆盖既有 CLI 准入、读法、来源展开、capture、doctor，`src/agy-plugin.test.ts` 覆盖插件登记时机。
- `verify.sh run` 的 `cli-agy-locate`：`node --test src/agy-locate.test.ts src/host.test.ts`。隔离文件根覆盖三处提示、唯一候选、T3 的 GEMINI_HOME、未落盘坐标、跨根冲突和非法路径。真实 CLI 的无路径 capture 回读三处登记路径；冲突不刷新已有行。`remember --from-worker` 后 `get --expand` 展开各自原话，回读 L1 来源确认不串根。IDE 进程链只做回放，不算真实工具 shell 验收。
- `verify.sh run` 的 `cli-agy-path-pin`：`node --test src/agy-path-pin.test.ts`。真实 capture hook 和手动 capture 后逐字段回读，冲突时 `work.log` 不存在；覆盖带路径的同根多根冲突、异根未落盘提示、事务回滚及并发首次登记。真实 `remember --from-worker` / `get --expand` 展开登记根原话，跨表引用扫描不取另一根；无基线冲突跳过。登记路径变成异根软链后，真实 `view --no-open` 报来源不可用，不写 agy 引用扫描记录。`src/work.test.ts` 的 Codex 635 到 644 接续断言保持不变。
- `verify.sh run` 的 `cli-agy-worker` 跑 `src/transcript.test.ts`、`src/transcript-file.test.ts` 和 `src/cli.test.ts` 中的身份回归。覆盖两类 T3 前缀、正文反例、带项目参数标记、超长首行和身份待定；真实 CLI 比较截断版与完整版 recall 输出，回读输出确认无主会话偏好，再用 `brief --worker` 确认全局规则仍在。
- doctor 单行仍沿 CLI 口径，逐处诊断由后续工作线实现。IDE/T3 定位已覆盖隔离目录，真实 IDE 工具 shell 未验证。

## Real-host evidence
- 2026-11-18 隔离库真实会话 `d98cb742-0aa7-4f0a-89ce-a61ccb04a6c8`：`capture_sessions` 有 host=agy、via=hook、已结束；窗口完成 1，抽出 1 条规则；`ab get --expand` 展开原话。证据 `~/.cache/verify-evidence/agentbrain/20261118-agy-capture/`

## Gotchas
- 钩子跑的是插件目录里复制的脚本：改了 `integrations/agy/` 要重新 `agy plugin install`
- 真机验证要把 `AGENTBRAIN_AB`、`AB_HOME`、`AB_REGISTRY` 传给 agy 进程（钩子继承环境），否则会写进正式库或用 `~/.local/bin/ab`
- 测试会话文件刚写出时不算静置，dry-run 不切最后一个窗口：把 mtime 设到 30 分钟前

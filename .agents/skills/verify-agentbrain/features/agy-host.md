# agy（Antigravity）宿主支持（设计 §7.7、§7.8）

## Sub-features
- 插件 `integrations/agy/`：SessionStart 返回 `{}`。PreInvocation 新 prompt 只 capture 一次并注入 recall 上下文；brief 独立保存 pending/done，只按 `agentbrain.session` 的 worker 三态选 `brief --worker`、`brief` 或等待。失败、空输出或身份待定后，同 prompt 只重查 session 并补 brief，不重复 capture 或偏好。恢复时只信 ab 的 brief_present。briefs 与 seen 文件都用规范应用根和会话 id 的 SHA-1 键。应用根优先取 transcript 日志尾，其次取 APP_DATA_DIR，再取存在的 GEMINI_HOME 下 antigravity-acp；存在的根取 realpath。Stop 且不再继续时按 SessionEnd 登记并拉起抽取。
- 准入：只认 CLI、IDE 与 T3 实例应用根内的 `brain/<id>/.system_generated/logs/transcript_full.jsonl`。CLI 根为 `~/.gemini/antigravity-cli`，IDE 根为 `~/.gemini/antigravity`，T3 根为 `~/.t3/userdata/providers/antigravity/<实例>/antigravity-acp`。截断版换成完整版；`chunks/`、`scratch/`、id 不符和逃逸软链拒绝。
- 读法：三处共用 `cleanTranscript("agy")`。`USER_REQUEST` 按尾部宿主块取正文，T3 内层请求取 `runtime_info` 前的末个闭标签。上下文交接只取末尾当前消息，缺边界、子代理完成和明确后台唤醒不生成用户轮。助手引用只保留非空 `citation.comment`，占位符不进入轮次或用户证据。`PLANNER_RESPONSE` 是助手轮，工具调用压成一行；`GENERIC` 是工具输出；`SYSTEM_MESSAGE` 不读。重复步骤依原始顺序使用 `76`、`76#2`，未读和去噪行也计数。回跳清空工具配对队列。
- sweep 补登记：`agyRoots` 动态枚举 T3 直接实例，`agyDiscover` 先发现本根完整日志，再与摘要行相交。原库及 WAL、SHM 先核验路径，复制后只读查询 id、首 workspace、parent 和修改时间，不读摘要正文。
- 发现状态：空实例没有摘要库报告 0；有日志但缺元数据保留日志和空 cwd，不补登记；坏库或无权限报告无法读取。不可读日志不能算成 0 对话，同根日志和摘要库失败只报一条，注明不可读日志数量及摘要库失败。同 id 多根完整日志冲突时不登记、不抽取。已登记会话不受七天窗口限制，未登记按摘要时间过滤，坏时间退回文件 mtime，子会话不补登记。
- 宿主识别：进程名 `agy` 或 `Antigravity`，以及位于 `Antigravity.app` 内或带 `--override_ide_name antigravity` 的 `language_server`。链上最近的宿主优先，IDE 内嵌 Pi、Claude Code、Codex 不改判。会话 id 取 `ANTIGRAVITY_CONVERSATION_ID`。
- 定位：`agyLocate` 检查枚举根里的指定 id 完整版，多根命中返回冲突；`locateTranscript` 返回 null。`ANTIGRAVITY_APP_DATA_DIR` 只匹配应用根，只有 `GEMINI_HOME` 时只匹配已枚举的 T3 实例。合法提示允许保留未落盘规范坐标；无提示只取唯一候选，没有候选返回 null。无路径 capture 遇到冲突不登记、不刷新。
- 子代理识别：Pi、agy 共用首个原始输入的两类 T3 前缀和 `ab brief <项目> --worker` 标记。读头从 16,384 字节扩至 262,144 字节，首条输入仍不完整时仅匹配其原始 JSON 已知标记。`workerIdentity` 在无完整首轮且无阳性信号时返回 null，recall 不注主会话偏好。
- 会话状态：`recall --hook` 仅在 `want_session_state:true` 时新增 `agentbrain.session`，包含 `worker` 三态和独立的 `brief_present`。已注入 brief 只从 SYSTEM_MESSAGE 的 content 判断，读头上限为 262,144 字节，截断末行仍先确认 type。先规范完整版路径，不把用户正文里的标签当注入。环境兜底补 transcript；stdin id 覆盖环境 id 时重新定位，冲突保持 null。
- 路径固定：agy 的 upsert 在短写事务内返回 `new`、`touched` 或 `conflict`。空路径首次补齐，同根 touch / Stop 更新；异根或多根完整版冲突不改任何会话字段、不启动 work。合法提示指向未落盘的另一根也不能换路径。引用扫描使用登记路径，无基线时只补找唯一合法来源；Codex 换文件语义不变。

## How to get to it (user POV)
- CLI、IDE 共用一份插件：`agy plugin install "$PWD/integrations/agy"`（只装到 `$HOME/.gemini/config/plugins/`，不认 `GEMINI_HOME`）。在已登记仓库里用 agy，每轮结束后台抽取，`ab search` 看到 `[未确认·自动沉淀]`
- T3 不以插件为前提，也没有自动开工注入：靠 `work --sweep` 补登记（30 分钟静置 + 每 30 分钟巡检），首条消息后约 30 至 60 分钟才开始抽取；要背景得自己 `ab brief` / `ab search`。给实例建 `config/plugins/agentbrain` 软链属于可选的「B建链」，只在隔离 ACP 探活通过、用户同意后才做，会写 `~/.t3`
- 三处分处看：`ab status` 与 `ab doctor` 每个应用根一行，如 `agy CLI: 日志 17（可抽 17），已登记 17，插件在位`、`agy IDE: 日志 15（可抽 15），已登记 0，只靠 sweep`、`agy T3 60c7502f: 日志 3（可抽 3），已登记 0，只靠 sweep`；某处有可抽主会话却 0 登记时进顶部「要处理」

## Driving it with verify.sh
- `verify.sh run` 的 `cli-agy-cli`：隔离 HOME 里造 CLI 根（`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/`）和摘要库，钩子给截断版路径；回读 `capture_sessions.transcript` 确认登记成完整版，dry-run 报 `待处理窗口 1`，`status` 出 `agy CLI: 日志 1（可抽 1），已登记 1，只靠 sweep`
- `verify.sh run` 的 `cli-agy-ide`：另一份隔离 HOME 造 `~/.gemini/antigravity/brain/<id>/…` 和 `conversation_summaries.db`，`capture --hook --host agy` 登记到 IDE 根的完整版；dry-run 报 `待处理窗口 1`，`status` 的 `agy IDE:` 一行显示日志 1、可抽 1、已登记 1
- `verify.sh run` 的 `cli-agy-t3`：隔离 HOME 造两个 T3 直接实例，各带 `antigravity-acp/brain/` 和摘要库；各自 capture 后 dry-run 各一行，`status` 出两条独立的 `agy T3 a1b2c3d4:` / `agy T3 e5f6a7b8:` 行，各计日志 1、已登记 1
- `verify.sh run` 的 `cli-agy-conflict`：隔离 HOME 让 CLI、IDE 两棵根同 id 都有完整日志；`work --sweep` 报「在多处有完整日志，已跳过」，`capture_sessions` 仍 0 行，`status` 两行标「冲突」且「要处理」只列一条
- `verify.sh run` 的 `cli-agy-roots`：`node --test src/agy-roots.test.ts` 在隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY 下造三处应用目录，真实 `work --sweep` 后回读 `capture_sessions`，断言三处路径与 cwd；再跑 `work --dry-run`，逐个断言待处理窗口 1。无模型时窗口延后，不用抽取成功冒充发现成功。
- 单测：`src/agy-roots.test.ts` 覆盖动态新增实例、空实例、缺元数据、坏库与无权限、DB/WAL/SHM 和日志逃逸、只读 WAL 副本、七天窗口、子会话与冲突。冲突加 `--redo` 的用例断言既有会话全部字段和已完成窗口均不变。不可读日志且无摘要库的用例断言不报 0，同根双重失败的用例断言只报一行并驱动真实 `work --sweep`。`src/agy.test.ts` 覆盖既有 CLI 准入、读法、来源展开、capture、doctor，`src/agy-plugin.test.ts` 覆盖插件登记时机。
- `verify.sh run` 的 `cli-agy-locate`：`node --test src/agy-locate.test.ts src/host.test.ts`。隔离文件根覆盖三处提示、唯一候选、T3 的 GEMINI_HOME、未落盘坐标、跨根冲突和非法路径。真实 CLI 的无路径 capture 回读三处登记路径；冲突不刷新已有行。`remember --from-worker` 后 `get --expand` 展开各自原话，回读 L1 来源确认不串根。IDE 进程链只做回放，不算真实工具 shell 验收。
- `verify.sh run` 的 `cli-agy-path-pin`：`node --test src/agy-path-pin.test.ts`。真实 capture hook 和手动 capture 后逐字段回读，冲突时 `work.log` 不存在；覆盖带路径的同根多根冲突、异根未落盘提示、事务回滚及并发首次登记。真实 `remember --from-worker` / `get --expand` 展开登记根原话，跨表引用扫描不取另一根；无基线冲突跳过。登记路径变成异根软链后，真实 `view --no-open` 报来源不可用，不写 agy 引用扫描记录。`src/work.test.ts` 的 Codex 635 到 644 接续断言保持不变。
- `verify.sh run` 的 `cli-agy-worker` 跑 `src/transcript.test.ts`、`src/transcript-file.test.ts` 和 `src/cli.test.ts` 中的身份回归。覆盖两类 T3 前缀、正文反例、带项目参数标记、超长首行和身份待定；真实 CLI 比较截断版与完整版 recall 输出，回读输出确认无主会话偏好，再用 `brief --worker` 确认全局规则仍在。
- `verify.sh run` 的 `cli-agy-status`：`node --test src/status-agy.test.ts`。真实 `status`、`doctor` 在隔离 HOME 下各显示 CLI、IDE 和两个 T3 实例一行。计数覆盖所有完整日志，按登记路径对齐，不沿用 sweep 的七天窗口。子会话、已删 cwd 和未登记项目不进可抽数；冲突日志不重复计数；缺元数据、坏库和权限拒绝各自注明。CLI、IDE 检查共享插件，T3 检查各实例入口。0 登记且有可抽主会话进入顶部“要处理”。诊断不改 capture 行、事件、源摘要库或日志，`status --line` 仍只有 `review` 和 `work_failed`。
- `verify.sh run` 的 `cli-agy-denoise` 跑 `src/agy.test.ts` 和 `src/extract.test.ts` 的去噪与定位点回归。它覆盖嵌套闭标签、普通 User message 和唤醒字样、缺边界交接、两类完成通知、引用评论与坏 JSON、原始步骤计数、非用户回跳及 ab 键隔离。真实 CLI 在隔离三处根各执行 `remember --from-worker` 和 `get --expand`，回读 L1 来源的路径及 `76#2`，确认展开只含用户正文。
- `verify.sh run` 的 `cli-agy-session-state` 跑 `node --test --test-name-pattern=会话状态 src/cli.test.ts`。隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY，真实 CLI 比较带标记与不带标记的 stdout，唯一差异为 agentbrain 字段。覆盖 worker 三态与 brief 的独立组合、恢复无标记、用户/助手标签反例、16KB 后注入与 262KB 截断。名为 agy 的 Node 软链父进程驱动三处环境坐标、无准入路径、仅 stdin id 和覆盖环境 id，回读 SQLite 的 inject_log 与 recall_runs，确认 host、session_id、transcript 一致。多根冲突保持 null；Pi 的 stdin id 补定位回读 realpath，库版本仍为 1。此项只验证 ab 合同，不证明已安装插件或真实 IDE/ACP 钩子。
- `verify.sh run` 的 `cli-agy-plugin` 跑 `node --test src/agy-plugin.test.ts`。假 ab 只放在 CLI 边界，记录 argv、stdin 和 env，验证失败重试与根隔离。真实 CLI 在隔离 HOME、AB_HOME、AB_REGISTRY、PLUGIN_DATA 下通过 stdin 跑仓库插件，覆盖 CLI、IDE 两处首轮三态、待定补注、同 prompt 去重与删除标记后的恢复。名为 agy 的 Node 父进程只回放宿主名，不安装插件。SQLite 回读 capture_sessions、inject_log 和 recall_runs，确认 brief 每会话只一次且坐标对齐；转录保持不变。此项不证明真实 IDE 或 ACP 加载。
- IDE/T3 定位和诊断已覆盖隔离目录，真实 IDE 工具 shell 未验证。

## Real-host evidence
- 2026-11-18 隔离库真实会话 `d98cb742-0aa7-4f0a-89ce-a61ccb04a6c8`：`capture_sessions` 有 host=agy、via=hook、已结束；窗口完成 1，抽出 1 条规则；`ab get --expand` 展开原话。证据 `~/.cache/verify-evidence/agentbrain/20261118-agy-capture/`
- 2026-11-24 三处隔离重放（证据 `~/.cache/verify-evidence/agentbrain/20261124-122510-agy-wiring/`）：真实日志复制进隔离 HOME 的三类应用根，摘要库只留本轮会话行；假 chat、假 embedding 只放在模型边界，真实 `runWork({sweep:true})` 发现、登记、处理；`now` 固定 2026-11-24T04:00:30Z。
  - CLI `9583e746-72da-472c-8b4c-4db3c176f15a`（cwd `~/code_me/pm`）：条目 `435f966d` 引真实原话，定位点 `0`，窗口 1 完成（`processed_anchor` 157）。
  - IDE `63892cce-332b-464d-8483-b7ba8c7d45df`：两个条目 `9e82db16`（`76`）、`edf787e8`（`76#2`），回滚前后两个定位点各自能 `ab get --expand` 打开并显示 `user@76` / `user@76#2`。
  - T3 `ac0a3dfd…/adb838bc-9931-4978-ade9-1e4a0d64b3c4`：条目 `664829a5`，定位点 `0`，4 个窗口全完成（`processed_anchor` 671）。
  - 反例 T3 `60c7502f…/2fc7ed3c-3d9f-45bf-985f-c7388164257c`：`workerIdentity` 为 true，证据按 `worker_prompt` 丢弃，0 条目。
  - 第二次重放：登记 4、窗口 7、条目 4、候选 4 均不增；`status` 四根各「已登记 1」，`work --dry-run` 全部「待处理窗口 0」。
  - 正式库 `~/.agentbrain/store.db` 按这四个 id 逐表比对不变（IDE、T3 仍 0 行，CLI 的会话/窗口/事件/候选字节相同）；源 transcript 与 `hooks.json` 的 mtime、sha256 不变。
- BLOCKED 真实 IDE 交互窗口：本机只用隔离目录回放 IDE 根的日志与进程链，缺 Antigravity IDE 真实窗口里一次 `UserPromptSubmit` 的钩子输入与 `inject_log` 证据。
- BLOCKED 真实账号 ACP 钩子：四个 T3 实例都没有 `config/plugins/`，「B建链」要等隔离 ACP 探活通过并由用户点头建软链；缺 ACP 实际加载并触发钩子的标记。

## Gotchas
- 钩子跑的是插件目录里复制的脚本：改了 `integrations/agy/` 要重新 `agy plugin install`
- 真机验证要把 `AGENTBRAIN_AB`、`AB_HOME`、`AB_REGISTRY` 传给 agy 进程（钩子继承环境），否则会写进正式库或用 `~/.local/bin/ab`
- 测试会话文件刚写出时不算静置，dry-run 不切最后一个窗口：把 mtime 设到 30 分钟前

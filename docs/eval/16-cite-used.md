# Eval 16：ab-used 引用标注（上线前评测，**部分结果：只有 Codex 跑出 21 轮；其余等额度**）

> 状态：骨架。设计 §11.8.9 / §11.8.10。引用开关 `ab setup --cite` 默认关，本评测完成并经用户审阅后才决定是否默认打开。

## 目的
量出模型在回复末尾自报的 `ab-used: 标题 (id)` 准不准、各宿主/模型愿不愿意标，以及加这行指令对回答质量的影响。

## 设置（每次运行把确切参数填进下表）
- 全部用临时库：`AB_HOME=$(mktemp -d)`，stdin 关闭（`</dev/null`），不碰正式库。
- 记忆来源：测试切分（与 eval 13/14 相同口径），约 20 个有召回的回合。
- 两组：A = `ab setup --cite off`；B = `ab setup --cite on`（同时写临时 HOME 下的托管块，`AB_HOST_HOME` 指临时目录）。
- 宿主与模型：

| 宿主 | 版本 | 模型 | effort / 推理档 | 命令行 |
|---|---|---|---|---|
| Pi | 1.3.0 | cpa/glm-5.3 | `--thinking max`（生效确认待第一条成功运行） | 见 `eval/cite-used/README.md` |
| Pi | 1.3.0 | cpa/deepseek-v4-pro | `--thinking max`（同上） | 同上 |
| Claude Code | 2.1.296 | opus（claude-opus-5-5） | `--effort max` | `claude -p --output-format stream-json --verbose --effort max --model opus`；工具默认开 |
| Codex | codex-cli 0.162.1 | gpt-5.6-sol | `model_reasoning_effort="xhigh"`（Codex 最高档） | `codex exec --json -s read-only --dangerously-bypass-hook-trust --skip-git-repo-check -c model_reasoning_effort="xhigh"`；工具开、只读沙箱 |
| opencode | v2.0.30 | huoshan/ark-code-latest | 变体 `#max`（reasoningEffort=max） | `opencode run --standalone --format json -m huoshan/ark-code-latest#max`；`OPENCODE_CONFIG` 指真实配置（只读） |

## 标注
- 我标：每轮注入的每条召回记忆，回答是否实际依据了它（是 / 否 / 说不清）。
- 用户抽查：至少抽 5 轮，不一致处以用户为准并记录。

## 指标（按宿主 × 模型分开）
- 标注率 = B 组有召回的回合里写了 ab-used 的比例（看板同口径：`recall_runs.cite=1 且 hit` 对 `cite_scan.marked_turns`）。
- 精确率 = 标了的里真用了的比例；召回率 = 真用了的里标了的比例。
- 标题不符率（`title_mismatch`）。
- 回答质量：A/B 两组同题对比，沿用 eval 14 的评判方式，注意评判噪声。

## 题目与记忆（2026-10-21 定稿，跑之前提交）
- 题目 23 道（`eval/cite-used/questions.json`）：都是 agentbrain 开发里会问的话，不提评测、不提引用。
- 预检（`preflight.json`，只跑 `ab recall --hook`，不调模型）：20 道有召回、3 道没有（q07、q19、q20，用来看没召回时会不会乱标）。20 道里 9 道注入 2–3 条，其中有明显不相关的干扰条（如 q15 注入了"临时文件写 /tmp"、q23 注入了"撤销单处编辑别用 git checkout"）；11 道只注入 1 条，基本都相关。所以精确率主要由那 9 道决定，样本小，结果要按这个读。
- 记忆：从正式库只读导出 44 条（agentbrain 项目 26 条 active 全部 + 全局 18 条与开发、测试相关的），脱敏（邮箱、IP、key 形状、`/Users/<名>`）后用 `ab remember --confirmed` 写进临时库，id 是新生成的。

## 进度
- 2026-10-21 15:37（SGT）harness 冒烟：Pi 真实加载扩展，召回块注入、末尾带引用指令；`inject_log` 记到 host=pi、会话 id、transcript，`recall_runs.cite=1`。
- 同时发现 cpa 上 glm-5.3、deepseek-v4-pro 都在 429（5 小时额度，提示 17:16 / 19:28 SGT 重置），没有一条模型回答。runner 已在 Mac 后台启动，429 时每 10 分钟重试，截止 23:30 SGT。

- 15:53 起 Claude Code、Codex、opencode 车道。Claude Code：会话额度用尽，提示 19:10 SGT 重置；opencode：和 Pi 同一火山额度，19:28 重置；Codex 跑到 16:37 SGT 也用尽，提示 20:51 重置。各车道 429 时每 10 分钟重试，截止 23:30 SGT。
- 宿主隔离核对：四个宿主的指令文件都在临时 HOME（`.claude/CLAUDE.md`、`.codex/AGENTS.md`、`.pi/agent/AGENTS.md`、`.config/opencode/AGENTS.md`）里，on 的一份含 ab-used 说明，off 的不含；四个宿主的 hook 都把注入记到了临时库（host 分别为 claude/codex/pi/opencode）。Codex 的 hook 命令里直接写 `AB_HOME=…`，不靠环境继承。

## 结果（2026-10-21 16:41 SGT，只有 Codex）

| 车道 | 跑完 | 有召回的轮 | 标注率 | 精确率 | 召回率 | 编造 id 被丢 | 标题不符 |
|---|---|---|---|---|---|---|---|
| Codex gpt-5.6-sol，开 | 15/23 | 14 | 13/14 | 16/16 | 16/16 | 0 | 0 |
| Codex gpt-5.6-sol，关 | 6/23 | 6 | 3/6（见下） | 4/4 | 4/9 | 0 | 0 |

- 标注：执行代理逐轮读回答，对每条注入的记忆标 是/否/说不清，并附原文摘句（`eval/cite-used/labels.json`）。还没给用户抽查。
- 开的那组里唯一没标的一轮（q15）是对的：注入的是一条无关的 AB_HOME 坑，回答只讲 realpath，确实没用。说不清 1 条（q10 的 8afca8b7），不进分母。
- `ab view` 的引用扫描和人工解析一致：开的那组 16 次引用、0 次标题不符、0 个被丢的 id。
- **关的那组不是干净对照**：Codex 开着工具，会读仓库里的设计文档 §11.8（里面写了 ab-used 格式），于是开关关着也照写（q02、q04、q06）。在 agentbrain 仓库里用带工具的宿主测，开关之外的这条泄漏挡不住。
- 样本：开 14 轮、关 6 轮；有 2 条以上注入的只有 5 轮。所以"16/16"只说明没看到乱标，不能说明精确率就是 100%。
- 回答质量（开/关对比）没做：能当裁判的非 GPT 模型（火山、Claude）额度都用尽，用 GPT 判 GPT 不符合交叉裁判要求。

## 抽查（原文，待用户核对）
1. Codex 开 q09（注入 2 条，标 1 条）：问 hook 超时卡在哪。回答主体是"`stdin` 等不到 EOF……`security` 同步调用最多 3 秒，随后 embedding 又有 3 秒"，末行 `ab-used: hook 每处等待都要有截止时间 (2d6b98cc)`。另一条注入的"hook 必须自己 try/catch"(0246839d) 只被顺带提了一句，没标，判为没用上。
2. Codex 开 q15（注入 1 条干扰，没标）：问 tmpdir 路径断言偶发失败。注入的是"cli.test.ts 写记忆用例要独立 AB_HOME"(090a4f27)，回答讲 `/tmp` 是 `/private/tmp` 的软链、两边 realpath，没有 ab-used 行。判为正确不标。
3. Codex 关 q02（开关关着却标了）：回答末行 `ab-used: 并发测试不用 sleep 赌时序 (3f8e5ce1)；锁持有时间须小于 busy timeout (23e76180)`。这组的召回块和指令文件里都没有引用说明，是读了仓库设计文档学来的。


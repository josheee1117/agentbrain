# Eval 16：ab-used 引用标注（上线前评测，2026-10-22 结果：187 轮；Claude Code 只有开组 9 轮）

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

## 结果（2026-10-22 00:40 SGT，全部车道截止 23:30 后收尾）

跑完的轮数：Pi glm-5.3 开/关 23/23、Pi deepseek-v4-pro 开/关 23/23、opencode 开/关 23/23、Codex 开 23 / 关 17（关组 q18 起额度用尽）、Claude Code 开 9（q01–q09）/ 关 0（会话额度，提示 00:10 重置，截止前没恢复）。没有 `.failed`。两个库各跑一次 `ab view --no-open` 后 `extract_all.py` 汇总成 `summary.json`（187 轮）。

### 引用准确度（开组；分母见表；unclear 不进分母）

| 车道 | 有召回的轮 | 标注率 | 只算有实质回答的轮 | 精确率 | 召回率 | 被丢的 id | 没召回却标 |
|---|---|---|---|---|---|---|---|
| Codex gpt-5.6-sol | 19 | 18/19 | 18/19 | 23/23 | 23/23（unclear 2） | 0 | 0 |
| Claude Code opus | 8 | 8/8 | 8/8 | 9/11 | 9/9 | 0 | 0 |
| Pi glm-5.3 | 20 | 13/20 | 13/14 | 18/18 | 18/20 | 0 | 0 |
| Pi deepseek-v4-pro | 20 | 8/20 | 8/9 | 11/11 | 11/12 | 0 | 0 |
| opencode ark-code-latest | 17 | 5/17 | 5/17 | 7/7 | 7/7 | 24 | 4 轮 |

关组（不该写 ab-used）：Pi glm 0/20、Pi deepseek 0/20、opencode 1 轮（2 个 id，都被丢）、Codex 7/15（读了仓库设计文档学来的，见上一版说明，精确率 8/8）。

- **Pi 的分母要打折扣**：Pi 车道用了 `--no-tools`，但模型常常还是想先看代码，输出"我先看一下……"或一段假的 `<tool_calls>` 文本就结束了。标注时标为没有实质回答（`_nonanswer`）：glm 开组 6 轮、deepseek 开组 11 轮。去掉这些，Pi 两个模型的标注率都很高（13/14、8/9）。这是 harness 的毛病，不是引用指令的毛病；真实使用时 Pi 有工具，不会出现。
- **Claude 的 2 个误标**：q01 把一条它自己在正文里驳斥为"不对"的记忆（f4c6a2e6）也标上了；q02 标了"并发测试不用 sleep"(3f8e5ce1)，正文却说这种写法"在这里用不上"。都是"看过、讨论过但没照做"也算进了用。样本只有 8 轮。
- **opencode 的问题最大**：开组 14 轮写了 ab-used 行，但 id 合法（属于本轮 hook 注入）的只有 5 轮；ab view 丢了 24 个 id，4 轮没注入也写了。逐个核对 33 个 id：7 个是本轮注入的；19 个是库里真实存在、但来自它自己跑的 `ab brief` / `ab search` / `ab get`（opencode 开着工具，一轮里常调几十次 ab）；7 个是正式库的原始 id，它翻到了 harness 目录里的 `seed.json` / `ab-props.json`。没有凭空编的 id。也就是说 opencode 的标注"内容上"大多是对的，但扫描只认 hook 注入的 id，工具查到的一律丢掉；另外 harness 把种子文件放在宿主能读到的地方，是评测本身的泄漏。
- 标题不符：所有车道 0。
- 标注：执行代理逐条标，附原文摘句，脚本核对摘句都是回答原文子串（`labels.json`）。我又复核了全部"标了但标注为没用"和"用了但没标"的 6 处（见抽查）。还没给用户抽查。

### 回答质量（开 vs 关，盲评）

做法：同题开/关两个回答，删掉 ab-used 行，顺序随机（49/86 开组在 A 位），交给不同家族的模型判哪个更有用（`judge.py`，Pi `--thinking max --no-tools`）：glm 的回答由 deepseek 判，deepseek 和 opencode（火山 ark）的由 glm 判，Codex（GPT）的由 deepseek 判。没有 Claude 关组，所以 Claude 不比。一题一判。结果在 `answer-grades.json`。

| 宿主/模型 | 对数 | 开更好 | 关更好 | 平 | 两边都有实质回答的对 |
|---|---|---|---|---|---|
| Pi glm-5.3 | 23 | 11 | 11 | 1 | 13 对：开 8、关 5 |
| Pi deepseek-v4-pro | 23 | 12 | 8 | 3 | 8 对：开 6、平 2 |
| opencode | 23 | 11 | 11 | 1 | 同左 |
| Codex | 17 | 4 | 13 | 0 | 同左 |

- Codex 关组明显占优，所以又用 glm 换顺序重判了一遍（`answer-grades-codex-2.json`）：开 6、关 9、平 2。两个裁判一致 12/17，其中 9 对都判关更好、3 对都判开更好。理由多是"关组那份更全、多给了一步"；关组回答中位长度 625 字，开组 556 字，裁判说长度不算优点，但难说没影响。还有一个混杂因素：Codex 开组大多是 16 点前跑的，关组多在 20:51 额度重置后跑，同一模型不同时段。所以 Codex 这项只能说"有变差的迹象，没坐实"。
- 其它三条车道开关各有胜负，看不出差别。裁判误差按 eval 14 的经验大约和这个差距同一量级。
- 位置偏差：判 A 42 次、B 39 次、平 5 次，没有明显偏向。

## 抽查（原文，待用户核对）
1. Pi glm 开 q10（注入 3 条，标 2 条）：问 recall 复用 searchHybrid 的风险。正文第 1 点"`searchHybrid` 会吞掉 embedding 异常并降级为纯 FTS"，第 2 点"纯向量 86.7%，门槛 0.45 下仍有 33.3%"，第 3 点"检索按相关度排序而非插入时间"。末行 `ab-used: recall 不能直接复用 searchHybrid（degraded 静默降级）(5844f8eb); ab-used: 向量检索负例误报率高，门槛选择需分场景 (8afca8b7)`。第 3 点用了 a5fb524e 却没标（漏标 1 条），另外一行里写了两次 `ab-used:`，扫描照样认出两个 id。
2. Claude Code 开 q01（注入 3 条，全标）：正文写"召回里'用坑或事实'不对，事实也进不了正文"，以代码为准驳斥了 f4c6a2e6，末行却仍写 `brief 验证别用决定类 (f4c6a2e6)`。判为误标（看过但没照做）。
3. opencode 开 q22（注入 2 条无关的，都没用）：问 Pi 扩展 hook 的坑，回答列了 6 条，内容都对得上库里的记忆，末行 `hook 子命令要 try/catch (0246839d)；EPIPE 要监听 error 事件 (6dd4bcfa)；…；Pi 不热重载配置 (fb6ea8c4)` 共 7 个 id，只有 0246839d 在库里，其余 6 个是它从 harness 种子文件里读到的正式库 id。扫描全丢，本轮记为"没标"。
4. Pi deepseek 开 q16：整条回答是 `<system-message></system-message>`，没有实质内容（Pi `--no-tools` 下的典型坏轮）。

## 结论与建议
- 在"一轮只有 hook 注入、模型不自己查库"的宿主上（Codex、Pi、Claude），引用行基本可信：标了的几乎都真用了（Codex 23/23、glm 18/18、deepseek 11/11），唯一的误标模式是 Claude 把讨论过、驳斥过的记忆也算进去。
- opencode 不行：它会自己调 `ab search/get`，标的 id 大多不在本轮注入记录里，扫描丢掉后标注率只剩 5/17。要么扫描也接受本会话里 `ab get/search` 返回过的 id，要么指令里只让它标召回块里的条目。
- 回答质量：Pi、opencode 看不出影响；Codex 两个裁判都偏向关组，但有时段和长度的混杂，样本 17 对。
- 建议先不默认打开。可以只对 Codex/Claude/Pi 打开、opencode 保持关，并补一轮：Claude 关组 + 开组剩下 14 题、Codex 关组剩下 6 题（q18–q23）同一时段跑、Pi 用带工具的模式重跑、种子文件挪出宿主可读目录。cite 开关保持关。

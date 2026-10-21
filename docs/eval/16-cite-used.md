# Eval 16：ab-used 引用标注（上线前评测，**Pi harness 就绪，模型运行等额度**）

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
| Claude Code | 待填 | 已配置的模型（待填） | 最高 | 待填 |
| Codex | 待填 | 已配置的模型（待填） | 最高 | 待填 |
| opencode | 待填 | 已配置的模型（待填） | 最高 | 待填 |

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

## 结果
（Pi 未出结果：额度用尽）

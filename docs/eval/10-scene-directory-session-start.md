# 10. 场景目录与开工背景（PR #56，2026-10-15）

## 问题
会话开头 `ab brief` 只能放约 2000 字符：data-asset 有 175 条、ai-data 有 121 条，大多数会被隐藏。如果在 brief 里加一个"场景目录"（场景标题加编号，用 `ab scene <编号>` 看原条目），agent 开工时能不能答出项目背景问题？和"看完 brief 再跑一次 `ab search`"比，哪个更好？

## 实现（被评对象）
PR #56（`feat/scene-directory`，提交 702a2b5、8a6d5a1、11498fe）：
- 只分组、不改写。场景 = 标题 + 成员 id，存在 index.db（L3，可重建）。
- 分组方法：向量 average linkage 聚类，加场景二字词奖励 0.15，`SCENE_LINK_MIN` = 0.5。模型只负责起标题。
- 成员关系沿 superseded_by 和 merged_into 跟随到最新条目。
- brief 里的目录上限 600 字符。
- 对应的 Mac 测试 236/236 通过，tsc 通过。

## 数据
- `eval/scene-directory/questions.json`：46 道题，data-asset 18、ai-data 18、insuranceagent 10。
  - 抽样：每个项目按"kind × 是否确认"分层，固定种子 20261015 轮转抽样，先取 2 倍候选。
  - 出题：模型（deepseek-v4.1-flash）判断这条是否属于"开工背景"，是的话改写成开工时会问的问题，并给出标准答案和 1～3 个关键点。不相关的丢掉（见 `genq.log`：36→18、36→18、20→10）。
  - 划分：按题号 `k % 3 == 2` 为 test（15 题），其余 31 题为 tune（用来选 `SCENE_LINK_MIN`）。
  - 题目和答案由模型生成，执行者抽查过，用户没有逐条标注。
- 库：10-15 Mac 真实库的只读快照（未提交）。

## 方法
- `eval/scene-directory/evalscene.ts <home> <split|all> <out.json> [--search]`，对每题比较：
  1. **只看 brief**：baseline brief 对比带目录的 brief；
  2. **选场景命中**：模型只看目录，选一个场景，看 gold 是否在这个场景里；
  3. **打开覆盖**：brief 加上打开所选场景的原条目；
  4. **对照**：baseline brief 加上用题目跑一次 `ab search`。
- 评分员是 deepseek-v4.1-flash，只根据上下文打 0 / 0.5 / 1 分（提示词见脚本里的 GRADE）。
- 其余脚本：`genq.ts`（出题）、`common.ts`、`dump.ts`（导出快照条目）。
- 复现（Mac，需要快照目录，以及 PR #56 的 worktree）：
  ```bash
  node genq.ts                                   # 生成 questions.json
  node evalscene.ts <快照home> tune res-L0.5-tune.json
  node evalscene.ts <快照home> test res-L0.5-test.json --search
  ```
  建标题的 token：data-asset 约 8.8k，ai-data 约 7.1k。

## 结果（`eval/scene-directory/results/`）

test（15 题，`SCENE_LINK_MIN` = 0.5）：

| 方案 | 得分 | 上下文字符 |
|---|---|---|
| 只看 baseline brief | 0.167 | 1638 |
| 只看带目录的 brief | 0.200 | 1704 |
| 目录选场景命中率 | 0.533（3 题没选） | — |
| brief + 打开所选场景 | 0.667 | 4283 |
| baseline brief + 一次 `ab search` | 0.767～0.80 | 1337 |
| 两者取较好 | 0.833 | — |

tune（31 题）上选门槛：

| `SCENE_LINK_MIN` | 选中命中 | 打开覆盖 | 打开字符 |
|---|---|---|---|
| 0.45 | 0.613 | 0.71 | 6850 |
| **0.50** | **0.677** | **0.742** | 4403 |
| 0.55 | 0.516 | 0.548 | 3214 |
| 对照：一次 search | — | 0.919 | 1358 |

## 结论与决定（2026-10-15）
- 目录对"只看 brief"几乎没有帮助（0.167→0.200）。打开场景能到 0.667，但仍不如一次 search（0.77～0.80），字符数还是 search 的 3 倍。
- 目录不能替代 search。它的价值只在于"知道有哪些方面"，以及能看到同组的完整原条目。
- 决定：PR #56 搁置，保持开放、不合并，并在 PR 里留言说明。

## 保留意见
- 评测偏向 search：题目由单条记忆改写而来，问题和答案天然落在单条上，正是 search 的强项；而目录要解决的"跨条目概览"问题，这套题没有覆盖。
- test 只有 15 题，评分员是模型。
- 问题和标准答案含项目内部信息，已脱敏。

# 7. 一步式 vs 两步式：窗口重放（PR #54，2026-10-15，**未完成：27/38 个窗口**）

> 状态：**中期结果，未完成**。Claude 周额度在 2026-10-15 16:53 SGT 用完（`You've hit your weekly limit · resets Oct 17 at 1am (Asia/Singapore)`），剩下 11 个窗口（9 个未跑 + 2 个出错）要等 2026-10-17 01:00 SGT 额度恢复后补跑。下面的数字和结论都可能变。

## 问题
话题结束时，下面两种做法哪个更好？
- (A) 两步：现有抽取器（deepseek-v4.1-flash）先抽，再由 Haiku 5.5 max 审稿。
- (B) 一步：Haiku 5.5 max 读窗口，一次完成抽取和判断（新记 / 并入 / 不记），提示词与校验见 `src/onepass.ts`。

另外拿两条"只审稿"的结果做参照：同样这些标签条目，用**原来抽出来的那条候选**直接让审稿人判（不重新抽取）：
- astra v4（`eval/curate/runs/v4b_solo.json`，第 6 篇的 astra 单审）
- Haiku 5.5 max（`eval/curate/runs/haiku.json`，第 6 篇的 haiku 行）

## 数据
- 90 条用户标注（`eval/curate/labels/labels90_relabel.json`）里，能重放的只有自动抽取的条目：extract 47 / manual 22 / import 21。
- extract 里有 42 条能找回原窗口和转录，分布在 38 个窗口。其余条目没有窗口，只能比较判断这一步（见第 6 篇）。
- 近邻只用"该窗口当初抽取之前就已在库里、且来自不同会话"的条目，防止标签条目自己充当近邻。
- **本次已完成 27 个窗口，覆盖 31 条标签条目**：s30 有用 4 / 部分有用 1 / 没用 10；s60 有用 8 / 部分有用 6 / 没用 2。另有 2 个窗口出错（1 个额度用完、1 个连接断开 ECONNRESET），9 个未跑。

## 方法
1. 重放（Mac 上，在 PR #54 分支的工作区跑，可续跑，跳过 run1.jsonl 里已有的窗口）：
   ```bash
   node scripts/replay-eval.ts ~/.agentbrain/eval/labels90_relabel.json ~/.agentbrain/eval/replay/run1.jsonl --conc 3
   ```
   每个窗口分别跑 A 和 B，记录产出、耗时、Haiku 费用。
2. 匹配：用匹配员（Haiku）判断每条产出对应原来的哪条标签条目。重放时用 low 档；之后用 high 档二次匹配覆盖（可续跑）：
   ```bash
   AB_HOME=~/.agentbrain/eval/h_replay node scripts/replay-rematch.ts ~/.agentbrain/eval/replay/run1.jsonl ~/.agentbrain/eval/replay/rematch_high.json
   ```
   high 二次匹配只覆盖了前 18 个窗口（也是额度用完而停）；另外 9 个窗口仍是 low 匹配结果。在两档都有结果的 38 条标签引用上，low 和 high 有 2 条不一致（各一个方向）。
3. 打分口径（`eval/onepass-replay/compare.py`）：
   - A/B：标签条目被某条产出匹配上（新记或并入都算）= 留下；没匹配上 = 没进库。
   - 只审稿：审稿结论 admit=true（含并入）= 留下。
   - "总对"= 有用/部分有用被留下 + 没用被挡掉。四种做法用同一批 31 条。
4. 复现（仓库内数据即可，不需要私有转录）：
   ```bash
   python3 eval/onepass-replay/compare.py eval/onepass-replay/run1-meta.json eval/onepass-replay/rematch_high.json \
     eval/curate/labels/labels90_relabel.json eval/curate/runs/v4b_solo.json eval/curate/runs/haiku.json
   python3 eval/onepass-replay/score_replay.py <run1.jsonl> eval/onepass-replay/rematch_high.json   # 分 A/B 的明细（需要 jsonl：把 run1-meta.json 的数组逐行写出即可）
   ```
   仓库内的 `run1-meta.json` 去掉了 A 路径抽取出的原始候选正文（`A.cands`），出错信息里的本机路径换成 `<path>`；用它和用 Mac 上的私有 `run1.jsonl` 跑 compare.py，输出逐字相同（已核对）。

## 中期结果（27 个窗口，31 条标签条目）

### 全部
| 做法 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |
|---|---|---|---|---|
| A 两步（flash 抽 + Haiku 审） | 2/12 | 6/19 | 10/12 | 16/31 |
| B 一步（Haiku 抽+判） | 7/12 | 10/19 | 12/12 | **22/31** |
| 只审稿 astra v4（原候选） | 10/12 | 16/19 | 7/12 | 23/31 |
| 只审稿 Haiku max（原候选） | 12/12 | 17/19 | 5/12 | 22/31 |

### s30（15 条，其中没用 10）
| 做法 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |
|---|---|---|---|---|
| A 两步 | 2/4 | 3/5 | 8/10 | 11/15 |
| B 一步 | 4/4 | 5/5 | 10/10 | **15/15** |
| 只审稿 astra v4 | 4/4 | 5/5 | 5/10 | 10/15 |
| 只审稿 Haiku max | 4/4 | 4/5 | 3/10 | 7/15 |

### s60（16 条，其中没用 2）
| 做法 | 有用留下 | 有用+部分有用留下 | 没用挡掉 | 总对 |
|---|---|---|---|---|
| A 两步 | 0/8 | 3/14 | 2/2 | 5/16 |
| B 一步 | 3/8 | 5/14 | 2/2 | 7/16 |
| 只审稿 astra v4 | 6/8 | 11/14 | 2/2 | 13/16 |
| 只审稿 Haiku max | 8/8 | 13/14 | 2/2 | **15/16** |

### 产出与成本（27 个窗口）
| 做法 | 产出条数 | 其中并入 | 空产出窗口 | Haiku 费用 | 每窗口平均耗时 |
|---|---|---|---|---|---|
| A 两步 | 47 | 6 | 4 | $0.49（不含 flash 抽取） | 284 s |
| B 一步 | 46 | 4 | 3 | $0.93 | 273 s |

## 中期结论（可能随补跑改变）
1. **一步走比两步走好**：总对 22/31 对 16/31；s30 15/15 对 11/15，s60 7/16 对 5/16。两步走主要输在 flash 抽取漏掉有用内容（有用留下 2/12），审稿救不回来没抽出来的东西。
2. **s60 上两种重放都输**，原因不在判断，而在**重新抽取时漏掉了用户标成有用的记忆**：同一批条目，只把原候选交给审稿人判，Haiku 15/16、astra 13/16；重放后 B 只有 7/16、A 只有 5/16。短板是抽取召回，不是把关。
3. **只审稿的 Haiku 太松**：s30 的 10 条没用只挡住 3 条（astra 挡住 5 条）。所以"Haiku 只当审稿人"不能直接替代 astra。
4. B 的"没用挡掉 12/12"要打折看：B 整体抽得少（46 条产出、3 个空窗口），挡住没用的部分原因是它本来就没抽到，而不是识别出"没用"。s60 只有 2 条没用，样本太小。
5. 成本：B 的 Haiku 费用约为 A 的 2 倍（A 另有 flash 抽取费用未计入），耗时相当。

## 决定
- 暂不定。补跑剩下 11 个窗口、并把 high 二次匹配补齐到全部窗口后再定。
- 如果结论不变，下一步该提高**抽取召回**（例如抽取时把整段话题窗口和更多前文给模型、提示词里明确"宁可多提候选交给判断"），而不是再加审稿层。

## 待补跑（额度恢复后）
```bash
# 1) 续跑重放（自动跳过已完成；出错的 2 个窗口需先从 run1.jsonl 里去掉对应行，备份后再删）
node scripts/replay-eval.ts ~/.agentbrain/eval/labels90_relabel.json ~/.agentbrain/eval/replay/run1.jsonl --conc 3
# 2) 续跑 high 二次匹配
AB_HOME=~/.agentbrain/eval/h_replay node scripts/replay-rematch.ts ~/.agentbrain/eval/replay/run1.jsonl ~/.agentbrain/eval/replay/rematch_high.json
# 3) 重新打分并更新本文与 run1-meta.json / rematch_high.json
```

## 保留意见
- 匹配员本身是模型，会判错；目前 9 个窗口还是 low 档匹配。
- 31 条样本小，s60 的"没用"只有 2 条。
- 窗口转录和候选原文是私有内容，只在 Mac `~/.agentbrain/eval/replay/`。

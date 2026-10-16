# 11. 话题窗口 vs 48000 字窗口（§8.6 验收，PR #59，**待跑：pending-run**）

> 状态：**方法和脚本已就绪，正式结果待跑**（2026-10-16）。§8.6 的新触发（话题结束时一步式沉淀）默认关闭；本评测和 `docs/eval/07` 补跑完、且话题窗口在"有用留下"上明显更好，才由用户决定是否打开开关。
> 下面"试跑"一节如有数字，只是用**非 Claude 模型**（pi `openai-codex/gpt-6-astra`）跑的少量会话，用来确认脚本能跑、估算花费，**不是**按 §8.6 设定的 Claude Haiku 的结果，不能当结论用。

## 问题
§8.6 把"按 48000 字切窗口、30 分钟静置后抽取"改成"一个话题结束（相邻两轮间隔 ≥20 分钟、压缩、会话结束）时，把整个话题连同前面一点背景交给一步式模型"。要回答：同一个一步式模型、同一套提示词，**只换窗口切法**，用户标成"有用"的记忆留下的更多吗？"没用"的挡住的少了吗？花费和耗时怎么变？

## 数据
- 用户标注 90 条（`eval/curate/labels/labels90_relabel.json`）中，自动抽取（origin=extract）且能找回原窗口和转录的 42 条，分布在 **33 个会话、38 个原窗口**（和 `docs/eval/07` 同一批）。
- 库：Mac 上 `~/.agentbrain/eval/h_replay` 的副本（`sqlite3 .backup` 到 `~/.agentbrain/eval/h_topic`），**不碰正式库**；转录读本机原文件（只读）。
- 近邻：只用"原窗口当初抽取之前就在库里、且不是同一会话"的条目（同 `docs/eval/07`，防止标签条目自己当近邻）。一个话题窗口跨多个原窗口时，取其中最早的截止点（更严）。

## 方法（`scripts/topic-eval.ts`）
1. 对每个会话：
   - **L 原窗口**：用旧切法 `chunk()`（48000 字）把当初那个窗口原样重切出来（按 window_id 找，找不到按结束锚点找）。
   - **T 话题窗口**：整份会话按 `topicChunks()` 切（相邻两轮时间戳差 ≥20 分钟断开；会话视为已结束，最后一段收尾；超过 120000 字的话题拆成 k/n 段；前面带 ≤8 轮 / ≤6000 字背景）。取和原窗口有重叠的话题窗口；同一个话题窗口只跑一次，被几个原窗口共用。
2. 两边用**同一个**一步式模型、同一套提示词（`src/onepass.ts`，`prompt_version` 记在结果里），没信号的窗口按产品逻辑跳过（`hasExtractableSignal`）。
3. 匹配：参考 = 原窗口里的标签条目 + 同窗口其他原抽取条目；产出 = L（该原窗口的产出）或 T（所有重叠话题窗口产出的并集）。匹配员提示词和 `docs/eval/07` 的 high 二次匹配相同。匹配员输出不合法时整窗记 `match_invalid`，不计分（不当成"没匹配上"）。
4. 打分口径（同 `docs/eval/07`）：标签条目被某条产出匹配上（新记或并入都算）= 留下；"总对"= 有用/部分有用被留下 + 没用被挡掉。只计 L、T 都跑完的窗口。另报每边调用次数、平均窗口字数、平均每次耗时。
5. 已知局限：
   - 历史转录里没有当时的压缩标记（PreCompact hook 是这次才加的），所以 T 只按时间间隔和会话结束切，压缩边界不在本评测内。
   - T 把会话当成已结束；生产里最后一个话题要等 transcript 静置 20 分钟或会话结束，切出的话题一样，只是时间晚。
   - T 的产出是"重叠话题窗口的并集"，话题窗口可能比原窗口大（多看到前后文），也可能比原窗口小（原窗口被拆成多个话题）——这正是要比的东西。
   - 每个条件只跑一次，同一模型多次跑会有波动；差 1–2 条不算有区别。

## 怎么跑
```bash
# Mac，PR #59 分支的工作区（~/code_me/agentbrain-topicx），库副本：
AB_HOME=~/.agentbrain/eval/h_topic node scripts/topic-eval.ts \
  ~/.agentbrain/eval/labels90_relabel.json ~/.agentbrain/eval/topic/<run>.jsonl \
  --model claude:haiku@max --matcher claude:haiku@high --allow-claude --conc 2     # §8.6 设定的模型（需 Claude 额度）
# 非 Claude 试跑（默认）：--model pi:openai-codex/gpt-6-astra@max --matcher pi:openai-codex/gpt-6-astra@high --conc 1
node scripts/topic-eval.ts --score ~/.agentbrain/eval/topic/<run>.jsonl ~/.agentbrain/eval/labels90_relabel.json
```
可断点续跑（按会话跳过已完成的）；额度用完写 `QUOTA` 行、退出码 3。

## 结果
待跑（正式结果要用 Haiku 5.5 max，等 Claude 额度 2026-10-17 01:00 SGT 恢复、且 `docs/eval/07` 补跑之后）。

## 试跑（非 Claude，仅用于确认脚本和估算花费）
（见下）

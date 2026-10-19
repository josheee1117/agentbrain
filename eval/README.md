# eval/：评测数据与脚本

每个子目录对应 `docs/eval/` 里的一篇评测记录，说明见 [docs/eval/README.md](../docs/eval/README.md)。

| 目录 | 对应记录 | 内容 |
|---|---|---|
| `retrieval-v1/` | 01 | 53 条语料、121 条查询（评测脚本是仓库内的 `scripts/eval-retrieval.ts`） |
| `recall/` | 02 | 95 条查询与 gold、eval/sweep/diag 脚本、4 个版本的结果、条目元数据（不含正文） |
| `oneoff/` | 03 | sample48、heldout160、打分脚本、#40～#42 独立评估报告 |
| `value-gate/` | 05 | sample30 + 用户标签、fresh30 标签、复判输入与输出、gate/replay 脚本 |
| `curate/` | 06 | 标注（labels90、改标版、s60 样本）、各次运行的压缩结果、批量脚本、`scores.md` |
| `onepass-replay/` | 07 | 已跑 5 个窗口的元数据、打分脚本（未完成） |
| `graph-1hop/` | 08 | 模拟脚本、关系边（只有 id）、输出 |
| `scene-sim/` | 09 | 模拟脚本与输出 |
| `scene-directory/` | 10 | 出题与评测脚本、46 道题、结果（去掉了 brief 全文） |
| `recall-misses/` | 12 | 42 条标签的元数据与各做法结果（`items.json`，无正文）、同窗口追问与召回版提示词试跑的结果（去掉原始输出，产出正文已脱敏）、新条目人工复核、`probe.ts`、`analyze.py` |
| `lib/` | — | `scrub.py`（脱敏）、`collect.py`（从本地工作目录收集并脱敏，记录了数据来源） |

## 约定
- 所有文件都经过 `lib/scrub.py` 脱敏。检查命令：
  ```bash
  python3 eval/lib/scrub.py --check $(find eval -type f ! -path 'eval/lib/*')
  ```
  命令什么都不输出、退出码为 0 即为通过。
- 没有提交的内容：库快照、完整记忆导出、embedding 缓存、会话转录。它们只在本地：box 的 `/workspace/agentbrain-review/`，Mac 的 `~/.agentbrain/eval/`。
- 脚本里的路径是当时工作目录的路径，复跑前要改。

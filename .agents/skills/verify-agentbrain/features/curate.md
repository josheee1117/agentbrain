# ab curate / review (未确认条目审稿与到期复审)

## Sub-features
- 未确认条目的审稿建议 (`ab curate [--apply] [--host <claude|codex|pi|opencode>] [--limit N]`)：审"未确认的有效条目"，给出留下/改写/并入/丢弃；默认 dry-run 只写报告，`--apply` 才写库
- 审稿回滚 (`ab curate --undo <run>`)：撤销本批打的 guidance 标记、归档和改写生成的新条目
- worker 原话审计 (`ab audit worker-quotes [--apply]`)：找出只靠 worker 派活提示当"用户原话"的条目，`--apply` 撤销其自动转正
- 到期条目复审清单 (`ab review [--limit N] [--archive <id 前缀…> | --archive --all]`)：未确认、过了预计有效期、期间没被注入过的条目；`--archive` 归档，可撤销
- 旧候选区条目迁移对照 (`AB_HOME=<库或副本> node scripts/staging-report.ts [--json]`)：只读列出旧版本写成候选或被 `ab stage` 移进候选区的条目，现在是什么状态、能不能进召回

## How to get to it (user POV)
- 手动跑 `ab curate` 看未确认条目的审稿报告（默认 dry-run 不写库）；认可结论再 `ab curate --apply`
- 误判时用 `ab curate --undo <run>` 一键撤销那次运行
- 升级后核对旧候选条目用 `scripts/staging-report.ts`（只读，跑几遍结果一样）
- 看过期未确认条目用 `ab review`

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts review`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts audit worker-quotes`
- `env AB_HOME="$AB_HOME" node scripts/staging-report.ts`（verify.sh 先往临时库塞一条旧候选事件）
- Proof: review 打印到期清单或"没有到期待复审的条目"；audit 打印撤销/需复核条数；staging-report 打印旧候选条目数与升级后状态

## Gotchas
- `ab curate` 真正评判要 `review.json` 里的主审/评审团模型（API 或宿主 CLI 额度）；没有配置时只验证参数和错误消息，本技能不驱动真实审稿
- 2026-10-22 起没有候选区（§8.8）：`ab stage`、`ab audit agent-remember`、`ab remember --direct`、`AB_STAGING` 都已删除；审稿"留下"不再写状态事件，只在认定是干活偏好时打 guidance
- 用户确认过的条目不被审稿改动；`ab review` 永远不列已确认条目
- 审稿“改写”生成的新条目不带 `model` / `prompt_version`（范围例外，§8.10）：`ab get` 显示「未记录」，不是 bug
- 审稿只动未确认条目；`--apply` 在主审或参考成员连不上、或评审团不满 3 家时被忽略，只在报告里注明，不悄悄退化

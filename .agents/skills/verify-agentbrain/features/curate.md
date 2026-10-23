# ab curate / review (候选区审稿与生命周期管理)

## Sub-features
- 候选区自动与人工审稿 (`ab curate [--apply] [--host <claude|codex|pi|opencode>] [--limit N]`)
- 审稿回滚 (`ab curate --undo <run>`)，整批撤销审稿转正与改写操作
- 候选区分期暂存与撤销 (`ab stage <id...> [--undo]`)
- 历史条目审计 (`ab audit worker-quotes [--apply]`, `ab audit agent-remember [--apply]`)
- 到期条目复审清单 (`ab review [--limit N] [--archive ...]`)

## How to get to it (user POV)
- 定期运行 `ab curate` 查看候选区命题的审稿报告（默认 dry-run 只写报告）；确认无误后执行 `ab curate --apply` 写入正式库
- 出现误判时使用 `ab curate --undo <run>` 一键还原
- 查看即将过期且未被使用的未确认条目使用 `ab review`

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts review`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts audit worker-quotes`
- Proof: 退出码 0，输出待复审列表或审计报告

## Gotchas
- `ab curate` 真实评判需要配置 `review.json` 中的主审或评审团模型（API 或宿主 CLI 额度）
- 用户确认过的条目（confirmed）不受审稿或到期复审影响，永不被自动归档或撤销

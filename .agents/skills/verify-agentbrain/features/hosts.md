# hosts (真实宿主隔离闭环)

## Sub-features
- 一个驱动 `hosts.ts` 跑 Claude Code、Codex、Pi、opencode 的真实宿主闭环，`scripts/` 下不再留重复脚本
- 每个场景独立会话：宿主钩子把会话登记进测试库，shell 里的 `ab` 经 PATH 里的包装器继承 `AB_HOME` / `AB_REGISTRY`
- 场景：`search-used`、`preference`、`unused`、`unreported`、`empty-search`；Pi 另有 `progress-then-model-error`（本机 mock 提供商：先回工具调用，再全部 429）
- 逐场景断言：宿主退出码、`memory_reports` 的 status / queried / cite、`memory_report_ids` 的 verified
- 正式库核对：`sqlite3 -readonly ~/.agentbrain/store.db` 查本次所有测试会话 id，计数必须全为 0

## How to get to it (user POV)
- `.agents/skills/verify-agentbrain/verify.sh hosts [claude codex pi opencode]`，参数留空跑全部宿主

## Driving it with verify.sh
- `verify.sh hosts pi`
- Proof: 每个场景打印 PASS；`summary.json` 的 status 为 `PASS`（有 BLOCKED 时 `PASS_WITH_BLOCKED`）；证据目录里有每场景的 `.log`、`-sql.json`、`-sweep.log` 和 `production-isolation.json`

## Gotchas
- 宿主必须已登录：opencode 的 401 记 BLOCKED，不算失败；Codex 官方账号额度用完时，驱动改用本机 `~/.pi/agent/models.json` 里的本地网关（`codex exec` 的 `session_meta` 是 `source=exec`，会被认作 worker 会话，所以验证偏好要带 `--for-workers` 才能注入）
- Codex 沙箱必须是 `danger-full-access`：`workspace-write` 下 `ps` 被禁，`ab` 认不出宿主会话，交付记录会缺 host / session
- Pi 退出时自己拉起的 `ab work --session` 会占着租约，驱动会等它放掉再 sweep
- 证据目录是 `~/.cache/verify-evidence/agentbrain/<时间戳>-hosts/`

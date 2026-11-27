---
name: verify-agentbrain
description: "Verify agentbrain, the local agent-memory CLI (`ab` = node src/cli.ts). Use after changing src/*.ts or CLI behavior."
---

# verify-agentbrain

Every agent must use this to verify changes before calling them done. 改动必须先用本技能验证、附证据，才算完成。

## Launch
CLI, no server. Requires node >=22.18 (runs .ts natively). Isolate with scratch HOME, AB_HOME, AGENTBRAIN_HOME and AB_REGISTRY. Never point at ~/.agentbrain or real host session directories. `verify.sh run` sets all four before running tests and provides a fixture security command for local HTTP mocks.

A fully isolated HOME hides the keychain. The local embedding server in `verify.sh run` still reads `agentbrain-embedding` through `security`. Put a scratch `security` on PATH that returns `fixture-key` only for that service, following `src/llm.test.ts`. No real key is needed. Do not use this stub for real-model verification.

## Doctor
`.agents/skills/verify-agentbrain/verify.sh doctor` — read-only; JSON lines. Run first whenever anything looks off.

## Drive
`verify.sh run`: `npm test` (node --test src/*.test.ts), `npm run typecheck`, then drives the real CLI in isolated scratch environments:
- `cli-status`: `status` and `status --line`, plus the 抽取模型 line from `status` under a scratch `extract.json` with and without a valid `extraBody`
- `cli-memory`: `remember` (confirmed and unconfirmed), `confirm`, `search`, `get`, and `get` after seeding an `evidence` event that carries `model` / `prompt_version` (asserts the 模型产出记录 block, and that a hand-written entry has none)
- `cli-conflicts`: `src/conflicts.test.ts` drives real `get`, `search`, `brief`, `status`, `archive`, and `archive --reactivate` against an isolated file-backed store. It asserts multi-pair visibility, reverse reassessment, and lifecycle counts. See [features/conflicts.md](features/conflicts.md).
- `cli-stale-guard`: `src/stale-guard.test.ts` 检查四类确认来源的注入资格、警告预算和草稿退场。`src/stale-cli.test.ts` 的独立 ab-1 顶层用例用隔离库、临时中文 Git 仓库与本地 `/chat/completions` 服务驱动真实 `remember`、`confirm`、`brief`、`recall`、`search`、`get`、`status`、`verify [--ref]`。回读 `verify_attempts`、`verify_queue`、`inject_log` 和 L2，断言决定不自动转正及脏工作区不变。证据为 `cli-stale-guard.log`、`stale-guard/cli-e2e.log`、`stale-guard/mock-requests.json`。`src/codeverify.test.ts` 覆盖 ref 工具、中文路径、文件大小及提交祖先边界。
- `cli-change-verify` / `cli-change-sweep`: `verify --changed <项目>` 扫描、预演、JSON 和持租约同步核验。`cli-change-verify` 只执行 `src/stale-cli.test.ts` 的独立 ab-2 顶层用例，不重复 ab-1。使用临时 Git 仓库、本地 HTTP mock 和隔离库，回读队列、核验记录及工作区，覆盖主干选择、机械预筛、非祖先三分支、20 条上限和默认关闭的每日扫描。证据为 `cli-change-verify.log`、`cli-change-sweep.log`、`change-verify/cli-e2e.log`、`change-verify/mock-requests.json`。见 [features/change-verify.md](features/change-verify.md)。
- `cli-anchors-verify` / `cli-anchors-*` / `cli-backfill-*`: 锚点契约、跨仓 `<repo>:<relpath>` 扫描与入队消费、决定核验不自动转正、以及离线 `scripts/backfill-decision-anchors.ts` 预览与确认写入。见 [features/anchors-decisions.md](features/anchors-decisions.md)。
- `synthesize-unit` / `cli-synthesize-e2e` / `cli-synthesize-*`: `ab synthesize <project> --spec <file>... [--diff-base <ref>] [--dry-run] [--json]` 隔离单测与 CLI 实测（`--dry-run` 零写库与正式写入 `confirmed === false`、`origin === "auto"`、零自动转正/归档）。见 [features/synthesize.md](features/synthesize.md)。
- `cli-lifecycle`: `correct` (old entry shows 已被替代), `archive` + `--reactivate`, `guidance` on/off with `recall --hook` showing and hiding the `<agentbrain-prefs>` block
- `cli-brief`: `brief` before and after confirm, plus `brief --worker` (asserts unconfirmed text stays out until confirm)
- `cli-inbox-*`: `inbox` / `--json` / `--kind` / `--limit` / `--noise` 5 类高信号清单、高注入低引用规则扫描与主会话 `brief` 前 5 条高信号展开、只读零写库（`events`/`inject_log`/`prop_usage` 零增量）。见 [features/inbox.md](features/inbox.md)。
- `cli-scene` & `truth-jit-unit`: 四场景（`design|code|test|review`）、专属性优先 `≤8` 条场景路由 + 按需触发器、`ab tag --on-demand`、`ab relate <id1> <id2> --coexist|--refines` 解除误报冲突。
- `cli-recall-hook`: `recall --hook` via stdin JSON。`cli-agy-worker` 跑 Pi、agy 的共用首轮矩阵和真实 CLI，断言截断路径先规范、身份待定不注主会话偏好；全局规则仍由 `brief --worker` 提供。常驻偏好开关用隔离 agy 完整首轮验证。`cli-agy-session-state` 用真实 CLI 比较 `want_session_state` 的输出差异，覆盖 worker 三态、SYSTEM_MESSAGE 中的 brief、262KB 读头、截断路径规范化，以及三处环境坐标与 `brief` / `recall` 日志对齐。
- `cli-opencode`: opencode SQLite session capture (`capture --hook --host opencode`) and `work --dry-run`
- `cli-agy-cli`: agy session capture from the truncated `transcript.jsonl` path in an isolated `~/.gemini/antigravity-cli`; reads `capture_sessions.transcript` back as `transcript_full.jsonl`, then `work --session … --dry-run` (待处理窗口 1) and `status` (`agy CLI: 日志 1（可抽 1），已登记 1，只靠 sweep`).
- `cli-agy-ide`: the same drive under `~/.gemini/antigravity` with a `conversation_summaries.db` row; asserts the hook registers the IDE root's full log, the dry-run window, and `status` showing `agy IDE:` with 日志 1、可抽 1、已登记 1.
- `cli-agy-t3`: two isolated `~/.t3/userdata/providers/antigravity/<实例>/antigravity-acp` roots, each with `brain/` and summaries; each capture plus dry-run line, and `status` lists one independent `agy T3 <前 8 位>:` line per instance (日志 1、已登记 1 each).
- `cli-agy-conflict`: the same id has full logs in both the CLI and IDE roots; `work --sweep` reports 在多处有完整日志，已跳过, `capture_sessions` stays at 0 rows, and `status` marks both root lines 冲突 plus a single 要处理 entry.
- `cli-agy-roots` drives the real `work --sweep` in isolated CLI, IDE and T3 directories, then asserts three capture rows and three dry-run windows. It also covers empty instances, missing metadata, unreadable databases, symlink escape, the seven-day window and cross-root conflicts. `cli-agy-status` drives real `status`, `doctor` and `status --line` in four isolated roots. It checks per-root counts, plugin sources, zero-registration warnings, deleted and unregistered directories, missing metadata, unreadable logs and databases, conflicts, and unchanged source files and capture rows. `cli-agy-locate` covers root hints, unique candidates, conflicts, unwritten canonical paths and IDE process-chain replay. It drives real no-path capture and `remember --from-worker` / `get --expand` in isolated directories; a real IDE tool shell still needs a separate run (see [features/agy-host.md](features/agy-host.md)). `cli-agy-path-pin` drives real capture hooks, manual capture and `get --expand` in isolated roots. It asserts unchanged session fields and no `work.log` after conflicting hooks, first-path pinning under concurrent registration, and citation scans using the registered path.
- `cli-agy-denoise`: agy 去噪与唯一定位点回归，包含真实 CLI 在隔离 CLI、IDE、T3 三处根的 `remember --from-worker` 和 `get --expand`。断言评论取代助手引用、完成通知不进用户轮、`76#2` 来源定位与原始行计数，以及回跳工具配对隔离。
- `cli-agy-plugin`: `node --test src/agy-plugin.test.ts` 通过 stdin 跑仓库插件。假 ab 覆盖三态、pending 重试、失败和空输出、根与 id 去重；真实 CLI 在隔离 CLI、IDE 目录回读 capture_sessions、inject_log、recall_runs，确认首轮与恢复不重复 brief、待定重试不重复偏好。所有入口隔离 HOME、AB_HOME、AB_REGISTRY、PLUGIN_DATA，不安装测试插件，不改真实 IDE 或 T3 配置。
- `cli-curate`: `review` and `audit worker-quotes`
- `cli-detail`: `remember --body-file/--alternative` → `get` shows body + rejected options → `search` body hint → rule-with-body rejected → `correct` does not copy detail (see [features/detail.md](features/detail.md))
- `cli-cross-*`: cross-project section in `ab search` (other projects' similar entries, sim >=0.65, max 3) using a mock embedding endpoint; asserts it is suppressed for `--project` / `--all` / pm dir / `--scene`, records delivery in `inject_log`, and explains itself when vectors are unavailable (see [features/cross-project.md](features/cross-project.md))
- `cli-attr-*`: attribution display (see [features/attribution.md](features/attribution.md)) — a `project_unresolved` entry is marked 「[归属未定]」 in `ab search` and `ab get`, and `ab get` spells out 「会话在 X，抽取判定归属 Y」 for a successful cross-project attribution
- `cli-view`: `view --no-open --out <evidence>/view.html`
- `cli-backup*` / `cli-restore*` / `cli-purge-refused` / `cli-admin-status` / `cli-admin-perms` / `cli-usage-scoped`: `backup` → `restore` preview → `restore --yes`, `purge` refused without a terminal, the new `status` lines (要处理 / 代码 / 库 / 备份 / 失败窗口), 0700 / 0600 permissions, and per-command usage on a bad flag (see [features/admin.md](features/admin.md))
- `cli-staging-report`: `scripts/staging-report.ts` on a seeded legacy candidate event

Run all: `.agents/skills/verify-agentbrain/verify.sh run` (`--dry-run` prints the commands without running).

## Real hosts
`.agents/skills/verify-agentbrain/verify.sh hosts [claude codex pi opencode]` runs `.agents/skills/verify-agentbrain/hosts.ts` against the real hosts with an isolated test store. It asserts per scenario: host exit code, `memory_reports` status / queried, `memory_report_ids` verified, plus a read-only `sqlite3` check that none of this run's session ids reached `~/.agentbrain/store.db`. Scenarios: `search-used`, `preference`, `unused`, `unreported`, `empty-search`, and (Pi only) `progress-then-model-error` via a local mock provider. Hosts that are not logged in, or that hit quota, are reported BLOCKED rather than FAIL. Evidence: `~/.cache/verify-evidence/agentbrain/<timestamp>-hosts/`. Details and gotchas in [features/hosts.md](features/hosts.md).

## Real hosts, one full round
`.agents/skills/verify-agentbrain/verify.sh team [pi codex claude]` runs `team.ts`: one real session per host against a copy of the production store (brief → build failure → search + get → status → answer), then asserts injection, read-path labels, extraction into the copy with operator and machine on the new events, the new `status` lines, and that nothing reached `~/.agentbrain/store.db`. Costs real model quota. Details in [features/team.md](features/team.md).

## Evidence
Logs per step + JSON status lines land in `/Users/hejiayuan/.cache/verify-evidence/agentbrain/<timestamp>/`. Cite that path. Proof standards: drive the real user path (CLI/HTTP/UI), not internal setters; capture action + resulting state; check side effects; mock only at existing production boundaries (repo fakes). Never use real secrets or prod endpoints from this skill.

## Not locally verifiable (stays unverified until a real-target run)
- Embedding / LLM paths (embed.ts, llm.ts, curate review, work extraction) need real model keys — not run. The model-metadata paths (`model` / `prompt_version` on remember / evidence / relate / verify, and `ab get` showing them) are covered by `src/prompt-version.test.ts`, which drives real `runWork` / `importPensieve` / `applyActions` with a fake chat and then the real `ab get`; `verify.sh run` only asserts the read side against a seeded event.
- Extraction has no request timeout by design (user 2026-10-30), so a hung `ab work` never exits on its own and relies on lease takeover — only observable against a real model endpoint.
- Host integrations beyond the `hosts` driver (installed launchd job, the user's real interactive sessions) — not run.

## Cleanup
`verify.sh run` removes its scratch directories on exit and keeps evidence. `.agents/skills/verify-agentbrain/verify.sh cleanup` removes scratch recorded by older runs; it never kills by process name.

## Feature map
See [features/README.md](features/README.md). Keep it in sync via `/maintain-verification-skill` (weekday daily pass).

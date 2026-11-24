---
name: verify-agentbrain
description: "Verify agentbrain, the local agent-memory CLI (`ab` = node src/cli.ts). Use after changing src/*.ts or CLI behavior."
---

# verify-agentbrain

Every agent must use this to verify changes before calling them done. 改动必须先用本技能验证、附证据，才算完成。

## Launch
CLI, no server. Requires node >=22.18 (runs .ts natively). Isolate with scratch AB_HOME / AGENTBRAIN_HOME (mktemp) — never point at ~/.agentbrain (user's real memory).

A fully isolated HOME hides the keychain. The local embedding server in `verify.sh run` still reads `agentbrain-embedding` through `security`. Put a scratch `security` on PATH that returns `fixture-key` only for that service, following `src/llm.test.ts`. No real key is needed. Do not use this stub for real-model verification.

## Doctor
`.agents/skills/verify-agentbrain/verify.sh doctor` — read-only; JSON lines. Run first whenever anything looks off.

## Drive
`verify.sh run`: `npm test` (node --test src/*.test.ts), `npm run typecheck`, then drives the real CLI in isolated scratch environments:
- `cli-status`: `status` and `status --line`, plus the 抽取模型 line from `status` under a scratch `extract.json` with and without a valid `extraBody`
- `cli-memory`: `remember` (confirmed and unconfirmed), `confirm`, `search`, `get`, and `get` after seeding an `evidence` event that carries `model` / `prompt_version` (asserts the 模型产出记录 block, and that a hand-written entry has none)
- `cli-conflicts`: `src/conflicts.test.ts` drives real `get`, `search`, `brief`, `status`, `archive`, and `archive --reactivate` against an isolated file-backed store. It asserts multi-pair visibility, reverse reassessment, and lifecycle counts. See [features/conflicts.md](features/conflicts.md).
- `cli-lifecycle`: `correct` (old entry shows 已被替代), `archive` + `--reactivate`, `guidance` on/off with `recall --hook` showing and hiding the `<agentbrain-prefs>` block
- `cli-brief`: `brief` before and after confirm, plus `brief --worker` (asserts unconfirmed text stays out until confirm)
- `cli-scene`: `remember --scene`, `brief` index line vs `--scene` section, `tag --scene`, `brief --worker --scene`, `search --scene` (including unconfirmed and the rejected flag combinations)
- `cli-recall-hook`: `recall --hook` via stdin JSON
- `cli-opencode`: opencode SQLite session capture (`capture --hook --host opencode`) and `work --dry-run`
- `cli-agy`: agy session capture from the truncated `transcript.jsonl` path (registered as `transcript_full.jsonl`) and `work --dry-run`. `cli-agy-roots` drives the real `work --sweep` in isolated CLI, IDE and T3 directories, then asserts three capture rows and three dry-run windows. It also covers empty instances, missing metadata, unreadable databases, symlink escape, the seven-day window and cross-root conflicts. `cli-agy-locate` covers root hints, unique candidates, conflicts, unwritten canonical paths and IDE process-chain replay. It drives real no-path capture and `remember --from-worker` / `get --expand` in isolated directories; a real IDE tool shell still needs a separate run (see [features/agy-host.md](features/agy-host.md)).
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
`.agents/skills/verify-agentbrain/verify.sh cleanup` — removes only scratch this script created; never kills by process name; evidence is kept.

## Feature map
See [features/README.md](features/README.md). Keep it in sync via `/maintain-verification-skill` (weekday daily pass).

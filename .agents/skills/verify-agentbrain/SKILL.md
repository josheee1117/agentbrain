---
name: verify-agentbrain
description: "Verify agentbrain, the local agent-memory CLI (`ab` = node src/cli.ts). Use after changing src/*.ts or CLI behavior."
---

# verify-agentbrain (local only, not committed / 仅本地，不提交)

Every agent must use this to verify changes before calling them done. 改动必须先用本技能验证、附证据，才算完成。

## Launch
CLI, no server. Requires node >=22.18 (runs .ts natively). Isolate with a scratch AB_HOME (mktemp) — never point at ~/.agentbrain (user's real memory).

## Doctor
`.agents/skills/verify-agentbrain/verify.sh doctor` — read-only; JSON lines. Run first whenever anything looks off.

## Drive
`verify.sh run`: `npm test` (node --test src/*.test.ts), `npm run typecheck`, then drives the real CLI with AB_HOME=<scratch>: `node src/cli.ts status`.

Run all: `.agents/skills/verify-agentbrain/verify.sh run` (`--dry-run` prints the commands without running).

## Evidence
Logs per step + JSON status lines land in `/Users/hejiayuan/.cache/verify-evidence/agentbrain/<timestamp>/`. Cite that path. Proof standards: drive the real user path (CLI/HTTP/UI), not internal setters; capture action + resulting state; check side effects; mock only at existing production boundaries (repo fakes). Never use real secrets or prod endpoints from this skill.

## Not locally verifiable (stays unverified until a real-target run)
- Embedding / LLM paths (embed.ts, llm.ts, review, work extraction) need real model keys — not run.
- Host integrations (integrations/, launchd) on the user's real Pi/Claude/Codex — not run.

## Cleanup
`.agents/skills/verify-agentbrain/verify.sh cleanup` — removes only scratch this script created; never kills by process name; evidence is kept.

## Feature map
See [features/README.md](features/README.md). Keep it in sync via `/maintain-verification-skill` (weekday daily pass).

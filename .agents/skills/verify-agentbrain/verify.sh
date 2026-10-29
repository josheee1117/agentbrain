#!/usr/bin/env bash
# verify-agentbrain control script. Usage: verify.sh doctor|run|hosts [claude codex pi opencode]|cleanup [--dry-run]
# Output: one JSON object per line. Evidence: /Users/hejiayuan/.cache/verify-evidence/agentbrain/<ts>/ (survives cleanup).
set -u
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"; cd "$ROOT"
TS=$(date +%Y%m%d-%H%M%S); EV="/Users/hejiayuan/.cache/verify-evidence/agentbrain/$TS"; DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
emit(){ printf '{"step":"%s","status":"%s","detail":"%s"}\n' "$1" "$2" "$(printf '%s' "$3" | tr '"\n' "' " | cut -c1-300)"; }
step(){ # name cmd...
  local n=$1; shift; mkdir -p "$EV"
  if [ $DRY = 1 ]; then emit "$n" dry-run "$*"; return 0; fi
  if "$@" >"$EV/$n.log" 2>&1; then emit "$n" pass "$(tail -3 "$EV/$n.log")"; else emit "$n" fail "$(tail -5 "$EV/$n.log")"; FAIL=1; fi; }
FAIL=0
case "${1:-}" in
  doctor)
    v=$(node -v); emit node info "$v"
    [ -d node_modules ] && emit deps pass node_modules || emit deps fail "run npm ci"
    node -e 'require("node:sqlite")' 2>/dev/null && emit sqlite pass "node:sqlite available" || emit sqlite fail "node:sqlite missing"
    ;;
  run)
    step unit npm test
    step typecheck npm run typecheck

    # Isolate with scratch directory (resolve canonical path to satisfy opencode canonical DB check)
    S=$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/verify-ab-XXXXXX")")
    echo "$S" > "${TMPDIR:-/tmp}/verify-agentbrain.scratch"

    AB_HOME="$S/ab_home"
    AGENTBRAIN_HOME="$AB_HOME"
    AB_REGISTRY="$S/repos"
    FAKE_HOME="$S/fake_home"
    REPO="$S/test-repo"

    mkdir -p "$AB_HOME" "$AB_REGISTRY" "$FAKE_HOME/.local/share/opencode" "$REPO"
    git -C "$REPO" init -q
    printf -- "- 路径：\`%s\`\n" "$REPO" > "$AB_REGISTRY/testrepo.md"

    # Mock OpenCode SQLite DB
    node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$FAKE_HOME/.local/share/opencode/opencode.db');
db.exec(\`CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);\`);
const now = Date.now();
db.prepare('INSERT INTO session_v2 VALUES(?,?,?,?,?)').run('ses_verify1', '$REPO', null, now - 3600000, now - 3600000);
db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run('msg_1', 'ses_verify1', 'user', 1, now - 3600000, JSON.stringify({ text: '以后做任何改动都要先通过 verify.sh 验证' }));
db.prepare('INSERT INTO session_message VALUES(?,?,?,?,?,?)').run('msg_2', 'ses_verify1', 'assistant', 2, now - 3500000, JSON.stringify({ content: [{ type: 'text', text: '好的，严格执行 verify.sh' }] }));
db.close();
"

    # 1. status / doctor drive
    step cli-status env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" status
    step cli-status-line env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" status --line

    # 2. memory drive (remember / get / search)
    step cli-remember env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" remember --kind rule --text "测试全局规范：验证先于声明完成" --summary "验证规范" --global --confirmed
    ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-remember.log" 2>/dev/null | head -1)
    step cli-get env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" get "$ID"
    step cli-get-text bash -c "grep -qF '验证先于声明完成' '$EV/cli-get.log'"

    # 2b. unconfirmed remember is active and searchable, but stays out of brief until confirm (§8.8 没有候选区)
    drive_remember_unconfirmed(){
      (cd "$REPO" && env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" remember --kind rule --text "未确认测试规则：候选区已取消" --summary "候选区取消验证")
    }
    step cli-remember-unconfirmed drive_remember_unconfirmed
    UNCONF_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-remember-unconfirmed.log" 2>/dev/null | head -1)
    step cli-search env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" search "规范" --all
    step cli-search-unconfirmed env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" search "候选区已取消" --all
    step cli-search-unconfirmed-mark bash -c "grep -qF '[未确认]' '$EV/cli-search-unconfirmed.log'"

    # 3. brief drive (main & worker; unconfirmed stays out of the body until confirm)
    drive_brief(){
      (cd "$REPO" && env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" brief)
    }
    drive_brief_worker(){
      (cd "$REPO" && env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" brief --worker)
    }
    step cli-brief drive_brief
    step cli-brief-pending bash -c "! grep -qF '候选区已取消' '$EV/cli-brief.log'"
    step cli-brief-pending-count bash -c "grep -qF '另有 1 条 agent 自记未确认' '$EV/cli-brief.log'"
    step cli-brief-worker drive_brief_worker
    step cli-brief-worker-text bash -c "! grep -qF '候选区已取消' '$EV/cli-brief-worker.log'"
    step cli-confirm env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" confirm "$UNCONF_ID"
    step cli-brief-confirmed drive_brief
    step cli-brief-confirmed-text bash -c "grep -qF '候选区已取消' '$EV/cli-brief-confirmed.log'"

    # 4. recall-hook drive
    drive_recall_hook(){
      printf '{"prompt":"验证规范","cwd":"%s"}\n' "$REPO" | env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" recall --hook
    }
    step cli-recall-hook drive_recall_hook

    # 5. opencode host drive (capture & work dry-run)
    drive_opencode_capture(){
      printf '{"session_id":"ses_verify1","transcript_path":"opencode://session/ses_verify1","cwd":"%s","hook_event_name":"SessionEnd"}\n' "$REPO" | env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" capture --hook --host opencode
    }
    step cli-opencode-capture drive_opencode_capture
    step cli-opencode-work env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --session opencode:ses_verify1 --dry-run

    # 6. curate / review / audit drive
    step cli-review env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" review
    step cli-audit env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" audit worker-quotes

    # 7. view drive (headless; HTML lands in the evidence dir)
    step cli-view env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" view --no-open --out "$EV/view.html"
    step cli-view-html bash -c "[ -s '$EV/view.html' ] && grep -qF 'agentbrain 记忆看板' '$EV/view.html'"

    # 8. legacy candidate report (read-only) over a seeded old-format event
    step cli-staging-seed node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$AB_HOME/store.db');
db.prepare('INSERT INTO events(id,seq,ts,kind,target_id,session_id,body) VALUES(?,?,?,?,?,?,?)').run('legacycand', 999999, new Date().toISOString(), 'remember', null, null, JSON.stringify({kind:'pitfall',text:'旧候选条目：升级后是有效的未确认条目',summary:'旧候选区迁移',confirmed:false,candidate:true}));
db.close();
"
    step cli-staging-report env AB_HOME="$AB_HOME" node "$ROOT/scripts/staging-report.ts"
    step cli-staging-report-text bash -c "grep -qF '旧候选区条目 1 条' '$EV/cli-staging-report.log'"

    ls -laR "$S" > "$EV/scratch-tree.txt" 2>&1
    emit evidence info "$EV"; exit $FAIL ;;
  hosts)
    # 真实宿主闭环（claude / codex / pi / opencode）：独立测试库 + 逐场景断言 + 正式库只读核对。
    # 需要宿主已登录；401/限额记 BLOCKED。参数留空跑全部宿主。
    shift || true
    mkdir -p "$EV"
    if [ $DRY = 1 ]; then emit hosts dry-run "node .agents/skills/verify-agentbrain/hosts.ts $*"; exit 0; fi
    node .agents/skills/verify-agentbrain/hosts.ts "$@" >"$EV/hosts.log" 2>&1; c=$?
    tail -20 "$EV/hosts.log"
    emit hosts "$([ $c = 0 ] && echo pass || echo fail)" "$EV/hosts.log"
    exit $c ;;
  cleanup)
    # kills nothing by name; only removes scratch dirs this script created. Evidence kept.
    [ -f "${TMPDIR:-/tmp}/verify-agentbrain.scratch" ] && { d=$(cat "${TMPDIR:-/tmp}/verify-agentbrain.scratch"); [ $DRY = 1 ] && emit cleanup dry-run "rm -r $d" || { rm -rf "$d"; rm "${TMPDIR:-/tmp}/verify-agentbrain.scratch"; emit cleanup pass "removed $d"; }; } || emit cleanup pass nothing-to-clean ;;
  *) echo "usage: verify.sh doctor|run|hosts [claude codex pi opencode]|cleanup [--dry-run]" >&2; exit 2 ;;
esac

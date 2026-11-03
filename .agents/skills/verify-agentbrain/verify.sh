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
    step cli-get-no-model bash -c "! grep -qF '模型产出记录' '$EV/cli-get.log'" # 手记条目没有模型产出

    # 2c. 模型产出记录（§8.10）：L1 事件带 model / prompt_version 时 ab get 逐条列出
    step cli-model-output-seed node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$AB_HOME/store.db');
const target = db.prepare(\"SELECT id FROM events WHERE kind='remember' ORDER BY seq LIMIT 1\").get().id;
const source = { host: 'pi', session_id: 's_verify', transcript: null, anchor: null, summary: '合成来源' };
const body = { source, basis: 'observed_failure', evidence: [], window_id: 'w_verify', model: 'qwen-plus', prompt_version: 'abc123def456' };
db.prepare('INSERT INTO events(id,ts,kind,target_id,session_id,body) VALUES(?,?,?,?,?,?)').run('modelev1', new Date().toISOString(), 'evidence', target, null, JSON.stringify(body));
db.close();
"
    step cli-get-model-output env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" get "$ID"
    step cli-get-model-output-text bash -c "grep -qF '模型产出记录' '$EV/cli-get-model-output.log' && grep -qF '追加证据: qwen-plus，提示词版本 abc123def456' '$EV/cli-get-model-output.log'"

    # 2d. extract.json 的 extraBody（§8.10 抽取模型配置）：对象照用，非对象在 ab status 里报错
    step cli-extract-extra-body-ok bash -c "
      H='$S/extra_home_ok'; mkdir -p \"\$H\"; printf '%s\n' '{\"baseUrl\":\"https://x.example/v1\",\"model\":\"m1\",\"keyService\":\"k\",\"extraBody\":{\"reasoning_effort\":\"max\"}}' > \"\$H/extract.json\";
      env AB_HOME=\"\$H\" AGENTBRAIN_HOME=\"\$H\" AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status > '$EV/cli-extract-extra-body-ok.log' 2>&1;
      grep -qF '抽取模型: m1 @ x.example' '$EV/cli-extract-extra-body-ok.log'"
    step cli-extract-extra-body-bad bash -c "
      H='$S/extra_home_bad'; mkdir -p \"\$H\"; printf '%s\n' '{\"baseUrl\":\"https://x.example/v1\",\"model\":\"m1\",\"extraBody\":\"max\"}' > \"\$H/extract.json\";
      env AB_HOME=\"\$H\" AGENTBRAIN_HOME=\"\$H\" AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status > '$EV/cli-extract-extra-body-bad.log' 2>&1;
      grep -qF 'extraBody 必须是对象' '$EV/cli-extract-extra-body-bad.log'"

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

    # 3b. scene tags (§11.10): remember --scene → brief index line → tag 改 → brief --worker --scene
    step cli-scene-remember env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" remember --confirmed --global --for-workers --kind rule --text "场景规范：开发先写测试（verify）" --summary "场景标签" --scene design
    SCENE_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-scene-remember.log" 2>/dev/null | head -1)
    step cli-scene-brief-index bash -c "(cd '$REPO' && env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' brief) > '$EV/cli-scene-brief-index.log' 2>&1; grep -qF '场景规则：设计 1 条；进入该场景先 ab search --scene <场景>' '$EV/cli-scene-brief-index.log'"
    step cli-scene-brief-index-out bash -c "! grep -qF '场景规范：开发先写测试（verify）' '$EV/cli-scene-brief-index.log'"
    step cli-scene-tag env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" tag "$SCENE_ID" --scene design,code
    drive_brief_worker_scene(){
      (cd "$REPO" && env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" brief --worker --scene code)
    }
    step cli-scene-brief-worker drive_brief_worker_scene
    step cli-scene-brief-worker-text bash -c "grep -qF '场景规范：开发先写测试（verify）' '$EV/cli-scene-brief-worker.log'"
    step cli-scene-brief-worker-head bash -c "grep -qF 'worker scene=\"code\"' '$EV/cli-scene-brief-worker.log'"
    step cli-scene-search env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" search --scene code
    step cli-scene-search-text bash -c "grep -qF '场景规范：开发先写测试（verify）' '$EV/cli-scene-search.log'"
    step cli-scene-search-mixed bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search --scene code 测试 >/dev/null 2>&1"
    step cli-scene-search-archived bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search --scene code --archived >/dev/null 2>&1"
    step cli-scene-remember-unconfirmed env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" remember --global --kind rule --text "未确认场景规则（verify）" --summary "场景标签" --scene code
    step cli-scene-search-unconfirmed env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" search --scene code
    step cli-scene-search-unconfirmed-mark bash -c "grep -qE '\[未确认.*\].*未确认场景规则（verify）' '$EV/cli-scene-search-unconfirmed.log'"
    # 边界报错：非 rule 带 --scene、未知场景值、search --scene 配其他 --kind、场景与 guidance 互斥
    step cli-scene-reject-non-rule bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' remember --global --confirmed --kind pitfall --text 坑 --summary 验证 --scene code 2>'$EV/cli-scene-reject-non-rule.log'"
    step cli-scene-reject-non-rule-text bash -c "grep -qF '只能用于规则' '$EV/cli-scene-reject-non-rule.log'"
    step cli-scene-reject-unknown bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search --scene nope 2>'$EV/cli-scene-reject-unknown.log'"
    step cli-scene-reject-unknown-text bash -c "grep -qF '必须是 design|code|review' '$EV/cli-scene-reject-unknown.log'"
    step cli-scene-search-kind bash -c "env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search --scene code --kind pitfall 2>&1 | grep -qF '只列规则'"
    step cli-scene-guidance-conflict bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' guidance '$SCENE_ID' 2>'$EV/cli-scene-guidance-conflict.log'"
    step cli-scene-guidance-conflict-text bash -c "grep -qF '不能同时标成干活偏好' '$EV/cli-scene-guidance-conflict.log'"

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
db.prepare('INSERT INTO events(id,ts,kind,target_id,session_id,body) VALUES(?,?,?,?,?,?)').run('legacycand', new Date().toISOString(), 'remember', null, null, JSON.stringify({kind:'pitfall',text:'旧候选条目：升级后是有效的未确认条目',summary:'旧候选区迁移',confirmed:false,candidate:true}));
db.close();
"
    step cli-staging-report env AB_HOME="$AB_HOME" node "$ROOT/scripts/staging-report.ts"
    step cli-staging-report-text bash -c "grep -qF '旧候选区条目 1 条' '$EV/cli-staging-report.log'"

    # 9. 生命周期：correct / archive / guidance（memory.md）
    step cli-correct env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" correct "$ID" --text "测试全局规范：验证先于声明完成（改后）" --summary "验证规范" --confirmed
    step cli-correct-old-mark bash -c "env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' get '$ID' | grep -qF '（已被替代）'"
    step cli-archive env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" archive "$UNCONF_ID"
    step cli-archive-mark bash -c "env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' get '$UNCONF_ID' | grep -qF '（已归档）'"
    step cli-archive-reactivate env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" archive "$UNCONF_ID" --reactivate
    step cli-archive-reactivated-mark bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' get '$UNCONF_ID' | grep -qF '（已归档）'"
    step cli-guidance env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" remember --kind rule --text "偏好测试：改动后先跑测试" --summary "验证规范" --global --confirmed
    GUIDE_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-guidance.log" 2>/dev/null | head -1)
    step cli-guidance-mark env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" guidance "$GUIDE_ID"
    step cli-guidance-prefs bash -c "printf '{\"prompt\":\"验证规范\",\"cwd\":\"%s\"}\n' '$REPO' | env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' recall --hook | grep -qF '偏好测试：改动后先跑测试'"
    step cli-guidance-off env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" guidance "$GUIDE_ID" --off
    step cli-guidance-off-prefs bash -c "printf '{\"prompt\":\"验证规范\",\"cwd\":\"%s\"}\n' '$REPO' | env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' recall --hook | grep -qvF '偏好测试：改动后先跑测试'"

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

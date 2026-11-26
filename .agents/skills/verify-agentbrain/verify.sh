#!/usr/bin/env bash
# verify-agentbrain control script. Usage: verify.sh doctor|run|hosts [claude codex pi opencode]|team [pi codex claude]|cleanup [--dry-run]
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
    ISOLATED=$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/verify-ab-env-XXXXXX")")
    mkdir -p "$ISOLATED/home" "$ISOLATED/ab" "$ISOLATED/repos" "$ISOLATED/bin"
    printf '#!/bin/sh\ncase "$*" in *agentbrain-extract*|*agentbrain-embedding*) printf fixture-key;; *) exit 1;; esac\n' > "$ISOLATED/bin/security"
    chmod +x "$ISOLATED/bin/security"
    export HOME="$ISOLATED/home" AB_HOME="$ISOLATED/ab" AGENTBRAIN_HOME="$ISOLATED/ab" AB_REGISTRY="$ISOLATED/repos" PATH="$ISOLATED/bin:$PATH"
    unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE PI_SESSION_ID PI_SESSION_FILE PI_INTERCOM_SESSION_ID CLAUDE_SESSION_ID CODEX_SESSION_ID GEMINI_HOME ANTIGRAVITY_APP_DATA_DIR ANTIGRAVITY_CONVERSATION_ID
    trap '[ -z "${XP_PID:-}" ] || kill "$XP_PID" 2>/dev/null || true; [ -z "${ANC_PID:-}" ] || kill "$ANC_PID" 2>/dev/null || true; rm -rf "$ISOLATED"; [ -z "${S:-}" ] || rm -rf "$S"' EXIT
    step unit npm test
    step typecheck npm run typecheck
    step cli-agy-roots node --test src/agy-roots.test.ts
    step cli-agy-status node --test src/status-agy.test.ts
    step cli-agy-locate node --test src/agy-locate.test.ts src/host.test.ts
    step cli-agy-path-pin node --test src/agy-path-pin.test.ts
    step cli-agy-worker node --test --test-name-pattern='Pi、agy|workerIdentity|先规范 agy' src/transcript.test.ts src/transcript-file.test.ts src/cli.test.ts
    step cli-agy-session-state node --test --test-name-pattern='会话状态' src/cli.test.ts
    step cli-agy-plugin node --test src/agy-plugin.test.ts
    step cli-agy-denoise node --test --test-name-pattern='agy 去噪|agy 定位点|agy 三处去噪|assistant_citations' src/agy.test.ts src/extract.test.ts
    step cli-conflicts node --test src/conflicts.test.ts
    step stale-guard node --test src/stale-guard.test.ts src/codeverify.test.ts
    step change-prescreen node --test src/changeverify.test.ts src/registry.test.ts
    step cli-stale-guard env AB1_EVIDENCE="$EV/stale-guard" node --test --test-name-pattern="^ab-1" src/stale-cli.test.ts
    step cli-change-verify env AB1_EVIDENCE="$EV/change-verify" node --test --test-name-pattern="^ab-2" src/stale-cli.test.ts
    step cli-change-sweep node --test --test-name-pattern='ab-2|用前核对排队|§12.6.12' src/work.test.ts
    step anchors-unit node --test src/anchors.test.ts src/backfill-anchors.test.ts
    step cli-anchors-verify env AB1_EVIDENCE="$EV/anchors-verify" node --test --test-name-pattern="^ab-3" src/stale-cli.test.ts

    # Isolate with scratch directory (resolve canonical path to satisfy opencode canonical DB check)
    S=$(realpath "$(mktemp -d "${TMPDIR:-/tmp}/verify-ab-XXXXXX")")

    AB_HOME="$S/ab_home"
    AGENTBRAIN_HOME="$AB_HOME"
    AB_REGISTRY="$S/repos"
    FAKE_HOME="$S/fake_home"
    export AB_HOME AGENTBRAIN_HOME AB_REGISTRY
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

    # 3c. 详情正文与否掉的方案（§8.11）：remember --body-file/--alternative → ab get 顺序 → search 正文提示
    printf '过期 300 秒。\n\n回滚：切回 60 秒。\n' > "$S/body.md"
    drive_remember_detail(){
      (cd "$REPO" && env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" remember --confirmed --kind decision \
        --text "缓存统一 300 秒过期（verify）" --why "10-20 出现缓存雪崩" --summary "缓存选型" \
        --body-file "$S/body.md" --alternative "继续单机内存::多实例下不一致")
    }
    step cli-detail-remember drive_remember_detail
    DETAIL_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-detail-remember.log" 2>/dev/null | head -1)
    step cli-detail-get env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" get "$DETAIL_ID"
    step cli-detail-get-body bash -c "grep -qF '回滚：切回 60 秒。' '$EV/cli-detail-get.log'"
    step cli-detail-get-alt bash -c "grep -qF '继续单机内存：多实例下不一致' '$EV/cli-detail-get.log'"
    step cli-detail-search env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node "$ROOT/src/cli.ts" search "缓存统一" --all
    step cli-detail-search-body bash -c "grep -qF '正文: 过期 300 秒。' '$EV/cli-detail-search.log'"
    step cli-detail-search-hint bash -c "grep -qF \"ab get $DETAIL_ID 看全文\" '$EV/cli-detail-search.log'"
    step cli-detail-rule-body bash -c "! env AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' remember --confirmed --kind rule --text '规则不能带正文（verify）' --summary 'x' --body-file '$S/body.md' >/dev/null 2>&1"
    step cli-detail-correct env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" correct "$DETAIL_ID" --text "缓存改 600 秒（verify）" --summary "纠正" --confirmed
    CORRECT_ID=$(sed -n 's/^已纠正 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-detail-correct.log" 2>/dev/null | head -1)
    step cli-detail-correct-nocopy env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" get "$CORRECT_ID"
    step cli-detail-correct-nocopy-text bash -c "! grep -qF '回滚：切回 60 秒。' '$EV/cli-detail-correct-nocopy.log'"

    # 3d. 跨项目段（§8.11.4）：假 embedding 接口造相似度 → 项目目录出段、四种场景不出
    # 只在本步骤用这个 store，避免假向量污染其他步骤。
    XP_HOME="$S/ab_cross"
    XP_PORTS="$S/xp-port"
    mkdir -p "$XP_HOME"
    cat > "$S/xp-embed.mjs" <<'MOCK'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const sim = (text) => { const m = /SIM([0-9.]+)/.exec(text); const s = m ? Number(m[1]) : 1; return [s, Math.sqrt(Math.max(0, 1 - s * s))]; };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body || "{}");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: (b.input ?? []).map((text, index) => ({ index, embedding: sim(text) })) }));
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
MOCK
    node "$S/xp-embed.mjs" "$XP_PORTS" & XP_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$XP_PORTS" ] && break; sleep 0.3; done
    XP_REPO2="$S/test-repo-2"
    mkdir -p "$XP_REPO2"; git -C "$XP_REPO2" init -q
    # pm 目录 = 清单目录的父目录（isRegistryHome）
    git -C "$S" init -q
    printf -- "- 路径：\`%s\`\n" "$XP_REPO2" > "$AB_REGISTRY/testrepo2.md"
    printf '{"baseUrl":"http://127.0.0.1:%s/v1","model":"cross"}\n' "$(cat "$XP_PORTS")" > "$XP_HOME/embedding.json"
    xp_run(){ env AB_HOME="$XP_HOME" AGENTBRAIN_HOME="$XP_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" "$@"; }
    xp_remember(){ (cd "$1" && xp_run remember --confirmed --kind "$2" --text "$3" --summary "跨项目验证"); }
    step cli-cross-seed-other xp_remember "$XP_REPO2" decision "其他项目的缓存决定 SIM0.92"
    step cli-cross-seed-other2 xp_remember "$XP_REPO2" note "其他项目的指标口径 SIM0.71"
    step cli-cross-seed-other3 xp_remember "$XP_REPO2" note "其他项目的低相似条目 SIM0.30"
    XP_SEED_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-cross-seed-other.log" 2>/dev/null | head -1)
    step cli-cross-seed-own xp_remember "$REPO" decision "本项目的缓存决定 SIM1.0"
    step cli-cross-search bash -c "(cd '$REPO' && env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '缓存怎么选') > '$EV/cli-cross-search.log' 2>&1"
    step cli-cross-search-section bash -c "grep -qF '其他项目里相近的：' '$EV/cli-cross-search.log'"
    step cli-cross-search-hit bash -c "grep -qF \"[$XP_SEED_ID] testrepo2 决定[用户确认]: 其他项目的缓存决定 SIM0.92（0.92）\" '$EV/cli-cross-search.log'"
    step cli-cross-search-threshold bash -c "! grep -qF 'SIM0.30' '$EV/cli-cross-search.log'"
    step cli-cross-search-own-excluded bash -c "! grep -qF '本项目的缓存决定 SIM1.0（' '$EV/cli-cross-search.log'"
    step cli-cross-search-delivered node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$XP_HOME/store.db');
const hit = db.prepare(\"SELECT COUNT(*) AS n FROM inject_log WHERE path='search' AND substr(prop_id,1,8)=?\").get('$XP_SEED_ID').n;
db.close();
if (hit !== 1) { console.error('跨项目段交付记录应为 1 条，实际 ' + hit); process.exit(1); }
"
    step cli-cross-suppressed bash -c "
for a in '--project testrepo' '--all'; do
  (cd '$REPO' && env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '缓存怎么选' \$a | grep -qF '其他项目里相近的：') && { echo \"不该出：\$a\"; exit 1; }
done
(cd '$S' && env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '缓存怎么选') | grep -qF '其他项目里相近的：' && { echo 'pm 目录不该出'; exit 1; }
env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search --scene code | grep -qF '其他项目里相近的：' && { echo '--scene 不该出'; exit 1; }
exit 0
"
    step cli-cross-degraded bash -c "(cd '$REPO' && env AB_HOME='$S/ab_cross_no_embed' AGENTBRAIN_HOME='$S/ab_cross_no_embed' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '缓存怎么选') > '$EV/cli-cross-degraded.log' 2>&1; grep -qF '跨项目段也要算查询向量' '$EV/cli-cross-degraded.log' && ! grep -qF '其他项目里相近的：' '$EV/cli-cross-degraded.log'"

    # 3e. 归属显示（§8.11.3）：project_unresolved 三处标「[归属未定]」；成功跨项目归属 ab get 写清归属
    step cli-attr-seed node -e "
import('$ROOT/src/store.ts').then(({ Store }) => {
  const s = new Store('$XP_HOME/store.db', '$XP_HOME/index.db');
  const here = s.ensureProject('testrepo'), there = s.ensureProject('testrepo2');
  const src = (x) => ({ host: 'pi', session_id: 'verify', transcript: null, anchor: 'u1', summary: x });
  const a = s.remember(here, 'verify', false, { kind: 'decision', text: '归属未定的缓存决定（verify）', why: '当时没确认记到哪个项目', confirmed: false, origin: 'extract', source: src('缓存选型'), value: { flags: ['project_unresolved'] } });
  const b = s.remember(there, 'verify', false, { kind: 'decision', text: '跨项目归属的缓存决定（verify）', why: '单机内存扛不住峰值', confirmed: true, origin: 'extract', source: src('缓存选型'), value: { session_project: 'testrepo', flags: [] } });
  s.close();
  console.log(a.slice(0, 8) + ' ' + b.slice(0, 8));
});
"
    ATTR_UNRESOLVED=$(cut -d' ' -f1 "$EV/cli-attr-seed.log")
    ATTR_CROSS=$(cut -d' ' -f2 "$EV/cli-attr-seed.log")
    step cli-attr-search bash -c "(cd '$REPO' && env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '归属未定的缓存决定') > '$EV/cli-attr-search.log' 2>&1; grep -qF \"[$ATTR_UNRESOLVED] testrepo 决定[未确认·自动沉淀][归属未定][字面+相似 1.00]: 归属未定的缓存决定（verify）\" '$EV/cli-attr-search.log'"
    step cli-attr-get-unresolved bash -c "env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' get '$ATTR_UNRESOLVED' > '$EV/cli-attr-get-unresolved.log' 2>&1; grep -qF '[归属未定]' '$EV/cli-attr-get-unresolved.log' && grep -qF '归属: 会话在 testrepo，抽取没能确认归属' '$EV/cli-attr-get-unresolved.log'"
    step cli-attr-get-cross bash -c "env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' get '$ATTR_CROSS' > '$EV/cli-attr-get-cross.log' 2>&1; grep -qF '归属: 会话在 testrepo，抽取判定归属 testrepo2' '$EV/cli-attr-get-cross.log'"
    kill $XP_PID 2>/dev/null


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

    # 5b. Codex .jsonl.zst 读时解析（§7.6）：隔离 home 里放一个压缩会话，登记与 dry-run 都走读时解压
    ZSID="01a332dc-4d5f-7d62-840d-69f94d09f7d7"
    mkdir -p "$FAKE_HOME/.codex/sessions/2026/10/12"
    node -e "
const { zstdCompressSync } = require('node:zlib');
const { writeFileSync } = require('node:fs');
const lines = [
  JSON.stringify({ type: 'session_meta', payload: { cwd: '$REPO', source: 'vscode' } }),
  JSON.stringify({ ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '以后做任何改动都要先通过 verify.sh 验证' }] } }),
].join('\n') + '\n';
writeFileSync('$FAKE_HOME/.codex/sessions/2026/10/12/rollout-2026-10-12T10-00-00-$ZSID.jsonl.zst', zstdCompressSync(Buffer.from(lines, 'utf8')));
"
    drive_codex_zst_capture(){
      printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionEnd"}\n' "$ZSID" "$REPO" | env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" capture --hook --host codex
    }
    step cli-codex-zst-capture drive_codex_zst_capture
    step cli-codex-zst-work env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --session codex:$ZSID --dry-run
    step cli-codex-zst-work-text bash -c "grep -qF 'codex:$ZSID: 待处理窗口' '$EV/cli-codex-zst-work.log'"

    # 5c. agy（§7.7、§7.8）：CLI、IDE、T3 实例三处共用发现与分处诊断。
    # 每处用自己的隔离 HOME，一处失败不把别的根的状态断言带偏；$ALOGS 留给第 9 步的 cli-guidance-prefs。
    agy_log(){ # home appRoot sessionId：完整版 + 截断版日志，静置一小时
      local logs="$2/brain/$3/.system_generated/logs"
      mkdir -p "$logs"
      node -e "
const { writeFileSync, utimesSync } = require('node:fs');
const t = new Date(Date.now() - 3600000);
const steps = [
  { step_index: 0, type: 'USER_INPUT', status: 'DONE', created_at: t.toISOString(), content: '<USER_REQUEST>\\n以后做任何改动都要先通过 verify.sh 验证\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\nlocal time\\n</ADDITIONAL_METADATA>' },
  { step_index: 1, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: t.toISOString(), content: '<agentbrain-prefs>注入的偏好</agentbrain-prefs>' },
  { step_index: 2, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: t.toISOString(), model: 'gemini-test', content: '好的，严格执行 verify.sh' },
];
writeFileSync('$logs/transcript_full.jsonl', steps.map((s) => JSON.stringify(s)).join('\\n') + '\\n');
writeFileSync('$logs/transcript.jsonl', JSON.stringify(steps[0]) + '\\n');
utimesSync('$logs/transcript_full.jsonl', t, t);
"
    }
    agy_summaries(){ # appData sessionId cwd：真实表结构，workspace_uris 是 JSON 数组
      node -e "
const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
mkdirSync('$1', { recursive: true });
const db = new DatabaseSync('$1/conversation_summaries.db');
db.exec('CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, parent_conversation_id TEXT, last_modified_time TEXT, raw_summary BLOB)');
db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?)').run('$2', JSON.stringify(['file://$3']), '', new Date(Date.now() - 3600000).toISOString(), null);
db.close();
"
    }
    ASID="a9e00000-1111-2222-3333-444444444444"
    ALOGS="$FAKE_HOME/.gemini/antigravity-cli/brain/$ASID/.system_generated/logs"
    agy_log "$FAKE_HOME" "$FAKE_HOME/.gemini/antigravity-cli" "$ASID"
    drive_agy_capture(){
      printf '{"session_id":"%s","transcript_path":"%s/transcript.jsonl","cwd":"%s","hook_event_name":"UserPromptSubmit"}\n' "$ASID" "$ALOGS" "$REPO" | env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" capture --hook --host agy
    }
    # 摘要库给 status 提供 cwd；登记来自上面的钩子。
    agy_summaries "$FAKE_HOME/.gemini/antigravity-cli" "$ASID" "$REPO"
    step cli-agy-cli-capture drive_agy_capture
    step cli-agy-cli-registered node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$AB_HOME/store.db', { readOnly: true });
const row = db.prepare(\"SELECT transcript FROM capture_sessions WHERE host='agy' AND session_id=?\").get('$ASID');
db.close();
if (row?.transcript !== '$ALOGS/transcript_full.jsonl') { console.error('登记路径应为完整版，实际 ' + row?.transcript); process.exit(1); }
"
    step cli-agy-cli-work env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --session agy:$ASID --dry-run
    step cli-agy-cli-work-text bash -c "grep -qF 'agy:$ASID: 待处理窗口 1' '$EV/cli-agy-cli-work.log'"
    step cli-agy-cli-status bash -c "(cd '$REPO' && env HOME='$FAKE_HOME' AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status) > '$EV/cli-agy-cli-status.log' 2>&1; grep -qF 'agy CLI: 日志 1（可抽 1），已登记 1，只靠 sweep' '$EV/cli-agy-cli-status.log'"

    # 5c-2. IDE：根是 ~/.gemini/antigravity，登记与诊断走同一套
    ISID="b7d10000-1111-2222-3333-444444444444"
    IHOME="$S/agy_ide_home"; IAB="$S/agy_ide_ab"; IROOT="$IHOME/.gemini/antigravity"
    mkdir -p "$IHOME" "$IAB"
    agy_log "$IHOME" "$IROOT" "$ISID"
    agy_summaries "$IROOT" "$ISID" "$REPO"
    drive_agy_ide_capture(){
      printf '{"session_id":"%s","transcript_path":"%s/brain/%s/.system_generated/logs/transcript.jsonl","cwd":"%s","hook_event_name":"UserPromptSubmit"}\n' "$ISID" "$IROOT" "$ISID" "$REPO" | env HOME="$IHOME" AB_HOME="$IAB" AGENTBRAIN_HOME="$IAB" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" capture --hook --host agy
    }
    step cli-agy-ide-capture drive_agy_ide_capture
    step cli-agy-ide-registered node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$IAB/store.db', { readOnly: true });
const row = db.prepare(\"SELECT transcript FROM capture_sessions WHERE host='agy' AND session_id=?\").get('$ISID');
db.close();
if (row?.transcript !== '$IROOT/brain/$ISID/.system_generated/logs/transcript_full.jsonl') { console.error('IDE 登记路径不对：' + row?.transcript); process.exit(1); }
"
    step cli-agy-ide-work env HOME="$IHOME" AB_HOME="$IAB" AGENTBRAIN_HOME="$IAB" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --session agy:$ISID --dry-run
    step cli-agy-ide-work-text bash -c "grep -qF 'agy:$ISID: 待处理窗口 1' '$EV/cli-agy-ide-work.log'"
    step cli-agy-ide-status bash -c "(cd '$REPO' && env HOME='$IHOME' AB_HOME='$IAB' AGENTBRAIN_HOME='$IAB' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status) > '$EV/cli-agy-ide-status.log' 2>&1; grep -qF 'agy IDE: 日志 1（可抽 1），已登记 1，只靠 sweep' '$EV/cli-agy-ide-status.log'"

    # 5c-3. T3：两个直接实例，各带 antigravity-acp/brain 和摘要库，诊断必须各自一行
    THOME="$S/agy_t3_home"; TAB="$S/agy_t3_ab"; TPROV="$THOME/.t3/userdata/providers/antigravity"
    TSID1="d3e40000-1111-2222-3333-444444444444"; TSID2="f5a60000-1111-2222-3333-444444444444"
    mkdir -p "$THOME" "$TAB"
    for pair in "a1b2c3d4:$TSID1" "e5f6a7b8:$TSID2"; do
      agy_log "$THOME" "$TPROV/${pair%%:*}/antigravity-acp" "${pair##*:}"
      agy_summaries "$TPROV/${pair%%:*}/antigravity-acp" "${pair##*:}" "$REPO"
    done
    drive_agy_t3_capture(){
      for pair in "a1b2c3d4:$TSID1" "e5f6a7b8:$TSID2"; do
        printf '{"session_id":"%s","transcript_path":"%s/%s/antigravity-acp/brain/%s/.system_generated/logs/transcript_full.jsonl","cwd":"%s","hook_event_name":"UserPromptSubmit"}\n' "${pair##*:}" "$TPROV" "${pair%%:*}" "${pair##*:}" "$REPO" \
          | env HOME="$THOME" AB_HOME="$TAB" AGENTBRAIN_HOME="$TAB" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" capture --hook --host agy || return 1
      done
    }
    step cli-agy-t3-capture drive_agy_t3_capture
    step cli-agy-t3-work env HOME="$THOME" AB_HOME="$TAB" AGENTBRAIN_HOME="$TAB" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --dry-run
    step cli-agy-t3-work-text bash -c "grep -qF 'agy:$TSID1: 待处理窗口 1' '$EV/cli-agy-t3-work.log' && grep -qF 'agy:$TSID2: 待处理窗口 1' '$EV/cli-agy-t3-work.log'"
    step cli-agy-t3-status bash -c "(cd '$REPO' && env HOME='$THOME' AB_HOME='$TAB' AGENTBRAIN_HOME='$TAB' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status) > '$EV/cli-agy-t3-status.log' 2>&1; grep -qF 'agy T3 a1b2c3d4: 日志 1（可抽 1），已登记 1，只靠 sweep' '$EV/cli-agy-t3-status.log' && grep -qF 'agy T3 e5f6a7b8: 日志 1（可抽 1），已登记 1，只靠 sweep' '$EV/cli-agy-t3-status.log'"

    # 5c-4. 冲突：CLI、IDE 两棵根同 id 都有完整日志，不登记、不抽取、单列
    CHOME="$S/agy_conflict_home"; CAB="$S/agy_conflict_ab"; CSID="c0f10000-1111-2222-3333-444444444444"
    mkdir -p "$CHOME" "$CAB"
    for app in "$CHOME/.gemini/antigravity-cli" "$CHOME/.gemini/antigravity"; do
      agy_log "$CHOME" "$app" "$CSID"
      agy_summaries "$app" "$CSID" "$REPO"
    done
    step cli-agy-conflict-sweep env HOME="$CHOME" AB_HOME="$CAB" AGENTBRAIN_HOME="$CAB" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" work --sweep
    step cli-agy-conflict-sweep-text bash -c "grep -qF 'agy 会话 $CSID 在多处有完整日志，已跳过' '$EV/cli-agy-conflict-sweep.log'"
    step cli-agy-conflict-rows node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$CAB/store.db', { readOnly: true });
const n = db.prepare(\"SELECT COUNT(*) AS n FROM capture_sessions WHERE host='agy'\").get().n;
db.close();
if (n !== 0) { console.error('冲突会话不该登记，实际 ' + n + ' 行'); process.exit(1); }
"
    step cli-agy-conflict-status bash -c "(cd '$REPO' && env HOME='$CHOME' AB_HOME='$CAB' AGENTBRAIN_HOME='$CAB' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' status) > '$EV/cli-agy-conflict-status.log' 2>&1; [ \$(grep -cF 'agy 会话 $CSID 在多处有完整日志' '$EV/cli-agy-conflict-status.log') = 1 ] && grep -qF 'agy CLI: 日志 0（可抽 0），已登记 0，只靠 sweep，冲突' '$EV/cli-agy-conflict-status.log' && grep -qF 'agy IDE: 日志 0（可抽 0），已登记 0，只靠 sweep，冲突' '$EV/cli-agy-conflict-status.log'"

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

    # 8b. anchors & backfill-decision-anchors (ab-3): remember --anchor / tag --anchor / tag --anchor none / correct 继承 / get 展示 / verify --changed / preview & apply
    ANC_AB="$S/anc_ab"; ANC_REPO="$S/anc_repo"; ANC_REG="$S/anc_repos"; ANC_PORT="$S/anc-port"
    mkdir -p "$ANC_AB" "$ANC_REPO/src" "$ANC_REG"
    git -C "$ANC_REPO" init -qb main
    printf 'export const ANC = 1;\n' > "$ANC_REPO/src/锚点模块.ts"
    git -C "$ANC_REPO" add . && git -C "$ANC_REPO" -c user.name=verify -c user.email=v@local commit -qm init
    printf -- "- 路径：\`%s\`\n- 主干：\`main\`\n" "$ANC_REPO" > "$ANC_REG/ancrepo.md"
    anc_ab(){ (cd "$ANC_REPO" && env HOME="$FAKE_HOME" AB_HOME="$ANC_AB" AGENTBRAIN_HOME="$ANC_AB" AB_REGISTRY="$ANC_REG" node "$ROOT/src/cli.ts" "$@"); }
    step cli-anchors-remember anc_ab remember --kind decision --text "锚点 CLI 验证决定" --summary "锚点验证" --anchor "./src/锚点模块.ts"
    ANC_ID=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-anchors-remember.log" 2>/dev/null | head -1)
    step cli-anchors-get anc_ab get "$ANC_ID"
    step cli-anchors-get-text bash -c "grep -qF '代码锚点（基准 ' '$EV/cli-anchors-get.log' && grep -qF 'src/锚点模块.ts' '$EV/cli-anchors-get.log'"
    step cli-anchors-correct anc_ab correct "$ANC_ID" --text "锚点 CLI 继承决定" --summary "纠正继承"
    ANC_COR=$(sed -n 's/^已纠正 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-anchors-correct.log" 2>/dev/null | head -1)
    step cli-anchors-correct-get bash -c "(cd '$ANC_REPO' && env HOME='$FAKE_HOME' AB_HOME='$ANC_AB' AGENTBRAIN_HOME='$ANC_AB' AB_REGISTRY='$ANC_REG' node '$ROOT/src/cli.ts' get '$ANC_COR') > '$EV/cli-anchors-correct-get.log' 2>&1 && grep -qF 'src/锚点模块.ts' '$EV/cli-anchors-correct-get.log'"
    step cli-anchors-tag-none anc_ab tag "$ANC_COR" --anchor none
    step cli-anchors-tag-none-check bash -c "! (cd '$ANC_REPO' && env HOME='$FAKE_HOME' AB_HOME='$ANC_AB' AGENTBRAIN_HOME='$ANC_AB' AB_REGISTRY='$ANC_REG' node '$ROOT/src/cli.ts' get '$ANC_COR' | grep -qF '代码锚点')"
    step cli-anchors-tag-set anc_ab tag "$ANC_COR" --anchor src/锚点模块.ts
    printf 'export const ANC = 2;\n' > "$ANC_REPO/src/锚点模块.ts"
    git -C "$ANC_REPO" add . && git -C "$ANC_REPO" -c user.name=verify -c user.email=v@local commit -qm bump
    step cli-anchors-verify-changed anc_ab verify --changed ancrepo --json
    step cli-anchors-verify-changed-hit bash -c "grep -qF '\"priority\":\"anchor\"' '$EV/cli-anchors-verify-changed.log'"

    step cli-backfill-seed anc_ab remember --kind decision --text "待回填决定" --summary "回填"
    ANC_BF=$(sed -n 's/^已记住 \[\([0-9a-f]\{8\}\)\].*/\1/p' "$EV/cli-backfill-seed.log" 2>/dev/null | head -1)
    cat > "$S/anc-mock.mjs" <<MOCK
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ items: [{ id: "$ANC_BF", anchors: ["src/锚点模块.ts"], reason: "verify mock" }] }) } }], usage: { total_tokens: 10 } }));
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
MOCK
    node "$S/anc-mock.mjs" "$ANC_PORT" & ANC_PID=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$ANC_PORT" ] && break; sleep 0.3; done
    printf '{"baseUrl":"http://127.0.0.1:%s/v1","model":"anc-mock"}\n' "$(cat "$ANC_PORT")" > "$ANC_AB/extract.json"
    step cli-backfill-preview env HOME="$FAKE_HOME" AB_HOME="$ANC_AB" AGENTBRAIN_HOME="$ANC_AB" AB_REGISTRY="$ANC_REG" node "$ROOT/scripts/backfill-decision-anchors.ts" preview --project ancrepo --out "$EV/backfill-plan.json" --md "$EV/backfill-plan.md"
    step cli-backfill-preview-check bash -c "grep -qF 'src/锚点模块.ts' '$EV/backfill-plan.json' && grep -qF '| ancrepo |' '$EV/backfill-plan.md'"
    step cli-backfill-apply env HOME="$FAKE_HOME" AB_HOME="$ANC_AB" AGENTBRAIN_HOME="$ANC_AB" AB_REGISTRY="$ANC_REG" node "$ROOT/scripts/backfill-decision-anchors.ts" apply --plan "$EV/backfill-plan.json" --ids "$ANC_BF"
    step cli-backfill-apply-check bash -c "(cd '$ANC_REPO' && env HOME='$FAKE_HOME' AB_HOME='$ANC_AB' AGENTBRAIN_HOME='$ANC_AB' AB_REGISTRY='$ANC_REG' node '$ROOT/src/cli.ts' get '$ANC_BF') > '$EV/cli-backfill-get.log' 2>&1 && grep -qF 'src/锚点模块.ts' '$EV/cli-backfill-get.log' && grep -qF '未确认' '$EV/cli-backfill-get.log'"
    step cli-backfill-apply-idempotent env HOME="$FAKE_HOME" AB_HOME="$ANC_AB" AGENTBRAIN_HOME="$ANC_AB" AB_REGISTRY="$ANC_REG" node "$ROOT/scripts/backfill-decision-anchors.ts" apply --plan "$EV/backfill-plan.json" --ids "$ANC_BF"
    step cli-backfill-apply-idempotent-check bash -c "grep -qF 'applied=0，skipped=1' '$EV/cli-backfill-apply-idempotent.log'"
    kill $ANC_PID 2>/dev/null || true

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
    step cli-guidance-prefs bash -c "printf '{\"prompt\":\"验证规范\",\"cwd\":\"%s\",\"transcript_path\":\"%s/transcript_full.jsonl\"}\n' '$REPO' '$ALOGS' | env HOME='$FAKE_HOME' AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' recall --hook | grep -qF '偏好测试：改动后先跑测试'"
    step cli-guidance-off env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node "$ROOT/src/cli.ts" guidance "$GUIDE_ID" --off
    step cli-guidance-off-prefs bash -c "printf '{\"prompt\":\"验证规范\",\"cwd\":\"%s\",\"transcript_path\":\"%s/transcript_full.jsonl\"}\n' '$REPO' '$ALOGS' | env HOME='$FAKE_HOME' AB_HOME='$AB_HOME' AGENTBRAIN_HOME='$AB_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' recall --hook | grep -qvF '偏好测试：改动后先跑测试'"

    # 10. 数据安全（admin.md，设计 §12.6）：单独一个库，备份 → 再写一条 → 恢复预览 → 恢复 → 清除被拒 → status 新增各行 → 权限
    ADM="$S/admin_home"; A="env AB_HOME=$ADM AB_REGISTRY=$AB_REGISTRY HOME=$FAKE_HOME node $ROOT/src/cli.ts"
    step cli-admin-seed $A remember --kind rule --text "备份前就有的规则 ADMINKEEP" --summary "数据安全" --global --confirmed
    step cli-backup $A backup
    BK=$(sed -n 's/^已备份 \(.*\.db\)（.*/\1/p' "$EV/cli-backup.log" 2>/dev/null | head -1)
    step cli-backup-verified bash -c "grep -qF '（1 条事件，已核对完整性）' '$EV/cli-backup.log' && [ -s '$BK' ]"
    step cli-admin-later $A remember --kind rule --text "备份之后才写的规则 ADMINLATER" --summary "数据安全" --global --confirmed
    step cli-restore-preview bash -c "$A restore '$BK' > '$EV/cli-restore-preview.out' 2>&1; [ \$? = 1 ] && grep -qF '没有执行。恢复会把现库换成备份的内容，备份之后写入的 1 条事件会从现库消失' '$EV/cli-restore-preview.out' && $A search ADMINLATER | grep -qF ADMINLATER"
    step cli-restore $A restore "$BK" --yes
    step cli-restore-state bash -c "grep -qF '已恢复：现库 1 条事件' '$EV/cli-restore.log' && $A search ADMINLATER | grep -qF '没有匹配的记忆' && $A search ADMINKEEP | grep -qF ADMINKEEP"
    step cli-purge-seed node -e "
import('$ROOT/src/store.ts').then(({ Store }) => {
  const s = new Store('$ADM/store.db', '$ADM/index.db');
  s.remember(null, 'verify-purge-sess', false, { kind: 'note', text: '要清除的内容 ADMINPURGE', confirmed: true, source: { host: 'claude', session_id: 'verify-purge-sess', transcript: null, anchor: null, summary: 'x' } });
  s.close();
});"
    # 不是终端（脚本、agent）时只打印范围、不执行，内容还在
    step cli-purge-refused bash -c "$A purge --session claude:verify-purge-sess < /dev/null > '$EV/cli-purge-refused.out' 2>&1; [ \$? = 1 ] && grep -qF '没有执行：清除只能由人在终端里发起' '$EV/cli-purge-refused.out' && $A search ADMINPURGE | grep -qF ADMINPURGE"
    step cli-admin-status bash -c "$A status > '$EV/cli-admin-status.out' 2>&1 && grep -q '^要处理' '$EV/cli-admin-status.out' && grep -q '^代码: ' '$EV/cli-admin-status.out' && grep -q '^库: 版本 1（代码支持 1）；事件 [0-9]* 条；不认识的事件 0 条' '$EV/cli-admin-status.out' && grep -q '^备份: 最近一次 ' '$EV/cli-admin-status.out' && grep -q '^失败窗口: ' '$EV/cli-admin-status.out'"
    step cli-admin-perms bash -c "[ \"\$(stat -f %Lp '$ADM')\" = 700 ] && [ \"\$(stat -f %Lp '$ADM/store.db')\" = 600 ] && [ \"\$(stat -f %Lp '$ADM/index.db')\" = 600 ] && [ \"\$(stat -f %Lp '$ADM/backups')\" = 700 ] && [ \"\$(stat -f %Lp '$BK')\" = 600 ]"
    # 参数写错只给该子命令的用法
    step cli-usage-scoped bash -c "$A remember --confirmed 位置参数 > '$EV/cli-usage.out' 2>&1; grep -q '^  ab remember --kind' '$EV/cli-usage.out' && ! grep -q 'ab curate' '$EV/cli-usage.out'"

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
  team)
    # 真实宿主一轮四步（Pi / Codex / Claude Code）：正式库副本 + 临时项目 team-demo，见 features/team.md。会花真实模型额度。
    shift || true
    mkdir -p "$EV"
    if [ $DRY = 1 ]; then emit team dry-run "node .agents/skills/verify-agentbrain/team.ts --evidence $EV $*"; exit 0; fi
    node .agents/skills/verify-agentbrain/team.ts --evidence "$EV" "$@" >"$EV/team.log" 2>&1; c=$?
    tail -8 "$EV/team.log"
    emit team "$([ $c = 0 ] && echo pass || echo fail)" "$EV/team.log"
    exit $c ;;
  cleanup)
    # kills nothing by name; only removes scratch dirs this script created. Evidence kept.
    [ -f "${TMPDIR:-/tmp}/verify-agentbrain.scratch" ] && { d=$(cat "${TMPDIR:-/tmp}/verify-agentbrain.scratch"); [ $DRY = 1 ] && emit cleanup dry-run "rm -r $d" || { rm -rf "$d"; rm "${TMPDIR:-/tmp}/verify-agentbrain.scratch"; emit cleanup pass "removed $d"; }; } || emit cleanup pass nothing-to-clean ;;
  *) echo "usage: verify.sh doctor|run|hosts [claude codex pi opencode]|team [pi codex claude]|cleanup [--dry-run]" >&2; exit 2 ;;
esac

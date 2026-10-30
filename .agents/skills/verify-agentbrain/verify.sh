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
    step cli-cross-search-hit bash -c "grep -qF \"[$XP_SEED_ID] testrepo2 决定: 其他项目的缓存决定 SIM0.92（0.92）\" '$EV/cli-cross-search.log'"
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
    step cli-attr-search bash -c "(cd '$REPO' && env AB_HOME='$XP_HOME' AGENTBRAIN_HOME='$XP_HOME' AB_REGISTRY='$AB_REGISTRY' node '$ROOT/src/cli.ts' search '归属未定的缓存决定') > '$EV/cli-attr-search.log' 2>&1; grep -qF \"[$ATTR_UNRESOLVED] testrepo 决定[未确认·自动沉淀][归属未定]: 归属未定的缓存决定（verify）\" '$EV/cli-attr-search.log'"
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

/**
 * 真实宿主验收（一轮会话走四步）：开工注入 → 会话内搜索/查看并答对预设问题 → 会话结束后抽取入库 → 会话内 ab status。
 * 库用正式库的副本（AB_HOME 指向副本），HOME 保持真实；项目清单只有一个临时仓库 team-demo，正式库的后台巡检不会抽这些会话。
 * 用法：node team.ts [--cli <cli.ts>] [--label <名字>] [--evidence <目录>] [claude codex pi]
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { hostEnv } from "./hosts.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const HOSTS = ["claude", "codex", "pi"] as const;
type Host = (typeof HOSTS)[number];
const CODEX_MODEL = "gemini-3.8-flash-high";
const FLAG = "ROLLOUT_CANARY_42";
const FLAG_VALUE = "17";
const PIT_TEXT = "team-demo 的集成测试库端口是 15432，不是默认的 5432，连错会报 connection refused。";
const PI_MODEL = process.env.AB_TEAM_PI_MODEL ?? "magpie/codex/gpt-5.6-terra";
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const { values, positionals } = parseArgs({ options: { cli: { type: "string" }, label: { type: "string", default: "run" }, evidence: { type: "string" } }, allowPositionals: true });
const CLI = values.cli ? realpathSync(values.cli) : join(ROOT, "src/cli.ts");
const selected = (positionals.length ? positionals : [...HOSTS]) as Host[];
assert.ok(selected.every((h) => HOSTS.includes(h)), "宿主只能是 claude codex pi");
const realHome = homedir();
const ev = values.evidence ?? join(realHome, ".cache/verify-evidence/agentbrain", `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}-team-${values.label}`);
mkdirSync(ev, { recursive: true });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ab-team-hosts-")));
const store = join(scratch, "store");
const registry = join(scratch, "repos");
const repo = join(scratch, "team-demo");
const bin = join(scratch, "bin");
const shell = join(scratch, "shell");
for (const d of [store, registry, join(repo, "scripts"), bin, shell]) mkdirSync(d, { recursive: true });

const log = (name: string, value: unknown) => {
  const file = join(ev, name);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
};
const sh = (cmd: string, args: string[], env: NodeJS.ProcessEnv, timeout = 600_000, cwd = repo) => spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });

// ---- 正式库副本（只读地复制；不在正式库上开连接） ----
const prodHome = join(realHome, ".agentbrain");
for (const f of ["store.db", "store.db-wal", "index.db", "index.db-wal", "embedding.json", "extract.json", "review.json"]) {
  if (existsSync(join(prodHome, f))) copyFileSync(join(prodHome, f), join(store, f));
}
// Codex 用临时 HOME 跑（不带真实 hooks/MCP），钥匙串在临时 HOME 下读不到：PATH 里放一个转发到真实 HOME 的 security
writeFileSync(join(bin, "security"), `#!/bin/sh\nHOME=${quote(realHome)} exec /usr/bin/security "$@"\n`, { mode: 0o700 });
const prefix = `env AB_HOME=${quote(store)} AB_REGISTRY=${quote(registry)} PATH=${quote(bin)}:"$PATH" ${quote(process.execPath)} ${quote(CLI)}`;
writeFileSync(join(bin, "ab"), `#!/bin/sh\nexec ${prefix} "$@"\n`, { mode: 0o700 });
const shellSetup = `export AB_HOME=${quote(store)}\nexport AB_REGISTRY=${quote(registry)}\nexport PATH=${quote(bin)}:$PATH\n`;
for (const f of [".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(shell, f), shellSetup);

const env = hostEnv({ HOME: realHome, AB_HOME: store, AB_REGISTRY: registry, ZDOTDIR: shell, PATH: `${bin}:${process.env.PATH}` });
const ab = (args: string[], cwd = repo) => {
  const r = sh(process.execPath, [CLI, ...args], env, 120_000, cwd);
  assert.equal(r.status, 0, `ab ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// ---- 临时项目 team-demo ----
writeFileSync(join(repo, "README.md"), "# team-demo\n\n验收用的演示项目。本地构建脚本在 scripts/ 下，只写本目录的 .state/。\n");
// 每个宿主会话开始前删掉 .state，保证 build.sh 第一次一定失败。
// 夹具只做本地构建：叫 deploy 会被 Claude Code 的权限分类器当成没有预览的生产发布拦下（基线实测）
writeFileSync(join(repo, "scripts/build.sh"), "#!/bin/sh\n# 只在本目录生成 .state/build.txt，不联网、不碰别的目录\nif [ -f .state/build.lock ]; then\n  echo 'ERROR: 另一个构建正在运行（.state/build.lock 存在），构建中止，退出码 3。' >&2\n  exit 3\nfi\nmkdir -p .state && echo built > .state/build.txt\necho 'build ok: 本地构建完成'\n", { mode: 0o755 });
writeFileSync(join(repo, "scripts/smoke.sh"), "#!/bin/sh\n# 用法: sh scripts/smoke.sh [--unlock]\n#   --unlock  清掉上次构建被中断后残留的 .state/build.lock（没有构建在跑时它也会留着）\nif [ \"$1\" = --unlock ]; then rm -f .state/build.lock && echo 'unlocked: 已清掉残留的构建锁'; fi\necho smoke ok\n", { mode: 0o755 });
writeFileSync(join(repo, ".gitignore"), ".state/\n");
sh("git", ["init", "-q"], env);
sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], env);
sh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], env);
writeFileSync(join(registry, "team-demo.md"), `- 路径：\`${repo}\`\n`);
const idOf = (out: string) => {
  const id = /\[([0-9a-f]{8})\]/.exec(out)?.[1];
  assert.ok(id, out);
  return id;
};
const pit = idOf(ab(["remember", "--confirmed", "--kind", "pitfall", "--text", PIT_TEXT, "--summary", "验收用：发布顺序"]));
const dec = idOf(ab(["remember", "--confirmed", "--kind", "decision", "--text", `team-demo 的灰度开关叫 ${FLAG}，默认比例是 ${FLAG_VALUE}%。`, "--why", "验收用的预设答案", "--summary", "验收用：灰度开关"]));
const CODE_PIT = "team-demo 的单测用 node --test 跑，仓库里没有装 jest。";
let codePit: string | null = null;
{
  const { Store } = (await import(join(CLI, "../store.ts"))) as typeof import("../../../src/store.ts");
  const st = new Store(join(store, "store.db"), join(store, "index.db"));
  const pid = st.ensureProject("team-demo");
  codePit = st.remember(pid, "seed-extract", false, { kind: "pitfall", text: CODE_PIT, confirmed: false, origin: "extract", source: { host: "claude", session_id: "seed-extract", transcript: null, anchor: null, summary: "验收用：代码核验转正的坑" } });
  st.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: codePit, body: { outcome: "verified", head: "seed", refs: [], model: "seed" } }], () => {});
  st.close();
}
const ME = userInfo().username;
log("run.json", { cli: CLI, scratch, store, registry, repo, hosts: selected, pit, dec, codePit, label: values.label });

const db = new DatabaseSync(join(store, "store.db"), { readOnly: true });
const q = (sql: string, ...args: (string | number | null)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];
const cols = (table: string) => new Set(q(`PRAGMA table_info(${table})`).map((r) => String(r.name)));

const hooks = (host: Host) => {
  const cap = { type: "command", command: `${prefix} capture --hook --host ${host}`, timeout: 5 };
  return { hooks: { UserPromptSubmit: [{ hooks: [cap, { type: "command", command: `${prefix} recall --hook`, timeout: 5 }] }], SessionEnd: [{ hooks: [cap] }] } };
};
const claudeSettings = join(scratch, "claude-settings.json");
writeFileSync(claudeSettings, JSON.stringify(hooks("claude")));
const codexHome = join(scratch, "codex-home");
mkdirSync(join(codexHome, ".codex"), { recursive: true });
if (existsSync(join(realHome, ".codex/auth.json"))) {
  copyFileSync(join(realHome, ".codex/auth.json"), join(codexHome, ".codex/auth.json"));
  chmodSync(join(codexHome, ".codex/auth.json"), 0o600);
}
const gateway = (() => {
  try {
    const conf = JSON.parse(readFileSync(join(realHome, ".pi/agent/models.json"), "utf8")) as { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: { id?: string }[] }> };
    for (const p of Object.values(conf.providers ?? {})) {
      if (typeof p?.baseUrl !== "string" || typeof p?.apiKey !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl)) continue;
      if (!(p.models ?? []).some((m) => m.id === CODEX_MODEL)) continue;
      const probe = sh("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", `${p.baseUrl}/models`, "-H", `Authorization: Bearer ${p.apiKey}`], env);
      if (probe.stdout.trim() === "200") return { baseUrl: p.baseUrl, apiKey: p.apiKey };
    }
  } catch {}
  return null;
})();
const codexModel = gateway ? CODEX_MODEL : "gpt-5.6-sol";
// Claude Code 官方登录失效时（真实出现过：OAuth session expired），改走本机网关的 Anthropic 兼容接口；宿主仍是真实的 Claude Code。
const CLAUDE_MODEL = process.env.AB_TEAM_CLAUDE_MODEL ?? "codex/gpt-5.6-terra";
const claudeGateway = (() => {
  try {
    if ((JSON.parse(sh("claude", ["auth", "status"], env, 30_000).stdout) as { loggedIn?: boolean }).loggedIn) return null;
  } catch {}
  try {
    const conf = JSON.parse(readFileSync(join(realHome, ".pi/agent/models.json"), "utf8")) as { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: { id?: string }[] }> };
    for (const p of Object.values(conf.providers ?? {})) {
      if (typeof p?.baseUrl !== "string" || typeof p?.apiKey !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl)) continue;
      if ((p.models ?? []).some((m) => m.id === CLAUDE_MODEL)) return { baseUrl: p.baseUrl.replace(/\/v1\/?$/, ""), apiKey: p.apiKey };
    }
  } catch {}
  return null;
})();
writeFileSync(join(codexHome, ".codex/config.toml"), gateway
  ? `model = "${codexModel}"\nmodel_provider = "local"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = true\n[shell_environment_policy]\ninherit = "all"\n[model_providers.local]\nname = "local"\nbase_url = "${gateway.baseUrl}"\nenv_key = "AB_CODEX_KEY"\nwire_api = "responses"\n`
  : `model = "${codexModel}"\nmodel_provider = "custom"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = true\n[shell_environment_policy]\ninherit = "all"\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\nsupports_websockets = true\nwire_api = "responses"\n`);
writeFileSync(join(codexHome, ".codex/hooks.json"), JSON.stringify(hooks("codex")));
const piExtension = join(scratch, "pi-recall.ts");
writeFileSync(piExtension, `import { createExtension, makeExecRunner } from ${JSON.stringify(join(ROOT, "integrations/pi/agentbrain-recall.ts"))};\nexport default createExtension(makeExecRunner([${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}]]));\n`);

const PROMPT = `这是 agentbrain 的验收会话，当前目录是演示项目 team-demo。只用 shell 工具，不改任何文件。按顺序做完下面五步，每一步都把命令的原始输出看完再做下一步：
1. 开工先执行 \`ab brief\`。
2. 执行 \`sh scripts/build.sh\` 做本地构建（只写本目录的 .state/，不联网）。如果失败，先查清原因（可以读 scripts/ 下的脚本）再处理，直到构建成功。不要改仓库里已有的文件。
3. 执行 \`ab search 灰度开关\`，对命中的那条执行 \`ab get <id>\`。
4. 执行 \`ab status\`。
5. 最后用中文回答，分五小段：
   (a) ab brief 里 team-demo 的坑，原样抄一条；
   (b) 灰度开关叫什么、默认比例是多少；按 ab get 的输出，这条记忆是谁（操作者@机器）确认的、是不是在 agent 会话里执行的；
   (c) build.sh 第一次的报错原文、真实原因，以及最后是怎么构建成功的；
   (d) ab status 输出里以「代码」「库」「备份」开头的行，原样抄出来，没有就写「没有这些行」；
   (e) ab brief 里有没有标了（代码核验）的条目，有就抄一条，并说明这个标注是什么意思。
回答末尾按注入的要求写记忆报告行。
另外定个规矩：以后 team-demo 的本地构建产物一律放 .state/ 下，不许写到仓库其他目录。这条不用你执行 ab remember，后台会自动抽取。`;

/** 宿主最后一条回复的正文（不含工具输出）：claude 取 result，codex 取最后一条 agent_message，pi 取 agent_end 里最后一条助手消息。 */
function finalAnswer(host: Host, stdout: string): string {
  if (host === "claude") {
    try {
      return String((JSON.parse(stdout) as { result?: string }).result ?? "");
    } catch {
      return "";
    }
  }
  let last = "";
  for (const l of stdout.split("\n")) {
    let d: any;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (host === "codex" && d?.type === "item.completed" && d.item?.type === "agent_message" && typeof d.item.text === "string") last = d.item.text;
    if (host === "pi" && d?.type === "agent_end" && Array.isArray(d.messages)) {
      const a = d.messages.filter((m: any) => m?.role === "assistant").pop();
      const c = a?.content;
      last = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : last;
    }
  }
  return last;
}

const results: Record<string, unknown>[] = [];
const sessions = new Set<string>();
let failed = false;
const waitWork = (host: Host, sid: string, timeoutMs: number) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const lease = q("SELECT 1 FROM work_lease");
    const wins = q("SELECT state FROM capture_windows WHERE host=? AND session_id=?", host, sid);
    if (!lease.length && wins.some((w) => w.state === "done" || w.state === "failed")) return true;
    spawnSync("sleep", ["3"]);
  }
  return false;
};

for (const host of selected) {
  const dir = `${host}/`;
  const version = sh(host, ["--version"], env, 30_000);
  const sid = randomUUID();
  const childEnv = hostEnv({ ...env, HOME: host === "codex" ? codexHome : realHome, ...(gateway ? { AB_CODEX_KEY: gateway.apiKey } : {}),
    ...(host === "claude" && claudeGateway ? { ANTHROPIC_BASE_URL: claudeGateway.baseUrl, ANTHROPIC_AUTH_TOKEN: claudeGateway.apiKey, ANTHROPIC_MODEL: CLAUDE_MODEL, ANTHROPIC_SMALL_FAST_MODEL: CLAUDE_MODEL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}) });
  const args = host === "claude" ? ["-p", "--setting-sources", "", "--settings", claudeSettings, "--strict-mcp-config", "--tools", "Bash", "--allowedTools", "Bash", "--session-id", sid, "--output-format", "json", PROMPT]
    : host === "codex" ? ["exec", "--dangerously-bypass-hook-trust", "--json", PROMPT]
    : ["-p", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", PI_MODEL, "--session-id", sid, "-e", piExtension, "--tools", "bash", "--mode", "json", PROMPT];
  const before = new Set(q("SELECT session_id FROM capture_sessions WHERE host=?", host).map((r) => String(r.session_id)));
  const maxSeq = Number(q("SELECT max(seq) AS n FROM events")[0].n);
  console.log(`${host} 开始`);
  sh("rm", ["-rf", join(repo, ".state")], env, 10_000);
  mkdirSync(join(repo, ".state"));
  writeFileSync(join(repo, ".state/build.lock"), "stale\n");
  const r = sh(host, args, childEnv);
  const output = r.stdout + "\n" + r.stderr;
  log(`${dir}host-output.log`, output);
  const found = q("SELECT session_id FROM capture_sessions WHERE host=?", host).map((x) => String(x.session_id)).filter((id) => !before.has(id));
  const session = host === "codex" ? found[0] : sid;
  if (session) sessions.add(session);
  for (const id of found) sessions.add(id);
  const checks: Record<string, { ok: boolean; detail: unknown }> = {};
  let how = "hook";
  try {
    assert.equal(r.status, 0, r.error?.message ?? output.slice(-1500));
    assert.ok(session && found.includes(session), "hook 必须在副本库登记本次会话");
    // 会话结束后的抽取：先等 hook 拉起的后台进程；宿主没发 SessionEnd 时改为手动登记结束并跑同一条命令
    if (!waitWork(host, session, 240_000)) {
      how = "manual";
      const menv = { ...childEnv, PATH: `${bin}:${process.env.PATH}` };
      const m1 = sh(process.execPath, [CLI, "capture", `${host}:${session}`, "--end", "--cwd", repo], menv, 60_000);
      const m2 = sh(process.execPath, [CLI, "work", "--session", `${host}:${session}`], menv, 600_000);
      log(`${dir}manual-work.log`, [m1.stdout, m1.stderr, m2.stdout, m2.stderr].join("\n"));
      waitWork(host, session, 30_000);
    }
    const final = finalAnswer(host, r.stdout);
    const transcript = String(q("SELECT transcript FROM capture_sessions WHERE host=? AND session_id=?", host, session)[0]?.transcript ?? "");
    const raw = transcript && existsSync(transcript) ? readFileSync(transcript, "utf8") : "";
    log(`${dir}transcript-path.txt`, transcript);
    if (raw) log(`${dir}transcript.jsonl`, raw);
    const deliveries = q("SELECT path, prop_id FROM inject_log WHERE host=? AND session_id=?", host, session);
    const queries = q("SELECT path, count(*) AS n FROM memory_queries WHERE host=? AND session_id=? GROUP BY path", host, session);
    const windows = q("SELECT substr(window_id,1,8) AS id, state, attempts, error_code, receipt FROM capture_windows WHERE host=? AND session_id=?", host, session);
    const ec = cols("events");
    const events = q(`SELECT seq, kind, substr(id,1,8) AS id, ${ec.has("actor") ? "actor" : "NULL AS actor"}, ${ec.has("machine") ? "machine" : "NULL AS machine"}, json_extract(body,'$.text') AS text, json_extract(body,'$.basis') AS basis FROM events WHERE seq>? AND session_id=? ORDER BY seq`, maxSeq, session);
    checks.brief = { ok: deliveries.some((d) => d.path === "brief" && String(d.prop_id).startsWith(pit)) && (raw || output).includes("集成测试库端口是 15432"), detail: deliveries.filter((d) => d.path === "brief").length + " 条经 brief 交付" };
    checks.prefs_injected = { ok: (raw || output).includes("agentbrain-recall"), detail: "每轮注入块出现在会话记录里" };
    const seen = raw || output;
    checks.search_get = { ok: queries.some((x) => x.path === "search") && queries.some((x) => x.path === "get") && final.includes(FLAG) && final.includes(FLAG_VALUE), detail: queries };
    checks.get_who = { ok: /确认: 用户确认 · /.test(seen) && /写入: /.test(seen) && final.includes(ME), detail: `会话里 ab get 有“确认”“写入”两行，最终回答里写出了操作者 ${ME}` };
    checks.brief_trust = { ok: seen.includes(`${CODE_PIT}（代码核验）`) && seen.includes("没标注的条目是用户确认过的"), detail: "会话里 ab brief 把代码核验转正的坑标出来，并有说明行" };
    checks.search_marks = { ok: /决定\[用户确认\]\[[^\]]*(字面|相似)[^\]]*\]: team-demo 的灰度开关/.test(seen), detail: "会话里 ab search 的结果带确认来源和命中方式" };
    checks.extract = { ok: windows.some((w) => w.state === "done") && events.some((e) => e.kind === "remember" || e.kind === "evidence"), detail: { how, windows, events } };
    checks.actor_machine = { ok: events.length > 0 && events.every((e) => e.actor && e.machine), detail: events.map((e) => ({ id: e.id, kind: e.kind, actor: e.actor, machine: e.machine })) };
    // 行首：真换行、JSON 里转义的换行，或工具输出字符串的开头（"text":"要处理…）
    const line = (label: string) => new RegExp(`(^|\\n|\\\\n|")${label}`).test(seen);
    const missing = ["要处理", "代码: ", "库: 版本 ", "备份: ", "失败窗口: "].filter((l) => !line(l));
    checks.status = { ok: !missing.length, detail: missing.length ? `会话里的 ab status 缺这些行：${missing.join("、")}` : "会话里的 ab status 有 要处理、代码、库、备份、失败窗口 各行" };
    log(`${dir}final-answer.txt`, final.slice(-6000));
    log(`${dir}sql.json`, { session, deliveries, queries, windows, events });
  } catch (e) {
    checks.run = { ok: false, detail: String(e) };
  }
  const blocked = !!checks.run && /401|usage limit|rate.limit|429|quota|not logged in/i.test(output);
  const ok = Object.values(checks).every((c) => c.ok);
  if (!ok && !blocked) failed = true;
  const row = { host, model: host === "codex" ? codexModel : host === "pi" ? PI_MODEL : claudeGateway ? `${CLAUDE_MODEL}（本机网关，官方登录失效）` : "官方登录默认模型", version: (version.stdout + version.stderr).trim(), session, extract_via: how, status: ok ? "PASS" : blocked ? "BLOCKED" : "FAIL", checks, args: args.slice(0, -1), HOME: childEnv.HOME, AB_HOME: store };
  results.push(row);
  log(`${dir}result.json`, row);
  console.log(`${host} ${row.status} ${Object.entries(checks).map(([k, c]) => `${k}=${c.ok ? "ok" : "FAIL"}`).join(" ")}`);
}
db.close();

// ---- 正式库核对：复制后查，本次会话 id 在各表里都必须是 0 ----
const prodCopy = join(scratch, "prod-check.db");
copyFileSync(join(prodHome, "store.db"), prodCopy);
if (existsSync(join(prodHome, "store.db-wal"))) copyFileSync(join(prodHome, "store.db-wal"), prodCopy + "-wal");
const prod = new DatabaseSync(prodCopy);
const ids = [...sessions];
const isolation: Record<string, number> = {};
for (const t of ["events", "inject_log", "recall_runs", "memory_queries", "memory_reports", "capture_windows", "capture_sessions"]) {
  isolation[t] = ids.length ? Number((prod.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { n: number }).n) : 0;
}
prod.close();
// capture_sessions 允许出现坐标行（正式巡检会登记未登记目录的会话坐标，不抽取）；其余表必须是 0
const leaked = Object.entries(isolation).some(([t, n]) => t !== "capture_sessions" && n > 0);
if (leaked) failed = true;
log("production-isolation.json", { sessions: ids, counts: isolation, leaked });
log("summary.json", { status: failed ? "FAIL" : results.some((r) => r.status === "BLOCKED") ? "PASS_WITH_BLOCKED" : "PASS", results: results.map((r) => ({ host: r.host, status: r.status, session: r.session, extract_via: r.extract_via, checks: Object.fromEntries(Object.entries(r.checks as Record<string, { ok: boolean }>).map(([k, c]) => [k, c.ok])) })) });
console.log(`证据 ${ev}`);
if (failed) process.exitCode = 1;

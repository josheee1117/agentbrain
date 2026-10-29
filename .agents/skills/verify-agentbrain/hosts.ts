import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(ROOT, "src/cli.ts");
const HOSTS = ["claude", "codex", "pi", "opencode"] as const;
const CODEX_MODEL = "gemini-3.8-flash-high";
/** 第一次 chat 请求回一个工具调用，之后全部 429：稳定造出“有进度、然后模型失败”的轮。 */
const MOCK_PROVIDER = `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
let n = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) { res.setHeader("Content-Type", "application/json"); res.end("{}"); return; }
    n++;
    if (n === 1) {
      res.setHeader("Content-Type", "text/event-stream");
      const chunk = (o) => res.write(\`data: \${JSON.stringify(o)}\n\n\`);
      const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "one" };
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "先跑一下命令。" }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo progress" }) } }] }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.write("data: [DONE]\\n\\n");
      res.end();
    } else {
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "mock quota exhausted", type: "rate_limit" } }));
    }
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
`;
type Host = typeof HOSTS[number];
type Row = Record<string, SQLOutputValue>;
type Expected = { status: "used" | "unused" | "unreported"; queried: number; id?: string };

export function hostEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  assert.ok(overrides.AB_HOME && overrides.AB_REGISTRY, "测试库和 registry 必须显式指定");
  const env = { ...process.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_HOME", "PI_SESSION_ID", "PI_SESSION_FILE", "PI_CODING_AGENT_SESSION_DIR", "OPENCODE_SESSION_ID", "AGENTBRAIN_REVIEWER"]) delete env[key];
  return { ...env, ...overrides };
}

export function assertScenario(code: number | null, reports: Row[], ids: Row[], expected: Expected): void {
  assert.equal(code, 0, "宿主必须正常退出");
  assert.equal(reports.length, 1, "本次会话必须恰有一个最终回答报告");
  assert.deepEqual({ status: reports[0].status, queried: reports[0].queried, cite: reports[0].cite }, { status: expected.status, queried: expected.queried, cite: 1 });
  assert.deepEqual(ids.map((r) => ({ short_id: r.short_id, verified: r.verified })), expected.id ? [{ short_id: expected.id, verified: 1 }] : []);
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

function main() {
  const hosts = process.argv.slice(2);
  assert.ok(hosts.every((h) => HOSTS.includes(h as Host)), "参数只能是 claude codex pi opencode");
  const selected = hosts.length ? hosts as Host[] : [...HOSTS];
  const realHome = homedir();
  const ev = join(realHome, ".cache/verify-evidence/agentbrain", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "") + "-hosts");
  mkdirSync(ev, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ab-hosts-")));
  const store = join(scratch, "store");
  const registry = join(scratch, "repos");
  const repo = join(scratch, "test-repo");
  const bin = join(scratch, "bin");
  const shell = join(scratch, "shell");
  // sweep 的扫描会把 homedir 下三个宿主的会话目录补登记进测试库；用空 HOME 跑，只留下 opencode 的库。
  const sweepHome = join(scratch, "sweep-home");
  mkdirSync(join(sweepHome, ".local/share"), { recursive: true });
  if (existsSync(join(realHome, ".local/share/opencode"))) symlinkSync(join(realHome, ".local/share/opencode"), join(sweepHome, ".local/share/opencode"));
  for (const d of [store, registry, repo, bin, shell]) mkdirSync(d, { recursive: true });
  const env = hostEnv({ HOME: realHome, AB_HOME: store, AB_REGISTRY: registry, ZDOTDIR: shell, PATH: `${bin}:${process.env.PATH}` });
  const sweepEnv = hostEnv({ ...env, HOME: sweepHome });
  const results: object[] = [];
  const sessions = new Set<string>();
  const log = (name: string, value: unknown) => writeFileSync(join(ev, name), typeof value === "string" ? value : JSON.stringify(value, null, 2), { mode: 0o600 });
  const run = (cmd: string, args: string[], childEnv = env, input = "", timeout = 180_000) => spawnSync(cmd, args, { cwd: repo, env: childEnv, input, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  const ab = (args: string[], childEnv = env, input = "") => {
    const r = run(process.execPath, [CLI, ...args], childEnv, input, 30_000);
    assert.equal(r.status, 0, `ab ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  // 宿主退出时自己拉起的 ab work --session 可能还占着租约；等它放掉再扫，否则引用结算被跳过。
  const sweep = (childEnv: NodeJS.ProcessEnv) => {
    for (let i = 0; i < 15; i++) {
      const out = ab(["work", "--sweep"], childEnv);
      if (!out.includes("另一个 ab work 正在运行")) return out;
      spawnSync("sleep", ["2"]);
    }
    assert.fail("ab work --sweep 一直被另一个 ab work 占着");
  };
  const prefix = `env AB_HOME=${quote(store)} AB_REGISTRY=${quote(registry)} ${quote(process.execPath)} ${quote(CLI)}`;
  const shellSetup = `export AB_HOME=${quote(store)}\nexport AB_REGISTRY=${quote(registry)}\nexport PATH=${quote(bin)}:$PATH\n`;
  for (const f of [".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(shell, f), shellSetup);
  writeFileSync(join(bin, "ab"), `#!/bin/sh\nprintf '%s\\t%s\\n' "$AB_HOME" "$AB_REGISTRY" >> ${quote(join(ev, "shell-libraries.tsv"))}\nexec ${prefix} "$@"\n`, { mode: 0o700 });
  assert.equal(run("git", ["init", "-q"]).status, 0);
  writeFileSync(join(registry, "test-repo.md"), `- 路径：\`${repo}\`\n`);
  const remember = (args: string[]) => {
    const out = ab(["remember", "--confirmed", ...args]);
    const id = /\[([0-9a-f]{8})\]/.exec(out)?.[1];
    assert.ok(id, out);
    return id;
  };
  // codex exec 被 isWorkerTranscript 认作 worker 会话，偏好要带 --for-workers 才能进入这一轮注入。
  const pref = remember(["--global", "--kind", "rule", "--for-workers", "--text", "回答保持简短。", "--summary", "验证偏好"]);
  ab(["guidance", pref]);
  const pit = remember(["--kind", "pitfall", "--text", "test-repo 禁止使用全局锁。", "--summary", "验证用锁规则"]);
  ab(["setup", "--cite", "on"]);
  const db = new DatabaseSync(join(store, "store.db"), { readOnly: true });
  const hook = JSON.parse(ab(["recall", "--hook"], env, JSON.stringify({ prompt: "全局锁", cwd: repo })));
  log("hook-output.json", hook);
  const context = hook.hookSpecificOutput.additionalContext;
  assert.ok(context.includes(pref) && context.includes("要不要查历史记忆由你判断") && context.includes("每个最终回答"));
  assert.ok(!context.includes(pit), "hook 不应自动检索坑记忆");

  const hooks = (host: Host) => ({ hooks: { UserPromptSubmit: [{ hooks: [
    { type: "command", command: `${prefix} capture --hook --host ${host}`, timeout: 5 },
    { type: "command", command: `${prefix} recall --hook`, timeout: 5 },
  ] }] } });
  const claudeSettings = join(scratch, "claude-settings.json");
  writeFileSync(claudeSettings, JSON.stringify(hooks("claude")));
  const codexHome = join(scratch, "codex-home");
  mkdirSync(join(codexHome, ".codex"), { recursive: true });
  const auth = join(realHome, ".codex/auth.json");
  if (existsSync(auth)) {
    copyFileSync(auth, join(codexHome, ".codex/auth.json"));
    chmodSync(join(codexHome, ".codex/auth.json"), 0o600);
  }
  // 只复制模型连接设置，不复制真实 hooks、MCP 或项目授权。
  // 沙箱用 danger-full-access（与用户真实配置一致）：workspace-write 下 ps 被禁，ab 就认不出 Codex 会话。
  // 官方 ChatGPT 账号额度用完时（真实出现过），改用本机 pi 配置里的本地网关；没有就继续用真实登录。
  const gateway = (() => {
    try {
      const conf = JSON.parse(readFileSync(join(realHome, ".pi/agent/models.json"), "utf8")) as { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: { id?: string }[] }> };
      for (const p of Object.values(conf.providers ?? {})) {
        if (typeof p?.baseUrl !== "string" || typeof p?.apiKey !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)/.test(p.baseUrl)) continue;
        if (!(p.models ?? []).some((m) => m.id === CODEX_MODEL)) continue;
        const probe = run("curl", ["-s", "-m", "2", "-o", "/dev/null", "-w", "%{http_code}", `${p.baseUrl}/models`, "-H", `Authorization: Bearer ${p.apiKey}`]);
        if (probe.stdout.trim() === "200") return { baseUrl: p.baseUrl, apiKey: p.apiKey };
      }
    } catch {}
    return null;
  })();
  const codexModel = gateway ? CODEX_MODEL : "gpt-5.6-sol";
  writeFileSync(join(codexHome, ".codex/config.toml"), gateway
    ? `model = "${codexModel}"\nmodel_provider = "local"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = true\n[shell_environment_policy]\ninherit = "all"\n[model_providers.local]\nname = "local"\nbase_url = "${gateway.baseUrl}"\nenv_key = "AB_CODEX_KEY"\nwire_api = "responses"\n`
    : `model = "${codexModel}"\nmodel_provider = "custom"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[features]\nhooks = true\n[shell_environment_policy]\ninherit = "all"\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\nsupports_websockets = true\nwire_api = "responses"\n`);
  log("codex-model.json", { model: codexModel, gateway: gateway ? gateway.baseUrl : null });
  writeFileSync(join(codexHome, ".codex/hooks.json"), JSON.stringify(hooks("codex")));
  const piExtension = join(scratch, "pi-recall.ts");
  writeFileSync(piExtension, `import { createExtension, makeExecRunner } from ${JSON.stringify(join(ROOT, "integrations/pi/agentbrain-recall.ts"))};\nexport default createExtension(makeExecRunner([${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}]]));\n`);
  // standalone 使 opencode 的服务进程继承本次测试环境，而不是复用已启动的全局服务。
  const pluginDir = join(repo, ".opencode/plugins");
  mkdirSync(pluginDir, { recursive: true });
  const plugin = readFileSync(join(ROOT, "integrations/opencode/agentbrain-v2.js"), "utf8")
    .replace('const CMD = existsSync(NODE) && existsSync(AB) ? [NODE, [AB]] : ["ab", []];', `const CMD = [${JSON.stringify(process.execPath)}, [${JSON.stringify(CLI)}]];`);
  writeFileSync(join(pluginDir, "agentbrain-v2.js"), plugin);
  const cases: { name: string; prompt: string; expected: Expected }[] = [
    { name: "search-used", prompt: "执行 shell 命令 `ab search 全局锁`，根据返回的坑给一句结论，最后写记忆报告。只引用该坑，不引用偏好。", expected: { status: "used", queried: 1, id: pit } },
    { name: "preference", prompt: "不要使用任何工具。遵守本轮注入的简短回答偏好，回答一句收到并写记忆报告。最后一行严格写成「记忆：简短标题 (8位id)」格式，只列该偏好。", expected: { status: "used", queried: 0, id: pref } },
    { name: "unused", prompt: "不要使用任何工具。严格只回复以下两行：\n收到\n记忆：本轮未用", expected: { status: "unused", queried: 0 } },
    { name: "unreported", prompt: '本轮在测试报告缺失的处理。不要使用工具，故意不写记忆报告。严格只输出 {"ok":true}，不加其他文字。', expected: { status: "unreported", queried: 0 } },
    { name: "empty-search", prompt: "执行 `ab search zzzmemvisnotfoundzzzz`。没有结果时只回答以下两行：\n没有结果\n记忆：本轮未用", expected: { status: "unused", queried: 1 } },
  ];
  log("run.json", { root: ROOT, scratch, store, registry, repo, hosts: selected, pref, pit });
  let failed = false;
  try {
    for (const host of selected) {
      const version = run(host, ["--version"]);
      log(`${host}-version.txt`, version.stdout + version.stderr);
      for (const c of cases) {
        const before = new Set(db.prepare("SELECT session_id FROM recall_runs WHERE host=?").all(host).map((r) => r.session_id));
        const sid = randomUUID();
        const childEnv = hostEnv({ ...env, HOME: host === "codex" ? codexHome : realHome, ...(gateway ? { AB_CODEX_KEY: gateway.apiKey } : {}) });
        const prompt = `这是 agentbrain 的隔离闭环验证，只使用当前测试库，不改任何文件或配置。不要执行 ab brief。\n${c.prompt}`;
        const args = host === "claude" ? ["-p", "--setting-sources", "", "--settings", claudeSettings, "--strict-mcp-config", "--tools", "Bash", "--allowedTools", "Bash(ab:*)", "--session-id", sid, "--output-format", "json", prompt]
          : host === "codex" ? ["exec", "--dangerously-bypass-hook-trust", "--json", prompt]
          : host === "pi" ? ["-p", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", "cpa/gemini-3.8-flash-high", "--session-id", sid, "-e", piExtension, "--tools", "bash", "--mode", "json", prompt]
          : ["run", "--standalone", "--format", "json", prompt];
        console.log(`${host}/${c.name} 开始`);
        const r = run(host, args, childEnv);
        const output = r.stdout + "\n" + r.stderr;
        log(`${host}-${c.name}.log`, output);
        log(`${host}-${c.name}-command.json`, { command: host, args, HOME: childEnv.HOME, AB_HOME: childEnv.AB_HOME, AB_REGISTRY: childEnv.AB_REGISTRY, code: r.status, error: r.error?.message });
        const found = db.prepare("SELECT DISTINCT session_id FROM recall_runs WHERE host=? AND session_id IS NOT NULL").all(host).map((r) => String(r.session_id)).filter((id) => !before.has(id));
        if (host === "claude" || host === "pi") sessions.add(sid);
        for (const id of found) sessions.add(id);
        for (const m of output.matchAll(/"(?:thread_id|session_id|sessionID)"\s*:\s*"([a-zA-Z0-9_-]+)"/g)) sessions.add(m[1]);
        try {
          assert.equal(r.status, 0, r.error?.message ?? output.slice(-2000));
          assert.equal(found.length, 1, "hook 必须在测试库登记本次唯一会话");
          if (host === "claude" || host === "pi") assert.equal(found[0], sid);
          log(`${host}-${c.name}-sweep.log`, sweep(sweepEnv));
          const reports = db.prepare("SELECT anchor,cite,status,queried FROM memory_reports WHERE host=? AND session_id=? ORDER BY ts").all(host, found[0]);
          const ids = db.prepare("SELECT short_id,verified FROM memory_report_ids WHERE host=? AND session_id=? ORDER BY short_id").all(host, found[0]);
          const runs = db.prepare("SELECT * FROM recall_runs WHERE host=? AND session_id=?").all(host, found[0]);
          const deliveries = db.prepare("SELECT path,prop_id FROM inject_log WHERE host=? AND session_id=?").all(host, found[0]);
          log(`${host}-${c.name}-sql.json`, { session_id: found[0], reports, ids, runs, deliveries });
          assertScenario(r.status, reports, ids, c.expected);
          if (c.name === "search-used") assert.ok(deliveries.some((d) => d.path === "search" && String(d.prop_id).startsWith(pit)));
          if (c.name === "empty-search") assert.equal(deliveries.length, 0);
          results.push({ host, scenario: c.name, status: "PASS", session_id: found[0] });
          console.log(`${host}/${c.name} PASS`);
        } catch (e) {
          const blocked = /401|usage limit|rate.limit|429|quota|not logged in/i.test(output);
          failed ||= !blocked;
          results.push({ host, scenario: c.name, status: blocked ? "BLOCKED" : "FAIL", reason: String(e), sessions: found });
          console.log(`${host}/${c.name} ${blocked ? "BLOCKED" : "FAIL"}: ${String(e)}`);
          break;
        }
      }
    }
    // 进度 + 工具 + 模型失败：真实提供商造不出可重复的错误，用本机 mock 提供商跑 Pi，确认这一轮不结算。
    if (selected.includes("pi")) {
      const portFile = join(scratch, "mock-port");
      writeFileSync(join(scratch, "mock-provider.mjs"), MOCK_PROVIDER);
      const mock = spawn(process.execPath, [join(scratch, "mock-provider.mjs"), portFile], { detached: true, stdio: "ignore" });
      mock.unref();
      try {
        for (let i = 0; i < 50 && !existsSync(portFile); i++) spawnSync("sleep", ["0.1"]);
        const port = readFileSync(portFile, "utf8").trim();
        const piHome = join(scratch, "pi-mock-home");
        mkdirSync(join(piHome, ".pi/agent"), { recursive: true });
        writeFileSync(join(piHome, ".pi/agent/models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "mock", models: [{ id: "one", name: "mock", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096 }] } } }));
        const sid = randomUUID();
        const r = run("pi", ["-p", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", "mock/one", "--session-id", sid, "-e", piExtension, "--tools", "bash", "--mode", "json", "跑一条 shell 命令"], hostEnv({ ...env, HOME: piHome }), "", 240_000);
        log("pi-progress-then-model-error.log", r.stdout + "\n" + r.stderr);
        sessions.add(sid);
        log("pi-progress-then-model-error-sweep.log", sweep(sweepEnv));
        const runs = db.prepare("SELECT cite FROM recall_runs WHERE host='pi' AND session_id=?").all(sid);
        const reports = db.prepare("SELECT anchor FROM memory_reports WHERE host='pi' AND session_id=?").all(sid);
        log("pi-progress-then-model-error-sql.json", { session_id: sid, runs, reports });
        assert.equal(runs.length, 1, "钩子必须登记这一轮");
        assert.equal(runs[0].cite, 1, "开关打开时钩子记 cite=1");
        assert.equal(reports.length, 0, "进度和模型失败的轮不结算成报告");
        results.push({ host: "pi", scenario: "progress-then-model-error", status: "PASS", session_id: sid });
        console.log("pi/progress-then-model-error PASS");
      } catch (e) {
        failed = true;
        results.push({ host: "pi", scenario: "progress-then-model-error", status: "FAIL", reason: String(e) });
        console.log(`pi/progress-then-model-error FAIL: ${String(e)}`);
      } finally {
        try { process.kill(-mock.pid!, "SIGKILL"); } catch {}
      }
    }
    const shellLogFile = join(ev, "shell-libraries.tsv");
    const shellLog = existsSync(shellLogFile) ? readFileSync(shellLogFile, "utf8").trim().split("\n") : [];
    if (!shellLog.length || !shellLog.every((line) => line === `${store}\t${registry}`)) {
      failed = true;
      results.push({ scenario: "shell-ab", status: "FAIL", reason: "宿主 shell 里的 ab 必须执行且继承测试库环境", log: shellLog });
    }
  } finally {
    db.close();
    const production = join(realHome, ".agentbrain/store.db");
    // 没有正式库（新机器）就谈不上泄漏
    if (!existsSync(production)) log("production-isolation.json", { production, sessions: [...sessions], skipped: "正式库不存在" });
    else {
    const sqlIds = [...sessions].map((id) => `'${id.replaceAll("'", "''")}'`).join(",");
    const tables = run("sqlite3", ["-readonly", production, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('events','inject_log','recall_runs','capture_sessions','memory_queries','memory_reports','memory_report_ids','cite_scan');"]);
    assert.equal(tables.status, 0, tables.stderr);
    const sql = tables.stdout.trim().split("\n").filter(Boolean).map((table) => `SELECT '${table}',count(*) FROM ${table} WHERE session_id IN (${sqlIds || "NULL"});`).join("\n");
    const check = run("sqlite3", ["-readonly", production, sql]);
    log("production-isolation.json", { command: "sqlite3 -readonly", production, sessions: [...sessions], sql, code: check.status, output: check.stdout, error: check.stderr });
    if (check.status !== 0 || !check.stdout.trim() || check.stdout.trim().split("\n").some((line) => !line.endsWith("|0"))) failed = true;
    }
    log("summary.json", { status: failed ? "FAIL" : results.some((r) => (r as { status: string }).status === "BLOCKED") ? "PASS_WITH_BLOCKED" : "PASS", results });
    console.log(`证据 ${ev}`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();

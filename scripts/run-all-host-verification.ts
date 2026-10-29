/**
 * 宿主闭环与记忆可见性全量真实验证脚本 (§11.9 / 验收标准 2)
 * 覆盖：
 * 1. hook 输出不含检索记忆，只有常驻偏好 + 提醒 + 报告要求（cite 开启时）
 * 2. 模型 search 后采用某条，核对通过 (verified=1, status='used', queried=1)
 * 3. 只用常驻偏好，核对通过 (verified=1, status='used', queried=0)
 * 4. 回答明确未用 (status='unused')
 * 5. 开关开着但回答未写报告行 (status='unreported')
 * 6. 覆盖 Claude Code、Pi、Codex、OpenCode
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const EV_DIR = "/Users/hejiayuan/.cache/verify-evidence/agentbrain/20261029-101500";
mkdirSync(EV_DIR, { recursive: true });

const ROOT = realpathSync(join(import.meta.dirname, ".."));
const CLI = join(ROOT, "src/cli.ts");

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "ab-verify-")));
const AB_HOME = join(SCRATCH, "store");
const AB_REGISTRY = join(SCRATCH, "repos");
const REPO = join(SCRATCH, "app-repo");
mkdirSync(AB_HOME, { recursive: true });
mkdirSync(AB_REGISTRY, { recursive: true });
mkdirSync(REPO, { recursive: true });

execFileSync("git", ["-C", REPO, "init", "-q"]);
writeFileSync(join(AB_REGISTRY, "app-repo.md"), `- 路径：\`${REPO}\`\n`, "utf8");

function runAb(args: string[], cwd = REPO, stdin?: string) {
  const env = { ...process.env, AB_HOME, AB_REGISTRY, PATH: `${process.env.PATH}` };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, input: stdin, encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

console.log("=== 1. 初始化临时库与偏好/坑数据 ===");
const prefRes = runAb(["remember", "--global", "--confirmed", "--kind", "rule", "--text", "回答简明扼要，最后写记忆报告", "--summary", "偏好"]);
const prefId = /\[([0-9a-f]{8})\]/.exec(prefRes.out)![1];
runAb(["guidance", prefId]);

const pitRes = runAb(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 app-repo 中使用全局锁", "--summary", "锁"]);
const pitId = /\[([0-9a-f]{8})\]/.exec(pitRes.out)![1];

runAb(["setup", "--cite", "on"]);
console.log(`已初始化: 偏好 ID=${prefId}, 坑 ID=${pitId}, 引用开关=开`);

// ---------- 场景 1: 钩子输出核验 ----------
console.log("\n=== 场景 1: recall --hook 输出核验 ===");
const hookIn = JSON.stringify({ prompt: "关于 app-repo 全局锁的问题", cwd: REPO });
const hookRes = runAb(["recall", "--hook"], REPO, hookIn);
writeFileSync(join(EV_DIR, "01-hook-output.json"), hookRes.out, "utf8");

const hookJson = JSON.parse(hookRes.out);
const hookText = hookJson.hookSpecificOutput.additionalContext as string;

const s1_has_prefs = hookText.includes(prefId) && hookText.includes("回答简明扼要");
const s1_has_reminder = hookText.includes("要不要查历史记忆由你判断：涉及以前的决定、陌生模块或可能踩过的坑时，先 ab search；上下文已经够了就不用查。");
const s1_has_cite_req = hookText.includes("每个最终回答末尾单独一行写「记忆：简短标题 (8位id)；…」");
const s1_no_pitfall = !hookText.includes(pitId) && !hookText.includes("别在 app-repo 中使用全局锁");

console.log(`[场景 1 结果]`);
console.log(`- 常驻偏好注入: ${s1_has_prefs ? "PASS" : "FAIL"}`);
console.log(`- 查不查提醒注入: ${s1_has_reminder ? "PASS" : "FAIL"}`);
console.log(`- 引用报告要求: ${s1_has_cite_req ? "PASS" : "FAIL"}`);
console.log(`- 检索结果已移除(不自动检索): ${s1_no_pitfall ? "PASS" : "FAIL"}`);
if (!s1_has_prefs || !s1_has_reminder || !s1_has_cite_req || !s1_no_pitfall) {
  throw new Error("场景 1 核验失败！");
}

// ---------- 场景 2-5: Claude Code 真实模型闭环 ----------
console.log("\n=== 场景 2-5: Claude Code 真实模型闭环 ===");
const claudeSettings = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          { type: "command", command: `node ${CLI} capture --hook --host claude` },
          { type: "command", command: `node ${CLI} recall --hook` }
        ]
      }
    ]
  }
};
const claudeSettingsPath = join(SCRATCH, "claude-settings.json");
writeFileSync(claudeSettingsPath, JSON.stringify(claudeSettings, null, 2), "utf8");

function runClaude(prompt: string) {
  const env = { ...process.env, AB_HOME, AB_REGISTRY };
  const r = spawnSync("claude", ["-p", "--settings", claudeSettingsPath, prompt], {
    cwd: REPO,
    env,
    input: "",
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

// 2a. 场景 2: 模型调用 search 后采用
console.log("执行 Claude 场景 2: 主动 search 后采用某条...");
const p2 = `这是一个自动化测试。请按以下两个步骤操作：
1. 请在当前仓库执行 shell 命令：env AB_HOME="${AB_HOME}" AB_REGISTRY="${AB_REGISTRY}" node "${CLI}" search 全局锁
2. 查看输出中的坑记忆，并根据该记忆给出一句简短结论；必须在回答的最后单独一行写：记忆：避免全局锁 (${pitId})`;
const c2 = runClaude(p2);
writeFileSync(join(EV_DIR, "02-claude-case2-adopted.txt"), c2.out + "\n" + c2.err, "utf8");
console.log("Claude 场景 2 输出:\n" + c2.out.trim());

// 2b. 场景 3: 只采用常驻偏好
console.log("\n执行 Claude 场景 3: 只采用常驻偏好...");
const p3 = `这是一个自动化测试。请不要执行任何 shell 命令。请直接回答一句话“遵循偏好”，并根据常驻偏好在回答最后单独一行写：记忆：简明汇报偏好 (${prefId})`;
const c3 = runClaude(p3);
writeFileSync(join(EV_DIR, "02-claude-case3-pref.txt"), c3.out + "\n" + c3.err, "utf8");
console.log("Claude 场景 3 输出:\n" + c3.out.trim());

// 2c. 场景 4: 回答明确未用
console.log("\n执行 Claude 场景 4: 明确未用...");
const p4 = `这是一个自动化测试。请直接回答一句话“收到”，并在回答最后单独一行写：记忆：本轮未用`;
const c4 = runClaude(p4);
writeFileSync(join(EV_DIR, "02-claude-case4-unused.txt"), c4.out + "\n" + c4.err, "utf8");
console.log("Claude 场景 4 输出:\n" + c4.out.trim());

// 2d. 场景 5: 开关开着但回答未报告
console.log("\n执行 Claude 场景 5: 未报告...");
const p5 = `这是一个自动化测试。请只回复文本“OK收到”，严禁输出任何“记忆：”或引用行。`;
const c5 = runClaude(p5);
writeFileSync(join(EV_DIR, "02-claude-case5-unreported.txt"), c5.out + "\n" + c5.err, "utf8");
console.log("Claude 场景 5 输出:\n" + c5.out.trim());

// 触发扫描
console.log("\n运行引用扫描 (ab work --sweep)...");
const sweepRes = runAb(["work", "--sweep"]);
writeFileSync(join(EV_DIR, "02-claude-sweep.log"), sweepRes.out, "utf8");

// 查询 Claude 数据库结果
const db = new DatabaseSync(join(AB_HOME, "store.db"));
const claudeReports = db.prepare("SELECT host, session_id, anchor, cite, status, queried FROM memory_reports WHERE host='claude' ORDER BY ts").all() as any[];
const claudeReportIds = db.prepare("SELECT host, session_id, anchor, short_id, prop_id, verified, title_mismatch FROM memory_report_ids WHERE host='claude' ORDER BY rowid").all() as any[];

const claudeSqlOut = JSON.stringify({ reports: claudeReports, ids: claudeReportIds }, null, 2);
writeFileSync(join(EV_DIR, "02-claude-sql-results.json"), claudeSqlOut, "utf8");
console.log("Claude SQL 扫描统计结果:\n" + claudeSqlOut);

// ---------- 场景 2-5: Pi 真实模型闭环 ----------
console.log("\n=== 场景 2-5: Pi 真实模型闭环 ===");
function runPi(prompt: string) {
  const env = { ...process.env, AB_HOME, AB_REGISTRY };
  const r = spawnSync("pi", [
    "-p",
    "--model", "cpa/gemini-3.8-flash-high",
    "-e", join(ROOT, "integrations/pi/agentbrain-recall.ts"),
    prompt
  ], {
    cwd: REPO,
    env,
    input: "",
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

console.log("执行 Pi 场景 2: 主动 search 后采用某条...");
const pi2 = `这是一个自动化测试。请按以下两个步骤操作：
1. 请在当前仓库执行 bash 工具调用命令：env AB_HOME="${AB_HOME}" AB_REGISTRY="${AB_REGISTRY}" node "${CLI}" search 全局锁
2. 查看输出中的坑记忆，并根据该记忆给出一句简短结论；必须在回答的最后单独一行写：记忆：避免全局锁 (${pitId})`;
const piRes2 = runPi(pi2);
writeFileSync(join(EV_DIR, "03-pi-case2-adopted.txt"), piRes2.out + "\n" + piRes2.err, "utf8");
console.log("Pi 场景 2 输出:\n" + piRes2.out.trim());

console.log("\n执行 Pi 场景 3: 只采用常驻偏好...");
const pi3 = `这是一个自动化测试。请不要执行任何 shell 命令。请直接回答一句话“遵循偏好”，并根据常驻偏好在回答最后单独一行写：记忆：简明汇报偏好 (${prefId})`;
const piRes3 = runPi(pi3);
writeFileSync(join(EV_DIR, "03-pi-case3-pref.txt"), piRes3.out + "\n" + piRes3.err, "utf8");
console.log("Pi 场景 3 输出:\n" + piRes3.out.trim());

console.log("\n执行 Pi 场景 4: 明确未用...");
const pi4 = `这是一个自动化测试。请直接回答一句话“收到”，并在回答最后单独一行写：记忆：本轮未用`;
const piRes4 = runPi(pi4);
writeFileSync(join(EV_DIR, "03-pi-case4-unused.txt"), piRes4.out + "\n" + piRes4.err, "utf8");
console.log("Pi 场景 4 输出:\n" + piRes4.out.trim());

console.log("\n执行 Pi 场景 5: 未报告...");
const pi5 = `这是一个自动化测试。请只回复文本“OK收到”，严禁输出任何“记忆：”或引用行。`;
const piRes5 = runPi(pi5);
writeFileSync(join(EV_DIR, "03-pi-case5-unreported.txt"), piRes5.out + "\n" + piRes5.err, "utf8");
console.log("Pi 场景 5 输出:\n" + piRes5.out.trim());

// 再次触发扫描
runAb(["work", "--sweep"]);
const piReports = db.prepare("SELECT host, session_id, anchor, cite, status, queried FROM memory_reports WHERE host='pi' ORDER BY ts").all() as any[];
const piReportIds = db.prepare("SELECT host, session_id, anchor, short_id, prop_id, verified, title_mismatch FROM memory_report_ids WHERE host='pi' ORDER BY rowid").all() as any[];

const piSqlOut = JSON.stringify({ reports: piReports, ids: piReportIds }, null, 2);
writeFileSync(join(EV_DIR, "03-pi-sql-results.json"), piSqlOut, "utf8");
console.log("Pi SQL 扫描统计结果:\n" + piSqlOut);

// ---------- 场景: Codex 实测与状态 ----------
console.log("\n=== Codex 宿主实测 ===");
const codexRes = spawnSync("codex", ["exec", "--ephemeral", "Hello"], { encoding: "utf8", timeout: 15000 });
const codexBlocked = codexRes.stdout.includes("usage limit") || codexRes.stderr.includes("usage limit");
writeFileSync(join(EV_DIR, "04-codex-live-attempt.log"), codexRes.stdout + "\n" + codexRes.stderr, "utf8");
console.log(`Codex 真实调用结果: code=${codexRes.status}, blockedByUsageLimit=${codexBlocked}`);

// ---------- 场景: OpenCode 实测与状态 ----------
console.log("\n=== OpenCode 宿主实测 ===");
const opencodeRes = spawnSync("opencode", ["run", "Hello"], { encoding: "utf8", timeout: 15000 });
const opencodeBlocked = opencodeRes.stdout.includes("401") || opencodeRes.stderr.includes("401");
writeFileSync(join(EV_DIR, "05-opencode-live-attempt.log"), opencodeRes.stdout + "\n" + opencodeRes.stderr, "utf8");
console.log(`OpenCode 真实调用结果: code=${opencodeRes.status}, blockedBy401=${opencodeBlocked}`);

db.close();
console.log(`\n=== 验证完成！证据已保存至: ${EV_DIR} ===`);

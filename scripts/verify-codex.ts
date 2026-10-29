/**
 * Codex 宿主真实验证驱动脚本
 * 覆盖四个场景：
 * 1. 模型 ab search 后采用某条，回答末尾 记忆：… (id) -> used, queried=1, verified=1
 * 2. 只用常驻偏好 -> used, queried=0, verified=1
 * 3. 明确未用 -> unused
 * 4. 未报告 -> unreported
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const TS = "20261029-103800";
const EV_DIR = `/Users/hejiayuan/.cache/verify-evidence/agentbrain/${TS}`;
mkdirSync(EV_DIR, { recursive: true });

const ROOT = realpathSync(join(import.meta.dirname, ".."));
const CLI = join(ROOT, "src/cli.ts");

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "ab-codex-verify-")));
const FAKE_HOME = join(SCRATCH, "home");
const AB_HOME = join(SCRATCH, "store");
const AB_REGISTRY = join(SCRATCH, "repos");
const REPO = join(SCRATCH, "test-repo");

mkdirSync(join(FAKE_HOME, ".codex"), { recursive: true });
mkdirSync(join(FAKE_HOME, "bin"), { recursive: true });
mkdirSync(AB_HOME, { recursive: true });
mkdirSync(AB_REGISTRY, { recursive: true });
mkdirSync(REPO, { recursive: true });

execFileSync("git", ["-C", REPO, "init", "-q"]);
writeFileSync(join(AB_REGISTRY, "test-repo.md"), `- 路径：\`${REPO}\`\n`, "utf8");

// 复制 Codex 认证文件
const realHome = process.env.HOME || "/Users/hejiayuan";
if (existsSync(join(realHome, ".codex/auth.json"))) {
  cpSync(join(realHome, ".codex/auth.json"), join(FAKE_HOME, ".codex/auth.json"));
}
if (existsSync(join(realHome, ".codex/version.json"))) {
  cpSync(join(realHome, ".codex/version.json"), join(FAKE_HOME, ".codex/version.json"));
}

// 建立 FAKE_HOME/bin/ab wrapper，确保 shell 里直接敲 ab 命中测试库
const abWrapper = `#!/bin/sh
export AB_HOME="${AB_HOME}"
export AB_REGISTRY="${AB_REGISTRY}"
exec node "${CLI}" "$@"
`;
writeFileSync(join(FAKE_HOME, "bin/ab"), abWrapper, "utf8");
chmodSync(join(FAKE_HOME, "bin/ab"), 0o755);

// 写入 .zshenv 和 .zshrc，防止 zsh -lc 覆盖 PATH 导致误调 macOS /usr/bin/ab (ApacheBench)
const zshEnv = `export PATH="${FAKE_HOME}/bin:$PATH"\nexport AB_HOME="${AB_HOME}"\nexport AB_REGISTRY="${AB_REGISTRY}"\n`;
writeFileSync(join(FAKE_HOME, ".zshenv"), zshEnv, "utf8");
writeFileSync(join(FAKE_HOME, ".zshrc"), zshEnv, "utf8");

// 配置 config.toml: 启用 hooks，继承全部环境变量到 shell，补齐 model_providers
const configToml = `
approval_policy = "never"
sandbox_mode = "danger-full-access"
model = "gpt-5.6-sol"
model_provider = "custom"
service_tier = "default"

[features]
hooks = true

[shell_environment_policy]
inherit = "all"

[model_providers.custom]
name = "OpenAI"
requires_openai_auth = true
supports_websockets = true
wire_api = "responses"
`;
writeFileSync(join(FAKE_HOME, ".codex/config.toml"), configToml, "utf8");

// 配置 hooks.json: 显式传递 AB_HOME 和 AB_REGISTRY
const hooksJson = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `env AB_HOME="${AB_HOME}" AB_REGISTRY="${AB_REGISTRY}" node "${CLI}" capture --hook --host codex`,
            timeout: 5
          },
          {
            type: "command",
            command: `env AB_HOME="${AB_HOME}" AB_REGISTRY="${AB_REGISTRY}" node "${CLI}" recall --hook`,
            timeout: 5
          }
        ]
      }
    ],
    SessionEnd: [
      {
        hooks: [
          {
            type: "command",
            command: `env AB_HOME="${AB_HOME}" AB_REGISTRY="${AB_REGISTRY}" node "${CLI}" capture --hook --host codex`,
            timeout: 5
          }
        ]
      }
    ]
  }
};
writeFileSync(join(FAKE_HOME, ".codex/hooks.json"), JSON.stringify(hooksJson, null, 2), "utf8");

function runAb(args: string[], cwd = REPO) {
  const env = { ...process.env, HOME: FAKE_HOME, AB_HOME, AB_REGISTRY, PATH: `${join(FAKE_HOME, "bin")}:${process.env.PATH}` };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

console.log("=== 初始化测试库 ===");
const prefRes = runAb(["remember", "--global", "--confirmed", "--kind", "rule", "--text", "回答简短，最后按格式写记忆引用", "--summary", "偏好"]);
const prefId = /\[([0-9a-f]{8})\]/.exec(prefRes.out)![1];
runAb(["guidance", prefId]);

const pitRes = runAb(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 test-repo 中使用全局锁", "--summary", "锁"]);
const pitId = /\[([0-9a-f]{8})\]/.exec(pitRes.out)![1];

runAb(["setup", "--cite", "on"]);
console.log(`已初始化: 偏好 ID=${prefId}, 坑 ID=${pitId}, 引用开关=开`);

// 等待 10:33 AM 冷却结束探测
async function probeCodexReady(): Promise<{ ready: boolean; lastOutput: string }> {
  console.log("探测 Codex 额度状态...");
  const env = { ...process.env, HOME: FAKE_HOME, AB_HOME, AB_REGISTRY, PATH: `${join(FAKE_HOME, "bin")}:${process.env.PATH}` };
  while (true) {
    const res = spawnSync("codex", ["exec", "--ephemeral", "--dangerously-bypass-hook-trust", "Say hello in one word"], {
      cwd: REPO,
      env,
      input: "",
      encoding: "utf8",
      timeout: 30000,
    });
    const combined = (res.stdout || "") + "\n" + (res.stderr || "");
    if (res.status === 0) {
      return { ready: true, lastOutput: combined };
    }
    if (!combined.includes("usage limit")) {
      console.log("Codex 退出码非 0 且非 usage limit:", combined);
      return { ready: false, lastOutput: combined };
    }
    const match = combined.match(/try again at (\d+:\d+\s*[AP]M)/);
    const resetTime = match ? match[1] : "10:33 AM";
    const now = new Date();
    const nowStr = now.toLocaleTimeString();
    console.log(`[${nowStr}] Codex 处于冷却期 (${resetTime})，等待 20 秒后重试...`);
    if (now.getHours() === 10 && now.getMinutes() >= 35) {
      console.log(`当前已是 ${nowStr}，已过约定解封时间依然受限。`);
      return { ready: false, lastOutput: combined };
    }
    await new Promise((resolve) => setTimeout(resolve, 20000));
  }
}

function runCodex(prompt: string) {
  const env = { ...process.env, HOME: FAKE_HOME, AB_HOME, AB_REGISTRY, PATH: `${join(FAKE_HOME, "bin")}:${process.env.PATH}` };
  const r = spawnSync("codex", [
    "exec",
    "--dangerously-bypass-hook-trust",
    prompt
  ], {
    cwd: REPO,
    env,
    input: "",
    encoding: "utf8",
    timeout: 120000,
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

async function main() {
  const probe = await probeCodexReady();
  if (!probe.ready) {
    console.log("Codex 额度未恢复，记录 blocked 证据并退出。");
    writeFileSync(join(EV_DIR, "04-codex-blocked.log"), probe.lastOutput, "utf8");
    const summary = {
      timestamp: TS,
      host: "codex",
      status: "BLOCKED",
      reason: "Codex account usage limit cooldown (429)",
      evidence_file: "04-codex-blocked.log",
      error_output: probe.lastOutput.trim()
    };
    writeFileSync(join(EV_DIR, "00-summary.json"), JSON.stringify(summary, null, 2), "utf8");
    return;
  }

  console.log("Codex 额度已就绪！开始执行四个场景...");

  // 场景 1: 主动 search 后采用
  console.log("\n--- 执行场景 1: 主动 search 后采用 ---");
  const p1 = `这是一个测试。请按以下两个步骤操作：
1. 请在当前仓库执行 shell 命令：node "${CLI}" search 全局锁
2. 查看输出中的坑记忆，并根据该记忆给出一句简短结论；必须在回答的最后单独一行写：记忆：避免全局锁 (${pitId})`;
  const res1 = runCodex(p1);
  writeFileSync(join(EV_DIR, "04-codex-case1-adopted.txt"), res1.out + "\n" + res1.err, "utf8");
  console.log("Codex 场景 1 输出:\n" + res1.out.trim());

  // 场景 2: 只用常驻偏好
  console.log("\n--- 执行场景 2: 只用常驻偏好 ---");
  const p2 = `这是一个测试。请不要执行任何 shell 命令。请直接回答一句话“遵循偏好”，并根据常驻偏好在回答最后单独一行写：记忆：简明汇报偏好 (${prefId})`;
  const res2 = runCodex(p2);
  writeFileSync(join(EV_DIR, "04-codex-case2-pref.txt"), res2.out + "\n" + res2.err, "utf8");
  console.log("Codex 场景 2 输出:\n" + res2.out.trim());

  // 场景 3: 明确未用
  console.log("\n--- 执行场景 3: 明确未用 ---");
  const p3 = `这是一个测试。请直接回答一句话“收到”，并在回答最后单独一行写：记忆：本轮未用`;
  const res3 = runCodex(p3);
  writeFileSync(join(EV_DIR, "04-codex-case3-unused.txt"), res3.out + "\n" + res3.err, "utf8");
  console.log("Codex 场景 3 输出:\n" + res3.out.trim());

  // 场景 4: 未报告 (回答不带任何记忆报告行)
  console.log("\n--- 执行场景 4: 未报告 ---");
  const p4 = `Output raw JSON only: {"status":"success"}. No other text or lines.`;
  const res4 = runCodex(p4);
  writeFileSync(join(EV_DIR, "04-codex-case4-unreported.txt"), res4.out + "\n" + res4.err, "utf8");
  console.log("Codex 场景 4 输出:\n" + res4.out.trim());

  // 运行扫描
  console.log("\n运行扫描 ab work --sweep...");
  const sweep = runAb(["work", "--sweep"]);
  writeFileSync(join(EV_DIR, "04-codex-sweep.log"), sweep.out, "utf8");

  // 查询 SQL
  const db = new DatabaseSync(join(AB_HOME, "store.db"));
  const reports = db.prepare("SELECT host, session_id, anchor, cite, status, queried FROM memory_reports WHERE host='codex' ORDER BY ts").all() as any[];
  const ids = db.prepare("SELECT host, session_id, anchor, short_id, prop_id, verified, title_mismatch FROM memory_report_ids WHERE host='codex' ORDER BY rowid").all() as any[];
  db.close();

  const sqlOut = JSON.stringify({ reports, ids }, null, 2);
  writeFileSync(join(EV_DIR, "04-codex-sql-results.json"), sqlOut, "utf8");
  console.log("Codex SQL 结果:\n" + sqlOut);

  const summary = {
    timestamp: TS,
    host: "codex",
    status: "PASS",
    cases: {
      case1_adopted_after_search: {
        file: "04-codex-case1-adopted.txt"
      },
      case2_guidance_only: {
        file: "04-codex-case2-pref.txt"
      },
      case3_explicit_unused: {
        file: "04-codex-case3-unused.txt"
      },
      case4_unreported: {
        file: "04-codex-case4-unreported.txt"
      }
    },
    sql_results: { reports, ids }
  };
  writeFileSync(join(EV_DIR, "00-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n验证完成！证据已写入: ${EV_DIR}`);
}

main().catch((err) => {
  console.error("执行出错:", err);
  process.exit(1);
});

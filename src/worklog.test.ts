/**
 * §12.6.6：钩子拉起的后台 ab work 把输出追加到 work.log（以前直接丢掉）。
 * 真跑 ab 子进程：SessionEnd 钩子登记会话并拉起分离的 ab work --session。没有 extract.json，所以窗口延后，原因写进日志。
 * 运行：node --test src/worklog.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "cli.ts");

test("会话结束钩子拉起的 ab work：运行汇总和出错明细写进 work.log，权限 0600；日志过大时轮转", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-worklog-")));
  const abHome = join(dir, "store");
  const fakeHome = join(dir, "home");
  const repos = join(dir, "pm/repos");
  const repo = join(dir, "alpha");
  for (const d of [abHome, repos, repo, join(fakeHome, ".claude/projects/p")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repo, "README.md"), "# alpha\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repos, "alpha.md"), `- 路径：\`${repo}\`\n`);
  const sid = "aaaaaaaa-1111-2222-3333-444444444444";
  const transcript = join(fakeHome, `.claude/projects/p/${sid}.jsonl`);
  writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", cwd: repo, message: { role: "user", content: "以后 hook 命令都写 node 绝对路径" } }) + "\n");
  const env = { ...process.env, AB_HOME: abHome, AB_REGISTRY: repos, HOME: fakeHome };
  for (const k of ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID", "AGENTBRAIN_REVIEWER"]) delete (env as Record<string, string | undefined>)[k];
  // 先放一份超过 5 MB 的旧日志：这次拉起前应改名成 work.log.1
  writeFileSync(join(abHome, "work.log"), "旧".repeat(2 * 1024 * 1024));

  const r = spawnSync(process.execPath, [CLI, "capture", "--hook", "--host", "claude"], {
    env,
    cwd: repo,
    encoding: "utf8",
    input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: repo, hook_event_name: "SessionEnd" }),
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "", "钩子热路径不往宿主写任何东西");

  const log = join(abHome, "work.log");
  let text = "";
  for (let i = 0; i < 100; i++) {
    text = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (/^窗口: /m.test(text)) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.match(text, new RegExp(`^\\S+Z ab work --session claude:${sid}$`, "m"), "这次运行是哪个会话，日志里看得出");
  assert.match(text, /^窗口: 完成 0，延后 1，失败 0，跳过 0$/m);
  assert.match(text, /^出错明细:\n  窗口 claude:aaaaaaaa \d+ 字 no_config: 没有 \S+extract\.json/m, "为什么延后也在日志里");
  assert.ok(!text.includes("旧旧"), "新日志不含旧内容");
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(statSync(`${log}.1`).size, 2 * 1024 * 1024 * 3, "旧日志改名保留一份");
});

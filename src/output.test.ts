/**
 * 文字输出（设计 §12.6.7 T2–T7）：真跑 ab 子进程，库和 HOME 都在临时目录。
 * 运行：node --test src/output.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-output-")));
const home = join(dir, "store");
const fakeHome = join(dir, "home");
const repos = join(dir, "pm/repos");
const alpha = join(dir, "alpha");
const bin = join(dir, "bin");
const binTerm = join(dir, "bin-term");
for (const d of [home, fakeHome, repos, alpha, bin, binTerm]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", alpha]);
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
// 假 ps：bin 让 ab 认为自己在 pi 会话里；bin-term 让它认为不在任何宿主里（人在终端里执行）
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho '${process.pid} 1 pi'\n`);
writeFileSync(join(binTerm, "ps"), `#!/bin/sh\necho '${process.pid} 1 zsh'\n`);
for (const b of [bin, binTerm]) chmodSync(join(b, "ps"), 0o755);
const CLI = join(import.meta.dirname, "cli.ts");
const SESSION = "sess-abcdef-1234";
const WHO = `${userInfo().username}@${hostname()}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function ab(args: string[], opts: { inSession?: boolean } = {}): { out: string; err: string; code: number } {
  const inSession = opts.inSession !== false;
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: alpha,
    encoding: "utf8",
    env: {
      ...process.env,
      AB_HOME: home,
      AB_REGISTRY: repos,
      HOME: fakeHome,
      PATH: `${inSession ? bin : binTerm}:${process.env.PATH}`,
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      PI_SESSION_ID: inSession ? SESSION : "",
    },
  });
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 };
}
const idOf = (out: string) => /\[([0-9a-f]{8})\]/.exec(out)![1];

test("T2/T3：搜索结果每条标确认来源和命中方式", () => {
  const user = idOf(ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "发布脚本要先跑迁移 KEYWORDA", "--summary", "测试"]).out);
  const plain = idOf(ab(["remember", "--kind", "pitfall", "--text", "迁移脚本偶尔超时 KEYWORDA", "--summary", "测试"]).out);
  // 一条自动沉淀、之后被代码核验转正的
  const s = new Store(join(home, "store.db"), join(home, "index.db"));
  const pid = s.ensureProject("alpha");
  const auto = s.remember(pid, "s-auto", false, { kind: "pitfall", text: "模型抽出来的坑 KEYWORDA", confirmed: false, origin: "extract", source: { host: "claude", session_id: "s-auto", transcript: null, anchor: null, summary: "自动沉淀" } });
  s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: auto, body: { outcome: "verified", head: "abc", refs: [], model: "m" } }], () => {});
  s.close();
  const out = ab(["search", "KEYWORDA"]).out;
  assert.match(out, new RegExp(`^\\[${user}\\] alpha 坑\\[用户确认\\]\\[字面\\]: 发布脚本要先跑迁移 KEYWORDA$`, "m"));
  assert.match(out, new RegExp(`^\\[${plain}\\] alpha 坑\\[未确认\\]\\[字面\\]: 迁移脚本偶尔超时 KEYWORDA$`, "m"));
  assert.match(out, new RegExp(`^\\[${auto.slice(0, 8)}\\] alpha 坑\\[代码核验\\]\\[字面\\]: 模型抽出来的坑 KEYWORDA$`, "m"));
});

test("T4：ab get 写明谁确认的、谁写的、哪台机器、是不是在 agent 会话里执行", () => {
  const inSess = idOf(ab(["remember", "--confirmed", "--kind", "decision", "--text", "灰度比例定 17%", "--summary", "灰度"]).out);
  const g1 = ab(["get", inSess]).out;
  assert.match(g1, new RegExp(`^确认: 用户确认 · ${WHO} · \\d{4}-\\d\\d-\\d\\d · 在 agent 会话 sess-abc 里执行$`, "m"));
  assert.match(g1, new RegExp(`^写入: ${WHO} · 在 pi 会话 sess-abc 里执行 · \\d{4}-\\d\\d-\\d\\d$`, "m"));

  const term = idOf(ab(["remember", "--confirmed", "--kind", "decision", "--text", "人在终端里记的决定", "--summary", "终端"], { inSession: false }).out);
  const g2 = ab(["get", term]).out;
  assert.match(g2, new RegExp(`^确认: 用户确认 · ${WHO} · \\d{4}-\\d\\d-\\d\\d · 不在 agent 会话里执行$`, "m"));
  assert.match(g2, new RegExp(`^写入: ${WHO} · 不在 agent 会话里执行 · `, "m"));
  assert.match(g2, /^来源: 终端（命令行）（没有可展开的对话记录）/m);
  assert.doesNotMatch(g2, /未知宿主/);

  const pending = idOf(ab(["remember", "--kind", "rule", "--text", "还没人确认的规则", "--summary", "待定"]).out);
  assert.match(ab(["get", pending]).out, /^确认: 还没有人确认$/m);
});

test("T7：在 agent 会话里 ab confirm 会注明记为用户确认、由哪个会话执行；终端里执行不多说", () => {
  const a = idOf(ab(["remember", "--kind", "rule", "--text", "待确认规则甲", "--summary", "x"]).out);
  const c = ab(["confirm", a]);
  assert.match(c.out, new RegExp(`^已确认 \\[${a}\\] 待确认规则甲\\n这次记为用户确认，由 pi 会话 sess-abc 执行。只有用户明确说认可时才该执行这条命令；如果不是，请如实告诉用户。$`, "m"));
  assert.match(ab(["get", a]).out, /^确认: 用户确认 · \S+ · \d{4}-\d\d-\d\d · 在 agent 会话 sess-abc 里执行$/m);

  const b = idOf(ab(["remember", "--kind", "rule", "--text", "待确认规则乙", "--summary", "x"]).out);
  const t = ab(["confirm", b], { inSession: false });
  assert.equal(t.out, `已确认 [${b}] 待确认规则乙\n`);
  assert.match(ab(["get", b]).out, /^确认: 用户确认 · \S+ · \d{4}-\d\d-\d\d · 不在 agent 会话里执行$/m);
});

test("T6：参数写错只打印这个子命令的用法", () => {
  const r = ab(["remember", "--confirmed", "直接把内容当位置参数"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unexpected argument/);
  assert.match(r.err, /^  ab remember --kind <rule\|decision\|pitfall\|note> --text <内容> --summary <当时在讨论什么>$/m);
  assert.doesNotMatch(r.err, /ab brief|ab search|ab work|ab curate/, "不把别的命令的用法一起倒出来");
  assert.ok(r.err.split("\n").length < 20, `用法 ${r.err.split("\n").length} 行`);
  assert.match(r.err, /全部命令看 ab help/);
  const s = ab(["search", "--nope"]);
  assert.match(s.err, /^  ab search <关键词…>/m);
  assert.match(s.err, /^  ab search --scene/m, "同一个命令的几种写法都给");
  assert.doesNotMatch(s.err, /ab remember --kind/);
  assert.match(ab(["help"]).out, /ab brief[\s\S]*ab purge --session/, "ab help 仍是全部用法");
});

test("ab status：真实命令打印代码提交号、库版本、备份三行", () => {
  const out = ab(["status"]).out;
  const head = execFileSync("git", ["-C", import.meta.dirname, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  assert.match(out.split("\n")[0], /^要处理（\d+ 项）:$/);
  assert.match(out, new RegExp(`^代码: ${head}(（\\S+）)?，(有 \\d+ 个文件没提交|没有未提交改动)  \\S+$`, "m"));
  assert.match(out, /^库: 版本 1（代码支持 1）；事件 \d+ 条；不认识的事件 0 条$/m);
  assert.match(out, /^备份: 还没有/m);
  assert.equal(ab(["backup"]).code, 0);
  assert.match(ab(["status"]).out, /^备份: 最近一次 \S+（不到 1 小时前），共 1 份  \S+ab-backup-\S+\.db$/m);
});

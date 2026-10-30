/**
 * 命令行流程。运行：node --test src/cli.test.ts
 * store 与清单都指向临时目录，不碰真实的 ~/.agentbrain 与 pm。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-cli-")));
const home = join(dir, "store");
const fakeHome = join(dir, "fakehome");
const repos = join(dir, "pm/repos");
mkdirSync(repos, { recursive: true });

// 子进程不走真实宿主：假 ps 把父进程报成 pi，假 home 里放一份 transcript。
const SESSION = "cli-test-session";
const bin = join(dir, "bin");
mkdirSync(bin);
// CLI 的父进程就是本测试进程；ps -A -o pid=,ppid=,<col>= 都报它为 pi。
writeFileSync(join(bin, "ps"), `#!/bin/sh\necho '${process.pid} 1 pi'\n`);
chmodSync(join(bin, "ps"), 0o755);
const keyRead = join(dir, "fake-key-read");
writeFileSync(join(bin, "security"), `#!/bin/sh\ntouch '${keyRead}'\necho fixture-key\n`);
chmodSync(join(bin, "security"), 0o755);
const networkGuard = join(dir, "offline.mjs");
writeFileSync(networkGuard, `
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { throw new Error('测试禁止真实网络请求'); };
http.request = http.get = https.request = https.get = net.connect = net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://embedding.invalid/v1/embeddings') blocked();
  const body = JSON.parse(init.body);
  if (body.model === 'fail') return new Response(JSON.stringify({ error: { message: '假接口故障' } }), { status: 503 });
  return new Response(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [1, 0, 0] })) }));
};
`);
const transcriptDir = join(fakeHome, ".pi/agent/sessions/x");
mkdirSync(transcriptDir, { recursive: true });
writeFileSync(
  join(transcriptDir, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`),
  [
    { type: "message", id: "e1", parentId: null, message: { role: "user", content: "fixture 用户原话" } },
    { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: "fixture 助手回复" } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n",
);

function repo(name: string): string {
  const r = join(dir, name);
  execFileSync("git", ["init", "-q", r]);
  writeFileSync(join(repos, `${name}.md`), `- 路径：\`${r}\`\n`);
  return r;
}
const alpha = repo("alpha");
const beta = repo("beta");
const nowhere = join(dir, "nowhere");
mkdirSync(nowhere);

const CLI = join(import.meta.dirname, "cli.ts");

function ab(args: string[], cwd: string, storeHome = home, extraEnv: Record<string, string> = {}): { out: string; err: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", networkGuard, CLI, ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        AB_HOME: storeHome,
        AB_REGISTRY: repos,
        HOME: fakeHome,
        PATH: `${bin}:${process.env.PATH}`,
        CLAUDE_CODE_SESSION_ID: "",
        CODEX_THREAD_ID: "",
        PI_SESSION_ID: SESSION,
        ...extraEnv,
      },
    });
    return { out, err: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: err.stdout ?? "", err: err.stderr ?? "", code: err.status ?? -1 };
  }
}

test("hook 只注入偏好和提醒，不再检索；search/get/brief 交付带会话", () => {
  const own = join(dir, "visibility-store");
  const remembered = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "自动检索不应注入的特有旧坑", "--summary", "fixture"], alpha, own);
  assert.equal(remembered.code, 0);
  const id = /\[([0-9a-f]{8})\]/.exec(remembered.out)![1];
  const hook = spawnSync("node", ["--import", networkGuard, CLI, "recall", "--hook"], {
    cwd: alpha, encoding: "utf8", input: JSON.stringify({ prompt: "自动检索不应注入的特有旧坑", cwd: alpha }),
    env: { ...process.env, AB_HOME: own, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: SESSION },
  });
  assert.equal(hook.status, 0);
  const content = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(content, /要不要查历史记忆由你判断/);
  assert.doesNotMatch(content, /自动检索不应注入的特有旧坑/);
  for (const args of [["brief"], ["search", "特有旧坑"], ["get", id]]) assert.equal(ab(args, alpha, own).code, 0);
  const db = new DatabaseSync(join(own, "store.db"));
  try {
    const rows = db.prepare("SELECT path,host,session_id FROM inject_log WHERE substr(prop_id,1,8)=? ORDER BY id").all(id);
    assert.deepEqual(rows.map((r) => r.path), ["brief", "search", "get"]);
    assert.ok(rows.every((r) => r.host === "pi" && r.session_id === SESSION));
  } finally { db.close(); }
});

test("零结果 search 也记录查询事件，不伪造交付 id", () => {
  const own = join(dir, "empty-query-store");
  const result = ab(["search", "nonexistent_unique_query_123"], alpha, own);
  assert.equal(result.code, 0, result.err);
  const db = new DatabaseSync(join(own, "store.db"));
  try {
    const queries = db.prepare("SELECT host,session_id,path,ts FROM memory_queries").all();
    assert.equal(queries.length, 1);
    assert.equal(queries[0].host, "pi");
    assert.equal(queries[0].session_id, SESSION);
    assert.equal(queries[0].path, "search");
    assert.ok(Number.isFinite(Date.parse(String(queries[0].ts))));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inject_log").get()?.n, 0);
  } finally { db.close(); }
});

test("已登记仓库 remember 一个坑后 brief 能看到", () => {
  const r = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 alpha 里用全局锁", "--summary", "讨论锁"], alpha);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /已记住/);
  const b = ab(["brief"], alpha);
  assert.match(b.out, /别在 alpha 里用全局锁/);
  assert.match(b.out, /<agentbrain project="alpha">/);
});

test("全局规则出现在另一个已登记仓库的 brief 里", () => {
  const r = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "实现交给 Codex", "--summary", "分工"], alpha);
  assert.equal(r.code, 0, r.err);
  const b = ab(["brief"], beta);
  assert.match(b.out, /实现交给 Codex/);
});

test("--worker 只看得到标了 for_workers 的全局规则", () => {
  const marked = ab(
    ["remember", "--confirmed", "--global", "--for-workers", "--kind", "rule", "--text", "代码风格统一两个空格", "--summary", "风格"],
    alpha,
  );
  assert.equal(marked.code, 0, marked.err);
  const b = ab(["brief", "--worker"], beta);
  assert.match(b.out, /代码风格统一两个空格/);
  assert.doesNotMatch(b.out, /实现交给 Codex/);
  assert.match(b.out, /worker/);
});

test("pm 仓库里不给项目名时，brief 给全局规则和各项目概况", () => {
  execFileSync("git", ["init", "-q", join(dir, "pm")]);
  const b = ab(["brief"], join(dir, "pm"));
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /实现交给 Codex/);
  assert.match(b.out, /alpha：坑 1、规则 0、决定 0/);
  assert.match(b.out, /beta：坑 0、规则 0、决定 0/);
});

test("未登记目录 remember 不带 --global 报错", () => {
  const r = ab(["remember", "--kind", "note", "--text", "随便一条", "--summary", "无"], nowhere);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /不是已登记项目/);
  const b = ab(["brief"], nowhere);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /当前目录不是已登记项目/);
  assert.match(b.out, /实现交给 Codex/, "未登记目录仍给全局");
});

test("ps 失败时 remember 仍进 brief，status 报宿主检测失败", () => {
  writeFileSync(join(bin, "ps"), "#!/bin/sh\necho 'ps 坏了' >&2\nexit 1\n");
  const r = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "检测失败也要记住", "--summary", "无来源"], alpha);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /未找到会话记录，这条记忆没有可展开的来源/);
  assert.match(ab(["brief"], alpha).out, /检测失败也要记住/);
  assert.match(ab(["status"], alpha).out, /宿主检测失败/);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\necho '${process.pid} 1 pi'\n`);
});

test("多行记忆在 brief 里压成一行，后半段还在", () => {
  const r = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "第一行\n\n第二行还在", "--summary", "多行"], alpha);
  assert.equal(r.code, 0, r.err);
  const b = ab(["brief"], alpha);
  assert.match(b.out, /第一行 \/ 第二行还在/);
});

test("--worker 全局规则很多时项目坑仍在", () => {
  for (let i = 0; i < 60; i++) {
    const r = ab(
      ["remember", "--confirmed", "--global", "--for-workers", "--kind", "rule", "--text", `子代理规则第 ${i} 条 `.padEnd(80, "x"), "--summary", "预算"],
      alpha,
    );
    assert.equal(r.code, 0, r.err);
  }
  const pit = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "worker 预算下的项目坑", "--summary", "预算"], beta);
  assert.equal(pit.code, 0, pit.err);
  assert.match(ab(["brief", "--worker"], beta).out, /worker 预算下的项目坑/);
});

test("清单改名后 status 报孤立项目", () => {
  const r = ab(["remember", "--confirmed", "--kind", "note", "--text", "alpha 里的一条", "--summary", "孤立"], alpha);
  assert.equal(r.code, 0, r.err);
  renameSync(join(repos, "alpha.md"), join(repos, "gamma.md"));
  try {
    assert.match(ab(["status"], beta).out, /孤立项目: alpha/);
  } finally {
    renameSync(join(repos, "gamma.md"), join(repos, "alpha.md"));
  }
});

test("agent 不带 --confirmed 的 remember：照常生效、标未确认，能搜到、不进 brief；用户 confirm 后进 brief（§8.8）", () => {
  const r = ab(["remember", "--kind", "pitfall", "--text", "自己记下的未确认坑", "--summary", "自记"], alpha);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /已记住 \[[0-9a-f]{8}\]/);
  assert.match(r.out, /未确认：不进 brief/);
  const id = r.out.match(/\[([0-9a-f]{8})\]/)![1];
  assert.doesNotMatch(ab(["brief"], alpha).out, /自己记下的未确认坑/);
  assert.match(ab(["search", "自己记下的未确认坑"], alpha).out, new RegExp(`\\[${id}\\].*\\[未确认\\]`));
  assert.doesNotMatch(ab(["get", id], alpha).out, /候选/);
  assert.match(ab(["confirm", id], alpha).out, new RegExp(`已确认 \\[${id}\\]`));
  assert.match(ab(["brief"], alpha).out, /自己记下的未确认坑/);
  const c = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "用户要记的坑直接生效", "--summary", "用户要记"], alpha);
  assert.match(ab(["brief"], alpha).out, /用户要记的坑直接生效/, c.err);
  assert.notEqual(ab(["stage", id], alpha).code, 0, "ab stage 已删除");
});
test("未带 --confirmed 的坑不进 brief，search 标未确认，confirm 后进 brief", () => {
  const r = ab(["remember", "--kind", "pitfall", "--text", "agent 自记的坑", "--summary", "自记"], alpha);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /未确认：不进 brief/);
  const id = r.out.match(/\[([0-9a-f]{8})\]/)![1];
  const before = ab(["brief"], alpha);
  assert.doesNotMatch(before.out, /agent 自记的坑/);
  assert.match(before.out, /另有 \d+ 条 agent 自记未确认/);
  const s = ab(["search", "agent 自记的坑"], alpha);
  assert.match(s.out, /\[未确认\]/);
  const g = ab(["get", id], alpha);
  assert.match(g.out, /未确认（agent 自记）/);
  const c = ab(["confirm", id], alpha);
  assert.match(c.out, new RegExp(`已确认 \\[${id}\\] agent 自记的坑`));
  assert.match(ab(["brief"], alpha).out, /agent 自记的坑/);
  assert.match(ab(["confirm", id], alpha).out, /已是确认状态/);
  const missing = ab(["confirm", "deadbeef"], alpha);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /找不到记忆/);
});

test("--worker 排除未确认的 for_workers 全局规则", () => {
  const r = ab(
    ["remember", "--global", "--for-workers", "--kind", "rule", "--text", "子代理不该看到这条未确认规则", "--summary", "自记"],
    alpha,
  );
  assert.equal(r.code, 0, r.err);
  const b = ab(["brief", "--worker"], beta);
  assert.doesNotMatch(b.out, /子代理不该看到这条未确认规则/);
  assert.doesNotMatch(b.out, /另有 \d+ 条 agent 自记未确认/);
  assert.match(b.out, /不写记忆/);
});

test("search、get、archive 基本流程", () => {
  const s = ab(["search", "全局锁"], alpha);
  assert.match(s.out, /alpha 坑: 别在 alpha 里用全局锁/);
  const id = s.out.match(/\[([0-9a-f]{8})\]/)![1];

  const g = ab(["get", id], beta);
  assert.match(g.out, /别在 alpha 里用全局锁/);
  assert.match(g.out, /讨论锁/);
  const expanded = ab(["get", id, "--expand"], beta);
  assert.match(expanded.out, /fixture 用户原话/);
  assert.ok(expanded.out.indexOf("fixture 用户原话") < expanded.out.indexOf("fixture 助手回复"));

  const missing = ab(["get", "deadbeef"], alpha);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /找不到记忆/);

  const a = ab(["archive", id], alpha);
  assert.match(a.out, /已归档/);
  assert.doesNotMatch(ab(["search", "全局锁"], alpha).out, /全局锁/);
  assert.match(ab(["search", "全局锁", "--archived"], alpha).out, /全局锁/);
  assert.match(ab(["archive", id, "--reactivate"], alpha).out, /已恢复/);
  assert.match(ab(["search", "全局锁"], alpha).out, /全局锁/);
});

test("correct 未确认时旧条目仍在 brief，确认后旧条目消失且 search --archived 标已被替代", () => {
  const own = join(dir, "correct-home");
  const run = (args: string[]) => {
    try {
      const out = execFileSync("node", ["--import", networkGuard, CLI, ...args], {
        cwd: alpha,
        encoding: "utf8",
        env: { ...process.env, AB_HOME: own, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: SESSION },
      });
      return { out, err: "", code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: err.stdout ?? "", err: err.stderr ?? "", code: err.status ?? -1 };
    }
  };
  const old = run(["remember", "--confirmed", "--kind", "pitfall", "--text", "锁用全局一把", "--summary", "锁"]);
  assert.equal(old.code, 0, old.err);
  const oldId = old.out.match(/\[([0-9a-f]{8})\]/)![1];
  const neu = run(["correct", oldId, "--text", "锁按账户分", "--summary", "纠正锁"]);
  assert.equal(neu.code, 0, neu.err);
  const neuId = neu.out.match(/\[([0-9a-f]{8})\]/)![1];
  const before = run(["brief"]);
  assert.match(before.out, new RegExp(`锁用全局一把（有待确认的纠正 \\[${neuId}\\]）`));
  assert.doesNotMatch(before.out, /锁按账户分/);
  assert.match(run(["get", oldId]).out, new RegExp(`\n待确认的纠正 \\[${neuId}\\]: 锁按账户分（认可用 ab confirm ${neuId}，否决用 ab archive ${neuId}）`));
  assert.match(run(["search", "全局一把"]).out, new RegExp(`坑（有待确认的纠正 \\[${neuId}\\]）: 锁用全局一把`));
  assert.match(run(["recall", "锁用全局一把"]).out, new RegExp(`坑（有待确认的纠正 \\[${neuId}\\]）: 锁用全局一把`));
  assert.equal(run(["confirm", neuId]).code, 0);
  const after = run(["brief"]);
  assert.doesNotMatch(after.out, /锁用全局一把/);
  assert.match(after.out, /锁按账户分/);
  assert.match(run(["search", "全局一把", "--archived"]).out, /已被替代/);
  const again = run(["correct", oldId, "--text", "再改一次", "--summary", "二次"]);
  assert.notEqual(again.code, 0);
  assert.match(again.err, /只能纠正仍有效的记忆/);
});

test("--from-worker 格式错误报错；找不到的子会话仍记下且来源指向 pi", () => {
  const bad = ab(["remember", "--kind", "note", "--text", "x", "--summary", "s", "--from-worker", "nope:abc"], alpha);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--from-worker/);
  const r = ab(
    ["remember", "--confirmed", "--kind", "pitfall", "--text", "子代理报的坑", "--summary", "汇报", "--from-worker", "pi:does-not-exist"],
    alpha,
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /未找到子代理会话记录/);
  const id = r.out.match(/\[([0-9a-f]{8})\]/)![1];
  const g = ab(["get", id], alpha);
  assert.match(g.out, /（pi）（无 transcript）（经 pi 主会话转记）/);
});

test("没有 embedding 配置：search 提示仅全文检索，status 报不可用，不读 key", () => {
  rmSync(keyRead, { force: true });
  assert.equal(existsSync(join(home, "embedding.json")), false);
  const result = ab(["search", "不存在的搜索关键词"], alpha);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /没有匹配的记忆。\n（仅全文检索：/);
  const status = ab(["status"], alpha);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /向量: 不可用（.*embedding\.json/);
  const remembered = ab(["remember", "--kind", "note", "--text", "无配置也记下", "--summary", "降级"], alpha);
  assert.equal(remembered.code, 0, remembered.err);
  assert.match(remembered.out, /\n向量未更新：.*embedding\.json\n$/);
  const id = remembered.out.match(/\[([0-9a-f]{8})\]/)![1];
  const corrected = ab(["correct", id, "--text", "无配置也纠正", "--summary", "降级"], alpha);
  assert.equal(corrected.code, 0, corrected.err);
  assert.match(corrected.out, /\n向量未更新：.*embedding\.json\n$/);
  assert.match(ab(["get", id], alpha).out, /\n相关: 近邻不可用，这条还没有向量\n$/);
  assert.equal(existsSync(keyRead), false);
});

test("假 embedding：remember/correct 同步、search 混合、status 数量、模型切换与失败降级", () => {
  const own = join(dir, "vector-home");
  mkdirSync(own);
  const config = (model: string) => writeFileSync(join(own, "embedding.json"), JSON.stringify({ baseUrl: "https://embedding.invalid/v1", model }));
  const run = (args: string[]) => ab(args, alpha, own);
  config("fake-one");
  const old = run(["remember", "--confirmed", "--kind", "note", "--text", "猫咪很可爱", "--summary", "假向量"]);
  assert.equal(old.code, 0, old.err);
  assert.doesNotMatch(old.out, /向量未更新/);
  assert.match(run(["status"]).out, /向量: fake-one，已向量化 1\/1/);
  const id = old.out.match(/\[([0-9a-f]{8})\]/)![1];
  const corrected = run(["correct", id, "--confirmed", "--text", "小猫需要照顾", "--summary", "纠正"]);
  assert.equal(corrected.code, 0, corrected.err);
  assert.doesNotMatch(corrected.out, /向量未更新/);
  const found = run(["search", "喵星人"]);
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /小猫需要照顾/);
  assert.doesNotMatch(found.out, /仅全文检索|猫咪很可爱/);
  assert.match(run(["status"]).out, /向量: fake-one，已向量化 2\/2/);
  const neighbor = run(["remember", "--confirmed", "--kind", "note", "--text", "猫粮放在柜子里", "--summary", "近邻"]);
  const neighborId = neighbor.out.match(/\[([0-9a-f]{8})\]/)![1];
  const correctedId = corrected.out.match(/\[([0-9a-f]{8})\]/)![1];
  const got = run(["get", correctedId]).out;
  assert.match(got, new RegExp(`\\n相关（向量近邻）:\\n  \\[${neighborId}\\] alpha 事实: 猫粮放在柜子里（1\\.00）\\n$`));
  // §11.6 (ii)：被替代的旧条目在"关联"里列一行并标状态，但不当近邻
  assert.match(got, /\n关联:\n  纠正了 \[[0-9a-f]{8}\]（已被替代） alpha 事实: 猫咪很可爱\n/);
  assert.doesNotMatch(got.slice(got.indexOf("相关（向量近邻）")), /猫咪很可爱/, "已被替代的旧条目只出现在关联里，不当近邻");
  config("fake-two");
  assert.match(run(["status"]).out, /向量: fake-two，已向量化 0\/3/);
  assert.equal(run(["search", "喵星人"]).code, 0);
  assert.match(run(["status"]).out, /向量: fake-two，已向量化 3\/3/);
  config("fail");
  const failed = run(["remember", "--confirmed", "--kind", "note", "--text", "假接口失败也要保存", "--summary", "失败"]);
  assert.equal(failed.code, 0, failed.err);
  assert.match(failed.out, /向量未更新：.*HTTP 503.*假接口故障/);
  const fallback = run(["search", "接口失败"]);
  assert.equal(fallback.code, 0, fallback.err);
  assert.match(fallback.out, /假接口失败也要保存/);
  assert.match(fallback.out, /仅全文检索：.*假接口故障/);
  assert.doesNotMatch(failed.out + fallback.out, /fixture-key/);
  const invalid = run(["search", "词", "--not-an-option"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /Unknown option.*not-an-option[\s\S]*用法:/);
});

function recall(args: string[], cwd: string, storeHome: string, stdin?: string): { out: string; err: string; code: number } {
  const r = spawnSync("node", ["--import", networkGuard, CLI, ...args], {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      AB_HOME: storeHome,
      AB_REGISTRY: repos,
      HOME: fakeHome,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      PI_SESSION_ID: SESSION,
    },
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
}

test("recall 保留文本检索，recall --hook 改为偏好和提醒（不自动检索）", () => {
  const own = join(dir, "recall-home");
  const remember = (args: string[], cwd = alpha) => ab(["remember", ...args], cwd, own);
  const pit = remember(["--confirmed", "--kind", "pitfall", "--text", "别在 alpha 召回里用全局锁", "--summary", "召回"]);
  assert.equal(pit.code, 0, pit.err);
  assert.equal(remember(["--kind", "pitfall", "--text", "未确认的召回坑不该出现", "--summary", "召回"]).code, 0);
  const archived = remember(["--confirmed", "--kind", "decision", "--text", "已归档的召回决定不该出现", "--summary", "召回"]);
  assert.equal(archived.code, 0, archived.err);
  const archivedId = archived.out.match(/\[([0-9a-f]{8})\]/)![1];
  assert.equal(ab(["archive", archivedId], alpha, own).code, 0);
  assert.equal(remember(["--confirmed", "--kind", "note", "--text", "召回事实不该出现", "--summary", "召回"]).code, 0);
  assert.equal(
    remember(["--confirmed", "--global", "--kind", "rule", "--text", "未标 for_workers 的全局规则不该出现", "--summary", "召回"]).code,
    0,
  );
  const marked = remember([
    "--confirmed",
    "--global",
    "--for-workers",
    "--kind",
    "rule",
    "--text",
    "子代理也要看的召回规则",
    "--summary",
    "召回",
  ]);
  assert.equal(marked.code, 0, marked.err);

  const plain = recall(["recall", "召回 全局锁 子代理"], alpha, own);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /^<agentbrain-recall>\n/);
  assert.match(plain.out, /别在 alpha 召回里用全局锁/);
  assert.match(plain.out, /子代理也要看的召回规则/);
  assert.doesNotMatch(plain.out, /未确认的召回坑|已归档的召回决定|召回事实|未标 for_workers/);

  const hit = recall(["recall", "--hook"], alpha, own, JSON.stringify({ prompt: "召回 全局锁 子代理", cwd: alpha, extra: 1 }));
  assert.equal(hit.code, 0, hit.err);
  assert.equal(hit.err, "");
  const json = JSON.parse(hit.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  const ctx = json.hookSpecificOutput.additionalContext;
  assert.match(ctx, /要不要查历史记忆由你判断/);
  assert.doesNotMatch(ctx, /别在 alpha 召回里用全局锁/);

  const slash = recall(["recall", "--hook"], alpha, own, JSON.stringify({ prompt: "/help 召回", cwd: alpha }));
  const bad = recall(["recall", "--hook"], alpha, own, "not json");
  assert.equal(slash.code, 0);
  assert.equal(slash.out, "");
  assert.equal(bad.code, 0);
  assert.equal(bad.out, "");
});

test("recall 超过 3 条只出前 3 条", () => {
  const own = join(dir, "recall-limit");
  for (let i = 0; i < 5; i++) {
    const r = ab(
      ["remember", "--confirmed", "--kind", "pitfall", "--text", `召回限额第 ${i} 条坑`, "--summary", "限额"],
      alpha,
      own,
    );
    assert.equal(r.code, 0, r.err);
  }
  const hit = recall(["recall", "召回限额"], alpha, own);
  assert.equal(hit.code, 0, hit.err);
  const lines = hit.out.split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(lines.length, 3);
  assert.match(hit.out, /召回限额第 [0-4] 条坑/);
});

test("integrations 里 Claude Code 与 Codex 的样例命令能产出 UserPromptSubmit 的 additionalContext，capture 命令静默成功", () => {
  const own = join(dir, "wiring-home");
  const pit = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "接线样例要能召回这个坑", "--summary", "接线"], alpha, own);
  assert.equal(pit.code, 0, pit.err);
  const shim = join(dir, "ab-shim");
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "ab"), `#!/bin/sh\nexec node --import '${networkGuard}' '${CLI}' "$@"\n`);
  chmodSync(join(shim, "ab"), 0o755);
  for (const file of ["claude-code/settings.example.json", "codex/hooks.example.json"]) {
    const config = JSON.parse(readFileSync(join(import.meta.dirname, "../integrations", file), "utf8")) as {
      hooks: Record<"UserPromptSubmit" | "SessionEnd" | "PreCompact", { hooks: { type: string; command: string }[] }[]>;
    };
    const [handler, capture] = config.hooks.UserPromptSubmit[0].hooks;
    const host = file.startsWith("claude") ? "claude" : "codex";
    for (const [h, event] of [[capture, "UserPromptSubmit"], [config.hooks.SessionEnd[0].hooks[0], "SessionEnd"], [config.hooks.PreCompact[0].hooks[0], "PreCompact"]] as const) {
      assert.equal(h.command, `ab capture --hook --host ${host}`, file);
      const c = spawnSync("sh", ["-c", h.command], {
        cwd: alpha,
        encoding: "utf8",
        input: JSON.stringify({ session_id: `wiring-${host}`, hook_event_name: event, prompt: "x", cwd: alpha }),
        env: { ...process.env, AB_HOME: own, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${shim}:${bin}:${process.env.PATH}` },
      });
      assert.deepEqual([c.status, c.stdout, c.stderr], [0, "", ""], `${file} ${event}`);
    }
    assert.equal(handler.type, "command");
    const r = spawnSync("sh", ["-c", handler.command], {
      cwd: alpha,
      encoding: "utf8",
      input: JSON.stringify({ session_id: "x", hook_event_name: "UserPromptSubmit", prompt: "接线样例 召回", cwd: alpha }),
      env: { ...process.env, AB_HOME: own, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${shim}:${bin}:${process.env.PATH}`, PI_SESSION_ID: SESSION },
    });
    assert.equal(r.status, 0, file);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit", file);
    assert.match(out.hookSpecificOutput.additionalContext, /要不要查历史记忆由你判断/, file);
  }
});

// 放在最后：长内容进独立 AB_HOME，不进共享库；它也负责删掉整个临时目录。
test("recall：有用户原话依据的未确认规则/决定最多 1 条，排在已确认之后、标未确认；推断的坑、有冲突的不进", async () => {
  const own = join(dir, "recall-unconfirmed");
  const made = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "部署脚本召回要先停旧进程", "--summary", "召回"], alpha, own);
  assert.equal(made.code, 0, made.err);
  const { Store } = await import("./store.ts");
  const store = new Store(join(own, "store.db"), join(own, "index.db"));
  const pid = store.ensureProject("alpha");
  const src = { host: "pi" as const, session_id: "s", transcript: null, anchor: "a", summary: "x" };
  const ev = [{ anchor: "a", role: "user" as const, quote_sha256: "h" }];
  const base = { confirmed: false, origin: "extract" as const, source: src, evidence: ev };
  store.remember(pid, "s", false, { ...base, kind: "rule", basis: "user_directive", text: "部署脚本召回一律用用户原话规则甲" });
  store.remember(pid, "s", false, { ...base, kind: "decision", basis: "user_confirmed", text: "部署脚本召回采用用户认可的决定乙" });
  store.remember(pid, "s", false, { ...base, kind: "pitfall", basis: "agent_inference", text: "部署脚本召回推断的坑丙", evidence: [{ anchor: "a", role: "tool", quote_sha256: "h" }] });
  store.close();
  const r = recall(["recall", "部署脚本召回"], alpha, own);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n").filter((l) => l.startsWith("- "));
  assert.match(lines[0], /坑: 部署脚本召回要先停旧进程/, "已确认在前");
  const un = lines.filter((l) => /（未确认）/.test(l));
  assert.equal(un.length, 1, r.out);
  assert.match(un[0], /(规则|决定)（未确认）: 部署脚本召回.*(甲|乙)/);
  assert.equal(lines.indexOf(un[0]), lines.length - 1);
  assert.doesNotMatch(r.out, /推断的坑丙/);
});

test("ab review：列出到期未确认条目；--archive 只归档清单里的（可撤销），已确认/未到期的拒绝；brief 输出的条目记最近注入", async () => {
  const own = join(dir, "review-store");
  const { Store } = await import("./store.ts");
  const s = new Store(join(own, "store.db"), join(own, "index.db"));
  const src = { host: "pi" as const, session_id: "s", transcript: null, anchor: null, summary: "讨论" };
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "pitfall", text: "早就过时的坑", confirmed: false, source: src });
  const keep = s.remember(pid, "s", false, { kind: "pitfall", text: "用户确认过的老坑", confirmed: true, source: src });
  const fresh = s.remember(pid, "s", false, { kind: "pitfall", text: "刚记的坑", confirmed: false, source: src });
  const long = new Date(Date.now() - 400 * 86_400_000).toISOString();
  s.workDb.prepare("UPDATE events SET ts=? WHERE id IN (?,?)").run(long, old, keep);
  s.close();
  const list = ab(["review"], alpha, own);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /到期待复审 1 条/);
  assert.match(list.out, /早就过时的坑.*从未被注入/);
  assert.doesNotMatch(list.out, /用户确认过的老坑|刚记的坑/);
  const refuse = ab(["review", "--archive", keep.slice(0, 8), fresh.slice(0, 8)], alpha, own);
  assert.equal(refuse.code, 1);
  assert.match(refuse.err, /不在到期复审清单里/);
  const doc = ab(["doctor"], alpha, own);
  assert.match(doc.out, /到期待复审: 1/);
  const arch = ab(["review", "--archive", "--all"], alpha, own);
  assert.equal(arch.code, 0, arch.err);
  assert.match(arch.out, /已归档（到期）.*早就过时的坑/);
  assert.match(ab(["get", old.slice(0, 8)], alpha, own).out, /到期未确认，已归档/);
  assert.equal(ab(["archive", "--reactivate", old.slice(0, 8)], alpha, own).code, 0);
  ab(["brief"], alpha, own);
  const s2 = new Store(join(own, "store.db"), join(own, "index.db"));
  const usage = s2.usage();
  s2.close();
  assert.equal(usage.get(keep)?.uses, 1);
  assert.equal(usage.has(old), false);
});

// ---------- §11.6 显式关联 / 第 9–16 名 / why 不重复 / Pensieve 原文件（2026-10-19） ----------

async function linkFixtureStore(name: string) {
  const own = join(dir, name);
  // 先用 CLI 建库和项目，再用 Store 接口写关系事件（关系事件只有第 2 层判定会写，CLI 没有入口）
  const seed = ab(["remember", "--confirmed", "--kind", "note", "--text", `${name} 占位事实`, "--summary", "建库"], alpha, own);
  assert.equal(seed.code, 0, seed.err);
  const { Store } = await import("./store.ts");
  const store = new Store(join(own, "store.db"), join(own, "index.db"));
  const pid = store.ensureProject("alpha");
  const src = { host: "pi" as const, session_id: "s", transcript: null, anchor: "a", summary: "x" };
  const base = { confirmed: true, origin: "extract" as const, basis: "user_confirmed" as const, source: src, evidence: [{ anchor: "a", role: "user" as const, quote_sha256: "h" }] };
  const put = (text: string, extra: object = {}) => store.remember(pid, "s", false, { ...base, kind: "decision", text, ...extra });
  const relate = (from: string, outcome: "refines" | "conflicts", target: string) =>
    store.commit([{ kind: "relate", project_id: pid, session_id: null, target_id: from, body: { outcome, target, reason: "fixture", model: "fixture" } }], () => {});
  return { own, store, put, relate };
}

test("关联双向显示：被补充、合并自（对方已归档，标状态）在 search 和 get 都看得到；get 的邻近块不重复列关联条", async () => {
  const { own, store, put, relate } = await linkFixtureStore("links-both-ways");
  const a = put("缓存层采用 Redis 方案甲", { why: "单机内存不够" });
  const b = put("缓存层 Redis 的过期时间定为 300 秒");
  const c = put("缓存层用 Redis 做方案甲的旧说法");
  relate(b, "refines", a); // b 指向 a；a 自己没有任何字段指向 b
  store.lifecycle("archive", c, null, { reason: "duplicate", into: a });
  store.close();
  const id8 = (x: string) => x.slice(0, 8);

  const s = ab(["search", "缓存层"], alpha, own);
  assert.equal(s.code, 0, s.err);
  const rowA = s.out.split("\n").findIndex((l) => l.startsWith(`[${id8(a)}]`));
  assert.ok(rowA >= 0, s.out);
  const relA = s.out.split("\n").slice(rowA + 1).find((l) => l.startsWith("  关联: "));
  assert.ok(relA, `a 后面应有关联行：\n${s.out}`);
  assert.match(relA!, new RegExp(`被 \\[${id8(b)}\\] 补充`), "反向：a 能看到补充它的 b");
  assert.match(relA!, new RegExp(`合并自 \\[${id8(c)}\\]（已归档）`), "反向：a 能看到并入它的已归档 c，并标状态");
  assert.doesNotMatch(s.out, new RegExp(`^\\s*\\[${id8(c)}\\]`, "m"), "已归档的 c 不变成结果行（全文行和第 9–16 名一行版都不算）");
  assert.match(s.out, new RegExp(`补充了 \\[${id8(a)}\\]`), "正向：b 的行显示补充了 a");

  const g = ab(["get", id8(a)], alpha, own);
  assert.equal(g.code, 0, g.err);
  assert.match(g.out, new RegExp(`\\n关联:\\n(  .*\\n)*  被它补充 \\[${id8(b)}\\] alpha 决定: 缓存层 Redis 的过期时间定为 300 秒`));
  assert.match(g.out, new RegExp(`  合并自 \\[${id8(c)}\\]（已归档） alpha 决定: 缓存层用 Redis 做方案甲的旧说法`));
  assert.equal(g.out.split(`[${id8(b)}]`).length - 1, 1, "关联里列过的不再在邻近块里重复");

  const gc = ab(["get", id8(c)], alpha, own);
  assert.equal(gc.code, 0, gc.err);
  assert.match(gc.out, new RegExp(`  已并入 \\[${id8(a)}\\] alpha 决定: 缓存层采用 Redis 方案甲`));
  assert.match(gc.out, new RegExp(`撤销用 ab archive --reactivate ${id8(c)}`));
});

test("搜索结果的关联行最多列 3 个，多的提示用 ab get；ab get 全部列出", async () => {
  const { own, store, put, relate } = await linkFixtureStore("links-overflow");
  const a = put("日志采样率总决定");
  const subs = [1, 2, 3, 4].map((i) => put(`日志采样第${i}条细则`));
  for (const x of subs) relate(x, "refines", a);
  store.close();
  const s = ab(["search", "日志采样率总决定"], alpha, own);
  assert.equal(s.code, 0, s.err);
  const lines = s.out.split("\n");
  const rel = lines[lines.findIndex((l) => l.startsWith(`[${a.slice(0, 8)}]`)) + 1];
  assert.match(rel, /^  关联: (被 \[[0-9a-f]{8}\] 补充；){3}另有 1 个，ab get 看$/, s.out);
  const g = ab(["get", a.slice(0, 8)], alpha, own).out;
  for (const x of subs) assert.match(g, new RegExp(`  被它补充 \\[${x.slice(0, 8)}\\]`));
});

test("冲突两边都显示；被确认的纠正替代后，新条和旧条（已被替代）互相看得到", async () => {
  const { own, store, put, relate } = await linkFixtureStore("links-conflict");
  const a = put("队列重试上限定为 3 次");
  const b = put("队列重试上限定为 5 次");
  relate(b, "conflicts", a);
  const old = put("队列消费者用单线程");
  const fix = put("队列消费者改用 4 线程", { supersedes: old });
  store.close();
  const id8 = (x: string) => x.slice(0, 8);
  const s = ab(["search", "队列"], alpha, own);
  assert.equal(s.code, 0, s.err);
  assert.match(s.out, new RegExp(`与 \\[${id8(a)}\\] 冲突`));
  assert.match(s.out, new RegExp(`与 \\[${id8(b)}\\] 冲突`), "a 自己没有 conflicts_with，也要看到 b");
  assert.match(s.out, new RegExp(`纠正了 \\[${id8(old)}\\]（已被替代）`), s.out);
  const g = ab(["get", id8(old)], alpha, own);
  assert.equal(g.code, 0, g.err);
  assert.match(g.out, new RegExp(`  被它纠正 \\[${id8(fix)}\\] alpha 决定: 队列消费者改用 4 线程`));
});

test("search 里 why 只打一遍（回归：之前正文用了索引文本，why 出现两次）", async () => {
  const own = join(dir, "search-why-once");
  mkdirSync(own, { recursive: true });
  // 配上假 embedding，走混合检索（向量命中的 text 同样是正文 + why）
  writeFileSync(join(own, "embedding.json"), JSON.stringify({ baseUrl: "https://embedding.invalid/v1", model: "fake-one" }));
  const r = ab(["remember", "--confirmed", "--kind", "decision", "--text", "发布流程改为周四冻结", "--why", "周五上线出过两次事故", "--summary", "发布"], alpha, own);
  assert.equal(r.code, 0, r.err);
  const s = ab(["search", "发布流程"], alpha, own);
  assert.equal(s.code, 0, s.err);
  assert.doesNotMatch(s.out, /仅全文检索/, "确实走了混合检索");
  assert.equal(s.out.split("周五上线出过两次事故").length - 1, 1, s.out);
  assert.match(s.out, /alpha 决定: 发布流程改为周四冻结\n  为什么: 周五上线出过两次事故/);
});

test("search 前 8 条全文，第 9–16 名每条一行，再往后不出", async () => {
  const { own, store, put } = await linkFixtureStore("search-rank-16");
  const long = "，后面还有很长很长的一段说明文字用来检查一行显示会截断而不是整段铺开".repeat(3);
  const ids = Array.from({ length: 18 }, (_, i) => put(`灰度开关第${i + 1}号规定${long}`, { why: `理由${i + 1}` }));
  store.close();
  const s = ab(["search", "灰度开关"], alpha, own);
  assert.equal(s.code, 0, s.err);
  const lines = s.out.split("\n");
  const full = lines.filter((l) => /^\[[0-9a-f]{8}\]/.test(l));
  const head = lines.findIndex((l) => l === "更多（第 9–16 名，看全文用 ab get）:");
  assert.equal(full.length, 8, s.out);
  assert.ok(head > 0, s.out);
  const brief = lines.slice(head + 1).filter((l) => /^  \[[0-9a-f]{8}\]/.test(l));
  assert.equal(brief.length, 8);
  const shown = [...full, ...brief].map((l) => l.match(/\[([0-9a-f]{8})\]/)![1]);
  assert.equal(new Set(shown).size, 16, "16 条互不重复");
  assert.ok(shown.every((x) => ids.some((id) => id.startsWith(x))));
  for (const l of brief) {
    assert.doesNotMatch(l, /为什么|理由/, "一行版不带 why");
    const body = l.slice(l.indexOf(": ") + 2);
    assert.ok([...body].length <= 61, `一行版正文应截断：${l}`);
  }
  assert.ok(full.every((l) => l.includes(long.slice(0, 20))), "前 8 条是全文");
  // 排序不变（§11.4）：前 8 条与检索默认 8 条的结果、顺序一致
  const { Store } = await import("./store.ts");
  const s8 = new Store(join(own, "store.db"), join(own, "index.db"));
  const top8 = (await s8.searchHybrid("灰度开关", { projects: [s8.ensureProject("alpha")], includeGlobal: true }, null)).hits.map((h) => h.id.slice(0, 8));
  s8.close();
  assert.deepEqual(shown.slice(0, 8), top8);
});

test("ab get --expand：Pensieve 导入条打开原 md（脱敏、改过要说明）；文件没了或路径不在 .pensieve 下给出原因", async () => {
  const { own, store } = await linkFixtureStore("pensieve-expand");
  const pdir = join(dir, "pens-repo/.pensieve/decisions");
  mkdirSync(pdir, { recursive: true });
  const md = join(pdir, "2026-01-01-cache.md");
  const content = "# 缓存决定\n\n选 Redis，因为要跨进程共享。\n测试用 key: sk-abcdefghijklmnopqrstuvwx\n";
  writeFileSync(md, content);
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(content).digest("hex");
  const outside = join(dir, "pens-repo/notes.md");
  writeFileSync(outside, "不该被读出来的笔记\n");
  const pid = store.ensureProject("alpha");
  const src = { host: null, session_id: null, transcript: null, anchor: null, summary: "从 Pensieve 导入" };
  const mk = (text: string, path: string, also?: string[]) =>
    store.remember(pid, null, false, { kind: "decision", text, confirmed: true, origin: "import", source: src, import_ref: { system: "pensieve", id: text, path, sha256: sha, also } } as never);
  const ok = mk("导入决定甲", md);
  const bad = mk("导入决定乙", outside);
  const viaAlso = mk("导入决定丙", join(dir, "gone/.pensieve/decisions/x.md"), [md]);
  store.close();
  const id8 = (x: string) => x.slice(0, 8);

  const e = ab(["get", id8(ok), "--expand"], alpha, own);
  assert.equal(e.code, 0, e.err);
  assert.match(e.out, /--- Pensieve 原文件 ---\n.*2026-01-01-cache\.md\n# 缓存决定\n\n选 Redis，因为要跨进程共享。/);
  assert.doesNotMatch(e.out, /sk-abcdefghijklmnop/, "原文件内容要脱敏");
  assert.doesNotMatch(e.out, /导入后改过/);
  assert.match(ab(["get", id8(viaAlso), "--expand"], alpha, own).out, /选 Redis，因为要跨进程共享/, "主路径不在时用副本");

  const b = ab(["get", id8(bad), "--expand"], alpha, own);
  assert.match(b.out, /原文件不可用：.*不是 \.pensieve 目录下的 \.md 文件，拒绝读取/);
  assert.doesNotMatch(b.out, /不该被读出来的笔记/);

  // 符号链接逃逸：.pensieve 里的 md 指向外面
  const { symlinkSync, chmodSync: chm } = await import("node:fs");
  const escapeLink = join(pdir, "escape.md");
  const outsideMd = join(dir, "pens-repo/secret.md");
  writeFileSync(outsideMd, "外面的秘密笔记\n");
  symlinkSync(outsideMd, escapeLink);
  const s2 = new (await import("./store.ts")).Store(join(own, "store.db"), join(own, "index.db"));
  const mk2 = (text: string, path: string) =>
    s2.remember(pid, null, false, { kind: "decision", text, confirmed: true, origin: "import", source: src, import_ref: { system: "pensieve", id: text, path, sha256: sha } } as never);
  const esc = mk2("导入决定丁", escapeLink);
  const bigMd = join(pdir, "big.md");
  writeFileSync(bigMd, "长".repeat(5000));
  const big = mk2("导入决定戊", bigMd);
  const locked = join(pdir, "locked.md");
  writeFileSync(locked, "锁住的\n");
  chm(locked, 0o000);
  const lock = mk2("导入决定己", locked);
  s2.close();
  const eo = ab(["get", id8(esc), "--expand"], alpha, own).out;
  assert.match(eo, /原文件不可用：.*指向 \.pensieve 目录之外/);
  assert.doesNotMatch(eo, /外面的秘密笔记/);
  const bo = ab(["get", id8(big), "--expand"], alpha, own).out;
  assert.match(bo, /（已截断，完整内容看原文件）/);
  assert.equal(bo.split("长").length - 1, 4000);
  const lo = ab(["get", id8(lock), "--expand"], alpha, own);
  assert.equal(lo.code, 0, "读不了也不崩");
  if (process.getuid?.() !== 0) assert.match(lo.out, /原文件不可用：.*没有读取权限/);
  chm(locked, 0o644);

  writeFileSync(md, content + "后来补了一行\n");
  assert.match(ab(["get", id8(ok), "--expand"], alpha, own).out, /导入后改过/);
  rmSync(md);
  const gone = ab(["get", id8(ok), "--expand"], alpha, own);
  assert.equal(gone.code, 0, gone.err);
  assert.match(gone.out, /原文件不可用：.*文件不存在/);
});

// ---------- §11.7 Pi 状态栏：ab status --line / recall 条数 / 扩展接线（2026-10-20） ----------

test("ab status --line：只数到期待复审（不数刚记下的和已确认）和近 7 天失败窗口", async () => {
  const own = join(dir, "status-line-store");
  const { Store } = await import("./store.ts");
  const s = new Store(join(own, "store.db"), join(own, "index.db"));
  const src = { host: "pi" as const, session_id: "s", transcript: null, anchor: null, summary: "讨论" };
  const pid = s.ensureProject("alpha");
  const old = s.remember(pid, "s", false, { kind: "pitfall", text: "早就过时的坑", confirmed: false, source: src });
  const keep = s.remember(pid, "s", false, { kind: "pitfall", text: "用户确认过的老坑", confirmed: true, source: src });
  s.remember(pid, "s", false, { kind: "pitfall", text: "刚记的坑", confirmed: false, source: src });
  const long = new Date(Date.now() - 400 * 86_400_000).toISOString();
  s.workDb.prepare("UPDATE events SET ts=? WHERE id IN (?,?)").run(long, old, keep);
  s.close();
  const empty = ab(["status", "--line"], alpha, own);
  assert.equal(empty.code, 0, empty.err);
  assert.deepEqual(JSON.parse(empty.out), { review: 1, work_failed: 0 });
  // 刚记下的未确认条目还没到期，不算待复审
  assert.equal(ab(["remember", "--kind", "pitfall", "--text", "刚记下的坑", "--summary", "讨论"], alpha, own).code, 0);
  assert.deepEqual(JSON.parse(ab(["status", "--line"], alpha, own).out), { review: 1, work_failed: 0 });
  const s2 = new Store(join(own, "store.db"), join(own, "index.db"));
  const ins = s2.workDb.prepare(
    "INSERT INTO capture_windows(window_id,host,session_id,from_anchor,to_anchor,state,attempts,next_at,error_code,receipt,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
  ins.run("w1", "pi", "s", null, "a1", "failed", 4, null, "llm_error", null, recent);
  ins.run("w2", "pi", "s", null, "a2", "failed", 4, null, "llm_error", null, stale);
  ins.run("w3", "pi", "s", null, "a3", "done", 1, null, null, null, recent);
  s2.close();
  rmSync(keyRead, { force: true });
  const line = ab(["status", "--line"], alpha, own);
  assert.equal(line.code, 0, line.err);
  assert.deepEqual(JSON.parse(line.out), { review: 1, work_failed: 1 });
  assert.equal(existsSync(keyRead), false, "status --line 不读钥匙串");
});

test("recall --hook 注入常驻偏好与提醒，斜杠命令与不相关目录不注入", () => {
  const own = join(dir, "recall-count-home");
  const remember = (args: string[]) => ab(["remember", ...args], alpha, own);
  assert.equal(remember(["--confirmed", "--kind", "pitfall", "--text", "别在 alpha 计数里用全局锁", "--summary", "计数"]).code, 0);
  assert.equal(remember(["--confirmed", "--kind", "rule", "--text", "alpha 计数规则：全局锁要先拿", "--summary", "计数"]).code, 0);
  const pref = remember(["--confirmed", "--global", "--kind", "rule", "--text", "说人话", "--summary", "偏好"]);
  const prefId = pref.out.match(/\[([0-9a-f]{8})\]/)![1];
  assert.equal(ab(["guidance", prefId], alpha, own).code, 0);
  const hit = recall(["recall", "--hook"], alpha, own, JSON.stringify({ prompt: "计数 全局锁", cwd: alpha }));
  assert.equal(hit.code, 0, hit.err);
  const j = JSON.parse(hit.out) as { hookSpecificOutput: { additionalContext: string } };
  assert.match(j.hookSpecificOutput.additionalContext, /说人话/);
  assert.match(j.hookSpecificOutput.additionalContext, /要不要查历史记忆由你判断/);
  assert.doesNotMatch(j.hookSpecificOutput.additionalContext, /别在 alpha 计数里用全局锁/);
  const slash = recall(["recall", "--hook"], alpha, own, JSON.stringify({ prompt: "/help 计数", cwd: alpha }));
  assert.equal(slash.out, "");
});

test("Pi 扩展接真 ab：会话开始挂待办，提醒注入，/ab 打 ab status", async () => {
  const own = join(dir, "pi-ext-home");
  assert.equal(ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "别在 alpha 扩展里用全局锁", "--summary", "扩展"], alpha, own).code, 0);
  {
    const { Store } = await import("./store.ts");
    const st = new Store(join(own, "store.db"), join(own, "index.db"));
    const src = { host: "pi" as const, session_id: "s", transcript: null, anchor: null, summary: "讨论" };
    const old = st.remember(st.ensureProject("alpha"), "s", false, { kind: "pitfall", text: "早就过时的扩展坑", confirmed: false, source: src });
    st.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run(new Date(Date.now() - 400 * 86_400_000).toISOString(), old);
    st.close();
  }
  const extPath = join(import.meta.dirname, "../integrations/pi/agentbrain-recall.ts");
  const mod = (await import(extPath)) as { createExtension(run: unknown): (pi: unknown) => void };
  const run = (args: string[], input: object, timeout: number) =>
    Promise.resolve(spawnSync("node", ["--import", networkGuard, CLI, ...args], {
      cwd: alpha,
      encoding: "utf8",
      timeout,
      input: JSON.stringify(input),
      env: { ...process.env, AB_HOME: own, AB_REGISTRY: repos, HOME: fakeHome, PATH: `${bin}:${process.env.PATH}`, PI_SESSION_ID: SESSION, AB_NO_WORK: "1" },
    })).then((r) => (r.status === 0 ? { ok: true, out: r.stdout } : { ok: false, reason: "exit" }));
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
  const commands = new Map<string, { handler(a: string, ctx: unknown): Promise<void> }>();
  mod.createExtension(run)({ on: (n: string, h: never) => handlers.set(n, h), registerCommand: (n: string, c: never) => commands.set(n, c) });
  const statuses: string[] = [];
  const notes: string[] = [];
  const ctx = {
    cwd: alpha,
    sessionManager: { getSessionFile: () => join(fakeHome, "s.jsonl"), getSessionId: () => SESSION },
    ui: { setStatus: (k: string, t: string) => { assert.equal(k, "agentbrain"); statuses.push(t); }, notify: (m: string) => notes.push(m) },
  };
  const cwd0 = process.cwd();
  process.chdir(alpha);
  try {
    await handlers.get("session_start")!({}, ctx);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(statuses.at(-1), "🧠 ab · 待确认 1"); // 真 ab status --line 的结果；失败数 0 不显示
    const res = (await handlers.get("before_agent_start")!({ prompt: "扩展 全局锁" }, ctx)) as { message: { content: string } };
    assert.match(res.message.content, /要不要查历史记忆由你判断/);
    assert.equal(statuses.at(-1), "🧠 ab · 待确认 1");
    await commands.get("ab")!.handler("", ctx);
    assert.match(notes.at(-1)!, /^🧠 ab · 待确认 1\n\n[\s\S]*到期待复审: 1/);
  } finally {
    process.chdir(cwd0);
  }
});


// ---------- §11.10 场景标签（2026-10-30） ----------

test("场景标签：remember --scene、ab tag 改与清空、brief/search 按场景、correct 继承、报错", () => {
  const own = join(dir, "scene-store");
  const r1 = ab(["remember", "--confirmed", "--global", "--for-workers", "--kind", "rule", "--text", "场景规则：开发先写测试", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(r1.code, 0, r1.err);
  const id = /\[([0-9a-f]{8})\]/.exec(r1.out)![1];

  // 无场景：只有索引行，场景规则不进通用段
  const plain = ab(["brief"], alpha, own);
  assert.match(plain.out, /场景规则：开发 1 条；进入该场景先 ab search --scene <场景>/);
  assert.doesNotMatch(plain.out, /开发先写测试/);

  // --worker --scene code 输出该条（全局规则要 for_workers）
  const worker = ab(["brief", "--worker", "--scene", "code"], alpha, own);
  assert.equal(worker.code, 0, worker.err);
  assert.match(worker.out, /worker scene="code"/);
  assert.match(worker.out, /场景规则（开发）：/);
  assert.match(worker.out, /开发先写测试/);
  const main = ab(["brief", "--scene", "code"], alpha, own);
  assert.match(main.out, /^<agentbrain project="alpha" scene="code">/);
  assert.match(main.out, /开发先写测试/);
  assert.doesNotMatch(main.out, /进入该场景先 ab search --scene <场景>/);

  // ab tag 整组替换；换走之后别的场景看不到
  const tag = ab(["tag", id, "--scene", "design,review"], alpha, own);
  assert.equal(tag.code, 0, tag.err);
  assert.match(tag.out, /design,review/);
  assert.doesNotMatch(ab(["brief", "--scene", "code"], alpha, own).out, /开发先写测试/);
  assert.match(ab(["brief", "--scene", "review"], alpha, own).out, /场景规则（review）：[\s\S]*开发先写测试/);

  // ab tag --scene none 清空，回到通用段
  assert.equal(ab(["tag", id, "--scene", "none"], alpha, own).code, 0);
  const back = ab(["brief"], alpha, own);
  assert.match(back.out, /开发先写测试/);
  assert.doesNotMatch(back.out, /进入该场景先 ab search --scene <场景>/);

  // correct 继承旧条目的场景
  assert.equal(ab(["tag", id, "--scene", "review"], alpha, own).code, 0);
  const corrected = ab(["correct", id, "--text", "场景规则：review 先跑回归", "--summary", "场景", "--confirmed"], alpha, own);
  assert.equal(corrected.code, 0, corrected.err);
  assert.match(ab(["brief", "--scene", "review"], alpha, own).out, /review 先跑回归/);
  assert.doesNotMatch(ab(["brief"], alpha, own).out, /review 先跑回归/);
  // 纠正之后旧条目的标签再改，新条目不跟着变
  const cid = /\[([0-9a-f]{8})\]/.exec(corrected.out)![1];
  assert.equal(ab(["tag", id, "--scene", "code"], alpha, own).code, 0);
  assert.match(ab(["brief", "--scene", "review"], alpha, own).out, /review 先跑回归/);
  assert.doesNotMatch(ab(["brief", "--scene", "code"], alpha, own).out, /review 先跑回归/);
  const reviewList = ab(["search", "--scene", "review"], alpha, own);
  assert.match(reviewList.out, new RegExp(`^\\[${cid}\\]`, "m"));
  assert.doesNotMatch(reviewList.out, new RegExp(`^\\[${id}\\]`, "m"), "旧条目已不是 review 场景，不能作为场景行列出");
  // search --scene 列全（不受前 8 条限制），按 seq 倒序；与关键词同用报错
  for (let i = 0; i < 10; i++) {
    const r = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", `review 批量规则 ${i}`, "--summary", "场景", "--scene", "review"], alpha, own);
    assert.equal(r.code, 0, r.err);
  }
  const listed = ab(["search", "--scene", "review"], alpha, own);
  for (let i = 0; i < 10; i++) assert.match(listed.out, new RegExp(`review 批量规则 ${i}`));
  assert.deepEqual(
    [...listed.out.matchAll(/review 批量规则 (\d+)/g)].map((m) => Number(m[1])),
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  );
  const mixed = ab(["search", "--scene", "review", "回归"], alpha, own);
  assert.equal(mixed.code, 1);
  assert.match(mixed.err, /--scene/);
  for (const args of [["brief", "--scene", "bogus"], ["search", "--scene", "bogus"], ["tag", id, "--scene", "bogus"]]) {
    assert.equal(ab(args, alpha, own).code, 1, args.join(" "));
  }

  // 配非 rule、未知值报错；tag 也只能用于规则
  const pit = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "坑", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(pit.code, 1);
  assert.match(pit.err, /--scene 只能用于规则/);
  const pitOk = ab(["remember", "--confirmed", "--kind", "pitfall", "--text", "普通坑", "--summary", "场景"], alpha, own);
  const pitId = /\[([0-9a-f]{8})\]/.exec(pitOk.out)![1];
  const pitTag = ab(["tag", pitId, "--scene", "code"], alpha, own);
  assert.equal(pitTag.code, 1);
  assert.match(pitTag.err, /--scene 只能用于规则/);
  const bad = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "x", "--summary", "场景", "--scene", "bogus"], alpha, own);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--scene/);

  // 与 guidance 互斥：两个入口都报错
  const g = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "常驻偏好", "--summary", "场景"], alpha, own);
  const gid = /\[([0-9a-f]{8})\]/.exec(g.out)![1];
  assert.equal(ab(["guidance", gid], alpha, own).code, 0);
  const gtag = ab(["tag", gid, "--scene", "code"], alpha, own);
  assert.equal(gtag.code, 1);
  assert.match(gtag.err, /干活偏好/);
  assert.equal(ab(["tag", id, "--scene", "code"], alpha, own).code, 0);
  const guid = ab(["guidance", id], alpha, own);
  assert.equal(guid.code, 1);
  assert.match(guid.err, /场景/);

  // markUsed 与实际输出的 id 一致
  const db = new DatabaseSync(join(own, "store.db"));
  db.exec("DELETE FROM prop_usage");
  db.close();
  const last = ab(["brief", "--scene", "code"], alpha, own);
  assert.equal(last.code, 0, last.err);
  const db2 = new DatabaseSync(join(own, "store.db"));
  const usedIds = (db2.prepare("SELECT prop_id FROM prop_usage").all() as { prop_id: string }[]).map((r) => r.prop_id.slice(0, 8)).sort();
  db2.close();
  const printed = [...last.out.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]).sort();
  assert.deepEqual(usedIds, printed);
});

test("search --scene 列未确认规则并带标记；brief 的已确认门槛不变", () => {
  const own = join(dir, "scene-unconfirmed");
  const g = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "已确认的开发规范", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(g.code, 0, g.err);
  const u = ab(["remember", "--global", "--kind", "rule", "--text", "未确认的开发规范待认可", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(u.code, 0, u.err);
  const uid = /\[([0-9a-f]{8})\]/.exec(u.out)![1];

  const listed = ab(["search", "--scene", "code"], alpha, own);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /已确认的开发规范/);
  assert.match(listed.out, /未确认的开发规范待认可/);
  const line = listed.out.split("\n").find((l) => l.includes("未确认的开发规范待认可"))!;
  assert.match(line, /\[未确认\]/, line);
  assert.match(line, new RegExp(uid));

  // brief 两边都不放未确认的：通用段没有，场景段也没有
  const b = ab(["brief", "--scene", "code"], alpha, own);
  assert.match(b.out, /已确认的开发规范/);
  assert.doesNotMatch(b.out, /未确认的开发规范待认可/);
});

test("search --scene 配 --kind 非 rule、配 --archived 在 CLI 边界报错退出 1；--kind rule 可接受", () => {
  const own = join(dir, "scene-args");
  const r = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "找到的开发规范", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(r.code, 0, r.err);
  for (const kind of ["pitfall", "decision", "note"]) {
    const bad = ab(["search", "--scene", "code", "--kind", kind], alpha, own);
    assert.equal(bad.code, 1, `--kind ${kind}`);
    assert.match(bad.err, /--scene/);
  }
  const arch = ab(["search", "--scene", "code", "--archived"], alpha, own);
  assert.equal(arch.code, 1);
  assert.match(arch.err, /--archived/);
  const ok = ab(["search", "--scene", "code", "--kind", "rule"], alpha, own);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /找到的开发规范/);
});

test("brief --scene 的交付记录（prop_usage / inject_log）与场景段实际输出的 id 完全一致", () => {
  const own = join(dir, "scene-delivery");
  const ids = ["场景交付规则甲", "场景交付规则乙", "场景交付规则丙"].map((text) => {
    const r = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", text, "--summary", "场景", "--scene", "review"], alpha, own);
    assert.equal(r.code, 0, r.err);
    return /\[([0-9a-f]{8})\]/.exec(r.out)![1];
  });
  // 别的场景的规则：不进场景段，也不该被记成交付
  const other = ab(["remember", "--confirmed", "--global", "--kind", "rule", "--text", "开发场景规则不入 review 段", "--summary", "场景", "--scene", "code"], alpha, own);
  assert.equal(other.code, 0, other.err);
  const db = new DatabaseSync(join(own, "store.db"));
  db.exec("DELETE FROM prop_usage; DELETE FROM inject_log");
  db.close();

  const out = ab(["brief", "--scene", "review"], alpha, own);
  assert.equal(out.code, 0, out.err);
  const sceneSection = out.out.slice(out.out.indexOf("场景规则（review）："));
  for (const id of ids) assert.ok(sceneSection.includes(`[${id}]`), `场景段里应出现 ${id}`);
  assert.doesNotMatch(sceneSection, /开发场景规则不入 review 段/);
  const printed = [...out.out.matchAll(/^- \[([0-9a-f]{8})\]/gm)].map((m) => m[1]).sort();

  const db2 = new DatabaseSync(join(own, "store.db"));
  const logged = (db2.prepare("SELECT DISTINCT prop_id FROM inject_log WHERE path='brief'").all() as { prop_id: string }[])
    .map((r) => r.prop_id.slice(0, 8))
    .sort();
  const used = (db2.prepare("SELECT prop_id FROM prop_usage").all() as { prop_id: string }[]).map((r) => r.prop_id.slice(0, 8)).sort();
  db2.close();
  assert.deepEqual(logged, printed, "inject_log 与输出一致");
  assert.deepEqual(used, printed, "prop_usage 与输出一致");
  for (const id of ids) assert.ok(printed.includes(id), `交付记录里有 ${id}`);
});

test("brief 放不下的整条跳过，不硬截断结尾", () => {
  const own = join(dir, "brief-budget");
  const line = (i: number) => `第${i}条长规则专门用来占满字数预算不要硬截断结尾提示还要更长一点`;
  const pit = (i: number) => `第${i}条长坑专门用来占满字数预算不要硬截断结尾提示还要更长一点`;
  const run = (args: string[], cwd: string) => {
    try {
      const out = execFileSync("node", ["--import", networkGuard, CLI, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          AB_HOME: own,
          AB_REGISTRY: repos,
          HOME: fakeHome,
          PATH: `${bin}:${process.env.PATH}`,
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "",
          PI_SESSION_ID: SESSION,
        },
      });
      return { out, err: "", code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: err.stdout ?? "", err: err.stderr ?? "", code: err.status ?? -1 };
    }
  };
  try {
    for (let i = 0; i < 60; i++) {
      const r = run(
        ["remember", "--confirmed", "--global", "--for-workers", "--kind", "rule", "--text", line(i), "--summary", "预算"],
        alpha,
      );
      assert.equal(r.code, 0, r.err);
    }
    for (let i = 0; i < 20; i++) {
      const r = run(
        ["remember", "--confirmed", "--kind", "pitfall", "--text", pit(i), "--summary", "预算"],
        alpha,
      );
      assert.equal(r.code, 0, r.err);
    }
    for (const args of [["brief"], ["brief", "--worker"]] as const) {
      const b = run([...args], alpha);
      assert.equal(b.code, 0, b.err);
      assert.ok(b.out.length <= 2000, `${args.join(" ")} 长度 ${b.out.length}`);
      assert.doesNotMatch(b.out, /已截断/);
      assert.match(b.out, /放不下/);
      assert.match(b.out, args.length === 1 ? /用户明确要你记时才用 ab remember --confirmed/ : /不写记忆/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


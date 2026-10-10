/**
 * 命令行流程。运行：node --test src/cli.test.ts
 * store 与清单都指向临时目录，不碰真实的 ~/.agentbrain 与 pm。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function ab(args: string[], cwd: string, storeHome = home): { out: string; err: string; code: number } {
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
      },
    });
    return { out, err: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: err.stdout ?? "", err: err.stderr ?? "", code: err.status ?? -1 };
  }
}

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
  assert.match(before.out, /锁用全局一把/);
  assert.doesNotMatch(before.out, /锁按账户分/);
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
  config("fake-two");
  assert.match(run(["status"]).out, /向量: fake-two，已向量化 0\/2/);
  assert.equal(run(["search", "喵星人"]).code, 0);
  assert.match(run(["status"]).out, /向量: fake-two，已向量化 2\/2/);
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

// 放在最后：长内容进独立 AB_HOME，不进共享库；它也负责删掉整个临时目录。
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
      assert.match(b.out, args.length === 1 ? /记住用 ab remember/ : /不写记忆/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

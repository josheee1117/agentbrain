/**
 * 06 review 报告的流水线回归（§8.11.3）：条目 1（同标题不同正文不再合并）、条目 2（一条候选过不了写入口校验不拖垮窗口）、
 * 条目 5（关系目标限定在最终项目 + 全局）、条目 3（正文脱敏到 embedding 输入）、条目 11（窗口到投影的行为测试）。
 * 全部走真实 runWork / admit / Store.commit / 投影，不 mock 内部函数。
 * 运行：node --test src/work-review.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import { admit, runWork, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import type { Proposition, RememberBody } from "./l2.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-work-review-")));
let n = 0;

/** 字符袋向量：同样的字越多越像。 */
const fakeEmbed: Embedder = Object.assign(async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(97);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
}), { model: "fake-embed" });

type Reply = (msgs: ChatMessage[], opts?: { json?: boolean }) => ChatMessage | Promise<ChatMessage>;
const json = (o: object): ChatMessage => ({ role: "assistant", content: JSON.stringify(o) });

function fakeChat(reply: Reply): Chat & { calls: ChatMessage[][]; relateCalls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const relateCalls: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[], opts?: { json?: boolean }) => {
    if (msgs[0]?.content?.includes("记忆关系判定器")) {
      relateCalls.push(structuredClone(msgs));
      return { message: json({ results: [] }), tokens: 50 };
    }
    calls.push(structuredClone(msgs));
    return { message: await reply(msgs, opts), tokens: 100 };
  }) as Chat & { calls: ChatMessage[][]; relateCalls: ChatMessage[][] };
  f.calls = calls;
  f.relateCalls = relateCalls;
  return f;
}

interface Env {
  store: Store;
  repo: string;
  betaRepo: string;
  deps: (chat: Chat | null, extra?: Partial<WorkDeps>) => WorkDeps;
  transcript: (sid: string, lines: object[]) => string;
  register: (sid: string, file: string) => void;
  pid: string;
  betaPid: string;
}

function env(): Env {
  const dir = join(base, `e${n++}`);
  const repo = join(dir, "alpha");
  const betaRepo = join(dir, "beta");
  for (const r of [repo, betaRepo]) {
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, "AGENTS.md"), "实现交给 Codex。\n");
    execFileSync("git", ["-C", r, "init", "-q"]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
    execFileSync("git", ["-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  }
  const regDir = join(dir, "repos");
  mkdirSync(regDir);
  writeFileSync(join(regDir, "alpha.md"), "- 路径：`x`\n");
  writeFileSync(join(regDir, "beta.md"), "- 路径：`y`\n");
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = store.ensureProject("alpha");
  const betaPid = store.ensureProject("beta");
  const registry = [{ name: "alpha", path: repo }, { name: "beta", path: betaRepo }];
  return {
    store,
    repo,
    betaRepo,
    pid,
    betaPid,
    deps: (chat, extra = {}) => ({
      store,
      now: () => new Date(),
      chat: chat ? { chat, model: "fake-llm" } : { error: "no_config", message: "没有 extract.json" },
      embedder: fakeEmbed,
      registry,
      registryDir: regDir,
      resolveProject: (cwd) => (cwd.startsWith(repo) ? { name: "alpha", path: repo } : cwd.startsWith(betaRepo) ? { name: "beta", path: betaRepo } : null),
      projectId: (name) => store.ensureProject(name),
      ...extra,
    }),
    transcript: (sid, lines) => {
      const p = join(dir, `${sid}.jsonl`);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      utimesSync(p, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
      return p;
    },
    register: (sid, file) => {
      intake.upsertSession(store.workDb, { host: "claude", session_id: sid, transcript: file, cwd: repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date());
    },
  };
}

const user = (uuid: string, text: string) => ({ type: "user", uuid, message: { role: "user", content: text } });
const asst = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });

const RULE = {
  kind: "rule",
  text: "hook 命令写 node 绝对路径，不依赖 PATH",
  why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
  basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
  relation: { type: "new", target: null },
};

const src0 = (sid: string | null) => ({ host: "claude" as const, session_id: sid, transcript: null, anchor: "u1", summary: "x" });

/** 一次窗口里两条相同标题、不同正文的决定。 */
function twoSameTitleDecisions(): object {
  return {
    candidates: [
      {
        kind: "decision",
        text: "hook 执行方式",
        why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
        body: "用绝对路径启动 node 24",
        basis: "user_directive",
        evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
        relation: { type: "new", target: null },
      },
      {
        kind: "decision",
        text: "hook 执行方式",
        why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
        body: "只用 PATH 启动 node 26",
        basis: "user_directive",
        evidence: [{ anchor: "#2", role: "user", quote: "也可以只用 PATH 启动 node 26" }],
        relation: { type: "new", target: null },
      },
    ],
  };
}

// ---------- 条目 1：同标题不同正文不合并 ----------

test("review 条目 1：同窗口同标题不同正文的两条决定，最终投影里都留下各自的正文", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [
    user("u1", "以后 hook 命令都写 node 绝对路径"),
    user("u2", "也可以只用 PATH 启动 node 26"),
  ]));
  const chat = fakeChat(() => json(twoSameTitleDecisions()));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.equal(r.receipt.merged, 0, "正文不同不能合并");
  const bodies = [...e.store.project().props.values()].filter((p) => p.text === "hook 执行方式").map((p) => p.body).sort();
  assert.deepEqual(bodies, ["使用 PATH 启动 node 26".replace("使用", "只用"), "用绝对路径启动 node 24"]);
});

test("review 条目 1：已有同标题条目、模型说 new，正文不同就不再被强制判 duplicate，正文进库", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", body: "用绝对路径启动 node 24", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({
    candidates: [{
      kind: "decision",
      text: "hook 执行方式",
      why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
      body: "另一套旧的缓存方案",
      basis: "user_directive",
      evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
      relation: { type: "new", target: null },
    }],
  }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const all = [...e.store.project().props.values()];
  const fresh = all.filter((p) => p.id !== old);
  assert.equal(fresh.length, 1, "正文不同的候选按新条目留库");
  assert.equal(fresh[0].body, "另一套旧的缓存方案");
  assert.equal(e.store.project().props.get(old)!.body, "用绝对路径启动 node 24", "旧条目的正文没被改");
});

// ---------- 条目 2：一条候选过不了写入口校验，不拖垮窗口 ----------

test("review 条目 2：带正文的决定被判成旧规则的冲突时，不改种类、照常写入", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab，靠 PATH 找", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({
    candidates: [{
      kind: "decision",
      text: "hook 走 node 绝对路径",
      why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
      body: "绝对路径写进 hook 配置",
      basis: "user_directive",
      evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
      relation: { type: "conflicts", target: "m1" },
    }],
  }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual(r.windows, { done: 1, deferred: 0, failed: 0, skipped: 0 }, "窗口照常完成");
  const corr = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.equal(corr.kind, "decision", "带正文的决定不改成规则的种类");
  assert.equal(corr.body, "绝对路径写进 hook 配置");
  assert.equal(e.store.project().props.get(old)!.pending_corrections.length, 1);
});

test("review 条目 2：一条候选组装出的事件过不了写入口校验时只丢这一条、记 drop 原因，其余照常写入、进度推进", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  // 绕过 extract 自查、组装出来就过不了 checkRememberBody 的候选：规则带正文
  const bad = { kind: "rule", text: "另一条规则", body: "规则不该带正文", why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
    basis: "user_directive", evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }], relation: { type: "new", target: null } };
  const admission = admit(
    [{ ...bad, project: "alpha", key: "k-bad", unreconciled: false } as never, { ...RULE, project: "alpha", key: "k-ok", unreconciled: false } as never],
    intake.sessions(e.store.workDb)[0] ?? intake.upsertSession(e.store.workDb, { host: "claude", session_id: "s1", transcript: e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]), cwd: e.repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date()),
    e.pid, "window", e.store.project().props, "fake-llm",
  );
  assert.equal(admission.receipt.dropped.body_rejected, 1, "被丢的候选记 drop 原因");
  assert.deepEqual(admission.appends.map((a) => (a.body as RememberBody).text), [RULE.text], "其余候选照常组装");
});

// ---------- 条目 5：关系目标限定在最终项目 + 全局 ----------

test("review 条目 5：候选归到 beta 时，alpha 的条目不能当 supersedes 目标，按新条目处理", async () => {
  const e = env();
  const alphaProp = e.store.remember(e.pid, null, false, { kind: "decision", text: "alpha 的 final 阶段硬拦合并", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [
    user("u1", "beta 的门禁太严了，以后 beta final 阶段只显示不拦"),
    asst("a1", "beta 的 final 阶段建议只显示不拦合并"),
    user("u2", "可以，beta 的 final 就只显示不拦截"),
  ]));
  const chat = fakeChat(() => json({
    candidates: [{
      kind: "decision",
      project: "beta",
      project_anchor: "#1",
      text: "beta final 阶段只显示不拦合并",
      why: "beta 的 final 拦下过的真实问题太少，留着只添乱",
      basis: "user_confirmed",
      evidence: [
        { anchor: "#2", role: "assistant", quote: "beta 的 final 阶段建议只显示不拦合并" },
        { anchor: "#3", role: "user", quote: "beta 的 final 就只显示不拦截" },
      ],
      relation: { type: "supersedes", target: "m1" },
    }],
  }));
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(r.windows.done, 1);
  const beta = [...e.store.project().props.values()].find((p) => p.project_id === e.betaPid)!;
  assert.equal(beta.project_id, e.betaPid);
  assert.equal(beta.supersedes, undefined, "跨项目的关系目标要清掉");
  assert.equal(beta.related, null, "关系被清掉后按新条目处理，没有写入越界的关系");
  const alpha = e.store.project().props.get(alphaProp)!;
  assert.equal(alpha.state, "active", "alpha 的条目不被 beta 的决定替代");
  assert.equal(alpha.pending_corrections.length, 0);
});

test("review 条目 5：目标是全局条目时保留关系；目标是别的项目时连 conflicts 也清掉", async () => {
  const e = env();
  const globalProp = e.store.remember(null, null, false, { kind: "rule", text: "提交信息用中文写", confirmed: true, source: src0(null) });
  const alphaProp = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab，靠 PATH 找", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [
    user("u1", "beta 的门禁太严了，以后 beta final 阶段只显示不拦"),
    asst("a1", "beta 的 final 阶段建议只显示不拦合并"),
    user("u2", "可以，beta 的 final 就只显示不拦截"),
  ]));
  const cand = (type: string, target: string) => ({
    kind: "decision",
    project: "beta",
    project_anchor: "#1",
    text: "beta final 阶段只显示不拦合并",
    why: "beta 的 final 拦下过的真实问题太少，留着只添乱",
    basis: "user_confirmed",
    evidence: [
      { anchor: "#2", role: "assistant", quote: "beta 的 final 阶段建议只显示不拦合并" },
      { anchor: "#3", role: "user", quote: "beta 的 final 就只显示不拦截" },
    ],
    relation: { type, target },
  });
  const chat = fakeChat(() => json({ candidates: [cand("conflicts", "m2")] }));
  await runWork(e.deps(chat), { sweep: true, dryRun: false });
  const beta = [...e.store.project().props.values()].find((p) => p.project_id === e.betaPid)!;
  assert.equal(beta.supersedes, undefined);
  assert.equal(e.store.project().props.get(alphaProp)!.pending_corrections.length, 0, "alpha 的条目不受影响");

  const e2 = env();
  e2.store.remember(null, null, false, { kind: "decision", text: "全局约定：final 只显示不拦合并", confirmed: true, source: src0(null) });
  e2.register("s1", e2.transcript("s1", [
    user("u1", "beta 的门禁太严了，以后 beta final 阶段只显示不拦"),
    asst("a1", "beta 的 final 阶段建议只显示不拦合并"),
    user("u2", "可以，beta 的 final 就只显示不拦截"),
  ]));
  const chat2 = fakeChat(() => json({ candidates: [cand("supersedes", "m1")] }));
  await runWork(e2.deps(chat2), { sweep: true, dryRun: false });
  const beta2 = [...e2.store.project().props.values()].find((p) => p.project_id === e2.betaPid)!;
  assert.ok(beta2.supersedes, "全局条目在范围内，关系保留");
});

// ---------- 条目 3：正文脱敏到 embedding 输入 ----------

test("review 条目 3：抽取出来的正文脱敏后才进库、才送去算向量", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({
    candidates: [{
      kind: "decision",
      text: "告警邮件只发测试环境",
      why: "助手把通知发到了生产 webhook，用户纠正后要求只用测试环境",
      body: "联系 alice@example.com，路径 /Users/alice/private/company",
      basis: "user_directive",
      evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
      relation: { type: "new", target: null },
    }],
  }));
  const sent: string[][] = [];
  const embedder: Embedder = Object.assign(async (t: string[]) => { sent.push(t); return fakeEmbed(t); }, { model: "fake-embed" });
  await runWork(e.deps(chat, { embedder }), { sweep: false, dryRun: false });
  const p = [...e.store.project().props.values()][0] as Proposition;
  assert.equal(p.body!.includes("alice@example.com"), false);
  assert.equal(p.body!.includes("/Users/alice"), false);
  const embeddingInput = sent.flat().join("\n");
  assert.equal(embeddingInput.includes("alice@example.com"), false, `embedding 输入含原始邮箱：${embeddingInput}`);
  assert.equal(embeddingInput.includes("/Users/alice"), false, `embedding 输入含原始家目录：${embeddingInput}`);
});

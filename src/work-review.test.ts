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
import { Store, VEC_TEXT_MAX_CHARS, type Embedder } from "./store.ts";
import type { Chat, ChatMessage } from "./llm.ts";
import { admit, runWork, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import { linkIndex } from "./links.ts";
import { recall } from "./recall.ts";
import { recallable } from "./visibility.ts";
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

function fakeChat(reply: Reply, relate: Reply = () => json({ results: [] })): Chat & { calls: ChatMessage[][]; relateCalls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const relateCalls: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[], opts?: { json?: boolean }) => {
    if (msgs[0]?.content?.includes("记忆关系判定器")) {
      relateCalls.push(structuredClone(msgs));
      return { message: await relate(msgs, opts), tokens: 50 };
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

test("review 条目 2 / round3 条目 8：一条候选组装出的事件过不了写入口校验时只丢这一条、记 drop 原因，计数不含被丢的候选", async () => {
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
  assert.equal(admission.receipt.proposals, 1, "被丢的候选不算提议");
});

test("review round3 条目 9：一条候选校验失败只丢它自己，真实 runWork 的 checkpoint 照常推进", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径"), asst("a1", "好的")]));
  const bad = { ...RULE, text: "另一条规则", evidence: [{ anchor: "#1", role: "user", quote: "这句用户没说过" }] };
  const chat = fakeChat(() => json({ candidates: [bad, RULE] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual(r.windows, { done: 1, deferred: 0, failed: 0, skipped: 0 }, "窗口照常完成");
  assert.deepEqual(r.receipt.dropped, { no_evidence: 1 });
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, "a1", "checkpoint 推进");
  assert.deepEqual([...e.store.project().props.values()].map((p) => p.text), [RULE.text], "其余候选照常写入");
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

// ---------- round3：决定和知识的正文、否掉的方案不能悄悄丢 ----------

test("review round3 条目 1：正文只差缩进的两条决定不合并，两份正文都留下", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [
    user("u1", "以后 hook 命令都写 node 绝对路径"),
    user("u2", "提交前记得 commit"),
  ]));
  const bodyA = "if enabled:\n    write()\n    commit()";
  const bodyB = "if enabled:\n    write()\ncommit()";
  const cand = (body: string, anchor: string, quote: string) => ({
    kind: "decision",
    text: "提交时机",
    why: "提交晚了下游读不到",
    body,
    basis: "user_directive",
    evidence: [{ anchor, role: "user", quote }],
    relation: { type: "new", target: null },
  });
  const chat = fakeChat(() => json({ candidates: [cand(bodyA, "#1", "以后 hook 命令都写 node 绝对路径"), cand(bodyB, "#2", "提交前记得 commit")] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.merged, 0, "缩进算内容，不能合并");
  assert.deepEqual([...e.store.project().props.values()].map((p) => p.body).sort(), [bodyA, bodyB].sort());
});

test("review round3 条目 2：显式判重复但候选带不同正文时，按新条目写入并交给关系判定（输入含双方正文和方案）", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, {
    kind: "decision",
    text: "hook 执行方式",
    why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
    body: "用绝对路径启动 node 24",
    alternatives: [{ option: "靠 PATH 找 ab", rejected_because: "宿主 PATH 很少" }],
    confirmed: true,
    source: src0(null),
  });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(
    () => json({
      candidates: [{
        kind: "decision",
        text: "hook 执行方式",
        why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
        body: "改为 PATH 启动 node 26",
        alternatives: [{ option: "绝对路径写死", rejected_because: "换机器要改配置", evidence: 0 }],
        basis: "user_directive",
        evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
        relation: { type: "duplicate", target: "m1" },
      }],
    }),
    (msgs) => {
      const text = msgs[1].content!;
      assert.match(text, /用绝对路径启动 node 24/, "关系判定看得到目标正文");
      assert.match(text, /改为 PATH 启动 node 26/, "关系判定看得到候选正文");
      assert.match(text, /靠 PATH 找 ab/, "关系判定看得到目标的否掉方案");
      assert.match(text, /绝对路径写死/, "关系判定看得到候选的否掉方案");
      return json({ results: [] });
    },
  );
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.attached, 0, "正文不一致时不能只追加证据");
  assert.equal(e.store.project().props.size, 2, "按新条目写入");
  const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.equal(fresh.body, "改为 PATH 启动 node 26");
  assert.deepEqual(fresh.alternatives, [{ option: "绝对路径写死", rejected_because: "换机器要改配置", evidence: 0 }]);
  assert.equal(chat.relateCalls.length, 1, "交给第 2 层关系判定");
});

test("review round3 条目 3：目标是 note 时纠正保留候选自己的种类", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, {
    kind: "note",
    text: "hook 命令直接写 ab，靠 PATH 找",
    body: "现在 hook 里写的是 ab，靠 PATH 找到它",
    confirmed: true,
    source: src0(null),
  });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({
    candidates: [{
      kind: "decision",
      text: "hook 走 node 绝对路径",
      why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
      body: "绝对路径写进 hook 配置",
      basis: "user_directive",
      evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
      relation: { type: "supersedes", target: "m1" },
    }],
  }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const corr = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.equal(corr.kind, "decision", "note 目标不把纠正改成 note");
  assert.equal(corr.supersedes, old);
  assert.equal(e.store.project().props.get(old)!.pending_corrections.length, 1);
});

test("review round3 条目 6：候选算向量复用 vectorText 截断，正文完整入库", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  // round4 条目 7 后正文按脱敏后的 5000 字算，正文本身就到不了 6000；这里验的是向量输入照旧不超上限、正文完整入库
  const body = "通知名单记录。".repeat(625);
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, kind: "decision", text: "通知名单记录", body }] }));
  const sent: number[] = [];
  const embedder: Embedder = Object.assign(async (texts: string[]) => {
    sent.push(...texts.map((t) => [...t].length));
    if (texts.some((t) => [...t].length > VEC_TEXT_MAX_CHARS)) throw new Error(`fixture input exceeds ${VEC_TEXT_MAX_CHARS}`);
    return fakeEmbed(texts);
  }, { model: "fake-embed" });
  const r = await runWork(e.deps(chat, { embedder }), { sweep: false, dryRun: false });
  assert.deepEqual(r.windows, { done: 1, deferred: 0, failed: 0, skipped: 0 });
  const p = [...e.store.project().props.values()][0] as Proposition;
  assert.equal(p.body, body, "正文完整保留");
  assert.ok(sent.every((n) => n <= VEC_TEXT_MAX_CHARS), `向量输入超上限：${sent}`);
});

// ---------- round4 条目 1：证据超过上限只截断，不丢整条 ----------

/** 06.json 那条被整条丢掉的决定：4 条证据（1 用户 + 3 助手）、带否掉的方案、带正文。 */
function piOpsGateDecision() {
  return {
    kind: "decision",
    project: "alpha",
    scenario: "当在 alpha 上开 PR、判断能不能合并时",
    text: "alpha 的 GitHub 门禁整体去掉：main 不要求任何必过检查，只留禁强推和禁删分支",
    body: "2026-10-27 删掉必过检查，停用 final 和 evidence-gate 两个流程；门禁代码没删，可恢复。",
    why: "final 门禁只要改了已登记为证明的测试就一律拒绝，#33–#37 连续 5 次合并这项全红，每次都用管理员权限强合，门禁既没拦住坏代码又架空了真正的测试检查。",
    alternatives: [{ option: "维持现状：final 仍留在必过检查里，红了用管理员权限硬合", rejected_because: "final 从不放行，强行合并还会把 evidence-gate 的红一起带进来", evidence: 2 }],
    basis: "user_directive",
    evidence: [
      { anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" },
      { anchor: "#2", role: "assistant", quote: "final 阶段只显示不拦合并" },
      { anchor: "#3", role: "assistant", quote: "强行合并连带架空了真正的测试检查" },
      { anchor: "#4", role: "assistant", quote: "禁用 final 和 evidence-gate 两个流程" },
    ],
    relation: { type: "new", target: null },
  };
}

/** 一次窗口里 1 用户 + 3 助手原话（证据 4 条，被截断时方案的下标要重映射）。 */
function gateTranscript() {
  return [
    user("u1", "以后 hook 命令都写 node 绝对路径"),
    asst("a1", "final 阶段只显示不拦合并"),
    asst("a2", "强行合并连带架空了真正的测试检查"),
    asst("a3", "禁用 final 和 evidence-gate 两个流程"),
  ];
}

test("round4 条目 1：4 条证据的决定照样入库（MAX_EVIDENCE 提到 6），方案引用不丢", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", gateTranscript()));
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [piOpsGateDecision()] }))), { sweep: false, dryRun: false });
  assert.deepEqual(r.receipt.dropped, {}, "不再整条丢");
  assert.equal(r.receipt.proposals, 1);
  const [p] = [...e.store.project().props.values()];
  assert.equal(p.evidence.length, 4, "4 条证据都留下");
  assert.equal(p.body, piOpsGateDecision().body, "正文入库");
  assert.deepEqual(p.alternatives, [{ option: "维持现状：final 仍留在必过检查里，红了用管理员权限硬合", rejected_because: "final 从不放行，强行合并还会把 evidence-gate 的红一起带进来", evidence: 2 }]);
  assert.equal(p.value?.flags?.includes("evidence_truncated"), false);
});

test("round4 条目 1：证据 7 条时只取前 6 条并记 evidence_truncated，整条照常入库", async () => {
  const e = env();
  const turns = [user("u1", "以后 hook 命令都写 node 绝对路径"), ...[1, 2, 3, 4, 5, 6].map((i) => asst(`a${i}`, `第 ${i} 段助手说明`))];
  e.register("s1", e.transcript("s1", turns));
  const cand = {
    ...piOpsGateDecision(),
    evidence: [
      { anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" },
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ anchor: `#${i + 1}`, role: "assistant", quote: `第 ${i} 段助手说明` })),
    ],
    alternatives: [{ option: "维持现状", rejected_because: "final 从不放行", evidence: 6 }],
  };
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [cand] }))), { sweep: false, dryRun: false });
  assert.deepEqual(r.receipt.dropped, {}, "超 6 条也不整条丢");
  const [p] = [...e.store.project().props.values()];
  assert.equal(p.evidence.length, 6, "只保留前 6 条");
  assert.deepEqual(p.evidence.map((x) => x.quote), ["以后 hook 命令都写 node 绝对路径", ...[1, 2, 3, 4, 5].map((i) => `第 ${i} 段助手说明`)]);
  assert.ok(p.value?.flags?.includes("evidence_truncated"), "记下被截断");
  assert.deepEqual(p.alternatives, [], "引用被截掉证据的方案整项丢掉（投影里是空数组）");
  assert.ok(p.value?.flags?.includes("alternatives_dropped"));
});

// ---------- round4 条目 2：第 2 层判定不再吞详情 ----------

const detailCand = (body: string) => ({
  kind: "decision",
  text: "hook 执行方式",
  why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
  body,
  basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
  relation: { type: "duplicate", target: "m1" },
});

test("round4 条目 2：判定输入保留正文的换行和缩进，只按 2000 字截断", async () => {
  const e = env();
  const body = "if enabled:\n    write()\n    commit()";
  e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", body, confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [detailCand("if enabled:\n    write()\ncommit()")] }), () => json({ results: [] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.relateCalls.length, 1);
  const sent = chat.relateCalls[0][1].content!;
  assert.ok(sent.includes(`（正文：${body}）`), `判定输入里的缩进被压平了：\n${sent}`);
});

test("round4 条目 2：模型说 duplicate 但正文只差缩进 → 不归档，改记 refines，两条都留着并互相关联", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", body: "if enabled:\n    write()\n    commit()", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [detailCand("if enabled:\n    write()\ncommit()")] }), () => json({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.relate.refines, 1, "改记成补充");
  assert.equal(r.relate.duplicate, 0);
  const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.deepEqual([fresh.state, fresh.merged_into, fresh.related?.outcome], ["active", null, "refines"], "本条不归档，关系记成补充");
  assert.equal(fresh.unreconciled, false, "第 2 层给出确定结论就解除未判定");
  assert.equal(e.store.project().props.get(old)!.body, "if enabled:\n    write()\n    commit()", "目标的正文没被改");
  const links = linkIndex(e.store.project().props);
  assert.deepEqual(links.get(fresh.id), [{ type: "refines", id: old }], "新条目指出去");
  assert.deepEqual(links.get(old), [{ type: "refined_by", id: fresh.id }], "目标指回来");
});

test("round4 条目 2：差异在被 2000 字截断挡住的正文尾部时，同样不归档（tail）", async () => {
  const e = env();
  const head = "甲".repeat(2100);
  const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", body: `${head}生产环境禁止写入`, confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [detailCand(`${head}生产环境允许写入`)] }), () => json({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.relate.refines, 1);
  const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.equal(fresh.state, "active");
  assert.equal(fresh.body, `${head}生产环境允许写入`, "尾部差异留在库里");
  assert.equal(e.store.project().props.get(old)!.body, `${head}生产环境禁止写入`);
});

test("round4 条目 2：目标没有正文（empty-target），候选带正文判 duplicate 也改记 refines", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [detailCand("只在测试环境写入")] }), () => json({ results: [{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  assert.deepEqual([fresh.state, fresh.related?.outcome, e.store.project().props.get(old)!.body], ["active", "refines", null]);
});

// 详情完全一致的 duplicate 在第 1 层就直接并入（上面 review round3 条目 2 的反例），applyVerdict 层的同款行为在 relate.test.ts 里测。

// ---------- round4 条目 3：候选键算上否掉的方案 ----------

test("round4 条目 3：同标题、否掉的方案不同的两条候选都入库；没有方案的候选键不变、窗口重跑不重复", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const withAlt = (option: string, quote: string) => ({
    ...detailCand(""),
    body: undefined,
    alternatives: [{ option, rejected_because: "宿主 PATH 很少" }],
    evidence: [{ anchor: "#1", role: "user", quote }],
    relation: { type: "new", target: null },
  });
  const chat = fakeChat(() => json({ candidates: [withAlt("靠 PATH 找 ab", "以后 hook 命令都写 node 绝对路径"), withAlt("绝对路径写死", "以后 hook 命令都写 node 绝对路径")] }));
  const deps = e.deps(chat);
  const r = await runWork(deps, { sweep: false, dryRun: false });
  assert.deepEqual([r.receipt.proposals, r.receipt.merged], [2, 0], "方案不同是两份内容");
  assert.deepEqual([...e.store.project().props.values()].map((p) => p.alternatives![0].option).sort(), ["abs", "靠 PATH 找 ab"].sort().map((x) => (x === "abs" ? "绝对路径写死" : x)));
  // 没有方案的候选：键与旧口径一致，同窗口重跑不重复入库
  const e2 = env();
  e2.register("s1", e2.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const plain = { ...RULE, text: "hook 命令写 node 绝对路径，不依赖 PATH" };
  const chat2 = fakeChat(() => json({ candidates: [plain] }));
  await runWork(e2.deps(chat2), { sweep: false, dryRun: false });
  await runWork(e2.deps(chat2), { sweep: false, dryRun: false });
  assert.equal(e2.store.project().props.size, 1, "重跑不重复入库");
});

// ---------- round4 条目 5：显式 duplicate 被降级成新条目后标关系未判定 ----------

test("round4 条目 5：详情不同被判成新条目时首次写入就标 unreconciled，第 2 层给出确定结论才解除", async () => {
  for (const [name, reply, expected] of [
    ["unsure", () => json({ results: [{ id: "q1", relation: "unsure", target: null, reason: "拿不准" }] }), true],
    ["invalid", () => json({ results: [] }), true],
    ["error", () => { throw new Error("fake unavailable"); }, true],
    ["refines", () => json({ results: [{ id: "q1", relation: "refines", target: "m1", reason: "更具体" }] }), false],
  ] as const) {
    const e = env();
    const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", body: "旧正文", confirmed: true, source: src0(null) });
    e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
    const r = await runWork(e.deps(fakeChat(() => json({ candidates: [detailCand("新增正文")] }), reply)), { sweep: false, dryRun: false });
    const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
    assert.equal(fresh.state, "active", name);
    assert.equal(fresh.unreconciled, expected, `${name}: 未判定状态`);
    assert.equal(recallable(fresh, false), !expected, `${name}: 未判定的条目不进召回`);
    assert.equal(r.relate.errors, name === "invalid" || name === "error" ? 1 : 0, `${name}: 出错计数`);
    if (name === "refines") assert.equal(fresh.related?.outcome, "refines");
  }
});

test("round4 条目 5：unreconciled 解除后召回才带上这条", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "decision", text: "hook 执行方式", why: "宿主 hook 子进程的 PATH 很少", body: "旧正文", confirmed: true, source: src0(null) });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const unsure = fakeChat(() => json({ candidates: [detailCand("新增正文")] }), () => json({ results: [{ id: "q1", relation: "unsure", target: null, reason: "拿不准" }] }));
  await runWork(e.deps(unsure), { sweep: false, dryRun: false });
  const fresh = [...e.store.project().props.values()].find((p) => p.id !== old)!;
  const shown: string[] = [];
  const embedder = Object.assign(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])), { model: "fake" });
  const text = await recall(e.store, "hook 执行方式", e.repo, () => embedder, shown, [], () => ({ name: "alpha", path: e.repo }));
  assert.equal(shown.includes(fresh.id), false, `未判定的条目被召回：${text}`);
});

/**
 * 切片 3 流水线（函数级）：假模型、假 embedding 都是确定性的，不发网络请求。
 * 运行：node --test src/work.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import { WorkFailure, type Chat, type ChatMessage } from "./llm.ts";
import { allowedTranscript, chunk, runWork, scan, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import { sha256 } from "./extract.ts";
import type { Proposition, RememberBody } from "./l2.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-work-")));
let n = 0;

/** 字符袋向量：同样的字越多越像。 */
const fakeEmbed: Embedder = Object.assign(async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(97);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
}), { model: "fake-embed" });

type Reply = (msgs: ChatMessage[], opts?: { tools?: unknown[]; json?: boolean }) => ChatMessage | Promise<ChatMessage>;
function fakeChat(reply: Reply): Chat & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[], opts?: { tools?: unknown[]; json?: boolean }) => {
    calls.push(structuredClone(msgs));
    return { message: await reply(msgs, opts), tokens: 100 };
  }) as Chat & { calls: ChatMessage[][] };
  f.calls = calls;
  return f;
}
const json = (o: object): ChatMessage => ({ role: "assistant", content: JSON.stringify(o) });

interface Env {
  store: Store;
  repo: string;
  deps: (chat: Chat | null, extra?: Partial<WorkDeps>) => WorkDeps;
  transcript: (sid: string, lines: object[], idle?: boolean) => string;
  register: (sid: string, file: string, ended?: boolean) => void;
  pid: string;
}

function env(): Env {
  const dir = join(base, `e${n++}`);
  const repo = join(dir, "alpha");
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "实现交给 Codex。hook 命令要写 node 绝对路径。\n");
  writeFileSync(join(repo, "store.ts"), "const VEC_MIN_SIM = 0.45;\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  const regDir = join(dir, "repos");
  mkdirSync(regDir);
  writeFileSync(join(regDir, "alpha.md"), "- 路径：`x`\n- 业务：个人记忆系统\n");
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = store.ensureProject("alpha");
  return {
    store,
    repo,
    pid,
    deps: (chat, extra = {}) => ({
      store,
      now: () => new Date(),
      chat: chat ? { chat, model: "fake-llm" } : { error: "no_config", message: "没有 extract.json" },
      embedder: fakeEmbed,
      registry: [{ name: "alpha", path: repo }],
      registryDir: regDir,
      resolveProject: (cwd) => (cwd.startsWith(repo) ? { name: "alpha", path: repo } : null),
      projectId: (name) => store.ensureProject(name),
      ...extra,
    }),
    transcript: (sid, lines, idle = true) => {
      const p = join(dir, `${sid}.jsonl`);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      if (idle) utimesSync(p, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
      return p;
    },
    register: (sid, file, ended = false) => {
      intake.upsertSession(store.workDb, { host: "claude", session_id: sid, transcript: file, cwd: repo, ended, ephemeral: false, via: "hook" }, () => "alpha", new Date());
    },
  };
}

const user = (uuid: string, text: string) => ({ type: "user", uuid, message: { role: "user", content: text } });
const asst = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { content: [{ type: "text", text }] } });
const toolErr = (uuid: string, text: string) => ({ type: "user", uuid, message: { content: [{ type: "tool_result", tool_use_id: "x", content: text, is_error: true }] } });

const RULE = {
  kind: "rule",
  scope: "project",
  text: "hook 命令写 node 绝对路径，不依赖 PATH",
  basis: "user_directive",
  evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
  relation: { type: "new", target: null },
};

function props(store: Store): Proposition[] {
  return [...store.project().props.values()];
}

test("会话静置后抽出一条未确认提议；编造引文的候选被丢；checkpoint 推进、窗口完成", async () => {
  const e = env();
  const f = e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH"), asst("a1", "好的")]);
  e.register("s1", f);
  const chat = fakeChat(() => json({ candidates: [RULE, { ...RULE, text: "另一条", evidence: [{ anchor: "#1", role: "user", quote: "以后所有命令都加 sudo" }] }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual(r.windows, { done: 1, deferred: 0, failed: 0, skipped: 0 });
  assert.equal(r.receipt.proposals, 1);
  assert.deepEqual(r.receipt.dropped, { quote_mismatch: 1 });
  const [p] = props(e.store);
  assert.equal(p.text, RULE.text);
  assert.equal(p.confirmed, false);
  assert.equal(p.origin, "extract");
  assert.equal(p.basis, "user_directive");
  assert.equal(p.project_id, e.pid);
  assert.deepEqual(p.evidence, [{ anchor: "u1", role: "user", quote_sha256: sha256("以后 hook 命令都写 node 绝对路径") }]);
  assert.equal(p.source.session_id, "s1");
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, "a1");
  const ctx = chat.calls[0][1].content!;
  assert.match(ctx, /实现交给 Codex/, "项目文档进了上下文");
  assert.match(ctx, /业务：个人记忆系统/, "pm 档案进了上下文");
});

test("没有新内容不再调模型；L1 不因重跑而重复（幂等）", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1);
  assert.equal(props(e.store).length, 1);
});

test("崩溃重试：提交事务失败时 L1、窗口、checkpoint 一起回滚；重跑只多一次模型调用，不出重复条目", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  const real = e.store.commit.bind(e.store);
  let crash = true;
  e.store.commit = ((appends, work) => real(appends, (db, ids) => {
    work(db, ids);
    if (crash) {
      crash = false;
      throw new Error("模拟进程在提交前崩溃");
    }
  })) as Store["commit"];
  await assert.rejects(runWork(e.deps(chat), { sweep: false, dryRun: false }), /模拟进程/);
  assert.equal(props(e.store).length, 0);
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, null);
  assert.equal(e.store.workDb.prepare("SELECT count(*) AS n FROM work_lease").get()!.n, 0, "租约已释放");
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 2);
  assert.equal(props(e.store).length, 1);
});

test("送模型前脱敏；正文含秘密的候选被丢；ab 注入与 ab 输出不进模型输入（防回声）", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [
    user("u1", "<agentbrain-recall>\n- [deadbeef] 坑: 旧记忆的原文\n</agentbrain-recall>\n我的 key 是 sk-abcdefghijklmnop1234，邮箱 a.b@x.com，以后 hook 命令都写 node 绝对路径"),
    { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ab search 旧记忆" } }] } },
    { type: "user", uuid: "r1", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "[deadbeef] 全局 坑: 另一段 ab 输出" }] } },
  ]));
  const chat = fakeChat(() => json({ candidates: [RULE, { ...RULE, text: "key 是 sk-abcdefghijklmnop1234" }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const sent = JSON.stringify(chat.calls[0]);
  assert.doesNotMatch(sent, /sk-abcdefghijklmnop1234|a\.b@x\.com/);
  assert.match(sent, /\[SECRET:api_key\]/);
  assert.doesNotMatch(sent, /旧记忆的原文|另一段 ab 输出/);
  assert.deepEqual(r.receipt.dropped, { secret: 1 });
  assert.deepEqual(r.receipt.sanitizer, { api_key: 1, email: 1 });
  assert.equal(r.receipt.stripped, 3);
  assert.deepEqual(props(e.store).map((p) => p.text), [RULE.text]);
});

test("重复：给已有条目追加来源，不新建", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令写 node 绝对路径，不依赖 PATH", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, text: "hook 用绝对 node 路径", relation: { type: "duplicate", target: "m1" } }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.match(chat.calls[0][1].content!, /m1 \[rule\] hook 命令写 node 绝对路径/);
  assert.equal(r.receipt.attached, 1);
  const all = props(e.store);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].extra_sources.map((s) => [s.session_id, s.basis]), [["s1", "user_directive"]]);
  assert.equal(all[0].id, old);
});

test("与已确认条目冲突：成为待确认的纠正，旧条目仍有效并标出冲突", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab，靠 PATH 找", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，PATH 靠不住")]));
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, relation: { type: "conflicts", target: "m1" } }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.corrections, 1);
  const target = e.store.project().props.get(old)!;
  assert.equal(target.state, "active");
  assert.equal(target.pending_corrections.length, 1);
  const corr = e.store.project().props.get(target.pending_corrections[0])!;
  assert.equal(corr.supersedes, old);
  assert.equal(corr.confirmed, false);
});

test("近邻复查：出现没给模型看过的高相似条目 → 关系未判定（unreconciled）", async () => {
  const e = env();
  e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令写 node 绝对路径，不依赖 PATH", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  // 用户消息与已有条目毫不相干，预取不到它；候选正文却几乎一样
  e.register("s1", e.transcript("s1", [user("u1", "嗯嗯嗯嗯嗯嗯嗯嗯"), toolErr("t1", "以后 hook 命令都写 node 绝对路径 ERR")]));
  const chat = fakeChat((msgs) => {
    assert.doesNotMatch(msgs[1].content!, /m1 /);
    return json({ candidates: [{ ...RULE, kind: "pitfall", basis: "observed_failure", text: "hook 命令写 node 绝对路径，不依赖 PATH。", evidence: [{ anchor: "#2", role: "tool", quote: "hook 命令都写 node 绝对路径" }] }] });
  });
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.unreconciled, 1);
  assert.equal(props(e.store).filter((p) => p.unreconciled).length, 1);
});

test("跨会话印证：两个不同会话里用户各自说过同一条规则 → 自动转正；同一句原话被复制到新会话不算", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] }))), { sweep: false, dryRun: false });
  const [p] = props(e.store);
  // resume 出来的新会话带着同一句原话：不算独立
  e.register("s2", e.transcript("s2", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => json({ candidates: [{ ...RULE, relation: { type: "duplicate", target: "m1" } }] }))), { sweep: false, dryRun: false });
  assert.equal(e.store.project().props.get(p.id)!.confirmed, false);
  e.register("s3", e.transcript("s3", [user("v1", "记住：hook 里一律用 node 的绝对路径")]));
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [{ ...RULE, evidence: [{ anchor: "#1", role: "user", quote: "hook 里一律用 node 的绝对路径" }], relation: { type: "duplicate", target: "m1" } }] }))), { sweep: false, dryRun: false });
  assert.equal(r.receipt.corroborated, 1);
  const after = e.store.project().props.get(p.id)!;
  assert.equal(after.confirmed, true);
  assert.equal(after.confirmed_by, "corroboration");
});

test("agent 推断的重复不算印证", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] }))), { sweep: false, dryRun: false });
  e.register("s2", e.transcript("s2", [asst("a1", "我觉得 hook 命令最好写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => json({ candidates: [{ ...RULE, kind: "decision", basis: "agent_inference", evidence: [{ anchor: "#1", role: "assistant", quote: "hook 命令最好写 node 绝对路径" }], relation: { type: "duplicate", target: "m1" } }] }))), { sweep: false, dryRun: false });
  assert.equal(props(e.store)[0].confirmed, false);
});

test("未静置、未结束的会话不处理；SessionEnd 后立即处理；结束后又有新 prompt 就按静置判断", async () => {
  const e = env();
  const f = e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")], false);
  e.register("s1", f);
  const chat = fakeChat(() => json({ candidates: [] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 0);
  e.register("s1", f, true);
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1);
});

test("模型未配置：窗口延后且不消耗重试次数；embedding 故障按退避重试，用完转失败并跳过该窗口", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const r = await runWork(e.deps(null), { sweep: false, dryRun: false });
  assert.equal(r.windows.deferred, 1);
  const w = e.store.workDb.prepare("SELECT state,attempts,error_code FROM capture_windows").get();
  assert.deepEqual({ ...w }, { state: "deferred", attempts: 0, error_code: "no_config" });

  const broken: Embedder = Object.assign(async () => {
    throw new Error("503");
  }, { model: "fake-embed" });
  let t = Date.now();
  const deps = e.deps(fakeChat(() => json({ candidates: [] })), { embedder: broken, now: () => new Date(t) });
  for (let i = 0; i < intake.MAX_ATTEMPTS; i++) {
    t += 3 * 3_600_000;
    await runWork(deps, { sweep: false, dryRun: false });
  }
  const w2 = { ...e.store.workDb.prepare("SELECT state,error_code FROM capture_windows").get() };
  assert.deepEqual(w2, { state: "failed", error_code: "embed_unavailable" });
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, "u1", "毒化窗口不卡住后续内容");
});

test("限流 429 延后；日预算用完延后到次日", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => {
    throw new WorkFailure("http_429", "限流");
  })), { sweep: false, dryRun: false });
  assert.equal(e.store.workDb.prepare("SELECT error_code FROM capture_windows").get()!.error_code, "http_429");
  const e2 = env();
  e2.register("s1", e2.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  intake.spend(e2.store.workDb, new Date(), intake.DAILY_MAX_CALLS, 0);
  const chat = fakeChat(() => json({ candidates: [] }));
  const r = await runWork(e2.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 0);
  assert.equal(r.windows.deferred, 1);
  assert.equal(e2.store.workDb.prepare("SELECT error_code FROM capture_windows").get()!.error_code, "budget_exhausted");
});

test("ephemeral、未登记目录、已 purge 的会话跳过，不调模型", async () => {
  const e = env();
  const f = e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]);
  intake.upsertSession(e.store.workDb, { host: "pi", session_id: "eph", transcript: null, cwd: e.repo, ended: true, ephemeral: true, via: "hook" }, () => "alpha", new Date());
  intake.upsertSession(e.store.workDb, { host: "claude", session_id: "elsewhere", transcript: f, cwd: "/tmp", ended: true, ephemeral: false, via: "hook" }, () => null, new Date());
  e.register("gone", f, true);
  e.store.purgeSession("gone");
  const chat = fakeChat(() => json({ candidates: [] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 0);
  assert.equal(r.windows.skipped, 3);
});

test("单实例：租约被占时直接返回 busy；持有者进程已死则接管并计数", async () => {
  const e = env();
  e.store.workDb.prepare("INSERT INTO work_lease(name,holder,pid,expires_at) VALUES('work','x',?,?)").run(process.pid, new Date(Date.now() + 60_000).toISOString());
  assert.equal((await runWork(e.deps(null), { sweep: false, dryRun: false })).busy, true);
  e.store.workDb.prepare("UPDATE work_lease SET pid=999999").run();
  assert.equal((await runWork(e.deps(null), { sweep: false, dryRun: false })).busy, false);
  assert.equal(intake.stats(e.store.workDb, new Date()).leaseTakeovers, 1);
});

test("切窗口：按轮次边界不超过上限；未静置时最后一段留到下次；checkpoint 找不到时显式报错", () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ anchor: `a${i}`, role: "user" as const, text: "x".repeat(20_000) }));
  const settledChunks = chunk("claude", "s", turns, null, true) as ReturnType<typeof chunk> & object[];
  assert.deepEqual((settledChunks as any[]).map((c) => [c.from, c.to, c.turns.length]), [[null, "a1", 2], ["a1", "a3", 2], ["a3", "a4", 1]]);
  assert.deepEqual((settledChunks as any[])[1].context.map((t: any) => t.anchor), ["a0", "a1"]);
  assert.equal((chunk("claude", "s", turns, null, false) as any[]).length, 2);
  assert.equal((chunk("claude", "s", turns, "a3", true) as any[])[0].from, "a3");
  assert.equal(chunk("claude", "s", turns, "zzz", true), "anchor_missing");
  const again = chunk("claude", "s", turns, null, true) as any[];
  assert.equal(again[0].id, (settledChunks as any[])[0].id, "窗口 id 只由坐标决定");
});

test("transcript 路径必须在宿主自己的会话目录里", () => {
  const home = join(base, "h");
  mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
  const ok = join(home, ".claude/projects/p/s.jsonl");
  writeFileSync(ok, "");
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(allowedTranscript("claude", ok), ok);
    assert.equal(allowedTranscript("codex", ok), null);
    assert.equal(allowedTranscript("claude", join(home, ".ssh/id_rsa")), null);
    assert.equal(allowedTranscript("claude", join(home, ".claude/projects/p/../../../.ssh/x.jsonl")), null);
  } finally {
    process.env.HOME = old;
  }
});

test("扫描兜底：只补登记 cwd 在已登记项目里的近期会话", () => {
  const e = env();
  const home = join(base, "scanhome");
  mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
  writeFileSync(join(home, ".claude/projects/p/in.jsonl"), JSON.stringify({ type: "user", uuid: "u", cwd: e.repo, message: { content: "hi" } }) + "\n");
  writeFileSync(join(home, ".claude/projects/p/out.jsonl"), JSON.stringify({ type: "user", uuid: "u", cwd: "/tmp", message: { content: "hi" } }) + "\n");
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 1);
    assert.equal(scan(e.deps(null)), 0);
  } finally {
    process.env.HOME = old;
  }
  const [s] = intake.sessions(e.store.workDb);
  assert.deepEqual([s.session_id, s.project, s.via], ["in", "alpha", "scan"]);
});

// ---------- 代码核验转正 ----------

function verifierChat(verdict: object): Chat & { calls: ChatMessage[][] } {
  return fakeChat((msgs, opts) => {
    if (!opts?.tools) return json({ candidates: [] });
    if (msgs.length === 2) return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_code", arguments: JSON.stringify({ pattern: "VEC_MIN_SIM" }) } }] };
    return json(verdict);
  });
}

function unconfirmed(e: Env, text: string, extra: Partial<RememberBody> = {}): string {
  return e.store.remember(e.pid, "s0", false, { kind: "pitfall", text, confirmed: false, origin: "extract", basis: "agent_inference", source: { host: "claude", session_id: "s0", transcript: null, anchor: null, summary: "x" }, ...extra });
}

test("代码核验 verified：带对得上的文件证据 → 转正，L1 记下路径、行号与 HEAD", async () => {
  const e = env();
  const id = unconfirmed(e, "向量门槛 VEC_MIN_SIM 是 0.45");
  const r = await runWork(e.deps(verifierChat({ verdict: "verified", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] })), { sweep: true, dryRun: false });
  assert.equal(r.verify.verified, 1);
  const p = e.store.project().props.get(id)!;
  assert.equal(p.confirmed, true);
  assert.equal(p.confirmed_by, "code");
  const head = execFileSync("git", ["-C", e.repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.deepEqual(p.code_evidence, { head, refs: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] });
  const again = await runWork(e.deps(verifierChat({ verdict: "verified", evidence: [] })), { sweep: true, dryRun: false });
  assert.equal(again.verify.verified + again.verify.inconclusive, 0, "已确认的不再核验");
});

test("代码核验 contradicted → 标与代码不符，仍未确认；同一 HEAD 不重复核验", async () => {
  const e = env();
  const id = unconfirmed(e, "向量门槛 VEC_MIN_SIM 是 0.35");
  const chat = verifierChat({ verdict: "contradicted", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] });
  await runWork(e.deps(chat), { sweep: true, dryRun: false });
  const p = e.store.project().props.get(id)!;
  assert.equal(p.confirmed, false);
  assert.equal(p.stale?.refs.length, 1);
  const before = chat.calls.length;
  await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(chat.calls.length, before);
});

test("代码核验：编造的证据、只给置信度 → 不转正、不写 L1；决定与规则不进代码核验", async () => {
  const e = env();
  const id = unconfirmed(e, "向量门槛 VEC_MIN_SIM 是 0.45");
  const dec = unconfirmed(e, "选 RRF 是因为不用调权重", { kind: "decision" });
  const events = () => e.store.workDb.prepare("SELECT count(*) AS n FROM events WHERE kind='verify'").get()!.n;
  const chat = verifierChat({ verdict: "verified", confidence: 0.99, evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45 已验证" }] });
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(r.verify.inconclusive, 1);
  assert.equal(events(), 0);
  assert.equal(e.store.project().props.get(id)!.confirmed, false);
  assert.equal(e.store.project().props.get(dec)!.confirmed, false);
  assert.equal(chat.calls.filter((m) => /选 RRF/.test(JSON.stringify(m))).length, 0);
});

test("代码核验 not_verifiable 记在 work store，不写 L1；待确认的纠正与关系未判定的条目不核验", async () => {
  const e = env();
  unconfirmed(e, "Codex 会过滤自定义环境变量");
  const target = e.store.remember(e.pid, null, false, { kind: "pitfall", text: "旧坑", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  unconfirmed(e, "纠正旧坑", { supersedes: target });
  unconfirmed(e, "关系没判定的坑", { unreconciled: true });
  const chat = verifierChat({ verdict: "not_verifiable" });
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(r.verify.not_verifiable, 1);
  assert.equal(e.store.workDb.prepare("SELECT count(*) AS n FROM events WHERE kind='verify'").get()!.n, 0);
});

test("自动沉淀的提议 90 天未确认 → 归档为过期", async () => {
  const e = env();
  const id = unconfirmed(e, "很久以前的坑");
  const later = new Date(Date.now() + 91 * 86_400_000);
  const r = await runWork(e.deps(verifierChat({ verdict: "not_verifiable" }), { now: () => later }), { sweep: true, dryRun: false });
  assert.equal(r.expired, 1);
  const p = e.store.project().props.get(id)!;
  assert.deepEqual([p.state, p.expired], ["archived", true]);
});

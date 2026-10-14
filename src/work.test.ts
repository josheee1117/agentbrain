/**
 * 切片 3 流水线（函数级）：假模型、假 embedding 都是确定性的，不发网络请求。
 * 运行：node --test src/work.test.ts
 */
import { test } from "node:test";
import { reviewList } from "./expiry.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import { WorkFailure, type Chat, type ChatMessage } from "./llm.ts";
import { allowedTranscript, BACKLOG_WINDOWS_PER_SWEEP, chunk, runWork, scan, type WorkDeps } from "./work.ts";
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
/** 关系判定（第 2 层）的调用单独记在 relateCalls，默认回空结果（不写 L1）。 */
function fakeChat(reply: Reply, relate: Reply = () => json({ results: [] })): Chat & { calls: ChatMessage[][]; relateCalls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const relateCalls: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[], opts?: { tools?: unknown[]; json?: boolean }) => {
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
      staging: false, // 这些用例测 v2 的正式库流程（印证、纠正、核验）；候选区另有用例
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
  why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
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
  assert.deepEqual(r.receipt.dropped, { no_evidence: 1 });
  assert.deepEqual(r.receipt.evidence_dropped, { quote_mismatch: 1 });
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

test("给模型看过近邻、模型仍说 new，而正文与近邻几乎一样 → 关系未判定，不自动合并", async () => {
  const e = env();
  e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令写 node 绝对路径，不依赖 PATH", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，不依赖 PATH")]));
  const chat = fakeChat((msgs) => {
    assert.match(msgs[1].content!, /m1 \[rule，未确认\] hook 命令写 node 绝对路径/, "近邻给模型看了");
    return json({ candidates: [{ ...RULE, text: "hook 命令写 node 绝对路径，不要依赖 PATH" }] });
  });
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual([r.receipt.unreconciled, r.receipt.proposals], [1, 0]);
  assert.equal(props(e.store).length, 2, "不由向量自动并进旧条目");
});

test("同一窗口近重复：只留一条，优先 kind 与 basis 对得上的，证据取并集；不相干的照常保留", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径"), asst("a1", "好"), user("u2", "对，hook 一律写 node 绝对路径")]));
  const chat = fakeChat(() => json({ candidates: [
    { ...RULE, kind: "decision", text: "hook 命令都写 node 绝对路径，不依赖 PATH", evidence: [{ anchor: "#3", role: "user", quote: "hook 一律写 node 绝对路径" }] },
    { ...RULE, text: "hook 命令写 node 绝对路径，不依赖 PATH" },
    { ...RULE, text: "提交信息用中文写", evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令" }] },
  ] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual([r.receipt.candidates, r.receipt.merged, r.receipt.proposals], [3, 1, 2]);
  const kept = props(e.store).find((p) => p.text.startsWith("hook"))!;
  assert.equal(kept.kind, "rule", "user_directive 对应 rule");
  assert.deepEqual(kept.evidence.map((x) => x.anchor).sort(), ["u1", "u2"]);
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

test("限流 429 延后；日用量只记录不拦截；旧的 budget_exhausted 延后立即重做", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  await runWork(e.deps(fakeChat(() => {
    throw new WorkFailure("http_429", "限流");
  })), { sweep: false, dryRun: false });
  assert.equal(e.store.workDb.prepare("SELECT error_code FROM capture_windows").get()!.error_code, "http_429");
  const e2 = env();
  e2.register("s1", e2.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  intake.spend(e2.store.workDb, new Date(), 10_000, 100_000_000);
  await runWork(e2.deps(fakeChat(() => {
    throw new WorkFailure("http_429", "限流");
  })), { sweep: false, dryRun: false });
  e2.store.workDb.prepare("UPDATE capture_windows SET error_code='budget_exhausted', next_at=?").run(new Date(Date.now() + 86_400_000).toISOString());
  const chat = fakeChat(() => json({ candidates: [] }));
  const r = await runWork(e2.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1, "超过旧上限也照常调用");
  assert.equal(r.windows.done, 1);
  assert.equal(r.windows.deferred, 0);
  const id = unconfirmed(e2, "向量门槛 VEC_MIN_SIM 是 0.45");
  const vchat = verifierChat({ verdict: "verified", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] });
  const r2 = await runWork(e2.deps(vchat), { sweep: true, dryRun: false });
  assert.equal(r2.verify.verified, 1, "核验也不受日用量限制");
  assert.equal(e2.store.project().props.get(id)!.confirmed_by, "code");
});

test("补登记会话每次 sweep 最多处理 BACKLOG_WINDOWS_PER_SWEEP 个窗口；hook 登记的先处理、不受限", async () => {
  const e = env();
  for (let i = 0; i < BACKLOG_WINDOWS_PER_SWEEP + 2; i++) {
    const f = e.transcript(`b${i}`, [user(`u${i}`, `历史会话 ${i}`)]);
    intake.upsertSession(e.store.workDb, { host: "claude", session_id: `b${i}`, transcript: f, cwd: e.repo, ended: true, ephemeral: false, via: "backfill" }, () => "alpha", new Date());
  }
  const live = e.transcript("live", [user("u", "当前会话")]);
  intake.upsertSession(e.store.workDb, { host: "claude", session_id: "live", transcript: live, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date(Date.now() + 1000));
  const seenUsers: string[] = [];
  const chat = fakeChat((msgs) => {
    seenUsers.push(/\[#1 user\] (.*)/.exec(msgs[1].content!)![1]);
    return json({ candidates: [] });
  });
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(seenUsers[0], "当前会话", "hook 会话先处理");
  assert.equal(r.windows.done, BACKLOG_WINDOWS_PER_SWEEP + 1);
  assert.equal(r.backlogLeft, 2);
  const r2 = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.deepEqual([r2.windows.done, r2.backlogLeft], [2, 0], "下次 sweep 接着补");
  const one = await runWork(e.deps(chat), { session: { host: "claude", session_id: "b0" }, sweep: false, dryRun: false, redo: true });
  assert.equal(one.windows.done, 1, "--session 不受补登记上限");
});

test("同窗口近重复但关系不同（纠正 vs 新提议）不合并", async () => {
  const e = env();
  e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab", confirmed: true, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，不依赖 PATH")]));
  const chat = fakeChat(() => json({ candidates: [
    { ...RULE, relation: { type: "conflicts", target: "m1" } },
    { ...RULE, text: "hook 命令写 node 绝对路径，不要依赖 PATH" },
  ] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.merged, 0);
  assert.equal(r.receipt.corrections, 1, "纠正信号保留");
});

test("first_hook_at 只写一次：扫描行后来被 hook 碰到，不会把它的早期登记时间当成 hook 安装时间", () => {
  const e = env();
  const db = e.store.workDb;
  intake.upsertSession(db, { host: "pi", session_id: "old", transcript: null, cwd: e.repo, ended: false, ephemeral: false, via: "backfill" }, () => "alpha", new Date("2026-10-01T00:00:00Z"));
  intake.upsertSession(db, { host: "pi", session_id: "h", transcript: null, cwd: e.repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date("2026-10-10T00:00:00Z"));
  intake.upsertSession(db, { host: "pi", session_id: "old", transcript: null, cwd: e.repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date("2026-10-11T00:00:00Z"));
  assert.equal(intake.firstHookAt(db), "2026-10-10T00:00:00.000Z");
});

test("--redo：从头重跑一个会话，已入库的同一候选不重复", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]), true);
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const again = await runWork(e.deps(chat), { session: { host: "claude", session_id: "s1" }, sweep: false, dryRun: false });
  assert.equal(again.windows.done, 0, "不 redo 时没有新内容");
  const redo = await runWork(e.deps(chat), { session: { host: "claude", session_id: "s1" }, sweep: false, dryRun: false, redo: true });
  assert.equal(redo.windows.done, 1);
  assert.equal(chat.calls.length, 2);
  assert.equal(props(e.store).length, 1, "同一候选幂等");
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

test("Codex 子 agent 会话：不调模型、标 ephemeral、不算疑似漏登记；扫描也不补登记它", async () => {
  const e = env();
  const meta = (source: unknown) => ({ type: "session_meta", payload: { cwd: e.repo, timestamp: new Date().toISOString(), source } });
  const msg = { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "以后 hook 命令都写 node 绝对路径" }] } };
  const f = e.transcript("g1", [meta({ subagent: { other: "guardian" } }), msg]);
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: "g1", transcript: f, cwd: e.repo, ended: true, ephemeral: false, via: "scan" }, () => "alpha", new Date());
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 0);
  assert.equal(r.windows.skipped, 1);
  assert.equal(intake.sessions(e.store.workDb)[0].ephemeral, 1);
  assert.equal(intake.stats(e.store.workDb, new Date()).sessions.scanned, 0);

  const home = join(base, "subhome");
  const id = "01a11967-19b1-7063-8631-c3dfad45ef88";
  mkdirSync(join(home, ".codex/sessions/2026/10/08"), { recursive: true });
  writeFileSync(join(home, `.codex/sessions/2026/10/08/rollout-2026-10-08T10-45-49-${id}.jsonl`), JSON.stringify(meta({ subagent: { thread_spawn: { depth: 1 } } })) + "\n");
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 0);
    assert.equal(intake.knownSession(e.store.workDb, "codex", id), false);
  } finally {
    process.env.HOME = old;
  }
});

test("hook 登记时 transcript 还没落盘：处理时按 session id 找到 rollout 并补上", async () => {
  const e = env();
  const home = join(base, "latehome");
  const id = "01a132dc-4d5f-7d62-840d-69f94d09f7c7";
  const dir = join(home, ".codex/sessions/2026/10/12");
  mkdirSync(dir, { recursive: true });
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: null, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const f = join(dir, `rollout-2026-10-12T10-00-00-${id}.jsonl`);
  writeFileSync(f, [
    { type: "session_meta", payload: { cwd: e.repo, source: "vscode" } },
    { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "以后 hook 命令都写 node 绝对路径" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 1);
    assert.equal(intake.sessions(e.store.workDb)[0].transcript, realpathSync(f));
    assert.equal(props(e.store).length, 1);
  } finally {
    process.env.HOME = old;
  }
});

test("debugDir：每个窗口写一份脱敏后的轮次与模型原始回复；不设就不写", async () => {
  const e = env();
  const f = e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，key sk-abcdefghijklmnopqrstuvwxyz0123456789")]);
  e.register("s1", f, true);
  const dir = join(base, "dbg");
  const chat = fakeChat(() => json({ candidates: [RULE], note: "sk-abcdefghijklmnopqrstuvwxyz0123456789" }));
  await runWork(e.deps(chat, { debugDir: dir }), { sweep: false, dryRun: false });
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const d = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  assert.equal(d.session, "claude:s1");
  assert.equal(d.turns[0].n, "#1");
  assert.match(d.raw, /以后 hook 命令都写 node 绝对路径/);
  assert.doesNotMatch(JSON.stringify(d), /sk-abcdefghij/, "原始回复与轮次都脱敏");
  const e2 = env();
  e2.register("s1", e2.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]), true);
  await runWork(e2.deps(fakeChat(() => json({ candidates: [] }))), { sweep: false, dryRun: false });
  assert.equal(readdirSync(dir).length, 1);
});

const src0 = (sid: string | null) => ({ host: "claude" as const, session_id: sid, transcript: null, anchor: "u1", summary: "x" });
const auto = (e: Env, sid: string, text: string, quote: string, extra: Partial<RememberBody> = {}) =>
  e.store.remember(e.pid, sid, false, { kind: "rule", text, confirmed: false, origin: "extract", basis: "user_directive", evidence: [{ anchor: "u1", role: "user", quote_sha256: sha256(quote) }], source: src0(sid), ...extra });
const relateReply = (results: object[]): Reply => () => json({ results });

test("关系判定：重复 → 来源并入旧条目、本条归档（可撤销），不同会话不同原话 → 跨会话印证转正", async () => {
  const e = env();
  const a = auto(e, "s1", "hook 命令写 node 绝对路径，不依赖 PATH", "以后 hook 命令都写 node 绝对路径");
  const b = auto(e, "s2", "hook 命令写 node 绝对路径，别依赖 PATH", "hook 里一律用 node 的绝对路径");
  const chat = fakeChat(() => json({ candidates: [] }), relateReply([{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }]));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.relateCalls.length, 1);
  assert.match(chat.relateCalls[0][1].content!, /N: \[rule，未确认\] hook 命令写 node 绝对路径，别依赖/);
  assert.deepEqual([r.relate.duplicate, r.relate.corroborated], [1, 1]);
  const pa = e.store.project().props.get(a)!;
  const pb = e.store.project().props.get(b)!;
  assert.deepEqual([pb.state, pb.merged_into, pb.related?.outcome], ["archived", a, "duplicate"]);
  assert.deepEqual(pa.extra_sources.map((x) => x.session_id), ["s2"]);
  assert.deepEqual([pa.state, pa.confirmed, pa.confirmed_by], ["active", true, "corroboration"]);
  e.store.lifecycle("reactivate", b, null);
  assert.deepEqual([e.store.project().props.get(b)!.state, e.store.project().props.get(b)!.merged_into], ["active", null], "归档可撤销");
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.relateCalls.length, 1, "判过的不再判");
});

test("关系判定：同一会话里的重复只算一个会话，不转正", async () => {
  const e = env();
  const a = auto(e, "s1", "hook 命令写 node 绝对路径，不依赖 PATH", "以后 hook 命令都写 node 绝对路径");
  auto(e, "s1", "hook 命令写 node 绝对路径，别依赖 PATH", "hook 里一律用 node 的绝对路径");
  const chat = fakeChat(() => json({ candidates: [] }), relateReply([{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }]));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual([r.relate.duplicate, r.relate.corroborated], [1, 0]);
  assert.equal(e.store.project().props.get(a)!.confirmed, false);
});

test("关系判定：补充 / 无关解除关系未判定；拿不准照旧；冲突走待确认纠正，已确认条目不被改；校验不过的不写", async () => {
  const e = env();
  const ok = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab，靠 PATH 找到它", confirmed: true, source: src0(null) });
  const c1 = auto(e, "s1", "hook 命令直接写 ab，不靠 PATH 找到它", "q1", { unreconciled: true });
  const c2 = auto(e, "s2", "hook 命令直接写 ab，靠 PATH 找到它就行", "q2", { unreconciled: true });
  const c3 = auto(e, "s3", "hook 命令直接写 ab，靠 PATH 找到它即可", "q3", { unreconciled: true });
  const c4 = auto(e, "s4", "hook 命令直接写 ab，靠 PATH 找到它吧", "q4", { unreconciled: true });
  const chat = fakeChat(() => json({ candidates: [] }), (msgs) => {
    const n = (msgs[1].content!.match(/## q/g) ?? []).length;
    assert.equal(n, 4);
    return json({ results: [
      { id: "q1", relation: "conflicts", target: "m1", reason: "说法相反" },
      { id: "q2", relation: "unrelated", target: null, reason: "" },
      { id: "q3", relation: "unsure", target: null, reason: "" },
      { id: "q4", relation: "duplicate", target: "m9", reason: "编号越界" },
    ] });
  });
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual([r.relate.conflicts, r.relate.unrelated, r.relate.unsure, r.relate.errors], [1, 1, 1, 1]);
  const P = e.store.project().props;
  assert.deepEqual([P.get(ok)!.state, P.get(ok)!.confirmed, P.get(ok)!.pending_corrections], ["active", true, [c1]]);
  assert.deepEqual([P.get(c1)!.unreconciled, P.get(c1)!.conflicts_with, P.get(c1)!.supersedes, P.get(c1)!.confirmed], [false, ok, undefined, false]);
  assert.equal(P.get(c2)!.unreconciled, false);
  assert.deepEqual([P.get(c3)!.unreconciled, P.get(c3)!.related?.outcome], [true, "unsure"]);
  assert.deepEqual([P.get(c4)!.unreconciled, P.get(c4)!.related], [true, null], "校验不过：不写 L1，下次再判");
});

test("关系判定的冲突只标记：本条之后被转正（如被并入后印证）也不替代对方", async () => {
  const e = env();
  const ok = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令直接写 ab，靠 PATH 找到它", confirmed: true, source: src0(null) });
  const c1 = auto(e, "s1", "hook 命令直接写 ab，不靠 PATH 找到它", "q1");
  const chat = fakeChat(() => json({ candidates: [] }), relateReply([{ id: "q1", relation: "conflicts", target: "m1", reason: "相反" }]));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  e.store.lifecycle("confirm", c1, null, { by: "code" });
  const P = e.store.project().props;
  assert.deepEqual([P.get(ok)!.state, P.get(ok)!.pending_corrections], ["active", [c1]], "对方仍有效，只标冲突");
  assert.deepEqual([P.get(c1)!.conflicts_with, P.get(c1)!.supersedes], [ok, undefined]);

});

test("待确认的纠正不走印证转正；即便被非用户途径转正也不替代旧条目", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "e2e 由用户自己跑，agent 不跑", confirmed: false, origin: "extract", source: src0(null) });
  const corr = auto(e, "s1", "e2e 由 agent 自己跑，做成一条命令", "以后 e2e 你自己跑", { supersedes: old });
  auto(e, "s2", "e2e 由 agent 自己跑，做成一条命令吧", "e2e 都由你来跑");
  // 只把 s2 那条判为 corr 的重复，其余判无关
  const chat = fakeChat(() => json({ candidates: [] }), (msgs) => {
    const qs = msgs[1].content!.split("## ").slice(1);
    return json({ results: qs.map((q) => {
      const id = q.split("\n")[0];
      if (!/N: .*命令吧/.test(q)) return { id, relation: "unrelated", target: null, reason: "" };
      const m = /^(m\d+): .*做成一条命令$/m.exec(q)!;
      return { id, relation: "duplicate", target: m[1], reason: "同一件事" };
    }) });
  });
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.deepEqual([r.relate.duplicate, r.relate.corroborated], [1, 0], "两个会话两句不同原话，但目标是待确认纠正，不转正");
  e.store.lifecycle("confirm", corr, null, { by: "corroboration", sessions: ["a", "b"] });
  let P = e.store.project().props;
  assert.deepEqual([P.get(old)!.state, P.get(old)!.pending_corrections], ["active", [corr]]);
  e.store.lifecycle("confirm", corr, null, {});
  P = e.store.project().props;
  assert.equal(P.get(old)!.state, "superseded", "用户确认后纠正才生效");
});

test("--redo 不因换了措辞而多出条目：同会话新抽出的近重复由关系判定并入", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]), true);
  let text = "hook 命令写 node 绝对路径，不依赖 PATH";
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, text }] }), relateReply([{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }]));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  text = "hook 命令写 node 绝对路径，别依赖 PATH";
  await runWork(e.deps(chat), { session: { host: "claude", session_id: "s1" }, sweep: false, dryRun: false, redo: true });
  const active = props(e.store).filter((p) => p.state === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0].text, "hook 命令写 node 绝对路径，不依赖 PATH");
  assert.equal(active[0].confirmed, false);
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

test("扫描兜底：只补登记 cwd 在已登记项目里的近期会话；装 hook 前开始的记为 backfill，不报漏登记", () => {
  const e = env();
  const home = join(base, "scanhome");
  mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
  const line = (cwd: string, ts: string) => JSON.stringify({ type: "user", uuid: "u", cwd, timestamp: ts, message: { content: "hi" } }) + "\n";
  writeFileSync(join(home, ".claude/projects/p/in.jsonl"), line(e.repo, "2026-10-01T00:00:00Z"));
  writeFileSync(join(home, ".claude/projects/p/out.jsonl"), line("/tmp", "2026-10-01T00:00:00Z"));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 1);
    assert.equal(scan(e.deps(null)), 0);
    let st = intake.stats(e.store.workDb, new Date()).sessions;
    assert.deepEqual([st.scanned, st.backfill], [0, 1], "还没有任何 hook 登记：全是历史会话");
    // hook 第一次登记之后开始、却只能靠扫描登记的会话才算疑似漏登记
    intake.upsertSession(e.store.workDb, { host: "codex", session_id: "h1", transcript: null, cwd: e.repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date("2026-10-05T00:00:00Z"));
    writeFileSync(join(home, ".claude/projects/p/early.jsonl"), line(e.repo, "2026-10-04T00:00:00Z"));
    writeFileSync(join(home, ".claude/projects/p/late.jsonl"), line(e.repo, "2026-10-06T00:00:00Z"));
    assert.equal(scan(e.deps(null)), 2);
    st = intake.stats(e.store.workDb, new Date()).sessions;
    assert.deepEqual([st.scanned, st.backfill, st.scannedByHost], [1, 2, { claude: 1 }]);
    // hook 后来碰到了这个会话：说明 hook 对它生效，不再算漏登记
    intake.upsertSession(e.store.workDb, { host: "claude", session_id: "late", transcript: null, cwd: e.repo, ended: false, ephemeral: false, via: "hook" }, () => "alpha", new Date());
    assert.equal(intake.stats(e.store.workDb, new Date()).sessions.scanned, 0);
  } finally {
    process.env.HOME = old;
  }
  assert.deepEqual(intake.sessions(e.store.workDb).map((s) => [s.session_id, s.project, s.via]).sort(), [
    ["early", "alpha", "backfill"], ["h1", "alpha", "hook"], ["in", "alpha", "backfill"], ["late", "alpha", "hook"], ["out", null, "backfill"],
  ]);
});

test("旧数据里的 scan 记录：开始早于第一次 hook 登记的改记 backfill（只降级）", () => {
  const e = env();
  const db = e.store.workDb;
  const reg = (id: string, via: "hook" | "scan", at: string) =>
    intake.upsertSession(db, { host: "pi", session_id: id, transcript: `/x/${id}.jsonl`, cwd: e.repo, ended: false, ephemeral: false, via }, () => "alpha", new Date(at));
  reg("old", "scan", "2026-10-12T03:58:00Z");
  reg("new", "scan", "2026-10-12T03:58:00Z");
  reg("hk", "hook", "2026-10-12T03:44:00Z");
  const starts: Record<string, number> = { "/x/old.jsonl": Date.parse("2026-10-10T00:00:00Z"), "/x/new.jsonl": Date.parse("2026-10-12T03:50:00Z") };
  assert.equal(intake.reclassifyScanned(db, (t) => starts[t] ?? null), 1);
  assert.deepEqual(intake.sessions(db).map((s) => [s.session_id, s.via]).sort(), [["hk", "hook"], ["new", "scan"], ["old", "backfill"]]);
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

test("到期不再自动归档：sweep 后未确认提议仍 active，只进到期复审清单（§21 2026-10-14）", async () => {
  const e = env();
  const id = unconfirmed(e, "很久以前的坑");
  const later = new Date(Date.now() + 91 * 86_400_000);
  await runWork(e.deps(verifierChat({ verdict: "not_verifiable" }), { now: () => later }), { sweep: true, dryRun: false });
  const p = e.store.project().props.get(id)!;
  assert.deepEqual([p.state, p.expired], ["active", false]);
  assert.deepEqual(reviewList(e.store.project().props.values(), e.store.usage(), later).map((d) => d.prop.id), [id]);
});

test("用前核对排队：已转正的条目代码变了 → 下次 ab work 优先重新核验；出错留在队里重试，有结论后出队", async () => {
  const e = env();
  const id = unconfirmed(e, "向量门槛 VEC_MIN_SIM 是 0.45");
  await runWork(e.deps(verifierChat({ verdict: "verified", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] })), { sweep: true, dryRun: false });
  assert.equal(e.store.project().props.get(id)!.confirmed_by, "code");
  writeFileSync(join(e.repo, "store.ts"), "export const VEC_MIN_SIM = 0.5;\n");
  execFileSync("git", ["-C", e.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "bump"]);
  e.store.queueReverify([id], new Date());
  const queued = () => e.store.workDb.prepare("SELECT count(*) AS n FROM verify_queue").get()!.n;
  const boom = fakeChat(() => { throw new Error("429"); });
  const r1 = await runWork(e.deps(boom), { sweep: true, dryRun: false });
  assert.equal(r1.verify.errors, 1);
  assert.equal(queued(), 1, "出错不出队");
  const r2 = await runWork(e.deps(verifierChat({ verdict: "contradicted", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.5" }] })), { sweep: true, dryRun: false });
  assert.equal(r2.verify.contradicted, 1);
  assert.equal(queued(), 0);
  assert.ok(e.store.project().props.get(id)!.stale, "标与代码不符");
});

// ---------- v3 第 1 阶段：候选区 ----------

test("候选区（默认）：自动抽取写成候选，不进召回/搜索；重复不给正式条目追加来源；价值标记只记录不丢弃", async () => {
  const e = env();
  const existing = e.store.remember(e.pid, "s0", false, { kind: "rule", text: "hook 命令写 node 绝对路径，不依赖 PATH", confirmed: false, origin: "extract", basis: "user_directive", evidence: [{ anchor: "u0", role: "user", quote_sha256: "h0" }], source: { host: "claude", session_id: "s0", transcript: null, anchor: null, summary: "x" } });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH"), asst("a1", "好的")]));
  const chat = fakeChat(() => json({ candidates: [
    { ...RULE, scenario: "当配置宿主 hook 命令时", durability: "phase", findable: false, guidance: true },
    { ...RULE, text: "另一条重复的", relation: { type: "duplicate", target: "m1" } },
  ] }));
  await runWork(e.deps(chat, { staging: true }), { sweep: false, dryRun: false });
  const all = props(e.store);
  const cands = all.filter((p) => p.state === "candidate");
  assert.equal(cands.length, 2, "重复也进候选区");
  assert.ok(cands.every((p) => p.candidate && !p.confirmed));
  const first = cands.find((p) => p.text === RULE.text)!;
  assert.deepEqual(first.value?.flags, ["phase"]);
  assert.equal(first.value?.scenario, "当配置宿主 hook 命令时");
  assert.equal(first.guidance, true);
  assert.deepEqual(e.store.project().props.get(existing)!.extra_sources, [], "正式条目没被追加来源");
  // 归档再恢复回到候选区；用户确认则进正式库
  e.store.lifecycle("archive", first.id, null);
  e.store.lifecycle("reactivate", first.id, null);
  assert.equal(e.store.project().props.get(first.id)!.state, "candidate");
  e.store.lifecycle("confirm", first.id, null);
  assert.equal(e.store.project().props.get(first.id)!.state, "active");
});

test("候选区不外泄：候选不进每轮召回、常驻偏好、brief、全文/向量检索；带 supersedes 的候选不给正式条目挂待确认纠正", async () => {
  const { recall, guidanceBlock } = await import("./recall.ts");
  const { active } = await import("./present.ts");
  const e = env();
  const old = e.store.remember(e.pid, "s0", false, { kind: "rule", text: "hook 命令 lockfile 旧规则", confirmed: true, source: { host: "claude", session_id: "s0", transcript: null, anchor: null, summary: "x" } });
  const cand = e.store.remember(null, "s1", false, { kind: "rule", text: "hook 命令 lockfile 候选规则", confirmed: false, candidate: true, guidance: true, supersedes: old, source: { host: "claude", session_id: "s1", transcript: null, anchor: null, summary: "x" } });
  const props = e.store.project().props;
  assert.equal(props.get(cand)!.state, "candidate");
  assert.deepEqual(props.get(old)!.pending_corrections, []);
  const out = await recall(e.store, "hook 命令 lockfile", e.repo, () => null, [], [], () => ({ name: "alpha", path: e.repo }));
  assert.ok(!out.includes(cand.slice(0, 8)), out);
  assert.equal(guidanceBlock(props.values(), false).includes(cand.slice(0, 8)), false);
  assert.ok(!active(e.store).some((p) => p.id === cand), "brief 读的 active() 不含候选");
  const { hits } = await e.store.searchHybrid("lockfile", { projects: [e.pid], includeGlobal: true, limit: 10 }, null);
  assert.ok(!hits.some((h) => h.id === cand));
});

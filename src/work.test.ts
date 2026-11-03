/**
 * 切片 3 流水线（函数级）：假模型、假 embedding 都是确定性的，不发网络请求。
 * 运行：node --test src/work.test.ts
 */
import { test } from "node:test";
import { reviewList } from "./expiry.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { Store, type Embedder } from "./store.ts";
import { WorkFailure, type Chat, type ChatMessage } from "./llm.ts";
import { admit, BACKLOG_WINDOWS_PER_SWEEP, chunk, runWork, scan, type WorkDeps } from "./work.ts";
import { allowedTranscript } from "./transcript-file.ts";
import { expandSource } from "./source.ts";
import * as intake from "./intake.ts";
import { sha256, validate } from "./extract.ts";
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
  dir: string;
  registryDir: string;
  deps: (chat: Chat | null, extra?: Partial<WorkDeps>) => WorkDeps;
  transcript: (sid: string, lines: object[], idle?: boolean) => string;
  codexTranscript: (sid: string, lines: object[], idle?: boolean) => string;  register: (sid: string, file: string, ended?: boolean) => void;
  pid: string;
}

function env(): Env {
  const dir = join(base, `e${n++}`);
  process.env.HOME = dir; // 夹具：transcript 都在这个 fake home 的宿主会话目录下，准入检查（§7.6 每次读都查）才能过
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
    dir,
    repo,
    registryDir: regDir,
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
      const d = join(dir, ".claude/projects/fixture");
      mkdirSync(d, { recursive: true });
      const p = join(d, `${sid}.jsonl`);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      if (idle) utimesSync(p, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
      return p;
    },
    codexTranscript: (sid, lines, idle = true) => {
      const d = join(dir, ".codex/sessions/fixture");
      mkdirSync(d, { recursive: true });
      const p = join(d, `rollout-2026-10-08T10-45-49-${sid}.jsonl`);
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
const userTs = (uuid: string, text: string, timestamp: string) => ({ type: "user", uuid, timestamp, message: { role: "user", content: text } });
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
  assert.deepEqual(p.evidence, [{ anchor: "u1", role: "user", quote_sha256: sha256("以后 hook 命令都写 node 绝对路径"), quote: "以后 hook 命令都写 node 绝对路径" }]);
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
    // 正文向量含 why（§8.11.3）：不相干的候选要用自己的背景，不能共用一条 why
    { ...RULE, text: "提交信息用中文写", why: "仓库历史讨论都是中文，读 git log 的人不熟悉英文缩写", evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令" }] },
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

test("§8.11.3 关系链：候选归属别的项目时，近邻去重与关系判定都在最终项目 + 全局里做，跨项目重复按新条目处理", async () => {
  const e = env();
  const otherRepo = join(base, `other${n}`, "piops");
  mkdirSync(otherRepo, { recursive: true });
  writeFileSync(join(otherRepo, "AGENTS.md"), "pi-ops 仓库。\n");
  execFileSync("git", ["-C", otherRepo, "init", "-q"]);
  execFileSync("git", ["-C", otherRepo, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  execFileSync("git", ["-C", otherRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  writeFileSync(join(e.registryDir, "pi-ops.md"), "- 路径：`x`\n");
  const piopsId = e.store.ensureProject("pi-ops");
  const reg = [{ name: "alpha", path: e.repo }, { name: "pi-ops", path: otherRepo }];
  // alpha 已有一条同标题条目：候选被归到 pi-ops，就不能当成 alpha 条目的重复
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "final 阶段只显示不拦合并", confirmed: true, source: src0(null) });
  const ts = "2026-10-30T10:00:00Z";
  const f = e.transcript("s1", [
    userTs("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH", ts),
    asst("a1", "pi-ops 的 final 阶段建议只显示不拦合并"),
    userTs("u2", "可以，pi-ops 的 final 就只显示不拦截", ts),
  ]);
  e.register("s1", f);
  const DEC = {
    kind: "decision",
    project: "pi-ops",
    project_anchor: "#2",
    text: "final 阶段只显示不拦合并",
    why: "final 拦下过的真实问题太少",
    basis: "user_confirmed",
    evidence: [
      { anchor: "#2", role: "assistant", quote: "final 阶段建议只显示不拦合并" },
      { anchor: "#3", role: "user", quote: "final 就只显示不拦截" },
    ],
    relation: { type: "new", target: null },
  };
  const chat = fakeChat(() => json({ candidates: [DEC] }));
  const r = await runWork(e.deps(chat, { registry: reg, resolveProject: (cwd) => (cwd.startsWith(e.repo) ? { name: "alpha", path: e.repo } : null), projectId: (name) => e.store.ensureProject(name) }), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.equal(r.receipt.proposals, 1, "没被当成 alpha 的重复");
  const prop = props(e.store).find((p) => p.text === DEC.text && p.kind === "decision");
  assert.equal(prop?.project_id, piopsId);
  assert.equal(prop?.value?.session_project, "alpha", "成功跨项目归属记下会话项目，ab get 才能说清");
  // alpha 的同标题条目仍归 alpha：跨项目不并
  const alphaProp = props(e.store).find((p) => p.id === old)!;
  assert.equal(alphaProp.project_id, e.pid);
  assert.equal(alphaProp.state, "active");
});

test("§8.11.3 关系链：duplicate 追加的证据带 quote 与 said_at，跨会话印证只在同项目内发生", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: "hook 命令写 node 绝对路径，不依赖 PATH", confirmed: true, source: src0(null) });
  // s2 里的用户话与 alpha 同项目，先走一次 admit 的 duplicate
  e.register("s2", e.transcript("s2", [
    userTs("u1", "以后 hook 命令都写 node 绝对路径", "2026-10-30T09:00:00Z"),
  ]));
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, relation: { type: "duplicate", target: "m1" } }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.attached, 1);
  const after = props(e.store).find((p) => p.id === old)!;
  assert.equal(after.extra_sources.length, 1);
  const ev = after.extra_sources[0].evidence[0];
  assert.equal(ev.quote, "以后 hook 命令都写 node 绝对路径");
  assert.equal(ev.quote_sha256, sha256("以后 hook 命令都写 node 绝对路径"));
  assert.equal(ev.said_at, "2026-10-30T09:00:00.000Z");
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
  const f = e.codexTranscript("g1", [meta({ subagent: { other: "guardian" } }), msg]);
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: "g1", transcript: f, cwd: e.repo, ended: true, ephemeral: false, via: "scan" }, () => "alpha", new Date());
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 0);
  assert.equal(r.windows.skipped, 1);
  assert.equal(intake.sessions(e.store.workDb)[0].ephemeral, 1);
  assert.equal(intake.stats(e.store.workDb, new Date()).sessions.scanned, 0);

  // 下面 scan 要换 HOME；跑完恢复到夹具的 fake home（环境是进程级的，不回退会污染后续用例）
  const home = join(base, "subhome");
  const id = "01a11967-19b1-7063-8631-c3dfad45ef88";
  mkdirSync(join(home, ".codex/sessions/2026/10/08"), { recursive: true });
  writeFileSync(join(home, `.codex/sessions/2026/10/08/rollout-2026-10-08T10-45-49-${id}.jsonl`), JSON.stringify(meta({ subagent: { thread_spawn: { depth: 1 } } })) + "\n");
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 0);
    assert.equal(intake.knownSession(e.store.workDb, "codex", id), false);
  } finally {
    process.env.HOME = e.dir;
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

/** Codex 压缩会话（§7.6）：同一会话的 `.jsonl` 被压成 `.jsonl.zst`，原文件消失，agentbrain 读时解析。 */
function zstHome(sid: string) {
  const e = env();
  const home = join(base, `zsthome-${n++}`);
  const dir = join(home, ".codex/sessions/2026/10/12");
  mkdirSync(dir, { recursive: true });
  const id = sid;
  const lines = [
    { type: "session_meta", payload: { cwd: e.repo, source: "vscode" } },
    { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "以后 hook 命令都写 node 绝对路径" }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n";
  const zstPath = join(dir, `rollout-2026-10-12T10-00-00-${id}.jsonl.zst`);
  writeFileSync(zstPath, zstdCompressSync(Buffer.from(lines, "utf8")));
  return { e, home, dir, id, zstPath, lines };
}

test("§7.6 Codex 压缩会话：登记时 transcript 没落盘，处理时找到 .jsonl.zst 并抽取", async () => {
  const { e, home, id } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7c7");
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: null, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 1);
    assert.ok(intake.sessions(e.store.workDb)[0].transcript!.endsWith(".jsonl.zst"));
    assert.equal(props(e.store).length, 1);
  } finally {
    process.env.HOME = old;
  }
});

test("§7.6 压缩会话：截断的 .jsonl.zst 读取失败，记 source_unavailable、不调模型、进度不动", async () => {
  const { e, home, id, zstPath } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7c8");
  const c = readFileSync(zstPath);
  writeFileSync(zstPath, c.subarray(0, c.length - 1)); // Node 解压静默返回部分数据，不报错
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: zstPath, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 0, "坏文件不算完成");
    assert.equal(chat.calls.length, 0, "坏文件内容不能送进模型");
    const row = intake.sessions(e.store.workDb)[0];
    assert.equal(row.error_code, "source_unavailable");
    assert.equal(row.processed_anchor, null, "进度不动");
    assert.equal(props(e.store).length, 0);
  } finally {
    process.env.HOME = old;
  }
});

test("§7.6 压缩会话：登记后文件被换成目录外符号链接，内容不送模型、进度不动", async () => {
  const { e, home, id, zstPath, lines } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7c9");
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: zstPath, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const outside = join(e.dir, "outside.jsonl.zst");
  writeFileSync(outside, zstdCompressSync(Buffer.from(lines, "utf8")));
  rmSync(zstPath);
  symlinkSync(outside, zstPath);
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 0);
    assert.equal(chat.calls.length, 0, "符号链接指向的内容不能送进模型");
    const row = intake.sessions(e.store.workDb)[0];
    assert.equal(row.error_code, "source_unavailable");
    assert.equal(row.processed_anchor, null, "进度不动");
  } finally {
    process.env.HOME = old;
  }
});

test("§7.6 压缩会话：恢复成 .jsonl 后不丢进度、不重复抽", async () => {
  const { e, home, id, zstPath, lines } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7ca");
  // 第一步：压缩文件抽取一个窗口，处理完
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: zstPath, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 1);
    assert.equal(props(e.store).length, 1);
    // 恢复：Codex resume 解压回 .jsonl 并删掉 .zst
    const plain = zstPath.replace(/\.zst$/, "");
    writeFileSync(plain, lines);
    rmSync(zstPath);
    const chat2 = fakeChat(() => json({ candidates: [RULE] }));
    const r2 = await runWork(e.deps(chat2), { sweep: false, dryRun: false });
    assert.equal(r2.windows.done, 0, "窗口已处理过，不重抽");
    assert.equal(chat2.calls.length, 0);
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

test("admit：关系未判定的目标收到另一会话的重复用户引文，不生成 confirm", async () => {
  const e = env();
  const target = auto(e, "s1", RULE.text, "以后 hook 命令都写 node 绝对路径", { unreconciled: true });
  const quote = "hook 里一律用 node 的绝对路径";
  e.register("s2", e.transcript("s2", [user("u1", `记住：${quote}`)]));
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, evidence: [{ anchor: "#1", role: "user", quote }], relation: { type: "duplicate", target: "m1" } }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.receipt.attached, 1, "新窗口确实判重复并追加另一会话的证据");
  assert.deepEqual(e.store.project().props.get(target)!.extra_sources.map((s) => s.session_id), ["s2"]);
  assert.equal(e.store.workDb.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='confirm' AND target_id=?").get(target)!.n, 0);
  assert.equal(r.receipt.corroborated, 0);
  assert.equal(e.store.project().props.get(target)!.confirmed, false);
});

test("印证转正：admit 与关系判定对同一目标状态生成相同的 confirm 事件", async () => {
  for (const unreconciled of [false, true]) {
    const e = env();
    const target = auto(e, "s1", RULE.text, "以后 hook 命令都写 node 绝对路径", { unreconciled });
    const quote = "hook 里一律用 node 的绝对路径";
    const text = "hook 命令写 node 绝对路径，别依赖 PATH";
    e.register("s2", e.transcript("s2", [user("u1", quote)]));
    const checked = validate({ candidates: [{ ...RULE, text, evidence: [{ anchor: "#1", role: "user", quote }], relation: { type: "duplicate", target: "m1" } }] }, {
      turns: [{ anchor: "u1", role: "user", text: quote }], context: [],
    }, [e.store.project().props.get(target)!], "window", { name: "alpha", docs: "", registry: "", confirmed: "", projects: "- alpha" });
    assert.equal(checked.candidates.length, 1);
    const admission = admit(checked.candidates.map((c) => ({ ...c, unreconciled: false })), intake.sessions(e.store.workDb)[0], e.pid, "window", e.store.project().props, "fake-llm");
    // 同一份新证据改走关系判定入口，admit 的结果不提交。
    auto(e, "s2", text, quote);
    const chat = fakeChat(() => json({ candidates: [] }), relateReply([{ id: "q1", relation: "duplicate", target: "m1", reason: "同一件事" }]));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.relate.duplicate, 1);
    const confirms = e.store.workDb.prepare("SELECT body FROM events WHERE kind='confirm' AND target_id=?").all(target).map((row) => JSON.parse(String(row.body)));
    assert.deepEqual(admission.appends.filter((a) => a.kind === "confirm").map((a) => a.body), confirms, `unreconciled=${unreconciled}`);
    assert.deepEqual(confirms, unreconciled ? [] : [{ by: "corroboration", sessions: ["claude:s1", "claude:s2"] }]);
  }
});

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

test("扫描兜底：坏 .zst 不影响同目录其他会话，也不崩溃（§7.6 round1 修复）", () => {
  const e = env();
  const home = join(base, "badhome");
  mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
  mkdirSync(join(home, ".codex/sessions/2026/10/08"), { recursive: true });
  const line = (cwd: string, ts: string) => JSON.stringify({ type: "user", uuid: "u", cwd, timestamp: ts, message: { content: "hi" } }) + "\n";
  writeFileSync(join(home, ".codex/sessions/2026/10/08/rollout-bad-01a11967-19b1-7063-8631-c3dfad45ef93.jsonl.zst"), "not zstd");
  writeFileSync(join(home, ".claude/projects/p/good.jsonl"), line(e.repo, "2026-10-01T00:00:00Z"));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 1, "坏文件跳过，好文件照常登记");
    assert.deepEqual(intake.sessions(e.store.workDb).map((s) => s.session_id), ["good"]);
  } finally {
    process.env.HOME = old;
  }
});

test("扫描兜底：Pi 会话被补登记（round1 修复：piSessionId 传原路径）", () => {
  const e = env();
  const home = join(base, "pihome");
  mkdirSync(join(home, ".pi/agent/sessions"), { recursive: true });
  const line = (cwd: string, ts: string) => JSON.stringify({ type: "message", id: "e1", parentId: null, cwd, timestamp: ts, message: { role: "user", content: "hi" } }) + "\n";
  writeFileSync(join(home, ".pi/agent/sessions/2026-10-06T00-00-00-000Z_01a11967-19b1-7063-8631-c3dfad45ef99.jsonl"), line(e.repo, "2026-10-06T00:00:00Z"));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(scan(e.deps(null)), 1, "Pi 会话被登记");
    assert.deepEqual(intake.sessions(e.store.workDb).map((s) => [s.host, s.session_id]), [["pi", "01a11967-19b1-7063-8631-c3dfad45ef99"]]);
  } finally {
    process.env.HOME = old;
  }
});

test("扫描兜底：Claude 与 Pi 的 .zst 不进扫描，Codex 的进", () => {
  const e = env();
  const home = join(base, "zstwalkhome");
  mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
  mkdirSync(join(home, ".pi/agent/sessions"), { recursive: true });
  mkdirSync(join(home, ".codex/sessions/2026/10/08"), { recursive: true });
  const line = (cwd: string, ts: string) => JSON.stringify({ type: "message", id: "e1", parentId: null, cwd, timestamp: ts, message: { role: "user", content: "hi" } }) + "\n";
  // Claude 和 Pi 的 .zst（walk 只对 codex 收 .zst，这两个应该被无视）
  writeFileSync(join(home, ".claude/projects/p/c.jsonl.zst"), zstdCompressSync(Buffer.from(line(e.repo, "2026-10-06T00:00:00Z"), "utf8")));
  writeFileSync(join(home, ".pi/agent/sessions/2026-10-06T00-00-00-000Z_01a11967-19b1-7063-8631-c3dfad45ef98.jsonl.zst"), zstdCompressSync(Buffer.from(line(e.repo, "2026-10-06T00:00:00Z"), "utf8")));
  // Codex 的 .zst 应该被扫描
  const codexId = "01a11967-19b1-7063-8631-c3dfad45ef97";
  const codexLine = JSON.stringify({ type: "session_meta", payload: { cwd: e.repo, source: "vscode" } }) + "\n" + JSON.stringify({ ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }) + "\n";
  writeFileSync(join(home, `.codex/sessions/2026/10/08/rollout-2026-10-08T10-45-49-${codexId}.jsonl.zst`), zstdCompressSync(Buffer.from(codexLine, "utf8")));
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    scan(e.deps(null));
    assert.deepEqual(intake.sessions(e.store.workDb).map((s) => [s.host, s.session_id]), [["codex", codexId]]);
  } finally {
    process.env.HOME = old;
  }
});

test("sweep：未登记的坏 .zst 不阻断 sweep，其他会话照常抽取（round1 修复）", async () => {
  const e = env();
  // 一个未登记的坏 .zst（scan 会遇到它），一个好会话已登记
  const badZst = join(e.dir, ".codex/sessions/2026/10/08/rollout-2026-10-08T10-45-49-01a11967-19b1-7063-8631-c3dfad45ef94.jsonl.zst");
  mkdirSync(join(e.dir, ".codex/sessions/2026/10/08"), { recursive: true });
  writeFileSync(badZst, "not zstd");
  const good = e.codexTranscript("01a11967-19b1-7063-8631-c3dfad45ef95", [
    { type: "session_meta", payload: { cwd: e.repo, source: "vscode" } },
    { ordinal: 1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "以后 hook 命令都写 node 绝对路径" }] } },
  ]);
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: "01a11967-19b1-7063-8631-c3dfad45ef95", transcript: good, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(r.windows.done, 1, "好会话照常抽取，坏文件不阻断");
  assert.equal(chat.calls.length, 1);
  assert.equal(intake.knownSession(e.store.workDb, "codex", "01a11967-19b1-7063-8631-c3dfad45ef94"), false, "坏文件没被登记");
});

test("processSession：dry-run 不写库（transcript 没落盘时不补登记）", async () => {
  const e = env();
  const { home, id } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7cc");
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: null, cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = await runWork(e.deps(null), { sweep: false, dryRun: true });
    assert.equal(r.dry.length, 1);
    assert.equal(intake.sessions(e.store.workDb)[0].transcript, null, "dry-run 不写库");
  } finally {
    process.env.HOME = old;
  }
});

test("processSession：不改写库里的 transcript 路径（§7.6 第 1 条）", async () => {
  const { e, home, id, zstPath } = zstHome("01a332dc-4d5f-7d62-840d-69f94d09f7cb");
  // 库里的路径是 .jsonl（压缩前登记的），实际文件只剩 .zst
  intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: zstPath.slice(0, -4), cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const chat = fakeChat(() => json({ candidates: [RULE] }));
    const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
    assert.equal(r.windows.done, 1);
    assert.equal(intake.sessions(e.store.workDb)[0].transcript, zstPath.slice(0, -4), "capture_sessions.transcript 保持原路径");
    const p = props(e.store)[0];
    assert.equal(p.source.transcript, zstPath.slice(0, -4), "L1 来源保留登记路径");
    assert.match(expandSource(p.source)!, /以后 hook 命令都写 node 绝对路径/);
  } finally {
    process.env.HOME = old;
  }
});

test("processSession：缺失文件记 source_unavailable，dry-run 不改任何工作表", async () => {
  const e = env();
  const missing = join(e.dir, ".claude/projects/fixture/missing.jsonl");
  e.register("missing", missing, true);
  const before = e.store.workDb.prepare("SELECT * FROM capture_sessions").all();
  const changes = e.store.workDb.prepare("SELECT total_changes() AS n").get()!.n;
  const chat = fakeChat(() => json({ candidates: [] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: true });
  assert.deepEqual(e.store.workDb.prepare("SELECT * FROM capture_sessions").all(), before);
  assert.equal(e.store.workDb.prepare("SELECT total_changes() AS n").get()!.n, changes);
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  const s = intake.sessions(e.store.workDb)[0];
  assert.equal(s.error_code, "source_unavailable");
  assert.equal(s.processed_anchor, null);
  assert.equal(chat.calls.length, 0);
});

test("CLI sweep：坏 Codex 压缩文件不阻断其他会话的补登记", () => {
  const e = env();
  const dirs = [join(e.dir, ".codex/sessions/2026/10/08"), join(e.dir, ".claude/projects/fixture")];
  for (const d of dirs) mkdirSync(d, { recursive: true });
  writeFileSync(join(dirs[0], "rollout-bad-01a11967-19b1-7063-8631-c3dfad45ef92.jsonl.zst"), "not zstd");
  const good = join(dirs[1], "good.jsonl");
  writeFileSync(good, JSON.stringify({ type: "user", uuid: "u1", cwd: e.repo, message: { content: "以后测试必须检查真实数据库变化" } }) + "\n");
  writeFileSync(join(e.registryDir, "alpha.md"), `- 路径：\`${e.repo}\`\n`);
  const abHome = join(e.dir, "cli-store");
  const out = execFileSync(process.execPath, [join(import.meta.dirname, "cli.ts"), "work", "--sweep"], {
    cwd: e.repo, encoding: "utf8", env: { ...process.env, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: e.registryDir, HOME: e.dir, AGENTBRAIN_REVIEWER: "1" },
  });
  assert.ok(out.length > 0);
  const cliStore = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    assert.ok(intake.knownSession(cliStore.workDb, "claude", "good"));
    assert.equal(intake.knownSession(cliStore.workDb, "codex", "01a11967-19b1-7063-8631-c3dfad45ef92"), false);
  } finally {
    cliStore.close();
  }
});

for (const mode of ["普通", "话题"] as const) {
  for (const scenario of ["无新内容", "定位点缺失", "dry-run", "其他错误码"] as const) {
    test(`压缩会话恢复（${mode}）：${scenario}`, async () => {
      const { e, home, id, zstPath } = zstHome(`recovery-${mode}-${scenario}`);
      const oldHome = process.env.HOME;
      process.env.HOME = home;
      try {
        intake.upsertSession(e.store.workDb, { host: "codex", session_id: id, transcript: zstPath.slice(0, -4), cwd: e.repo, ended: true, ephemeral: false, via: "hook" }, () => "alpha", new Date());
        const anchor = scenario === "定位点缺失" ? "missing" : "1";
        const error = scenario === "其他错误码" ? "unregistered_project" : "source_unavailable";
        e.store.workDb.prepare("UPDATE capture_sessions SET processed_anchor=?, error_code=? WHERE host=? AND session_id=?").run(anchor, error, "codex", id);
        const chat = fakeChat(() => json({ candidates: [] }));
        const extra: Partial<WorkDeps> = mode === "话题" ? { topic: { run: "recovery-fixture", chatFor: () => ({ chat, model: "fixture-model" }) } } : {};
        const before = intake.sessions(e.store.workDb)[0];
        const report = await runWork(e.deps(chat, extra), { sweep: false, dryRun: scenario === "dry-run" });
        const after = intake.sessions(e.store.workDb)[0];
        assert.equal(report.windows.done, 0);
        assert.equal(chat.calls.length, 0);
        assert.equal(after.processed_anchor, anchor);
        assert.equal(after.error_code, scenario === "无新内容" ? null : error);
        if (scenario === "dry-run") assert.deepEqual(after, before);
      } finally {
        e.store.close();
        process.env.HOME = oldHome;
      }
    });
  }
}

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



// ---------- 额度用完（429 / AccountQuotaExceeded）：延后、之后自动接着做，不丢、不卡 ----------

const windowRow = (e: Env) => ({ ...e.store.workDb.prepare("SELECT state,error_code FROM capture_windows").get() });

test("抽取模型额度用完：窗口一直延后、不算失败；额度恢复后接着抽完，内容不丢", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH"), asst("a1", "好的")]), true);
  let t = Date.now();
  const quota = fakeChat(() => {
    throw new WorkFailure("http_429", "模型接口限流 429: AccountQuotaExceeded", 3_600_000);
  });
  for (let i = 0; i < intake.MAX_ATTEMPTS + 3; i++) {
    await runWork(e.deps(quota, { now: () => new Date(t) }), { sweep: false, dryRun: false });
    t += 2 * 3_600_000;
  }
  assert.deepEqual(windowRow(e), { state: "deferred", error_code: "http_429" });
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, null, "进度没往前跳");
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] })), { now: () => new Date(t) }), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.equal(props(e.store).filter((p) => p.text === RULE.text).length, 1);
});

test("embedding 额度用完：窗口按限流延后、不算失败；恢复后接着做", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]), true);
  const quota: Embedder = Object.assign(async () => {
    throw new Error('embedding HTTP 429: {"code":"AccountQuotaExceeded"}');
  }, { model: "fake-embed" });
  let t = Date.now();
  for (let i = 0; i < intake.MAX_ATTEMPTS + 3; i++) {
    await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] })), { embedder: quota, now: () => new Date(t) }), { sweep: false, dryRun: false });
    t += 3 * 3_600_000;
  }
  assert.deepEqual(windowRow(e), { state: "deferred", error_code: "http_429" });
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] })), { now: () => new Date(t) }), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
});

test("embedding 额度用完时写下的条目：没有向量，之后一次同步补上", async () => {
  const e = env();
  const id = unconfirmed(e, "额度用完时记下的坑");
  const quota: Embedder = Object.assign(async () => {
    throw new Error("embedding HTTP 429");
  }, { model: "fake-embed" });
  await assert.rejects(e.store.syncVectors(quota, "fake-embed"));
  const has = () => !!(e.store as any).fts.prepare("SELECT 1 AS x FROM vecs WHERE id=?").get(id);
  assert.equal(has(), false);
  await e.store.syncVectors(fakeEmbed, "fake-embed");
  assert.equal(has(), true);
});

test("核验模型额度用完：本轮停下不再逐条撞 429；下次运行（同一 HEAD、不到 24 小时）照样重试并转正", async () => {
  const e = env();
  const a = unconfirmed(e, "向量门槛 VEC_MIN_SIM 是 0.45");
  unconfirmed(e, "另一个坑 VEC_MIN_SIM 用在召回");
  let calls = 0;
  const quota = fakeChat((_m, opts) => {
    if (!opts?.tools) return json({ candidates: [] });
    calls++;
    throw new WorkFailure("http_429", "限流 AccountQuotaExceeded", 3_600_000);
  });
  const r1 = await runWork(e.deps(quota), { sweep: true, dryRun: false });
  assert.equal(calls, 1, "撞上额度就停，不给后面的条目再发请求");
  assert.equal(r1.verify.errors, 1);
  const later = new Date(Date.now() + 3_600_000);
  const ok = verifierChat({ verdict: "verified", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "VEC_MIN_SIM = 0.45" }] });
  await runWork(e.deps(ok, { now: () => later }), { sweep: true, dryRun: false });
  assert.equal(e.store.project().props.get(a)!.confirmed_by, "code");
});

test("hook 拉起的单会话 ab work：顺带重试别的会话里已到期的延后窗口", async () => {
  const e = env();
  e.register("old", e.transcript("old", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH")]), true);
  let t = Date.now();
  await runWork(e.deps(fakeChat(() => {
    throw new WorkFailure("http_429", "限流", 60_000);
  }), { now: () => new Date(t) }), { sweep: false, dryRun: false });
  assert.equal(windowRow(e).state, "deferred");
  e.register("new", e.transcript("new", [user("u2", "随便聊聊天气")]), true);
  t += 2 * 3_600_000;
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] })), { now: () => new Date(t) }), { sweep: false, dryRun: false, session: { host: "claude", session_id: "new" } });
  assert.equal(r.windows.done, 2, "新会话一个窗口 + 旧会话到期的延后窗口");
  assert.ok(props(e.store).some((p) => p.text === RULE.text));
});

const sessionRow = (e: Env) => e.store.workDb.prepare("SELECT processed_anchor, error_code FROM capture_sessions").get() as { processed_anchor: string | null; error_code: string | null };

test("升级前进度停在只有 ab-used 的那一轮：续跑不报错，新内容照常抽取", async () => {
  const e = env();
  const f = e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH"), asst("a1", "好的"), asst("a2", "ab-used: hook 绝对路径 (deadbeef)")]);
  e.register("s1", f);
  e.store.workDb.prepare("UPDATE capture_sessions SET processed_anchor='a2'").run();
  writeFileSync(f, readFileSync(f, "utf8") + [user("u2", "再说一件事：日志写到 ~/.agentbrain/logs"), asst("a3", "记住了")].map((x) => JSON.stringify(x)).join("\n") + "\n");
  utimesSync(f, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(sessionRow(e).error_code, null, "进度点没有被剥掉");
  assert.equal(chat.calls.length, 1, "u2 之后的新内容送去抽取");
  assert.equal(sessionRow(e).processed_anchor, "a3");
});

test("ab-used 行不送去抽取", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径，别依赖 PATH"), asst("a1", "好的\nab-used: hook 绝对路径 (deadbeef)")]));
  const chat = fakeChat(() => json({ candidates: [RULE] }));
  await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(chat.calls[0]), /ab-used|deadbeef/);
  assert.match(JSON.stringify(chat.calls[0]), /好的/);
  assert.equal(sessionRow(e).processed_anchor, "a1");
});

// ---------- review 条目 11：note 正文矛盾 → 最终投影标 stale ----------

test("review 条目 11：note 标题对得上、正文里一处断言与代码矛盾 → 最终投影标 stale，不转正", async () => {
  const e = env();
  // 正文写错值 0.35，仓库代码里是 0.45：矛盾来自正文，不来自标题
  const id = unconfirmed(e, "向量门槛 VEC_MIN_SIM 存在", { kind: "note", body: "VEC_MIN_SIM 定义在 store.ts，值是 0.35。" });
  const chat = fakeChat((msgs, opts) => {
    if (!opts?.tools) return json({ candidates: [] });
    assert.match(JSON.stringify(msgs), /值是 0\.35/, "核验请求里带上了正文");
    if (msgs.length === 2) return { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_code", arguments: JSON.stringify({ pattern: "VEC_MIN_SIM" }) } }] };
    // 返回矛盾结论之前确认：请求里既有正文的 0.35，也有工具查回来的代码 0.45
    const sent = JSON.stringify(msgs);
    assert.match(sent, /值是 0\.35/, "正文的 0.35 在请求里");
    assert.match(sent, /VEC_MIN_SIM = 0\.45/, "工具返回的代码 0.45 在请求里");
    return json({ verdict: "contradicted", evidence: [{ path: "store.ts", line_start: 1, line_end: 1, quote: "const VEC_MIN_SIM = 0.45;" }] });
  });
  const r = await runWork(e.deps(chat), { sweep: true, dryRun: false });
  assert.equal(r.verify.contradicted, 1);
  const p = e.store.project().props.get(id)!;
  assert.equal(p.confirmed, false, "矛盾不转正");
  assert.ok(p.stale, "最终投影标 stale，读路径才能显示与代码不符");
  assert.equal(p.stale!.refs.length, 1);
});

// ---------- round4 条目 3：候选键算上否掉的方案 ----------

test("round4 条目 3：同标题、否掉的方案不同的两条候选都入库，两份方案都留下", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  const cand = (option: string) => ({
    kind: "decision",
    text: "hook 执行方式",
    why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
    alternatives: [{ option, rejected_because: "宿主 PATH 很少", evidence: 0 }],
    basis: "user_directive",
    evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 绝对路径" }],
    relation: { type: "new", target: null },
  });
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [cand("靠 PATH 找 ab"), cand("绝对路径写死")] }))), { sweep: false, dryRun: false });
  assert.deepEqual([r.receipt.candidates, r.receipt.merged, r.receipt.proposals], [2, 0, 2], "方案不同是两份内容");
  assert.deepEqual([...e.store.project().props.values()].map((p) => p.alternatives![0].option).sort(), ["side", "靠 PATH 找 ab"].sort().map((x) => (x === "side" ? "绝对路径写死" : x)));
});

// ---------- 升级兼容：main 留下的旧候选键（sha256(windowId|kind|norm(text))） ----------

/** 旧版本（main 分支）的候选键：没有最终项目、正文和方案。 */
const legacyKey = (window: string, c: { kind: string; text: string }) => sha256(`${window}|${c.kind}|${c.text.replace(/\s+/g, " ").trim()}`);

/** 按本次重跑会切出的窗口 id 写一条旧键，模拟升级前 main 存下的候选。 */
function recordLegacyCandidate(e: Env, sid: string, to: string, cand: { kind: string; text: string }): void {
  const window = sha256(`claude|${sid}||${to}`);
  e.store.workDb.prepare("INSERT INTO capture_candidates(candidate_key,event_id,window_id) VALUES(?,?,?)").run(legacyKey(window, cand), "legacy-event", window);
}

const proposalCount = (e: Env) => e.store.project().props.size;
const evidenceCount = (e: Env) => e.store.workDb.prepare("SELECT count(*) AS n FROM events WHERE kind='evidence'").get()!.n;

test("升级兼容：旧键已在库、旧条目还有效 → 重跑不再追加证据、不新建条目", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  recordLegacyCandidate(e, "s1", "u1", RULE);
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] }))), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1, "窗口照常完成");
  assert.deepEqual([proposalCount(e), evidenceCount(e)], [0, 0], "旧键命中就当已处理");
});

test("升级兼容：旧键已在库、旧条目已被归档 → 重跑不再用新 id 让它重新生效", async () => {
  const e = env();
  const old = e.store.remember(e.pid, null, false, { kind: "rule", text: RULE.text, why: RULE.why, basis: "user_directive", confirmed: false, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" } });
  e.store.lifecycle("archive", old, null, { reason: "user" });
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  recordLegacyCandidate(e, "s1", "u1", RULE);
  await runWork(e.deps(fakeChat(() => json({ candidates: [RULE] }))), { sweep: false, dryRun: false });
  const same = [...e.store.project().props.values()].filter((p) => p.text === RULE.text);
  assert.deepEqual(same.map((p) => [p.id, p.state]), [[old, "archived"]], "归档的条目不能被新 id 重新写活");
});

test("升级兼容反例：候选带正文时不按旧键跳过，照常写入", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", [user("u1", "以后 hook 命令都写 node 绝对路径")]));
  recordLegacyCandidate(e, "s1", "u1", RULE);
  const withBody = { ...RULE, kind: "decision", body: "PATH 里没有 ab，写 node 绝对路径" };
  const r = await runWork(e.deps(fakeChat(() => json({ candidates: [withBody] }))), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.deepEqual([...e.store.project().props.values()].map((p) => [p.text, p.body]), [[withBody.text, withBody.body]], "main 的条目没有正文，带正文算新内容");
});

test("升级兼容：证据按旧键跳过时，confirm 也跳过，目标条目不被转正", async () => {
  const e = env();
  const target = auto(e, "s1", RULE.text, "以后 hook 命令都写 node 绝对路径");
  const quote = "hook 里一律用 node 的绝对路径";
  e.register("s2", e.transcript("s2", [user("u1", quote)]));
  // main 处理这条会话的窗口时已写下候选键：升级后重跑会再次产出同一条候选，判成 s1 条目的 duplicate
  recordLegacyCandidate(e, "s2", "u1", RULE);
  const chat = fakeChat(() => json({ candidates: [{ ...RULE, evidence: [{ anchor: "#1", role: "user", quote }], relation: { type: "duplicate", target: "m1" } }] }));
  const r = await runWork(e.deps(chat), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1, "窗口照常完成");
  const stat = (kind: string) => e.store.workDb.prepare("SELECT count(*) AS n FROM events WHERE kind=? AND target_id=?").get(kind, target)!.n;
  assert.deepEqual([stat("evidence"), stat("confirm")], [0, 0], "证据被旧键判成已处理时，confirm 不能单独写进去");
  assert.equal(e.store.project().props.get(target)!.confirmed, false, "目标条目不能靠没写进去的证据转正");
});

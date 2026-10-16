/**
 * 话题结束时一步式沉淀（§8.6）：切窗口、触发、写库、幂等、额度、撤销。假模型、假 embedding，不连网、不调 Claude。
 * 运行：node --test src/topic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Embedder } from "./store.ts";
import { WorkFailure, type Chat, type ChatMessage } from "./llm.ts";
import { runWork, type TopicDeps, type WorkDeps } from "./work.ts";
import * as intake from "./intake.ts";
import type { Turn } from "./transcript.ts";
import {
  addTopicMark, PROMPT_VERSION, TOPIC_CONTEXT_MAX_CHARS, TOPIC_CONTEXT_TURNS, TOPIC_IDLE_MS, TOPIC_MAX_CHARS,
  topicChatFor, topicChunks, topicEnabled, topicMarks, undoTopicRun, type TopicRunReport,
} from "./topic.ts";
import type { RunResult } from "./clireviewer.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "ab-topic-")));
let n = 0;
const MIN = 60_000;
const T0 = Date.parse("2026-10-16T01:00:00.000Z");
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

const fakeEmbed: Embedder = Object.assign(async (texts: string[]) => texts.map((t) => {
  const v = new Float32Array(97);
  for (const ch of t) v[ch.codePointAt(0)! % 97] += 1;
  return v;
}), { model: "fake-embed" });

// ---------- 切窗口 ----------

const turn = (anchor: string, min: number, text = `第 ${anchor} 轮`, role: Turn["role"] = "user"): Turn => ({ anchor, role, text, ts: at(min) });
const noCut = { marks: [], ended: false, idleTail: false };

test("切窗口：相邻两轮相隔 ≥20 分钟是话题边界；还在聊的最后一段不切", () => {
  const all = [turn("a", 0), turn("b", 5), turn("c", 30), turn("d", 31)];
  const r = topicChunks("claude", "s", all, null, noCut);
  assert.ok(r !== "anchor_missing");
  assert.equal(r.chunks.length, 1);
  assert.deepEqual(r.chunks[0].turns.map((t) => t.anchor), ["a", "b"]);
  assert.equal(r.chunks[0].trigger, "idle");
  assert.equal(r.chunks[0].from, null);
  assert.equal(r.chunks[0].to, "b");
  // 19 分 59 秒不算
  const near = [turn("a", 0), { ...turn("b", 0), ts: new Date(T0 + TOPIC_IDLE_MS - 1000).toISOString() }];
  const r2 = topicChunks("claude", "s", near, null, noCut);
  assert.ok(r2 !== "anchor_missing");
  assert.equal(r2.chunks.length, 0);
});

test("切窗口：会话结束/静置收尾把最后一段切出来；从处理进度之后开始，背景是前面的轮次", () => {
  const all = [turn("a", 0), turn("b", 5), turn("c", 30), turn("d", 31)];
  const ended = topicChunks("claude", "s", all, "b", { marks: [], ended: true, idleTail: false });
  assert.ok(ended !== "anchor_missing");
  assert.deepEqual(ended.chunks.map((c) => [c.from, c.to, c.trigger]), [["b", "d", "session_end"]]);
  assert.deepEqual(ended.chunks[0].context.map((t) => t.anchor), ["a", "b"]);
  const idle = topicChunks("claude", "s", all, "b", { marks: [], ended: false, idleTail: true });
  assert.ok(idle !== "anchor_missing");
  assert.equal(idle.chunks[0].trigger, "idle");
  assert.equal(topicChunks("claude", "s", all, "zzz", noCut), "anchor_missing");
});

test("切窗口：压缩标记切在标记时刻之前的最后一轮；落在处理进度之前的标记算失效", () => {
  const all = [turn("a", 0), turn("b", 1), turn("c", 2), turn("d", 3)];
  const r = topicChunks("claude", "s", all, null, { marks: [{ cut_at: new Date(T0 + 2.5 * MIN).toISOString(), trigger: "compact" }], ended: false, idleTail: false });
  assert.ok(r !== "anchor_missing");
  assert.deepEqual(r.chunks.map((c) => [c.to, c.trigger, c.marks.length]), [["c", "compact", 1]]);
  const later = topicChunks("claude", "s", all, "c", { marks: [{ cut_at: new Date(T0 + 2.5 * MIN).toISOString(), trigger: "compact" }], ended: true, idleTail: false });
  assert.ok(later !== "anchor_missing");
  assert.deepEqual(later.staleMarks.length, 1);
  assert.deepEqual(later.chunks.map((c) => [c.from, c.to, c.trigger]), [["c", "d", "session_end"]]);
});

test("切窗口：话题超长按轮次拆成 k/n，每段都带它前面的背景；背景最多 8 轮、6000 字", () => {
  const big = "字".repeat(50_000);
  const all = Array.from({ length: 12 }, (_, i) => turn(`t${i}`, i, i < 2 ? "背景".repeat(2000) : big));
  const r = topicChunks("claude", "s", all, "t1", { marks: [], ended: true, idleTail: false });
  assert.ok(r !== "anchor_missing");
  const parts = r.chunks;
  assert.ok(parts.length > 1);
  assert.ok(parts.every((c) => c.chars <= TOPIC_MAX_CHARS));
  assert.deepEqual(parts.map((c) => c.part), parts.map((_, i) => `${i + 1}/${parts.length}`));
  assert.equal(parts[0].from, "t1");
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].from, parts[i - 1].to, "首尾相接");
  for (const c of parts) {
    assert.ok(c.context.length <= TOPIC_CONTEXT_TURNS);
    assert.ok(c.context.reduce((s, t) => s + t.text.length, 0) <= TOPIC_CONTEXT_MAX_CHARS + 1);
  }
  assert.ok(parts.every((c) => c.trigger === "session_end"));
});

// ---------- 流水线 ----------

const user = (uuid: string, text: string, min: number) => ({ type: "user", uuid, timestamp: at(min), message: { role: "user", content: text } });
const asst = (uuid: string, text: string, min: number) => ({ type: "assistant", uuid, timestamp: at(min), message: { content: [{ type: "text", text }] } });

const ITEM = { action: "new", kind: "rule", class: "A", text: "改了前端 UI 后先重启 dev server 再跑 e2e", scenario: "当改完前端代码要跑 e2e 时", why: "上次 e2e 全绿但页面没变", guidance: false, reason: "用户明确要求" };

function fakeChat(reply: (msgs: ChatMessage[]) => object | Error): Chat & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const f = (async (msgs: ChatMessage[]) => {
    if (msgs[0]?.content?.includes("记忆关系判定器")) return { message: { role: "assistant", content: JSON.stringify({ results: [] }) }, tokens: 1 };
    calls.push(structuredClone(msgs));
    const r = reply(msgs);
    if (r instanceof Error) throw r;
    return { message: { role: "assistant", content: JSON.stringify(r) }, tokens: 10 };
  }) as Chat & { calls: ChatMessage[][] };
  f.calls = calls;
  return f;
}

interface Env {
  store: Store;
  pid: string;
  dir: string;
  repo: string;
  deps: (topic: TopicDeps | undefined, extra?: Partial<WorkDeps>) => WorkDeps;
  transcript: (sid: string, lines: object[], idleMin?: number) => string;
  register: (sid: string, file: string, ended?: boolean, host?: "claude" | "codex" | "pi") => void;
}

function env(): Env {
  const dir = join(base, `e${n++}`);
  const repo = join(dir, "alpha");
  mkdirSync(repo, { recursive: true });
  const regDir = join(dir, "repos");
  mkdirSync(regDir);
  const store = new Store(join(dir, "store.db"), join(dir, "index.db"));
  const pid = store.ensureProject("alpha");
  return {
    store,
    pid,
    dir,
    repo,
    deps: (topic, extra = {}) => ({
      store,
      now: () => new Date(T0 + 120 * MIN),
      chat: { error: "no_config", message: "话题模式不用抽取器" },
      embedder: fakeEmbed,
      registry: [{ name: "alpha", path: repo }],
      registryDir: regDir,
      resolveProject: (cwd) => (cwd.startsWith(repo) ? { name: "alpha", path: repo } : null),
      projectId: (name) => store.ensureProject(name),
      ...(topic ? { topic } : {}),
      ...extra,
    }),
    transcript: (sid, lines, idleMin = 0) => {
      const p = join(dir, `${sid}.jsonl`);
      writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      // 默认 transcript 刚改过（最后一段还在聊）；idleMin 给出最后修改距"现在"多少分钟
      const m = new Date(T0 + (120 - idleMin) * MIN);
      utimesSync(p, m, m);
      return p;
    },
    register: (sid, file, ended = false, host = "claude") => {
      intake.upsertSession(store.workDb, { host, session_id: sid, transcript: file, cwd: repo, ended, ephemeral: false, via: "hook" }, () => "alpha", new Date(T0 + 100 * MIN));
    },
  };
}

function topicDeps(chat: Chat, saved: TopicRunReport[] = [], model = "claude:haiku@max"): TopicDeps {
  return { run: `run-${n}-${Math.random().toString(36).slice(2, 8)}`, chatFor: () => ({ chat, model }), save: (r) => saved.push(structuredClone(r)) };
}

const TWO_TOPICS = [
  user("u1", "以后改了前端 UI 先重启 dev server 再跑 e2e，上次 e2e 全绿但页面没变", 0),
  asst("a1", "好的，记住了：改 UI 后先重启 dev server 再跑 e2e。", 2),
  user("u2", "另一个话题：数据库迁移脚本要先在副本上跑一遍", 40),
  asst("a2", "明白，迁移脚本先在副本上验证。", 41),
];

test("话题模式：只处理已结束的话题，写进正式库（未确认、不是候选），带来源定位点、窗口、触发、提示词版本、模型", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  const chat = fakeChat(() => ({ items: [ITEM] }));
  const saved: TopicRunReport[] = [];
  const t = topicDeps(chat, saved);
  const r = await runWork(e.deps(t), { sweep: false, dryRun: false });
  assert.deepEqual(r.windows, { done: 1, deferred: 0, failed: 0, skipped: 0 });
  assert.equal(chat.calls.length, 1);
  const prompt = chat.calls[0][1].content!;
  assert.match(prompt, /先重启 dev server/);
  assert.doesNotMatch(prompt, /数据库迁移/, "还在聊的第二个话题没送");
  assert.match(chat.calls[0][0].content!, /记忆员/, "用的是一步式提示词");
  const props = [...e.store.project().props.values()];
  assert.equal(props.length, 1);
  const p = props[0];
  assert.equal(p.state, "active");
  assert.equal(p.confirmed, false);
  assert.equal(p.origin, "extract");
  assert.equal(p.basis, "agent_inference");
  assert.equal(p.project_id, e.pid);
  assert.equal(p.source.anchor, "a1");
  const ev = e.store.topicRunEvents(t.run);
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0].body.topic, window_id: "x" }, { run: t.run, window_id: "x", trigger: "idle", from: null, to: "a1", part: null, prompt_version: PROMPT_VERSION, model: "claude:haiku@max", class: "A" });
  assert.equal(ev[0].body.window_id, ev[0].body.topic!.window_id);
  assert.equal(intake.sessions(e.store.workDb)[0].processed_anchor, "a1");
  assert.equal(saved.at(-1)!.windows[0].created[0].id, ev[0].id, "运行报告记下写入的条目");
});

test("话题模式幂等：重跑不再调模型；会话结束后只处理剩下的部分", async () => {
  const e = env();
  const f = e.transcript("s1", TWO_TOPICS);
  e.register("s1", f);
  const chat = fakeChat((m) => (/数据库迁移/.test(m[1].content!) ? { items: [{ ...ITEM, text: "数据库迁移脚本先在副本上跑一遍", scenario: "当要跑数据库迁移时" }] } : { items: [ITEM] }));
  await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1, "第二次没有新结束的话题");
  e.register("s1", f, true);
  const r = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.equal(chat.calls.length, 2);
  assert.doesNotMatch(chat.calls[1][1].content!.replace(/<context_only[\s\S]*?<\/context_only>/, ""), /先重启 dev server/, "第一个话题只在背景里，不重抽");
  assert.match(chat.calls[1][1].content!, /<context_only[\s\S]*先重启 dev server[\s\S]*<\/context_only>/, "前一个话题作为背景附上");
  assert.equal(e.store.project().props.size, 2);
  const w = e.store.workDb.prepare("SELECT COUNT(*) AS n FROM capture_windows WHERE state='done'").get() as { n: number };
  assert.equal(w.n, 2);
});

test("压缩标记：压缩前的内容立刻成为一个话题；之后会话结束只处理压缩后的部分", async () => {
  const e = env();
  const lines = [user("u1", "以后改了前端 UI 先重启 dev server 再跑 e2e", 100), asst("a1", "好的", 101), user("u2", "数据库迁移脚本要先在副本上跑一遍", 103), asst("a2", "明白", 104)];
  const f = e.transcript("s1", lines);
  e.register("s1", f);
  addTopicMark(e.store.workDb, "claude", "s1", new Date(T0 + 102 * MIN));
  const chat = fakeChat(() => ({ items: [] }));
  const r = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(r.windows.done, 1);
  assert.equal(r.topic!.windows[0].trigger, "compact");
  assert.equal(r.topic!.windows[0].to, "a1");
  assert.deepEqual(topicMarks(e.store.workDb, "claude", "s1"), [], "处理完的标记删掉");
  e.register("s1", f, true);
  const r2 = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.deepEqual(r2.topic!.windows.map((w) => [w.from, w.to, w.trigger]), [["a1", "a2", "session_end"]]);
});

test("并入已有：不改目标、不写库，只进运行报告（目标是用户确认的也一样）", async () => {
  const e = env();
  const target = e.store.remember(e.pid, null, false, { kind: "rule", text: "改 UI 后重启 dev server", source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" }, confirmed: true });
  await e.store.syncVectors(fakeEmbed, "fake-embed");
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  const chat = fakeChat((m) => {
    const label = /\[(m\d+)\][^\n]*改 UI 后重启 dev server/.exec(m[1].content!)?.[1] ?? "m1";
    return { items: [{ ...ITEM, action: "merge", into: label }] };
  });
  const before = e.store.workDb.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  const r = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  const after = e.store.workDb.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  assert.equal(after.n, before.n, "没写任何事件");
  assert.deepEqual(r.topic!.windows[0].merges.map((m) => [m.into, m.into_confirmed_by_user]), [[target, true]]);
  assert.equal(e.store.project().props.get(target)!.text, "改 UI 后重启 dev server");
});

test("库里已有高相似条目时，模型说 new 也只标关系未判定，交给用户", async () => {
  const e = env();
  e.store.remember(e.pid, null, false, { kind: "rule", text: ITEM.text, source: { host: null, session_id: null, transcript: null, anchor: null, summary: "x" }, confirmed: false });
  await e.store.syncVectors(fakeEmbed, "fake-embed");
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  const r = await runWork(e.deps(topicDeps(fakeChat(() => ({ items: [ITEM] })))), { sweep: false, dryRun: false });
  assert.equal(r.receipt.unreconciled, 1);
  assert.equal(r.topic!.windows[0].created[0].unreconciled, true);
});

test("额度用完：窗口延后到恢复时间、不算失败尝试；同一次运行不再给这个宿主发请求", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  e.register("s2", e.transcript("s2", TWO_TOPICS));
  const hours = 10 * 3_600_000;
  const chat = fakeChat(() => new WorkFailure("http_429", "claude 审稿失败：You've hit your weekly limit · resets Oct 17 at 1am", hours));
  const r = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1, "第二个会话没再调");
  assert.equal(r.windows.deferred, 2);
  const w = e.store.workDb.prepare("SELECT state,attempts,error_code,next_at FROM capture_windows").all() as any[];
  assert.equal(w.length, 1);
  assert.deepEqual([w[0].state, w[0].attempts, w[0].error_code], ["deferred", 0, "http_429"]);
  assert.equal(w[0].next_at, new Date(T0 + 120 * MIN + hours).toISOString());
  // 恢复前再跑：不调模型
  await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(chat.calls.length, 1);
  assert.equal(intake.sessions(e.store.workDb).every((s) => s.processed_anchor === null), true, "话题没丢");
});

test("输出不合法：窗口延后重试，不写库", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  const chat = (async () => ({ message: { role: "assistant", content: "我觉得没什么好记的" }, tokens: 1 })) as Chat;
  const r = await runWork(e.deps(topicDeps(chat)), { sweep: false, dryRun: false });
  assert.equal(r.windows.deferred, 1);
  assert.equal(e.store.project().props.size, 0);
  const w = e.store.workDb.prepare("SELECT state,attempts,error_code FROM capture_windows").get() as any;
  assert.deepEqual([w.state, w.attempts, w.error_code], ["deferred", 1, "invalid_output"]);
});

test("整次撤销：归档本次写入、之后没被动过的条目；用户确认过的、后来被改过状态的不动", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", TWO_TOPICS));
  const items = [ITEM, { ...ITEM, text: "迁移脚本先在副本上跑", scenario: "当要跑迁移时", kind: "decision" }, { ...ITEM, text: "提交前先跑 tsc", scenario: "当要提交代码时", kind: "pitfall" }];
  const t = topicDeps(fakeChat(() => ({ items })));
  const r = await runWork(e.deps(t), { sweep: false, dryRun: false });
  const ids = r.topic!.windows.flatMap((w) => w.created.map((c) => c.id));
  assert.equal(ids.length, 3);
  e.store.lifecycle("confirm", ids[0], null, {});
  e.store.lifecycle("stage", ids[1], null, {});
  const u = undoTopicRun(e.store, t.run);
  assert.deepEqual(u.archived, [ids[2]]);
  assert.deepEqual(u.kept.map((k) => k.id).sort(), [ids[0], ids[1]].sort());
  const props = e.store.project().props;
  assert.equal(props.get(ids[0])!.state, "active");
  assert.equal(props.get(ids[0])!.confirmed_by, "user");
  assert.equal(props.get(ids[2])!.state, "archived");
  assert.deepEqual(undoTopicRun(e.store, t.run).archived, [], "再撤一次不重复");
});

test("开关关着（没给 topic）时走原来的 48000 字窗口和抽取器，话题标记不影响", async () => {
  const e = env();
  e.register("s1", e.transcript("s1", TWO_TOPICS, 60));
  addTopicMark(e.store.workDb, "claude", "s1", new Date(T0 + 1 * MIN));
  const calls: string[] = [];
  const legacy = (async (msgs: ChatMessage[]) => {
    calls.push(msgs[0].content!);
    return { message: { role: "assistant", content: JSON.stringify({ candidates: [], results: [] }) }, tokens: 1 };
  }) as Chat;
  const r = await runWork(e.deps(undefined, { chat: { chat: legacy, model: "fake" } }), { sweep: false, dryRun: false });
  assert.equal(r.topic, undefined);
  assert.equal(r.windows.done, 1, "一个 48000 字窗口装下整个会话");
  assert.ok(calls.length >= 1);
  assert.doesNotMatch(calls[0], /记忆员/, "用的是抽取器提示词");
});

test("开关：extract.json 里 topic 为 true 才开；没文件、坏 JSON、其他值都是关", () => {
  const d = join(base, `sw${n++}`);
  mkdirSync(d);
  assert.equal(topicEnabled(d), false);
  writeFileSync(join(d, "extract.json"), "{bad");
  assert.equal(topicEnabled(d), false);
  writeFileSync(join(d, "extract.json"), JSON.stringify({ model: "qwen-plus", topic: "yes" }));
  assert.equal(topicEnabled(d), false);
  writeFileSync(join(d, "extract.json"), JSON.stringify({ model: "qwen-plus", topic: true }));
  assert.equal(topicEnabled(d), true);
  writeFileSync(join(d, "extract.json"), JSON.stringify({ topic: true }));
  assert.equal(topicEnabled(d), true, "只看这一个键");
});

test("子模型：按宿主选命令行和模型（review.json hostReviewers 优先，否则宿主默认），review.json 写错时报 no_config", async () => {
  const d = join(base, `cf${n++}`);
  mkdirSync(d);
  const seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const runner = async (cmd: string, args: string[], _input: string, o: { env: NodeJS.ProcessEnv }): Promise<RunResult> => {
    seen.push({ cmd, args, env: o.env });
    return { code: 0, stdout: JSON.stringify({ result: '{"items":[]}', usage: {} }), stderr: "", timedOut: false };
  };
  const prevHome = process.env.AB_HOST_HOME;
  process.env.AB_HOST_HOME = join(d, "nohome");
  try {
    const f = topicChatFor(d, { runner });
    const c = f("claude");
    assert.ok(!("error" in c));
    assert.equal(c.model, "claude:haiku@max");
    await c.chat([{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    assert.equal(seen[0].cmd, "claude");
    assert.ok(seen[0].args.includes("haiku") && seen[0].args.includes("max"));
    assert.equal(seen[0].env.AGENTBRAIN_REVIEWER, "1", "子模型会话不登记、不召回、不再触发抽取");
    writeFileSync(join(d, "review.json"), JSON.stringify({ mode: "primary", primary: "p", panel: [{ name: "p", type: "cli", host: "pi" }], hostReviewers: { pi: { name: "pi-review", type: "cli", host: "pi", model: "openai-codex/gpt-6-astra", effort: "max" } } }));
    const pi = topicChatFor(d, { runner })("pi");
    assert.ok(!("error" in pi));
    assert.equal(pi.model, "pi:openai-codex/gpt-6-astra@max");
    writeFileSync(join(d, "review.json"), "{bad");
    const bad = topicChatFor(d, { runner })("claude");
    assert.ok("error" in bad && bad.error === "no_config");
  } finally {
    if (prevHome === undefined) delete process.env.AB_HOST_HOME;
    else process.env.AB_HOST_HOME = prevHome;
  }
});

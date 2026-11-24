// Antigravity CLI（agy）作为宿主（设计 §7.7）：准入、读法、来源展开、模型名、sweep 补登记、hook 登记、doctor 一行。
// 全部用临时 HOME，造出 agy 的目录形状：brain/<id>/.system_generated/logs/transcript{,_full}.jsonl + conversation_summaries.db。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { allowedTranscript } from "./transcript-file.ts";
import { cleanTranscript } from "./transcript.ts";
import { expandSource, latestAnchor } from "./source.ts";
import { ownUserText } from "./extract.ts";
import { modelOf } from "./telemetry.ts";
import { locateTranscript, pickHost } from "./host.ts";
import { chunk, scan, runWork, type WorkDeps } from "./work.ts";
import { Store } from "./store.ts";
import * as intake from "./intake.ts";

const oldEnv = { HOME: process.env.HOME, AB_HOME: process.env.AB_HOME, AGENTBRAIN_HOME: process.env.AGENTBRAIN_HOME, AB_REGISTRY: process.env.AB_REGISTRY };
const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-agy-host-")));
process.env.HOME = home;
process.env.AB_HOME = process.env.AGENTBRAIN_HOME = join(home, "ab");
process.env.AB_REGISTRY = join(home, "repos");
after(() => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const app = join(home, ".gemini/antigravity-cli");
const brain = join(app, "brain");
const logs = (id: string) => join(brain, id, ".system_generated/logs");
const full = (id: string) => join(logs(id), "transcript_full.jsonl");
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");

const repo = join(home, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);

const MAIN = "aaaaaaaa-1111-2222-3333-444444444444";
const WORKER = "bbbbbbbb-1111-2222-3333-444444444444";
const CHILD = "cccccccc-1111-2222-3333-444444444444";
const ELSEWHERE = "dddddddd-1111-2222-3333-444444444444";
const OLD = "eeeeeeee-1111-2222-3333-444444444444";

const userInput = (i: number, text: string) => ({
  step_index: i, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: iso(now - 600_000),
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-18T15:12:29+08:00.\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\`.\n</USER_SETTINGS_CHANGE>`,
});
const system = (i: number, text: string) => ({
  step_index: i, source: "SYSTEM_SDK", type: "SYSTEM_MESSAGE", status: "DONE", created_at: iso(now - 600_000),
  content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\n${text}\n</SYSTEM_MESSAGE>`,
});
const planner = (i: number, content: string | undefined, tool_calls?: object[]) => ({
  step_index: i, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: iso(now - 500_000), model: "gemini-3.8-flash-low",
  thinking: "思考过程不读", ...(content === undefined ? {} : { content }), ...(tool_calls ? { tool_calls } : {}),
});
const generic = (i: number, content: string, error?: string) => ({
  step_index: i, source: "MODEL", type: "GENERIC", status: error ? "ERROR" : "DONE", created_at: iso(now - 400_000), content, ...(error ? { error } : {}),
});

function writeSession(id: string, steps: object[], truncated = steps) {
  mkdirSync(join(logs(id), "chunks/transcript_full"), { recursive: true });
  mkdirSync(join(brain, id, "scratch"), { recursive: true });
  writeFileSync(full(id), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(logs(id), "transcript.jsonl"), truncated.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(logs(id), "chunks/transcript_full/00000000.jsonl"), steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(brain, id, "scratch/notes.jsonl"), "{}\n");
}

const LONG = "以后改 hook 先在隔离 HOME 里跑一遍，因为上次直接改正式配置把 Codex 的信任弄丢了。" + "补充说明".repeat(500);
writeSession(MAIN, [
  userInput(0, LONG),
  system(1, `<agentbrain-brief>\n<agentbrain project="repo">\n全局规则：先结论后原因\n</agentbrain-brief>`),
  system(2, "<agentbrain-prefs>\n用户的干活偏好：简洁\n</agentbrain-prefs>"),
  planner(3, "我先看一下配置。", [{ name: "run_command", args: { CommandLine: "cat ~/.codex/hooks.json", WaitMsBeforeAsync: 5000, toolSummary: "读配置" } }, { name: "run_command", args: { CommandLine: "ab search hook", toolSummary: "查记忆" } }]),
  generic(4, "Created At: x\nCommand exited with code 1.\nError: hooks.json not found"),
  generic(5, "Created At: x\nab 的输出：[deadbeef] 记忆正文不能回流"),
  planner(6, undefined, [{ name: "read_file", args: { Path: "\"/etc/hosts\"" } }]),
  generic(7, "Encountered error in step execution: permission denied", "permission check failed for read_file"),
  planner(8, "好的，以后先在隔离 HOME 里试。"),
], [userInput(0, LONG.slice(0, 1500))]);
writeSession(WORKER, [
  userInput(0, "读 /tmp/task.md 全文，按要求完成。"),
  system(1, `<agentbrain-brief>\n<agentbrain project="repo" worker>\n子代理规则\n</agentbrain-brief>`),
  planner(2, "完成"),
]);
writeSession(CHILD, [userInput(0, "子会话"), planner(1, "好")]);
writeSession(ELSEWHERE, [userInput(0, "别处"), planner(1, "好")]);
writeSession(OLD, [userInput(0, "很久以前"), planner(1, "好")]);
utimesSync(full(MAIN), new Date(now - 3_600_000), new Date(now - 3_600_000)); // 静置超过 30 分钟，最后一个窗口才切出来
utimesSync(full(OLD), new Date(now - 9 * 86_400_000), new Date(now - 9 * 86_400_000));

const db = new DatabaseSync(join(app, "conversation_summaries.db"));
db.exec("CREATE TABLE conversation_summaries(conversation_id text, workspace_uris text NOT NULL, parent_conversation_id text NOT NULL DEFAULT '', last_modified_time datetime NOT NULL, PRIMARY KEY(conversation_id))");
for (const [id, ws, parent] of [[MAIN, [`file://${repo}`], ""], [WORKER, [`file://${repo}`], ""], [CHILD, [`file://${repo}`], MAIN], [ELSEWHERE, ["file:///elsewhere"], ""], [OLD, [`file://${repo}`], ""]] as const) {
  db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?)").run(id, JSON.stringify(ws), parent, iso(id === OLD ? now - 9 * 86_400_000 : now));
}
db.close();

test("agy 进程最近时按 agy 判定，会话 id 取 ANTIGRAVITY_CONVERSATION_ID；locateTranscript 找到 transcript_full.jsonl", () => {
  const hit = pickHost([{ comm: "/bin/sh", args: "sh" }, { comm: "agy", args: "agy -p hi" }, { comm: "claude", args: "claude" }], { ANTIGRAVITY_CONVERSATION_ID: MAIN, CLAUDE_CODE_SESSION_ID: "x" });
  assert.deepEqual(hit, { host: "agy", session_id: MAIN });
  assert.equal(locateTranscript("agy", MAIN), full(MAIN));
  assert.equal(locateTranscript("agy", "ffffffff-0000-0000-0000-000000000000"), null);
  assert.equal(locateTranscript("agy", "../../etc"), null);
});

test("agy 准入：只认 brain/<id>/.system_generated/logs/transcript_full.jsonl；截断版换成完整版；chunks、scratch、id 不符、目录外链接都拒绝", () => {
  assert.equal(allowedTranscript("agy", full(MAIN), MAIN), full(MAIN));
  assert.equal(allowedTranscript("agy", join(logs(MAIN), "transcript.jsonl"), MAIN), full(MAIN), "钩子给的截断版换成完整版");
  assert.equal(allowedTranscript("agy", join(logs(MAIN), "chunks/transcript_full/00000000.jsonl")), null);
  assert.equal(allowedTranscript("agy", join(brain, MAIN, "scratch/notes.jsonl")), null);
  assert.equal(allowedTranscript("agy", full(MAIN), WORKER), null, "id 必须和路径里的一致");
  assert.equal(allowedTranscript("claude", full(MAIN)), null, "别的宿主不认 agy 的目录");
  assert.equal(allowedTranscript("agy", join(home, ".claude/projects/p/x.jsonl")), null);
  // brain/<id> 被换成指向别处的链接：真实路径不在 brain 下
  const outside = join(home, "outside/.system_generated/logs");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "transcript_full.jsonl"), "{}\n");
  const LINK = "ffffffff-1111-2222-3333-444444444444";
  symlinkSync(join(home, "outside"), join(brain, LINK));
  assert.equal(allowedTranscript("agy", full(LINK), LINK), null);
  // 文件还没写出来：按字面路径放行（同 Claude）
  const LATE = "99999999-1111-2222-3333-444444444444";
  assert.equal(allowedTranscript("agy", join(logs(LATE), "transcript.jsonl"), LATE), full(LATE));
});

test("agy 读法：用户轮只取 USER_REQUEST 原文（不截断），注入的系统消息不进轮次，ab 调用和输出省略，工具调用压成一行", () => {
  const c = cleanTranscript("agy", full(MAIN));
  const roles = c.turns.map((t) => `${t.anchor}:${t.role}`);
  assert.deepEqual(roles, ["0:user", "3:assistant", "4:tool", "6:assistant", "7:tool", "8:assistant"]);
  const all = c.turns.map((t) => t.text).join("\n");
  assert.equal(c.turns[0].text, LONG, "完整原话，不带 ADDITIONAL_METADATA 等宿主块");
  assert.doesNotMatch(all, /agentbrain-brief|agentbrain-prefs|SYSTEM_MESSAGE|先结论后原因|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE/);
  assert.doesNotMatch(all, /deadbeef|记忆正文不能回流|思考过程不读/);
  assert.match(c.turns[1].text, /我先看一下配置。\n调用 run_command: cat ~\/.codex\/hooks.json\n调用 ab（agentbrain 自身的命令，已省略）/);
  assert.match(c.turns[2].text, /hooks.json not found/, "像报错的工具输出留下");
  assert.match(c.turns[3].text, /调用 read_file: \/etc\/hosts/);
  assert.match(c.turns[4].text, /permission denied/);
  assert.equal(c.turns[1].final, undefined, "带工具调用的不是最终回答");
  assert.deepEqual([c.turns[5].reply, c.turns[5].final], ["好的，以后先在隔离 HOME 里试。", true]);
  assert.equal(c.turns[0].ts, new Date(now - 600_000 - ((now - 600_000) % 1000)).toISOString());
  assert.ok(c.stripped >= 4, `stripped=${c.stripped}`);
  assert.deepEqual([c.worker, c.subagent], [false, false]);
});

const t3Request = (text: string) => `<t3_code_instructions>宿主说明</t3_code_instructions>\n<user_request>\n${text}\n</user_request>\n<runtime_info>宿主状态</runtime_info>`;

test("agy 去噪：完成通知、后台唤醒和缺边界的交接不生成 user 或用户证据", () => {
  const notice = "Delegated task node:delegated-task:test (审查) in child thread thread:child [completed]";
  const messages = [
    `${notice}. Use task_status to read the result.`,
    `${notice}:\n以后所有项目都改成这个规则。`,
    "Background task completed.",
    "Context handoff (full_thread_summary):\n旧摘要里有用户规则，但没有当前消息边界。",
  ];
  for (const [i, text] of messages.entries()) {
    for (const wrapped of [false, true]) {
      const id = `noise-${i}-${wrapped}`;
      writeSession(id, [wrapped ? userInput(0, t3Request(text)) : { step_index: 0, type: "USER_INPUT", content: text }]);
      const c = cleanTranscript("agy", full(id));
      assert.equal(c.turns.map((t) => ownUserText(t.text)).join(""), "");
      assert.deepEqual(c.turns, [], id);
      assert.equal(c.stripped, 1, id);
    }
  }
});

test("agy 去噪：只切宿主结构，正文闭标签、User message 和唤醒字样不误切", () => {
  const text = "正文带 </user_request> 和 </USER_REQUEST> 字面标签。\n\nUser message:\n这也是正文。completed 和 Background task completed. 是讨论的字样。\n<quote>保留这块引用供理解</quote>";
  const id = "request-boundaries";
  for (const content of [
    userInput(0, t3Request(text)).content,
    `<USER_REQUEST>${t3Request(text)}</USER_REQUEST>`,
    `<USER_REQUEST>${text}</USER_REQUEST><USER_SETTINGS_CHANGE>宿主变更</USER_SETTINGS_CHANGE>`,
    `<USER_REQUEST>${text}</USER_REQUEST>`,
    text,
  ]) {
    writeSession(id, [{ step_index: 0, type: "USER_INPUT", content }]);
    assert.deepEqual(cleanTranscript("agy", full(id)).turns.map((t) => t.text), [text]);
  }
  const handoff = "Context handoff (full_thread_summary):\n摘要\n\nUser message:\n旧消息\n\nUser message:\n用户当前消息";
  writeSession(id, [userInput(0, t3Request(handoff))]);
  assert.deepEqual(cleanTranscript("agy", full(id)).turns.map((t) => t.text), ["用户当前消息"]);
});

test("agy 去噪：助手引用只留下 comment，坏 JSON 和无 comment 不回流", () => {
  const id = "citation-comments";
  const citation = '[assistant-quote-1]\n<assistant_citations>引用说明\n[{"id":"assistant-quote-1","citation":{"text":"助手的规则","comment":"是这个","prefix":"前缀","suffix":"后缀","start":12}},{"citation":{"text":"无评论"}},{"citation":{"comment":" "}}]\n</assistant_citations>';
  writeSession(id, [userInput(0, citation)]);
  const c = cleanTranscript("agy", full(id));
  assert.deepEqual(c.turns.map((t) => [t.role, t.text]), [["user", "是这个"]]);
  assert.equal(ownUserText(citation), "是这个");
  for (const inner of ['[{"citation":{"text":"助手原话"}}]', '[{"citation":{"comment":"不可解析的残片"}}', "坏 JSON"]) {
    writeSession(id, [userInput(0, `[assistant-quote-2]<assistant_citations>${inner}</assistant_citations>`)]);
    assert.deepEqual(cleanTranscript("agy", full(id)).turns, []);
  }
});

test("agy 定位点：回滚保留 76 与 76#2，旧进度和两处来源各自能定位", () => {
  const id = "rollback-anchors";
  writeSession(id, [userInput(76, "回滚前用户输入"), planner(77, "回滚前回答"), system(80, "系统注入"), userInput(76, "回滚后用户输入"), planner(77, "回滚后回答")]);
  const turns = cleanTranscript("agy", full(id)).turns;
  assert.deepEqual(turns.map((t) => t.anchor), ["76", "77", "76#2", "77#2"]);
  const chunks = chunk("agy", id, turns, "76", true);
  assert.notEqual(chunks, "anchor_missing");
  if (chunks !== "anchor_missing") assert.deepEqual(chunks.flatMap((c) => c.turns.map((t) => t.anchor)), ["77", "76#2", "77#2"]);
  const expand = (anchor: string) => expandSource({ host: "agy", session_id: id, transcript: full(id), anchor, summary: "s" });
  assert.equal(expand("76"), "[user] 回滚前用户输入");
  assert.match(expand("76#2")!, /\[user\] 回滚后用户输入$/);
  assert.equal(latestAnchor("agy", full(id)), "77#2");
  assert.equal(expand("76#3"), null);
  assert.equal(chunk("agy", id, turns, "76#3", true), "anchor_missing");
});

test("agy 定位点：未读和去噪行也计数，非 USER_INPUT 回跳清 pending，ab 键跨回滚隔离", () => {
  const id = "rollback-tool-pairing";
  for (const type of ["SYSTEM_MESSAGE", "ERROR_MESSAGE", "GENERIC", "PLANNER_RESPONSE"]) {
    writeSession(id, [
      planner(80, "", [{ name: "run_command", args: { CommandLine: "ab search rule" } }]),
      { step_index: 79, type, content: type === "GENERIC" ? "Error: 新工具失败" : "" },
      generic(81, "Error: 回滚后输出不能被旧 ab 吞掉"),
      planner(80, "", [{ name: "run_command", args: { CommandLine: "npm test" } }]),
      generic(81, "Error: 新调用的输出不能被旧 ab 键吞掉"),
    ]);
    const turns = cleanTranscript("agy", full(id)).turns;
    assert.ok(turns.some((t) => t.anchor === "81" && t.text.includes("回滚后输出")), type);
    assert.ok(turns.some((t) => t.anchor === "81#2" && t.text.includes("新调用的输出")), type);
  }
  writeSession(id, [system(76, "注入"), { step_index: 76, type: "ERROR_MESSAGE" }, userInput(76, "Background task completed."), userInput(76, "用户输入")]);
  assert.deepEqual(cleanTranscript("agy", full(id)).turns.map((t) => t.anchor), ["76#4"]);
});

test("agy 三处去噪：真实 CLI remember 和 get --expand 使用唯一定位点和同一用户正文", () => {
  const apps = [app, join(home, ".gemini/antigravity"), join(home, ".t3/userdata/providers/antigravity/denoise/antigravity-acp")];
  const abHome = join(home, "denoise-store");
  const env = { ...process.env, HOME: home, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: join(home, "denoise-registry"), ANTIGRAVITY_APP_DATA_DIR: "", GEMINI_HOME: "" };
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "cli.ts"), ...args], { env, encoding: "utf8" });
  for (const [i, root] of apps.entries()) {
    const id = `denoise-source-${i}`;
    const path = join(root, "brain", id, ".system_generated/logs/transcript_full.jsonl");
    mkdirSync(join(root, "brain", id, ".system_generated/logs"), { recursive: true });
    const steps = [
      userInput(76, "第一次用户输入"),
      userInput(77, "Delegated task node:delegated-task:test in child thread child [completed]: 助手结果"),
      userInput(76, '[assistant-quote-1]<assistant_citations>说明\n[{"citation":{"text":"助手引用不能展开","comment":"是这个"}}]</assistant_citations>'),
    ];
    writeFileSync(path, steps.map((s) => JSON.stringify(s)).join("\n") + "\n");
    assert.deepEqual(cleanTranscript("agy", path).turns.map((t) => [t.anchor, t.text]), [["76", "第一次用户输入"], ["76#2", "是这个"]]);
    const remembered = cli("remember", "--global", "--kind", "note", "--text", `去噪来源 ${i}`, "--summary", "定位", "--from-worker", `agy:${id}`);
    assert.equal(remembered.status, 0, remembered.stderr);
    const prop = /已记住 \[([0-9a-f]+)\]/.exec(remembered.stdout)?.[1];
    assert.ok(prop, remembered.stdout);
    const expanded = cli("get", prop, "--expand");
    assert.equal(expanded.status, 0, expanded.stderr);
    assert.match(expanded.stdout, /\[user\] 是这个/);
    assert.doesNotMatch(expanded.stdout, /助手引用不能展开|助手结果|assistant-quote|assistant_citations/);
    const store = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
    try {
      const source = [...store.project().props.values()].find((p) => p.id.startsWith(prop))?.source;
      assert.deepEqual([source?.transcript, source?.anchor], [path, "76#2"]);
    } finally { store.close(); }
  }
});

test("agy worker：注入里有 brief --worker 的头，或首条用户消息带 ab brief --worker", () => {
  assert.equal(cleanTranscript("agy", full(WORKER)).worker, true);
  const ID = "12121212-1111-2222-3333-444444444444";
  writeSession(ID, [userInput(0, "先跑 `ab brief --worker`，再读仓库 AGENTS.md"), planner(1, "好")]);
  assert.equal(cleanTranscript("agy", full(ID)).worker, true);
});

test("agy 来源展开、最新定位点、模型名", () => {
  assert.equal(latestAnchor("agy", full(MAIN)), "8");
  const text = expandSource({ host: "agy", session_id: MAIN, transcript: full(MAIN), anchor: "3", summary: "s" });
  assert.ok(text);
  assert.match(text, /以后改 hook 先在隔离 HOME 里跑一遍/);
  assert.match(text, /我先看一下配置/);
  assert.doesNotMatch(text, /以后先在隔离 HOME 里试/, "定位点之后的不展开");
  assert.equal(expandSource({ host: "agy", session_id: MAIN, transcript: join(brain, MAIN, "scratch/notes.jsonl"), anchor: "3", summary: "s" }), null);
  assert.equal(modelOf("agy", full(MAIN)), "gemini-3.8-flash-low");
});

function deps(store: Store): WorkDeps {
  return { store, now: () => new Date(now), chat: { error: "no_config", message: "test" }, embedder: null, registry: [{ name: "repo", path: repo }], registryDir: home, resolveProject: (cwd) => (cwd === repo ? { name: "repo", path: repo } : null), projectId: (name) => store.ensureProject(name) };
}

test("agy sweep 补登记：cwd 取自 conversation_summaries.db；子会话、7 天前的、chunks 副本不登记；只数已登记项目", async () => {
  const store = new Store(join(home, "scan-store.db"), join(home, "scan-index.db"));
  try {
    const added = scan(deps(store));
    const rows = intake.sessions(store.workDb).filter((s) => s.host === "agy");
    assert.deepEqual(rows.map((s) => s.session_id).sort(), [MAIN, WORKER, ELSEWHERE].sort());
    assert.equal(added, 2, "/elsewhere 只记坐标不算");
    const main = rows.find((s) => s.session_id === MAIN)!;
    assert.deepEqual([main.transcript, main.cwd, main.project], [full(MAIN), repo, "repo"]);
    assert.equal(scan(deps(store)), 0, "第二次不重复");
    const report = await runWork(deps(store), { session: { host: "agy", session_id: MAIN }, sweep: false, dryRun: true });
    assert.equal(report.dry[0].windows, 1);
    assert.ok(report.dry[0].chars > LONG.length);
  } finally { store.close(); }
});

test("话题模式打开时 agy 会话退回普通抽取（同 opencode）：agy 没有可借用的命令行子模型", async () => {
  const store = new Store(join(home, "topic-store.db"), join(home, "topic-index.db"));
  try {
    scan(deps(store));
    const asked: string[] = [];
    const report = await runWork({ ...deps(store), topic: { run: "agy-fixture", chatFor: (host) => (asked.push(host), { error: "no_config", message: "不该被调用" }) } }, { session: { host: "agy", session_id: MAIN }, sweep: false, dryRun: false });
    assert.deepEqual(asked, []);
    assert.equal(report.windows.deferred, 1, "走普通抽取，缺模型配置时延后");
  } finally { store.close(); }
});

test("agy capture --hook：登记完整版路径和钩子给的 cwd；越界路径不登记；SessionEnd 记为结束", () => {
  const registry = join(home, "repos");
  mkdirSync(registry, { recursive: true });
  writeFileSync(join(registry, "repo.md"), `- 路径：\`${repo}\`\n`);
  const abHome = join(home, "ab");
  const cli = join(import.meta.dirname, "cli.ts");
  const capture = (payload: object) => spawnSync(process.execPath, [cli, "capture", "--hook", "--host", "agy"], { env: { ...process.env, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: registry, HOME: home }, input: JSON.stringify(payload), encoding: "utf8" });
  const ok = capture({ session_id: MAIN, transcript_path: join(logs(MAIN), "transcript.jsonl"), cwd: repo, hook_event_name: "UserPromptSubmit" });
  assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, "", ""]);
  capture({ session_id: WORKER, transcript_path: join(brain, WORKER, "scratch/notes.jsonl"), cwd: repo, hook_event_name: "UserPromptSubmit" });
  capture({ session_id: WORKER, transcript_path: full(MAIN), cwd: repo, hook_event_name: "UserPromptSubmit" });
  const store = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    const rows = intake.sessions(store.workDb);
    assert.deepEqual(rows.map((s) => [s.host, s.session_id, s.transcript, s.cwd, s.project, s.ended_at]), [["agy", MAIN, full(MAIN), repo, "repo", null]]);
  } finally { store.close(); }
  capture({ session_id: MAIN, transcript_path: join(logs(MAIN), "transcript.jsonl"), cwd: repo, hook_event_name: "SessionEnd" });
  const again = new Store(join(abHome, "store.db"), join(abHome, "index.db"));
  try {
    assert.ok(intake.sessions(again.workDb)[0].ended_at, "Stop 转成的 SessionEnd 记为结束");
  } finally { again.close(); }
});

test("ab doctor 按 agy 根显示日志、可抽数和插件来源", () => {
  const abHome = join(home, "ab-doctor");
  const cli = join(import.meta.dirname, "cli.ts");
  const doctor = () => spawnSync(process.execPath, [cli, "doctor"], { cwd: repo, env: { ...process.env, AB_HOME: abHome, AGENTBRAIN_HOME: abHome, AB_REGISTRY: join(home, "repos"), HOME: home }, encoding: "utf8" }).stdout;
  assert.match(doctor(), /^agy CLI: 日志 [0-9]+（可抽 [0-9]+），已登记 0，只靠 sweep，无法读取$/m);
  const plugin = join(home, ".gemini/config/plugins/agentbrain");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "hooks.json"), "{}");
  assert.match(doctor(), /^agy CLI: 日志 [0-9]+（可抽 [0-9]+），已登记 0，插件在位，无法读取$/m);
});

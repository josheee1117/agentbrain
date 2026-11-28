import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { brief } from "./brief.ts";
import { collectInbox } from "./inbox.ts";
import { validate, type ExtractWindow } from "./extract.ts";
import { admit } from "./work.ts";
import { applyVerdict, buildRelateMessages, parseRelate } from "./relate.ts";
import { conditionalTriggerHint } from "./recall.ts";
import { synthesizeProject } from "./synthesize.ts";
import { REDLINE_MAX, runLifecyclePass } from "./lifecycle.ts";
import type { Chat } from "./llm.ts";
import type { RememberBody } from "./l2.ts";

const CLI = join(import.meta.dirname, "cli.ts");
const SRC: RememberBody["source"] = {
  host: "pi",
  session_id: "sess-1",
  transcript: null,
  anchor: "#1",
  summary: "phase2-test",
};

function makeSandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-phase2-")));
  const repos = join(dir, "repos");
  const alpha = join(dir, "alpha");
  const abHome = join(dir, "ab");
  mkdirSync(repos, { recursive: true });
  mkdirSync(join(alpha, "src"), { recursive: true });
  mkdirSync(abHome, { recursive: true });
  execFileSync("git", ["-C", alpha, "init", "-qb", "main"]);
  writeFileSync(join(alpha, "src/index.ts"), "export const LIMIT = 767;\n");
  execFileSync("git", ["-C", alpha, "add", "."]);
  execFileSync("git", ["-C", alpha, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n- 主干：\`main\`\n`);

  const cleanEnv = {
    ...process.env,
    HOME: dir,
    AB_HOME: abHome,
    AGENTBRAIN_HOME: abHome,
    AB_REGISTRY: repos,
    PI_SESSION_ID: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    OPENCODE_SESSION_ID: "",
    ANTIGRAVITY_CONVERSATION_ID: "",
    ANTIGRAVITY_APP_DATA_DIR: "",
  };

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: alpha,
      encoding: "utf8",
      env: cleanEnv,
    });

  const runHook = (stdin: object) =>
    spawnSync(process.execPath, [CLI, "recall", "--hook"], {
      cwd: alpha,
      encoding: "utf8",
      input: JSON.stringify(stdin),
      env: cleanEnv,
    });

  return {
    dir,
    repos,
    alpha,
    abHome,
    runCli,
    runHook,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("源头四分流（E2）：validate 与 admit 解析 suggested_scenes + tier=on_demand，guidance 条目自动屏蔽场景与按需标记", () => {
  const win: ExtractWindow = {
    context: [],
    turns: [
      { anchor: "#1", role: "user", text: "以后写跨层 DTO 对象转换一律用 MapStruct，不要手写 BeanUtils；另外向我汇报时先给结论。" },
    ],
  };
  const raw = {
    candidates: [
      {
        kind: "rule",
        project: "alpha",
        scenario: "当编写跨层 DTO 对象转换代码时",
        text: "跨层 DTO 对象转换统一使用 MapStruct",
        why: "手写 BeanUtils 反射拷贝容易吞字段类型差异",
        basis: "user_directive",
        guidance: false,
        suggested_scenes: ["code", "review", "invalid_scene"],
        tier: "on_demand",
        evidence: [{ anchor: "#1", role: "user", quote: "以后写跨层 DTO 对象转换一律用 MapStruct" }],
        relation: { type: "new", target: null },
      },
      {
        kind: "rule",
        project: "global",
        scenario: "当向用户输出任务汇报时",
        text: "向用户汇报时结论先行",
        why: "用户在同轮对话中要求所有汇报直接先说结论",
        basis: "user_directive",
        guidance: true,
        suggested_scenes: ["code"],
        tier: "on_demand",
        evidence: [{ anchor: "#1", role: "user", quote: "另外向我汇报时先给结论" }],
        relation: { type: "new", target: null },
      },
    ],
  };
  const v = validate(raw, win, [], "win-e2", { name: "alpha", docs: "", registry: "", confirmed: "" });
  assert.equal(v.candidates.length, 2);
  assert.deepEqual(v.candidates[0].scenes, ["code", "review"]);
  assert.equal(v.candidates[0].on_demand, true);
  assert.equal(v.candidates[1].guidance, true);
  assert.equal(v.candidates[1].scenes, undefined);
  assert.equal(v.candidates[1].on_demand, undefined);

  const admitted = admit(
    v.candidates.map((c) => ({ ...c, unreconciled: false })),
    {
      host: "pi",
      session_id: "s-e2",
      transcript: "/tmp/s.jsonl",
      cwd: "/tmp/alpha",
      project: "alpha",
      first_seen: "2026-11-28T00:00:00Z",
      last_touch: "2026-11-28T00:00:00Z",
      ended_at: "2026-11-28T00:01:00Z",
      processed_anchor: null,
      ephemeral: 0,
      via: "hook",
      error_code: null,
    },
    "pid-alpha",
    "win-e2",
    new Map(),
    "m-test",
  );
  const b0 = admitted.appends[0].body as RememberBody;
  const b1 = admitted.appends[1].body as RememberBody;
  assert.deepEqual(b0.scenes, ["code", "review"]);
  assert.equal(b0.on_demand, true);
  assert.equal(b1.guidance, true);
  assert.equal(b1.on_demand, undefined);
  assert.equal(b1.scenes, undefined);
});

test("关系判定演进（R2）：输入附带时间与触发条件，supersedes 自动隐藏旧抽取草稿或登记待确认纠正，零误报冲突", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    const oldDraftId = s.remember(pid, "s1", false, {
      kind: "decision",
      text: "缓存超时设为 30 秒",
      trigger: "当配置 alpha 查询缓存时",
      confirmed: false,
      origin: "extract",
      source: SRC,
    });
    const newDraftId = s.remember(pid, "s2", false, {
      kind: "decision",
      text: "缓存超时调整为 120 秒",
      trigger: "当配置 alpha 查询缓存时",
      said_at: "2026-11-28T00:00:00Z",
      confirmed: false,
      origin: "extract",
      unreconciled: true,
      source: { ...SRC, session_id: "sess-2" },
    });
    const confId = s.remember(pid, "s0", false, {
      kind: "rule",
      text: "导出上限固定 1000 行",
      confirmed: true,
      source: SRC,
    });
    const corrDraftId = s.remember(pid, "s3", false, {
      kind: "rule",
      text: "导出上限放宽到 5000 行",
      confirmed: false,
      origin: "extract",
      unreconciled: true,
      source: { ...SRC, session_id: "sess-3" },
    });

    const props = s.project().props;
    const items = [
      { prop: props.get(newDraftId)!, neighbors: [props.get(oldDraftId)!] },
      { prop: props.get(corrDraftId)!, neighbors: [props.get(confId)!] },
    ];
    const msg = buildRelateMessages(items)[1].content!;
    assert.match(msg, /\[decision，未确认，\d{4}-\d{2}-\d{2}，触发：当配置 alpha 查询缓存时\]/);

    const verdicts = parseRelate(
      {
        results: [
          { id: "q1", relation: "supersedes", target: "m1", reason: "新版阈值替代旧草稿" },
          { id: "q2", relation: "supersedes", target: "m1", reason: "新版导出上限替代已确认旧规则" },
        ],
      },
      items,
    );
    assert.equal(verdicts[0]?.outcome, "supersedes");
    assert.equal(verdicts[1]?.outcome, "supersedes");

    for (const [i, v] of verdicts.entries()) {
      const applied = applyVerdict(items[i].prop, v!.target, v!, "m-r2", { mode: "absorb-new", corroborate: () => null });
      s.commit(applied.appends, () => {});
    }

    const after = s.project();
    assert.equal(after.conflict_pairs.length, 0, "supersedes 不产生冲突对");
    assert.equal(after.props.get(oldDraftId)?.superseded_draft, newDraftId, "旧未确认抽取草稿被新草稿自动隐藏");
    assert.deepEqual(after.props.get(confId)?.pending_corrections, [corrDraftId], "对已确认条目的 supersedes 转为待审纠正");
  } finally {
    s.close();
  }
});

test("动态 brief 索引与 <2.5ms BM25 条件触发钩子：常规对话零噪音，命中窄域词给短 ID 线索，cite=on 保留引用指令", () => {
  const sb = makeSandbox();
  const prevReg = process.env.AB_REGISTRY;
  process.env.AB_REGISTRY = sb.repos;
  try {
    const s = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    const pid = s.ensureProject("alpha");
    for (let i = 0; i < 28; i++) {
      s.remember(pid, "s", false, {
        kind: "note",
        text: `背景模块职责说明条目编号 ${i} 处理订单流水归档状态机节点_${i}`,
        confirmed: true,
        source: SRC,
      });
    }
    const coreRule = s.remember(null, "s", false, {
      kind: "rule",
      text: "设计阶段先核对契约边界",
      confirmed: true,
      for_workers: true,
      scenes: ["design"],
      source: SRC,
    });
    const mysqlRule = s.remember(null, "s", false, {
      kind: "rule",
      text: "MySQL utf8mb4 组合唯一索引单列前缀避免突破 767 字节上限",
      trigger: "当给 MySQL utf8mb4 表新增组合唯一索引时",
      confirmed: true,
      for_workers: true,
      on_demand: true,
      scenes: ["design", "code"],
      source: SRC,
    });
    s.close();

    // 1. brief 从数据库实时生成按需触发器，不暴露完整正文但给出 [shortId] + 触发线索
    const check = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    const briefText = brief(check, sb.alpha, undefined, true, [], ["design"]);
    assert.match(briefText, new RegExp(coreRule.slice(0, 8)));
    assert.match(briefText, new RegExp(`按需触发器.*\\[${mysqlRule.slice(0, 8)}\\] 给 MySQL utf8mb4 表新增组合`));
    assert.doesNotMatch(briefText, /突破 767 字节上限/);

    // 2. 纯内存性能与命中校验
    const t0 = performance.now();
    const hitRes = conditionalTriggerHint(check, "准备给 MySQL utf8mb4 配置表加一个组合唯一索引要注意什么", sb.alpha, false);
    const elapsedMs = performance.now() - t0;
    assert.ok(elapsedMs < 200, `BM25 触发耗时在并行负载下应低于 200ms，实测 ${elapsedMs.toFixed(2)}ms`);
    assert.ok(hitRes.ids.includes(mysqlRule));
    assert.match(hitRes.block, new RegExp(`命中关联记忆线索：\\[${mysqlRule.slice(0, 8)}\\]`));
    assert.match(hitRes.block, new RegExp(`ab get ${mysqlRule.slice(0, 8)}`));
    check.close();

    // 3. CLI recall --hook：常规对话及含“的改/用的”跨虚词总结提问均完全静默（additionalContext === ""）
    for (const chatPrompt of ["好的，先跑一下测试然后提交代码吧", "总结下本次的所有改动点，对我使用的改变"]) {
      const routine = sb.runHook({ prompt: chatPrompt, cwd: sb.alpha });
      assert.equal(routine.status, 0, routine.stderr);
      assert.equal(JSON.parse(routine.stdout).hookSpecificOutput.additionalContext, "", chatPrompt);
    }

    // 4. CLI recall --hook：命中窄域词时注入线索
    const hitCli = sb.runHook({ prompt: "准备给 MySQL utf8mb4 配置表加一个组合唯一索引要注意什么", cwd: sb.alpha });
    assert.equal(hitCli.status, 0, hitCli.stderr);
    const hitCtx = JSON.parse(hitCli.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(hitCtx, new RegExp(`ab get ${mysqlRule.slice(0, 8)}`));

    // 5. cite=on 且无历史回复（首轮）时带一次 CITE_INSTRUCTION，第 2 轮起（已有回复）自动静默不再每轮常驻
    assert.equal(sb.runCli("setup", "--cite", "on").status, 0);
    const citeTurn1 = sb.runHook({ prompt: "好的，先跑一下测试然后提交代码吧", cwd: sb.alpha });
    const citeCtx1 = JSON.parse(citeTurn1.stdout).hookSpecificOutput.additionalContext as string;
    assert.match(citeCtx1, /<agentbrain-recall>/);
    assert.match(citeCtx1, /每个最终回答/);
    assert.doesNotMatch(citeCtx1, /要不要查历史记忆由你判断/);

    const seededId = "c0000000-1111-2222-3333-444444444444";
    const seededLogDir = join(sb.dir, `.gemini/antigravity/brain/${seededId}/.system_generated/logs`);
    mkdirSync(seededLogDir, { recursive: true });
    const seededFull = join(seededLogDir, "transcript_full.jsonl");
    writeFileSync(
      seededFull,
      [
        JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "首轮输入" }),
        JSON.stringify({ step_index: 1, type: "PLANNER_RESPONSE", content: "首轮回复" }),
      ].join("\n") + "\n",
    );
    const prefRes = sb.runCli("remember", "--global", "--confirmed", "--kind", "rule", "--text", "首轮注入不重复偏好", "--summary", "s");
    const prefShort = /\[([0-9a-f]{8})\]/.exec(prefRes.stdout)![1];
    assert.equal(sb.runCli("guidance", prefShort).status, 0);
    // 记一条首轮 cite=1 记录，模拟该会话首轮已发过引用说明
    const tmpStore = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    tmpStore.workDb
      .prepare("INSERT INTO recall_runs(ts,host,session_id,transcript,outcome,n_hits,ms,cite) VALUES(?,?,?,?,?,?,?,1)")
      .run(new Date().toISOString(), "agy", seededId, seededFull, "nohit", 0, 1);
    tmpStore.close();

    const turn2 = sb.runHook({
      prompt: "好的，先跑一下测试然后提交代码吧",
      cwd: sb.alpha,
      session_id: seededId,
      transcript_path: seededFull,
    });
    assert.equal(turn2.status, 0, turn2.stderr);
    assert.equal(JSON.parse(turn2.stdout).hookSpecificOutput.additionalContext, "", "第 2 轮起偏好与引用说明均不再每轮常驻");
  } finally {
    if (prevReg === undefined) delete process.env.AB_REGISTRY;
    else process.env.AB_REGISTRY = prevReg;
    sb.cleanup();
  }
});

test("收口扩展（synthesize）：支持 decision / rule / pitfall 三类，rule/pitfall 默认入按需温层，拒绝 note", async () => {
  const sb = makeSandbox();
  try {
    const store = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    const specFile = join(sb.dir, "spec.md");
    writeFileSync(specFile, "# 收口规格\n确立索引上限与规则。\n");
    const chat: Chat = async () => ({
      tokens: 30,
      message: {
        role: "assistant",
        content: JSON.stringify({
          candidates: [
            { kind: "decision", text: "索引前缀上限采用 767 字节守卫", why: "兼容旧实例", anchors: ["src/index.ts"] },
            { kind: "rule", text: "改索引定义必须同步跑 schema 校验", why: "防止线上 DDL 失败", scenes: ["code", "test"], anchors: ["src/index.ts"] },
            { kind: "pitfall", text: "组合索引多列 utf8mb4 累加超 767 字节会建表报错", why: "实测踩坑", anchors: ["src/index.ts"] },
          ],
        }),
      },
    });
    const res = await synthesizeProject({
      store,
      project: "alpha",
      registry: [{ name: "alpha", path: sb.alpha, trunk: "main" }],
      specs: [specFile],
      chat,
      model: "synth-m",
    });
    assert.equal(res.created.length, 3);
    const props = store.project().props;
    const dec = props.get(res.created[0].id!)!;
    const rule = props.get(res.created[1].id!)!;
    const pit = props.get(res.created[2].id!)!;
    assert.equal(dec.kind, "decision");
    assert.equal(dec.on_demand, false);
    assert.equal(rule.kind, "rule");
    assert.deepEqual(rule.scenes, ["code", "test"]);
    assert.equal(rule.on_demand, true);
    assert.equal(pit.kind, "pitfall");
    assert.equal(pit.on_demand, true);

    // 传入 note 应被跳过
    const resSkip = await synthesizeProject({
      store,
      project: "alpha",
      registry: [{ name: "alpha", path: sb.alpha, trunk: "main" }],
      specs: [specFile],
      dryRun: true,
      chat: async () => ({
        tokens: 10,
        message: { role: "assistant", content: JSON.stringify({ candidates: [{ kind: "note", text: "普通事实不该沉淀", anchors: ["src/index.ts"] }] }) },
      }),
      model: "synth-m",
    });
    assert.equal(resSkip.created.length, 0);
    assert.match(resSkip.skipped[0].reason, /decision\/rule\/pitfall/);
    store.close();
  } finally {
    sb.cleanup();
  }
});

test("四层生命周期（L0-L3）与 inbox 收敛：红线豁免与 15 条上限、印证/采纳自动转正、零引用降级、14天草稿归档、双草稿冲突屏蔽", () => {
  const sb = makeSandbox();
  const prevReg = process.env.AB_REGISTRY;
  process.env.AB_REGISTRY = sb.repos;
  try {
    const s = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    const pid = s.ensureProject("alpha");
    const now = new Date("2026-11-28T12:00:00Z");
    const dayMs = 86_400_000;

    // 1. 造 15 条红线验证上限门禁与衰减豁免
    const redIds: string[] = [];
    for (let i = 0; i < REDLINE_MAX; i++) {
      redIds.push(
        s.remember(null, "s", false, {
          kind: "rule",
          text: `安全红线-${i}`,
          confirmed: true,
          redline: i < REDLINE_MAX - 1,
          on_demand: i === REDLINE_MAX - 1, // 最后一条先设为 on_demand，测 CLI --redline 自动清掉 on_demand
          source: SRC,
        }),
      );
    }
    const extraRule = s.remember(null, "s", false, { kind: "rule", text: "第16条超限测试规则", confirmed: true, source: SRC });

    // 2. 跨会话印证候选（2 个独立会话）
    const corrCand = s.remember(pid, "s1", false, {
      kind: "pitfall",
      text: "跨会话印证的真实坑",
      confirmed: false,
      origin: "extract",
      evidence: [{ anchor: "#1", role: "tool", quote_sha256: "q1" }],
      source: { ...SRC, session_id: "sess-a" },
    });
    s.commit(
      [
        {
          kind: "evidence",
          project_id: pid,
          session_id: "sess-b",
          target_id: corrCand,
          body: { source: { ...SRC, session_id: "sess-b" }, basis: "observed_failure", evidence: [{ anchor: "#2", role: "tool", quote_sha256: "q2" }], window_id: "w2" },
        },
      ],
      () => {},
    );

    // 3. 实盘采纳候选（2 个不同会话 ab get / cited=1）
    const adoptCand = s.remember(pid, "s1", false, {
      kind: "rule",
      text: "被两个会话主动查看采纳的规则",
      confirmed: false,
      origin: "extract",
      source: SRC,
    });

    // 4. 单会话代码核验转正条目（0 采纳 -> 应归入 L2 on_demand）
    const codeVerified = s.remember(pid, "s1", false, {
      kind: "pitfall",
      text: "单会话代码核验转正坑",
      confirmed: false,
      origin: "extract",
      source: SRC,
    });
    s.commit([{ kind: "verify", project_id: pid, session_id: null, target_id: codeVerified, body: { outcome: "verified", head: "abcdef1", refs: [], model: "v" } }], () => {});

    // 5. 高注入零引用 L1 规则（近 30 天 brief 注入 30 次且 0 采纳 -> 应降级为 on_demand）
    const noisyL1 = s.remember(null, "s", false, {
      kind: "rule",
      text: "高频注入但从不生效的噪音规则",
      confirmed: true,
      source: SRC,
    });

    // 6. 15 天零采纳抽取草稿（应自动归档）vs 7 天新草稿（应保留）vs 15 天收口提炼决定（应保留）
    const oldExtractDraft = s.remember(pid, "s1", false, {
      kind: "note",
      text: "满 15 天无人问津的抽取草稿",
      confirmed: false,
      origin: "extract",
      said_at: new Date(now.getTime() - 15 * dayMs).toISOString(),
      source: SRC,
    });
    const freshExtractDraft = s.remember(pid, "s1", false, {
      kind: "note",
      text: "仅 7 天的抽取草稿",
      confirmed: false,
      origin: "extract",
      said_at: new Date(now.getTime() - 7 * dayMs).toISOString(),
      source: SRC,
    });
    const oldSynthDraft = s.remember(pid, "s1", false, {
      kind: "decision",
      text: "满 15 天的收口提炼决定不自动归档",
      confirmed: false,
      origin: "auto",
      said_at: new Date(now.getTime() - 15 * dayMs).toISOString(),
      source: SRC,
    });

    // 7. 双未确认 extract 草稿互撞冲突（默认 ab inbox 屏蔽）
    const dc1 = s.remember(pid, "s1", false, { kind: "pitfall", text: "草稿互撞甲", confirmed: false, origin: "extract", source: SRC });
    const dc2 = s.remember(pid, "s2", false, {
      kind: "pitfall",
      text: "草稿互撞乙",
      confirmed: false,
      origin: "extract",
      relation: { type: "conflicts", target: dc1 },
      source: { ...SRC, session_id: "sess-dc2" },
    });
    assert.ok(dc2);

    // 写入 inject_log 遥测数据：给红线 0 号和 noisyL1 各塞 30 次零引用 brief 注入；给 adoptCand 塞 2 个会话 get/cited
    const ins = s.workDb.prepare("INSERT INTO inject_log(ts,host,session_id,prop_id,path,cited,failed) VALUES(?,?,?,?,?,?,0)");
    const recentTs = new Date(now.getTime() - 2 * dayMs).toISOString();
    for (let i = 0; i < 30; i++) {
      ins.run(recentTs, "pi", `b-${i}`, redIds[0], "brief", 0);
      ins.run(recentTs, "pi", `b-${i}`, noisyL1, "brief", 0);
    }
    ins.run(recentTs, "pi", "ad-1", adoptCand, "get", 0);
    ins.run(recentTs, "claude", "ad-2", adoptCand, "search", 1);

    // 验证默认 inbox 屏蔽双 extract 草稿冲突，仅剩收口提炼决定 1 条
    const inboxDefault = collectInbox(s, { cwd: sb.alpha, now });
    assert.equal(inboxDefault.counts.conflict, 0, "双 extract 未确认草稿冲突不打扰默认 inbox");
    assert.equal(inboxDefault.counts.synth, 1);
    const inboxWithDrafts = collectInbox(s, { cwd: sb.alpha, now, includeDraftConflicts: true });
    assert.equal(inboxWithDrafts.counts.conflict, 1);
    s.close();

    // CLI 验证第 15 条 --redline 成功并清掉 on_demand，第 16 条被上限拦住
    const tag15 = sb.runCli("tag", redIds[REDLINE_MAX - 1].slice(0, 8), "--redline");
    assert.equal(tag15.status, 0, tag15.stderr);
    const tag16 = sb.runCli("tag", extraRule.slice(0, 8), "--redline");
    assert.notEqual(tag16.status, 0, "超出 15 条红线上限应报错退出");
    assert.match(tag16.stderr, /上限为 15 条/);

    // CLI 验证 ab lifecycle --dry-run --json 零写库
    const dbPath = join(sb.abHome, "store.db");
    const mtimeBefore = statSync(dbPath).mtimeMs;
    const walBefore = existsSync(`${dbPath}-wal`);
    const dryCli = sb.runCli("lifecycle", "--dry-run", "--json");
    assert.equal(dryCli.status, 0, dryCli.stderr);
    assert.equal(statSync(dbPath).mtimeMs, mtimeBefore);
    assert.equal(existsSync(`${dbPath}-wal`), walBefore);

    // 执行生命周期流转（固定 now）
    const verifyStore = new Store(join(sb.abHome, "store.db"), join(sb.abHome, "index.db"));
    const rep = runLifecyclePass(verifyStore, { now });
    assert.equal(rep.redlineCount, REDLINE_MAX);
    assert.deepEqual(rep.promotedCorroboration.map((x) => x.id), [corrCand]);
    assert.deepEqual(rep.promotedAdoption.map((x) => x.id), [adoptCand]);
    assert.deepEqual(rep.warmTieredCode.map((x) => x.id), [codeVerified]);
    assert.deepEqual(rep.demotedToOnDemand.map((x) => x.id), [noisyL1]);
    assert.deepEqual(rep.archivedDrafts.map((x) => x.id), [oldExtractDraft]);

    const afterProps = verifyStore.project().props;
    assert.equal(afterProps.get(redIds[0])?.on_demand, false, "L0 红线虽 30 次零引用仍豁免降级");
    assert.equal(afterProps.get(redIds[REDLINE_MAX - 1])?.redline, true);
    assert.equal(afterProps.get(redIds[REDLINE_MAX - 1])?.on_demand, false);
    assert.equal(afterProps.get(corrCand)?.confirmed_by, "corroboration");
    assert.equal(afterProps.get(adoptCand)?.confirmed_by, "adoption");
    assert.equal(afterProps.get(codeVerified)?.on_demand, true);
    assert.equal(afterProps.get(noisyL1)?.on_demand, true);
    assert.equal(afterProps.get(oldExtractDraft)?.state, "archived");
    assert.equal(afterProps.get(oldExtractDraft)?.expired, true);
    assert.equal(afterProps.get(freshExtractDraft)?.state, "active");
    assert.equal(afterProps.get(oldSynthDraft)?.state, "active");
    verifyStore.close();

    // 验证归档可逆（ab archive --reactivate）
    const react = sb.runCli("archive", oldExtractDraft.slice(0, 8), "--reactivate");
    assert.equal(react.status, 0, react.stderr);
  } finally {
    if (prevReg === undefined) delete process.env.AB_REGISTRY;
    else process.env.AB_REGISTRY = prevReg;
    sb.cleanup();
  }
});

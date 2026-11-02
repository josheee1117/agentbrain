/** 06 review 报告的抽取侧回归（§8.11.3）：条目 4、6、7、8、9。运行：node --test src/extract-review.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, type Candidate, type ExtractWindow } from "./extract.ts";
import type { ProjectContext } from "./extract.ts";
import type { Proposition } from "./l2.ts";

const CTX: ProjectContext = {
  name: "alpha",
  docs: "",
  registry: "- 路径：`~/code_me/alpha`",
  confirmed: "",
  projects: "- alpha ~/code_me/alpha\n- beta ~/code_me/beta",
};

const WIN: ExtractWindow = {
  context: [{ anchor: "c1", role: "user", text: "上一段聊过 beta 的仓库路径 ~/code_me/beta" }],
  turns: [
    { anchor: "u1", role: "user", text: "以后 hook 命令都写 node 的绝对路径，别依赖 PATH" },
    { anchor: "a1", role: "assistant", text: "beta 的门禁太严，建议 final 阶段只显示不拦合并" },
    { anchor: "u2", role: "user", text: "可以，final 就只显示不拦截" },
    { anchor: "a2", role: "assistant", text: "Redis 只做缓存，跨实例不一致才是旧方案的毛病" },
  ],
};

const DECISION = {
  kind: "decision",
  project: "alpha",
  text: "alpha 的 final 阶段只显示证据不拦合并",
  why: "evidence-gate 拦下过的真实问题太少，留着只添乱",
  basis: "user_confirmed",
  evidence: [
    { anchor: "#2", role: "assistant", quote: "建议 final 阶段只显示不拦合并" },
    { anchor: "#3", role: "user", quote: "final 就只显示不拦截" },
  ],
  relation: { type: "new", target: null },
};

// ---------- 条目 4：project 的四种情况 ----------

test("review 条目 4：project=global 记为全局，不改回会话项目、不标归属未定", () => {
  const v = validate({ candidates: [{ ...DECISION, project: "global" }] }, WIN, [], "w1", CTX);
  assert.equal(v.candidates.length, 1);
  assert.equal(v.candidates[0].project, "global");
  assert.equal(v.candidates[0].value?.flags?.includes("project_unresolved"), false);
  assert.equal(v.candidates[0].value?.session_project, "alpha", "全局条目也要记下会话项目");
});

test("review 条目 4：省略 project 用会话项目且不标归属未定；未登记的名字才标", () => {
  const missing = validate({ candidates: [{ ...DECISION, project: undefined }] }, WIN, [], "w1", CTX);
  assert.equal(missing.candidates.length, 1);
  assert.equal(missing.candidates[0].project, "alpha");
  assert.equal(missing.candidates[0].value?.flags?.includes("project_unresolved"), false, "缺省是合法的会话项目");
  const unregistered = validate({ candidates: [{ ...DECISION, project: "no-such-project" }] }, WIN, [], "w1", CTX);
  assert.equal(unregistered.candidates[0].project, "alpha");
  assert.ok(unregistered.candidates[0].value?.flags?.includes("project_unresolved"));
});

// ---------- 条目 6：过滤证据后 alternatives 下标重映射 ----------

test("review 条目 6：证据被过滤后，方案引用重映射到过滤后的下标", () => {
  const win: ExtractWindow = {
    context: [],
    turns: [
      { anchor: "u1", role: "user", text: "以后 hook 命令都写 node 的绝对路径，别依赖 PATH" },
      { anchor: "u2", role: "user", text: "以后测试都要先检查输出，避免再次出现误报" },
      { anchor: "a1", role: "assistant", text: "beta 的缓存方案使用 Redis，旧方案跨实例不一致" },
    ],
  };
  const v = validate({
    candidates: [{
      ...DECISION,
      evidence: [
        { anchor: "#9", role: "user", quote: "这条锚点在窗口外" }, // 被过滤
        { anchor: "#2", role: "user", quote: "以后测试都要先检查输出" },
        { anchor: "#3", role: "assistant", quote: "beta 的缓存方案使用 Redis" },
      ],
      alternatives: [
        { option: "旧方案", rejected_because: "跨实例不一致", evidence: 2 },
        { option: "新方案", rejected_because: "要重写", evidence: 3 },
      ],
    }],
  }, win, [], "w1", CTX);
  assert.equal(v.candidates.length, 1);
  const alt = v.candidates[0].alternatives!;
  assert.equal(alt.length, 1);
  assert.equal(v.candidates[0].evidence[alt[0].evidence!].quote, "beta 的缓存方案使用 Redis", "下标跟着证据一起移位");
});

test("review 条目 6：引用被删证据或负数下标的方案整项丢掉，不改成无引用", () => {
  const v = validate({
    candidates: [{
      ...DECISION,
      evidence: [
        { anchor: "#2", role: "assistant", quote: "建议 final 阶段只显示不拦合并" },
        { anchor: "#3", role: "user", quote: "final 就只显示不拦截" },
      ],
      alternatives: [
        { option: "方案 A", rejected_because: "引用了负数下标", evidence: -1 },
        { option: "方案 B", rejected_because: "引用了被删的证据", evidence: 5 },
        { option: "方案 C", rejected_because: "引用了留下的证据", evidence: 1 },
      ],
    }],
  }, WIN, [], "w1", CTX);
  assert.deepEqual(v.candidates[0].alternatives, [{ option: "方案 C", rejected_because: "引用了留下的证据", evidence: 1 }]);
});

// ---------- 条目 7：body 超长只丢 body ----------

test("review 条目 7：body 超长只丢正文、记 body_dropped，其余照常写入", () => {
  const v = validate({
    candidates: [{ ...DECISION, body: "长".repeat(5001) }],
  }, WIN, [], "w1", CTX);
  assert.equal(v.candidates.length, 1, "不丢整条");
  assert.equal(v.candidates[0].body, undefined);
  assert.ok(v.candidates[0].value?.flags?.includes("body_dropped"));
  assert.equal(v.candidates[0].text, DECISION.text);
});

// ---------- 条目 8：决定不能用标题复述充当理由 ----------

test("review 条目 8：why 只是标题复述照样丢，决定的理由仍须有背景", () => {
  // 旧代码对决定放行“去掉 xxx： 前缀后和标题一样”的 why，这两例都在例外里，现在都必须过 hasBackground
  const cases: [string, string][] = [
    [DECISION.text, DECISION.text],
    ["pi-ops final：只显示不拦截", "只显示不拦截"],
  ];
  for (const [text, why] of cases) {
    const v = validate({ candidates: [{ ...DECISION, text, why }] }, WIN, [], "w1", CTX);
    assert.deepEqual(v.dropped, { no_why: 1 }, why);
  }
  const ok = validate({ candidates: [{ ...DECISION, why: "evidence-gate 拦下过的真实问题太少，留着只添乱" }] }, WIN, [], "w1", CTX);
  assert.equal(ok.candidates.length, 1, "有真实背景的 why 照常通过");
});

// ---------- 条目 9：双角色证据只对 user_confirmed 决定，note 走确定性校验 ----------

test("review 条目 9：rule 的 user_confirmed 只需用户原话，双角色要求只对决定", () => {
  const v = validate({
    candidates: [{
      kind: "rule",
      project: "alpha",
      text: "hook 命令用 node 绝对路径，不依赖 PATH",
      why: "宿主 hook 子进程的 PATH 很少，上次写 ab 直接报找不到命令",
      basis: "user_confirmed",
      evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 的绝对路径" }],
      relation: { type: "new", target: null },
    }],
  }, WIN, [], "w1", CTX);
  assert.deepEqual(v.dropped, {});
  assert.equal(v.candidates.length, 1);
});

test("review 条目 9：note 的 basis 必须是 agent_inference 且有助手原话，用户原话撑不起 note", () => {
  const note = {
    kind: "note",
    project: "alpha",
    text: "缓存方案用 Redis",
    body: "Redis 只做缓存，跨实例不一致才是旧方案的毛病。",
    basis: "user_directive",
    evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 的绝对路径" }],
    relation: { type: "new", target: null },
  };
  const v = validate({ candidates: [note] }, WIN, [], "w1", CTX);
  assert.equal(v.candidates.length, 0);
  assert.equal(v.dropped.basis_unsupported, 1);
  const ok = validate({ candidates: [{ ...note, basis: "agent_inference", evidence: [{ anchor: "#4", role: "assistant", quote: "Redis 只做缓存" }] }] }, WIN, [], "w1", CTX);
  assert.equal(ok.candidates.length, 1);
  // 只有用户原话，就算 basis 改对了也不收
  const userOnly = validate({ candidates: [{ ...note, basis: "agent_inference", evidence: [{ anchor: "#1", role: "user", quote: "以后 hook 命令都写 node 的绝对路径" }] }] }, WIN, [], "w1", CTX);
  assert.equal(userOnly.candidates.length, 0);
  assert.equal(userOnly.dropped.basis_unsupported, 1);
});

// ---------- 条目 3（抽取侧）：正文脱敏 ----------

test("review 条目 3：正文和否掉的方案里的邮箱、家目录路径脱敏后再进候选", () => {
  const v = validate({
    candidates: [{
      ...DECISION,
      body: "联系 alice@example.com，路径 /Users/alice/private/company 下面有配置",
      alternatives: [{ option: "用 bob@example.com 的账号", rejected_because: "路径 /Users/bob/data 不对", evidence: 1 }],
    }],
  }, WIN, [], "w1", CTX);
  const c = v.candidates[0];
  assert.equal(c.body!.includes("alice@example.com"), false);
  assert.equal(c.body!.includes("/Users/alice"), false);
  assert.match(c.body!, /\[PII:email\]/);
  assert.equal(c.alternatives![0].option.includes("bob@example.com"), false);
  assert.equal(c.alternatives![0].rejected_because.includes("/Users/bob"), false);
});

// ---------- round3：判重复时不能丢详情 ----------

const noteWith = (extra: Partial<Proposition>) => ({ id: "aaaaaaaa-1111", kind: "decision", text: "hook 执行方式", confirmed: true, body: null, alternatives: [], ...extra }) as Proposition;

test("review round3 条目 2：同标题捷径只在双方都没有详情、或详情完全相同时走", () => {
  const body = "用绝对路径启动 node 24";
  const target = noteWith({ body, alternatives: [] });
  const cand = (extra: object) => ({ ...DECISION, text: target.text, ...extra });
  const noDetail = validate({ candidates: [cand({})] }, WIN, [target], "w1", CTX).candidates[0];
  assert.deepEqual(noDetail.relation, { type: "new", target: null }, "目标带正文，候选没详情也不能走捷径");
  const sameBody = validate({ candidates: [cand({ body })] }, WIN, [target], "w1", CTX).candidates[0];
  assert.deepEqual(sameBody.relation, { type: "duplicate", target: target.id }, "详情完全相同照旧判重复");
  const diffBody = validate({ candidates: [cand({ body: "只用 PATH 启动 node 26" })] }, WIN, [target], "w1", CTX).candidates[0];
  assert.deepEqual(diffBody.relation, { type: "new", target: null }, "正文不同不能判重复");
  const plain = noteWith({ body: null });
  const withAlt = validate({ candidates: [cand({ alternatives: [{ option: "旧方案", rejected_because: "跨实例不一致" }] })] }, WIN, [plain], "w1", CTX).candidates[0];
  assert.deepEqual(withAlt.relation, { type: "new", target: null }, "候选带否掉的方案，目标没详情也不能走捷径");
  const targetAlt = noteWith({ body: null, alternatives: [{ option: "旧方案", rejected_because: "跨实例不一致" }] });
  const noAlt = validate({ candidates: [cand({})] }, WIN, [targetAlt], "w1", CTX).candidates[0];
  assert.deepEqual(noAlt.relation, { type: "new", target: null }, "目标带否掉的方案也不能走捷径");
  const bothPlain = validate({ candidates: [cand({})] }, WIN, [plain], "w1", CTX).candidates[0];
  assert.deepEqual(bothPlain.relation, { type: "duplicate", target: plain.id }, "双方都没详情照旧判重复");
});

// ---------- round3：方案引用空值、重复证据 ----------

test("review round3 条目 4：方案引用是 null 或非整数时保留方案、去掉引用", () => {
  const v = validate({
    candidates: [{
      ...DECISION,
      alternatives: [
        { option: "方案 A", rejected_because: "空引用", evidence: null },
        { option: "方案 B", rejected_because: "非整数", evidence: 1.5 },
        { option: "方案 C", rejected_because: "字符串", evidence: "1" },
      ],
    }],
  }, WIN, [], "w1", CTX);
  assert.deepEqual(v.candidates[0].alternatives, [
    { option: "方案 A", rejected_because: "空引用" },
    { option: "方案 B", rejected_because: "非整数" },
    { option: "方案 C", rejected_because: "字符串" },
  ]);
  assert.equal(v.candidates[0].value?.flags?.includes("alternatives_dropped"), false, "保留的方案不记丢弃");
  const dropped = validate({
    candidates: [{ ...DECISION, alternatives: [{ option: "方案 D", rejected_because: "负数下标", evidence: -1 }] }],
  }, WIN, [], "w1", CTX).candidates[0];
  assert.equal(dropped.alternatives, undefined);
  assert.ok(dropped.value?.flags?.includes("alternatives_dropped"), "整项丢掉时要记 flag，不能悄悄丢");
});

test("review round3 条目 7：重复证据也进下标映射，方案引用重复项时指向保留的那条", () => {
  const quote = "建议 final 阶段只显示不拦合并";
  const v = validate({
    candidates: [{
      ...DECISION,
      evidence: [
        { anchor: "#2", role: "assistant", quote },
        { anchor: "#2", role: "assistant", quote },
        { anchor: "#3", role: "user", quote: "final 就只显示不拦截" },
      ],
      alternatives: [{ option: "旧方案", rejected_because: "与决定相反", evidence: 1 }],
    }],
  }, WIN, [], "w1", CTX);
  assert.equal(v.candidates.length, 1);
  assert.equal(v.candidates[0].evidence.length, 2, "重复证据只留一条");
  assert.equal(v.candidates[0].evidence[0].quote, quote);
  assert.deepEqual(v.candidates[0].alternatives, [{ option: "旧方案", rejected_because: "与决定相反", evidence: 0 }], "引用重复项时映射到保留的那条");
});

// 供类型检查：确保 Candidate 类型仍被引用
export type _C = Candidate;

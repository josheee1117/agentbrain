import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANCHORS_MAX,
  checkAnchorHead,
  checkAnchors,
  checkRememberBody,
  checkTagBody,
  fold,
  normalizeAnchor,
  parseAnchor,
  type EventRow,
  type RememberBody,
} from "./l2.ts";
import { Store } from "./store.ts";

const SRC: RememberBody["source"] = {
  host: "pi",
  session_id: "s1",
  transcript: null,
  anchor: null,
  summary: "锚点测试",
};

test("parseAnchor 与 normalizeAnchor：合法路径、规范化、中文与跨仓", () => {
  assert.equal(ANCHORS_MAX, 5);
  assert.equal(normalizeAnchor("./src/cli.ts"), "src/cli.ts");
  assert.equal(normalizeAnchor("src//sub\\中文文件.ts"), "src/sub/中文文件.ts");
  assert.equal(normalizeAnchor("  docs/设计/方案.md  "), "docs/设计/方案.md");
  assert.equal(normalizeAnchor("pm:./tools/req"), "pm:tools/req");
  assert.equal(normalizeAnchor("agent-brain_1.0:src/中文/模块.ts"), "agent-brain_1.0:src/中文/模块.ts");

  assert.deepEqual(parseAnchor("src/cli.ts"), { repo: null, path: "src/cli.ts" });
  assert.deepEqual(parseAnchor("pm:tools/req"), { repo: "pm", path: "tools/req" });
});

test("normalizeAnchor 拒绝非法输入、目录、越界、.git、盘符、前导符号与密钥", () => {
  const invalid = [
    "",
    "   ",
    "a\0b",
    "a\nb",
    "a\rb",
    "/abs/path.ts",
    "\\abs\\path.ts",
    "C:\\windows\\file.ts",
    "D:/drive/file.ts",
    "src/dir/",
    "src\\dir\\",
    "-flag.ts",
    "./-flag.ts",
    ":src/cli.ts",
    ".",
    "./.",
    "../escape.ts",
    "src/../escape.ts",
    ".git",
    ".git/config",
    "sub/.git/HEAD",
    "pm:/abs/file.ts",
    "pm:../escape.ts",
    "pm:.git/config",
    "pm:dir/",
    "pm:-dash.ts",
    "pm:a:b.ts",
    "pm:   ",
    ".hidden:src/a.ts",
    "-repo:src/a.ts",
    "bad repo:src/a.ts",
    "sk-1234567890abcdef1234567890abcdef",
  ];
  for (const raw of invalid) {
    assert.throws(() => normalizeAnchor(raw), `应该拒绝: ${JSON.stringify(raw)}`);
  }
});

test("checkAnchors：去重保序、上限 5、[] 合法返回", () => {
  assert.equal(checkAnchors(undefined), undefined);
  assert.deepEqual(checkAnchors([]), []);
  assert.deepEqual(
    checkAnchors(["./src/a.ts", "src/b.ts", "src//a.ts", "pm:./docs/c.md", "pm:docs/c.md"]),
    ["src/a.ts", "src/b.ts", "pm:docs/c.md"],
  );
  assert.deepEqual(checkAnchors(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]), ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  assert.throws(() => checkAnchors(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]));
});

test("checkAnchorHead：7-40 位十六进制，非法报错", () => {
  assert.doesNotThrow(() => checkAnchorHead(undefined));
  assert.doesNotThrow(() => checkAnchorHead("abcdef1"));
  assert.doesNotThrow(() => checkAnchorHead("0123456789abcdef0123456789abcdef01234567"));
  for (const bad of ["", "abc123", "ABCDEF1", "xyz1234", "a".repeat(41)]) {
    assert.throws(() => checkAnchorHead(bad), `应该拒绝 head: ${bad}`);
  }
});

test("checkRememberBody 与 checkTagBody 就地规范化并保留 scenes/guidance 校验", () => {
  const r1: RememberBody = {
    kind: "decision",
    text: "测试决定",
    confirmed: false,
    source: SRC,
    anchors: ["./src/a.ts", "src/a.ts", "src/中文.ts"],
    anchor_head: "1234567",
  };
  checkRememberBody(r1);
  assert.deepEqual(r1.anchors, ["src/a.ts", "src/中文.ts"]);

  const rEmpty: RememberBody = {
    kind: "decision",
    text: "空锚点",
    confirmed: false,
    source: SRC,
    anchors: [],
  };
  checkRememberBody(rEmpty);
  assert.equal(rEmpty.anchors, undefined);

  const tClear = { anchors: [] as string[] };
  checkTagBody(tClear);
  assert.deepEqual(tClear.anchors, []);

  const tValid = { guidance: true, scenes: ["code" as const], anchors: ["./src/x.ts"] };
  checkTagBody(tValid);
  assert.deepEqual(tValid.anchors, ["src/x.ts"]);

  assert.throws(() => checkTagBody({ scenes: ["bogus" as never] }));
  assert.throws(() => checkTagBody({ guidance: "yes" as never }));
  assert.throws(() => checkTagBody({ anchors: ["../bad.ts"] }));
  assert.throws(() => checkTagBody({ anchors: ["src/x.ts"], anchor_head: "bad" }));
});

test("fold() 投影：remember/tag 对 anchors 与 anchor_head 的更新、清空与保留", () => {
  const baseRows: EventRow[] = [
    {
      seq: 1,
      id: "p1",
      ts: "2026-11-26T00:00:00Z",
      kind: "remember",
      project_id: "proj1",
      session_id: null,
      ephemeral: 0,
      target_id: null,
      body: JSON.stringify({
        kind: "decision",
        text: "决定1",
        confirmed: false,
        source: SRC,
        anchors: ["src/a.ts"],
        anchor_head: "1111111",
      } satisfies RememberBody),
    },
    {
      seq: 2,
      id: "t1",
      ts: "2026-11-26T00:01:00Z",
      kind: "tag",
      project_id: "proj1",
      session_id: null,
      ephemeral: 0,
      target_id: "p1",
      body: JSON.stringify({ guidance: true }), // 缺省 anchors：不动
    },
  ];
  let proj = fold(baseRows);
  assert.deepEqual(proj.props.get("p1")?.anchors, ["src/a.ts"]);
  assert.equal(proj.props.get("p1")?.anchor_head, "1111111");

  proj = fold([
    ...baseRows,
    {
      seq: 3,
      id: "t2",
      ts: "2026-11-26T00:02:00Z",
      kind: "tag",
      project_id: "proj1",
      session_id: null,
      ephemeral: 0,
      target_id: "p1",
      body: JSON.stringify({ anchors: ["src/b.ts"] }), // 没传 anchor_head 时保留原 head
    },
  ]);
  assert.deepEqual(proj.props.get("p1")?.anchors, ["src/b.ts"]);
  assert.equal(proj.props.get("p1")?.anchor_head, "1111111");

  proj = fold([
    ...baseRows,
    {
      seq: 3,
      id: "t3",
      ts: "2026-11-26T00:02:00Z",
      kind: "tag",
      project_id: "proj1",
      session_id: null,
      ephemeral: 0,
      target_id: "p1",
      body: JSON.stringify({ anchors: ["src/c.ts"], anchor_head: "2222222" }),
    },
    {
      seq: 4,
      id: "t4",
      ts: "2026-11-26T00:03:00Z",
      kind: "tag",
      project_id: "proj1",
      session_id: null,
      ephemeral: 0,
      target_id: "p1",
      body: JSON.stringify({ anchors: [] }), // 清空 anchors 和 anchor_head
    },
  ]);
  assert.deepEqual(proj.props.get("p1")?.anchors, []);
  assert.equal(proj.props.get("p1")?.anchor_head, null);
});

test("Store lifecycle / lifecycleIf / commit 对 tag 走统一门禁", () => {
  const s = new Store(":memory:", ":memory:");
  try {
    const pid = s.ensureProject("alpha");
    const id = s.remember(pid, null, false, {
      kind: "decision",
      text: "Store 门禁测试",
      confirmed: false,
      source: SRC,
    });
    assert.throws(() => s.lifecycle("tag", id, null, { anchors: ["../bad.ts"] }));
    assert.throws(() => s.lifecycleIf("tag", id, null, { anchors: ["bad/"] }, () => null));
    assert.throws(() =>
      s.commit([{ kind: "tag", project_id: pid, session_id: null, target_id: id, body: { anchors: ["-dash.ts"] } }], () => {}),
    );
    s.lifecycle("tag", id, null, { anchors: ["./src/ok.ts", "src/ok.ts"], anchor_head: "abcdef1" });
    assert.deepEqual(s.project().props.get(id)?.anchors, ["src/ok.ts"]);
    assert.equal(s.project().props.get(id)?.anchor_head, "abcdef1");
  } finally {
    s.close();
  }
});

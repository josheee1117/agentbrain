import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyNotes, BEGIN, END, LEGACY_SECTION, managedBlock, noteTargets, planNotes, planRemove } from "./notes.ts";

const USER_TOP = "# 我的全局指令\n\n- 用中文回答\n\n";
const USER_AFTER = "\n## 其他\n\n- 别动我\n";

test("手写段逐字相同：换成托管块，块外内容一字不变；再跑一次不改", () => {
  const before = USER_TOP + LEGACY_SECTION + "\n" + USER_AFTER;
  const p = planNotes(before, false);
  assert.equal(p.action, "replace-legacy");
  assert.ok(p.next!.startsWith(USER_TOP));
  assert.ok(p.next!.endsWith(USER_AFTER));
  assert.ok(p.next!.includes(managedBlock(false)));
  assert.equal(p.next!.split(BEGIN).length, 2);
  assert.equal(planNotes(p.next!, false).action, "unchanged");
});

test("开关打开时块里多出 ab-used 两条，关掉再变回三条", () => {
  const on = planNotes(USER_TOP + managedBlock(false) + "\n", true);
  assert.equal(on.action, "update");
  assert.match(on.next!, /ab-used: 简短标题 \(id\)/);
  const off = planNotes(on.next!, false);
  assert.equal(off.action, "update");
  assert.doesNotMatch(off.next!, /ab-used/);
  assert.equal(off.next, USER_TOP + managedBlock(false) + "\n");
});

test("手写段被用户改过：不替换，要 --adopt", () => {
  const edited = USER_TOP + LEGACY_SECTION.replace("与现场证据冲突时信现场。", "与现场证据冲突时问我。") + "\n";
  assert.deepEqual(planNotes(edited, false), { action: "needs-adopt", next: null });
  const adopted = planNotes(edited, false, true);
  assert.equal(adopted.action, "adopt");
  assert.doesNotMatch(adopted.next!, /问我/);
  assert.ok(adopted.next!.startsWith(USER_TOP));
});

test("没有手写段的文件追加到末尾，文件不存在则新建；标记不成对不碰", () => {
  const oc = "# OpenCode 全局指令\n\n## pstack\n\n内容\n";
  const p = planNotes(oc, false);
  assert.equal(p.action, "append");
  assert.equal(p.next, oc + "\n" + managedBlock(false) + "\n");
  assert.deepEqual(planNotes(null, false), { action: "create", next: managedBlock(false) + "\n" });
  assert.equal(planNotes(oc + BEGIN + "\n半截\n", false).action, "broken");
});

test("--remove-notes 只删块；用户内容原样保留，不恢复旧手写段", () => {
  const managed = planNotes(USER_TOP + LEGACY_SECTION + "\n" + USER_AFTER, false).next!;
  const r = planRemove(managed);
  assert.equal(r.action, "remove");
  assert.ok(!r.next!.includes("agentbrain"));
  assert.ok(r.next!.startsWith("# 我的全局指令\n\n- 用中文回答\n"));
  assert.ok(r.next!.endsWith("## 其他\n\n- 别动我\n"));
  assert.equal(planRemove("没有块\n").action, "absent");
  const appended = planNotes("# OC\n", false).next!;
  assert.equal(planRemove(appended).next, "# OC\n");
});

test("applyNotes：dry-run 不写；真写先备份原文件，四个宿主各恰好一个块；重复运行不再备份", () => {
  const home = mkdtempSync(join(tmpdir(), "ab-notes-home-"));
  const [claude, codex, pi, oc] = noteTargets(home).map((t) => t.path);
  for (const f of [claude, codex, pi, oc]) mkdirSync(dirname(f), { recursive: true });
  writeFileSync(claude, USER_TOP + LEGACY_SECTION + "\n");
  writeFileSync(codex, LEGACY_SECTION.replace("信现场", "问用户") + "\n");
  writeFileSync(pi, USER_TOP + LEGACY_SECTION + "\n" + USER_AFTER);
  const now = new Date("2026-10-21T04:00:00Z");

  const dry = applyNotes({ cite: false, dryRun: true, adopt: false, remove: false, home, now });
  assert.deepEqual(dry.map((r) => r.action), ["replace-legacy", "needs-adopt", "replace-legacy", "create"]);
  assert.ok(dry[0].diff!.includes("+" + BEGIN));
  assert.equal(existsSync(oc), false, "dry-run 不新建文件");
  assert.equal(readFileSync(claude, "utf8"), USER_TOP + LEGACY_SECTION + "\n");

  const real = applyNotes({ cite: false, dryRun: false, adopt: false, remove: false, home, now });
  assert.deepEqual(real.map((r) => r.wrote), [true, false, true, true]);
  assert.equal(readFileSync(real[0].backup!, "utf8"), USER_TOP + LEGACY_SECTION + "\n", "备份是改前原文");
  assert.equal(real[3].backup, null, "新建的文件没有可备份的原文");
  assert.match(readFileSync(codex, "utf8"), /问用户/, "改过的手写段没被动");
  for (const f of [claude, pi, oc]) {
    const t = readFileSync(f, "utf8");
    assert.equal(t.split(BEGIN).length, 2);
    assert.equal(t.split(END).length, 2);
  }
  const backups = () => readdirSync(dirname(claude)).filter((n) => n.includes(".bak-agentbrain-")).length;
  const n0 = backups();
  const again = applyNotes({ cite: false, dryRun: false, adopt: false, remove: false, home, now: new Date("2026-10-21T05:00:00Z") });
  assert.deepEqual(again.map((r) => r.action), ["unchanged", "needs-adopt", "unchanged", "unchanged"]);
  assert.equal(backups(), n0, "内容不变不写、不备份");

  applyNotes({ cite: false, dryRun: false, adopt: false, remove: true, home, now: new Date("2026-10-21T06:00:00Z") });
  assert.equal(readFileSync(pi, "utf8").includes("agentbrain"), false);
  assert.ok(readFileSync(pi, "utf8").includes("- 别动我"));
});

test("--adopt 只换到下一个一级或二级标题为止，后面的用户内容原样保留", () => {
  const edited = LEGACY_SECTION.replace("信现场", "问我");
  for (const next of ["# 另一个一级标题", "## 另一个二级标题"]) {
    const tail = `${next}\n\n- 用户自己的规则\n`;
    const p = planNotes(edited + "\n\n" + tail, false, true);
    assert.equal(p.action, "adopt");
    assert.ok(p.next!.endsWith(tail), next);
  }
});

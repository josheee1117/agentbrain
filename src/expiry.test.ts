/** 到期复审。运行：node --test src/expiry.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VALID_DAYS, ownClock, reviewList, sourceClock, validDays } from "./expiry.ts";
import { validate, type ExtractWindow } from "./extract.ts";
import { zstdCompressSync } from "node:zlib";
import { rmSync } from "node:fs";

const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };
const DAY = 86_400_000;

function aged(s: Store, id: string, days: number): void {
  s.workDb.prepare("UPDATE events SET ts=? WHERE id=?").run(new Date(Date.now() - days * DAY).toISOString(), id);
}

test("默认有效天数按种类；条目自带 valid_days 时优先", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, "s", false, { kind: "pitfall", text: "a", confirmed: false, source: src });
  const b = s.remember(null, "s", false, { kind: "rule", text: "b", confirmed: false, valid_days: 14, source: src });
  const props = s.project().props;
  assert.equal(validDays(props.get(a)!), DEFAULT_VALID_DAYS.pitfall);
  assert.equal(validDays(props.get(b)!), 14);
});

test("复审清单：只收未确认、active、超期且期间没被注入的；已确认（任何途径）永不进", () => {
  const s = new Store(":memory:", ":memory:");
  const mk = (text: string, confirmed: boolean, days: number, extra: Partial<RememberBody> = {}) => {
    const id = s.remember(null, "s", false, { kind: "pitfall", text, confirmed, source: src, ...extra });
    aged(s, id, days);
    return id;
  };
  const stale = mk("stale", false, 200);
  mk("fresh", false, 10);
  mk("confirmed old", true, 400);
  const corroborated = mk("corroborated old", false, 400);
  s.lifecycle("confirm", corroborated, null, { by: "corroboration", sessions: ["a", "b"] });
  const archived = mk("archived old", false, 400);
  s.lifecycle("archive", archived, null);
  const used = mk("used recently", false, 200);
  s.markUsed([used], new Date(Date.now() - 5 * DAY));
  const shortLived = mk("short", false, 20, { valid_days: 7 });
  const due = reviewList(s.project().props.values(), s.usage(), new Date());
  assert.deepEqual(due.map((d) => d.prop.id), [stale, shortLived]);
  assert.equal(due[0].lastUsed, null);
  assert.ok(due[0].overdueDays >= 109);
  // 很久以前注入过、之后又放了很久：从最近注入起算，仍到期
  s.markUsed([used], new Date(Date.now() - 150 * DAY));
  s.markUsed([used], new Date(Date.now() - 100 * DAY));
  const again = reviewList(s.project().props.values(), s.usage(), new Date());
  assert.ok(again.some((d) => d.prop.id === used));
  assert.equal(s.usage().get(used)!.uses, 3);
});

test("归档走 reason=expired，可 reactivate 撤销；撤销后条目回到 active", () => {
  const s = new Store(":memory:", ":memory:");
  const id = s.remember(null, "s", false, { kind: "note", text: "x", confirmed: false, source: src });
  s.lifecycle("archive", id, null, { reason: "expired" });
  assert.deepEqual([s.project().props.get(id)!.state, s.project().props.get(id)!.expired], ["archived", true]);
  s.lifecycle("reactivate", id, null);
  assert.equal(s.project().props.get(id)!.state, "active");
});

test("抽取器建议的 valid_days：7–730 的整数才采用，否则忽略（不丢候选）", () => {
  const win: ExtractWindow = { context: [], turns: [{ anchor: "t1", role: "tool", text: "Error: node:sqlite 不存在 (node v20)" }] };
  const base = { kind: "pitfall", scope: "project", text: "node 20 没有 node:sqlite", trigger: "跑测试", basis: "observed_failure", evidence: [{ anchor: "#1", role: "tool", quote: "node:sqlite 不存在" }], relation: { type: "new", target: null } };
  const days = [30, 3, 1000, 12.5, "60", undefined];
  const got = days.map((d, i) => validate({ candidates: [{ ...base, text: `${base.text} ${i}`, valid_days: d }] }, win, [], `w${i}`).candidates[0]?.valid_days ?? null);
  assert.deepEqual(got, [30, null, null, null, null, null]);
});

// ---------- 起算时间（eval fix 5）：从原话时间算，"全部重跑"不会把到期挤到同几天 ----------

test("said_at 优先于写入时间：重跑写入的条目按原话时间到期", () => {
  const s = new Store(":memory:", ":memory:");
  const said = new Date(Date.now() - 200 * DAY).toISOString();
  const a = s.remember(null, "s", false, { kind: "pitfall", text: "rerun but old", confirmed: false, said_at: said, source: src });
  const b = s.remember(null, "s", false, { kind: "pitfall", text: "rerun no said_at", confirmed: false, source: src });
  const props = s.project().props;
  assert.equal(ownClock(props.get(a)!), said);
  assert.deepEqual(reviewList(props.values(), s.usage(), new Date()).map((d) => d.prop.id), [a]);
  assert.ok(!reviewList(props.values(), s.usage(), new Date()).some((d) => d.prop.id === b));
});

test("旧条目没有 said_at：读路径用来源 transcript 的会话开始时间，而不是重跑写入时间", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-clock-"));
  const file = join(dir, "s.jsonl");
  const start = new Date(Date.now() - 120 * DAY).toISOString();
  writeFileSync(file, JSON.stringify({ type: "session", timestamp: start }) + "\n");
  const s = new Store(":memory:", ":memory:");
  const id = s.remember(null, "s", false, { kind: "pitfall", text: "legacy", confirmed: false, source: { ...src, transcript: file } });
  const nofile = s.remember(null, "s", false, { kind: "pitfall", text: "legacy missing file", confirmed: false, source: { ...src, transcript: join(dir, "gone.jsonl") } });
  const clock = sourceClock();
  const p = s.project().props.get(id)!;
  assert.equal(clock(p), start);
  assert.equal(clock(s.project().props.get(nofile)!), s.project().props.get(nofile)!.ts);
  assert.deepEqual(reviewList(s.project().props.values(), s.usage(), new Date(), clock).map((d) => d.prop.id), [id]);
  assert.equal(reviewList(s.project().props.values(), s.usage(), new Date()).length, 0);
});

test("抽取时把证据所在轮的时间记成 said_at（取最晚一条证据）", () => {
  const win: ExtractWindow = { context: [], turns: [
    { anchor: "t1", role: "tool", text: "Error: node:sqlite 不存在 (node v20)", ts: "2026-09-01T00:00:00.000Z" },
    { anchor: "t2", role: "tool", text: "Error: 还是 node:sqlite 不存在", ts: "2026-09-02T00:00:00.000Z" },
  ] };
  const c = { kind: "pitfall", scope: "project", text: "node 20 没有 node:sqlite", trigger: "跑测试", basis: "observed_failure", evidence: [{ anchor: "#1", role: "tool", quote: "node:sqlite 不存在" }, { anchor: "#2", role: "tool", quote: "还是 node:sqlite 不存在" }], relation: { type: "new", target: null } };
  assert.equal(validate({ candidates: [c] }, win, [], "w-said").candidates[0].said_at, "2026-09-02T00:00:00.000Z");
});

test("sourceClock（§7.6）：缓存键用解析后的路径，.jsonl 与 .jsonl.zst 同源", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-clock-zst-"));
  const start = new Date(Date.now() - 120 * DAY).toISOString();
  const plain = join(dir, "s.jsonl");
  writeFileSync(plain, JSON.stringify({ type: "session", timestamp: start }) + "\n");
  const s = new Store(":memory:", ":memory:");
  const id = s.remember(null, "s", false, { kind: "pitfall", text: "legacy", confirmed: false, source: { ...src, transcript: plain } });
  const clock = sourceClock();
  assert.equal(clock(s.project().props.get(id)!), start);
  // 同一份 transcript 变成只剩 .zst：解析后的路径相同，两个条目拿到同一会话开始时间
  writeFileSync(plain + ".zst", zstdCompressSync(Buffer.from(JSON.stringify({ type: "session", timestamp: start }) + "\n", "utf8")));
  rmSync(plain);
  const id2 = s.remember(null, "s", false, { kind: "pitfall", text: "legacy zst", confirmed: false, source: { ...src, transcript: plain + ".zst" } });
  assert.equal(clock(s.project().props.get(id2)!), start);
});

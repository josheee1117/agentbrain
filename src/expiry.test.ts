/** 到期复审。运行：node --test src/expiry.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { DEFAULT_VALID_DAYS, reviewList, validDays } from "./expiry.ts";
import { validate, type ExtractWindow } from "./extract.ts";

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

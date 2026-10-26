/** 去掉候选区（§8.8）的验收：旧候选、旧 stage/curate 事件重放后都是有效的未确认条目，能搜到、能被每轮召回，可信程度单独一栏。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import type { RememberBody } from "./l2.ts";
import { recall } from "./recall.ts";
import { recallable, searchable, trustOf } from "./visibility.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-vis-")));
const repos = join(dir, "repos");
const alpha = join(dir, "alpha");
for (const d of [repos, alpha]) mkdirSync(d, { recursive: true });
writeFileSync(join(repos, "alpha.md"), `- 路径：\`${alpha}\`\n`);
process.env.AB_REGISTRY = repos;
const src: RememberBody["source"] = { host: "pi", session_id: "s", transcript: null, anchor: null, summary: "讨论" };

// 真实案例 35670cf8 的正文与 why（10-22 pi 会话抽出，旧版本写成了候选）
const SLS = {
  kind: "pitfall" as const,
  text: "不要改用长期 AccessKey，先修 aliyun CLI 的自动刷新链路：MCP 刷新时会调 aliyun sls list-project --cli-dry-run，需安装 aliyun-cli-sls 插件，并把 ~/.aliyun/config.json 的 region_id 从 0 改成实际地域",
  why: "用户用 aliyun configure --mode OAuth 登录，凭证过期后 SLS MCP 查不了日志",
  confirmed: false,
  origin: "extract" as const,
  basis: "observed_failure" as const,
  candidate: true, // 旧版本写下的候选标记
  source: src,
};

test("旧版本写的候选：重放后是有效的未确认条目，全文检索能搜到，标未确认", async () => {
  const s = new Store(":memory:", ":memory:");
  s.ensureProject("alpha");
  const id = s.remember(null, "s", false, SLS);
  const p = s.project().props.get(id)!;
  assert.equal(p.state, "active");
  assert.equal(trustOf(p), "unconfirmed");
  assert.ok(searchable(p));
  const hits = s.search("aliyun configure OAuth 登录", { projects: "all", includeGlobal: true, limit: 8 });
  assert.ok(hits.some((h) => h.id === id), "why 里的 OAuth 登录能搜到");
});

test("旧版本写的候选：相关提问时被每轮召回，标（未确认）", async () => {
  const s = new Store(":memory:", ":memory:");
  s.ensureProject("alpha");
  const id = s.remember(null, "s", false, SLS);
  assert.ok(recallable(s.project().props.get(id)!, false));
  const out = await recall(s, "SLS MCP 凭证过期 aliyun 自动刷新 region_id 怎么修", alpha, () => null);
  assert.match(out, new RegExp(`\\[${id.slice(0, 8)}\\]`));
  assert.match(out, /未确认/);
});

test("旧 stage / curate 事件重放时不改状态：条目保持有效；归档后恢复也是有效", () => {
  const s = new Store(":memory:", ":memory:");
  const a = s.remember(null, "s", false, { kind: "rule", text: "被 stage 过的规则", confirmed: false, source: src });
  s.lifecycle("stage", a, null, { action: "stage", reason: "agent_remember" });
  const c = s.remember(null, "s", false, { kind: "rule", text: "被 curate 转正又撤销的规则", confirmed: false, candidate: true, source: src });
  s.lifecycle("curate", c, null, { action: "promote", run: "r" });
  s.lifecycle("curate", c, null, { action: "unpromote", run: "r" });
  s.lifecycle("archive", c, null);
  s.lifecycle("reactivate", c, null);
  const props = s.project().props;
  assert.equal(props.get(a)!.state, "active");
  assert.equal(props.get(c)!.state, "active");
});

test("可信程度：用户确认 / 代码核验 / 跨会话印证 / 未确认 各归一类；有争议的不进召回但能搜到", () => {
  const s = new Store(":memory:", ":memory:");
  const u = s.remember(null, "s", false, { kind: "rule", text: "用户确认的", confirmed: true, source: src });
  const n = s.remember(null, "s", false, { kind: "rule", text: "未确认的", confirmed: false, source: src });
  const k = s.remember(null, "s", false, { kind: "rule", text: "关系未判定的", confirmed: false, unreconciled: true, source: src });
  s.lifecycle("confirm", n, null, { by: "corroboration" });
  const props = s.project().props;
  assert.equal(trustOf(props.get(u)!), "user");
  assert.equal(trustOf(props.get(n)!), "corroboration");
  assert.equal(trustOf(props.get(k)!), "unconfirmed");
  assert.ok(searchable(props.get(k)!));
  assert.equal(recallable(props.get(k)!, false), false);
});

test("升级时旧版本留下的全文索引（候选标成 candidate）作废重建：不用等下一次写库就能搜到", () => {
  const s = new Store(":memory:", ":memory:");
  const id = s.remember(null, "s", false, SLS);
  assert.ok(s.search("aliyun configure OAuth", { projects: "all", includeGlobal: true, limit: 8 }).some((h) => h.id === id));
  const fts = (s as any).fts;
  fts.prepare("UPDATE props SET state='candidate' WHERE id=?").run(id); // 旧版本写下的索引行
  fts.exec("DELETE FROM meta WHERE key='index_version'"); // 旧版本没有这个键
  assert.ok(s.search("aliyun configure OAuth", { projects: "all", includeGlobal: true, limit: 8 }).some((h) => h.id === id));
});

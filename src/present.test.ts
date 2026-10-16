/** 搜索结果显示全文（§11.5 (ii)）。运行：node --test src/present.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchDetail, SEARCH_WHY_MAX_CHARS } from "./present.ts";

test("searchDetail：正文全部打印（后续行缩进），为什么最多 200 字，有场景才打场景行", () => {
  assert.equal(
    searchDetail("改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码", { why: "上次 e2e 全绿但页面没变，查了半小时才发现 dev server 没热更新到构建产物", value: { scenario: "当改完前端代码要跑 e2e 时", flags: [] } }),
    "改了前端 UI 后要先重启 dev server 再跑 e2e，否则测的是旧代码\n  为什么: 上次 e2e 全绿但页面没变，查了半小时才发现 dev server 没热更新到构建产物\n  场景: 当改完前端代码要跑 e2e 时",
  );
  assert.equal(searchDetail("第一行\n第二行", undefined), "第一行\n  第二行");
  assert.equal(searchDetail("只有正文", { why: undefined, trigger: "配置 hook 时", value: undefined }), "只有正文\n  场景: 配置 hook 时", "没有 value.scenario 时用 trigger");
  const long = searchDetail("x", { why: "因".repeat(300) });
  assert.equal(long, `x\n  为什么: ${"因".repeat(SEARCH_WHY_MAX_CHARS)}…`);
});

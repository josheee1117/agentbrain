import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, readKey } from "./embed.ts";
import { chatChain, chatClient, EXTRACT_KEYCHAIN_SERVICE, fallbackChat, loadChatConfig, WorkFailure, type Chat } from "./llm.ts";

const base = mkdtempSync(join(tmpdir(), "ab-llm-"));
const EMB = { baseUrl: "https://dashscope.example/compatible-mode/v1", model: "text-embedding-v4" };

function home(files: Record<string, unknown>): string {
  const h = mkdtempSync(join(base, "home-"));
  for (const [name, v] of Object.entries(files)) writeFileSync(join(h, name), typeof v === "string" ? v : JSON.stringify(v));
  return h;
}

test("extract.json 自带 baseUrl：用它，key 读 agentbrain-extract；不需要 embedding.json", () => {
  const h = home({ "extract.json": { baseUrl: "https://agentrouter.org/v1", model: "deepseek-v4-flash" } });
  assert.deepEqual(loadChatConfig(h), { baseUrl: "https://agentrouter.org/v1", model: "deepseek-v4-flash", keyService: EXTRACT_KEYCHAIN_SERVICE });
  assert.equal(EXTRACT_KEYCHAIN_SERVICE, "agentbrain-extract");
});

test("extract.json 的 extraBody 原样带进配置，不是对象就报错", () => {
  const h = home({ "extract.json": { baseUrl: "https://x/v1", model: "m", keyService: "k", extraBody: { reasoning_effort: "max" } } });
  assert.deepEqual(loadChatConfig(h), { baseUrl: "https://x/v1", model: "m", keyService: "k", extraBody: { reasoning_effort: "max" } });
  for (const bad of ["max", null, ["max"]]) {
    assert.match((loadChatConfig(home({ "extract.json": { baseUrl: "https://x/v1", model: "m", extraBody: bad } })) as { error: string }).error, /extraBody 必须是对象/);
  }
});

test("extract.json 没有 baseUrl：沿用 embedding 的 baseUrl 与 agentbrain-embedding 的 key", () => {
  const h = home({ "extract.json": { model: "qwen-flash" }, "embedding.json": EMB });
  assert.deepEqual(loadChatConfig(h), { baseUrl: EMB.baseUrl, model: "qwen-flash", keyService: KEYCHAIN_SERVICE });
  assert.equal(KEYCHAIN_SERVICE, "agentbrain-embedding");
});

test("配置错误都返回 error、不抛", () => {
  assert.match((loadChatConfig(home({})) as { error: string }).error, /extract\.json/);
  assert.match((loadChatConfig(home({ "extract.json": "{oops" })) as { error: string }).error, /合法 JSON/);
  assert.match((loadChatConfig(home({ "extract.json": { baseUrl: "https://x/v1" } })) as { error: string }).error, /缺 model/);
  assert.match((loadChatConfig(home({ "extract.json": { baseUrl: "", model: "m" } })) as { error: string }).error, /baseUrl/);
  assert.match((loadChatConfig(home({ "extract.json": { baseUrl: 42, model: "m" } })) as { error: string }).error, /baseUrl/);
  assert.match((loadChatConfig(home({ "extract.json": { model: "m" } })) as { error: string }).error, /沿用 embedding/);
});

test("readKey 按 service 查钥匙串，默认仍是 agentbrain-embedding", () => {
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  // 假 security：按 -s 参数返回不同 key，未知 service 失败
  writeFileSync(
    join(bin, "security"),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-s" ] && svc="$2"; shift; done\ncase "$svc" in\n  agentbrain-extract) echo extract-key ;;\n  agentbrain-embedding) echo embed-key ;;\n  *) exit 44 ;;\nesac\n`,
  );
  chmodSync(join(bin, "security"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${bin}:${old}`;
  try {
    assert.equal(readKey(), "embed-key");
    assert.equal(readKey("agentbrain-embedding"), "embed-key");
    assert.equal(readKey("agentbrain-extract"), "extract-key");
    assert.deepEqual(readKey("nope"), { error: "钥匙串里没有 nope" });
  } finally {
    process.env.PATH = old;
  }
});

test("chatClient 打到 <baseUrl>/chat/completions，带 Bearer key", async () => {
  let seen: { url?: string; auth?: string; model?: string } = {};
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, model: JSON.parse(body).model };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }], usage: { total_tokens: 7 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const chat = chatClient({ baseUrl: `http://127.0.0.1:${port}/v1/`, model: "deepseek-v4-flash", keyService: EXTRACT_KEYCHAIN_SERVICE }, "k1", 5000);
    const r = await chat([{ role: "user", content: "hi" }]);
    assert.equal(r.tokens, 7);
    assert.deepEqual(seen, { url: "/v1/chat/completions", auth: "Bearer k1", model: "deepseek-v4-flash" });
  } finally {
    server.close();
  }
});

test("chatClient 不给超时就不带中止信号（抽取不设超时，用户 2026-10-30）", async () => {
  let signal: AbortSignal | null | undefined = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    signal = init.signal;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }], usage: { total_tokens: 1 } }));
  }) as typeof fetch;
  const chat = chatClient({ baseUrl: "http://x/v1", model: "m", keyService: EXTRACT_KEYCHAIN_SERVICE }, "k", undefined, fetchImpl);
  await chat([{ role: "user", content: "hi" }]);
  assert.equal(signal, undefined);
});

test("fallbacks 按顺序解析，每项 model 与 baseUrl 必填；keyService 缺省 agentbrain-extract", () => {
  const full = {
    model: "cn:main",
    baseUrl: "http://127.0.0.1:7864/v1",
    keyService: "agentbrain-extract-cn",
    extraBody: { reasoning_effort: "max" },
    fallbacks: [
      { model: "deepseek-v4.1-flash-1017-tx", baseUrl: "http://127.0.0.1:8317/v1", keyService: "codex-cpa-local-api-key", extraBody: { reasoning_effort: "max" } },
      { model: "backup", baseUrl: "http://127.0.0.1:9999/v1" },
    ],
  };
  const cfg = loadChatConfig(home({ "extract.json": full })) as Exclude<ReturnType<typeof loadChatConfig>, { error: string }>;
  assert.deepEqual(cfg.fallbacks, [
    { model: "deepseek-v4.1-flash-1017-tx", baseUrl: "http://127.0.0.1:8317/v1", keyService: "codex-cpa-local-api-key", extraBody: { reasoning_effort: "max" } },
    { model: "backup", baseUrl: "http://127.0.0.1:9999/v1", keyService: EXTRACT_KEYCHAIN_SERVICE },
  ]);
  // 老配置零改动：没有 fallbacks 时结果与以前逐字相同
  assert.deepEqual(loadChatConfig(home({ "extract.json": { baseUrl: "https://x/v1", model: "m" } })), { baseUrl: "https://x/v1", model: "m", keyService: EXTRACT_KEYCHAIN_SERVICE });
});

test("fallbacks 配置错误都返回 error、不抛，点名第几项哪个字段", () => {
  const bad = (fallbacks: unknown) => (loadChatConfig(home({ "extract.json": { baseUrl: "https://x/v1", model: "m", fallbacks } })) as { error: string }).error;
  assert.match(bad({}), /fallbacks 必须是数组/);
  assert.match(bad([{ baseUrl: "http://y/v1" }]), /fallbacks\[0\] 缺 model/);
  assert.match(bad([{ model: "b" }]), /fallbacks\[0\] 的 baseUrl 不是非空字符串/);
  assert.match(bad([{ model: "b", baseUrl: "" }]), /fallbacks\[0\] 的 baseUrl 不是非空字符串/);
  assert.match(bad([{ model: "b", baseUrl: "http://y/v1", keyService: 7 }]), /fallbacks\[0\] 的 keyService 不是非空字符串/);
  assert.match(bad([{ model: "b", baseUrl: "http://y/v1", extraBody: ["x"] }]), /fallbacks\[0\] 的 extraBody 必须是对象/);
  assert.match(bad([{ model: "b", baseUrl: "http://y/v1" }, { model: "c", baseUrl: "http://z/v1", extraBody: null }]), /fallbacks\[1\] 的 extraBody 必须是对象/);
  assert.match(bad(["oops"]), /fallbacks\[0\] 必须是对象/);
});

/** 假渠道：记下被调用的是哪个模型；throwWith 给了就先抛这个 WorkFailure。 */
function channel(name: string, log: string[], throwWith?: WorkFailure, content = "{\"ok\":true}"): Chat {
  return async () => {
    log.push(name);
    if (throwWith) throw throwWith;
    return { message: { role: "assistant" as const, content }, tokens: 7, model: "actual-" + name };
  };
}

for (const code of ["http_error", "http_429", "network", "timeout"] as const) {
  test(`fallbackChat：主渠道 ${code} 换下一个，返回备用结果和备用模型`, async () => {
    const log: string[] = [];
    const chat = fallbackChat([channel("main", log, new WorkFailure(code, "主渠道挂了")), channel("backup", log)]);
    const r = await chat([{ role: "user", content: "hi" }]);
    assert.deepEqual(log, ["main", "backup"]);
    assert.equal(r.model, "actual-backup");
  });
}

test("fallbackChat：备用也失败就继续往后试，全部失败抛最后一个错误", async () => {
  const log: string[] = [];
  const last = new WorkFailure("timeout", "备用也超时");
  const chat = fallbackChat([channel("a", log, new WorkFailure("http_error", "a 挂了")), channel("b", log, new WorkFailure("network", "b 也挂了")), channel("c", log, last)]);
  await assert.rejects(
    () => chat([{ role: "user", content: "hi" }]),
    (e: unknown) => e === last,
  );
  assert.deepEqual(log, ["a", "b", "c"]);
});

test("fallbackChat：invalid_output 及其他错误不切换，直接抛", async () => {
  for (const code of ["invalid_output", "no_key", "no_config", "embed_unavailable"] as const) {
    const log: string[] = [];
    const boom = new WorkFailure(code, "不该换渠道");
    const chat = fallbackChat([channel("main", log, boom), channel("backup", log)]);
    await assert.rejects(
      () => chat([{ role: "user", content: "hi" }]),
      (e: unknown) => e === boom,
    );
    assert.deepEqual(log, ["main"], `${code} 时不应喊备用`);
  }
});

test("fallbackChat：只有主渠道时行为不变，原样返回结果", async () => {
  const seen: string[] = [];
  const r = await fallbackChat([channel("only", seen)])([{ role: "user", content: "hi" }]);
  assert.deepEqual(seen, ["only"]);
  assert.equal(r.model, "actual-only");
  assert.equal(r.tokens, 7);
});

test("fallbackChat：主渠道成功后不再喊备用", async () => {
  const log: string[] = [];
  const r = await fallbackChat([channel("main", log), channel("backup", log)])([{ role: "user", content: "hi" }]);
  assert.deepEqual(log, ["main"]);
  assert.equal(r.model, "actual-main");
});

test("chatClient 返回实际用的模型，供产出记录写真实模型", async () => {
  const chat = chatClient({ baseUrl: "http://x/v1", model: "cn:deepseek", keyService: "k" }, "k", undefined, (async () =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }], usage: { total_tokens: 1 } }))) as typeof fetch);
  assert.equal((await chat([{ role: "user", content: "hi" }])).model, "cn:deepseek");
});

test("chatChain：备用渠道读不到 key 就跳过它；主渠道读不到 key 仍是 no_key", async () => {
  const cfg = {
    baseUrl: "http://main/v1",
    model: "main-m",
    keyService: "main-svc",
    fallbacks: [
      { baseUrl: "http://fb1/v1", model: "fb1-m", keyService: "no-such-svc" },
      { baseUrl: "http://fb2/v1", model: "fb2-m", keyService: "fb2-svc" },
    ],
  };
  const keychain: Record<string, string> = { "main-svc": "k1", "fb2-svc": "k2" };
  const keyOf = (s: string): string | { error: string } => keychain[s] ?? { error: `钥匙串里没有 ${s}` };
  const built: string[] = [];
  const makeChat = (c: { model: string }, _k: string): Chat => {
    built.push(c.model);
    return async () => {
      if (c.model === "main-m") throw new WorkFailure("http_error", "主渠道 500");
      return { message: { role: "assistant", content: "{}" }, tokens: 1, model: c.model };
    };
  };
  const chain = chatChain(cfg, keyOf, makeChat);
  assert.ok(!("error" in chain));
  assert.deepEqual(built, ["main-m", "fb2-m"], "fb1 读不到 key，不建 client");
  assert.equal(chain.model, "main-m");
  assert.equal((await chain.chat([{ role: "user", content: "hi" }])).model, "fb2-m", "跳到下一个有 key 的备用");

  const noMain = chatChain({ ...cfg, keyService: "no-such-svc" }, keyOf, makeChat);
  assert.deepEqual(noMain, { error: "no_key", message: "钥匙串里没有 no-such-svc" });
});

test("chatChain：没有 fallbacks 时与以前一致（单渠道，带 model）", async () => {
  const chain = chatChain({ baseUrl: "http://main/v1", model: "m", keyService: "s" }, () => "k", (c) => async () => ({
    message: { role: "assistant", content: "{}" },
    tokens: 1,
    model: c.model,
  }));
  assert.ok(!("error" in chain));
  assert.equal(chain.model, "m");
  assert.equal((await chain.chat([{ role: "user", content: "hi" }])).model, "m");
});

test.after(() => rmSync(base, { recursive: true, force: true }));

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE, readKey } from "./embed.ts";
import { chatClient, EXTRACT_KEYCHAIN_SERVICE, loadChatConfig } from "./llm.ts";

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

test.after(() => rmSync(base, { recursive: true, force: true }));

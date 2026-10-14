/**
 * embedding。运行：node --test src/embed.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosine, embed, fromBlob, loadEmbedConfig, toBlob, type EmbedConfig } from "./embed.ts";

const cfg: EmbedConfig = { baseUrl: "https://example.test/v1/", model: "text-embedding-v4" };
const KEY = "sk-test-secret";

/** 假接口：按批回向量，data 顺序故意打乱，靠 index 还原。 */
function fakeFetch(calls: { url: string; n: number }[]): typeof fetch {
  return (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    calls.push({ url: String(url), n: body.input.length });
    const data = body.input.map((t, index) => ({
      index,
      embedding: [index, t.length, 1],
    }));
    data.reverse();
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}

test("23 条分成 10/10/3，结果顺序与输入一致", async () => {
  const texts = Array.from({ length: 23 }, (_, i) => `t${i}`);
  const calls: { url: string; n: number }[] = [];
  const out = await embed(texts, cfg, KEY, { fetch: fakeFetch(calls) });
  assert.deepEqual(calls.map((c) => c.n), [10, 10, 3]);
  assert.ok(calls.every((c) => c.url === "https://example.test/v1/embeddings"));
  assert.equal(out.length, 23);
  out.forEach((v, i) => assert.deepEqual([...v], [i % 10, texts[i].length, 1]));
});

test("空输入不请求", async () => {
  let called = false;
  const out = await embed([], cfg, KEY, {
    fetch: (() => {
      called = true;
      return Promise.resolve(new Response(""));
    }) as typeof fetch,
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("HTTP 400 抛错且消息不含 key", async () => {
  const fetch400 = (async () =>
    new Response(JSON.stringify({ error: { message: "batch too large" } }), { status: 400 })) as typeof fetch;
  await assert.rejects(embed(["a"], cfg, KEY, { fetch: fetch400 }), (e: Error) => {
    assert.match(e.message, /HTTP 400/);
    assert.match(e.message, /batch too large/);
    assert.equal(e.message.includes(KEY), false);
    return true;
  });
});

test("data 长度不符抛错", async () => {
  const short = (async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 })) as typeof fetch;
  await assert.rejects(embed(["a", "b"], cfg, KEY, { fetch: short }), /期望 2/);
});

test("toBlob/fromBlob 往返一致，含非对齐偏移", () => {
  const v = Float32Array.from([1.5, -2, 0, 3.25]);
  const blob = toBlob(v);
  assert.deepEqual(fromBlob(blob), v);
  const padded = new Uint8Array(blob.byteLength + 1);
  padded.set(blob, 1);
  assert.deepEqual(fromBlob(padded.subarray(1)), v);
});

test("cosine：相同为 1，正交为 0，零向量为 0，维度不同抛错", () => {
  assert.equal(cosine(Float32Array.from([1, 2, 3]), Float32Array.from([1, 2, 3])), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 5])), 0);
  assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 2])), 0);
  assert.throws(() => cosine(Float32Array.from([1]), Float32Array.from([1, 2])), /维度不同/);
});

test("loadEmbedConfig：缺文件、坏 JSON、缺字段返回 error，合法文件返回配置", () => {
  const d = mkdtempSync(join(tmpdir(), "ab-embed-"));
  try {
    assert.match((loadEmbedConfig(d) as { error?: string }).error ?? "", /没有/);
    writeFileSync(join(d, "embedding.json"), "{");
    assert.match((loadEmbedConfig(d) as { error?: string }).error ?? "", /JSON/);
    writeFileSync(join(d, "embedding.json"), JSON.stringify({ baseUrl: "https://x" }));
    assert.match((loadEmbedConfig(d) as { error?: string }).error ?? "", /model/);
    writeFileSync(join(d, "embedding.json"), JSON.stringify({ baseUrl: " https://x ", model: "" }));
    assert.match((loadEmbedConfig(d) as { error?: string }).error ?? "", /model/);
    writeFileSync(join(d, "embedding.json"), JSON.stringify({ baseUrl: "https://x/v1", model: "m" }));
    assert.deepEqual(loadEmbedConfig(d), { baseUrl: "https://x/v1", model: "m" });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

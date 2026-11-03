/** 运行：node --test src/sanitize.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasSecret, sanitize, secretKinds } from "./sanitize.ts";

test("常见秘密换成带类型的占位符，计数只记类型", () => {
  const r = sanitize("key sk-abcdefghijklmnop1234 和 ghp_abcdefghijklmnopqrstuvwxyz0123 还有 Authorization: Bearer abcdefghijklmnopqrstu");
  assert.equal(r.text, "key [SECRET:api_key] 和 [SECRET:api_key] 还有 Authorization: [SECRET:bearer]");
  assert.deepEqual(r.hits, { api_key: 2, bearer: 1 });
  assert.equal(hasSecret(r), true);
});

test("key=value 形态只打码值；短值是说明文字，不打码", () => {
  assert.equal(sanitize('"ANTHROPIC_AUTH_TOKEN": "cr_0123456789abcdef"').text, '"ANTHROPIC_AUTH_TOKEN": "[SECRET:credential]"');
  assert.equal(sanitize("password=hunter2hunter2").text, "password=[SECRET:credential]");
  assert.equal(sanitize("token=1 只是例子").text, "token=1 只是例子");
});

test("环境变量占位符和算法公式不算密钥（导入不再丢这两段正文）", () => {
  const yml = "        access-key-secret: ${OSS_SK_SURVEY}";
  const formula = "- 公式：`token = SHA256(纯净URL + 过期时间 + 密钥)`";
  assert.deepEqual(sanitize(yml), { text: yml, hits: {} });
  assert.deepEqual(sanitize(formula), { text: formula, hits: {} });
  assert.deepEqual(secretKinds(yml), []);
  assert.deepEqual(secretKinds(formula), []);
});

test("credential 只放行 ${ 占位符和算法调用，其他值照旧拦截", () => {
  for (const v of ["${OSS_SK_SURVEY}", "SHA256(abc", "md5(abc", "HMAC-SHA256(k", "base64(x"]) {
    assert.equal(sanitize(`token=${v}`).hits.credential, undefined, v);
  }
  for (const v of ["password=hunter2hunter2", "token: abcdefgh(ijk", "secret=$ABCDEFGH1234", "api_key=SHA256abcdefgh"]) {
    assert.equal(sanitize(v).hits.credential, 1, v);
    assert.deepEqual(secretKinds(v), ["credential"], v);
  }
});

test("JWT、PEM 私钥整块打码", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(sanitize(`x ${pem} y`).text, "x [SECRET:pem] y");
  assert.equal(sanitize("t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U").text, "t [SECRET:jwt]");
});

test("PII 与家目录：邮箱、手机号、身份证号、/Users/<名>", () => {
  const r = sanitize("找 a.b@x.com 或 13812345678，证件 11010519491231002X，文件在 /Users/hejiayuan/code_me/x");
  assert.equal(r.text, "找 [PII:email] 或 [PII:phone]，证件 [PII:id_card]，文件在 ~/code_me/x");
  assert.equal(hasSecret(r), false);
});

test("跑两遍结果不变（占位符不会被再次打码）", () => {
  const once = sanitize("sk-abcdefghijklmnop1234 secret: [SECRET:api_key]").text;
  assert.equal(sanitize(once).text, once);
});

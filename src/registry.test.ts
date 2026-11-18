/**
 * 项目清单与 worktree 归并。运行：node --test src/registry.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isRegistryHome, registryDir, resolveProject } from "./registry.ts";

test("worktree 解析回主仓库对应的项目；未登记目录返回 null", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ab-reg-")));
  const repos = join(dir, "pm/repos");
  mkdirSync(repos, { recursive: true });
  const repo = join(dir, "widget");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "f"), "x");
  execFileSync("git", ["-C", repo, "add", "f"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  const wt = join(dir, "widget-wt");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt, "HEAD"]);

  writeFileSync(join(repos, "widget.md"), `- 路径：\`${repo}\`\n`);
  writeFileSync(join(repos, "README.md"), `- 路径：\`${repo}\`\n`);
  writeFileSync(join(repos, "nopath.md"), "# 没有路径行\n");

  assert.deepEqual(resolveProject(wt, repos), { name: "widget", path: repo });
  assert.deepEqual(resolveProject(repo, repos), { name: "widget", path: repo });
  assert.equal(resolveProject(dir, repos), null);
  assert.equal(isRegistryHome(join(dir, "pm"), repos), true);
  assert.equal(isRegistryHome(repo, repos), false);
  rmSync(dir, { recursive: true, force: true });
});

test("清单默认位置：pm_new 的 repos 在就用它（2026-11-18 从 pm 迁来），不在就用旧 pm 的；AB_REGISTRY 优先", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-reg-home-")));
  assert.equal(registryDir({}, home), join(home, "code_me/pm/repos"));
  mkdirSync(join(home, "code_me/pm_new/repos"), { recursive: true });
  assert.equal(registryDir({}, home), join(home, "code_me/pm_new/repos"));
  assert.equal(registryDir({ AB_REGISTRY: "/x/repos" }, home), "/x/repos");
  rmSync(home, { recursive: true, force: true });
});

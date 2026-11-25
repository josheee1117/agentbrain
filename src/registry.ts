/**
 * 项目清单（设计 §6.1）：pm 的 repos/*.md。
 * 文件名（去掉 .md）是项目名，"- 路径：`...`" 行是主执行根。README.md 不是项目。
 */
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface RegistryEntry {
  name: string;
  path: string | null; // null = 档案没有路径行
  trunk?: string | null;
}

export function registryDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return env.AB_REGISTRY || join(home, "code_me/pm/repos");
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function loadRegistry(dir = registryDir()): RegistryEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md")
      .map((d) => d.name);
  } catch {
    return [];
  }
  return names.sort().map((n) => {
    const text = readFileSync(join(dir, n), "utf8");
    const m = text.match(/^- 路径：`([^`]+)`/m);
    let path: string | null = null;
    if (m) {
      try {
        path = realpathSync(expandHome(m[1]));
      } catch {
        path = resolve(expandHome(m[1])); // 路径不存在也保留，交给 status 报告
      }
    }
    const trunkLine = text.match(/^- 主干：[ \t]*(?:`([^`]+)`|([^\r\n]+))/m);
    const trunk = (trunkLine?.[1] ?? trunkLine?.[2])?.trim() || null;
    return { name: basename(n, ".md"), path, trunk };
  });
}

/** git 主工作树；不在仓库里时用 cwd 本身。 */
export function mainWorktree(cwd: string): string {
  try {
    const gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return realpathSync(dirname(gitDir));
  } catch {
    return realpathSync(cwd);
  }
}

export function resolveProject(cwd: string, dir = registryDir()): { name: string; path: string } | null {
  const root = mainWorktree(cwd);
  const hit = loadRegistry(dir).find((e) => e.path === root);
  return hit && hit.path ? { name: hit.name, path: hit.path } : null;
}

/** cwd 的主工作树是清单目录的父目录（即 pm 仓库本身）。 */
export function isRegistryHome(cwd: string, dir = registryDir()): boolean {
  try {
    return mainWorktree(cwd) === realpathSync(dirname(dir));
  } catch {
    return false;
  }
}

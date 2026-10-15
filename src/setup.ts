/**
 * ab setup：交互式上手（v3 pipeline「ab setup」一节）。
 * 依次问：快模型 → 审稿团与仲裁 → key（进钥匙串，配置只记条目名）→ 接哪些宿主 → 连通测试。
 * 可重复运行，--only 只改其中一项。写宿主配置前先备份原文件，并把改动给用户看、确认后才写。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chatClient, type ChatConfig } from "./llm.ts";
import { REVIEW_FILE, validateReviewConfig, type PanelMember } from "./review.ts";

export type HostName = "claude" | "codex" | "pi";
export const STEPS = ["fast", "panel", "keys", "hosts", "test"] as const;
export type Step = (typeof STEPS)[number];

/** 钥匙串条目名：agentbrain-<name>（名字只留字母数字和 -）。 */
export function keyServiceFor(name: string): string {
  return `agentbrain-${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "model"}`;
}

/** 往宿主的 hooks JSON（Claude Code settings.json / Codex hooks.json）里补 agentbrain 的命令；已有的不重复加，其他内容原样保留。 */
export function mergeHooks(settings: any, host: "claude" | "codex", abCmd: string): { next: any; added: string[] } {
  const next = JSON.parse(JSON.stringify(settings ?? {}));
  next.hooks ??= {};
  const want: Record<string, { command: string; timeout: number }[]> = {
    UserPromptSubmit: [
      { command: `${abCmd} recall --hook`, timeout: 5 },
      { command: `${abCmd} capture --hook --host ${host}`, timeout: 5 },
    ],
    SessionEnd: [{ command: `${abCmd} capture --hook --host ${host}`, timeout: host === "claude" ? 1 : 3 }],
  };
  const added: string[] = [];
  for (const [ev, cmds] of Object.entries(want)) {
    const groups: any[] = Array.isArray(next.hooks[ev]) ? next.hooks[ev] : (next.hooks[ev] = []);
    const existing = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).map((h: any) => String(h?.command ?? ""));
    const missing = cmds.filter((c) => !existing.some((e) => normalizeCmd(e) === normalizeCmd(c.command)));
    if (!missing.length) continue;
    groups.push({ hooks: missing.map((c) => ({ type: "command", command: c.command, timeout: c.timeout })) });
    added.push(...missing.map((c) => `${ev}: ${c.command}`));
  }
  return { next, added };
}

/** 比较时忽略 node/ab 的路径写法：`/x/node /y/ab recall --hook` 与 `ab recall --hook` 视为同一条。 */
function normalizeCmd(c: string): string {
  return c.replace(/^\S*node\s+/, "").replace(/^\S*\/ab\s/, "ab ").replace(/\s+/g, " ").trim();
}

export function hostConfigPath(host: "claude" | "codex", h = homedir()): string {
  return host === "claude" ? join(h, ".claude", "settings.json") : join(h, ".codex", "hooks.json");
}

export function backup(path: string, now = new Date()): string | null {
  if (!existsSync(path)) return null;
  const to = `${path}.bak-agentbrain-${now.toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, to);
  return to;
}

/** 写钥匙串：经 `security -i` 的 stdin 传，key 不出现在进程参数里。 */
export function storeKey(service: string, key: string, account = process.env.USER ?? "agentbrain"): void {
  if (/["\n\\]/.test(key) || /["\n\\]/.test(service)) throw new Error("key 或条目名含不支持的字符");
  const r = spawnSync("security", ["-i"], { input: `add-generic-password -U -s "${service}" -a "${account}" -w "${key}"\n`, encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) throw new Error(`写钥匙串失败: ${(r.stderr || "").trim() || r.status}`);
}

export function hasKey(service: string): boolean {
  try {
    return !!execFileSync("security", ["find-generic-password", "-s", service], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
  } catch {
    return false;
  }
}

/** 最小 JSON 请求，报告通不通、延迟、错误原文。 */
export async function probe(cfg: ChatConfig, key: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  try {
    const r = await chatClient(cfg, key, 60_000, fetchImpl)([{ role: "user", content: '只输出 JSON：{"ok":true}' }], { json: true });
    return { ok: /"ok"\s*:\s*true/.test(r.message.content ?? ""), ms: Date.now() - t0, detail: (r.message.content ?? "").slice(0, 80) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message.slice(0, 200) };
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function showDiff(path: string, before: string, after: string): string {
  const tmp = `${path}.agentbrain-new`;
  writeFileSync(tmp, after);
  const r = spawnSync("diff", ["-u", existsSync(path) ? path : "/dev/null", tmp], { encoding: "utf8" });
  try {
    execFileSync("rm", ["-f", tmp]);
  } catch {}
  void before;
  return r.stdout || "(无变化)";
}

export interface SetupIO {
  ask(q: string, def?: string): Promise<string>;
  secret(q: string): Promise<string>;
  say(s: string): void;
}

function ttyIO(): SetupIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(q, def) {
      const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
      return a || def || "";
    },
    async secret(q) {
      const out = process.stdout;
      const orig = (rl as any)._writeToOutput;
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes(q)) out.write(s);
      };
      const a = await rl.question(`${q}（输入不回显，回车跳过）: `);
      (rl as any)._writeToOutput = orig;
      out.write("\n");
      return a.trim();
    },
    say: (s) => console.log(s),
    close: () => rl.close(),
  };
}

const yes = (a: string) => /^(y|yes|是|好|1)$/i.test(a.trim());

export async function runSetup(home: string, only: Step[] | null, io?: SetupIO, abPath = resolve(process.argv[1] ?? "ab")): Promise<void> {
  const tty = io ? null : ttyIO();
  const u = io ?? tty!;
  const want = (s: Step) => !only || only.includes(s);
  mkdirSync(home, { recursive: true });
  const extractPath = join(home, "extract.json");
  const reviewPath = join(home, REVIEW_FILE);
  try {
    let extract = readJson(extractPath) ?? {};
    let review = readJson(reviewPath) ?? { panel: [], arbiter: "" };
    if (want("fast")) {
      u.say("\n【1/5】快模型（会话结束后抽取候选用，OpenAI 兼容接口）");
      const baseUrl = await u.ask("baseUrl", extract.baseUrl);
      const model = await u.ask("model", extract.model);
      const keyService = await u.ask("钥匙串条目名", extract.keyService ?? "agentbrain-extract");
      extract = { ...extract, model, keyService };
      if (baseUrl) extract.baseUrl = baseUrl;
      else delete extract.baseUrl; // 不写 baseUrl：沿用 embedding.json 的地址与 key
      writeFileSync(extractPath, `${JSON.stringify(extract, null, 2)}\n`);
      u.say(`已写 ${extractPath}`);
    }
    if (want("panel")) {
      u.say("\n【2/5】审稿团：先填各家模型，再选评审方式（primary：一位主审 + 参考意见；panel：投票 + 仲裁）");
      const n = Number(await u.ask("几家", String(review.panel?.length || 3))) || 3;
      const panel: PanelMember[] = [];
      for (let i = 0; i < n; i++) {
        const old = review.panel?.[i] ?? {};
        u.say(`— 第 ${i + 1} 家`);
        const name = await u.ask("简称（字母数字）", old.name);
        const baseUrl = await u.ask("baseUrl", old.baseUrl);
        const model = await u.ask("model", old.model);
        const keyService = await u.ask("钥匙串条目名", old.keyService ?? keyServiceFor(name));
        panel.push({ ...old, name, baseUrl, model, keyService }); // 保留 concurrency、extraBody 等手写字段
      }
      const mode = (await u.ask("评审方式：primary（一位主审定结论，其余只给参考意见）/ panel（投票 + 仲裁）", review.mode ?? "primary")) === "panel" ? "panel" : "primary";
      let arbiter: string | PanelMember | undefined;
      let primary: string | undefined;
      if (mode === "primary") {
        primary = await u.ask(`主审（${panel.map((m) => m.name).join("/")}）`, panel.some((m) => m.name === review.primary) ? review.primary : panel[0]?.name);
      } else {
        const oldArb = typeof review.arbiter === "object" && review.arbiter ? review.arbiter : null;
        const oldName = oldArb ? oldArb.name : review.arbiter;
        const pick = await u.ask(`仲裁（${panel.map((m) => m.name).join("/")}，或填 other 单独配一个模型）`, panel.some((m) => m.name === oldName) ? oldName : oldArb ? "other" : panel[0]?.name);
        arbiter = pick;
        if (pick === "other") {
          u.say("— 仲裁模型（不参加投票，只在分歧时定结论）");
          const name = await u.ask("简称（字母数字）", oldArb?.name);
          const baseUrl = await u.ask("baseUrl", oldArb?.baseUrl);
          const model = await u.ask("model", oldArb?.model);
          const keyService = await u.ask("钥匙串条目名", oldArb?.keyService ?? keyServiceFor(name));
          arbiter = { ...(oldArb ?? {}), name, baseUrl, model, keyService };
        }
      }
      const next: any = { ...review, mode, panel };
      if (mode === "primary") {
        next.primary = primary;
        delete next.arbiter;
      } else {
        next.arbiter = arbiter;
        delete next.primary;
      }
      const v = validateReviewConfig(next, reviewPath);
      if ("error" in v) throw new Error(v.error);
      if (mode === "panel" && panel.length < 3) u.say("提醒：panel 模式少于 3 家时 ab curate 只出报告，不写库。");
      review = next;
      writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
      u.say(`已写 ${reviewPath}`);
    }
    const arbObj = review.mode !== "primary" && typeof review.arbiter === "object" && review.arbiter ? (review.arbiter as PanelMember) : null;
    const services = [...new Set([extract.keyService, ...(review.panel ?? []).map((m: PanelMember) => m.keyService), arbObj?.keyService].filter(Boolean))] as string[];
    if (want("keys")) {
      u.say("\n【3/5】key：每个模型一个钥匙串条目，配置文件只记条目名");
      for (const s of services) {
        const k = await u.secret(`${s}${hasKey(s) ? "（已有，回车保留）" : ""}`);
        if (k) {
          storeKey(s, k);
          u.say(`已存 ${s}`);
        }
      }
    }
    if (want("hosts")) {
      u.say("\n【4/5】接哪些宿主（每轮召回 + 会话登记）");
      const node = process.execPath;
      const abCmd = `${node} ${abPath}`;
      for (const host of ["claude", "codex"] as const) {
        if (!yes(await u.ask(`接 ${host === "claude" ? "Claude Code" : "Codex"}？(y/n)`, "n"))) continue;
        const path = hostConfigPath(host);
        const before = existsSync(path) ? readFileSync(path, "utf8") : "{}";
        const { next, added } = mergeHooks(readJson(path) ?? {}, host, abCmd);
        if (!added.length) {
          u.say(`${path} 已经接好，不改。`);
          continue;
        }
        const after = `${JSON.stringify(next, null, 2)}\n`;
        u.say(showDiff(path, before, after));
        if (!yes(await u.ask("按上面的 diff 写入？(y/n)", "n"))) continue;
        const b = backup(path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after);
        u.say(`已写 ${path}${b ? `（原文件备份在 ${b}）` : ""}`);
      }
      if (yes(await u.ask("接 Pi？(y/n)", "n"))) {
        const real = existsSync(abPath) ? realpathSync(abPath) : abPath; // ~/.local/bin/ab 通常是指向仓库 src/cli.ts 的链接
        const src = resolve(dirname(real), "..", "integrations", "pi", "agentbrain-recall.ts");
        const dst = join(homedir(), ".pi", "agent", "extensions", "agentbrain-recall.ts");
        let exists = false;
        try {
          lstatSync(dst);
          exists = true;
        } catch {}
        if (exists) u.say(`${dst} 已存在，不改。`);
        else if (!existsSync(src)) u.say(`找不到 ${src}，跳过。`);
        else {
          mkdirSync(dirname(dst), { recursive: true });
          symlinkSync(src, dst);
          u.say(`已链接 ${dst} → ${src}`);
        }
      }
    }
    if (want("test")) {
      u.say("\n【5/5】连通测试");
      const models: { label: string; cfg: ChatConfig }[] = [];
      if (extract.baseUrl && extract.model) models.push({ label: "快模型", cfg: { baseUrl: extract.baseUrl, model: extract.model, keyService: extract.keyService ?? "agentbrain-extract" } });
      for (const m of review.panel ?? []) models.push({ label: `审稿 ${m.name}${review.mode === "primary" ? (m.name === review.primary ? "（主审）" : "（参考）") : m.name === review.arbiter ? "（仲裁）" : ""}`, cfg: m });
      if (arbObj) models.push({ label: `仲裁 ${arbObj.name}`, cfg: arbObj });
      const { readKey } = await import("./embed.ts");
      for (const m of models) {
        const k = readKey(m.cfg.keyService);
        if (typeof k !== "string") {
          u.say(`✗ ${m.label} ${m.cfg.model}: ${k.error}`);
          continue;
        }
        const r = await probe(m.cfg, k);
        u.say(`${r.ok ? "✓" : "✗"} ${m.label} ${m.cfg.model} ${r.ms}ms ${r.ok ? "" : r.detail}`);
      }
      const hook = spawnSync(process.execPath, [abPath, "recall", "--hook"], {
        input: JSON.stringify({ prompt: "agentbrain setup 连通测试：汇报时要注意什么", cwd: process.cwd(), hook_event_name: "UserPromptSubmit" }),
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, AB_HOME: home },
      });
      u.say(/<agentbrain-prefs>/.test(hook.stdout) ? "✓ ab recall --hook 输出里有 <agentbrain-prefs>" : `✗ ab recall --hook 没看到 <agentbrain-prefs>（可能还没有已确认的干活偏好）`);
    }
  } finally {
    tty?.close();
  }
}

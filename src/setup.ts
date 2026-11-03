/**
 * ab setup：交互式上手（v3 pipeline「ab setup」一节）。
 * 依次问：快模型 → 按宿主分的审稿人（默认用各宿主自己的命令行：Claude Haiku 5.5 max 等）→ 主审稿配置 → key（进钥匙串，配置只记条目名）→ 接哪些宿主 → 连通测试。
 * 可重复运行，--only 只改其中一项。写宿主配置前先备份原文件，并把改动给用户看、确认后才写。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chatClient, type ChatConfig } from "./llm.ts";
import { REVIEW_FILE, validateReviewConfig, type PanelMember } from "./review.ts";
import { cliChat, type CliHost } from "./clireviewer.ts";

export type HostName = "claude" | "codex" | "pi";
export const STEPS = ["fast", "reviewers", "panel", "keys", "hosts", "test"] as const;
export type Step = (typeof STEPS)[number];

/** 按宿主的默认审稿人（2026-10-15 用户认可）：各宿主用自己的副模型、推理开到最高。Claude 用 Haiku 5.5 max；Codex 用第二档 gpt-6-astra max；Pi 用它配的 reviewer 子代理模型 max（没配就用 Pi 默认模型）。setup 里都可以改。 */
export const HOST_REVIEWER_DEFAULTS: Record<CliHost, { model: string; effort: string }> = {
  claude: { model: "haiku", effort: "max" },
  codex: { model: "gpt-6-astra", effort: "max" },
  pi: { model: "", effort: "max" },
};

/** 按本机宿主配置推出默认审稿人（AB_HOST_HOME 可改宿主配置所在的 home，测试用）：Codex 读 ~/.codex/config.toml 的 review_model；Pi 读 ~/.pi/agent/settings.json 的 subagents.agentOverrides.reviewer.model。读不到就用 HOST_REVIEWER_DEFAULTS。 */
export function hostReviewerDefault(host: CliHost, home = process.env.AB_HOST_HOME || homedir()): { model: string; effort: string; from?: string } {
  const d = { ...HOST_REVIEWER_DEFAULTS[host] };
  try {
    if (host === "codex") {
      const f = join(home, ".codex", "config.toml");
      const m = existsSync(f) ? /^\s*review_model\s*=\s*"([^"]+)"/m.exec(readFileSync(f, "utf8")) : null;
      if (m) return { ...d, model: m[1], from: f };
    }
    if (host === "pi") {
      const f = join(home, ".pi", "agent", "settings.json");
      const model = existsSync(f) ? JSON.parse(readFileSync(f, "utf8"))?.subagents?.agentOverrides?.reviewer?.model : undefined;
      if (typeof model === "string" && model && model !== "inherit") return { ...d, model, from: f };
    }
  } catch {
    // 宿主配置读不了就用内置默认
  }
  return d;
}
/** 保留的 API 选项：经 cpa 的 gpt-6-astra。 */
export const ASTRA_VIA_CPA = { baseUrl: "http://127.0.0.1:8317/v1", model: "gpt-6-astra", keyService: "codex-cpa-local-api-key", extraBody: { reasoning_effort: "medium" } };

const HOST_LABEL: Record<CliHost, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

/** 问一个审稿成员：cli（宿主命令行）或 api（OpenAI 兼容接口）。保留旧配置里的手写字段（extraBody 等）。 */
async function askMember(u: SetupIO, old: any, name: string, fixed: { type?: "api" | "cli"; host?: CliHost } = {}): Promise<PanelMember> {
  const type = fixed.type ?? ((await u.ask("类型：cli（宿主命令行无头，用宿主自己的账号额度）/ api（OpenAI 兼容接口）", old?.type ?? (old?.baseUrl ? "api" : "cli"))) === "api" ? "api" : "cli");
  if (type === "cli") {
    const host = fixed.host ?? ((await u.ask("宿主（claude/codex/pi）", old?.host ?? "claude")) as CliHost);
    const d = HOST_REVIEWER_DEFAULTS[host] ? hostReviewerDefault(host) : HOST_REVIEWER_DEFAULTS.claude;
    const model = await u.ask(`模型（${host === "pi" ? "provider/id，回车用 Pi 的默认模型" : "别名或完整名"}）`, old?.type === "cli" && old.host === host ? old.model : d.model);
    const effort = await u.ask("推理强度", old?.type === "cli" && old.host === host ? old.effort : d.effort);
    const { baseUrl: _b, keyService: _k, extraBody: _e, ...rest } = old ?? {};
    void _b, _k, _e;
    return { ...rest, name, type, host, model: model ?? "", ...(effort ? { effort } : {}) } as PanelMember;
  }
  const useAstra = !old?.baseUrl;
  const baseUrl = await u.ask("baseUrl", old?.baseUrl ?? ASTRA_VIA_CPA.baseUrl);
  const model = await u.ask("model", old?.model || ASTRA_VIA_CPA.model);
  const keyService = await u.ask("钥匙串条目名", old?.keyService ?? (useAstra ? ASTRA_VIA_CPA.keyService : keyServiceFor(name)));
  const { host: _h, effort: _f, ...rest } = old ?? {};
  void _h, _f;
  return { ...(useAstra && model === ASTRA_VIA_CPA.model ? { extraBody: ASTRA_VIA_CPA.extraBody } : {}), ...rest, name, type: "api", baseUrl, model, keyService } as PanelMember;
}

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
    // 话题结束触发（§8.6）：压缩前记一个话题边界并拉起 ab work，立即返回、不挡压缩。开关（extract.json "topic"）关着时这条什么都不做
    PreCompact: [{ command: `${abCmd} capture --hook --host ${host}`, timeout: 5 }],
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
  // 临时文件放系统临时目录：宿主配置目录可能还不存在（首次接入）
  const tmp = join(tmpdir(), `agentbrain-new-${process.pid}-${Date.now()}.json`);
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
      u.say("\n【1/6】快模型（会话结束后抽取新记忆用，OpenAI 兼容接口）");
      const baseUrl = await u.ask("baseUrl", extract.baseUrl);
      const model = await u.ask("model", extract.model);
      const keyService = await u.ask("钥匙串条目名", extract.keyService ?? "agentbrain-extract");
      extract = { ...extract, model, keyService };
      if (baseUrl) extract.baseUrl = baseUrl;
      else delete extract.baseUrl; // 不写 baseUrl：沿用 embedding.json 的地址与 key
      backup(extractPath);
      writeFileSync(extractPath, `${JSON.stringify(extract, null, 2)}\n`);
      u.say(`已写 ${extractPath}`);
    }
    if (want("reviewers")) {
      u.say("\n【2/6】按宿主分的审稿人：某个宿主的会话结束后，用它自己的命令行无头审稿（用它自己的账号额度），只审从这个宿主会话抽出来的未确认条目");
      const hr: Record<string, any> = { ...(review.hostReviewers ?? {}) };
      for (const host of ["claude", "codex", "pi"] as const) {
        const old = hr[host];
        const d = hostReviewerDefault(host);
        const pick = await u.ask(`${HOST_LABEL[host]} 会话的审稿人：cli（${host}${d.model ? ` ${d.model}` : ""} ${d.effort}）/ api（例如经 cpa 的 gpt-6-astra）/ none`, old ? (old.type ?? "api") : "cli");
        if (pick === "none") {
          delete hr[host];
          continue;
        }
        u.say(`— ${HOST_LABEL[host]} 审稿人`);
        const type = pick === "api" ? "api" : "cli";
        hr[host] = await askMember(u, old?.type === type || (!old?.type && type === "api") ? old : undefined, `${host}-review`, { type, host });
      }
      const next: any = { ...review, hostReviewers: hr };
      delete next.autoRun;
      // 还没有主审稿配置时：用 Claude 的审稿人（没有就用第一个）当主审，主配置管手动 ab curate 和不属于任何宿主的候选
      if (!next.panel?.length) {
        const first = hr.claude ?? Object.values(hr)[0];
        if (first) {
          next.mode = "primary";
          next.primary = first.name;
          next.panel = [first];
          delete next.arbiter;
          u.say(`主审稿配置还没有：先用 ${first.name} 当主审（之后可用 ab setup --only panel 改）`);
        }
      }
      const v = validateReviewConfig(next, reviewPath);
      if ("error" in v) throw new Error(v.error);
      review = next;
      backup(reviewPath);
      writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
      u.say(`已写 ${reviewPath}`);
    }
    if (want("panel")) {
      u.say("\n【3/6】主审稿配置（手动 ab curate、没配宿主审稿人的宿主、不属于任何宿主的候选用它）：先填各家模型，再选评审方式（primary：一位主审，可另加几家只给参考意见；panel：投票 + 仲裁）。默认 1 家主审单独判");
      const n = Number(await u.ask("几家", String(review.panel?.length || 1))) || 1;
      const panel: PanelMember[] = [];
      for (let i = 0; i < n; i++) {
        const old = review.panel?.[i] ?? {};
        u.say(`— 第 ${i + 1} 家`);
        const name = await u.ask("简称（字母数字）", old.name ?? (i === 0 ? "haiku" : undefined));
        panel.push(await askMember(u, i === 0 && !old.name ? { type: "cli", host: "claude" } : old, name)); // 保留 extraBody 等手写字段
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
      backup(reviewPath);
      writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
      u.say(`已写 ${reviewPath}`);
    }
    const arbObj = review.mode !== "primary" && typeof review.arbiter === "object" && review.arbiter ? (review.arbiter as PanelMember) : null;
    const apiMembers = [...(review.panel ?? []), ...Object.values(review.hostReviewers ?? {}), arbObj].filter((m: any) => m && m.type !== "cli" && m.baseUrl) as PanelMember[];
    const services = [...new Set([extract.keyService, ...apiMembers.map((m) => m.keyService)].filter(Boolean))] as string[];
    if (want("keys")) {
      u.say("\n【4/6】key：每个模型一个钥匙串条目，配置文件只记条目名");
      for (const s of services) {
        const k = await u.secret(`${s}${hasKey(s) ? "（已有，回车保留）" : ""}`);
        if (k) {
          storeKey(s, k);
          u.say(`已存 ${s}`);
        }
      }
    }
    if (want("hosts")) {
      u.say("\n【5/6】接哪些宿主（每轮召回 + 会话登记）");
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
      u.say("\n【6/6】连通测试");
      const models: { label: string; cfg: ChatConfig }[] = [];
      if (extract.baseUrl && extract.model) models.push({ label: "快模型", cfg: { baseUrl: extract.baseUrl, model: extract.model, keyService: extract.keyService ?? "agentbrain-extract" } });
      const cliMembers: { label: string; m: PanelMember }[] = [];
      const add = (label: string, m: PanelMember) => (m.type === "cli" ? cliMembers.push({ label, m }) : models.push({ label, cfg: m }));
      for (const m of review.panel ?? []) add(`审稿 ${m.name}${review.mode === "primary" ? (m.name === review.primary ? "（主审）" : "（参考）") : m.name === review.arbiter ? "（仲裁）" : ""}`, m);
      for (const [h, m] of Object.entries(review.hostReviewers ?? {})) if (m && !(review.panel ?? []).some((p: PanelMember) => p.name === (m as PanelMember).name)) add(`${h} 会话审稿`, m as PanelMember);
      if (arbObj) add(`仲裁 ${arbObj.name}`, arbObj); // 独立仲裁人也按 type 分流：cli 的不当 HTTP 测
      for (const { label, m } of cliMembers) {
        const t0 = Date.now();
        try {
          const r = await cliChat({ host: m.host!, model: m.model || undefined, effort: m.effort, bin: m.bin, timeoutMs: 180_000 })([{ role: "system", content: "只回 JSON。" }, { role: "user", content: '回 {"ok":true}' }]);
          u.say(`${/"ok"\s*:\s*true/.test(r.message.content ?? "") ? "✓" : "✗"} ${label} ${m.host}:${m.model || "默认"}${m.effort ? `@${m.effort}` : ""} ${Date.now() - t0}ms`);
        } catch (e) {
          u.say(`✗ ${label} ${m.host}:${m.model || "默认"}: ${(e as Error).message}`);
        }
      }
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

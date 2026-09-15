/**
 * agentbrain Pi 扩展，切片 1（设计 §18）：
 *   /ab bind <name>   显式把当前 git 根绑定到项目
 *   /ab status        项目、计数、doctor 最小面
 *   memory_remember / memory_search / memory_get / memory_archive
 *   每轮注入小型 Brief（坑主动投递，§11.1）
 *
 * 只碰 Pi 的公开 seam：before_agent_start、registerTool、registerCommand、sessionManager。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Store, type PropKind, type Proposition } from "./store.ts";
import { expandSource } from "./source.ts";

const ROOT = join(homedir(), ".agentbrain");
const BRIEF_MAX_CHARS = 1500;
const KINDS: PropKind[] = ["pitfall", "decision", "note"];
const KIND_LABEL: Record<PropKind, string> = { pitfall: "坑", decision: "决定", note: "笔记" };

let store: Store | null = null;
function db(): Store {
  return (store ??= new Store(join(ROOT, "store.db"), join(ROOT, "index.db")));
}

/** 向上找 .git 作为执行根；只是发现候选，身份仍要显式 bind（§6.1）。 */
function gitRoot(cwd: string): string {
  let d = cwd;
  for (;;) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return cwd;
    d = up;
  }
}

function ctxInfo(ctx: ExtensionContext) {
  const root = gitRoot(ctx.cwd);
  const project = db().projectFor(root);
  const sm = ctx.sessionManager;
  const file = sm.getSessionFile();
  return {
    root,
    project,
    sessionId: sm.getSessionId(),
    ephemeral: file === undefined, // §9.5：无持久 session 文件 = ephemeral
    file: file ?? null,
    leaf: sm.getLeafId(),
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}

function findByPrefix(prefix: string, projectId: string): Proposition | null {
  const hits = [...db().project().props.values()].filter((p) => p.project_id === projectId && p.id.startsWith(prefix));
  return hits.length === 1 ? hits[0] : null;
}

function card(p: Proposition): string {
  const lines = [`[${short(p.id)}] ${KIND_LABEL[p.kind]}${p.state === "archived" ? "（已归档）" : ""}: ${p.text}`];
  if (p.why) lines.push(`  为什么: ${p.why}`);
  lines.push(`  来源: ${p.source.summary}${p.source.file ? "" : "（ephemeral 会话，无 transcript）"}  记录于 ${p.ts.slice(0, 10)}`);
  return lines.join("\n");
}

function brief(projectId: string, name: string): string {
  const all = [...db().project().props.values()].filter((p) => p.project_id === projectId && p.state === "active");
  const pitfalls = all.filter((p) => p.kind === "pitfall").sort((a, b) => b.seq - a.seq);
  const nDecision = all.filter((p) => p.kind === "decision").length;
  const nNote = all.filter((p) => p.kind === "note").length;
  const head = `<agentbrain project="${name}">\n`;
  const tail = `决定 ${nDecision} 条、笔记 ${nNote} 条：用 memory_search 查，memory_get 看当时的讨论。记住新的坑/决定用 memory_remember。\n</agentbrain>`;
  let body = pitfalls.length ? `坑（${pitfalls.length} 条，最近在前；与现场证据冲突时信现场）：\n` : "";
  let shown = 0;
  for (const p of pitfalls) {
    const line = `- [${short(p.id)}] ${p.text}\n`;
    if (head.length + body.length + line.length + tail.length > BRIEF_MAX_CHARS) break;
    body += line;
    shown++;
  }
  if (shown < pitfalls.length) body += `- …还有 ${pitfalls.length - shown} 条，用 memory_search kind=pitfall 查\n`;
  return head + body + tail;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: undefined };
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ab", {
    description: "agentbrain: bind <name> | status",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const info = ctxInfo(ctx);
      if (sub === "bind") {
        const name = rest.join(" ").trim();
        if (!name) return ctx.ui.notify("用法: /ab bind <项目名>", "error");
        db().bind(info.root, name);
        return ctx.ui.notify(`已绑定 ${info.root} → ${name}`, "info");
      }
      const proj = db().project();
      const mine = info.project ? [...proj.props.values()].filter((p) => p.project_id === info.project!.id) : [];
      ctx.ui.notify(
        [
          `项目: ${info.project ? info.project.name : "未绑定（/ab bind <名>）"}  根: ${info.root}`,
          `会话: ${info.sessionId}${info.ephemeral ? "（ephemeral）" : ""}`,
          `本项目 propositions: ${mine.length}（active ${mine.filter((p) => p.state === "active").length}）`,
          `doctor: orphan 事件 ${proj.orphans}，ephemeral 证据 ${proj.ephemeral}，已清除 ${proj.purged}`,
          `store: ${ROOT}`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Remember",
    description:
      "把一个踩过的坑（pitfall）、一个做出的决定（decision）或一条事实（note）记进项目长期记忆。会自动记录当前对话位置作为来源，以后可以还原当时的讨论。",
    promptSnippet: "memory_remember: 记住坑/决定/事实到项目记忆",
    promptGuidelines: [
      "踩到坑并解决后，或用户明确做出决定后，用 memory_remember 记下来；summary 写一句这段讨论在说什么。",
    ],
    parameters: Type.Object({
      kind: StringEnum(KINDS, { description: "pitfall=坑, decision=决定, note=事实" }),
      text: Type.String({ description: "一句话结论。坑写成：在什么情况下别做什么" }),
      why: Type.Optional(Type.String({ description: "理由 / 后果 / 替代方案" })),
      summary: Type.String({ description: "一句话：当前这段讨论在说什么（用于以后定位来源）" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const info = ctxInfo(ctx);
      if (!info.project) return text(`当前目录未绑定项目。请用户先执行 /ab bind <项目名>（根目录 ${info.root}）。`);
      const id = db().remember(info.project.id, info.sessionId, info.ephemeral, {
        kind: params.kind,
        text: params.text,
        why: params.why,
        source: { file: info.file, entry_id: info.leaf, summary: params.summary },
      });
      return text(
        info.ephemeral
          ? `已记录为 ephemeral 证据 [${short(id)}]（本会话无持久记录，默认不进入项目记忆）。`
          : `已记住 [${short(id)}] ${KIND_LABEL[params.kind]}: ${params.text}`,
      );
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "在当前项目的长期记忆里搜索坑、决定和事实。返回 id，可用 memory_get 看详情和当时的讨论。",
    promptSnippet: "memory_search: 搜索项目记忆（坑/决定/事实）",
    parameters: Type.Object({
      query: Type.String({ description: "关键词，空格分隔" }),
      kind: Type.Optional(StringEnum(KINDS)),
      include_archived: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const info = ctxInfo(ctx);
      if (!info.project) return text("当前目录未绑定项目，无记忆可搜。");
      const hits = db().search(info.project.id, params.query, { kind: params.kind, includeArchived: params.include_archived });
      if (!hits.length) return text("没有匹配的记忆。");
      return text(hits.map((h) => `[${short(h.id)}] ${KIND_LABEL[h.kind]}${h.state === "archived" ? "（已归档）" : ""}: ${h.text.split("\n")[0]}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description: "读取一条记忆的完整内容；expand=true 时还原记录当时的对话片段（从 Pi 会话记录按需读取）。",
    promptSnippet: "memory_get: 看一条记忆的详情和当时的讨论",
    parameters: Type.Object({
      id: Type.String({ description: "记忆 id 或其前缀" }),
      expand: Type.Optional(Type.Boolean({ description: "是否还原当时的讨论" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const info = ctxInfo(ctx);
      if (!info.project) return text("当前目录未绑定项目。");
      const p = findByPrefix(params.id, info.project.id);
      if (!p) return text(`找不到唯一匹配的记忆: ${params.id}`);
      let out = card(p);
      if (params.expand) {
        const disc = expandSource(p.source);
        out += "\n\n--- 当时的讨论 ---\n" + (disc ?? "（来源 transcript 不可用：文件不存在或指针失效）");
      }
      return text(out);
    },
  });

  pi.registerTool({
    name: "memory_archive",
    label: "Memory Archive",
    description: "归档一条不再适用的记忆（可逆，历史保留）。只在用户明确表示这条记忆过时或错误时使用。",
    parameters: Type.Object({
      id: Type.String({ description: "记忆 id 或其前缀" }),
      reactivate: Type.Optional(Type.Boolean({ description: "true 则恢复已归档的记忆" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const info = ctxInfo(ctx);
      if (!info.project) return text("当前目录未绑定项目。");
      if (info.ephemeral) return text("ephemeral 会话不能改变项目记忆状态。");
      const p = findByPrefix(params.id, info.project.id);
      if (!p) return text(`找不到唯一匹配的记忆: ${params.id}`);
      db().lifecycle(params.reactivate ? "reactivate" : "archive", p.id, info.sessionId);
      return text(`${params.reactivate ? "已恢复" : "已归档"} [${short(p.id)}] ${p.text}`);
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const info = ctxInfo(ctx);
    if (!info.project) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${brief(info.project.id, info.project.name)}` };
  });

  pi.on("session_shutdown", async () => {
    store?.close();
    store = null;
  });
}

/** 价值标准评测：同一套"复判"输入，分别用旧/新抽取提示词 + 各自的确定性校验，判这条该不该记。用法：node gate.ts <repo> <items.json> <old_extract.ts> <out.json> */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const [repo, itemsPath, oldPath, outPath] = process.argv.slice(2);
const { chatClient, loadChatConfig, parseJsonLoose } = await import(join(repo, "src/llm.ts"));
const { readKey } = await import(join(repo, "src/embed.ts"));
const ex = await import(join(repo, "src/extract.ts"));
const { isWorkerTranscript } = await import(join(repo, "src/transcript.ts"));
const sys = (file: string) => {
  const s = readFileSync(file, "utf8");
  const m = /const SYSTEM = `([\s\S]*?)`;/.exec(s)!;
  return m[1].replace("${MAX_CANDIDATES_PER_WINDOW}", "3");
};
const WORKER_NOTE = /const WORKER_NOTE = `([\s\S]*?)`;/.exec(readFileSync(join(repo, "src/extract.ts"), "utf8"))![1];
const PROMPTS = { old: sys(oldPath), new: sys(join(repo, "src/extract.ts")) };
const cfg = loadChatConfig(join(homedir(), ".agentbrain"));
const chat = chatClient(cfg, readKey(cfg.keyService), 120_000);
const items = JSON.parse(readFileSync(itemsPath, "utf8"));
const NARR: RegExp = ex.NARRATIVE;
const ask = (it: any, worker: boolean) => {
  const ev = it.quote ? `用户原话：${it.quote}` : it.basis?.startsWith("user") ? "（用户原话见当时会话，未附）" : "（证据是工具输出或助手观察）";
  return [
    `项目：${it.proj ?? "（全局）"}`,
    worker ? WORKER_NOTE : "",
    `下面不是会话记录，而是一条已经从会话里抽出来的候选记忆。请只按系统提示里的标准复判：值得长期记就按输出格式输出（可以改写、概括、补场景；evidence 写 {"anchor":"#1","role":"${it.basis === "observed_failure" ? "tool" : "user"}","quote":"x"} 即可，程序不核对），不值得就输出 {"candidates":[]}。`,
    `<candidate>\n种类：${it.kind}\n范围：${it.scope}\n依据：${it.basis ?? "人工记录"}\n正文：${it.text}\n背景：${it.why ?? "（无）"}\n触发场景：${it.trigger ?? "（无）"}\n${ev}\n</candidate>`,
  ].filter(Boolean).join("\n\n");
};
const out: any[] = [];
let i = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < items.length) {
    const it = items[i++];
    const worker = !!it.transcript && isWorkerTranscript(it.transcript);
    const row: any = { set: it.set, n: it.n, id: it.id, gold: it.admit, worker };
    for (const v of ["old", "new"] as const) {
      let parsed: any = null;
      for (let t = 0; t < 2 && !parsed; t++) {
        try {
          const r = await chat([{ role: "system", content: PROMPTS[v] }, { role: "user", content: ask(it, v === "new" && worker) }], { json: true });
          parsed = parseJsonLoose(r.message.content);
        } catch (e) { row[`${v}_err`] = String(e); }
      }
      const c = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : undefined;
      let reason = c ? "" : "model_skip";
      if (c && (c.kind === "decision" || c.kind === "rule") && !ex.hasBackground(c.why, c.text ?? "")) reason = "no_why";
      if (v === "new" && c && !reason) {
        if (worker && (c.basis === "user_directive" || c.basis === "user_confirmed" || c.kind === "rule")) reason = "worker_prompt";
        else if (c.durability === "phase") reason = "phase";
        else if (c.findable === true) reason = "findable";
        else if (!ex.isScenario(c.scenario ?? c.trigger, c.text ?? "")) reason = "no_scenario";
        else if (NARR.test(c.text ?? "")) reason = "narrative";
      }
      row[v] = { admit: !reason, reason, text: c?.text, scenario: c?.scenario ?? c?.trigger, durability: c?.durability, guidance: c?.guidance, kind: c?.kind };
    }
    out.push(row);
    process.stderr.write(".");
  }
}));
out.sort((a, b) => (a.set + String(a.n).padStart(2, "0")).localeCompare(b.set + String(b.n).padStart(2, "0")));
writeFileSync(outPath, JSON.stringify(out, null, 1));

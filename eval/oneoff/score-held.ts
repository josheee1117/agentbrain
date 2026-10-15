import { readFileSync } from "node:fs";
const m = await import(process.argv[2]);
const d = JSON.parse(readFileSync(new URL("./oneoff-heldout160.json", import.meta.url), "utf8"));
for (const [name, items] of [["first80", d.items.slice(0, 80)], ["all160", d.items]] as const) {
  let tp = 0, fp = 0, fn = 0, tn = 0; const F: string[] = [], N: string[] = [];
  for (const x of items as any[]) { const own = m.ownUserText(x.text); const g = m.isOneOffAuthorization(own); if (g && x.oneOff) tp++; else if (g) { fp++; F.push(x.text); } else if (x.oneOff) { fn++; N.push(x.text); } else tn++; }
  console.log(name, JSON.stringify({ n: items.length, tp, fp, fn, tn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: +(tp / (tp + fn)).toFixed(3), fpList: F, fnList: N }, null, 0));
}

// usage: node score.ts <path-to-extract.ts>
import { readFileSync } from "node:fs";
const m = await import(process.argv[2]);
const s = JSON.parse(readFileSync(new URL("./oneoff-sample48.json", import.meta.url), "utf8")) as { text: string; oneOff: boolean }[];
let tp = 0, fp = 0, fn = 0, tn = 0; const miss: string[] = [], wrong: string[] = [];
for (const x of s) { const got = m.isOneOffAuthorization(x.text); if (got && x.oneOff) tp++; else if (got) { fp++; wrong.push(x.text); } else if (x.oneOff) { fn++; miss.push(x.text); } else tn++; }
console.log(JSON.stringify({ n: s.length, tp, fp, fn, tn, precision: +(tp / (tp + fp)).toFixed(3), recall: +(tp / (tp + fn)).toFixed(3), fpList: wrong, fnList: miss }, null, 1));

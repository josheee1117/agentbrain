/**
 * ab view：把 L2 投影 + 已存向量导出成一个自包含的 HTML 页面（§21 2026-10-13 ab view）。
 * 只读 store；不发网络请求；页面里只有 store 里已有的内容（引文只存了哈希，页面也只显示定位点）。
 */
import type { Store } from "./store.ts";
import type { Proposition } from "./l2.ts";
import { cosine } from "./embed.ts";
import { reviewList, validDays } from "./expiry.ts";

export type ViewStatus = "user" | "code" | "corroboration" | "unconfirmed" | "stale";

export interface ViewEntry {
  id: string;
  kind: Proposition["kind"];
  text: string;
  why: string | null;
  summary: string;
  trigger: string | null;
  project: string; // "全局" 或项目名
  state: Proposition["state"];
  status: ViewStatus;
  origin: Proposition["origin"];
  host: string | null;
  sessions: string[];
  created: string;
  for_workers: boolean;
  expired: boolean;
  /** 到期待复审（未确认、过期、期间没被注入）。 */
  review_due: boolean;
  valid_days: number;
  last_used: string | null;
  unreconciled: boolean;
  evidence: { role: string; anchor: string; quote_sha256: string }[];
  code: { head: string; refs: string[]; stale: boolean } | null;
  links: { type: "merged_into" | "merged_from" | "refines" | "refined_by" | "conflicts" | "supersedes" | "superseded_by" | "pending_correction"; id: string }[];
  neighbors: { id: string; similarity: number }[];
  xy: [number, number] | null;
}

export interface ViewData {
  generated: string;
  embed_model: string | null;
  entries: ViewEntry[];
  counts: { total: number; active: number; vectors: number };
}

const NEIGHBORS = 5;

function statusOf(p: Proposition): ViewStatus {
  if (p.stale) return "stale";
  if (!p.confirmed) return "unconfirmed";
  return p.confirmed_by ?? "user";
}

const refText = (r: { path: string; line_start: number; line_end: number; quote: string } | { commit: string; quote: string }) =>
  "path" in r ? `${r.path}:${r.line_start}-${r.line_end} ${r.quote}` : `${r.commit.slice(0, 10)} ${r.quote}`;

/** 前两个主成分（幂迭代 + 去除第一成分），结果确定：初始向量固定。 */
export function pca2(vecs: Float32Array[]): [number, number][] {
  const n = vecs.length;
  if (n === 0) return [];
  const d = vecs[0].length;
  const mean = new Float64Array(d);
  for (const v of vecs) for (let j = 0; j < d; j++) mean[j] += v[j] / n;
  const X = vecs.map((v) => Float64Array.from(v, (x, j) => x - mean[j]));
  const comps: Float64Array[] = [];
  for (let c = 0; c < 2; c++) {
    let w: Float64Array = Float64Array.from({ length: d }, (_, j) => Math.sin(j + 1 + c * 7));
    for (let it = 0; it < 100; it++) {
      const next = new Float64Array(d);
      for (const x of X) {
        let s = 0;
        for (let j = 0; j < d; j++) s += x[j] * w[j];
        for (let j = 0; j < d; j++) next[j] += s * x[j];
      }
      for (const prev of comps) {
        let s = 0;
        for (let j = 0; j < d; j++) s += next[j] * prev[j];
        for (let j = 0; j < d; j++) next[j] -= s * prev[j];
      }
      const norm = Math.hypot(...next) || 1;
      w = next.map((x) => x / norm);
    }
    comps.push(w);
  }
  return X.map((x) => comps.map((w) => x.reduce((s, xj, j) => s + xj * w[j], 0)) as [number, number]);
}

export function buildViewData(store: Store, now: Date = new Date()): ViewData {
  const props = store.project().props;
  const names = new Map(store.listProjects().map((p) => [p.id, p.name]));
  const usage = store.usage();
  const due = new Set(reviewList(props.values(), usage, now).map((d) => d.prop.id));
  const vecs = store.currentVectors();
  const ids = [...props.keys()].filter((id) => vecs.has(id));
  const xy = new Map(pca2(ids.map((id) => vecs.get(id)!)).map((p, i) => [ids[i], p]));
  const reverse = new Map<string, ViewEntry["links"]>();
  const addRev = (target: string | null | undefined, link: ViewEntry["links"][number]) => {
    if (!target || !props.has(target)) return;
    reverse.set(target, [...(reverse.get(target) ?? []), link]);
  };
  for (const p of props.values()) {
    addRev(p.merged_into, { type: "merged_from", id: p.id });
    if (p.related?.outcome === "refines") addRev(p.related.target, { type: "refined_by", id: p.id });
  }
  const entries: ViewEntry[] = [...props.values()].sort((a, b) => b.seq - a.seq).map((p) => {
    const links: ViewEntry["links"] = [];
    const add = (type: ViewEntry["links"][number]["type"], id: string | null | undefined) => {
      if (id && props.has(id) && !links.some((l) => l.type === type && l.id === id)) links.push({ type, id });
    };
    add("merged_into", p.merged_into);
    if (p.related?.outcome === "refines") add("refines", p.related.target);
    add("conflicts", p.conflicts_with);
    add("supersedes", p.supersedes);
    add("superseded_by", p.superseded_by);
    for (const c of p.pending_corrections) add(props.get(c)?.conflicts_with === p.id ? "conflicts" : "pending_correction", c);
    for (const l of reverse.get(p.id) ?? []) add(l.type, l.id);
    const own = vecs.get(p.id);
    const neighbors = own
      ? ids.flatMap((id) => {
          const n = props.get(id)!;
          if (id === p.id || (n.project_id !== null && p.project_id !== null && n.project_id !== p.project_id)) return [];
          return [{ id, similarity: Math.round(cosine(own, vecs.get(id)!) * 1000) / 1000 }];
        }).sort((a, b) => b.similarity - a.similarity).slice(0, NEIGHBORS)
      : [];
    const sessions = [p.source.session_id ? `${p.source.host ?? "?"}:${p.source.session_id}` : null,
      ...p.extra_sources.map((x) => (x.session_id ? `${x.host ?? "?"}:${x.session_id}` : null))].filter((s): s is string => !!s);
    const code = p.code_evidence ?? p.stale;
    return {
      id: p.id,
      kind: p.kind,
      text: p.text,
      why: p.why ?? null,
      summary: p.source.summary,
      trigger: p.trigger ?? null,
      project: p.project_id === null ? "全局" : (names.get(p.project_id) ?? "未知项目"),
      state: p.state,
      status: statusOf(p),
      origin: p.origin,
      host: p.source.host,
      sessions: [...new Set(sessions)],
      created: p.ts,
      for_workers: p.for_workers,
      expired: p.expired,
      review_due: due.has(p.id),
      valid_days: validDays(p),
      last_used: usage.get(p.id)?.last_used ?? null,
      unreconciled: p.unreconciled,
      evidence: p.evidence.map((e) => ({ role: e.role, anchor: e.anchor, quote_sha256: e.quote_sha256 })),
      code: code ? { head: code.head, refs: code.refs.map(refText), stale: !!p.stale } : null,
      links,
      neighbors,
      xy: xy.get(p.id) ?? null,
    };
  });
  return {
    generated: now.toISOString(),
    embed_model: store.vectorStatus().model,
    entries,
    counts: { total: entries.length, active: entries.filter((e) => e.state === "active").length, vectors: ids.length },
  };
}

/** JSON 嵌进 <script> 时转义，防止内容里的 </script> 截断脚本。 */
function embedJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderHtml(data: ViewData): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>agentbrain 记忆</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font:14px/1.5 -apple-system,"PingFang SC",sans-serif;margin:0;background:#f6f7f9;color:#222}
header{padding:14px 20px;background:#1f2937;color:#fff}header small{opacity:.7}
main{display:grid;grid-template-columns:420px 1fr;gap:16px;padding:16px}
section{background:#fff;border-radius:8px;padding:12px;box-shadow:0 1px 2px #0001}
.filters label{display:block;margin:6px 0}.filters select,.filters input[type=search]{width:100%;padding:4px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #eee;padding:2px 4px;text-align:left}
.card{background:#fff;border-radius:8px;padding:10px 12px;margin-bottom:10px;box-shadow:0 1px 2px #0001;border-left:4px solid #999}
.card.hl{outline:2px solid #f59e0b}.card.inactive{opacity:.6}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:9px;background:#eef;margin-right:4px}
.st-user{background:#d1fae5}.st-code{background:#bfdbfe}.st-corroboration{background:#e9d5ff}.st-unconfirmed{background:#fef3c7}.st-stale{background:#fecaca}
.meta{color:#666;font-size:12px}.why{color:#444;margin-top:4px}a{color:#2563eb;cursor:pointer}
details{margin-top:4px;font-size:12px}#tip{position:fixed;pointer-events:none;background:#111;color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;max-width:360px;display:none}
#legend span{margin-right:8px;font-size:12px}
</style></head><body>
<header><b>agentbrain 记忆</b> <small id="hdr"></small></header>
<main><div>
<section class="filters"><b>筛选</b>
<label><input type="search" id="q" placeholder="全文搜索"></label>
<label>项目 <select id="fp"></select></label>
<label>类型 <select id="fk"></select></label>
<label>状态 <select id="fs"></select></label>
<label>宿主 <select id="fh"></select></label>
<label>来源 <select id="fo"><option value="">全部</option><option value="extract">自动沉淀</option><option value="manual">手动记录</option></select></label>
<label><input type="checkbox" id="fa"> 显示已归档/已替代</label>
<div class="meta" id="shown"></div></section>
<section><b>向量地图</b>（PCA 二维投影，按项目着色；悬停看内容，点击跳到卡片）
<svg id="map" viewBox="0 0 400 400" width="100%"></svg><div id="legend"></div></section>
<section><b>概览</b><div id="ov"></div></section>
</div><div id="list"></div></main><div id="tip"></div>
<script id="data" type="application/json">${embedJson(data)}</script>
<script>
const D=JSON.parse(document.getElementById('data').textContent);
const E=D.entries,byId=new Map(E.map(e=>[e.id,e]));
const KIND={rule:'规则',decision:'决定',pitfall:'坑',note:'事实'};
const ST={user:'用户确认',code:'代码核验转正',corroboration:'跨会话印证转正',unconfirmed:'未确认',stale:'与代码不符'};
const STATE={active:'有效',archived:'已归档',superseded:'已被替代'};
const LINK={merged_into:'已并入',merged_from:'合并自',refines:'补充了',refined_by:'被补充',conflicts:'冲突',supersedes:'替代了',superseded_by:'被替代',pending_correction:'待确认纠正'};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const projects=[...new Set(E.map(e=>e.project))].sort();
const color=p=>'hsl('+(projects.indexOf(p)*137%360)+',65%,45%)';
const opt=(el,vals,lab)=>{el.innerHTML='<option value="">全部</option>'+vals.map(v=>'<option value="'+esc(v)+'">'+esc(lab?lab[v]??v:v)+'</option>').join('')};
const $=id=>document.getElementById(id);
opt($('fp'),projects);opt($('fk'),Object.keys(KIND),KIND);opt($('fs'),Object.keys(ST),ST);opt($('fh'),[...new Set(E.map(e=>e.host||'未知'))]);
$('hdr').textContent='生成于 '+new Date(D.generated).toLocaleString()+' · 共 '+D.counts.total+' 条，有效 '+D.counts.active+' 条，有向量 '+D.counts.vectors+' 条 · embedding: '+(D.embed_model||'无');
const short=id=>id.slice(0,8);
const ref=id=>{const e=byId.get(id);return '<a data-go="'+id+'">['+short(id)+']</a> '+(e?esc(e.text.split('\\n')[0].slice(0,60)):'')};
function card(e){return '<div class="card'+(e.state!=='active'?' inactive':'')+'" id="c-'+e.id+'" style="border-left-color:'+color(e.project)+'">'+
'<div><span class="tag">'+esc(e.project)+'</span><span class="tag">'+KIND[e.kind]+'</span><span class="tag st-'+e.status+'">'+ST[e.status]+'</span>'+
(e.state!=='active'?'<span class="tag">'+STATE[e.state]+'</span>':'')+(e.unreconciled?'<span class="tag">关系未判定</span>':'')+(e.expired?'<span class="tag">到期归档</span>':'')+(e.review_due?'<span class="tag">到期待复审</span>':'')+
'<span class="meta">['+short(e.id)+'] '+(e.origin==='extract'?'自动沉淀':e.origin==='import'?'导入':'手动')+' · '+esc(e.host||'未知宿主')+' · '+e.created.slice(0,16).replace('T',' ')+'</span></div>'+
'<div style="white-space:pre-wrap;margin-top:4px">'+esc(e.text)+'</div>'+
(e.why?'<div class="why">为什么：'+esc(e.why)+'</div>':'')+'<div class="meta">背景：'+esc(e.summary)+(e.trigger?' · 触发：'+esc(e.trigger):'')+'</div>'+
(e.links.length?'<div class="meta">'+e.links.map(l=>LINK[l.type]+' '+ref(l.id)).join('<br>')+'</div>':'')+
'<details><summary>证据与来源（'+e.evidence.length+' 处引文，'+e.sessions.length+' 个会话）</summary>'+
e.sessions.map(s=>'<div>会话 '+esc(s)+'</div>').join('')+
e.evidence.map(v=>'<div>'+esc(v.role)+' @ '+esc(v.anchor)+' <span class="meta">sha256 '+esc(v.quote_sha256.slice(0,12))+'</span></div>').join('')+
(e.evidence.length?'<div class="meta">原话正文不入库，要看用 ab get '+short(e.id)+' --expand</div>':'')+
(e.code?'<div>'+(e.code.stale?'与代码不符':'代码证据')+'（HEAD '+esc(e.code.head.slice(0,10))+'）：<br>'+e.code.refs.map(esc).join('<br>')+'</div>':'')+'</details>'+
(e.neighbors.length?'<details><summary>向量近邻 top '+e.neighbors.length+'</summary>'+e.neighbors.map(n=>'<div>'+n.similarity.toFixed(2)+' '+ref(n.id)+'</div>').join('')+'</details>':'')+'</div>'}
function visible(){const q=$('q').value.trim().toLowerCase();return E.filter(e=>($('fa').checked||e.state==='active')&&(!$('fp').value||e.project===$('fp').value)&&(!$('fk').value||e.kind===$('fk').value)&&(!$('fs').value||e.status===$('fs').value)&&(!$('fh').value||(e.host||'未知')===$('fh').value)&&(!$('fo').value||e.origin===$('fo').value)&&(!q||[e.id,e.text,e.why,e.summary,e.trigger].join(' ').toLowerCase().includes(q)))}
function count(list,key){const m={};list.forEach(e=>{const k=key(e);m[k]=(m[k]||0)+1});return Object.entries(m).sort((a,b)=>b[1]-a[1])}
function table(title,rows){return '<h4 style="margin:8px 0 2px">'+title+'</h4><table>'+rows.map(r=>'<tr><td>'+esc(r[0])+'</td><td>'+r[1]+'</td></tr>').join('')+'</table>'}
function render(){const v=visible();$('shown').textContent='显示 '+v.length+' 条';$('list').innerHTML=v.map(card).join('')||'<p>没有符合条件的记忆</p>';
$('ov').innerHTML=table('按项目',count(v,e=>e.project))+table('按类型',count(v,e=>KIND[e.kind]))+table('按状态',count(v,e=>ST[e.status]));
const pts=v.filter(e=>e.xy);const svg=$('map');if(!pts.length){svg.innerHTML='<text x="10" y="20">没有向量</text>';return}
const xs=pts.map(e=>e.xy[0]),ys=pts.map(e=>e.xy[1]),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
const sx=x=>10+380*(x-x0)/((x1-x0)||1),sy=y=>390-380*(y-y0)/((y1-y0)||1);
svg.innerHTML=pts.map(e=>'<circle data-id="'+e.id+'" cx="'+sx(e.xy[0]).toFixed(1)+'" cy="'+sy(e.xy[1]).toFixed(1)+'" r="4" fill="'+color(e.project)+'" fill-opacity="'+(e.state==='active'?0.8:0.3)+'" stroke="#fff" stroke-width=".5" style="cursor:pointer"/>').join('');
$('legend').innerHTML=[...new Set(pts.map(e=>e.project))].map(p=>'<span><b style="color:'+color(p)+'">●</b> '+esc(p)+'</span>').join('')}
function go(id){const e=byId.get(id);if(!e)return;if(!document.getElementById('c-'+id)){$('q').value='';['fp','fk','fs','fh','fo'].forEach(k=>$(k).value='');if(e.state!=='active')$('fa').checked=true;render()}
const el=document.getElementById('c-'+id);document.querySelectorAll('.hl').forEach(x=>x.classList.remove('hl'));el.classList.add('hl');el.scrollIntoView({behavior:'smooth',block:'center'})}
document.addEventListener('click',ev=>{const t=ev.target.closest('[data-go],[data-id]');if(t)go(t.dataset.go||t.dataset.id)});
const tip=$('tip');$('map').addEventListener('mousemove',ev=>{const id=ev.target.dataset&&ev.target.dataset.id;if(!id){tip.style.display='none';return}const e=byId.get(id);tip.textContent='['+e.project+' · '+KIND[e.kind]+'] '+e.text.slice(0,140);tip.style.display='block';tip.style.left=(ev.clientX+12)+'px';tip.style.top=(ev.clientY+12)+'px'});
$('map').addEventListener('mouseleave',()=>tip.style.display='none');
['q','fp','fk','fs','fh','fo','fa'].forEach(k=>$(k).addEventListener('input',render));render();
</script></body></html>`;
}

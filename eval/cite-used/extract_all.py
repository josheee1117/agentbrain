"""汇总所有宿主 .done 的运行。注入的召回 id 以库里 inject_log(path=recall, 该会话) 为准（真实产物），
回答正文取宿主输出的最终消息；scan_cited 来自 ab view --no-open 扫描后的 inject_log.cited。"""
import json, glob, os, re, sqlite3
R='/private/tmp/cite-eval'; rows=[]
AB=re.compile(r'^\s*`?\s*ab-used\s*[:：]\s*(.*?)`?\s*$',re.I|re.M)
def parse(host,path):
    sid=None; ans=''; model=None; extra={}
    for l in open(path):
        try: e=json.loads(l)
        except Exception: continue
        t=e.get('type')
        if host in('glm','ds'):
            if t=='session': sid=e['id']
            if t=='message_end' and e['message'].get('role')=='assistant' and e['message'].get('stopReason')!='error':
                m=e['message']; ans=''.join(x.get('text','') for x in m['content'] if x.get('type')=='text'); model=f"{m.get('provider')}/{m.get('model')}"
                extra['has_thinking']=any(x.get('type')=='thinking' and x.get('thinking','').strip() for x in m['content'])
            mm=re.search(r'"thinkingLevel":\s*"(\w+)"',l)
            if mm: extra['thinkingLevel']=mm.group(1)
        elif host=='claude':
            if t=='system' and e.get('subtype')=='init': sid=e.get('session_id'); model=e.get('model')
            if t=='result' and not e.get('is_error'): ans=e.get('result',''); extra['modelUsage']=list(e.get('modelUsage',{}).keys())
        elif host=='codex':
            if t=='thread.started': sid=e['thread_id']
            it=e.get('item',{})
            if t=='item.completed' and it.get('type')=='agent_message': ans=it.get('text','')
            if t=='turn.completed': extra['reasoning_tokens']=e['usage'].get('reasoning_output_tokens')
        elif host=='opencode':
            sid=e.get('sessionID',sid)
            if t=='text': ans+=e.get('part',{}).get('text','')
            if t=='reasoning': extra['has_reasoning']=True
    return sid,ans,model,extra
dbs={c:sqlite3.connect(f'file:{R}/abhome-{c}/store.db?mode=ro',uri=True) for c in('on','off')}
for done in sorted(glob.glob(f'{R}/runs/*-*/q*.done')):
    lane=done.split('/')[-2]; host,cond=lane.split('-'); q=os.path.basename(done)[:-5]
    sid,ans,model,extra=parse(host,done[:-5]+'.jsonl')
    db=dbs[cond]
    inj=[r[0] for r in db.execute("select substr(prop_id,1,8) from inject_log where session_id=? and path='recall' order by ts,rank",(sid,))]
    cited=[{'id':a,'title':b,'mismatch':c} for a,b,c in db.execute("select substr(prop_id,1,8),cited_title,title_mismatch from inject_log where session_id=? and path='recall' and cited=1",(sid,))]
    other=[r[0] for r in db.execute("select distinct path from inject_log where session_id=? and path!='recall'",(sid,))]
    used=AB.findall(ans)
    rows.append(dict(lane=lane,host=host,cond=cond,q=q,session=sid,model=model,injected=inj,other_inject_paths=other,answer=ans,ab_used_line=used[-1] if used else None,scan_cited=cited,dirty=os.path.exists(done[:-5]+'.dirty.diff'),**extra))
json.dump(rows,open(f'{R}/runs/summary.json','w'),ensure_ascii=False,indent=1)
print(len(rows),'runs')

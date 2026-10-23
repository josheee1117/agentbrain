"""eval 16 回答质量盲评：同题 cite on/off 两个回答（已删掉 ab-used 行，顺序随机），异族模型判哪个更好。
用法：python3 judge.py pairs.json out/   断点续跑；输出 out/<host>_<q>.json"""
import json,os,subprocess,sys,re,time,datetime
P=json.load(open(sys.argv[1])); O=sys.argv[2]; os.makedirs(O,exist_ok=True)
DEADLINE=datetime.datetime.now()+datetime.timedelta(hours=float(os.environ.get('HOURS','2')))
T="""你是代码评审专家，在评一个叫 agentbrain 的 TypeScript 项目（给编码代理用的本地记忆库 CLI，SQLite 存储，带 hook 召回）的开发问答。
下面是开发者的问题和两个助手回答 A、B。请判断哪个回答对开发者更有用：是否切中问题、具体可执行、没有错误或编造、没有无关内容。长度本身不是优点。
只输出一行 JSON：{{"winner":"A"|"B"|"tie","reason":"一句话中文理由"}}

## 问题
{question}

## 回答 A
{A}

## 回答 B
{B}
"""
def run(p):
    c=['pi','-p','--mode','json','--no-extensions','--no-tools','--no-skills','--no-prompt-templates','--no-mcp','--no-context-files','--thinking','max','--model',p['judge'],T.format(**p)]
    r=subprocess.run(c,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=900,cwd='/tmp')
    txt='';err='';model=None
    for l in r.stdout.splitlines():
        try: e=json.loads(l)
        except Exception: continue
        if e.get('type')=='message_end' and e['message'].get('role')=='assistant':
            m=e['message']
            if m.get('stopReason')=='error': err=str(m.get('errorMessage'))
            else: txt=''.join(x.get('text','') for x in m['content'] if x.get('type')=='text'); model=f"{m.get('provider')}/{m.get('model')}"
    return txt,err or r.stderr[-300:],model
for p in P:
    f=f"{O}/{p['id'].replace('/','_')}.json"
    if os.path.exists(f): continue
    tries=0
    while datetime.datetime.now()<DEADLINE:
        txt,err,model=run(p)
        m=re.search(r'\{[^{}]*"winner"\s*:\s*"(A|B|tie)"[^{}]*\}',txt)
        if m:
            v=json.loads(m.group(0)); w=v['winner']
            cond={'A':p['A_is'],'B':'off' if p['A_is']=='on' else 'on','tie':'tie'}[w]
            json.dump(dict(id=p['id'],judge=p['judge'],judge_model=model,A_is=p['A_is'],winner=w,better=cond,reason=v.get('reason'),raw=txt),open(f,'w'),ensure_ascii=False); print(p['id'],cond,flush=True); break
        if '429' in err or 'limit' in err.lower() or 'quota' in err.lower():
            print(p['id'],'quota',err[:120],flush=True); time.sleep(600); continue
        tries+=1; print(p['id'],'fail',err[:120],txt[:80],flush=True)
        if tries>=2: break

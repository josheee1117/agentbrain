import json,subprocess,os,re
env=dict(os.environ,AB_HOME='/private/tmp/cite-eval/abhome-pre',AB_REGISTRY='/private/tmp/cite-eval/registry',HOME='/private/tmp/cite-eval/home-off')
out={}
for q in json.load(open('/tmp/cite-eval/harness/questions.json')):
    p=subprocess.run(['/opt/homebrew/bin/node','/private/tmp/cite-eval/agentbrain/src/cli.ts','recall','--hook'],input=json.dumps({'prompt':q['prompt'],'cwd':'/private/tmp/cite-eval/agentbrain','want_count':True}),capture_output=True,text=True,env=env,cwd='/private/tmp/cite-eval/agentbrain')
    d=json.loads(p.stdout) if p.stdout.strip() else {}
    ctx=d.get('hookSpecificOutput',{}).get('additionalContext','')
    ids=re.findall(r'^- \[([0-9a-f]{8})\]',ctx.split('<agentbrain-recall>')[-1],re.M) if '<agentbrain-recall>' in ctx else []
    out[q['id']]=ids; print(q['id'],d.get('agentbrain'),ids)
json.dump(out,open('/tmp/cite-eval/harness/preflight.json','w'))

import json, subprocess
CLI='/private/tmp/cite-eval/agentbrain/src/cli.ts'
m={}
for s in json.load(open('/tmp/cite-eval/harness/seed.json')):
    a=['node',CLI,'remember','--confirmed','--kind',s['kind'],'--text',s['text'],'--why',s['why'],'--summary','cite-eval seed '+s['orig']]
    a+=['--global'] if s['scope']=='global' else ['--project','agentbrain']
    p=subprocess.run(a,capture_output=True,text=True,stdin=subprocess.DEVNULL,cwd='/private/tmp/cite-eval/agentbrain')
    print(s['orig'],p.returncode,(p.stdout+p.stderr).strip()[:120])

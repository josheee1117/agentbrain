import json, re
G = "7345c5a1 da07940f 8c6f31ab 1c920fc7 09d5d1b5 3574673d 3f79d9fc fb6ea8c4 7e107d15 dd6a4fdc 71cefbfd 2352b4ab c7afa685 44d60254 551ed4b1 15660141 dda5bdf3 dcfc5a22".split()
SCRUB = [(re.compile(r'[\w.+-]+@[\w-]+\.[\w.]+'), '<email>'), (re.compile(r'\b\d{1,3}(\.\d{1,3}){3}\b'), '<ip>'),
         (re.compile(r'(sk|ak)-[A-Za-z0-9]{8,}'), '<key>'), (re.compile(r'/Users/[^/\s]+'), '~')]
def scrub(s):
    for r, t in SCRUB: s = r.sub(t, s)
    return s
def split(t):
    i = t.find('\n')
    return (t[:i].strip(), t[i+1:].strip()) if i > 0 else (t, '')
out = []
for f, scope in [('ab-props', 'project'), ('global-props', 'global')]:
    for r in json.load(open(f'/tmp/cite-eval/{f}.json')):
        if scope == 'global' and r['id'][:8] not in G: continue
        text, why = split(scrub(r['text']))
        out.append({'orig': r['id'][:8], 'scope': scope, 'kind': r['kind'], 'text': text, 'why': why or '（无）'})
json.dump(out, open('/tmp/cite-eval/harness/seed.json', 'w'), ensure_ascii=False, indent=1)
print(len(out), sum(o['scope']=='global' for o in out))

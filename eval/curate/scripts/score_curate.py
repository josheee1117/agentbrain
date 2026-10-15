import json,sys
d=json.load(open(sys.argv[1]))
rows=d['rows']
# 用户点评明确说"应该改写成偏好/补场景"的两条：改写也算对（只作为补充口径）
REWRITE_OK={('s30',4),('s30',12)}
def pct(a,b): return f"{a}/{b}={100*a/b:.0f}%" if b else "n/a"
def score(xs, mode):
  def admit(r,v):
    if v is None: return None
    if mode=='effective' and v=='merge': return r['gold']  # 并入=不新增条目；对有用的=知识已在库
    return v!='discard'
  ul=[r for r in xs if not r['gold']]; uf=[r for r in xs if r['gold']]
  def ok(r):
    a=admit(r,r['final'])
    if mode=='adjusted' and (r['set'],r['n']) in REWRITE_OK and r['final']=='rewrite': return True
    return a==r['gold']
  return dict(discard_useless=pct(sum(ok(r) for r in ul),len(ul)), keep_useful=pct(sum(ok(r) for r in uf),len(uf)))
for s in ['s30','fresh']:
  xs=[r for r in rows if r['set']==s]
  print(s, {m:score(xs,m) for m in ['strict','effective','adjusted']}, 'final:',{v:sum(r['final']==v for r in xs) for v in ['keep','rewrite','merge','discard',None]}, 'arbiter',sum(r['route']=='arbiter' for r in xs))

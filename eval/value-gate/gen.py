import json
d=json.load(open("raw_sample.json"))
Q={
"22b0fb9d":"docker的那个cpu和业务错误日志为什么不能主动发现？",
"dd03a351":"什么勾八，我要的是能够理解的计算方式，这个指标怎么来的…计算方式需要给我生成一个最终版本到一个字段",
"42830c38":"那就先使用 subagent 吧，我再体验体验。",
"dda5bdf3":"给我一个用人话的版本，你现在说的我看不懂",
"e6aa6726":"我说的耗时是指从提交问题，但最终任务执行完毕。而不是只是提交成功",
"77cbf3ea":"（企微 webhook key 已脱敏）…再推到测试机器之前能否在本地docker验证一下呢。即使项目起不来，也可以模拟一个类似dataasset的jdk17的项目啊。",
"d7fbd3d6":"后面使用 pi 时可以尝试 rpc 这种方式（据 why 字段；会话证据只剩选项回复）",
"8d281513":"（选项卡片回复，原文未留存）",
"94cf1473":"（有 1 处引文，但当时讨论已不可展开）",
"ed9f5e6c":"⚠ 证据是派活提示「任务如下。」——疑似主代理写给子代理的话，不是你本人",
"0f00e247":"⚠ 证据是派活提示「你在 …ai-data-metric-catalog 工作…」——疑似主代理写的，不是你本人",
"8279061f":"⚠ 证据是派活提示「目标仓库：…只加测试，不改任何实现代码」——疑似主代理写的，不是你本人",
}
SRC={"pensieve":"pensieve"}
KIND={"rule":"规则","decision":"决定","pitfall":"踩坑","note":"笔记"}
ST={"unconfirmed":"未确认","confirmed":"已确认","code-verified":"代码核验","pensieve":"已确认(导入)"}
def t(s,n): s=" ".join(s.split()); return s if len(s)<=n else s[:n]+"…"
md=["# agentbrain 记忆价值抽样（30 条）","",f"随机种子 `{d['seed']}`，从 512 条有效记忆里按 类型×状态×范围 分层抽取。请每条标「有用 / 没用」（可附一句理由）。","",]
out=[]
for i,x in enumerate(d["items"],1):
    sid=x["id"][:8]; pen=x["status"]=="pensieve"
    why=x["why"] or "（未记录背景）"
    q=Q.get(sid, "—（导入条目，无对话原话）" if pen else "—（无用户原话，agent 自己观察/推断）")
    if "整理(" in x["summary"]: src="对话（整理合并）"
    else: src="pensieve" if pen else "对话"
    card=dict(n=i,id=sid,full_id=x["id"],scope=("项目·"+x["project"]) if x["project"] else "全局",kind=KIND[x["kind"]],status=ST[x["status"]],source=src,content=t(x["text"],110),background=t(why,70),quote=q,stratum=x["stratum"])
    out.append(card)
    md+= [f"**{i}. `{sid}`** · {card['scope']} · {card['kind']} · {card['status']} · {src}",
          f"- 内容：{card['content']}", f"- 背景：{card['background']}", f"- 原话：{q}", "- 你的判断：☐ 有用 ☐ 没用",""]
json.dump({"seed":d["seed"],"population_active":512,"plan":d["plan"],"items":out},open("sample30.json","w"),ensure_ascii=False,indent=1)
open("sample30.md","w").write("\n".join(md))

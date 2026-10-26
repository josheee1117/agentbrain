# ab view (记忆看板)

## Sub-features
- 生成自包含 HTML 记忆看板 (`ab view [--out <路径>] [--no-open]`)，默认 `~/.agentbrain/view.html`，权限 0600
- 概览、关联图、记忆详情、注入/引用统计；数据嵌在 HTML 里，离线可开
- 引用扫描：读注入记录，统计每条被 recall/brief 注入过几次、模型用 `ab-used` 引用了哪条，对不上的丢弃

## How to get to it (user POV)
- 手动运行 `ab view`，自动用浏览器打开看板
- 无桌面或要留证据时用 `ab view --no-open --out <路径>`，只生成文件

## Driving it with verify.sh
- `env HOME="$FAKE_HOME" AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts view --no-open --out "$EV/view.html"`
- Proof: 退出码 0，打印"已生成 … 共 N 条"；`view.html` 非空且含"agentbrain 记忆看板"

## Gotchas
- 只手动生成，后台不自动刷新
- 没有候选状态（§8.8）：旧版本写成候选的条目在看板里状态是"有效"、可信程度是"未确认"
- 引用统计依赖 `inject_log` 和宿主会话 transcript；读不到的会话不计引用或计入丢弃

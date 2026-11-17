# team（真实宿主一轮四步）

设计 §12.6.11 第 5 条。驱动是 `team.ts`。

## Sub-features
- Pi、Codex、Claude Code 各跑一轮真实会话：`ab brief` → 本地构建失败再修好 → `ab search` + `ab get` → `ab status` → 回答五个问题
- 库是正式库的副本（`AB_HOME` 指向临时目录），`HOME` 保持真实；项目清单只有临时仓库 `team-demo`，正式库的后台巡检不会抽这些会话
- 逐宿主断言：开工注入（含代码核验标注和说明行）、每轮注入块、搜索结果带确认来源和命中方式、`ab get` 的「确认」「写入」两行并在回答里说出操作者、会话结束后抽取写进副本库且事件带操作者和机器、`ab status` 的 要处理 / 代码 / 库 / 备份 / 失败窗口 各行
- 正式库核对：复制正式库后查，本次会话 id 在 events、inject_log、recall_runs、memory_queries、memory_reports、capture_windows 里都必须是 0

## Driving it with verify.sh
- `verify.sh team [pi codex claude]`，或 `node .agents/skills/verify-agentbrain/team.ts --evidence <目录> [--cli <别的 worktree 的 cli.ts>] pi codex claude`
- Proof: `summary.json` 的 status 是 `PASS`；每个宿主目录里有 `result.json`（逐项结果）、`transcript.jsonl`（宿主的会话记录）、`final-answer.txt`、`sql.json`（副本库里的交付、窗口、事件）；`production-isolation.json` 各表为 0

## Gotchas
- Claude Code 官方登录失效时（`claude auth status` 的 `loggedIn` 为 false）改走本机网关的 Anthropic 兼容接口，模型由 `AB_TEAM_CLAUDE_MODEL` 指定；宿主仍是真实的 Claude Code。`result.json` 的 `model` 写明用的哪个
- Pi 的模型由 `AB_TEAM_PI_MODEL` 指定，默认 `magpie/codex/gpt-5.6-terra`
- 夹具不能叫 deploy：Claude Code 的权限分类器会把它当成没有预览的生产发布拦下
- `codex exec` 的会话被认作 worker 会话，用户原话不算证据，只抽工具输出证实的坑。夹具里的残留构建锁就是给它准备的
- Codex 用临时 HOME 跑，钥匙串读不到：驱动在 PATH 里放了一个转发到真实 HOME 的 `security`
- 抽取用真实模型，产出不是确定的：某个宿主没抽出事件时重跑那一个宿主

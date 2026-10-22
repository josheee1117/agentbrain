# ab status / doctor

## Sub-features
- 数据库摘要与 active 记忆计数 (`ab status`)
- 宿主与清单接线自检、向量与抽取模型连通诊断 (`ab doctor`)
- 单行 JSON 状态输出供宿主状态栏使用 (`ab status --line`)

## How to get to it (user POV)
- CLI 执行 `ab status` 或 `ab doctor`，查看当前库容量、活跃条目数和宿主诊断
- 宿主状态栏（如 Pi 状态栏扩展）调用 `ab status --line`，输出 `{"review": 0, "work_failed": 0}` 等轻量结构

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts status`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts status --line`
- Proof: 退出码 0，输出包含 active 计数和诊断行，`status --line` 输出合法的单行 JSON

## Gotchas
- 空库输出 "active: 无" 属于预期状态
- 未配置 embedding.json 时 status 会如实诊断向量不可用，系统自动降级为纯全文检索

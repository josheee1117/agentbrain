# ab status / doctor

## Sub-features
- 数据库摘要与 active 记忆计数 (`ab status`)
- 当前冲突对数、最老等待天数和期间注入行数，零冲突写 "冲突 0 对"。口径与副本验收见 [conflicts.md](conflicts.md)。
- 宿主与清单接线自检、向量与抽取模型连通诊断 (`ab doctor`)
- 单行 JSON 状态输出供宿主状态栏使用 (`ab status --line`)

- 开头是「要处理」清单（没有就写「要处理: 没有要处理的事」）：库比代码新、不认识的事件、抽取模型不可用、近 7 天失败窗口、备份缺失或超过 48 小时、代码有未提交文件、冲突、到期待复审、向量不可用、钩子漏登记
- `代码:` 提交号、分支、未提交文件数（只看 src、integrations、package.json）；`库:` 版本、事件数、不认识的事件数；`备份:` 最近一次和份数；`失败窗口:` 最近 5 个失败或延后窗口的时间、宿主、错误码、字数和原因
- 孤立项目超过 3 个折成一行

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
- 「抽取模型」行的三种状态：正常打印 `<模型> @ <主机>（key: 钥匙串 <service>）`；`extract.json` 不存在或不是合法 JSON 时打「不可用（<错误>）」；`extraBody` 不是对象时也在这里报「extraBody 必须是对象」，不另外报错
- 固定统计行的一条已验证口径：`关系未判定积压（§9.4.4）` 计数状态有效（active）且 `unreconciled` 的条目；`到期待复审` 只算未确认条目，计时起点取「来源时间」与「最近一次被注入」中较晚的那个（来源时间 = `said_at`，没有就用来源会话开始时间，再没有才用写入时间），过期不会自动归档，要 `ab review --archive`

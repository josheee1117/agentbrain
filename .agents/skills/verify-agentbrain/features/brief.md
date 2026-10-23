# ab brief

## Sub-features
- 主会话开工记忆速览，展示全局规则与当前项目的坑
- 子代理模式 (`ab brief --worker`)，仅输出标记为 for_workers 的全局规则，排除未确认规则与项目坑，提示不写记忆
- 智能预算控制，当条目总长超出字符上限时跳过整条条目，并在输出末尾提示使用 `ab search`

## How to get to it (user POV)
- 主会话开工第一步运行 `ab brief`
- 派发给子代理的任务提示词中运行 `ab brief --worker`
- 在项目管理仓库中运行 `ab brief` 查看全局规则与各个已登记项目的概况

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts brief`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" AB_REGISTRY="$AB_REGISTRY" node src/cli.ts brief --worker`
- Proof: 退出码 0，主会话模式打印全局规则与项目坑，worker 模式仅打印 for_workers 规则并附带子代理免写提示

## Gotchas
- 超出预算时优先整条跳过，绝不硬截断句子结尾，末尾保留 search 建议行
- 未确认记忆不展示正文，仅以统计计数提醒

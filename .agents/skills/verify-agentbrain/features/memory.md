# remember / search / get / correct

## Sub-features
- 显式记录记忆 (`ab remember --kind <rule|decision|pitfall|note> --text ... --summary ... [--confirmed] [--global] [--for-workers]`)
- 记忆纠正与替换 (`ab correct <id> --text ... --summary ... [--confirmed]`)
- 混合检索 (`ab search <query> [--kind ...] [--project ...] [--archived]`)，前 8 条全文加关联关系，第 9 至 16 条单行显示
- 详情与关联查看 (`ab get <id> [--expand]`)，展示双向关联、待确认纠正、向量近邻与原始讨论出处
- 记忆生命周期操作 (`ab confirm <id>`, `ab archive <id> [--reactivate]`, `ab guidance <id>`)

## How to get to it (user POV)
- 用户明确要求记录某条结论时执行 `ab remember --confirmed ...`
- 检索相关知识执行 `ab search <关键词>`
- 查看某条记忆的来源背景与邻近关联执行 `ab get <id 前缀>`
- 纠正已被推翻的旧记忆执行 `ab correct <id> ...`

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts remember --kind rule --text "测试全局规范：验证先于声明完成" --summary "验证规范" --global --confirmed`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts search "验证规范"`
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts get <id>`
- Proof: remember 成功写入并投影至 L2，search 返回匹配条目，get 返回该条目正文与元数据

## Gotchas
- agent 未带 `--confirmed` 的 remember 默认写入候选区（candidate），不进 brief、search 和 recall，需等待审稿或手动 `confirm`
- 纯向量通道依赖 embedding API key，无 key 时自动降级为 FTS5 全文搜索

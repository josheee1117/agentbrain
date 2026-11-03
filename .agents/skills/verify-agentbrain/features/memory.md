# remember / search / get / correct

## Sub-features
- 显式记录记忆 (`ab remember --kind <rule|decision|pitfall|note> --text ... --summary ... [--confirmed] [--global] [--for-workers]`)
- 规则场景标签 (`ab remember ... --scene design,code` / `ab tag <id> --scene design,code|none`)，brief 按场景加载见 [scene.md](scene.md)
- 记忆纠正与替换 (`ab correct <id> --text ... --summary ... [--confirmed]`)
- 混合检索 (`ab search <query> [--kind ...] [--project ...] [--archived]`)，前 8 条全文加关联关系，第 9 至 16 条单行显示
- 详情与关联查看 (`ab get <id> [--expand]`)，展示双向关联、待确认纠正、向量近邻与原始讨论出处；模型产出的条目另有一段「模型产出记录」（§8.10）
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
- `env AB_HOME="$AB_HOME" AGENTBRAIN_HOME="$AB_HOME" node src/cli.ts get <id>`（先往库里补一条带 `model` / `prompt_version` 的 `evidence` 事件），输出里的「模型产出记录」按事件列 `追加证据: <模型>，提示词版本 <版本>`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts correct <id> --text ... --summary ... --confirmed`，再用 `get` 确认旧条目显示「（已被替代）」
- `env AB_HOME="$AB_HOME" ... node src/cli.ts archive <id>` / `archive <id> --reactivate`，`get` 相应出现、消失「（已归档）」
- `env AB_HOME="$AB_HOME" ... node src/cli.ts guidance <id>`，再用 `recall --hook` 确认出现在 `<agentbrain-prefs>`；`guidance <id> --off` 后消失
- Proof: remember 成功写入并投影至 L2，search 返回匹配条目，get 返回该条目正文与元数据；模型产出段的 kind 标签为 抽取 / 追加证据 / 关系判定 / 代码核验，缺字段显示「未记录」

## Gotchas
- agent 未带 `--confirmed` 的 remember 照常写入并生效（state=active），只标"未确认"：search 能看到（带 `[未确认]`），不进 brief，用户 `ab confirm` 后才进 brief；没争议的坑/规则/决定按 §21 2026-10-14 的规矩进每轮召回（每轮最多 1 条，标"未确认"）
- 2026-10-22 起没有候选区（§8.8）：`ab stage`、`ab audit agent-remember`、`ab remember --direct` 都已删除；旧库里的候选条目升级后就是有效的未确认条目
- 纯向量通道依赖 embedding API key，无 key 时自动降级为 FTS5 全文搜索
- 这一段按条件出现：手工 `ab remember` 的条目没有它；旧库缺字段的抽取条目、`ab curate --apply` 改写的条目有它但值显示「未记录」（不补造，§8.10）
- 提示词版本是实发系统提示词全文的 SHA-256 前 12 位；旧话题事件的 `topic.model` / `topic.prompt_version` 原样读出，不回填

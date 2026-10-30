# 场景标签（scene）

## Sub-features
- 规则按场景打标签：`design`（设计）/ `code`（开发）/ `review`，可多选；空表示不分场景（设计 §11.10）
- 写入与修改：`ab remember --kind rule --scene design,code ...`，`ab tag <id 前缀> --scene design,code|none`（整组替换，`none` 清空）
- 开工按场景加载：`ab brief --scene code` 把带场景规则从通用段移到「场景规则」段，单独 2000 字预算；不带 `--scene` 时只多一行索引（各场景条数）
- 按场景列举：`ab search --scene code` 直接遍历投影列出范围内该场景的全部规则（含未确认条目，带 `[未确认]` 标记；全文、seq 倒序），不走混合检索
- 互斥与继承：带场景的规则不能标成常驻偏好（`ab guidance`、`ab tag --scene`）；`ab correct`、`ab curate` 改写与 Pensieve 重导的替代条目复制旧条目的场景；`guidanceBlock` 兜底跳过带场景条目，`ab curate` 转正时不打 guidance

## How to get to it (user POV)
- 主会话写方案前：`ab search --scene design`；验收 review 前：`ab search --scene review`
- 被派活的子代理开工：主会话派活单加场景后跑 `ab brief --worker --scene code`（派活工具 `tools/herdr-dispatch` 负责加这一行）
- 改标签：`ab tag <id 前缀> --scene review`，去掉：`ab tag <id 前缀> --scene none`

## Driving it with verify.sh
- `env AB_HOME="$AB_HOME" ... node src/cli.ts remember --confirmed --global --for-workers --kind rule --text "..." --summary "..." --scene design`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts tag <id> --scene code`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts brief`（无场景：只有索引行，场景规则正文不出现）
- `env AB_HOME="$AB_HOME" ... node src/cli.ts brief --worker --scene code`（含该条，头标签 `worker scene="code"`）
- `env AB_HOME="$AB_HOME" ... node src/cli.ts search --scene code`
- Proof: brief 输出里场景规则只在带 `--scene` 时成段出现；`ab search --scene code 关键词`、配 `--archived`、配 `--kind` 非 rule 都退出码 1；`--scene` 配非 rule、未知值、与 guidance 互斥都报错退出；未确认的场景规则出现在 `search --scene` 但不在 brief

## Gotchas
- 取值只在 CLI 边界校验，内部只用 `Scene[]`；`--scene none` 只对 `ab tag` 有效
- brief 不读环境变量定场景（设计明确去掉了 `AB_SCENE`）：场景只来自 `--scene` 参数
- 先定范围再筛场景：项目目录 / 显式项目名取全局 + 本项目；pm 目录与未登记目录只取全局；`--worker` 时全局规则要求 `for_workers`，本项目规则不要求
- `markUsed` / `inject_log` 只记最终实际输出（硬截断兜底时会把丢掉的 id 剔掉）
- 场景标签与 `guidance` 互斥只在两个入口检查：`ab tag --scene` 和 `ab guidance`；绕过这两处的写入方（导入、curate）不报错，但 `guidanceBlock` 与 `ab curate` 都跳过/不写 guidance，所以带场景条目不会每轮注入

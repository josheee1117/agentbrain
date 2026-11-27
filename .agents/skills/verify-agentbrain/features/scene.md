# 场景标签与按需路由（scene）

## Sub-features
- 规则按四场景打标签：`design`（设计）/ `code`（开发）/ `test`（测试）/ `review`，可多选；空表示不分场景（设计 §11.10）
- 写入与修改：`ab remember --kind rule --scene design,code ...`，`ab tag <id 前缀> --scene design,code,test|none`（整组替换，`none` 清空）
- 按需加载降级：`ab tag <id 前缀> --on-demand`（恢复用 `--no-on-demand`）将低频情境规则移出 `brief` 自动注入，保留在 `ab search` / `ab search --scene`（标 `[按需]`）
- 开工渐进式披露：`ab brief --scene code`（子代理通用全局段上限 8 条）在「场景规则」段按专属性优先 `(a.scenes.length - b.scenes.length) || (b.seq - a.seq)` 最多注入 `8` 条（3000 字预算），附各场景 `按需触发器` 提示何时主动跑 `ab search`；不带 `--scene` 时只输出一行各场景条数索引
- 互补误报冲突解除与噪音巡检：`ab relate <id1> <id2> --coexist|--refines [--reason ...]` 显式写入人工共存/补充关系覆盖关系判定误报冲突；`ab inbox --noise [--json]` 只读列出近 30 天高注入低引用规则
- 按场景列举：`ab search --scene code` 直接遍历投影列出范围内该场景的全部规则（含 `[未确认]` 与 `[按需]` 标记；全文、seq 倒序），不走混合检索
- 互斥与继承：带场景的规则不能标成常驻偏好（`ab guidance`、`ab tag --scene`）；`ab correct`、`ab curate` 改写与 Pensieve 重导复制旧条目的场景，`ab correct` 同步继承 `on_demand`

## How to get to it (user POV)
- 主会话写方案前：`ab search --scene design`；测试设计前：`ab search --scene test`；验收 review 前：`ab search --scene review`
- 被派活的子代理开工：`tools/dispatch` 按派活单类别自动加 `ab brief --worker --scene code|test|review|design,review`
- 改场景或转按需：`ab tag <id 前缀> --scene test`、`ab tag <id 前缀> --on-demand`；解误报冲突：`ab relate <id1> <id2> --coexist`

## Driving it with verify.sh
- `node --test src/truth-jit.test.ts` + `src/scene.test.ts`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts remember --confirmed --global --for-workers --kind rule --text "..." --summary "..." --scene design`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts tag <id> --scene design,code`
- `env AB_HOME="$AB_HOME" ... node src/cli.ts brief`（无场景：只有索引行，场景规则正文不出现）
- `env AB_HOME="$AB_HOME" ... node src/cli.ts brief --worker --scene code`（含该条与按需触发器，头标签 `worker scene="code"`）
- `env AB_HOME="$AB_HOME" ... node src/cli.ts search --scene code`
- Proof: 四场景合法校验（未知值报 `必须是 design|code|test|review`）；`≤8` 条专属性优先截断与触发器；`--on-demand` 不进 `brief` 但进 `search`；`ab relate --coexist|--refines` 消除冲突对；`inbox --noise` 零写库

## Gotchas
- 取值只在 CLI 边界校验，内部只用 `Scene[]`；`--scene none` 只对 `ab tag` 有效
- brief 不读环境变量定场景：场景只来自 `--scene` 参数
- 先定范围再筛场景：项目目录 / 显式项目名取全局 + 本项目；pm 目录与未登记目录只取全局；`--worker` 时全局规则要求 `for_workers` 且上限 8 条
- `markUsed` / `inject_log` 只记最终实际注入的 id

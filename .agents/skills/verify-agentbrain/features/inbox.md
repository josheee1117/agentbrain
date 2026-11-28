# ab inbox 与 brief 高信号待拍板展开

## Sub-features
- `ab inbox [项目名] [--all] [--kind stale|correction|synth|review|conflict] [--limit <n>] [--json]` 只读列出 5 类高信号待用户拍板条目
- 严格优先级：`stale` > `correction` > `synth` > `review` > `conflict`（含至少一条已确认的冲突对优先，其次最老在前）
- 排除普通未确认 `extract`/`manual` 条目、已被 `superseded_draft` 替代的草稿，以及两端均为未确认自动抽取草稿（`origin === "extract"`）的后台草稿互撞冲突（仅保留涉及已确认或人工/收口条目的冲突）
- 作用域过滤对齐 `brief`（`--all` / `pm` 全库、项目目录全局 + 当前项目、未登记目录仅全局；按名查 `listProjects()` 不写 `projects` 表）
- 主会话 `ab brief`（`!worker`）附带前 `BRIEF_INBOX_MAX_ITEMS = 5` 条、总长 `<= BRIEF_INBOX_MAX_CHARS = 450` 的高信号展开（含已确认冲突，不含双未确认冲突），严守 `BRIEF_MAX_CHARS`、不挤死规则段、不计入 `used`/`inject_log`
- `brief`（`conflictReminder` / `staleReminder`）与 `status` 待办行指向 `ab inbox --kind ...`

## How to get to it (user POV)
- `ab inbox` / `ab inbox <项目名>` / `ab inbox --all` 查看高信号待用户拍板清单
- `ab inbox --kind stale` / `--kind conflict` 等按类筛选，`--json` 给脚本消费
- 主会话 `ab brief` 直接查看最高优先级前 5 条与对应处理命令

## Driving it with verify.sh
- `verify.sh run` 中 `cli-inbox-*` 步骤使用独立隔离 `AB_HOME` / `AB_REGISTRY` / 临时 Git 仓库：
  - 写入普通未确认条目、`synth`（`origin: "auto"`）条目、含已确认冲突对与双未确认冲突对
  - 验证 `ab inbox --json` 排除普通未确认条目并按优先级排序
  - 验证 `ab inbox --kind conflict --limit 1` 与未建表项目查询不写库
  - 验证主会话 `ab brief` 展开 `synth` 与含已确认冲突、排除双未确认冲突、`brief --worker` 不展开
  - 回读 `store.db` 验证 `events`、`inject_log`、`prop_usage` 零增量

## Gotchas
- `ab inbox` 通过只读快照打开库（含 `-wal`/`-shm`），绝不写 `events`、`inject_log` 或 `projects`
- `ab status` 中「与代码不符 N 条（待用户核实）：ab verify ...」保留既有前缀，后附 `（ab inbox --kind stale 看清单）`

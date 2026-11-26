# 锚点、决定核验与存量补锚点

## 入口和边界

```text
ab remember ... [--anchor <relpath | repo:relpath>]…
ab correct <id> ... [--anchor <relpath | repo:relpath>… | --anchor none]
ab tag <id> [--scene <design,code,review|none>] [--anchor <relpath | repo:relpath>… | --anchor none]
ab get <id>
ab verify --changed <项目> [--ref <git-ref>] [--run] [--dry-run] [--json]
node scripts/backfill-decision-anchors.ts preview [--project <名>] [--out <json>] [--md <md>] [--batch-size <n>]
node scripts/backfill-decision-anchors.ts apply --plan <json> [--project <名>] [--ids <id1,id2>] [--dry-run]
```

锚点单条不超过 5 个，仅收仓内相对路径或 `<repo>:<relpath>`，拒绝绝对路径、Windows 盘符、`..`、`.git`、目录尾 `/` 与密钥，保留 UTF-8/中文路径。全局记忆必须带 `<repo>:` 前缀，跨仓项目名须在清单中存在。`ab tag` 仅传 `--anchor` 时不受规则和 `guidance` 限制；`--anchor none` 清空 `anchors` 与 `anchor_head`。

变更扫描把 `"anchor"` 纳入优先级队列（`deleted > broken > anchor > overlap_or_ident`），命中锚点的路径绝不机械预筛。`ab verify --changed <repo>` 同时扫描本仓路径与全库 `<repo>:` 跨仓锚点；无有效基线提交时直接核对目标树。`work.ts` 将 `decision` 纳入首次代码核验，写入 `code_evidence` 后保持未确认且不再重复首次核验，并支持跨仓锚点入队消费。`VERIFY_PROMPT_VERSION` 与 `SCHEMA_VERSION = 1` 保持不变。

## 隔离验收

运行 `.agents/skills/verify-agentbrain/verify.sh run`，或单独运行：

```sh
node --test src/anchors.test.ts src/backfill-anchors.test.ts
node --test --test-name-pattern="^ab-3" src/stale-cli.test.ts
```

1. `cli-anchors` 步骤在隔离临时仓库里驱动真实 CLI：`remember --anchor`、`tag --anchor`、`tag --anchor none`、`correct` 继承、`get` 展示、以及 `verify --changed` 锚点命中。
2. `cli-backfill-anchors` 步骤在隔离库与本地 HTTP mock 上驱动 `scripts/backfill-decision-anchors.ts preview`（只读不写库）与 `apply`（确认写入、保留 `confirmed=false`、二次执行幂等跳过）。

## 证据

- `anchors-unit.log`：`src/anchors.test.ts` 与 `src/backfill-anchors.test.ts`。
- `cli-anchors-verify.log`：`src/stale-cli.test.ts` 的 `ab-3` 独立用例（含 `anchors-verify/cli-e2e.log` 与 `anchors-verify/mock-requests.json`）。
- `cli-anchors-*.log` 与 `cli-backfill-*.log`：隔离 CLI 与离线补锚点脚本的运行输出及回读断言。

上述验证仅使用隔离库、临时 Git 仓库与本地 HTTP mock；正式库存量 `decision` 补锚点需先生成预览单并经用户确认后再 `apply`。

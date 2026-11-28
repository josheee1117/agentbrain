# 需求收口综合沉淀（ab synthesize）

## 入口和边界

```text
ab synthesize <project> --spec <file>... [--diff-base <ref>] [--dry-run] [--json]
```

在需求/功能收口时，结合 `--spec`（可重复，合并总字数超 `SYNTH_SPEC_MAX_CHARS = 24_000` 按序截断并标记 `truncated`）与仓库 git diff（`--diff-base`，缺省回退 `resolveTrunkRef` / `HEAD~1` / 初始树）以及项目现有有效记忆（最多 `SYNTH_EXISTING_MAX = 40` 条），单次调模型提炼最多 `SYNTH_MAX_CANDIDATES = 3` 条新的项目级 `decision | rule | pitfall`。

硬不变量：
- 每条产出 `kind` 仅允许 `"decision" | "rule" | "pitfall"`（缺省回退 `"decision"`，其中 `"rule"` / `"pitfall"` 默认带 `on_demand: true` 归入按需温层，`"rule"` 可解析可选 `scenes`），强制 `confirmed: false`、`origin: "auto"`、`anchor_head: HEAD`（仅在有 `anchors` 时设置），并逐条经过 `checkRememberBody`。
- `anchors` 逐项调用 `checkAnchors` 并核对仓库真实文件树存在性，过滤无效/不存在路径，无有效锚点或与已有记忆同义重复的候选记录跳过原因。
- `supersedes` 仅解析**同一项目**且处于 `active`（含 `stale`）的唯一匹配目标为完整 UUID；跨项目、已归档/已替代或无效前缀静默置空，不阻断其余候选。
- 绝不自动 `confirm`、绝不自动 `archive` 任何已有条目；`draftHints`（最多 `SYNTH_DRAFT_HINTS_MAX = 20` 条）仅作摘要与清理提示。
- `--dry-run` 通过临时只读副本（`store.db` + `-wal`/`-shm`）或 `:memory:` 快照读库，保证正式 `store.db` / `index.db` 的 `events`、WAL 与 mtime 零变化。

## 隔离验收

运行 `.agents/skills/verify-agentbrain/verify.sh run`，或单独运行：

```sh
node --test src/synthesize.test.ts
node --test --test-name-pattern="^ab-4" src/stale-cli.test.ts
```

1. `synthesize-unit`：`src/synthesize.test.ts` 覆盖常量、多 `--spec` 与超长截断、锚点过滤、重复跳过、同项目 `supersedes` 校验、向量失败不回滚 L1、`--dry-run` 零写库与错误参数退出。
2. `cli-synthesize-e2e`：`src/stale-cli.test.ts` 的 `ab-4` 独立用例驱动真实 CLI 预演与实写，验证跨仓锚点、`confirmed === false`、`origin === "auto"`、`ab get` 展示与无自动转正/归档。
3. `cli-synthesize-*`：`verify.sh run` 在隔离临时库、临时 Git 仓库与本地 HTTP mock 上实跑 `ab synthesize --dry-run --json`（校验 `store.db` mtime/WAL 不变）与正式写入（回读确认 `confirmed === false` 与 `origin === "auto"`）。

## 证据

- `synthesize-unit.log`：`src/synthesize.test.ts` 单测与 CLI 测试输出。
- `cli-synthesize-e2e.log`：`src/stale-cli.test.ts` 的 `ab-4` 独立用例（含 `synthesize-e2e/cli-e2e.log` 与 `synthesize-e2e/mock-requests.json`）。
- `cli-synthesize-dry.log` / `cli-synthesize-write.log` / `cli-synthesize-get.log`：`verify.sh run` 隔离 CLI 实测与回读证据。

上述验证仅使用隔离库、临时 Git 仓库与本地 HTTP mock，不碰 `~/.agentbrain/` 正式库或真实模型接口。

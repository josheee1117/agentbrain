# 变更驱动重核

## 入口和边界

```text
ab verify --changed <项目> [--ref <git-ref>] [--run] [--dry-run] [--json]
```

扫描读取 pm 清单的主干名。远端跟踪分支和本地分支互为祖先时取较新的提交，分叉取远端，同提交取远端。未配置主干时用 HEAD。工具只读提交树，不 fetch，不切分支，不读脏工作区。

默认扫描最多入队 20 条，不调用模型。文件被删优先于引文断裂，最后是旧侧改动与引文 ±3 行交叠或同标识符改动。引文完好且机械预筛未命中时不改 `verify_attempts`。非祖先基线按主干原文完好、主干改坏、分支独有分别平移、入队、跳过。缺失基线回退到主干机械核对。只有 verified 或 shifted 的核验记录可作新基线，证据不足退避到期后仍从代码证据提交比较。非法路径逐条跳过，全非法引文不平移基线。

`--dry-run` 只报告预计结果。`--run` 持有 work 租约，消费本项目队列最多 3 条。与 sweep 共用核验、退避、出队和记账逻辑。无法核验、同 head、退避中的证据不足项不再消费。新 head 上的确定结论立即重核。决定不自动转正。

sweep 的本地每日扫描默认关闭。测试通过 `WorkOptions.changeScan: true` 开启，每项目每日一次。日键为 `verify_scan_day:<项目>`，单仓失败不会阻断其他项目。不新增配置键、表、列或事件种类，库版本保持 1。

## 隔离验收

运行 `.agents/skills/verify-agentbrain/verify.sh run`。脚本为所有步骤隔离 HOME、AB_HOME、AGENTBRAIN_HOME 和 AB_REGISTRY，清除继承的 Git 和宿主会话坐标。测试只使用仓外临时 Git 仓库和本地 HTTP mock。run 退出时删除临时目录，保留证据。不运行 hosts、team 或正式库回放。

可单独运行以下命令，外层仍需使用上述隔离环境：

```sh
node --test src/changeverify.test.ts src/registry.test.ts
node --test --test-name-pattern="^ab-2" src/stale-cli.test.ts
node --test --test-name-pattern='ab-2|用前核对排队|§12.6.12' src/work.test.ts
```

### 用户结果与断言

`src/stale-cli.test.ts` 的独立 ab-2 顶层用例通过真实 CLI 建立 5 条决定，先单条核验写入旧主干证据，再移动临时主干。原目录留在另一分支并带脏文件。

1. `verify --changed --dry-run --json` 报告 5 条预计入队，数据库队列为空，HTTP 请求数不变。
2. 占用租约后执行 `--run`。CLI 单行拒绝，队列和模型请求数不变。
3. 默认扫描真实入队 5 条。CLI 不调用模型。
4. `--run --json` 核验 3 条，留下 2 条，其他项目队列不动。模型工具输出只含目标提交里的 99，不含工作区的 999。
5. 模型返回 HTTP 500 时留下队列并释放租约。恢复模型后剩余 2 条完成。决定始终未确认。
6. `--ref other --run` 消费无代码证据决定，记录显式目标 head。
7. stale 确认记录主干 head 并出队。项目目录不可用时确认仍出队。
8. 结束时回读核验记录、队列、L2 和租约，核对工作区文件、HEAD 和脏状态未变。
9. 删除文件与改坏引文在 H2 核出 inconclusive:1。将核验时间设为两天前，提交无关 H3 后，预演和入队仍命中 deleted 与 broken。混入非法路径条目后，正常条目照常入队，非法条目计入 untracked_path。

`src/changeverify.test.ts` 覆盖主干选择、非祖先三分支、缺失基线、未跟踪路径、中文文件名、超过 200 个路径的分批、机械预筛、优先级及 20 条上限。`src/work.test.ts` 覆盖主干只读核验、无证据及决定队列、1/2/4/8 天退避、新 head 立即重核、默认关闭及跨天扫描。

## 证据

- `change-prescreen.log` 记录扫描和主干清单单测。
- `cli-change-verify.log` 只记录 ab-2 的真实 CLI 断言，不重复 ab-1。
- `cli-change-sweep.log` 记录队列与每日扫描断言。
- `change-verify/cli-e2e.log` 记录每条 CLI 命令、退出码、输出和数据库最终状态。
- `change-verify/mock-requests.json` 记录本地模型收到的工具结果。

这些证据只证明本地隔离流程。正式库回放、预筛漏报率和真实模型判断仍未验证，需要另获授权。

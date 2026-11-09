# 冲突显示与处理

当前冲突按无方向的条目对记录。`search`、`get`、`brief` 写 "与 [id] 冲突"，真正未获用户确认的 `supersedes` 才写 "待确认的纠正"。

## 判定口径

- `relate` 与 `remember.relation` 都参与判定。同一对取 seq 最新的事件，不按时间戳排序。
- 最新判定是 `conflicts` 且两端最终都 active 才是当前冲突。归档或确认替代任一端后，该对消失。
- `archive --reactivate` 恢复条目。如果双方都 active，原冲突也恢复。
- `status` 计当前对数。最老天数取各对最新冲突判定时间距当前时间的整天数。
- 期间注入次数计这些条目在相应冲突时间之后的 `inject_log` 行数。同一条卷入多对时，同一行只计一次，不按对重复计数。
- 有冲突的未确认条目不主动召回，冲突条目不进常驻偏好，也不占纠正保底位。

## 自动验收

`verify.sh run` 的 `cli-conflicts` 执行 `node --test src/conflicts.test.ts`。测试以真实文件库和 CLI 完成以下闭环：

1. A/B 和 A/C 都冲突。`get A` 列 B、C，B、C 各列 A，`search` 和 `brief` 显示冲突。
2. 归档 B。默认搜索不返回 B，A 不再列 B，`status` 对数从 2 变 1。
3. 恢复 B。A/B 冲突恢复，对数回到 2。
4. 反方向把 B/A 判为 `refines`。只解除 A/B，A/C 保留。

同一测试文件还直接验证真实投影、展示和资格函数，包括初次 `remember.relation` 冲突、确认替代、时间戳与 seq 顺序不同、日志计数和纠正资格一致性。

## 正式库副本

在改生产代码之前和之后分别执行：

```sh
node .agents/skills/verify-agentbrain/conflicts.ts before <证据目录>
node .agents/skills/verify-agentbrain/conflicts.ts after <同一证据目录>
```

`before` 用 Node SQLite 的只读连接和 backup API 复制正式 `store.db`、`index.db`。所有 CLI 命令使用副本，并隔离 HOME、AB_HOME、AB_REGISTRY。`after` 从同一快照重新复制。

脚本独立重放事件，检查 `status` 数量，选 5 条冲突条目检查 `get`，跑 `brief agentbrain --scene design` 检查冲突文字。随后只在副本归档一条样本，检查对数减少及双方读取，再恢复并检查冲突回归。它分别测 `search`、`get`、`brief` 3 次进程总耗时，记录毫秒值和完整输出。3 次不足以判断小幅性能变化，不能据此宣称提速。

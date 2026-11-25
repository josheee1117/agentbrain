# Stale 护栏与草稿退场

## 用户结果

用户确认或跨会话印证的 stale 条目仍注入，正文带 `[与代码不符@<短sha>，待用户核实]`。代码核验转正或未确认的 stale 条目不注入。`brief` 在固定预算内提示可见范围的待核实数量，`status` 报全库活跃待核实数量。

`ab confirm <id>` 清除 stale，并在能解析本地项目 HEAD 时，同事务记录 `verify_attempts` 并清理 `verify_queue`。旧 confirm 事件不清 stale。

`ab verify <id> [--ref <git-ref>]` 强制重核。`--ref` 只读目标提交树，不切分支或修改脏工作区。决定、待确认纠正和关系未判定的条目核出 verified 时只写代码证据和清 stale，不自动转正。撤销过自动转正的条目仍不保存新代码证据。规则、非 active 条目和全局记忆不能核验。非法 ref、缺仓库和模型 HTTP 错误只输出一行报错。证据不足在 `verify_attempts.outcome` 中从 `inconclusive:1` 递增。无模型配置和未实现的 `--changed` 明确报错。

同项目未确认 extract 草稿被未确认新草稿替代时，旧条目不进入召回、brief 待确认数和到期清单。搜索和详情仍能看到它。归档替代草稿后旧条目恢复。已确认条目、非 extract 条目和跨项目条目不退场。

## 入口与证据

生产入口在 `src/l2.ts`、`src/visibility.ts`、`src/present.ts`、`src/brief.ts`、`src/recall.ts`、`src/expiry.ts`、`src/status.ts`、`src/codeverify.ts`、`src/cli.ts` 和 `src/work.ts`。

运行 `.agents/skills/verify-agentbrain/verify.sh run`。其中 `cli-stale-guard` 执行 `node --test src/stale-guard.test.ts src/stale-cli.test.ts src/codeverify.test.ts`。

- `stale-guard.test.ts` 断言四类来源、worker 与 pm 范围、注入日志、预算、旧事件兼容和草稿恢复。新增规则、归档、待确认纠正及未判定关系的自动转正边界。真实 `runWork({ sweep: true })` 使用落盘 SQLite 和临时 Git 仓库，断言首次及已入队的退场草稿均不核验。三段替代链只认最终 active 的草稿，覆盖活跃竞争者回退及归档最终条目后恢复。
- `stale-cli.test.ts` 使用隔离 HOME、AB_HOME、AGENTBRAIN_HOME、AB_REGISTRY、临时 Git 仓库和本地模型替身。命令输出和数据库查询写入 `cli-e2e.log`，模型收到的工具输出写入 `mock-requests.json`。覆盖规则和归档拒绝、纠正和未判定关系不转正、错误不泄露堆栈、证据不足计数递增。真实 `correct --confirmed`、`get` 和 `search` 覆盖三段替代链，确认非 active 的替代草稿不再隐藏旧条目。
- `codeverify.test.ts` 在另一分支的脏工作区读取目标 ref，检查中文路径、大小限制、符号链接、提交祖先和所有只读工具。

本地模型替身只证明调用接线、确定性证据核对和状态变化，不证明真实模型的判断准确率。变更扫描、每日 sweep、锚点和需求提炼不在本单验证范围。

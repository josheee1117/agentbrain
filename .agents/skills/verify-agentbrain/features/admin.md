# 数据安全：purge / backup / restore / 库版本 / 权限

设计 §12.6.1–§12.6.5。代码在 `src/admin.ts`（编排、文件面）和 `src/store.ts`（事务）。

## Sub-features
- `ab backup [--list]`：`VACUUM INTO` 写到 `<AB_HOME>/backups/ab-backup-<时间>.db`（0600），写完核对完整性和事件数，只留最近 14 份自己命名的；`ab work --sweep` 距上次超过 24 小时自动做一次
- `ab restore <文件> --yes`：先核对备份，把现库另存成 `pre-restore-<时间>.db`，一个事务里换表内容，索引重建；现库里已声明清除的会话对恢复出来的内容重做清除。不加 `--yes` 只预览
- `ab purge --session <宿主:会话id> [--drop-backups]`：只在终端里由人输入会话 id 前 8 位确认后执行；清 L1 正文、统计表、全文索引与向量，两个库 `VACUUM` 加 WAL 截断，删 `view.html` 和该会话的调试文件；逐面报告（成功 / 部分 / 失败 / 不在范围）
- 库版本号：`PRAGMA user_version`（现在是 1）。库比代码新时这个连接只读，写入报「库版本 N 比代码支持的 M 新，拒绝写入」
- 不认识的事件种类不改条目状态，计入 `ab status` 的「不认识的事件」
- 每条新事件带 `actor`（登录名）和 `machine`（主机名），`ab get` 的「写入」「确认」两行显示
- 数据目录和 `backups/` 0700，`store.db`、`index.db`、`work.log` 0600，每次打开库时收紧

## How to get to it (user POV)
- 备份和恢复：`ab backup`，`ab restore <文件> --yes`
- 用户发现某次会话把不该记的东西记进去了：自己在终端运行 `ab purge --session claude:<id>`

## Driving it with verify.sh
- `verify.sh run` 的 `cli-backup*`、`cli-restore*`、`cli-purge-refused`、`cli-admin-status`、`cli-admin-perms`、`cli-usage-scoped`
- `node --test src/admin.test.ts`：清除后两个库文件里搜不到明文、重跑不重复声明、恢复后已清除的内容不回来、库比代码新时拒绝写入
- Proof: 备份日志有「已核对完整性」；恢复后搜不到备份之后写的条目；非终端下 purge 打印「没有执行：清除只能由人在终端里发起」且内容还在

## Gotchas
- 清除要走真执行路径得有终端。脚本里用 `script -q /dev/null node src/cli.ts purge --session <id>`，输入要晚几秒再送（等 readline 就绪），否则确认读不到
- 清除压实库文件需要独占：有别的进程正在读库时 WAL 截断不了，那一面报「失败」，等它们结束重跑同一条命令
- 清除碰不到手工复制的库副本和宿主的会话文件，只报告路径；`--drop-backups` 只删含这个会话正文的库副本
- 恢复不动库文件本身（事务内换表），别的进程开着也安全；但备份之后的写入会从现库消失，所以要先关掉其他会话
- 这次之前的旧代码不查版本号，仍会往新库写。版本保护从本版本起生效

# 15. Pi 状态栏 agentbrain 段（§11.7 方案 B）实现验收

日期：2026-10-20（新加坡时间）。分支 `feat/pi-footer-status`，代码提交 `f21fc22`（实现）、`84b092a`（审稿修正）。

## 测什么

1. 状态栏在各状态下显示的是不是设计里定的文字（召回条数、待确认、抽取失败、召回超时），0 段是否隐藏。
2. `ab status --line` 的口径对不对：待确认只数到期复审清单（`reviewList`，和 `ab review`、`ab status` 里"到期待复审"同一个数），不数候选区和已确认；抽取失败只数近 7 天的失败窗口。
3. 会不会拖慢每轮：`status --line` 只在 `session_start` 和 `agent_end` 后台跑，不在召回路径上；耗时多少。
4. Claude / Codex 的 hook 输出是否完全不变。

## 怎么测

### 行为测试（`src/pi-status.test.ts` 8 个，`src/cli.test.ts` 新增 3 个）

- 假 runner 测扩展逻辑：命中 / 没命中 / 超时 / 出错 / 返回乱码 → 状态文字；`status --line` 刷新超时保留旧值；刷新不阻塞事件；子代理（没有会话文件）不设状态、不跑 `status --line`；`/ab` 成功和失败；runner 抛错不让这一轮失败；扩展自己发起的 custom 轮次不召回；旧版 ab 不给条数时显示"🧠 ab"而不是 0；用会话的 `ctx.cwd`。
- 真子进程测 `makeExecRunner` 的错误分类：命令不存在 → missing，超时被杀 → timeout，非零退出 → exit，输出超过 1MB → exit（不是超时），并在指定 cwd 运行。
- 真 CLI + 临时库：`status --line` 在有过期未确认、已确认、刚记、候选区、近 7 天和 10 天前失败窗口时输出 `{review:1, work_failed:1}`，且不读钥匙串；`recall --hook` 带 `want_count` 时条数等于 `<agentbrain-recall>` 里的行数，常驻偏好不算；不带时 JSON 里没有 `agentbrain` 字段、没命中时输出仍为空；扩展接真 ab 跑一遍 `session_start → 召回 → /ab`。
- **改前代码上跑新测试**：把 `src/cli.ts`、`src/status.ts`、`integrations/pi/agentbrain-recall.ts` 换回 `e7cb2f1`，新测试 9/9 全部失败（pi-status 6 个、cli 3 个；当时 pi-status 还是 6 个）。
- 全套：`npm test` 320/320 通过，`tsc` 通过；扩展文件另外按 Mac 上真实的 pi 1.3.0 类型（`dist/index.d.ts`）做了类型检查，0 错误。

### Mac 实测（记忆库的临时副本）

- `sqlite3 .backup` 把 `store.db`、`index.db` 拷到临时目录，`AB_HOME` 指过去，没有 `extract.json`，所以不会触发抽取模型。用完已删除。
- tmux 里起 pi：`pi -ne --no-mcp -e <pi-cc-extensions> -e <ponytail> -e <扩展副本>`，扩展副本只把 ab 路径改成临时 clone 的 `src/cli.ts`。不加载用户的其他扩展，不用正式库，不动 hook 和 launchd，用户开着的 pi 会话也没动。
- 为了看到"待确认"和"抽取失败"，在**临时副本**里把 3 条未确认条目的时间改到 400 天前，插了 2 个失败窗口。
- 超时状态：扩展副本的 ab 指向一个睡 20 秒的脚本。

## 结果

| 状态 | 实测底栏第 2 行（agentbrain 段） | 截图 |
|---|---|---|
| 刚启动 | `🧠 ab` | — |
| 本轮只有常驻偏好、没召回到 | `🧠 ab 0` | `assets/15/real-nohit.png` |
| 本轮召回 2 条 | `🧠 ab 2` | — |
| 有到期复审、有失败窗口 | `🧠 ab 0 · 待确认 3 · ⚠ 抽取失败 2` | `assets/15/real-todo.png` |
| ab 卡住 | `🧠 ab ⚠ 召回超时` | `assets/15/real-timeout.png` |
| 审稿修正后（`84b092a`）再跑一遍 | 启动 `🧠 ab · 待确认 3 · ⚠ 抽取失败 2`，召回后 `🧠 ab 2 · 待确认 3 · ⚠ 抽取失败 2` | `assets/15/real-final.png` |

- 位置：第 2 行 `⎇ 分支` 之后、`ponytail` 之前，和示意图一致；颜色被 pi-cc-extensions 统一成灰色，也和预期一致。
- `/ab`：弹出当前状态加 `ab status` 全文。
- `召回 2` 那轮，直接跑 `ab recall --hook` 拿到的 `recalled` 也是 2，常驻偏好 3 条没算进去。
- **`ab status --line` 耗时**（Mac，临时副本，877 条，20 次）：中位约 141ms，最慢 180ms；其中 node 空启动约 42ms。达到目标（中位 < 300ms）。它不在召回路径上。
- 卡住时这一轮会等满 5 秒召回超时，这是原来就有的 `TIMEOUT_MS`，没改。

## 独立审稿

`cpa/deepseek-v4-pro`，`--thinking max`，临时 `AB_HOME`，`-ne`，`</dev/null`。没有阻断问题，有 1 条"重要"和 7 条"次要"：

- 重要 1："设计文档没有 §11.7" —— **不成立**：§11.7 在 #64 的分支上，审的是只含代码的分支。已把 #64 的分支并进本分支。
- 次要 2（runner 异常没兜底）、3（输出超限被当成超时）、4（custom 轮次显示假 0）、5（execRunner 测试没测被测代码）、6（集成测试断言弱、没超时）、7（应该用 `ctx.cwd`）、8（旧 ab 不给条数时冒充 0）：**全部修了**，每条都有测试（`84b092a`）。
- 审稿人核实过、认为没问题的：事件名和 ctx 用法与 pi 类型一致、子代理判定成立、超时保留旧值、Claude/Codex 输出不变、计数口径。

## 结论

方案 B 按设计实现，测试和实测都通过。用户现在开着的 pi 会话要重启才会加载新扩展。

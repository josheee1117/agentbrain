# eval 16 引用标注评测 harness（Pi 单元）

在用户 Mac 上 `/tmp/cite-eval/`（实际路径 `/private/tmp/cite-eval/`）运行，全部隔离：

| 目录 | 用途 |
|---|---|
| `agentbrain/` | `feat/memory-viewer` 的临时检出（2d8e24e），没有 node_modules（cli 只用内置模块，扩展只 `import type`） |
| `abhome-on/`、`abhome-off/` | 两份临时库，内容相同（44 条精选、脱敏记忆：agentbrain 项目 26 条全部 active + 全局 18 条），`work_meta.cite` 分别为 on / off。只拷了 `embedding.json`（无 key），key 仍从钥匙串读 |
| `home-on/`、`home-off/` | 临时 HOME。`.pi/agent/AGENTS.md` 由 `ab setup --cite on/off` 写入托管块；`models.json` 软链到真实文件（只读用）；`Library/Keychains` 软链到真实钥匙串目录，让 embedding 能取 key。真实 `~/.pi`、`~/.claude`、`~/.codex`、`~/.config/opencode` 不动 |
| `registry/agentbrain.md` | 临时项目清单，路径指向临时检出（`AB_REGISTRY`） |
| `runs/<模型>-<开关>/qNN.{jsonl,err,done,failed}` | 每题原始输出；`.done` 记命令、耗时 |

步骤：`build_seed.py`（从正式库只读导出、脱敏）→ `seed.py`（`ab remember --confirmed` 写入临时库）→ `preflight.py`（在第三份拷贝上只跑 `ab recall --hook`，看每题会注入哪些 id，不调模型）→ `start.sh`（两条后台车道，429 时每 10 分钟重试同一题）→ `extract.py`（汇总，读 `ab view` 扫描后的 `inject_log.cited`）→ 人工标注 `labels.json` → `score.py`。

Pi 命令（每题一个新会话，会话文件存在临时 HOME 下，供 `ab view` 扫描）：
```
pi -p --mode json --no-extensions -e harness/ab-ext.ts --no-tools --no-skills --no-prompt-templates --no-mcp --thinking max --model cpa/<glm-5.3|deepseek-v4-pro> "<问题>" </dev/null
```
`ab-ext.ts` 只是把仓库里的 Pi 扩展换成调用临时检出的 `src/cli.ts`（原扩展写死了 `~/.local/bin/ab`）。上下文文件保留（临时 HOME 的 AGENTS.md 托管块 + 仓库 AGENTS.md），因为引用说明就在托管块里。

给后续宿主复用：`abhome-*`、`home-*`、`registry/`、`questions.json`、`extract.py`、`score.py` 宿主无关；每个宿主要补自己的 runner 和 `extract` 的 transcript 解析。

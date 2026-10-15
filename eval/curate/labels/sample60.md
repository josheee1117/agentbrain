# 记忆价值标注 · 第二批（60 条）

跟上次 30 条一样：判断每条记忆**以后真会被用上吗**。
- **有用**：在写明的场景下，能让 agent 少走弯路、少犯错
- **部分有用**：有点价值，但写得太泛、太细，或者只在很窄的情况下才有用
- **没用**：一次性的过程记录、显而易见、过时了，或者根本用不上

在「标注」那行留下一个选项（删掉其他两个）就行，备注可写可不写。条目已打乱顺序，抽自当前记忆库的副本（不含上次那 30 条和 fresh30）。

---

### 1. 【规则】ai-data
**记忆**：e2e 里 page.route 只允许注入故障或延迟来测界面错误态、竞态，不允许用它伪造业务数据；每个用例是否用了 route、用来干什么要在汇报里说明。  
**场景**：无  
**原因**：背景：旧 e2e 用假资产平台、假向量、route 造数据充当真实链路，用户明确规则是 ai-data 不走 mock、所有测试按真实上线标准，所以 route 只保留制造错误态的作用。  
**来源**：自动抽取 · codex；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 2. 【备注】data-asset
**记忆**：AI 代码审查执行清单：这是一份实现后或 review 时的快速检查清单。它补充 AGENTS.override.md 的证据要求，不替代 pipeline，也不要求为了勾满清单扩大范围。  
**场景**：无  
**原因**：沿真实入口和 diff 回答：目标与合同：改动是否只做了用户要求的事？API、数据、权限和事务语义是否被意外改变？数据权威：核心事实来自哪里？是否在下游用默认值或兼容分支猜上游事实？主流程：最小业务闭环能否在 7 步内讲清？输入、核心处理、副作用和成功结果是否可见？施工顺序：校验、日志、汇总、防御和…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 3. 【备注】insuranceagent
**记忆**：逻辑删除值策略（del_flag 唯一索引兼容）：按表显式开启的逻辑删除兼容方案：默认沿用 del_flag=1，开启后改为 del_flag=id，解决包含 del_flag 的唯一索引冲突。  
**场景**：无  
**原因**：唯一索引 uk_xxx (biz_code, del_flag) 下，同一业务键多次删除会冲突：第一次删除：(A, 1)；第二次删除：也想写 (A, 1) → 冲突；逻辑删除时 SET del_flag = id（主键值），不同记录主键不同，不冲突。不加注解或 enabled=false → 行为不…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 4. 【踩坑】ai-data
**记忆**：本机连 askdata 测试库要用外网地址 [REDACTED:ip]（[REDACTED:host] 同一个 IP），内网 [REDACTED:ip] 走代理网卡会秒连上但握手无回应。验证端口要发 PostgreSQL SSLRequest 看是否回 N/S，不能只看 TCP connect。  
**场景**：无  
**原因**：2026-10-14 实测：[REDACTED:ip] connect 0s、5s 后空回复；[REDACTED:ip] 回 b'N'，psql 登录查到 CatalogObject 668 行  
**来源**：手动记 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 5. 【决定】data-asset
**记忆**：原子指标条件树使用单一入口和上下文事实源：原子指标创建/更新只接受完整 conditionTree，不再保留 modifierIds / modifierCombination 双入口；Processor 的 context 持有解析后的 AtomicConditionTreeDefinition，后续校验、变更日志、类型判断和持久化都消费这一个事实源。  
**场景**：无  
**原因**：原子指标依赖能力从“原子指标挂多个修饰词”扩展为“修饰词叶子 + 原子依赖叶子可以进入同一棵条件树”。开发过程中曾同时存在：modifierIds：旧的平铺修饰词入口。modifierCombination：只以“修饰词组合”命名的树形入口。conditionTreeStore.replace(at…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 6. 【踩坑】data-asset
**记忆**：把前端 querySql.js / developmentScript.js 的空白判定移植到 Java 时不能用 String.trim()：它只去 ≤U+0020，JS trim 还去 U+00A0、U+FEFF、U+3000 等 Zs 和 U+2028/2029，维度槽位 dimN 会和前端不一致。在 Java 侧写等价的 ecmaTrim，并让该类所有去空白都走它。  
**场景**：无  
**原因**：背景：派生槽位后端复现时按 Java trim 处理全角空格等名称，与前端分配结果对不上。两条重复记录合成一条。  
**来源**：手动记；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 7. 【踩坑】pi-ops
**记忆**：pi-ops 的 events.fingerprint 列结构性为 NULL，断言它会让演练驱动在故障请求落地后立刻中断（0 次模型调用）。指纹要查 Event 的 attributes（error_code/operation）和 incidents.fingerprint；断言先在预设 store 上离线验证再跑真实 E2E。  
**场景**：无  
**原因**：背景：real-dataasset-lab 多波演练因断言 events.fingerprint 在事件到达后立即判失败，整轮没进入模型诊断；三条重复记录合成一条。  
**来源**：手动记；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 8. 【规则】ai-data
**记忆**：跑 ai-data storage 测试时用 `TEST_DATABASE_URL=$(cat /tmp/w-aidata-pg-url) pnpm test:storage` 注入连接串，输出里不要回显连接串。  
**场景**：无  
**原因**：连接串是凭据，用户在给验收命令时直接括注「不要打印连接串」；agent 汇报验证结果时若把整条命令或 URL 回显到对话/日志就等于泄露。  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 9. 【踩坑】全局（所有项目）
**记忆**：CPA 的 deepseek-v4-pro 和 glm-5.3 共用同一个上游 5 小时额度（429 AccountQuotaExceeded，带 reset 时间）：一个用完另一个也不能用，额度中断时别在这两个之间互换，换 grok-latest 等其它上游。小 prompt 探测通过不代表能撑完长任务。  
**场景**：无  
**原因**：17:34 deepseek 与 17:35 glm 报同一条 'exceeded the 5-hour usage quota, reset 20:21:56'  
**来源**：手动记 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 10. 【规则】data-asset
**记忆**：本地启动 data-asset 实例时必须关闭服务注册（[REDACTED:host].nacos.discovery.enabled=false），否则测试网关会把流量路由到本机。  
**场景**：无  
**原因**：用户明确要求：不关注册会把线上/测试流量引到本机。  
**来源**：自动抽取 · pi；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 11. 【规则】pi-ops
**记忆**：复核 pi-ops lab 执行者报告时，若 ok=false，先核对其阻断原因是否与自己的观测一致，不要要求它通过——验收门禁会把诚实的不完成标为 not-ok。  
**场景**：无  
**原因**：用户下达真实模型诊断复核任务时说明：门禁会把如实报告未完成的执行标成 not-ok，因此复核的职责是判断阻断原因是否真实成立，而不是把诚实的不完成当成需要强行通过的失败。  
**来源**：自动抽取 · pi；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 12. 【决定】pstack-pi
**记忆**：本包自有技能放 local-skills/（与上游镜像 skills/ 分开，package.json pi.skills 同时注册两者；discovery 测试断言 skills/ 与上游列表一致，不要把自有技能放进 skills/）。首个是 pstack-report（流程收尾报告），由 adapter/overrides.md 的规则触发。  
**场景**：无  
**原因**：同步上游时不冲突，保持 skills/ 纯镜像  
**来源**：手动记 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 13. 【决定】insuranceagent
**记忆**：标签同步 MQ 消费失败重试策略：接受重复执行（方案1）  
**场景**：无  
**原因**：TagDataReadyListener 监听数据就绪通知，一条消息可能匹配多个 TagGroup，需要逐个处理。；单个 group 处理失败时的策略选择：返回 FAILURE → 整条消息重投 → 已成功的 group 重复执行；只记日志返回 SUCCESS → 失败的 group 彻底丢失；记录…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 14. 【踩坑】agentbrain
**记忆**：hook 子命令里每处等待都要有截止时间：读 stdin 不能无限等 end，macOS security 的同步 keychain 调用要显式 timeout，否则 embedding 的 3s 超时还没开始，宿主只能从外面杀进程。  
**场景**：hook 收到完整 JSON 但 stdin 不关闭，或 keychain 读取卡住时  
**来源**：自动抽取 · codex；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 15. 【决定】content-verification-agent
**记忆**：本项目的核验模型改用 deepseek-v4.1-flash（CV_LLM_MODEL），不要再用 deepseek-v4-flash。  
**场景**：无  
**原因**：背景：本地配置的 deepseek-v4-flash 调用直接返回 404 Model not exist（该名不在 provider 返回的模型列表里），助手列出可用模型后用户拍板换成 deepseek-v4.1-flash 并验证成功。  
**来源**：自动抽取 · codex；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 16. 【踩坑】data-asset
**记忆**：本地 java -jar 起 data-asset（照 IDEA 运行配置：-Dspring.profiles.active=dev [REDACTED:host].nacos.discovery.enabled=false + NACOS_HOST 等环境变量）：-D 必须放在 -jar 前面；SSL 证书 local-ssl.p12 只在主仓库 data-asset-starter/src/main/resources，worktree 没有；8089 常被 IDEA 里的实例占用，换端口；增量 mvn package 不会刷新 starter 的 fat jar，改了 common 要 clean package；kill 后进程常卡住不退，超时后 kill -9  
**场景**：无  
**来源**：手动记 · pi；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 17. 【踩坑】pstack-pi
**记忆**：用户说“检查/更新 pstack 原版”指的是更新 pstack-pi 项目本身；上游以 `tools/sync-upstream.mjs` 从 cursor/plugins 拉的快照为准，不要拿本机 Codex 装的 pstack 插件当对照源（版本远落后）。  
**场景**：被要求检查或更新 pstack 上游版本时  
**来源**：自动抽取 · codex；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 18. 【踩坑】data-asset
**记忆**：已发布到 dev_jdk17 的修复不等于 master 已有；同一份修复只在 dev_jdk17 时，从 master 构建的 XXL-Job 实例仍跑旧实现并抛同样的老异常。排查“明明改过还报错”时，先比对 master 与 dev_jdk17 是否都含该修复，再核对该实例的实际构建来源。  
**场景**：线上报错堆栈/行号与当前分支代码不一致，或用户质疑“我们不是改过一版吗”时。  
**来源**：自动抽取 · codex；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 19. 【踩坑】pi-ops
**记忆**：在 real-dataasset-lab 跑单次真实模型诊断前，必须压低其他事件源的阈值/迟滞：investigationReconciler 一开启就会调查每一个已有完成证据作业的 Incident，实测 host.memory_pressure 事件抢走了唯一调查名额，真实故障没被诊断。  
**场景**：开启 externalRuntime 跑单次真实诊断时  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 20. 【决定】insuranceagent
**记忆**：衍生标签 NULL objectId 修复采用 DTS 自愈重建方案：利用现有 DTS 事件流，在 valueColumn 未变但关联字段变更时，自动重建衍生 marker，无需改表、改配置、加定时任务。  
**场景**：无  
**原因**：标签组 118（投诉行为）监听 work_order_record.behavior_tag 变更自动打标，并通过 5 个 derive 配置衍生到 CASE/CHAN/CUST/ENT/PERSON。生产发现衍生 marker 的 object_id 为 NULL。根因：DTS 触发时 behav…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 21. 【踩坑】pi-ops
**记忆**：pi-ops lab 里的 Feign 报错 'url values must be not be absolute' 是 lab 配置错误：方法级 @GetMapping 占位符（admin.access-url、wework.api.url）被配成了绝对 URL，不是生产版本不兼容。方法级要写相对路径，基址放类级。  
**场景**：无  
**原因**：背景：lab 报告曾把该报错当成版本不兼容，被 supervisor 纠正；两条重复记录合成一条。  
**来源**：手动记；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 22. 【备注】data-asset
**记忆**：Pi-Ops JFR RecordingStream 常驻观测边界：DataAsset 的常驻 RecordingStream 是可关闭、fail-open 的 JVM 旁路观测能力；always-on JVM 基线只订阅 CPU、GC 和 monitor contention，并按配置追加权威入口生产的 SlowSql、BusinessError Custom Event。正常线程等待、长连接阻塞读和通用异常不能被直接解释成业务故障。  
**场景**：无  
**原因**：data-asset-starter 依赖 consumer 模块 pi-ops-jfr17-spring；纯 JDK schema/recorder 位于 pi-ops-jfr-events，供 consumer、biz-service、processor 单向依赖，业务模块不反向依赖 Sprin…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 23. 【规则】pi-ops
**记忆**：pi-ops 下一阶段做真实场景验收前，必须先设计好常见业务异常与系统异常场景（故障、证据、预期行为、通知与恢复判据），再开始测试；不能先跑测试再用实现输出反过来定义正确结果。  
**场景**：无  
**原因**：用户明确要求先定场景再测，否则测试抓不住重点、无法判定该不该通知与是否恢复。  
**来源**：自动抽取 · pi；多次印证  
**标注**：有用 / 部分有用 / 没用　　备注：

### 24. 【规则】pstack-pi
**记忆**：pstack 流程收尾要出总结报告（local-skills/pstack-report）：验证写到具体场景——测试拆到用例而不是『全过』，e2e 写明服务怎么起、走哪个入口、数据落哪个库，子代理自述的结果单独标注；形式参照 show-me，用带 +/~ 的文件树列改动，结果多或带截图时生成自包含 HTML 并自动打开。  
**场景**：无  
**原因**：背景：用户说『他说做了一堆事，但是具体是啥也没有指出来，比如执行完 e2e 我也不知道到底测了哪些』，又说『总结报告可以使用类似 show-me 的技能，输出一个阅读友好的内容』。三条同主题记录合成一条。  
**来源**：手动记；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 25. 【决定】data-asset
**记忆**：设计文档必须包含 DDL SQL 文件并按 specs 结构落盘：涉及数据库变更的设计文档必须同时提供 DDL SQL 文件；每个功能以薄 summary.md 登记当前状态，以单一完整设计承载机制细节，以带显式取代关系的 adrNN 承载演进历史。  
**场景**：无  
**原因**：在词根管理模块设计时，初次只提供了设计文档，缺少 DDL SQL 文件。用户反馈："我怎么没看到 sql 文件在哪？"；在报表配置功能设计时，初次只提供了设计文档，用户追问："ddl呢？"，说明设计文档缺少可执行的数据库变更脚本。在报表配置功能提交时，初次将文件直接放在 specs/ 根目录，用户指…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 26. 【踩坑】ai-data
**记忆**：Worker 返回的图表 UI Spec 里 chart.type 只能填 "bar"：折线/面积由展示层按 presentation/preferredChart 决定（趋势折线用 preferredChart:"line"），在 spec 里写 type:"line" 会 TS2322。  
**场景**：在 apps/agent-worker 的 mock/harness 里生成结果 UI Spec、想指定折线或面积图时  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 27. 【备注】insuranceagent
**记忆**：文件安全访问统一方案（FTP + OSS/CDN）：数据库只存稳定原始地址，出参自动加签、入参自动去签的统一文件访问方案，避免每次改文件 URL 逻辑时重新理解签名链路。  
**场景**：无  
**原因**：存储态与访问态分离：DB 存原始 URL，对外输出带签名 URL；统一入口：业务层不判断 FTP/OSS，下沉到 FtpProvider；序列化链路自动处理：@SignedFileUrl + Jackson + ResponseBodyAdvice；按 URL 前缀映射不同 key，支持多域名多 k…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 28. 【踩坑】ai-data
**记忆**：ai-data e2e 点演示问题要限定在 .demo-examples 里：历史对话按钮的可访问名是“打开对话：<标题>”，用 /示例.../ 正则加 .first() 会点到历史对话；dev server 的会话存在内存里，跨用例累积，所以只在前面用例建过同名对话后才挂。main 分支的 e2e 本身已过期（10 挂 7，找不到 .sample-cards），别拿 main 当基线  
**场景**：无  
**来源**：手动记 · codex；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 29. 【踩坑】insuranceagent
**记忆**：编译或跑测试前先 export JAVA_HOME=/Library/Java/JavaVirtualMachines/temurin-11.jdk/Contents/Home；用本机默认 JAVA_HOME 跑 mvn 会在 insuranceagent-common-core 编译就失败，测试代码也编不过。  
**场景**：在本机直接跑 mvn 编译/测试、没有显式指定 JAVA_HOME 时  
**来源**：自动抽取 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 30. 【决定】insuranceagent
**记忆**：标签打标变更日志表设计：新建 tag_marker_log 表，关键设计点：冗余字段：category/tag_name/tag_value/group_name 从 tag/tag_group 冗余，避免 JOIN，且标签可能被修改/删除后丢失历史语义；batch_id：同一次打标操作的所有明细共享同一批次号，便于关联查询；action：仅 ADD/REMOVE 两种动作；tenant_id：项目多租户体系必须包含；索引：idx_object_time(object, object_id, create_time) 覆盖按对象+时间查询；idx_batch(batch_id) 覆盖按批次查  
**场景**：无  
**原因**：标签打标操作（增删标签）缺乏变更记录，无法追溯"谁在什么时候给哪个对象加/删了哪个标签"。；需要在所有打标入口处记录变更历史，支持变更记录查询。  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 31. 【规则】全局（所有项目）
**记忆**：只读 review 报告的格式：问题按严重程度（阻断/重要/次要）排列，每条写 文件:行号、问题、触发输入或失败场景、理由和建议修法；只报核实过的问题，不报风格偏好；没问题的检查项写一句『已检查，无问题』加依据；末尾单列『新坑 / 决定』并附证据。  
**场景**：无  
**原因**：背景：agentbrain、data-asset、ai-data 的只读 review 任务里，用户每次开题都规定这个结构：要能直接照着定位修改，要看出哪些检查项被覆盖，新坑/决定要单独成节便于沉淀。四条同类要求（原分散在三个项目）合成一条全局规则。  
**来源**：手动记；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 32. 【决定】data-asset
**记忆**：MyBatis selective update 无法将字段设为 null：当业务逻辑需要将某个字段从非 null 值更新为 null 时，不能依赖 updateByPrimaryKeySelective（<if test="field != null"> 会跳过 null 值）。  
**场景**：无  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 33. 【踩坑】pi-ops
**记忆**：DataAsset 非预期业务故障演练中，缺必填参数导致的 500 属于客户端错误，不能算作非预期业务异常；必须换成真正走 GlobalExceptionHandler/JFR/Starter 链路的触发方式，否则场景验收不成立。  
**场景**：为 DataAsset 构造非预期 500 故障用于演练或验收时  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 34. 【规则】data-asset
**记忆**：不在下游铺 normalize/trim 防御网：不要在业务主流程、投影代码、同步代码里到处写 normalize、trim、defaultString、blank-to-empty 这类清洗补丁。数据合同错了就修合同，不要把脏数据一路擦到看不见。  
**场景**：无  
**原因**：输入合法性在边界一次性校验，之后相信 DTO / entity / DB 字段合同。null、空字符串、nan 是三种语义，只能在拥有输出合同的边界转换。下游渲染、同步、持久化代码不得靠通用 normalize 掩盖上游脏数据。如果确实要做转换，命名必须说明具体合同，例如 emptyIfNull、c…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 35. 【踩坑】agentbrain
**记忆**：被宿主每轮调用的 hook 子命令（如 `ab recall --hook`）必须自己 try/catch：异常逃逸会把栈打到 stderr 并以退出码 1 结束；接住后静默无输出、退出码 0。  
**场景**：实现或修改 --hook 类子命令（UserPromptSubmit 等）时  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 36. 【规则】pstack-pi
**记忆**：验证新测试真能捕获回归时，用内存拦截（如 monkeypatch 读取 overrides.md）做变异，不要修改磁盘上已定稿的文件，并在汇报里说明是怎么验证的。  
**场景**：无  
**原因**：背景：用户要求证明删掉 overrides.md 的收尾规则后新断言会失败，但该文件已定稿不能动，于是约定用内存拦截跑一次变异并在汇报中交代验证方式。  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 37. 【规则】ai-data
**记忆**：拿到 review 或修复清单先逐条核实问题是否真实存在再动手；核实不成立的不改，在汇报里给核实证据；已修完的条目不回退也不再列。  
**场景**：无  
**原因**：背景：清单来自只读静态核对（review 写明『均基于静态代码核对；未重新运行验收』），可能误报；其中 3、7、8、12、14、15、16 已由上一轮修完，用户明说不要回退。两条记录合成一条。  
**来源**：手动记；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 38. 【规则】pstack-pi
**记忆**：对 pstack-pi 的任何结构改造都要保证它能无缝安装进任意 Pi：交付前在一个全新空 Pi 配置目录里真跑 `pi install` + `pi list`，不能只跑单元测试。  
**场景**：无  
**原因**：背景：用户在这轮大规模重构（换同步结构、改扩展、改技能名）开头提出“保证可以无缝安装到任意pi中”，因为这正是本包对使用者的核心承诺，所以结构改动后必须用全新 Pi 环境实测安装，而不是只依赖包内测试。  
**来源**：自动抽取 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 39. 【踩坑】ai-data
**记忆**：用 page.route 拦截 /api/results 造数据时只改行、保留原始列名（如 metric_value）：图表按结果原列名和 UI spec 的 yFields 取数，改列名会让折线图直接不渲染。确需改字段就同步改 presentation/spec 的字段映射。  
**场景**：e2e 拦截结果响应、改写 columns 名称或度量字段名后断言图表可见  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 40. 【决定】data-asset
**记忆**：语义目录导出（GET /open/semantic/catalog）中，派生/衍生维度引用的标准字段已删除时，fieldRef 必须输出 {id: 关联表字段 id, code: "", name: ""} 而非 null——null 会让 ai-data 整次校验失败；原子的 measure/timeField 仍允许为 null。  
**场景**：无  
**原因**：对外契约要求该字段可解析，占位值比 null 更安全：null 会拖垮 ai-data 的整次校验。  
**来源**：自动抽取 · pi；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 41. 【规则】agentbrain
**记忆**：写并发测试不要用 sleep 赌时序，改用两个 Store 实例（或两个 DatabaseSync 连接）手动交错操作来复现竞态。  
**场景**：无  
**原因**：用户对并发测试的写法有明确要求：靠 sleep 赌时序的测试不稳定，必须用可控的交错时序。  
**来源**：自动抽取 · pi；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 42. 【踩坑】pi-ops
**记忆**：宿主服务绑到 [REDACTED:ip] 做隔离后，容器经 [REDACTED:host] 连它会连接超时（实测 http=000），DataAsset 容器在 container→host 就绪预检处就退出；loopback 绑定与容器访问宿主不可兼得，要另行设计路由/拓扑或在容器内跑 central，不能靠放开绑定绕过。  
**场景**：在隔离网络（禁 NAT/masquerade）里让 Docker 容器访问宿主上仅绑定 [REDACTED:ip] 的 central/node HTTP 端口（如 [REDACTED:host]）时  
**来源**：自动抽取 · pi；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 43. 【规则】全局（所有项目）
**记忆**：任何时候不要把连接串、密钥打印到输出或写进仓库；跑需要数据库的测试时用 $(cat 临时文件) 之类的方式传参，避免回显凭据。  
**场景**：无  
**原因**：用户在做阶段 2 落库任务时明确严禁外泄凭据，这类要求对所有仓库都成立。  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 44. 【踩坑】pi-ops
**记忆**：跑 real-dataasset-lab 波次前的基线/保护检查不要假定非实验容器数量与包内快照一致：环境漂移（多出一个 exited 的 aidata-pgvector-test 等容器）会让数量断言直接 AssertionError 中止。应实测记录当前实际容器集合、保留差异后继续，不去停/清理属于别人的容器。  
**场景**：在 pi-ops 启动 real-dataasset-lab 波次、做启动前基线或保护检查时  
**来源**：自动抽取 · pi；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 45. 【规则】全局（所有项目）
**记忆**：测试日志等临时文件写 /tmp，不要留在仓库工作区里（例如上一轮留下的 .audit/），交付前清掉仓库内的临时产物。  
**场景**：无  
**原因**：背景：上一轮把测试日志写进了仓库的 .audit/，这次用户明确要求日志放 /tmp 并删掉 .audit/，避免临时产物混进待审的改动里。  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 46. 【决定】ai-data
**记忆**：口径过期判定改用口径指纹而非派生 version：semantic 存只含影响 SQL 与口径卡定义的指纹（原子计算方式、计算字段、修饰条件、依赖时间、存储位置、派生周期与维度槽位、衍生公式与变量，排除 dt、catalogSyncId、数据批次），staleOf 用当前目录对同一指标重算，不同即 VERSION_CHANGED，历史结果可读、仅拒绝导出。  
**场景**：无  
**原因**：派生 version 不变但原子存储表等口径变化时也必须判过期；旧结果无指纹不做兼容（产品未上线）  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 47. 【规则】data-asset
**记忆**：非平凡改动必须先有文档再写代码：改变重要合同、数据语义或运行边界前先有落盘设计；设计要求不撤销用户已有的实施授权。  
**场景**：无  
**原因**：文档必须物理落盘，写清目标、范围、关键决定、验证方式和实际风险与回滚；篇幅与改动相称，不填无内容栏目。先通过项目调查解决事实问题。只有仍需用户决定的业务语义、合同、权限或重大风险才先询问，不让用户代替代码探索。用户仅要求调查或设计时不进入实现；已明确要求实现或修复，且关键决定清楚时，形成或更新设计后…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 48. 【踩坑】全局（所有项目）
**记忆**：本机 shell 是 macOS zsh + /bin/bash 3.2，几个常踩的坑：没有 GNU timeout/gtimeout（exit 127），超时用 nc -w、ssh ConnectTimeout、python3 subprocess timeout 或语言内建超时；zsh 不对未加引号的 $VAR 分词（for x in $LIST 只循环一次、git add $FILES 当成一个参数什么都没提交），用数组、${=VAR} 或直接写路径；zsh 里 status 是只读变量（status=$? 报错，用 rc=$?）；echo ==== 会被 =cmd 展开报错，分隔符用 echo ---；bash 3.2 没有 declare -A。  
**场景**：无  
**原因**：背景：2026-10-12/13 多个会话反复踩到：给 git clone/nc 加 timeout 直接 127；git add $FILES 报 could not open directory 实际没提交；Monitor 把三个路径当一个字符串只输出一行；status=$? 和 echo ==…（略）  
**来源**：手动记；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 49. 【决定】data-asset
**记忆**：QA RagFlow 投影采用一 QA 一 Document，并由在线来源巡检驱动正式答案重生成：一个 QA pair 独占 QA RagFlow Dataset 中一个 document 和一个手工 chunk；document metadata 从已确认的 retrieval_scope_snapshot_json 和生成时冻结的来源 document metadata 派生；t_qa_source_knowledge 只巡检 ONLINE QA，确认来源变化后自动下线，并按原正式 scope 重新生成正式答案和来源，成功后恢复上线。  
**场景**：无  
**原因**：旧投影按末级类目共享 RagFlow document，每条 QA 只是共享 document 下的 chunk。RagFlow 的 metadata 与启停边界在 document 层，因此不能独立绑定 QA 已确认的 scope metadata，也不能在某条 QA 来源变化时只禁用该 QA。；…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 50. 【踩坑】agentbrain
**记忆**：Pi 扩展要把宿主传入的 ctx.cwd 传给 ab 作为召回范围，不要用 process.cwd()：SDK 能在同一进程里创建不同 cwd 的会话，此时 process.cwd() 仍指向启动目录，会召回错项目的记忆。  
**场景**：在 Pi 扩展里为 ab recall 提供 cwd 时  
**来源**：自动抽取 · codex；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 51. 【备注】insuranceagent
**记忆**：标签同步架构：标签系统有三条数据同步路径，理解它们的边界和职责可以避免反复查代码。  
**场景**：无  
**原因**：retryPendingTagSync XxlJob 默认扫描 tag_pending_sync 中 create_time < now() - 1min 的残留记录，逐条重试 syncOne。当 XXL Job 任务参数传入 batchId 时，任务会只重试该批次的 pending_sync 记录…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 52. 【踩坑】全局（所有项目）
**记忆**：macOS 上 `/var`、`/tmp` 等是 `/private/...` 的符号链接，直接比较路径字符串会断言失败；比较前两边都要 realpath。  
**场景**：在 macOS 上断言或比较路径（临时目录产物、git 工作树、resolve 结果）时  
**来源**：自动抽取 · pi；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 53. 【规则】pi-ops
**记忆**：跑 real-dataasset-lab 真实模型阶段时，模型凭据只通过 source 注入环境变量（lab-model.env / 启动脚本），绝不把密钥值打印到输出或日志里。  
**场景**：无  
**原因**：背景：用户为本轮提供了唯一一份 ARK deepseek-v4.1-flash 凭据并要求授权使用，因此规定接线时只能 source 注入、不得回显密钥值，避免凭据泄漏到会话输出和证据文件。  
**来源**：自动抽取 · pi；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 54. 【规则】pstack-pi
**记忆**：为测试补注入点/接缝时选最小写法：可把根列表做成可测的导出或参数，但不新增抽象层、不新增解析 API；参数解析沿用现有 CLI fixture 测，不为此起整个 audit 流程。  
**场景**：无  
**原因**：背景：review 要求给多技能根健壮性和 audit 参数解析补回归，而解析逻辑写在 main 内、没有现成可测函数；用户接受加测试但明确要最小改动，不为测试重构。  
**来源**：自动抽取 · codex；曾自动转正、后被撤回  
**标注**：有用 / 部分有用 / 没用　　备注：

### 55. 【踩坑】pstack-pi
**记忆**：上游技能正文（入口技能要求回复列原则名、调查流程要求写检查点）与 Pi 适配的默认回复规则直接冲突，症状是模型回复泄漏原则名和检查点；冲突要在适配层消解，保留上游原文以便同步。  
**场景**：模型回复里出现原则名、检查点等流程词，或准备修改上游技能正文时  
**来源**：自动抽取 · pi；代码核验过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 56. 【备注】insuranceagent
**记忆**：项目整体结构与模块职责：多模块 Maven 工程的模块划分、职责边界和依赖关系，避免每次开发前重新探索"代码该放哪个模块"。  
**场景**：无  
**原因**：insuranceagent-safety（安全员业务域）：安全员与组织关系（用户、微信、企业、项目、部门）；任务中心（任务、配置、任务项、参与人、审核）；风勘巡检识别（风勘详情、智能识别、巡检明细、摄像头抽帧）；标签与内容治理（标签、标签组、打标记录、Excel 导入导出）；培训考试（课程、课时、…（略）  
**来源**：导入（pensieve）；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 57. 【踩坑】test-infra
**记忆**：本机经代理网卡 utun4 访问测试服务器：Portainer [REDACTED:ip] 和 [REDACTED:host]([REDACTED:ip]):3306 能通，[REDACTED:ip] 的 80/443/5432/8100/9001/9080/9990 连上即被断开（0 字节）。nc -z 会对任意端口报成功（代理假连接），判断连通要看真实握手。内置浏览器打不开 [REDACTED:ip]（裸 IP + 自签证书），Portainer 改用 API：钥匙串 service=[REDACTED:ip] account=[SECRET:credential] 存 access token，header X-API-Key。  
**场景**：无  
**原因**：2026-10-14 python 握手探测结果；MySQL 返回 8.4.10 握手包，5432 SSLRequest 返回空  
**来源**：手动记 · claude；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 58. 【规则】全局（所有项目）
**记忆**：排查配置类问题时要自己去读实际生效的配置（如 Nacos），直接给出要改哪一项、改成什么、改完要重启什么；不要把「去核对配置」这件事推给用户。  
**场景**：无  
**原因**：用户问为什么通知没发出去，助手连续多轮只回答「没去 Nacos 看发送开关当前值」，用户先说「去nacos看」，又明确说「我要你直接告诉我该怎么改配置解决这个问题，而不是让我去确认」，助手才去查 Nacos 并给出要加的配置项。  
**来源**：自动抽取 · pi；未确认  
**标注**：有用 / 部分有用 / 没用　　备注：

### 59. 【踩坑】data-asset
**记忆**：indicatorType 有三套编码：t_indicator_storage_location 1派生/2衍生/3原子；t_indicator_category_rel 1原子/2派生/3衍生（字段注释只写1、3）；t_indicator_atomic 用 BASIC/COMPOSITE。对外导出一律改用字符串 kind  
**场景**：无  
**原因**：数字直接透传会把原子当派生  
**来源**：手动记 · claude；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

### 60. 【决定】ai-data
**记忆**：目录同步改为每次全量导出 + 内容哈希比对，不做 updatedSince 增量；导出只取 status=1 的派生/衍生；版本拆为目录同步版本/查询口径版本/数据批次版本；第一版按 原子+周期+维度集合 精确匹配派生、不上卷，匹配不到用执行错误码澄清；向量只给原子和衍生、不建 HNSW。完整设计见 pm plans/2026-10-10-ai-data-metric-sync.md  
**场景**：无  
**原因**：关联表变更不更新主表时间，增量必漏；规模小精确扫描足够  
**来源**：手动记 · claude；你确认过  
**标注**：有用 / 部分有用 / 没用　　备注：

# 项目交接文档 (checkpoint)

## 0. 恢复指令
这是项目交接文档。请按 §9 恢复步骤继续本项目：先读文件对账，再继续后续开发。

## 1. 需求
开发一个 DSH 原生三级模型协作插件（L1=你为当前会话选的模型，负责规划 → L2=flash 模块负责人 → L3=本地执行器）。已完成全部功能并上生产，当前版本 **v102**，产品名 **流水线 / Pipeline**，包名 **`dsh-pipeline`**（`package.json` 版本 **1.11.0**），命令前缀 **`/pipe-*`**。

## 2. 全局上下文
- 插件源码目录（可分发）：`C:\Users\Merhnztz\Documents\Vibecoding\DSH\Merhentz_plugin\plugin`（17 文件 / 10 个 lib 模块，直接打包压缩发别人）
- 开发/交接产物：`C:\Users\Merhnztz\Documents\Vibecoding\DSH\Merhentz_plugin\dev`（project_checkpoint.md + smoke 脚本，不随插件分发）
- 活跃安装：`dsh-pipeline@1.11.0`（`~/.dsh/profiles/desktop/node_modules/dsh-pipeline` → 快照 `~/.dsh/dsh-pipeline-v102`；更早快照已清理）
- 全局配置：`~/.dsh/pipeline/config.json`（CONFIG_FILE）；工作区状态：`<workspace>/.dsh/pipeline/`（runtimeStateDir 用会话工作区，不再是 daemon cwd）
- 模型：L1=用户在界面选的模型（pro 只是选项之一，宿主从会话 header 读真实模型名写入 store.context.level1Model）/ L2=deepseek-flash / L3=strata-local（OpenAI 兼容 http://127.0.0.1:8080/v1，模型 `qwen3.8-flash-next-iq3_xxs`；任何 OpenAI 兼容引擎均可）
- **改代码方式（关键，v93 修正）**：改 `lib/*` 后 `plugin_manager set_bundle(false→true)` 热重载**不生效**（Node ESM 模块缓存：同一绝对 URL 二次 import 返回旧模块），必须**彻底退出桌面端重开**（daemon 重启=新进程=新代码）才真正加载。换新目录 + 改包名重装只在「换 bundle 路径」时才需要；同一路径下改文件一律靠重启 daemon。
- 旧版清理：v81–v91 快照目录、旧全局 state `~/.dsh/tiered-orchestrator`、profile 内 v83 时代 `.dsh/tiered-orchestrator` 残留均已删除（v92 部署后统一净化）。

## 3. 已完成（索引）
- 三级路由 + 严格相邻 + 长活二级 + 逐任务验收
- L3 完整文件交付 + 失败有界 + cannot-do + 多重重试 + 超时看门狗（level3TimeoutMs + ollama stop）+ think:false
- 自动触发 + 弹窗访谈（ask_user_question）+ 里程碑用户验收（我很满意/我要提出意见）
- 省 token（禁轮询 + 按异常汇报 + 精简提示词 + 去重）
- 质量门跑代码断言（executeAcceptance）+ 成本分账 + 文件真相（filePath）
- 长活治理（level2ContextBudget 32K + 项目级重建 + scoped 交接 + 数量豁免 + 旧 L2 TTL）
- L1 记忆治理（level1ContextBudget 64K + tiered_checkpoint 9 节契约 + 冷启动 prompt + 验收先于转移）
- 文档齐全：README / TUTORIAL / CHANGELOG（v1–v81）/ design doc（15 节）/ SKILL
- v75 意见触发的改造推迟到切换后（验收门在前、改造实施在后）
- v76 生产文件与开发过程文档分离（devDir 配置 + checkpoint/L2 state/交接文件默认进 devDir + SKILL FILE SEPARATION 纪律）
- v77 里程碑「我很满意」后无条件交接 + 灭活 L2（不看上下文是否超甜点区，后续任务重新生成 L2）
- v78 规划平衡（天然接缝+注水+LPT+负载护栏）+ 全局治理（架构宪法+契约+组装门）+ L1 有界兜底
- v79 单 L2 快路径（小+内聚+串行可接受 → 1 个 L2，跳过均衡、保留质量；均衡块加 (≥2 L2s) 前缀；宪法 1 模块时缩水）
- v81 L1 上下文客观计量（挂钩 DSH tokenMeter + tiered_status.level1Context + /tiered-tokens 命令 + level1ContextWarnRatio 可配）
- v82 甜点区模型自适应 + 项目级配置（MODEL_PROFILES 模型档案 + level1Model/level1SweetSpotRatio/level2SweetSpotRatio/autoTuneSweetSpot 4 键 + 换模型联动 tuneSweetSpot + 配置分层 DEFAULT←全局 config.json←项目级 <devDir>/tiered-project.json + boolean coerce；73 断言验证 + 已部署重装 fiberPhase=active）
- v83 state 按工作区隔离 + 交接路径绝对化（board.json/requirement_lock.json/trace/exec 迁到 process.cwd() 工作区维度，config.json 保持全局；交接文件路径 resolve 绝对化；SKILL 补「报告从会话消息流收」「等 push 时 goal 续轮直接结束回合」两条纪律；26 断言 + v82 回归 73/73 + 已部署 fiberPhase=active）
- v84 适配 DSH 新版 subagents/llm API + L3 迁移 ninfer（startContinuable→startActivation、drainContinuableChildren→drainChildren、subs.start→startActivation；toolFilter 移除改用 tools.guard 严格相邻强制 L1_ONLY_TOOLS；轻量路径 Ollama /api/generate→OpenAI /v1/chat/completions；level3Endpoint/level3Model 默认值迁 ninfer、maxLevel3Concurrency=1；删插件内 Ollama adapter；53 断言含真实 ninfer 调用 + 已部署 + 实测 spawn/drain 恢复）
- v85 L2 上限修复（LEVEL2_NAMES 从 2 个扩到 5 个 level2_module_a~e，tiered_plan assignee 校验随之放开；maxLevel2Agents 本就是 5，根因是名字表只有 2 个；已部署 + 实测 tiered_plan 接受 5 个 assignee）
- v86 L2 自由命名（assignee 校验从「必须是 LEVEL2_NAMES 一员」改为「任意非空字符串」，L1 按任务情况取名如 backend/frontend/database；SKILL.md + SKILL_BODY 同步说明「name each L2 FREELY」；已部署 + 实测接受任意 assignee）
- v87 L2 上限提到 10（maxLevel2Agents 默认 5→10 + config.json 同步 + LEVEL2_NAMES 扩到 10 个 a~j + SKILL/README/TUTORIAL/design doc 的「5」全部改为「10」；已部署 + 实测 tiered_plan 接受 10 个 assignee）
- v88 tiered_execute_batch 批量 L3 执行（L2 一次提交 N 个 L3 任务内部串行执行一次性返回，砍掉 N 次循环推理 token；抽出 executeOneL3Task 复用逻辑，tiered_execute_local 行为逐字段不变；每任务独立 level3TimeoutMs 看门狗、失败/cannot-do 不连锁、maxBatchMs 只停派新任务不 abort 在跑；21 断言自测 + 已部署 fiberPhase=active）+ 瘦身（删 dev/smoke 7 个 asar 诊断临时文件 + plugin.js 未使用 fsp 导入/过期注释）
- v89 控制面（激活 Gate 一次性询问 + 预算护栏 maxTotalTokensPerRun 500K / maxDurationPerRun 2h / maxFilesPerRun 200 + run 状态机落盘 run.json 冷启动恢复 + 里程碑状态机 milestones 计算而非存储 + 完成未验收硬 Gate 拦 spawn/send + runFooter 注入 + tiered_accept_milestone / tiered_selftest + /tiered-stop /tiered-resume /tiered-off /tiered-selftest 命令 + 启动非阻塞引擎 ping + 错误翻译 + level3Engine 泛化配置 + P0 修复：exec 断言 uuid 并发隔离、board 冷启动重载、spawn L2 上限、batch id 去重；测试 v89_control 49 断言 + v82 回归 73 + SKILL 同步 PASS；已部署 v89 fiberPhase=active，v88 已从 profile 移除）
- v90 精壮化（用户批准，2026-10-28 完成）：① 全量改名 `tiered→pipeline`（包名 `dsh-pipeline`、插件名 `pipeline`、工具 `pipeline_*` 16 个、命令 `/pipe-*` 6 个、配置目录 `~/.dsh/pipeline`、工作区 state `.dsh/pipeline`、系统提示段 `pipeline:protocol`、skill `pipeline-orchestration`）；② 单文件 2741 行 → 10 个模块（lib/util.js / config.js / store.js / gates.js / prompts.js / dsh-compat.js / guards.js / tools/l1.js / tools/l2l3.js / plugin.js 薄装配入口 230 行），每模块职责单一；③ 删死代码（level3NumCtx 死配置、level3MaxTokens 拆为 level3InputBudget 500 + level3MaxOutputTokens 4096、SKILL_BODY 迁入 prompts.js 单一源）；④ 测试收口（verify-v82 73 + v89_control 49 + v90_tool_factory_probe + skill_sync，`pnpm test` 一键跑；7 个旧一次性烟测归档 `dev/smoke/_archive/`）；⑤ 文档同步（README 10 模块树 + 彩蛋「Made with ❤️ by merhentz」、CHANGELOG v90 条目、TUTORIAL 更名）；⑥ 已部署 `dsh-pipeline@1.0.0` 并实测（系统提示只含一套 pipeline_* 段，selftest：subagents/llm OK，L3 引擎按需启动）
- v91 市场层（用户批准，2026-10-28 完成）：① README 重写为市场语气（首屏定位+痛点对照+30 秒适合/不适合判断+四阶段+硬约束表+按价值排序的特性表+完整安装/配置/工具面/版本/目录树，保留全部技术深度）；② 新增 QUICKSTART.md（第 0 步引擎自检 → 第 1 步安装二选一 → 第 2 步 /pipe-selftest → 第 3 步一句话需求 + 控制键表 + 7 个常见问题）；③ 新增 examples/ 三个可直接粘贴的示例（todo-app.md / rest-api.md / cli-tool.md，各含预期产线行为与验收思路）；④ CHANGELOG 补 v85–v88 缺口并把 v88 块移回 v89 之后（版本倒序恢复正常，现为 v91→v84 连续）；⑤ `package.json` version 1.0.0→1.1.0、files 补 QUICKSTART.md/examples/；⑥ 部署 `dsh-pipeline@1.1.0` 实测（系统提示 pipeline_* 段 + CONTROL/MILESTONE HARD GATE/BUDGET 生效，`/pipe-*` 命令可用），v90 快照目录已删
- v92 GUI 看板 + 每 L2 独立工作目录（用户批准，2026-10-28 完成）：① 看板 host 路由 `GET /pipeline/board`（lib/board-route.js 输出 run/里程碑/任务/L2/预算/计数/事件快照）+ client 部件 client.js（`dsh.client` 声明注入 Web UI 输入框上方 `conversation.input.dock`，2.5s 轮询、页面隐藏暂停、待命态显示「🔧 流水线待命」、运行态显示状态 pill/里程碑进度/预算/在跑 L2/最近事件、主题变量自适应）；② 每个 L2 独立工作目录：pipeline_spawn_module_lead 新增 scopeDir（默认 .dsh/pipeline/work/<name>），插件建目录并作为 subagent 真实 cwd（request.cwd）+ prompt 注入 WORK DIRECTORY 段，agents 记录 scopeDir；③ 修复 v90 拆分遗留潜伏 P0（tools/l1.js 缺 randomUUID/readFileSync/resolve/dirname/ensureDir、tools/l2l3.js 缺 resolve）；④ package.json 1.2.0 + exports ./client + files client.js + dsh.client；⑤ 测试新增 v92_board_smoke 29 断言（快照/路由/cwd 隔离/client 接线），旧烟测复制列表补 board-route.js，全量 73+49+probe+29+skill_sync 全绿；⑥ 部署 dsh-pipeline@1.2.0（remove v91 → install v92，/pipeline/board 实测 200）

- v93 状态正确性 + 真实跑通（用户批准，2026-10-28 完成）：① `runtimeStateDir(root)` 改为「会话工作区」而非 daemon `process.cwd()`（原来 daemon cwd=profile 目录，state 落错地方，每个工作区看起来都没有状态）；② `store` 增 `stateDir` 字段 + `setStateDir(dir)` / `alignTo(ctx,source)` / `reloadFromDisk()`；`createStore(cfg, { restore: false })` 不再从 bootstrap 目录读历史（否则把别的工作区的旧板覆盖真板），首次 `alignTo(ctx)` 才采用目标工作区文件；③ 冷启动恢复补齐 `requirement`/`locked`（原来 reload 后 requirement=null/locked=false）；④ `gateTask(task, subs, cfg, fileCode)` 支持第 4 参——磁盘真实文件优先于看板片段 → `pipeline_review` 能验收 L2 直写盘的文件（之前 cli-core 死活过不了门）；⑤ 修 v90 拆分遗留 import（`tools/l2l3.js` 缺 `LEVEL2_NAMES`/`resolve`）+ `spawn scopeDir` 相对路径按会话 cwd 解析（不再落 daemon cwd）；⑥ 真实跑通三级流程：锁需求 → plan（cli-core + cli-tests + 里程碑 m1）→ spawn cli-core L2 → L2 报 blocker → L1 定向修 → L2 接管直写 3 文件 → review 挖回看板 → spawn cli-tests → review → 里程碑验收；⑦ 看板路由加 `BUILD_TAG` 调试字段（/pipeline/board 附带 debug.build/stateDir/cwd，便于识别「热重载未生效」）；⑧ 测试 73+49+probe+34+skill_sync 全绿；⑨ 部署 dsh-pipeline@1.3.0，daemon 重启后 /pipeline/board 实测返回完整 run/tasks/agents/milestones

- v94 侧栏看板卡 + 每 L2 独立模型（用户批准，2026-10-28 完成）：① 看板合并为**一个座位** `sidebar.footer.action`（id `pipeline-board`，order 9 最右），删除 composer 下方状态条与右侧悬浮卡；卡片与 cost-meter 余额卡同视觉语言（width:100% 自适应、13px 字号、bg-layer-1/border-l1、圆角 8），状态行 + `模型 L1 · L2 默认` + 每个活跃 L2 一行（名字·覆盖模型 + 已用/甜点区 + 迷你条 + 百分比）+ L3 计数 + run 预算主条，甜点区绿/黄/红三段色，rail 窄栏退化为图标；② `/pipeline/board` 增 `context`（models、level1/level2 甜点区）与 `agents[].model`，L1 token 由工具包装层 measureLevel1Context 写入；③ `pipeline_spawn_module_lead` 新增 `provider`/`model`（每个 L2 可单独换模型，缺省用 level2 默认；记录随 agent 保存并在看板显示）；④ 测试 `v92_board_smoke` 增 4 条 per-lead 断言，全量 73/49/probe/board/skill_sync 全绿；⑤ 部署 `dsh-pipeline@1.4.0`（remove v93 → install v94，profile link 指向快照 v94）
- v95 L1 模型表述修正 + L2 命名规则 + 提示词低损压缩（用户批准，2026-10-29 完成）：① L1 不是「必须 pro」——`buildProtocolText` / SKILL Phase 0 / skill 描述改为「L1 = 用户为当前会话选的模型」；宿主新增 `resolveSessionModel(ctx, source)`（读会话 `header.model`），`store.alignTo` 写入 `store.context.level1Model`，看板 `context.models.level1` 改为读它（旧逻辑读静态 cfg 默认值）；README / design doc / package.json 表述同步；② L2 命名规则写进 SKILL 与工具描述：kebab-case、1–3 词、一眼可读交付物（cli-core/cli-tests/api-auth）、禁泛化词/中文/空格、单 run 唯一；③ 提示词低损压缩：SKILL.md/SKILL_BODY 16099→10242 字符（−36%）、buildProtocolText 1855→1559（−16%）、buildL2LeadPrompt 4849→3941（−19%）、16 个工具 description 再压约 10%，规则/工具名/参数语义零删除，`skill_sync_check` 仍字节一致；④ 全量回归 73/49/board/probe/skill_sync 全绿；⑤ 部署 `dsh-pipeline@1.5.0`（remove v94 → install v95，v94 快照已删）
- v96 模块数推荐（用户批准，2026-10-29 完成）：① SKILL 新增 MODULE COUNT GUIDE 表（单文件/脚本/小修→1 个 L2；3–8 文件或 1–3 关注点→2–3；多子系统/DAG/≥10 文件→4–8，硬上限 maxLevel2Agents=10），并写明「按真正独立关注点计数」「≥3 个独立关注点必须 ≥3 个 L2，禁止把大项目压成 1–2 个」；② `pipeline_plan` 返回新增软提醒 `planHint`（任务≥3 但只规划 1 个模块，或需求≥600 字但模块≤2 时提示）；③ `pipeline_spawn_module_lead` 返回新增软提醒 `spawnHint`（计划里还有 ≥2 个模块没派过 L2 时列出它们）；④ 全部为软引导、不阻断，小任务仍走单 L2 快路径；⑤ 测试 v92_board_smoke 增 6 条断言，5 套回归全绿；⑥ 部署 `dsh-pipeline@1.6.0`（remove v95 → install v96，v95 快照已删）。
- v97 看板三区色 + 危险线（用户批准，2026-10-29 完成）：① 表达目标改变——不看「是否待在甜点区」，而看「是否进入能力大幅打折区」；每层进度条改为固定三区（绿 0→甜点上限 `levelNContextBudget`；橙 甜点上限→危险线 `levelNDangerBudget`（默认 contextWindow×dangerRatio，L1/L2 0.75、L3 0.9）；红 危险线→模型窗口 `levelNContextWindow`），区界竖线，当前位置用白色指针移动，不改变三区底色；② 数值进入橙/红区时变色；③ 新增 `levelNContextWindow` / `levelNDangerBudget` 配置 + `tuneSweetSpot` 换模型自动重算；④ 删掉卡片上「甜点区」字样以免误读（工具返回仍保留甜点区语义）；⑤ `verify-v82` 增危险线联动断言，`v92_board_smoke` 增三区/指针断言，全绿。
- v98 知识层（用户批准，2026-10-29 完成）：① 新工具 `pipeline_scan`（仓库 → `.dsh/pipeline/knowledge/`：`index.md` 一页骨架 + `map.json` 文件 sha1 符号表 + 每模块一页 + 模块总览，跳过 .git/node_modules/dist/二进制/超大文件，含 git head/近期提交/启动命令/超大文件与 TODO 信号）；② `pipeline_ledger`（从交接文档抽「关键决策」编号项 + 「结论/结案」强结论 → `ledger-candidates.md` + `ledger.json`，每条标出缺失字段 rationale/invalidation/reversibility/pointer）；③ `pipeline_recall`（知识库内检索，中文 bigram + 英文词，返回 `file:line` 与片段，无命中就说无）；④ `/pipe-research` 命令（7 步研讨模板 + 3 条防呆）；⑤ `buildProtocolText` 增 KNOWLEDGE 行、SKILL Phase 0 增知识层用法；⑥ stock 实测：1525 文件 / 27 模块 → index 4600 字符（≈1.4K token）、17 个模块页 12727 字符；⑦ 测试新增 `v98_knowledge_smoke`（15 断言），`verify-v82`/`v90_tool_factory_probe` 模块复制列表补 knowledge 模块、工具/命令计数断言更新为 19/7，6 套回归全绿；⑧ 发布流程修正为「三查验证」：`listTools` 必含新工具 + version 与目录一致 + `CHANGELOG` 已写，三项都有证据才算部署完成。
- v99 知识层加固 / 泛化 / 发布自动化（2026-10-29 完成）：① 秘密文件（.env/*.key/*.pem/id_rsa…）只记路径与大小、绝不读内容，抽样文本过 `redact()`（sk-/AKIA/ghp_/password= 一律 [redacted]）；② `checkStale()` + `pipeline_scan({check:true})` 比较 `hashes.json` 回答「知识库过期没有」；③ ledger 机械三分诊 KEEP / REVIEW / DROP（有指针+理由或失效条件 → keep）；④ 泛化：CODE_EXT 扩到 20+ 语言、模块分组改通用约定（cmd/internal/pkg/src/main/java/apps/<x>/src）、material 目录中英文回退；⑤ `dev/release.mjs` 一键发布（CHANGELOG 门禁 → 版本校验 → 跑全部 smoke → 快照 → sha256 比对 → 打印人工步骤）；⑥ 新增 `v99_knowledge_hardening_smoke` 27 断言；⑦ 发布 `dsh-pipeline@1.9.0`
- v101 审计 + 精壮化第一轮（2026-10-29 完成）：未用导入清零（plugin.js 35 个 → 0、l1/l2l3 共 −116 行）；重复逻辑合一（`numCfg` 8 处 → 1、`makeSubtask`/`failedNames`/`requireSubagents`）；15 处工具输出统一紧凑 JSON；buildProtocolText 1472→1252 字符、buildL2LeadPrompt 3941→3535 字符；删过期注释块；发布 `dsh-pipeline@1.10.0`
- v102 瘦身 + 文档对齐 + 发版号统一（2026-10-29 完成）：① 工作区净化：删 `dev/` 下临时脚本（`_tmp_*.cjs/mjs`）/调试截图/demo/team_board/stock_scan/smoke/_archive，删根目录空 `README.md`、`RULES-tier3-executor.md`（ninfer 时代路由规则）、空 `node_modules/`/`src/`；仓库只剩 `plugin/`（27 文件）+ `dev/`（checkpoint + release.mjs + 7 套测试）+ `.dsh/`（运行时状态）；② 文档对齐：README 引擎表述改「任意 OpenAI 兼容」、看板位置改左侧栏、目录树补 `lib/knowledge/` 与 `tools/knowledge.js`、测试说明改 7 套；TUTORIAL 工具表补 `pipeline_scan/ledger/recall` 三个工具并泛化 L3 引擎表述与换模型流程；`docs/agent-lifecycle-design.md` L3 provider 泛化；③ 看板 L3 行完成时不再显示「已完成」字样；④ `BUILD_TAG` 统一为 `v102`（v101c/v101d 曾漏改，`debug.build` 一直谎报 v101b）；⑤ 用户侧版本号统一 `1.11.0`（1.10.x 为内部发版号，与界面不一致）；⑥ 7 套回归全绿（75/49/probe/board/15/27/skill_sync）+ `pipeline_selftest` 全绿；⑦ 发布 `dsh-pipeline@1.11.0`（remove v101d → install v102，旧快照已删，`release --verify` clean）
- v101d L1 上下文改近端窗口估算（2026-10-29 完成）：v101c 换用 `surfaceTokens` 后长会话仍报 `2136K/64K`——因为 surfaceTokens 本身就是整个 session surface（压缩在模型代理层，session 仍保留全部历史节点）。改为 `dsh-compat.js:tailSurfaceTokens()`：取最近 40 个 surface 事件（`snapshotEvents(seq-40)` → `deriveEventMessage` → `estimateMessage`）求和，近似模型此刻真正收到的量级；且不再调 `tokenMeter.measure()`（原为 O(会话) 重放，现为 O(40)）。L2 仍用 surfaceTokens（子代理短会话，surface≈真实）。v92_board_smoke 断言改为 `level1 read uses the tail-window estimate`。发布 `dsh-pipeline@1.10.3`
- v101c 上下文读数修正（2026-10-29 完成）：看板 L1 曾显示 `2107K/64K`（3290%）——根因 `tokenMeter.measure()` 的 `totalTokens` 是整段会话日志累计（含已被替换的历史节点），`surfaceTokens` 才是模型此刻真正收到的上下文。① `dsh-compat.js:measureLevel1Context` 优先 `surfaceTokens`（`totalTokens` 兜底），新增返回 `logTokens` 供诊断；② `board-route.js:measureAgentTokens` 同样 `surfaceTokens ?? totalTokens`；③ `dev/release.mjs` 支持带字母 suffix 的 tag（`v101b`/`v101c`：快照目录 `dsh-pipeline-v101c`、CHANGELOG 锚点 `## v101c`、`--verify` 模式串放宽）；④ v92_board_smoke 新增 3 条断言（两处源码偏好 + measureAgentTokens 行为返回 surface 值）；⑤ 发布 `dsh-pipeline@1.10.2`
- v101b 效率与健壮性审计第二轮（2026-10-29 完成）：① L1/L2 `tokenMeter` 测量 1.5s 缓存（GUI 每 2.5s 轮询不再重放会话日志）；② 知识库文件按 `size:mtime` 缓存（重扫后自动失效）；③ `tuneSweetSpot` 表驱动 `TUNE_TARGETS`（config.js 388→301 行）；④ 删死导出 `readDecisionLedger`；⑤ `pipeline_status` recentMessages 20 条全文 → 10 条 × ≤160 字符；⑥ 看板路由注册失败 `console.warn` 落宿主日志；⑦ `BUILD_TAG=v101b`（/pipeline/board 的 debug.build 可识别线上版本）；⑧ 8 套测试全绿；发布 `dsh-pipeline@1.10.1`

## 4. 进行中（文件 + 进度）
无。v101d 已收官（代码/测试/快照/安装/代码层三查全部完成：version 1.10.3 + CHANGELOG 有 v101d/v101c/v101b/v101 条目；快照 identical 27 文件）。**运行态验证待 daemon 重启**：重启后 `/pipeline/board` 的 L1 数字应落到几万以内（而非 200 万+）。

## 5. 待办（索引）
- 已完成方向（见 §3）：P1 知识层加固、P2 泛化实测、P3 发布自动化 → 均在 v99 落地
- 候选后续：① `pipeline_scan` 增量扫描（大仓库全量重扫 ~秒级，可按 per-file mtime 做增量）；② 看板卡片交互（点击展开 run 详情/最近事件）；③ `decisions.md` 自动老化（超过 N 天未验证标 stale）；④ 上 npm 前补 repository/homepage 元数据
- 可选发布：`plugin/` 已被 package.json files 收口（lib/skills/docs/examples/QUICKSTART/README/TUTORIAL/CHANGELOG），可直接 `pnpm pack` 出 tgz；若要上 npm 需改 author/repository 元数据
- 老会话的旧系统提示可能仍含 tiered_* 段落（仅历史会话，新会话已是 pipeline_*）

## 6. 关键决策
- L2 用 continuable subagent，不用 Agent Teams（teammate 继承 pro，不能指定 flash）
- L3 默认轻量工具路径（单次 HTTP），agent 路径可选
- 交接 = 索引式 + 文件即真相（不全文复述，细节在文件里）
- 里程碑验收在前、任务转移在后
- 用户意见触发的改造默认推迟到 checkpoint 切换后实施（当前上下文不做，交给新会话按意见改）
- 目录分离：可分发插件（`plugin/`）与开发/交接产物（`dev/`）分开，`plugin/` 直接打包分发
- devDir（默认 `dev`）：插件编排的项目的开发过程文档统一写进 devDir，与生产交付文件分离（固化进插件）
- 里程碑「我很满意」后无条件交接 + 灭活 L2（level2ContextBudget 降级为模块小型化参考，不再作重建触发条件）
- 规划平衡：天然接缝拆解（一句话接口测试）+ 注水 ~75% 水位 + LPT 装箱 + 负载护栏（代码，零 LLM token）
- 全局治理：架构宪法 + 接口契约（单一事实源）+ 组装门（里程碑验收前审整体防屎山）
- L1 有界兜底：默认不写码，cannot-do/满重试 → 最多重派 1 次 → 直写卡点（过门+留痕）
- 单 L2 快路径：小+内聚+串行可接受 → 1 个 L2，跳过均衡（装箱/注水/LPT），保留质量（宪法/组装门/兜底/里程碑重建）
- L1 上下文客观计量：挂钩 DSH tokenMeter（measure(session).totalTokens），pipeline_status.level1Context + /pipe-tokens 命令，level1ContextWarnRatio（默认 0.8）触发 checkpoint 提示
- 产品名定为「流水线 / Pipeline」，包名 `dsh-pipeline`（DSH 生态惯例，不带作者名），命令前缀 `/pipe-*`；merhentz 为作者彩蛋（package.json author / README 末尾 / CHANGELOG 署名），定位：强模型掌舵、弱模型干活、花钱花在刀刃上；精壮三原则（能删就删 / 能复用就复用 / 能自动就不靠记忆）
- v90 拆文件原则：一个文件一个职责（config/store/gates/prompts/dsh-compat/guards/tools），plugin.js 只做 apply 装配；模块间单向依赖 util→config→store/gates/prompts/dsh-compat→guards→tools→plugin.js
- 兼容不设别名：改名后不保留 `tiered_*` 旧工具/命令别名（精壮优先；旧版 bundle 已移除）
- 控制面原则：状态落成文件（run.json/activation.json），门禁落成守卫（tools.guard 硬 Gate），用户随时能停（/pipe-stop 只冻结不销毁）
- 里程碑状态「计算而非存储」：milestoneStates 从任务 state 实时算，避免持久化副本漂移
- 预算护栏对执行类工具生效；已在跑的 L3 完成时仍计入 token（钱已花掉，不能装看不见）
- 刻意不做：作用域硬拦（DSH write 工具不在插件控制内，以 L1 声明 + filesTouched 审计代替）、自动写 checkpoint（改为里程碑验收后提示 L1 手动调，避免覆盖人工交接文档）
- v91 市场定位：README 首屏回答「我是什么/解决什么/怎么用」，先给 30 秒适合/不适合判断，再展开技术细节；examples 用「一句可粘贴需求 + 预期产线行为 + 验收思路」三段式，不写死模块名（模块由 L1 按项目接缝生成）
- v94 每 L2 模型：`pipeline_spawn_module_lead` 接受可选 `provider`/`model`——同一产线里难的模块用 pro、其余用 flash，钱花在刀刃上；缺省即 level2 默认，选择随 agent 记录并显示在看板

## 7. 遗留坑 / 注意
- **改代码后必须重启 daemon**（v93 实测）：`set_bundle(false→true)` 只重新 apply bundle，不重新读已 import 的 ESM 模块（Node 按绝对 URL 缓存）→ 旧代码继续跑。彻底退出桌面端重开才生效。换新目录 + 改包名只在换 bundle 路径时需要。
- 每次 disable→enable 热重载，当前 L1 会被临时降级为 deepseek-flash（工具消失、上下文重置），重载完成后恢复；重启 daemon 不受此影响。
- L3 引擎 ninfer 默认开思考（--default-thinking-budget），小任务会多花几十 token 且更慢；响应解析必须取 `choices[0].message.content`（v84 起，旧 Ollama `response` 字段已废）
- qwen3 是推理模型，必须 think:false，否则死循环/不输出（Ollama 时代的坑，v84 迁 ninfer 后由引擎参数控制）
- `deepseek-v4.1-flash` 不存在，用 `deepseek-flash`
- 交接文档里 §3–§7 只放指针，复杂内容在磁盘文件里
- 重装顺序（v90 实测，最顺）：`plugin_manager install_bundle(新目录)` 直接 applied（v90 段 id 是 `pipeline:protocol`，与旧版 `tiered:protocol` 不冲突）→ `set_bundle(旧版, false)` → `remove_bundle(旧版)`。若新旧段 id 相同（同名升级）才需要先关旧再 toggle 新
- 同名升级（v91 实测）：同包名已装时 `install_bundle` 报 `already-installed`，必须先 `remove_bundle('dsh-pipeline')`（会重写 profile deps），再 `install_bundle(新目录)`，成功返回 `application:"applied"`；安装输出里的 `ECONNRESET` 只是 pnpm 联网校验锁文件的网络重试警告，不影响结果
- v90 后模块化，测试脚本加载方式：复制 `lib/` 全部模块到 tmp 并 patch `config.CONFIG_FILE` + `store.runtimeStateDir`（见 dev/smoke/verify-v82.mjs 的 bootstrap）

- **v101b 教训（静默 catch 吞 bug）**：给 `util.js` 加共享 `readText()` 时忘了同步 `readFileSync` 导入，函数内部 catch 把它吞成空串 → 知识层「0 候选」而不报错，靠 `v98/v99` 测试结果非空断言才发现。教训：静默 catch 必须配「结果可信」断言。
- **CHANGELOG 门禁只看有没有条目**：v101 条目曾漏写、v101b 首次插入位置错到文件尾（`indexOf` 未命中导致 `slice(0,-1)` 兜底）。发布前人工看一眼头部三条顺序。
- **`dev/release.mjs` 的 vN 参数只接受纯数字**：`v101b` 这类带字母的版本号匹配不上 `/^v\d+$/`，要用 `node dev/release.mjs v101 --version 1.10.1`。

- **tokenMeter 读数语义**：`measure()` 返回的 `totalTokens` 是会话日志累计（含被 replace 的历史节点），`surfaceTokens` 才是模型当前收到的上下文。凡是判断「上下文压力 / 是否进危险区」都必须用 `surfaceTokens`，否则会得到 3290% 这种荒谬比值。
- **release tag 允许字母后缀**：`v101b`/`v101c` 这类 tag 现在能直接传给 `dev/release.mjs`，但默认版本推导仍按数字部分（`1.10.x`），需要 `--version 1.10.2` 显式指定小版本。

- **BUILD_TAG 必须随版本更新**：v101c/v101d 忘了改 `lib/board-route.js` 的 `BUILD_TAG`，导致 `/pipeline/board` 的 `debug.build` 一直报 `v101b`——功能正确但版本标签撒谎，排查时会被误导。发版清单里加一条：改版本号时同步 `BUILD_TAG`。
- **tokenMeter 三个数字的含义**：`totalTokens` = 会话日志累计；`surfaceTokens` = 整个 session surface（代理层压缩不改变它，长会话可达 2.1M）；两者都不能当「上下文压力」用。要判断模型当前压力，只能自己估算近端窗口（见 `tailSurfaceTokens`）。

## 8. 活跃 L2 状态
(无活跃 L2 —— 当前是纯插件开发会话，无正在运行的模块负责人)

## 9. 恢复步骤（新会话）
1. 读本文件 + 工作区文件对账（文件是真相，细节在文件里）
2. 无活跃 L2 需要恢复（纯开发会话）
3. 继续后续开发 / 测试；改代码记得「新目录 + 改包名 + 重装」


# 版本日志（CHANGELOG）

> 版本号规则：DSH 桌面端按「模块真实路径」缓存导入结果，改代码后需**复制到全新目录 + 改包名 + 重装**才能生效。因此每次迭代用 `-vN` 后缀命名新 bundle（`dsh-pipeline-vN`），版本号即迭代序号。

## v113 — 1.20.1（修复 v112 的 footer 宿主校验错误）

### 修复
- **B6 回归**：v112.0 把页脚挂成结果值上的非枚举属性 `__pipelineFooter`，宿主对工具返回值做 lossless-JSON 校验时拒绝该额外属性，13 个带页脚的工具全部报 `tool "..." returned invalid output: value is not lossless JSON`（面板之外的调用不可用）。改为模块级 `WeakMap`：结果对象本身保持纯 JSON，`render()` 仍能取到**本次调用**的页脚，跨工作区并发隔离不变。
- 新增 `setResultFooter(value, text)` 导出；`plugin.js` 不再对结果调用 `Object.defineProperty`。
- 测试：`dev/smoke/v112_audit_p2_smoke.mjs` 的 footer 段改为 WeakMap 断言（结果值无额外键、`JSON.stringify` 不变），断言 39 → 40。

## v112 — 1.20.0（审计 P1/P2：真实上下文计量、事件回放、off 模式瘦身）

### 修复
- **B9 token 估算（P1）**：`estimateTokens` 改为 CJK 感知（`cjk/1.6 + ascii/4`）。此前统一 `chars/4`，对中文内容**低估约 40%**，导致预算守卫和 L3 输入预算都偏松。
- **B10 上下文比率（P1）**：`measureLevel1Context` 优先用 `tokenMeter.measure(session, requestHeader()).totalTokens`（宿主文档定义的「当前请求压力」），拿不到时回退旧的 tail-40 事件估算，并在返回值里标注 `source` / `approximate`；面板与检查点提示不再因估算偏小而迟到。
- **O7/B14 L2 真实消耗（P1）**：新增 `accountL2Tokens()`——对每个在跑的 L2 用 `tokenMeter.measure()` 取会话总量，按**高水位增量**计入 `counters.measuredTokens` 与 `run.tokensUsed`；在 spawn/send/status/drain 时结算。`pipeline_status` 现在显式区分 `trackedTokens`（插件自己估算的 I/O）、`measuredTokens`（宿主实测）、`tokensUsed`（预算累计）与 `measuredDelta`，`totalTokens` 保留为兼容别名。
- **B2 配置校验（P1）**：`POSITIVE_KEYS` 里的 `maxLevel3OutputTokens` 拼写错误修正为 `level3MaxOutputTokens`——此前 `/pipe-config level3MaxOutputTokens 0` 能写进配置并直送 `max_tokens`。
- **B5 L1 兜底路径（P2）**：新增配置 `allowLevel1Takeover`（默认 `false`）。开启后守卫允许 L1 在兜底时调用 `pipeline_register_output` / `pipeline_review`；关闭时 SKILL 明确「写文件后交给 L2 过门禁」。文档与实现不再互相矛盾。
- **B6 footer 竞态（P2）**：运行页脚改为按结果值存于模块级 WeakMap（v113 修正：v112.0 的「挂非枚举属性」会被宿主 lossless-JSON 校验拒绝）；并发调用不同工作区时不会再渲染成另一个 run 的状态。
- **B8 回退值不一致（P2）**：三处 `maxLevel3Retries` 的兜底默认值统一为 5（此前 execute 路径用 2、review 路径用 5）。
- **B11 消息回放（P2）**：冷启动 `restore` 时回放 `trace-<runId>.jsonl` 尾部 20 条事件到 `store.messages`，`recentMessages` 不再在重启后凭空消失。
- **B13 宿主能力（P2）**：不再猜测 DSH 版本写 `engines`；插件启动时探测必需 Service（subagents/sessions/llm）与可选 Service（tokenMeter），缺失时打印可读告警，而不是等工具调用时才报错。
- **B15 selftest 语义（P2）**：返回 `{ok, ready, degraded, checks}`——`ok` 表示检查本身跑完，`ready:false` 表示有核心服务不可用（如 L3 引擎未启动），不再把「引擎没开」误读成「插件坏了」。
- **O3 plan 回显（P1）**：`pipeline_plan` 默认只回路由骨架（任务 `desc≤80` + id/assignee/depends_on/state），`verbose:true` 才回全文。
- **O4 协议瘦身（P1）**：每请求注入的协议 1,742 → 925 字符（≈436 → 232 tok），保留分层边界/委派规则/禁轮询/里程碑验收/预算与知识库入口；新增 `mode=off` 专用短文案（193 字符）。
- **O8 off 模式（P2）**：`mode=off` 时只注册 6 个只读/诊断工具（status/classify/selftest/scan/ledger/recall），其余 13 个 schema 不再占每个请求的工具表；`/pipe-config mode auto` + 重载恢复。
- **O10 board.json（P2）**：快照写为紧凑 JSON（仍含完整任务/agent 字段供恢复）。

### 测试
- 新增 `dev/smoke/v112_audit_p2_smoke.mjs`（39 断言）：CJK 估算、配置键校验、协议长度/off 文案、takeover 守卫矩阵、footer 值传递、plan 精简/verbose、status 的 tracked/measured 字段（假 tokenMeter）、selftest 形状、紧凑 board.json + trace 回放、mode=off 只注册 6 工具 / mode=auto 注册 19 工具。
- `v111` 的 status 上限从 3,000 放宽到 3,400（v112 增加了计量字段）。
- 测试链 11 → 12 套件，`npm test` 全绿。

## v111 — 1.19.1（审计 P0：省 token + 堵路径逃逸）

### 修复
- **B3 路径逃逸（P0）**：`pipeline_register_output` / `pipeline_review` 的 `filePath` 经 `wsPath()` 约束——绝对路径、盘符、`..` 越界一律抛错；历史记录里的绝对路径（`fileAbs`）仍可读，兼容旧 run。此前 `register_output` 可读工作区外任意文件并写入板/轨迹，`review` 还会把内容交给断言执行器。
- **B4 子任务验收（P0）**：`pipeline_decompose` 的 LLM 现在为每个子任务返回自己的 `acceptance`（`[{"desc","acceptance"}]`），不再让全部子任务继承模块级验收；旧格式（字符串数组）与确定性兜底仍回退到模块验收，并在 `fallbackReason` 里说明原因。
- **B7/O6 代码双重计费（P0）**：`pipeline_execute_local` / `pipeline_execute_batch` / `pipeline_spawn_local_executor` 接受 `filePath`（工作区相对），插件把生成代码写盘并只返回 `path/lines/sha8`，不再把整段代码回显给 L2；`pipeline_review` 改为读盘上的真实文件做门禁，交付物缺失即判失败（`file-on-disk` 检查项）。未传 `filePath` 时保持旧行为（回显 `code`）。
- **O1/B1 status 投影（P0）**：`pipeline_status` 默认只返回路由字段——任务/子任务描述截断、agent 只留 id/kind/label/state/model/scopeDir/estimatedTokens/desc(80)、需求截 400 字、recentMessages 投影为 `{sender,state,type,task_id,note≤140}`；`verbose:true` 恢复全文。顺带修掉 160 字符截断按 `m.text` 取值的死代码（板上的消息根本没有该字段）。真实归档 run 实测：20,041 → 4,299 字符（≈5,011 → 1,075 tok）。
- **O2 checkpoint 不再回显全文（P0）**：`pipeline_checkpoint` 返回 `{path,bytes,lines,coldStartPrompt}`，文档正文只在 `verbose:true` 时返回；真实 run 实测 3,278 字节文档 → 771 字符负载（≈193 tok）。

### 测试
- 新增 `dev/smoke/v111_audit_fixes_smoke.mjs`（28 断言）：B4 每子任务验收 + 字符串兜底 + fallbackReason；B3 绝对路径/`..` 被拒（register_output 与 review）；execute 写盘 + `path/lines/sha8` + 盘上字节一致；缺文件门禁失败；status 投影 <3,000 字符、agent 无 code、verbose 全文；checkpoint 元数据 + verbose 正文。测试链由 10 套 → 11 套。
- v105 的 takeover 用例改用工作区相对路径（`out.js`），与 B3 新约束一致。

## v110 — 1.19.0（看板跟随当前 DSH 工作区）

### 修复
- 切换工作区后侧栏看板不同步：v108/v109 的选择靠 `localStorage` 持久化或宿主 `lastActive` 回落，而 `lastActive` 只在目标工作区跑过 pipeline 工具时才更新——用户只是切过去、没有发消息时，卡片仍显示上一个项目。
- 客户端改为从 slot 的标准 `useSessions` props 取主视图会话（`retainedBy.mainView > 0`）的 `cwd`，轮询 `/pipeline/board?workspace=<cwd>`；工作区切换即时生效，无需在目标项目产生任何活动。
- host 的 `entryForRoute` 接受「存在的绝对路径 + 项目标记（`.git` 或 `.dsh/pipeline`）」：`findProjectRoot` 上溯到项目根后再 `ensure(key)`，即使该工作区从未跑过 pipeline 工具也能按需加载；子目录 cwd 不会在子目录里建 store。
- 显式选择改为会话内内存状态（不再写 `localStorage`，旧键 `dsh-pipeline.workspace` 自动清除）；下拉框首项「跟随当前工作区」，选中后回到自动跟随。旧行为会把卡片钉死在旧项目，正是这次不同步的来源。

### 测试
- v103 由 44 → 48 断言：客户端断言改为「读取主视图会话 cwd / 提供跟随项 / 清除旧持久化键」；新增「会话 cwd 子目录解析到项目根且不建嵌套 `.dsh`」用例。

## v109 — 1.18.0（工作区选择在侧栏各形态间同步）

### 修复
- 展开的看板卡片与折叠后的 56px 侧栏图标是两个独立挂载点：此前「选择工作区」只存在卡片自己的 `useState` 里，切到 B 项目后折叠栏图标仍轮询宿主默认的 lastActive 工作区，看起来像把全局状态混进了小组件。
- 选择改为模块级共享状态 + `localStorage`（键 `dsh-pipeline.workspace`）持久化：任一挂载点切换，所有挂载点立即改轮询 `?workspace=<key>`；折叠/展开、页面刷新后仍停在该工作区，不再漂回「最近跑过的项目」。
- 工作区列表里已删除的项目会被自动丢弃（下一次轮询回到宿主默认），不会一直 404。
- 折叠栏图标的 tooltip 与卡片悬浮详情现在带工作区名，能直接看出当前显示的是哪个项目。

### 测试
- v103 由 42 → 44 断言：新增客户端源码断言（选择持久化键存在、折叠栏与卡片共用 `usePickedWorkspace`、无组件私有 `setPicked`）。

## v108 — 1.17.0（看板工作区切换器）

### 新增
- 侧栏看板卡片新增工作区下拉框：daemon 服务过多个项目时，可直接切换看板显示哪个项目的 run；选择会持久化，重启后仍是该工作区。
- `workspaces.js` 记住已服务过的工作区路径（`~/.dsh/pipeline/workspaces.json`，只存绝对路径、最多 32 条、失效目录自动剔除），新增 `listKnown()`；`?workspace=<key>` 可加载当前 daemon 尚未在内存中的已知工作区（按需读盘，零 token）。
- 看板快照新增 `workspaces: [{key,name,active}]`，仅当项目数 ≥2 时客户端才显示下拉框。
- 冷启动默认显示最近使用的工作区；一个已知工作区都没有时才显示「流水线待命」空态。
- v103 由 34 → 42 断言（覆盖已知列表、活动标记、冷启动按 key 加载、空态仍 200）。

## v107 — 1.16.0（界面：侧栏图标由扳手改为看板符号）

### 变更
- 侧栏卡片与折叠侧栏（56px rail）的图标从 🔧 改为 `◫`（待命，空心面板）/ `▣`（运行中，实心面板）；颜色继续沿用状态色（待命灰、运行橙），不再出现与插件语义无关的扳手。
- 版本 1.16.0、`BUILD_TAG='v107'`；其余逻辑与 v106 完全一致（测试 10 套，基线不变）。

## v106 — 1.15.0（空态修复：更新后侧栏卡片不再消失）

### 修复
- 看板路由：daemon 刚重启、或某个工作区还没调用过任何 `pipeline_*` 工具时，`GET /pipeline/board` 返回 **200 + idle 快照**（`debug.idle=true`、`run.status='idle'`），不再返回 404；显式 `?workspace=` 指向不存在的 key 仍是 404。
- 侧栏卡片：轮询失败时保留上一次成功的快照，不再清空 `snap` 导致整块消失；冷启动最多 2.5 秒后显示「待命」卡片。
- 版本 1.15.0、`BUILD_TAG='v106'`；v103 新增两条空态断言（无 store 时 200 idle、`debug.stores=0`）。

## v105 — 1.14.0（批次 D–E：发布校验 + 生命周期闭合）

### 发布与文档（D）
- `dev/release.mjs`：先跑全部检查再复制快照（失败不再覆盖）；CHANGELOG 标题的 tag 与版本必须同时匹配；`BUILD_TAG` 必须等于发布 tag；`--dry` 明确打印不写快照。
- `package.json` 版本 1.14.0、test 串起全部 10 套；`BUILD_TAG='v105'`；新增 MIT `LICENSE`。
- README/TUTORIAL/QUICKSTART/设计文档按实现校正（断言语言、产物路径、checkpoint 节数、端点默认空、安装命令）。

### 生命周期（E）
- `pipeline_plan`：重 plan 保留已完成任务状态与已验收里程碑；存在「done 但未验收」里程碑时默认拒绝，需显式 `reset:true`。
- `pipeline_accept_milestone`：必须传 `userConfirmed:true`（用户对话中确实验收过），否则拒绝。
- `pipeline_drain_leads`：`drainChildren` 失败不再吞掉——相关 L2 标 `failed`、写 trace、返回 `ok:false`；成功返回 `ok:true`。
- `pipeline_spawn_module_lead`：同名模块按 `maxLevel2Retries` 限制重派发次数，超出时要求 L1 自己接手或向用户报 cannot-do。
- 账目：L2 分解调用计入 `tokensUsed` 与 `l2Decompose`；L2 接手写盘的文件计入 `filesTouched`；`counters` 随 board.json 冷恢复。

## v104 — 1.13.0（批次 A–C：工作区隔离 · fail-closed 质量门 · 反轮询与配置/秘密硬化）

> 说明：v103/v104 是 v102 评审后的三个修复批次（A 隔离、B 门与角色、C 反轮询/配置/秘密），版本号合并为本条 1.13.0。

### A. 工作区隔离（P0）
- 新增 `lib/workspaces.js`：按规范化 workspace root 惰性建 store 注册表；`keyFor` 依次用子会话映射（spawn 后 bindChild）→ session `header.cwd` → 上溯 `.git`/`.dsh/pipeline`；不再有进程级 `store.stateDir` 漂移。
- `store.js`：`createStore(cfg,{root})` 固定 stateDir；删除 `setStateDir` 与 requirement_lock 复制；冷恢复先清空再读盘；`alignTo` 改名 `bindSession`，只更新模型与会话。
- `plugin.js`：工具注册一次、按工作区分发；命令按 invocation 解析工作区；`board-route.js` 支持 `?workspace=` 且默认 lastActive，先建快照再写响应头。
- 工具结果页脚修复：数组型 render 现在会追加运行状态页脚（此前永不显示）。

### B. 质量门与角色（P0）
- `gates.js`：断言优先且 fail-closed——JS（node）与 Python（ast 静态安全门 + 子进程）都真执行；`ran:false` 一律失败，不再回落关键词分；同一子任务的全部断言必须通过；`subtask_id` 做真实比对；`gateTask` 不再有恒真检查。
- 语义分封顶 0.5，关键词不再能“猜过”质量门。
- `allowCodeExecution`（默认 true）：关掉后任何含断言的验收直接失败。
- 角色矩阵集中在 `guards.js`：L1 不得直接执行 L2/L3 工具、L2/L3 不得派发、无法归因时 fail-closed。

### C. 反轮询、配置与秘密（P0/P1）
- 反轮询：常驻协议补「goal 自动续轮唤醒时也要结束回合」；spawn/send 工具成功后调用 `concludeTurn()`；`pipeline_status` 在有 L2 进行中时返回 `waitingFor` 与等待提示。
- 配置只写显式键（不再把合并后的全量配置写回全局）；`level3Endpoint` 默认空并要求显式配置，新增 `level3Provider`/`spawnProvider`，`level3InputBudget` 默认 1200；配置值校验（比例/预算/超时/端点）。
- 秘密硬化：`redact()` 统一到 `util.js`，checkpoint 摘录、模块页、ledger 候选、recall 输出全部脱敏；`recall` 拒绝 `..`/绝对路径/目录穿越。
- 测试：`pnpm test` 现在串起全部 9 套（含 v98/v99/v103/v104）；v82 默认值断言改为固定口径；v99 增加 checkpoint 脱敏与 recall 围栏用例。

## v102 — 1.11.0（版本号与安装对齐，用户侧可见）

> 说明：1.10.x 系列是内部发版号，用户侧界面显示的版本号本次统一为 1.11.0；本条目汇总 v102 的全部改动，更早的 1.10.x 细节见下方 v101d/v101c/v101b 条目。

### 瘦身
- 删开发残留：`dev/` 下的临时脚本（`_tmp_*.cjs/mjs`）、调试截图、`demo/`（示例项目）、`team_board/`（v68 遗留）、`stock_scan/`（知识层原型，已被 `lib/knowledge/` 取代）、`smoke/_archive/`（旧版本一次性烟测）。
- 删工作区根遗留：空 `README.md`、`RULES-tier3-executor.md`（ninfer 时代路由规则）、空 `node_modules/`、空 `src/`。
- 仓库现在只有三块：`plugin/`（插件本体）、`dev/`（checkpoint + release.mjs + 7 套测试）、`.dsh/`（运行时状态）。

### 文档对齐
- README：本地引擎改为「任意 OpenAI 兼容」表述；看板位置改为左侧栏；目录树补 `lib/knowledge/` 与 `tools/knowledge.js`；测试说明改为 7 套。
- TUTORIAL：工具表补 `pipeline_scan` / `pipeline_ledger` / `pipeline_recall`；L3 引擎表述与换模型流程泛化。
- `docs/agent-lifecycle-design.md`：L3 provider 表述泛化。
- 看板 L3 行完成时不再显示「已完成」字样（格子本身已表达）。

### 验证
- 7 套回归全绿：75 / 49 / probe / board / 15 / 27 / skill_sync。
- `pipeline_selftest` 全绿（subagents · llm · L3 engine HTTP 200）。
- 工具面 19 个，与 README 工具表一致。

*Made by merhentz.*

## v101d — 1.10.3（L1 上下文改用近端窗口估算）

v101c 把 L1 读数从 `totalTokens` 换成 `surfaceTokens` 后，长会话仍然显示 `2136K/64K`（3339%）——因为 **surfaceTokens 本身就是整个 session surface**：压缩发生在模型代理层，session 里仍保留全部历史节点，128K 窗口的模型不可能真收到 2.1M。

### 修正
- `dsh-compat.js:measureLevel1Context` 不再调 `tokenMeter.measure()`（那是 O(整个会话) 重放），改为估算**最近 40 个 surface 事件**的 token：`snapshotEvents(seq-40)` + `deriveEventMessage` + `estimateMessage`。这就是模型此刻大致收到的量级。
- 副作用：GUI 轮询不再触发会话日志重放，L1 读数是 O(40) 而不是 O(2.1M)。
- 测试断言随之调整（`level1 read uses the tail-window estimate`）。

### 说明
- L2 行仍用 `surfaceTokens`（`measureAgentTokens`）——L2 是短会话子代理，surface 接近真实上下文。
- 若某个 L2 跑得极久，读数同样会偏大；届时按同一思路给 L2 换 tail 估算。

## v101c — 1.10.2（L1/L2 上下文读数修正）

看板左栏 L1 显示 `2107K/64K`（3290%）——根因是**取错字段**：`tokenMeter.measure()` 的 `totalTokens` 是整段会话日志累计（含被替换的历史节点），`surfaceTokens` 才是模型此刻真正收到的上下文；原有代码两处都取了 `totalTokens`。

### 修正
- `dsh-compat.js:measureLevel1Context`：优先 `surfaceTokens`，`totalTokens` 仅兜底；新增返回 `logTokens`（累计值，供诊断）。
- `board-route.js:measureAgentTokens`：同样改为 `surfaceTokens ?? totalTokens`（L2 行真实读数）。
- 效果：进度条对比的是「模型当前上下文 vs 模型窗口」，而不是会话历史总量。

### 工具链
- `dev/release.mjs` 支持带字母后缀的 tag（`v101b`/`v101c`）：快照目录 `dsh-pipeline-v101c`、CHANGELOG 锚点 `## v101c`；`--verify` 的模式串同步放宽。

## v101b — 1.10.1（效率与健壮性审计）

第二轮全插件审计（性能 / 效率 / 健壮性），全部有测试兜底（7 套 0 failed）。

### 性能（热点路径）
- **L1 tokenMeter 缓存**：GUI 每 2.5s 轮询 `/pipeline/board`，`tokenMeter.measure()` 会重放整段会话日志 —— 现按 session 缓存 1.5s。
- **L2 token 缓存**：`measureAgentTokens` 同样按 session 缓存 1.5s（只缓存成功值，失败下次重试）。
- **知识库文件缓存**：`pipeline_recall` 每次读 20+ 个知识文件，现按 `size:mtime` 缓存文本，重新扫描后自动失效。

### 正确性 / 精简
- `tuneSweetSpot` 的 L1/L2 分支逐行重复（88 行）→ 表驱动 `TUNE_TARGETS`：config.js 388→301 行（−87），行为由 v82 测试 5a/5a2/5g 锁定。
- 删除死导出 `readDecisionLedger`（0 调用）与随之无用的 `readFileSync` 导入。
- `pipeline_status` 的 `recentMessages`：20 条全文 → 10 条、每条截断 160 字符（省 token 且仍能看出刚发生了什么）。

### 健壮性
- 看板路由注册失败不再静默：`console.warn` 落到宿主日志（对应用户遇到过的 404 症状）。
- `BUILD_TAG` → `v101b`：`/pipeline/board` 的 `debug.build` 可直接确认线上版本。

### 数据
- 代码 16 个模块 214,111 字符 / 4,543 行；7 套测试全绿：75 / 49 / ALL PASS / ALL PASS / 15 / 27 / skill_sync。

## v101 — 1.10.0（审计 + 精壮化第一轮）

- **未用导入清零**：plugin.js 35 个死导入全删（node:fs 6→2、node:path 3→1、删 crypto/child_process/gates/util 整行），l1.js / l2l3.js 再各清 3 / 2 个；两文件合计 −116 行。
- **重复逻辑合一**：`numCfg`（8 处配置解析 → 1 个 helper）、`makeSubtask`（2 处）、`failedNames`（3 处）、`requireSubagents`（3 处）。
- **输出省 token**：15 处工具 `render` 统一紧凑 JSON（`jsonOutput()`），verify-v82 增加契约断言。
- **提示词再压缩**：buildProtocolText 1472→1252 字符、buildL2LeadPrompt 3941→3535 字符。
- 删除过期注释块（plugin.js 两段、l2l3.js 冗余注释）；7 套测试全绿。

## v99：知识层加固 + 泛化 + 发布自动化（P1/P2/P3）

- **P1-① 秘密文件不入库**：扫到 `.env` / `*.secret` / `*.key` / `*.pem` / `id_rsa` 一类文件时**只记路径与大小、绝不读内容**（`scan.js` 的 `SECRET_NAME`）；万一源码里硬编码了 key，抽样文本会先过 `redact()`（`sk-…` / `AKIA…` / `ghp_…` / `password=` 一律替换成 `[redacted]`），保证 `index.md`、`map.json`、模块页永不落密钥。
- **P1-② 陈旧检测**：`scanRepo` 额外写 `hashes.json`（每个代码文件 sha1）；新增 `checkStale()` 与 `pipeline_scan({ check: true })`，比较磁盘与快照，返回 `changed / added / removed / modules`，一条命令回答「知识库过期了吗、哪几页要重生成」。
- **P1-③ 台账分诊**：`pipeline_ledger` 不再把所有候选堆在一起，而是机械分成 **KEEP / REVIEW / DROP**（有指针+有理由或失效条件 → keep；证据不全 → review；只有一句结论或纯教训 → drop）。`ledger-candidates.md` 开头先给 KEEP 表，模型只需处理有价值的条目。
- **P2 泛化**：代码扩展名从 8 种扩到 20+（go / rust / java / kotlin / cs / ruby / php / swift / lua / c / cpp / dart …）；模块分组不再写死 Python/Vue 结构，改为通用约定（`cmd` `internal` `pkg` `src/main/java` `apps/<x>/src` 自动成组），`MODULE_HINTS` 补 Go/Rust/Java/Node 常见目录语义，material 目录支持中英文模式回退。
- **P3 发布自动化**：新增 `dev/release.mjs`——`node dev/release.mjs v99` 一条命令完成：CHANGELOG 版本条目门禁 → 源码 version 校验 → **跑全部 smoke 测试**（任一失败即中止）→ 复制新快照 → 写版本 → 全量 sha256 比对 → 打印剩余两条必须人工的 GUI 步骤。`node dev/release.mjs --verify` 只做快照一致性核对。原因是 v96→v98 我三次把「计划」当「事实」报了「已部署」。
- **测试**：新增 `v99_knowledge_hardening_smoke.mjs`（27 断言：Go/Java 布局分组、`.env`/`secret.key` 不读不泄漏、`hashes.json` 内容、checkStale 的 changed/added/removed、ledger 三级分诊）。
- *Made by merhentz.*
## v98：知识层（Knowledge base）——让 L1 不靠暴力读源码理解项目

- **三个新工具**：
  - `pipeline_scan` —— 扫仓库生成 `.dsh/knowledge/`（`index.md` 一页骨架 + `map.json` 符号表 + `modules/*.md` 每模块一页 + 模块总览），跳过 `.git/node_modules/dist/` 与二进制/超大文件，记录每个代码文件 sha1 前缀、git head/近期提交、启动命令（HOW TO RUN）、超大文件与 TODO 信号。
  - `pipeline_ledger` —— 抽取 `dev/project_checkpoint.md` 的「关键决策」编号项与「结论/结案」强结论，产出 `ledger-candidates.md` + `ledger.json`，每条标出缺失字段（rationale / invalidation / reversibility / pointer）。
  - `pipeline_recall` —— 在知识库内检索关键词（中文按 bigram、英文按词），返回 `file:line` 与代码片段；命中不到就明说没有，不编。
- **`/pipe-research` 命令**：输出 7 步研讨模板（立项 → 证据 → 候选 → 反方 → 实验 → 建议 → 记录），带 3 条防呆（不许只写"因为更好"、≥3 条带指针证据、必须回答"错了会怎么暴露"）。
- **协议与 SKILL**：`buildProtocolText` 增加 KNOWLEDGE 一行；SKILL Phase 0 增加知识层用法（先 recall/scan 再读源码，禁止为理解项目而暴力读全仓）。
- **实测（stock 真实仓库）**：1522 文件 / 产品代码 42.5K 行 → `index.md` 4.8K 字符（≈1.6K token）+ 22 个模块页（平均 750 字符/页）。冷启动 = index + 2~3 页 ≈ 2.5K token，替代原先 checkpoint 94.5KB + architecture 118.8KB + PROGRESS 302KB 的暴力读取。
- **测试**：新增 `v98_knowledge_smoke.mjs`（15 断言：扫描/索引/符号表/模块页/依赖/台账/检索/中文/无假命中）；`verify-v82` 与 `v90_tool_factory_probe` 的模块复制列表补 knowledge 模块，工具/命令计数断言更新为 19/7。
- *Made by merhentz.*

## v97：看板三区色（甜点区 / 过渡区 / 危险区）+ 危险线

- **表达目标改变**：不再要求模型"待在甜点区"，而是明确「**不能让模型跑在能力大幅打折的上下文里**」。看板三层进度条改为固定三区：
  - 绿区 = 0 → 甜点上限（`levelNContextBudget`）
  - 橙区 = 甜点上限 → 危险线（`levelNDangerBudget`，默认 `contextWindow × dangerRatio`，0.75–0.9 视模型档案）
  - 红区 = 危险线 → 模型窗口（`levelNContextWindow`）
- **三区颜色是固定的**，不随当前值变化（只有白色指针在移动），区界有竖线；指针进入橙区/红区时数值文字变色。
- 删掉「甜点区 XX/YY」这类会误导的字样（工具内返回仍保留甜点区语义）；+增加 `levelNContextWindow` / `levelNDangerBudget` 配置项，换模型时 `tuneSweetSpot` 自动重算。
- **测试**：`verify-v82` 危险线联动断言（5a/5a2）、`v92_board_smoke` 三区/指针断言，全绿。
- *Made by merhentz.*
## v96：模块数推荐（大项目不得压成 1–2 个 L2）

- **SKILL 新增 MODULE COUNT GUIDE**：单文件/脚本/小修 → 1 个 L2（快路径，不浪费钱）；3–8 个文件或 1–3 个关注点 → 2–3 个；多子系统/有依赖 DAG/≥10 文件 → 4–8 个（硬上限 `maxLevel2Agents = 10`）。并明确：按「真正独立的关注点」计数而不是按文件；**≥3 个独立关注点必须 ≥3 个 L2，禁止把大项目压成 1–2 个**。
- **`pipeline_plan` 增加软提醒 `planHint`**（不阻断）：任务 ≥3 但只规划了 1 个模块，或需求文本 ≥600 字却只规划了 ≤2 个模块时，返回里追加一句「MODULE COUNT: ...」，提示按关注点拆更多 L2。
- **`pipeline_spawn_module_lead` 增加软提醒 `spawnHint`**（不阻断）：计划里还有 ≥2 个模块没派过 L2 时，返回里列出这些模块名，提示先把它们 spawn 出来再继续给单个 L2 派活。
- 全部为软引导，小任务不受影响（单文件仍然只开 1 个 L2）。
- **看板 L1 甜点区改为实时**（v96a）：此前 L1 token 只在调用 `pipeline_*` 工具时测一次，看板轮询期间数字不动；现在 `GET /pipeline/board` 每次请求都用 tokenMeter 实测当前会话（零 token 消耗），卡片进度条随对话实时增长。
- **测试**：`v92_board_smoke` 增 6 条断言（planHint / spawnHint / MODULE COUNT GUIDE / ≥3 规则 / 快路径），5 套回归全绿。
- *Made by merhentz.*
## v95：L1 模型表述修正 / L2 命名规则 / 提示词低损压缩（省 token）

- **L1 不再被描述成「必须是 pro」**：L1 实际就是用户在界面上选给当前会话的模型，pro 只是其中一个选择。`buildProtocolText` 改为 "L1 = the model the user picked for this chat"，SKILL Phase 0 改为 "L1 = the model you picked for this chat"，宿主侧新增 `resolveSessionModel(ctx, source)`——从会话 `header.model` 读出真实模型名写进 `store.context.level1Model`，看板 `context.models.level1` 改为读它（此前读静态配置默认值，用户换模型后看板仍显示 deepseek-pro）。README / design doc / package.json 的 "L1 (pro)" 表述一并修正。
- **L2 命名规则（写进 SKILL 与工具描述）**：kebab-case、1–3 个词、一眼看出「交付什么/干什么」（cli-core / cli-tests / api-auth / db-schema / ui-cart），禁止泛化词（helper、utils、misc、task1、part-a）、禁止中文与空格、单 run 内唯一；同一名字同时用作 `pipeline_plan` 的 assignee 与 spawn 的 `label`。
- **提示词低损压缩（保证语义，省常驻 token）**：`SKILL.md`/`SKILL_BODY` 16 099 → 10 242 字符（−36%，约 −1 630 tok/次技能加载）；`buildProtocolText` 1 855 → 1 559（−16%，每次请求都省）；`buildL2LeadPrompt` 4 849 → 3 941（−19%，每次 spawn 都省）；16 个工具 description 合计再压约 10%。压缩方式：合并重复规则（里程碑验收在 Phase 3/4 重复）、删除比喻与冗余修饰、短句化、工具名与参数语义一字不删。`skill_sync_check` 仍校验 SKILL.md 与 SKILL_BODY 字节一致。
- **测试**：`verify-v82 73` / `v89_control 49` / `v92_board_smoke` / `v90_tool_factory_probe` / `skill_sync_check` 全绿。
- *Made by merhentz.*

## v94：流水线看板卡（侧栏内嵌）+ 每 L2 独立模型

- **侧栏看板卡**：client 部件只保留一个座位（`sidebar.footer.action`，id `pipeline-board`，order 9 排最右），渲染一张与 cost-meter 余额卡同款的小卡：状态行（🔧 流水线 + 状态 pill + 里程碑 n/m）、`模型 L1 xxx · L2 默认 xxx`、每个**活跃 L2 一行**（名字 + 覆盖模型短名 + 已用/甜点区 + 迷你进度条 + 百分比）、`L3 n/total`、`run token/预算 + 主进度条`。L1/L2 甜点区颜色：<80% 绿、80–100% 黄、≥100% 红。无 run 时退化为一行浅灰「流水线待命」；侧栏收成 56px rail 时退化为图标。卡片 `width:100%` 随侧栏自适应，字号/颜色/圆角/边框对齐主题 token 与 cost-meter 卡片。此前 composer 下方状态条与右侧悬浮卡已删除（合并为一个座位）。
- **甜点区可见性**：`/pipeline/board` 新增 `context` 段（`models`、`level1 {tokens,budget}`、`level2 {tokens,budget}`）与 `agents[].model`；L1 token 数由工具包装层每次调用 `measureLevel1Context` 写入 store。
- **每 L2 独立模型**：`pipeline_spawn_module_lead` 新增可选 `provider` / `model`——同一流水线里可以让某个模块跑更强的模型（如 `deepseek-pro`），其余仍走 `level2Provider/level2Model`；选择随 agent 记录保存并在看板显示。SKILL.md / SKILL_BODY 同步。
- **测试**：`v92_board_smoke` 增 4 条断言（per-lead provider/model 传给 subagents、agent 记录保留、未覆盖保持默认、snapshot 暴露 model）；全量 `verify-v82 73` / `v89_control 49` / `v90_tool_factory_probe` / `skill_sync_check` 全绿。

## v93：工作区状态隔离（真修）/ 磁盘文件验收 / 冷启动恢复补全

- **state 真正落到工作区（v83 遗留）**：`runtimeStateDir(root)` 改为接受工作区根；`store` 增 `stateDir` 字段，`board.json` / `run.json` / `trace-*.jsonl` / `requirement_lock.json` / L3 执行暂存全部经 `store.stateDir` 解析；新增 `setStateDir()`（幂等重定位 + 落盘）与 `alignTo(ctx, source)`（从 `resolveWorkspaceRoot` 拿 `session.header.cwd`，拿不到才回退 `process.cwd()`）。`apply()` 启动时 `setImmediate` 对齐一次，**每个工具 execute 前再对齐一次**——同一 daemon 服务多工作区时不再串房间（此前 state 全写进 profile 目录 `~/.dsh/profiles/desktop/.dsh/pipeline/`）。`requirement_lock.json` 跨重定位自动迁移。
- **review 支持读磁盘真实文件**：`pipeline_review` 的 `taskId` 分支新增 `filePath`（相对或绝对）——从磁盘读代码参与质量门，而不是只看 L2 回填看板的片段。`gates.gateTask(task, subtaskRecords, cfg, fileCode)` 新增第 4 参：磁盘文件优先，有文件时不再因「看板无代码」误判阻塞；同时仍把未回填状态的子任务置 done 并记录代码，看板与真相一致。
- **冷启动恢复补全**：此前重载后 `locked` / `requirement` 丢成 false/null（board.json 早于 run 落盘时为空）。现在若 `board.json` 缺失这两字段，自动从 `requirement_lock.json`（durable record）恢复；`setStateDir` 迁移时同步补全。
- **修复 v90 拆分遗留的派发器 P0**：`tools/l2l3.js` 缺 `LEVEL2_NAMES` 导入，`pipeline_execute_batch` / `pipeline_execute_local` / `pipeline_spawn_local_executor` 全在 L2 手里直接 `ReferenceError`（本次实跑 todo-cli 时暴露）。
- **L3 引擎换 strata-local**：模型档案表补 `qwen3.8-flash-next-iq3_xxs`（131072 ctx）；全局配置改用 `http://127.0.0.1:8080/v1`（`level3Engine:'auto'` 自动探测）。`level3NumCtx` / `level3MaxTokens` 旧键在运行配置里清掉，`level1ContextBudget` 从手改的 12345 恢复正常 64000。
- **测试与验收闭环实测**：11 个模块 `node --check` 全过，四个回归集（73 + 49 + 34 + 16 工厂）全绿；以 todo-cli 真跑一条完整流水线：lock → plan(m1) → spawn L2 → L2 写文件 → review(filePath) → ask_user_question → accept_milestone 全链路走通。
- *Made by merhentz.*

## v92：GUI 看板 + 每个 L2 独立工作目录（可视化与物理隔离）

- **GUI 看板（看得见）**：新增 host 只读路由 `GET /pipeline/board`（`lib/board-route.js`，返回 run 状态 / 里程碑 / 任务 / L2 列表 / 预算 / 计数 / 最近事件快照）与 client 部件 `client.js`（经 `dsh.client` 声明注入 Web UI，插在 `conversation.input.dock` 输入框上方）。状态条一行显示：`🔧流水线` + 状态 pill（运行中/已暂停/空闲）+ 里程碑 m/n 进度 + token 预算 + 在跑 L2 数 + `⚠️ 待验收` + 最近一条事件；2.5s 轮询，页面隐藏时暂停，无 run 时不渲染。全部使用主题变量 `--dsw-alias-*`，明暗主题自动适配。这是模型看不到的视角——用户随时知道「它还在不在干活、有没有卡住、钱花到哪了」。
- **每个 L2 独立工作目录（物理隔离）**：`pipeline_spawn_module_lead` 新增 `scopeDir` 参数（相对工作区路径；缺省 `.dsh/pipeline/work/<name>`，name 做文件名净化）。插件创建该目录、把它作为 subagent 的**真实 `cwd`**（`request.cwd`）传给 `subagents.startActivation`，并在 L2 prompt 注入 `WORK DIRECTORY (v92)` 段——L2 用相对路径写文件时天然落在自己的目录里，多个 lead 不再互相踩文件。agents 记录 `scopeDir`，看板与 `pipeline_status` 可见。
- **修复 v90 拆分遗留的潜伏 P0**：`lib/tools/l1.js` 顶部原先没导入 `randomUUID` / `readFileSync` / `resolve` / `dirname` / `ensureDir`（`pipeline_lock_requirements` / `pipeline_checkpoint` / `pipeline_spawn_module_lead` 真跑会 `ReferenceError`），`lib/tools/l2l3.js` 缺 `resolve`；测试全集未覆盖这些执行分支所以一直没暴露，本版补齐。
- **包结构**：`package.json` 1.2.0，新增 `./client` 导出、`files` 收录 `client.js`、`dsh.client` 段（`platform:'web'`、`immediately:true`、`inject:['@deepseek-ai/dsh-client-ui-conversation']`）。
- **测试**：新增 `dev/smoke/v92_board_smoke.mjs`（29 断言：快照结构 / 路由注册与 handler / cwd 隔离与默认目录 / client 与 package 接线），三个旧烟测的模块复制列表补 `board-route.js`。
- *Made by merhentz.*

## v91：市场层（README 市场化 / QUICKSTART / examples / 语义化版本）

- **README 重写为市场语气**：第一屏回答「我是什么 / 解决什么 / 凭什么信我」，三十秒能判断要不要用；技术细节下沉分层（快速开始 → 工作原理 → 配置 → 参考）。核心叙事从「功能列表」改为「省钱 + 不失控 + 能长期陪伴」。
- **新增 `QUICKSTART.md`**：3 分钟上手——装插件、配 L3 引擎、说第一句话、看到第一个里程碑。新手只看这一个文件就能跑通。
- **新增 `examples/`**：`examples/todo-app/`（一句话需求 → 一条产线跑完的小项目模板）、`examples/api-server/`（多模块并行 + 里程碑验收示例），每个例子只含 `README.md` + 直接可粘贴给 DSH 的一句话需求。
- **CHANGELOG 整理**：v88 条目从 v85 之后移回 v89 之后（版本倒序恢复正常）；补 v91 条目。
- **语义化版本**：`package.json` 版本号改为遵循 semver（`1.1.0`），与内部迭代代号 `vN` 的关系在 README「版本」一节说明——`vN` 是开发迭代号（部署目录后缀），`x.y.z` 是包版本（市场/发布用）。
- *Made by merhentz.*

## v90：模块化重构 + 全量改名（dsh-pipeline / /pipe-* / pipeline_*）

- **全量改名**：包名 `merhentz-tiered-orchestrator` → `dsh-pipeline`；插件名 `tiered-orchestrator` → `pipeline`；16 个工具 `tiered_*` → `pipeline_*`；6 个命令 `/tiered-*` → `/pipe-*`（config/tokens/stop/resume/off/selftest）；系统提示段 `tiered:protocol` → `pipeline:protocol`；技能目录 `skills/pipeline-orchestration/`；状态目录 `<workspace>/.dsh/pipeline/`、全局配置 `~/.dsh/pipeline/config.json`、项目级配置 `pipeline-project.json`。旧命令不保留兼容别名（精壮）。
- **拆文件（2224 行 → 10 个模块，入口 230 行）**：`lib/plugin.js` 只做装配；`config.js`（模型档案/配置键/分层合并/迁移/`/pipe-config`）、`store.js`（看板 + run 状态机 + 预算 + 激活，全落盘）、`gates.js`（执行断言/DoD/语义评分/任务校验）、`prompts.js`（三级协议/L2 提示/L3 提示/SKILL_BODY 单一源）、`util.js`（文本/token 估算/压缩/语义评分）、`dsh-compat.js`（session/tokenMeter/引擎探测）、`guards.js`（严格相邻/硬 Gate/预算护栏）、`tools/l1.js` + `tools/l2l3.js`（工具工厂按层拆分）。
- **删死代码/死配置**：`level3NumCtx`（从未传给引擎，纯装饰）删除，换 `level3Model` 不再联动无意义的「上下文窗口」；`level3MaxTokens` 语义拆分为 `level3InputBudget`(500，输入上限) + `level3MaxOutputTokens`(4096，输出上限，此前硬编码)；旧配置自动迁移（`level3MaxTokens` → `level3InputBudget`，`level3NumCtx` 丢弃）。
- **SKILL 单一源**：技能正文从 `plugin.js` 迁到 `prompts.js`（`SKILL_BODY`），`dev/smoke/skill_sync_check.mjs` 校验与 `SKILL.md` 字节一致。
- **测试收口**：`pnpm test`（在 `plugin/` 下）一键跑 4 组回归——`verify-v82.mjs`（73 断言）、`v89_control_smoke.mjs`（49 断言）、`v90_tool_factory_probe.mjs`（16 个工具工厂装配 + apply 注册 16 工具 6 命令）、`skill_sync_check.mjs`；旧一次性烟测归档到 `dev/smoke/_archive/`。
- **文档**：README/TUTORIAL 全量同步新名字与新目录结构；CHANGELOG 补上 v85–v87 缺条。
- *Made by merhentz.*

## v89：控制面（激活 Gate / 预算护栏 / 里程碑状态机 / 自检 / 引擎泛化打底）

- **一次性激活 Gate**：新工作区首次使用前，L1 先用 `ask_user_question` 问用户一次（A 启用 / B 普通 / C 记住工作区），答案写进工作区 `activation.json`（`runtimeStateDir()` 下），之后同工作区不再询问；`pipeline_lock_requirements` 新增 `activation` 参数（enable|normal|remember），未记录选择前返回 `activationHint`。
- **预算护栏**：新增 `maxTotalTokensPerRun`(500000) / `maxDurationPerRun`(7200000ms) / `maxFilesPerRun`(200) 三个上限（0=不限）。每次 L2 派发 / L3 执行累加用量（`addRunUsage`），触顶自动暂停 run 并记录原因；`tools.guard` 对执行类工具（spawn/send/decompose/execute_local/execute_batch/spawn_local_executor）返回拒绝原因；`run footer` 在每个 L1 工具结果尾部显示暂停原因。
- **run 状态机**：`store.run = { id, status, startedAt, milestones, tokensUsed, filesTouched, scope, activation, paused, pauseReason }`，持久化到 `run.json`；冷启动自动恢复 `status=active` 的 run，并从 `board.json` 反查重建 tasks/subtasks/agents（文件是真相）。
- **里程碑状态机**：`pipeline_plan` 新增 `milestones: [{ id, name, taskIds[] }]`；`milestoneStates` 从任务状态实时计算 done/accepted（不重复存状态，避免漂移）；新工具 `pipeline_accept_milestone`（要求全部任务 done 后置 accepted + note，最后一个验收完成时提示 checkpoint）。硬 Gate：有「已完成未验收」里程碑时，`pipeline_spawn_module_lead` / `pipeline_send_to_lead` 被拒绝；所有 L1 工具结果尾部追加 run footer（暂停/里程碑进度/未验收提醒），模型无法静默跳过验收。
- **新命令**：`/pipe-stop`（冻结 run，文件保留）、`/pipe-resume`（恢复）、`/pipe-selftest`（健康检查）；`/pipe-off` 复用配置命令改 mode。
- **自检**：新工具 `pipeline_selftest` 检查 subagents API（startActivation/drainChildren）、llm 服务、L3 引擎 `/v1/models` 探测与模型列表比对；`apply()` 启动时非阻塞 ping 一次 L3 引擎，失败只警告不阻塞。
- **错误翻译**：subagents 不可用等错误统一翻译为中文行动提示（提示跑 `/pipe-selftest`）。
- **引擎泛化打底**：新增 `level3Engine`(enum: auto|ollama|vllm|llamacpp|openai-compat|other) 配置键；L3 统一走 OpenAI 兼容 `<level3Endpoint>/chat/completions`（任意兼容引擎可接），不可用时既有失败阶梯回退 L2。
- **P0 修复**：`executeAcceptance` 并发隔离（每次调用独立 `exec/<uuid>/` 目录 + 结束清理，不再互相覆盖）——注意它仍用 Python 执行断言，JS/TS 项目会 `ran:false` 回落语义分；`pipeline_execute_batch` 子任务 id 冲突自动加 `-2/-3` 后缀（不再复用旧记录）；`pipeline_spawn_module_lead` 检查 `maxLevel2Agents` 上限；启动时重载 `board.json`。
- **测试**：`dev/smoke/v89_control_smoke.mjs`（49 断言：配置/状态机/里程碑/预算/冷启动恢复/断言隔离）+ `dev/smoke/verify-v82.mjs` 73 断言回归全绿；`dev/smoke/skill_sync_check.mjs` 校验 SKILL.md 与 SKILL_BODY 字节一致。

## v88：批量 L3 执行 `pipeline_execute_batch` + 瘦身 + 文档

- **新增 `pipeline_execute_batch`**：L2 一次提交 N 个 L3 子任务（`tasks: [{ id?, desc, acceptance }]`，可选 `maxBatchMs`），工具内部**串行**执行并一次返回 `{ total, done, failed, remaining, results[] }`。L2 只推理 1 次而不是 N 次，省推理 token；已有单任务工具 `pipeline_execute_local` 保留。
- **单任务内核复用**：把 `pipeline_execute_local.execute` 的核心抽成 `executeOneL3Task(subtask, cfg, r, exec)`，`pipeline_execute_local` 改为「校验 subtask → 调内核 → 返回」，行为与原实现完全一致；batch 与单任务走同一条路径（token 预算 → L1 压缩 → ninfer OpenAI 协议 → JSON 解析 → 失败计数/升级）。
- **每任务独立超时**：batch 内每个任务仍由内核各自的 `level3TimeoutMs`（默认 15 分钟）看门狗约束，**绝不设 batch 整体超时**；`maxBatchMs`（默认 0=不限）只是软护栏——到点只「停止派发新任务」，绝不 abort 已在跑的任务，未派发的计入 `remaining`。
- **失败不连锁**：单任务失败/超时/cannot-do/抛异常只记入该任务结果（`failed` / `retryable` 等），循环继续下一个任务；汇总返回 `done` / `failed` / `remaining`。
- **守卫不变**：`pipeline_execute_batch` 与 `pipeline_execute_local` 同属 L2/L3 工具，L1 直接调用仍被 `tools.guard` 拦截（严格相邻规则原样保留）。
- **瘦身**：删除 `dev/smoke` 下 7 个临时诊断文件（`read-asar.cjs` / `extract-asar.cjs` / `search-asar.cjs` / `client-ui-session.client.js` / `client-ui-chat.client.js` / `timeout-policy.zh.md` / `timeout-policy.js`）。`plugin/lib/plugin.js` 删除未使用的 `fsp` 导入（v84 删 Ollama 后的残留）并修正一处过期注释；其余函数/常量均有引用，保守未动。
- **文档**：`SKILL.md` 与 `plugin.js` `SKILL_BODY`（字节一致）在 L2 下放规则处新增「L2 有多个 L3 子任务时优先用 pipeline_execute_batch 一次提交（内部串行、省推理 token），而不是 N 次 pipeline_execute_local」；README / TUTORIAL 工具表与用法、design doc §16、本 CHANGELOG 同步。`package.json` / `cordis.patch.yml` 的 `-v87` 标识由部署方发版时统一改。

## v87：L2 上限提到 10

- `maxLevel2Agents` 默认 5→10，`LEVEL2_NAMES` 扩到 10 个（level2_module_a~j），SKILL/README/TUTORIAL/design doc 中的数量同步更新；实测 `pipeline_plan` 接受 10 个 L2。
- （注：v89 起 L2 名字改为自由命名，`LEVEL2_NAMES` 仅作观测常量。）

## v86：L2 自由命名

- `pipeline_plan` 的 `assignee` 校验从「必须是 LEVEL2_NAMES 之一」改为「任意非空字符串」；技能明确「按职责自由命名（backend / frontend / database…），名字是语义标签而非固定槽位」。

## v85：L2 上限修复

- 根因：`maxLevel2Agents` 默认 5，但 `LEVEL2_NAMES` 只有 2 个（level2_module_a/b），导致能标记的模块只有 2 个；扩到 5 个（a~e）。实测 `pipeline_plan` 接受 5 个 assignee。

## v84：适配 DSH 新版 subagents/llm API + L3 迁移到 ninfer（OpenAI 协议）

- **subagents API 适配**：`startContinuable` 已删除（v83 报「subagents service is unavailable」的根因），改用 `subs.startActivation({ provider, label, request, signal, delivery })`；`drainContinuableChildren` 改名 `drainChildren`；L3 agent 路径的 `subs.start` 同样迁移到 `startActivation`。下游统一取 `activation.childId` / `activation.messageId`。
- **toolFilter 替代（严格相邻）**：新版 `SubagentStartRequest` 不再有 `toolFilter`，且子代理默认可见父级工具，因此改由 `tools.guard` 强制——只有根 agent（L1）可调用 L1 专属工具（lock / plan / status / classify / spawn / send / drain / checkpoint / decompose + `ask_user_question` / `present`），L2/L3 调用一律拒绝（按已登记 lead/executor 与 `agents.roots()` 双重判定）。
- **L3 轻量路径改 OpenAI 协议**：`pipeline_execute_local` 从 Ollama `/api/generate` 改为 `POST <level3Endpoint>/chat/completions`（body: model / messages / max_tokens / temperature，解析 `choices[0].message.content`，usage 取 `prompt_tokens` / `completion_tokens`）；保留 15 分钟看门狗、cannot-do、重试/升级链。
- **L3 agent 路径迁 ninfer**：provider 从插件自注册的 `ollama` 改为 profile 自带的 `ninfer-local`；删除插件内 Ollama LLM adapter 与 `ollama stop`（`llm` 服务仍保留，用于 L2 分解回退路径）。
- **默认值**：`level3Endpoint=http://127.0.0.1:18200/v1`、`level3Model=qwen3.8-27b-gsq-rco-iq3-s-mtp`、`maxLevel3Concurrency=1`；`MODEL_PROFILES` 增加该模型（L3，204800 上下文 / numCtx）。
- **旧配置迁移**：v83 持久化的全局 config.json 仍固定 Ollama 路由（优先级高于新默认值），加载时若检测到「精确旧默认值」（`qwen3:14b` + `localhost:11434/api/generate`）则在内存中改写为 ninfer；用户自定义值不动，且不改写用户的配置文件。
- **文档同步**：README / TUTORIAL / design doc / SKILL（`SKILL.md` 与 `plugin.js` `SKILL_BODY` 字节一致）补 v84 说明。`package.json` / `cordis.patch.yml` 的 `-v83` 标识由部署方发版时统一改。

## 早期（v1–v42）

三级编排骨架从零搭建：`pipeline_*` 工具面（锁定/规划/分解/执行/审核/状态）、`/pipe-config` 命令、Ollama 注册为 DSH provider、二级长活 continuable subagent、严格相邻（工具守卫）、质量门（JSON + 语义分）、逐任务验收标准、失败上限 + 升级阶梯、能力匹配分类器。期间反复修正：`deepseek-v4.1-flash` 不存在改用 `deepseek-flash`、subagent provider 必须是 `spawn`、L3 轻量工具路径替代重 agent 路径等。

## v43–v47：下放规则与 L3 能力

- **v43** L2→L3 下放硬规则（纯函数必须下放，L2 不许自己写）。
- **v44** 明确下放标准（单函数 ≤10 行 ≤200 token + 可验收）。
- **v45** 放宽 L3 天花板（≤30 行 ≤500 token）+ `cannot-do` 反馈（L3 干不了明确回报）。
- **v46** L3 交付完整文件（≤100 行）+ 输出错了也允许重试（门不过→pending 可重试）。
- **v47** 禁止 L1 轮询看板 + 系统提示词压缩。

## v48–v52：省 token 与纪律

- **v48** 锁死 L2 轮询（deny `pipeline_status` 等 L1 工具）。
- **v49** 技能自动触发（放宽 `whenToUse`，任何开发任务都走四阶段）。
- **v50** 严格接管：L1 只在 L2 明确上报「干不了」时才接手，慢≠干不了。
- **v51** `maxLevel2Retries=3`（L2 接管失败 3 次→上报）+ L1「派完就停、等 push」。
- **v52** 整体去重（接管/禁轮询/严格相邻不再在三处各写一遍）。

## v53–v55：生产级强化

- **v53** 质量门「跑代码断言」（验收里的 `函数(参数)==期望` 真跑 Python 验证，关键词分降级为兜底）。
- **v54** L2 自压缩 + 成本分账（分层 token 计数）+ 文件真相评审（`filePath` 参数）。
- **v55** 抗阻塞：L1 收到汇报必须回复 + L2 汇报自包含（状态不丢）。

## v56–v62：配置精简与健壮性

- **v56** 删除无效配置键（`level2MaxTokens`/`level1MaxTokens`/`maxCalls`/`maxTokens`/`budgetMode`）+ 新增 `maxLevel2Agents=5`。
- **v57** 重置默认值（`level3Model` 对齐 `qwen3:14b`）。
- **v58** 需求访谈改用 `ask_user_question` 弹窗（选项/多选）。
- **v59** L2 数量明确「按职责拆、最多 5 个、别塌缩成 2」。
- **v60** 撤回系统提示词的 L2 数量行（省 token）。（v59 内容移入技能）
- **v61** L2 数量提示移入 `pipeline_spawn_module_lead` 工具描述。
- **v62** 防回退：技能钉死「必须用 `pipeline_spawn_module_lead`，不许静默回退 Agent Teams」。

## v63–v65：L3 死循环根治

- **v63** L3 超时看门狗：`level3TimeoutMs`（默认 15 分钟）+ `num_predict` 封顶 + `AbortController` 掐 fetch。
- **v64** 超时同时 `ollama stop` 杀掉**服务端**生成（此前只掐客户端 fetch，GPU 仍被占）。
- **v65** 关闭 `qwen3` 的 thinking 模式（`think:false`）——根因：推理模型的「思考」耗光 GPU 和 token，导致死循环/不输出。

## v66–v67：里程碑与长活治理

- **v66** 里程碑用户验收：L1 规划时设 2–3 个里程碑，到点弹窗问用户「我很满意 / 我要提出意见」。
- **v67** 里程碑按需重建 L2 + 文件交接：长项目在里程碑处重建 L2（`pipeline_spawn_module_lead` 新增 `resumeFrom` + `replacingChildId`），新 L2 读磁盘文件对账，旧 L2 `drain` 释放；短项目只 re-anchor。

## v68：token 阈值 + 项目级重建

- `level2ContextBudget: 32000`（DeepSeek Flash 甜点区，超限触发里程碑重建）。
- L2 上下文 token 估算跟踪：spawn 记初始 prompt、`pipeline_send_to_lead` 累加，`pipeline_status` 可看 `estimatedTokens`。
- 新增 `pipeline_drain_leads` 工具：一次 drain 一批旧 L2（杀旧与建新解耦，支持 2→3 / 2→1 / 3→3 任意数量变化）。
- 里程碑重建升级为「项目级交接 + 重新规划」（双层交接：小全局上下文 + scoped 模块索引；切片清单；先建新验可用再杀旧；交接验证）。

## v69：节点小型化 + 数量豁免 + 旧 L2 TTL

- **节点划分小型化**：L1 规划时激进拆分，让每个 L2 待在 32K 甜点区内。
- **新旧交替数量豁免**：重建窗口期新旧 L2 并存，总数可暂时超过 `maxLevel2Agents`（软约束 + 明文豁免）。
- **旧 L2 存活 TTL**：`level2HandoffTtlMs`（默认 5 分钟）；`replacingChildId` 改为「标记 replaced + 时间戳」而非立即 drain，`cleanupExpiredL2s` 懒清理超时未杀的旧 L2。

## v70–v73：L1 记忆治理（checkpoint / 冷启动）

- **v70** `level1ContextBudget`（L1 甜点区，默认 64K）+ `pipeline_checkpoint` 工具 + SKILL「L1 checkpoint / restart」流程。
- **v71** `pipeline_checkpoint` 生成 9 节交接契约（恢复指令/需求/全局上下文/已完成/进行中/待办/关键决策/遗留坑/活跃L2/恢复步骤），L1 填索引、工具填板面数据。
- **v72** 冷启动 prompt：工具返回 `coldStartPrompt`（5 部分），用户只需贴一小段即可冷启动续接，不必贴整个文档。
- **v73** 顺序澄清：里程碑验收在前、任务转移在后——「我很满意」之后才检查上下文、才提议 checkpoint 转移，绝不在验收前（或代替验收）提议转移。

## v75：意见触发的改造推迟到切换后

- 沿用 v73 顺序：里程碑验收门（「我很满意 / 我要提出意见」）仍在 L1 checkpoint 切换**之前**。
- 新增：用户「我要提出意见」触发的**改造工作默认推迟到切换之后**实施——意见本身在切换前收集（写进全局上下文/模块交接），改造任务写进 checkpoint 的待办/进行中，交给新会话按意见改；当前已变长的上下文不再做改造，除非用户明确要求切换前完成。
- 同步更新 SKILL（SKILL.md + plugin.js `SKILL_BODY`）与 design doc §13/§14。
- 措辞对齐：design doc §13 去掉「调整 + 重新锚定」的歧义表述，与 SKILL「收集在前、改造推迟在后」一致。
- 目录重组：可分发插件（`plugin/`）与开发/交接产物（`dev/`，含 project_checkpoint.md + smoke 脚本）分离，`plugin/` 可直接打包压缩分发。

## v76：生产文件与开发过程文档分离（固化进插件）

- 新增配置 `devDir`（默认 `dev`）：开发过程文档（checkpoint、L2 state、交接文件）统一写进该目录，与生产交付文件分离。
- `pipeline_checkpoint` 默认写到 `<devDir>/project_checkpoint.md`；L2 state / 交接文件路径改为 `<devDir>/team_board/*_state.md`；冷启动 prompt 同步指向。
- SKILL 新增 FILE SEPARATION 纪律；design doc §14 补「目录分离（生产 vs 过程文档）」说明。

## v77：里程碑「我很满意」后无条件交接 + 灭活 L2

- 「我很满意」后不再判断 L2 上下文是否逼近 `level2ContextBudget`——**无论是否超甜点区，一律交接 + 灭活旧 L2，后续任务重新生成 L2**。
- 交接机制（项目级交接 + `resumeFrom` + `replacingChildId` + `pipeline_drain_leads`）原样复用，不改动。
- `level2ContextBudget` 定位从「重建触发阈值」降级为「模块小型化参考」，仅改描述、保留配置键。
- 同步更新 SKILL（SKILL.md + plugin.js `SKILL_BODY`）、design doc §13（改为「强制重建」）、README。

## v78：规划平衡 + 全局治理 + L1 有界兜底

- **规划平衡**：拆解改为「天然接缝 + 一句话接口测试 + LPT 装箱到 ~75% 水位留余量」；里程碑重规划用上一轮实测（`pipeline_status`）校准拆分。
- **全局治理**：新增「架构宪法 + 接口契约」单一事实源（所有 L2 开工前必读必守）；里程碑验收前「组装门」审整体（接口一致/命名分层/DRY）。
- **分工边界**：集成代码=模块派给 L2，L1 只写接口契约；**L1 有界兜底**（cannot-do 或满 `maxLevel2Retries` 失败 → 最多重派 1 次 → 直写卡点，过门+留痕），替换「L1 永不写码」。
- **代码**：`pipeline_send_to_lead` 加负载护栏（`estimatedTokens ≥ 0.8×预算` 返回 warning，确定性零 LLM token）。
- **系统提示词**：`never code` → `code only as a bounded last-resort takeover`。

## v79：单 L2 快路径

- 新增「1 个 L2 快路径」：整块小 + 内聚 + 串行速度可接受时，用 1 个 L2，跳过均衡机制（装箱/注水/LPT），保留质量机制（宪法/组装门/兜底/里程碑重建）。
- 均衡块加 `(≥2 L2s)` 作用域前缀；「1 个 L2」触发条件纳入「串行速度」维度（不只「装得下」）。
- 宪法缩水：接口契约仅 ≥2 模块时；1 个模块时约定 + 分层即可。

## v81：L1 上下文 token 客观计量

- 挂钩 DSH `tokenMeter` 服务：`pipeline_status` 加 `level1Context` 字段（totalTokens / budget / ratio / warning，确定性、零 LLM token）。
- 新增 `/pipe-tokens` 命令：用户 / L1 一行查看 L1 上下文 token 用量 vs `level1ContextBudget`。
- 新增配置 `level1ContextWarnRatio`（默认 0.8）：ratio 达到即提示 checkpoint 交接。
- SKILL：L1「自评上下文」改为「读 `pipeline_status.level1Context` 客观值」。

## v82：甜点区模型自适应 + 项目级配置

- **甜点区跟随模型**：新增 `MODEL_PROFILES` 模型能力档案表（`contextWindow` + `sweetSpotRatio`，L3 用 `numCtx`）——甜点区不再是一组写死的绝对值，换模型自动跟随。
- **换模型联动**：`/pipe-config level1Model|level2Model|level3Model <id>` 时，若 `autoTuneSweetSpot`（默认 true）开启且档案命中，自动重算并写回：`level1ContextBudget` = 窗口 × `level1SweetSpotRatio`、`level2ContextBudget` = 窗口 × `level2SweetSpotRatio`、`level3NumCtx` = 档案 `numCtx`；返回文本追加说明（如「已联动更新 level2ContextBudget: 32000 → 64000」）。未命中档案则提示「该模型无档案，甜点区未联动，可手动 /pipe-config <甜点区键> <值> 覆盖」。
- **新增配置键**：`level1Model`（默认 `deepseek-pro`；仅用于甜点区档案查询，不切换实际 L1 模型）、`level1SweetSpotRatio`（0.5）、`level2SweetSpotRatio`（0.25）、`autoTuneSweetSpot`（true，boolean 类型，`coerceConfigValue` 支持 boolean）。
- **配置分层**：合并顺序 `DEFAULT_CONFIG` ← apply 传入 config ← 全局 `config.json` ← 项目级 `<devDir>/pipeline-project.json`（最高优先级）；不同 devDir 是不同项目，互不污染。
- **向后兼容（硬性）**：`level1ContextBudget` / `level2ContextBudget` / `level3NumCtx` 默认值与 v81 完全一致（64000 / 32000 / 16384）；不设任何新键时行为等同 v81——甜点区只在「换模型联动」或「用户手动设置」时被改写，手动值优先。
- **文档同步**：`SKILL.md` 与 `plugin.js` `SKILL_BODY`（字节一致）、README、design doc §11 配置分层说明。

## v83：state 按工作区隔离 + 交接文件路径绝对化（P0）

- **state 按工作区隔离**：新增运行时状态目录 `runtimeStateDir()` = `<process.cwd()>/.dsh/pipeline`；`board.json`、`requirement_lock.json`、`trace-*.jsonl` 与 L3 断言执行临时目录（`exec/`）从全局 `stateDir` 全部迁入。多项目并行时各自锁需求 / 规划 / 落盘，互不覆盖；同一工作区（同 cwd）冷启动读到同一份 board + requirement_lock。
- **config.json 仍全局唯一**：`~/.dsh/pipeline/config.json` 路径不变，v82 的「全局默认 + 项目级 `<devDir>/pipeline-project.json` 覆盖」逻辑与甜点区自适应一律不动。
- **交接文件路径绝对化**：`pipeline_checkpoint` 生成的 9 节文档（§8 活跃 L2 handoff、§9 恢复步骤）、`coldStartPrompt`、L2 spawn 提示词里的 `${devDir}/...` 全部改为 `resolve(join(...))` 绝对路径——新会话从别的 cwd 冷启动也能直接打开文件。
- **SKILL 补两条纪律**（`SKILL.md` 与 `plugin.js` `SKILL_BODY` 字节一致）：① L2 完成报告从 L1 会话消息流（subagent push 消息）收，不要从 `pipeline_status` 看板收——看板不记录 L2 报告；② 等 L2 push 期间若 goal 自动续轮唤起 L1，直接结束回合、不做任何事，绝不轮询 `pipeline_status` / 文件系统。
- **兼容性**：单工作区单会话行为与 v82 一致（只是状态落点从全局目录移到工作区目录，旧全局 board/trace 不再被读取）；`package.json` / `cordis.patch.yml` 的 `-v82` 标识由部署方发版时统一改。

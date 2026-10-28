# dsh-pipeline 最终修复计划（v1.12.0 / v103）

> 依据：2026-10-29 三路只读审查 + 独立验证（探针、实机路由、stock 会话日志）。
> 代码基线：工作区 `plugin/` 与安装副本 `~/.dsh/dsh-pipeline-v102` 逐字节一致（SHA256 全同）。
> 本文是执行契约，替代 `dev/review-2026-10-29.md` 里的批次草案；问题详情仍以该文档为准。

## 0. 目标与非目标

**目标**：让 README 里的“自动产线”承诺成立——质量门对 Node/TS 项目有效、工作区彼此隔离、三层角色有机械约束、秘密不落盘、文档与实跑一致。

**非目标**：不重写侧栏 UI；不引入第三方依赖；不改 L3 本地引擎协议；不动 `D:\Vctest\stock` 的数据；不追求 100% 覆盖所有 P2。

## 1. 基线（开工前实测）

| 项 | 值 |
|---|---|
| 版本 | 1.11.0 / BUILD_TAG v102 |
| 注册 | 19 tools / 7 commands / 1 系统提示段 |
| 代码量 | `plugin/lib` 15 个 js，4,305 行 |
| 测试 | 7 套 smoke 单跑全绿（75/49/probe/board/15/27/skill_sync）；`pnpm test` 只串 5 套 |
| 安装 | `desktop/package.json` 依赖 `link:C:/Users/Merhnztz/.dsh/dsh-pipeline-v102`（实体目录） |
| 部署 | 必须 `release.mjs` 复制 + 重启 daemon；ESM 缓存使 set_bundle 热重载无效 |
| 常驻 token | 协议 1595 字符 + 19 schema 8749 字符 ≈ 2586 token/步 |
| 会话日志 | `~/.dsh/sessions/<workspace>/<id>/session.v4.jsonl.zstd`，多帧 zstd |

## 2. 修复清单

### P0（不修则产品承诺不成立）

| ID | 问题 | 关键位置 | 修法 | 验收 |
|---|---|---|---|---|
| P0-1 | 质量门对 JS/TS 永久失效：断言只在 Python 里跑，任何异常 `{ran:false}` 后回退语义分；语义分只要代码里有 `{` 就给 0.6；阈值 0.7 是“断言通过率”（3/4 错也过）；`gateTask` 的 `jsonOk` 恒真且只跑语义分 | `gates.js:38,55-77,124-133,155`; `util.js:95-113` | 新增 JS/TS runner（Node 子进程执行 `new Function` 断言，超时+临时目录）；无 runner → 硬失败（不再回落）；语义分去掉“结构 0.6”，只留关键词且封顶 0.5；断言阈值改为“全部通过”或可配置最少条数；`gateTask` 改为跑同一套断言或删除 | v104：`add(2,3)==5` 对错误实现必须失败；正确实现必须通过；JS 缺失 runner 时任务 failed；Python 路径回归 v89 |
| P0-2 | 跨工作区串味：进程级单 store，`setStateDir` 每次调用重绑（还复制 requirement_lock），`restoreFromDir` 只合并不清空 → A 的锁/任务写进 B；现场 board 已混入 stock 的 k1–k4 与 4 个 L2 | `store.js:60,66-146,162-192,194-209`; `plugin.js:36,105-128`; `board-route.js:160-204` | 按规范化 workspace root 惰性建 registry（`Map<key,{root,store,r,tools}>`）；新增 `lib/workspaces.js`（normalizeRoot / keyFor / bindChild）；`createStore(cfg,{root})` 固定 stateDir；删 `setStateDir` 与 lock 复制；`alignTo`→`bindSession` 只更新 model/lastSession；工具 execute 改为按 key 分发；命令用 invocation 解析；看板取 `?workspace=`（必须是已存在 key）→ lastActive；spawn 后 `bindChild(childId,key)` | 新增 v103：两个临时工作区 A/B，A 锁后 B 调 status，B 不生成 lock、A 锁不丢；冷启动只恢复自己的；L2 cwd=scopeDir 仍归 A；`?workspace=B` 只返回 B；实机 board 不再出现 stock 记录 |
| P0-3 | 三层只是提示词：`agentTeams` 未注入（`plugin.js:21`），只有 `membership(agent)?.role==='lead'` 才拒；`isRootCoordinator` 在 agent 缺失/服务缺失/异常时一律 true；`ToolExecutionInput.agent` 本身可选 → 无归因的执行可绕过全部角色边界，L1 可直调 `pipeline_execute_local` | `plugin.js:21,135-160`; `guards.js:72-94` | 注入/解析 `agentTeams`，用 `agents.roots()`+spawn 登记表判定归因；角色矩阵显式化：lead → 禁 L2/L3 工具；l2/l3 → 禁 L1-only（含 status）；无归因 → ADVANCE/EXECUTION/L1-only 一律拒绝（fail-closed）；`decompose` 统一归 L2（从 L1_ONLY 移除，lead 调它被拒）；补 v104 负测试 | v104：L1 调 execute_local/execute_batch 被拒；L2 调 status 被拒；L2 调 decompose 放行；无 agent 的伪造执行被拒；错误文案可见 |
| P0-4 | 秘密安全两处活洞：checkpoint 的 `## 0.` 摘录未脱敏写进 `index.md`；`pipeline_recall` 的 `files` 可 `../../../.env` 读工作区外文件 | `scan.js:152,249,283,433`; `recall.js:59`; `ledger.js:91-104`; `SKILL.md:19` | 抽 `redact()` 为唯一写入口，覆盖 index/module page/ledger 全部落盘点；`recall` 对 rel 做 `resolve`+`relative` 校验，拒绝 `..` 与绝对路径；补 secret fixture 测试 | v99 扩展：fixture checkpoint 里的假 secret 不出现在任何产物；`files:["../../../.env"]` 必须报错；正常相对路径仍可读 |

### P1（不修则“能用”但会持续误导/丢工作）

| ID | 问题 | 关键位置 | 修法 | 验收 |
|---|---|---|---|---|
| P1-1 | 宿主机直接 `exec` L3 模型产出的代码，并对模型写的 acceptance 做 `eval`，无沙箱/白名单 | `gates.js:55-77` | 受限执行：仅接受 `函数(参数)==期望` 形式；禁止 import/os/文件/网络（AST 白名单）；临时目录 + 30s 超时；新增 `allowCodeExecution` 开关（默认开，可关） | 构造 `os.system` 注入用例必须被拒；正常断言通过 |
| P1-2 | 冻结是装饰性的：`/pipe-stop` 置 `status='paused'`，但 `budgetRefusal` 首行 `status!=='active'` 直接放行；`/pipe-off` 只改显示字段，守卫从不看 mode | `store.js:319-321`; `plugin.js:190-196,282` | `budgetRefusal` 先判 `run.paused` 再判 status；守卫增加 `cfg.mode==='off'` 拦截 EXECUTION/ADVANCE；`/pipe-stop` 与 `/pipe-off` 文案与行为一致 | v104：paused 后 spawn/execute 被拒；off 后同样被拒；resume 后恢复 |
| P1-3 | 运行页脚永远不追加：包装器只认 string/`{type:'text'}`，而 13 个工具 render 返回数组 | `guards.js:27-34`; `util.js:16-18` | 兼容数组：把页脚作为额外 text block 追加；补渲染测试 | v104：`pipeline_status.output.render` 结果含“⏸️/📊/⚠️”任一 |
| P1-4 | 里程碑自证：`accept_milestone` 只校验任务 done 就写 accepted；重新 plan 覆写 milestones，会抹掉“done 未验收” | `l1.js:156,575` | 增加 `userConfirmed:true` 机械参数（由 L1 在 ask_user_question 后传）；plan 保留已 accepted 里程碑，存在 done-unaccepted 时拒绝重 plan 除非显式 reset | v104：无确认参数被拒；重 plan 不丢未验收状态 |
| P1-5 | 恒真检查：`gateTask` 的 `jsonOk` 恒真；`l2l3.js` 把 `subtask_id` 伪造成 s.id 再比对；`gateSubtask` 的 subtask-id-match 永远通过 | `gates.js:155`; `l2l3.js:396` | 用真实解析结果做 JSON 校验；`subtask_id` 从 L3 原始返回读取并与记录比对，缺失即失败；补负测试 | v104：错误 id、非 JSON、空 code 分别失败 |
| P1-6 | L3 状态机谎报：非 JSON 回复被存成 `done`+`code:null`；`review` 计为 done；filePath 复核把 failed 改 done（仅凭语义分） | `l2l3.js:270,350,439-443,531,547-549` | 状态机只允许 `in_progress→review→done/failed`；非 JSON 直接 failed；`done` 仅在 gate 通过后写；批次返回区分 submitted/accepted；`parsed=null` 在计数前处理 | v104：非 JSON → failed；未过门 → review；filePath 重审不无条件升级 |
| P1-7 | 静默失败与谎报：`drain_leads` 吞异常后仍返回 drained；多处 best-effort catch 把真失败变“成功” | `l1.js:373-378` 等 17 处 | 失败必回传（返回错误字段/写 trace）；`drain` 只有成功才标记 done；保留 best-effort 的地方必须带 `warn` 日志 | v104：mock drain 抛错时返回失败且 state 不变 |
| P1-8 | 路径按 daemon cwd 解析：`devDir`/checkpoint/team_board/gates scratch 写到 profile 目录，项目级配置永远读不到 | `l1.js:403-404`; `prompts.js:29-30`; `gates.js:47`; `config.js:192` | 统一走 workspace root（A 批的 registry 提供）；gates scratch 用 `stateDir/exec`；项目配置按 workspace root 解析 | v103/v104：临时工作区内生成 checkpoint/team_board；项目级 config 可读 |
| P1-9 | 配置回写污染：`savePersistedConfig` 把合并后的全部键写回全局，项目层值泄漏到 `~/.dsh/pipeline/config.json` | `config.js:126-135,190-200,331` | 只写“本次显式修改的键”；全局/项目两层分开持久化；加 config 往返测试 | v104：项目层改值后全局文件不变 |
| P1-10 | 默认值绑作者机器：默认端点 18200 vs 实际 8080；L3 provider 硬编码 `ninfer-local`；`provider:'spawn'` 硬编码；`level3InputBudget=500` 硬拒 | `config.js:37-39`; `l2l3.js:508-514`; `l1.js:270-281` | 默认端点留空 + selftest 提示；`level3Provider` 可配置（默认 `ninfer-local` 但可改）；`spawn` provider 可配置；inputBudget 默认提高并在超限时提示压缩 | v104：selftest 指出缺失 provider；配置可改端点/provider |
| P1-11 | 反轮询只有提示词：L1 调 status 不被拦；L2 侧拦截 fail-open；完整规则只在按需 SKILL 里 | `prompts.js:14,42,44,218`; `plugin.js:135-160` | 协议补回“goal 续轮就结束回合”；守卫按 P0-3 fail-closed；spawn 后 `exec.concludeTurn()`（多连发用 `setImmediate` 合并验证）；可选：有 L2 in_progress 时 status 返回等待文案 | v104：单派发后回合结束；双派发两步都完成再结束；L2 调 status 被拒 |
| P1-12 | 预算账目失真：L2 分解从不计数；`filesTouched` 永远空（`maxFilesPerRun` 死）；counters 只在内存、重启归零；`maxLevel2Retries` 只存在于配置 | `l2l3.js:14-42,262`; `l1.js:284,344`; `store.js:33`; `config.js:91` | 分解调用计入 token；`addRunUsage` 传真实文件列表；counters 纳入 snapshot/restore；实现 L2 重试或删除该配置 | v104：分解后 tokensUsed 增加；重启后 counters 保留；files 出现在文件数 |
| P1-13 | 测试/发布不可信：`pnpm test` 漏 v98/v99；v90 隔离替换串失效（用真实 state dir）；v92 写脏 cwd；release 检查失败仍先覆盖快照；tag→version 差一；无 BUILD_TAG 校验 | `package.json:29`; `v90:33`; `v92:158,174`; `release.mjs:47,139-155`; `board-route.js:7,186` | test 串 7 套；v90 用新锚点并失败即 abort；v92 改用临时目录；release 先检查后写快照；公式改 `1.${vNum-91}.0`；BUILD_TAG 从 package 派生并校验 | `pnpm test` 7 套全绿；release dry-run 通过；v102→1.11.0 校验通过 |
| P1-14 | 看板/路由/卡片：无鉴权/方法检查；先 `writeHead(200)` 再 build，抛错会双写头；TTL 1.5s < 2.5s 轮询，每次重放 L2 session log；返回绝对路径/需求/错误串；client fetch 无超时、错误整卡为空、浅色下白刻度不可见、无 aria | `board-route.js:19-20,66,175-176,183-194`; `client.js:75,124` | 先 build 后 writeHead；TTL ≥ 轮询；错误只回通用文案；加方法/来源检查（本地回环）；client 加超时与错误态；对比度/aria；删相同分支 | v104：路由抛错返回 500 且无头错误；卡片错误可见；TTL 不重放 |
| P1-15 | 文档失真 11 条：`pnpm test` 7 套、≤300 行、`pipeline_scan(path=".")` 被 schema 拒、产物目录写错、decompose 归 L2、TUTORIAL 声称装入 web 档、两条安装命令不一致、9 节 vs 10 节、~230 行 vs 312、MIT 无 LICENSE、SKILL 硬编码动态数字 | `README:91,100,196,211,251,274`; `TUTORIAL:54,82,86`; `QUICKSTART:31`; `package.json:31`; `SKILL.md:43,79,93,111` | 逐条改到与代码/实跑一致；补 LICENSE；SKILL 动态值改为“见配置” | 文档断言清单逐条人工核对；`pnpm test` 输出与 README 一致 |

### P2（本次可延后，批次 E）

| 组 | 内容 |
|---|---|
| 知识层 | `scan` 同步 `git` 调用阻塞路由；两次遍历/重复读；符号链接、深度、2MB 静默跳过；不认 .gitignore；ledger 丢 <800 字符文档与长行；stale 只认代码扩展名；版本号 98/99 不一致 |
| 配置校验 | `maxCodeLines=0`、负预算、ratio>1 可写入；`tuneSweetSpot` 可让 budget>window；`level3Engine` 枚举与文档不符 |
| run 生命周期 | 全部里程碑 accepted 后 run 仍 `active` 永不收尾；`/pipe-close` 缺失；`/pipe-resume` 文案 |
| 常驻成本 | 协议 1595 字符静态插值 config（改配置不刷新）；19 schema 对所有层级可见；启动无条件 GET `/models` |
| 其他 | `maxLevel2Retries` 去留；`stateDir` 配置项被忽略；模块行数声明；`dsh-compat` duck-typing 无版本探测 |

## 3. 执行批次

依赖：0 → A → B；C 依赖 A；D 依赖 B/C；E 可独立。

| 批次 | 内容 | 预计改动 | 验收 |
|---|---|---|---|
| **0 基线** | 备份安装目录与两个项目的 `.dsh/pipeline`；`git init` + `.gitignore`；清理 `plugin/.dsh`、`plugin/src/calc`、本工作区 `.dsh/pipeline` 残留；跑 7 套基线 | 0 代码 | `git status` 干净；7 套全绿；备份存在 |
| **A 隔离** | P0-2、P1-8、P1-14（store/route 部分）、命令解析、board disposer | ~250 行，4 文件 + 新 `lib/workspaces.js` | v103 绿；v82/v89/v90/v92/skill_sync 绿 |
| **B 门与角色** | P0-1、P0-3、P1-1、P1-2、P1-3、P1-4、P1-5、P1-6、P1-7、P1-11 | ~350 行，7 文件 | v104 绿；v89 回归 |
| **C 秘密与配置** | P0-4、P1-9、P1-10、P2 配置校验 | ~150 行，5 文件 | v98/v99 扩展绿 |
| **D 发布与文档** | P1-13、P1-14（client/route hardening）、P1-15、LICENSE | ~120 行 + 文档 | `pnpm test` 7 套；release dry-run |
| **E 收尾** | P1-12、P2 知识层/生命周期/常驻成本 | ~120 行 | v105（可选） |

## 4. 测试与验收命令

```powershell
# 基线/回归
node dev/smoke/verify-v82.mjs
node dev/smoke/v89_control_smoke.mjs
node dev/smoke/v90_tool_factory_probe.mjs
node dev/smoke/v92_board_smoke.mjs
node dev/smoke/v98_knowledge_smoke.mjs
node dev/smoke/v99_knowledge_hardening_smoke.mjs
node dev/smoke/skill_sync_check.mjs
node dev/smoke/v103_workspace_isolation_smoke.mjs   # 新增
node dev/smoke/v104_gate_and_role_smoke.mjs         # 新增
```

验收基线：全部 PASS；v82 不得低于 75；v89 不得低于 49；v98 不得低于 15；v99 不得低于 27。

## 5. 部署与回滚

**前置**：`D:\Vctest\stock\.dsh\pipeline\run.json` 的 `status` 不是 `active`，或用户确认可以中断（部署会重启 desktop daemon，杀掉正在跑的 L2）。

1. 备份：`~/.dsh/dsh-pipeline-v102` → `.bak-2026-10-29`；`Merhentz_plugin/.dsh/pipeline`、`D:\Vctest\stock\.dsh\pipeline` 各一份。
2. 版本：`package.json` 1.12.0，CHANGELOG 加 v103，BUILD_TAG 同步。
3. `node dev/release.mjs v103`（检查 + 复制 + 字节比对）。
4. 重启 daemon（`set_bundle` 无效）。
5. 验证：`GET http://127.0.0.1:61730/pipeline/board` 返回 `build: v103`；`pipeline_selftest` 全绿；两个工作区各看一次 board。
6. 回滚：停 daemon，恢复备份目录，重启。

## 6. 待确认（默认值）

1. **范围**：A–D（推荐）／只做 P0／A–E 全做。
2. **反轮询硬度**：A 协议句 + B `concludeTurn` + D fail-closed（推荐）／只 A+D／只 A。
3. **代码执行**：受限执行 + `allowCodeExecution` 默认开（推荐）／默认关。
4. **部署时机**：等 stock run 收工（推荐）／立即（会中断）／先 headless profile 验证。
5. **git init**：做（推荐）／不做（仅备份）。

## 7. 已知风险

- 状态布局变化：旧 `board.json` 字段兼容，但删除 lock 迁移后，旧工作区首次启动不会自动带走锁；需手工确认残留。
- `concludeTurn` 在并行工具调用下的时序需用 v104 实测，必要时只对单派发射。
- 门改成 fail-closed 后，L1 若本来就在直调 L3，会在修复后立刻报错——这是预期行为，需在 CHANGELOG 写明。
- 部署时 stock 若仍在 active，会中断其 L2；这是唯一不可逆点。

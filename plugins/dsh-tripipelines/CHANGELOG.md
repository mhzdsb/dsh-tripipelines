# 版本日志（CHANGELOG）

> 版本号规则：包版本走语义化 `x.y.z`；迭代代号 `vN` 是本机开发部署号——Electron 桌面端按「模块真实路径」缓存导入结果，本机改代码后需**复制到全新目录 + 重装**才能生效（普通用户从市场升级无感）。v114 起 bundle 名为 `dsh-tripipelines-vN`，此前为 `dsh-pipeline-vN`。v109 及更早的条目已归档到 [CHANGELOG-archive.md](CHANGELOG-archive.md)。

## v128 — 1.32.0（甜点区数值跟真实窗口走：档案 → 宿主上报 → 未知不画假刻度）

### 变更
- **修掉一个真 bug**：用户质疑"甜点区数值本身对不对"——对没有内置档案的模型，答案是错的。`MODEL_PROFILES` 只收录了 deepseek 系与几个本地模型；换成千问 Token Plan 的 `qwen3.7-plus`（宿主档案里窗口 1,000,000）后，甜点/危险/窗口三值一直停在 flash 的 32K/96K/128K 旧数——看板显示"过线"而实际远没用完一半窗口。根因：`tuneSweetSpot` 对档案外模型静默跳过，只印一句"该模型无档案，甜点区未联动"。
- **三级回退链**（config.js / models.js）：`resolveTuning`（纯档案、同步路径不变）→ 新增 `resolveHostTuning(ctx,cfg,tierKey)`（档案命中即用；否则带 2.5s 超时调宿主 `llm.resolveModelInfo(provider, model).context.contextWindow`，比例取 cfg 覆盖值或默认 甜点 25% / 危险 75%，`FALLBACK_SWEET_RATIO`/`FALLBACK_DANGER_RATIO` 导出复用）→ 两边都没有返回 null。`autoPairAfterConfig` 在 L2 provider 配对之后新增 `retune('level1Model')` + `retune('level2Model')`：每个字段变化输出 `🔧 <field>: from → to（按宿主上报/内置档案窗口 W 重算）`，一致则 `✔ …已对齐…`，查不到则 `ℹ️ …看板会标注"未知"，不画假刻度`；修正值随 patch 落全局配置。`autoTuneSweetSpot=false` 时全部跳过。
- **看板不再画假刻度**（client.js）：`meter()` 新增 `winUnknown`（无宿主窗口且已有读数）——此时百分比位显示「未知」、数值只显示当前 token、填充涂中性灰、tooltip 说明两条修复路径（换模型自动对齐 / 手动 `/pipe-config level1ContextWindow <值>`）。v127 的 advisory 配色逻辑不变，`nearDanger` 在未知窗口下强制关闭。
- `/pipe-config` 档案缺失提示改为「该模型无档案且宿主未报窗口，甜点区未联动——看板按"未知"显示不画假刻度；可手动 …」；`TUNE_TARGETS` 导出供 models.js 复用同一套键名。
- SKILL Phase 0 第 4 条补写回退链语义（synced 16658 chars，字节同步 PASS）。协议长度 auto=1163/off=1164，护栏内。

### 测试
- 全绿 19 套：verify-v82 82（档案缺失文案更新 + 双布局锚点）、v122 跨 provider 配对 26→33（fake llm 增 `resolveModelInfo`；裸命令自配对断言 budget 32000→250000 / danger 96000→750000 / window 128000→1000000 并落盘；新段"甜点区跟宿主窗口走"验证切回 flash 恢复 32K、再配 qwen 重新拉到 250K）、v92 看板 +3（`winUnknown` / 「未知」占位 / tooltip 含 `level1ContextWindow` 修复指引）。
- 双拷贝教训再次生效：test/smoke 编辑后 Copy-Item → dev/smoke 并两侧各跑一遍；v122/verify-v82 头部升级为 pkgRoot/repoRoot 双布局锚点。

### 文档
- README.md / README.en.md：GUI 看板行加"窗口未知显示「未知」不画假刻度（v128）"；「甜点区自适应」段改写为三级回退链并点名旧 bug；ASCII 示意加一行 v128 注；测试清单 v122 计数 33 + v128 条目。

版本 1.31.0 → 1.32.0（行为变化：档案外模型的甜点/危险/窗口值改由宿主上报窗口自动重算并落盘；查不到窗口的模型看板显示「未知」，不再沿用错误的旧默认值）。

## v127 — 1.31.0（甜点区/危险线改为"仅提示"口径：过甜点不再报警，压缩代理下不误判）

### 变更
- **颜色语义重定**：v126 的读数诚实了，但阈值本身还在说谎——装了压缩代理（billion-context/ACP 这类）后，`tokenMeter.measure()` 的请求压力可以远超甜点线甚至危险线，而实际折叠后的上下文很小、模型表现照常；旧配色把这种健康会话涂成琥珀/红，用户看卡片就误判"快爆了"。现在**过甜点 = 中性钢灰（仅提示）**，琥珀只涂逼近危险线的最后 5% 窗口带（`nearDanger`），红色保留给真正过危险线≈接近崩溃。数值与百分比照旧显示，tooltip 明写「装了压缩代理时这是原始请求压力，实际上下文可能小得多、表现照常」。
- **快照声明 advisory**：`buildBoardSnapshot`/`idleBoardSnapshot` 的 `context.level1/level2` 增加 `advisory: true`，看板与消费方从此知道这些线是长上下文退化经验的建议值，不是硬限制（延续 v119 warningOnly 的思路）。
- **L1 警告文案改写**（dsh-compat.js）：过阈值时的 warning 从"上下文已到 X%，建议 checkpoint 交接"改为"请求压力已达甜点的 X%……压缩代理下实际上下文可能仍很小、表现照常——checkpoint 只是可选整理动作"；measure 结果同时携带 `danger`/`window` 字段供上层显示。
- **SKILL 检查点规则条件化**：Phase「L1 checkpoint / restart」不再单纯按 `ratio >= level1ContextWarnRatio` 提议交接——先判断是否处于压缩代理之下（拿不准就不提议），话术改为"原始请求压力已过甜点区（压缩代理下实际可能仍很小），要做一次 checkpoint 吗？"，并明令禁止仅凭压力数字宣称能力下降。
- `/pipe-config` 里 `level1/level2DangerBudget`、`level1ContextWarnRatio` 的说明同步改为"提醒线，非硬限制"口径。
- 板卡其余行为（单条填充、测/估徽章、待验收行、折叠 rail）不变。

### 测试
- `v92_board_smoke.mjs` +4 断言（context 双层 `advisory:true`；client 存在中性灰填充串；`nearDanger` 逻辑存在；tooltip 含"原始请求压力"声明），dev/test 双拷贝字节一致均 ALL PASS。
- 全量 19 套回归 exit 0；协议长度 auto=1163 / off=1164 < 1200 护栏。

### 文档
- README.md / README.en.md：GUI 看板行与 ASCII 示意图标注新配色语义（灰=仅提示、压缩代理下颜色仅供参考）；TUTORIAL/QUICKSTART 无需改动（未涉及配色）。

版本 1.30.0 → 1.31.0（行为变化：看板过甜点不再显黄/红警报，只有逼近危险线才琥珀、过线才红；一切阈值文案统一为"仅提示"口径）。

## v126 — 1.30.0（看板负载条说实话：单条填充 + 测/估徽章，三区渐变退役）

### 变更
- **看板 meter 重做**：v97b 的「绿黄红三区固定渐变 + 白色指针」暗示指针是窗口内的精确位置，但宿主 `tokenMeter.measure()` 给的是**请求压力口径**——装了压缩代理（ACP/billion-context 这类）后它与实际计费上下文并不是一回事，三区+指针是在表演精确。现改为**单条填充**：填充色随读数落在甜点区前/甜点~危险线/危险线后来取绿/黄/红，阈值数值收进悬浮 tooltip（`当前 X／甜点 Y／危险线 Z／窗口 W`），不再画分区界线和假刻度。
- **来源徽章**：每条读数右侧新增 `测`（宿主 tokenMeter 实测）/ `估`（tail-40 估算、缓存回落或 spawn 足迹）小徽章；L1 读数由 `/pipeline/board` 快照携带 `source`/`approximate` 字段（buildBoardSnapshot/idleBoardSnapshot 同步扩形），L2 沿用 `measured` 真值并把原 `· 估` 文字后缀升级为同款徽章。tooltip 明写「装了压缩代理时可能与实际计费口径不同」。
- **测量不再吃缓存旧值**：`measureLevel1Context` 优先实时 `measure()`，仅当瞬时失败才回落到 TTL 缓存（此前 2.5s 轮询大部分命中缓存，卡片刻度在两次工具调用之间是冻住的）；plugin.js 工具包装层写 store 时同样带上 `level1Source/level1Approximate`（此前只写数字，把 tail40 估算洗白成"无标注读数"）。
- L1 尚无读数时不显示徽章（不拿 `估` 冒充有数据）；待验收行、折叠 rail、工作区切换等其余卡面行为不变。功能没有取消——只是把不能保证准确的部分降级为诚实的近似显示，并保留全部信息量。

### 测试
- v92 看板套件 +7 断言：context.level1 默认 source=null / tail40 provenance 透传 / level2.measured 聚合 / live lead 缓存 tokens / client 含测·估徽章 / 三区渐变 track 已删除 / 甜点·危险线只存在于 tooltip。dev/smoke 与 test/smoke 双副本锚点统一（root 回退逻辑同 v125 模式）。
- 全套 19 套件 `npm test` 全绿。

### 文档
- README / README.en.md：ASCII 看板示意行改为 `41K/64K 测` / `63K/32K 估` 样式，GUI 看板特性行说明测/估徽章与变色语义；config.js 两个 ContextWindow 键描述去掉"用于显示分区"旧词。

版本 1.29.0 → 1.30.0（行为变化：侧栏负载条不再假装精确——单填充+变色、阈值进 tooltip、读数以 测/估 徽章标明来源；L1 刻度改为实时测量不再冻在缓存上）。

## v125 — 1.29.0（市场就绪：测试随包发布、双门合一、看板脱敏、文档英文入口）

### 变更
- **测试随包发布**：19 套 smoke 回归全部搬进包内 `test/smoke/`，`npm test` 不再依赖本仓库的 `dev/` 布局——任何人克隆/安装本包后在任意目录都能自验。路径锚点改为「包根优先，monorepo 回退」，仓库内 `dev/smoke/` 副本同样可跑。`package.json` 补 `homepage` / `bugs` 字段，`files[]` 收编 `test/`、`README.en.md`、`CHANGELOG-archive.md`。
- **双门合一（v125）**：新工作区开工不再连弹两个窗——`pipeline_model_setup` 的提问合并一次性激活确认（`question.activationMerged`，选项前三项即启用；选模型而未答时自动记 `remember`）。`pipeline_lock_requirements` 在两门皆开时只发一条合并 hint；显式 `activation=enable|normal|remember` 仍可单独传。SKILL Phase 0 与纪律条目同步改写。
- **看板默认脱敏**：`GET /pipeline/board` 默认快照不再携带绝对路径等 debug 块（`?debug=1` 显式索取才有）；路由头注释写明 localhost-only 假设与只读性质。
- **QUICKSTART 重写**：第 0 步改为三条零门槛路线表（A 本地引擎 executor / B 云端 agent / C 两级 off），无引擎用户不再是二等公民；FAQ 补「没有任何本地引擎能用吗」与 provider 配错报错两条。
- **selftest 文案对齐 v123/v124**：引擎不可达/未配置的建议改指 agent/off 路径；L3 报错标签从内部名 `ninfer` 改为通用「L3 引擎」。
- **spawn_local_executor 并发队列去轮询**：200ms busy-wait 换成事件驱动 waiter（槽位释放即唤醒，兜底超时保留）。
- **README 视觉首因**：ASCII 图加 GUI 看板示意框；新增 `README.en.md`（英文版全文，市场目录用）与中英互链。
- **CHANGELOG 拆分**：v109 及更早移入 `CHANGELOG-archive.md`；头部版本规则说明改写为「semver + 本机 -vN 开发号」，明确普通用户升级不受 Electron 缓存影响。

### 测试
- v121 扩至 52 断言（+9：合并提问三态、message/next 文案、双 hint 合一、apply 带 activation 落盘、门闭后不再追问、dev/smoke 与 test/smoke 副本字节一致守卫）。
- v103 增至 50 断言（看板默认快照省略 debug 块、无 debug 时 workspaces 仍只回 key）。
- 全套 19 套件 `npm test` 全绿（含协议长度守卫 <1200：auto=1191 / off=1164）。

### 文档
- README（中英指针 + 看板示意 + 双门合一说明）、QUICKSTART 重写、TUTORIAL/README.en.md 同步；`.gitignore` 覆盖 src/ 残留已清理删除。

版本 1.28.0 → 1.29.0（行为变化：新项目开工只弹一次窗（定模型+启用确认合一）；看板默认输出脱敏；包可独立测试；英文文档入口就位）。

## v124 — 1.28.0（可以手动关闭三级：只用 L1 + L2 两级协作）

### 变更
- **`level3Mode` 新增 `off`**：`/pipe-config level3Mode off`（或简写 `/pipe-config level3Model <id> off`）把插件切成两级——L1 照常规划/派发/验收，L2 负责人自己写全部代码。恢复用 `/pipe-config level3Mode auto`（也可 `/pipe-config level3Model <id> mode=auto` 换模型顺带恢复）。
- **执行面拒绝**：off 时 `pipeline_execute_local` / `pipeline_execute_batch` 返回 `{ok:false, blocked:true, l3Disabled:true}` 并说明「本任务由你（二级负责人）自己完成，完成后用 pipeline_register_output 登记」；`pipeline_spawn_local_executor` 直接抛错同样给出路径。`pipeline_decompose` / `pipeline_review` / `pipeline_register_output` 不受影响，两级下照常工作。
- **不会偷偷复活**：off 状态下改 `level3Model` 只做记录、不再自动配对回 executor/agent（输出 ℹ️ 提示）；只有显式带 `mode=` 才重新启用。`pipeline_model_setup({apply:'defaults'})` 尊重当前 off，不覆盖三级配置。
- **开工清单与提问**：off 时 L3 段改为「已关闭」状态块，附两条恢复命令；问题选项在开启态多一个「只用 L1+L2（关闭三级执行器）」、关闭态换成「恢复三级执行器」（恒为 4 选项）。`pipeline_model_setup({apply:'custom', level3Mode:'off'})` 可一步关闸并写入项目记录 `model-setup.json`。
- **L2 提示词切换两级版**：`buildL2LeadPrompt` 在 off 时改用两级拓扑（无 DOWN 层、去掉硬性派发规则、改为「自己写完 → register_output → review」），协议 config 行显示 `L3 OFF (two-tier: L2 writes code itself)`。
- `pipeline_selftest`：off 时输出 ok:true 的 `L3 disabled` 检查（不进 degraded），且不再探测本地引擎端点；插件启动时的端点自检在 off 下整体跳过。SKILL.md Phase 3 增加「L3 OFF (v124)」条目并与 SKILL_BODY 字节同步。

### 测试
- 新增 `dev/smoke/v124_l3_off_smoke.mjs`（29 断言）：off 落盘与命令文案、裸 `off` 简写、off 下改模型不自愈、`mode=auto` 同条命令恢复并判 executor、三个执行工具逐一验证、selftest 只报 disabled 不探引擎、setup 一步关闸 + 项目记录 + 清单/提问文案、defaults 不覆盖 off、工具级恢复后 execute_local 放行。
- v121 用例更新为 4 选项断言；测试链 18 → 19 套件，`npm test` 全绿。

### 文档
- README / TUTORIAL / QUICKSTART：补「关闭三级（两级模式）」用法。

版本 1.27.0 → 1.28.0（行为变化：用户可用一条命令关闭三级执行器，插件以 L1+L2 两级运行；所有 L3 派发入口被明确拒绝并指向二级直写路径）。

## v123 — 1.27.0（L3 可以是云端模型，并可带模式；`/pipe-config` 直接自配对 provider）

### 变更
- **`/pipe-config` 支持一条命令同时带模式/provider**：`/pipe-config level3Model <id> mode=agent`、`/pipe-config level3Model <id> provider=<pid>`，也接受纯 `k=v` 形式；`level3Model` 后面直接跟 `agent|executor|auto` 视为 `mode=`。L2 永远是子代理，`mode=` 用在 L2 上会被忽略并给出说明。
- **改模型后自动配套**：命令执行后插件用 `ctx.llm.listModels` 校验，L2/L3 的模型只属于另一个 provider 时自动改过去并在输出里说明（`🔧 … 已自动配套 level2Provider=…`）。因此 `qwen3.7-plus` 这类 token-plan 模型直接写模型名即可，不再需要手动补 provider 行。派发/模型清单里的显式 provider 仍优先。
- **新增 `level3Mode`（auto / executor / agent，默认 auto）**：`executor` = 本地 OpenAI 兼容端点一次性执行；`agent` = 把 L3 当 DSH 子代理、跑在该模型所属 provider 上（云端模型没有本地端点，必须走这条）；`auto` 按模型来源判断（引擎模型 → executor，云端模型 → agent）。`pipeline_model_setup` 的默认值落 `auto`，`apply:'custom'` 传云端 L3 时自动切成 agent 并配套 provider。
- **模式约束**：`level3Mode=agent` 时 `pipeline_execute_local` / `pipeline_execute_batch` 返回 blocked 并指向 `pipeline_spawn_local_executor`；`level3Mode=executor` 时反向拒绝 `pipeline_spawn_local_executor`。`pipeline_spawn_local_executor` 派发前同样校验 L3 的 provider 配对（自动纠正或明确报错），不再把云端模型 id 发到错误端点。
- **开工清单**：L3 段标题区分两种模式，并多给一行示例 `/pipe-config level3Model <任一 L2 模型> mode=agent`；当前行与 `✅ 已定` 行都显示 L3 模式。
- `pipeline_selftest`：agent 模式下检查 `level3Provider`/`level3Model` 配对（不再检查本地端点），executor/auto 模式仍检查 `GET /v1/models`；`level3Mode` 写进 protocol 的 config 行。
- 项目记录 `model-setup.json` 增加 `level3Provider` / `level3Mode`；protocol 与 SKILL.md Phase 0/3（新「L3 MODE」段）字节同步。

### 测试
- 新增 `dev/smoke/v123_l3_mode_smoke.mjs`（23 断言）：`mode=agent` 落盘并自动配套 provider、清单提示、agent 模式 selftest 通过/坏配对 degraded、agent 模式拒绝 execute_local、executor 模式拒绝 spawn_local_executor、`mode=auto` 对引擎模型判 executor、裸 `agent` 简写、`apply:'custom'` 云端 L3 自动 agent、L2 上的 `mode=` 被忽略。
- v121/v122 用例按新行为更新（L3 行数、裸模型命令现在自配对）；测试链 17 → 18 套件，`npm test` 全绿。

### 文档
- README / TUTORIAL / QUICKSTART：补云端 L3 + `mode=agent` 用法与「L2 直接写模型名」的说明。

版本 1.26.0 → 1.27.0（行为变化：`/pipe-config` 改模型会自动配套 provider；L3 可用云端模型并以 agent 模式运行，模式可随命令一起设置）。

## v122 — 1.26.0（跨 provider 选 L2 模型时自动带上正确的 provider）

### 修复
- **缺陷（用户实机报错）**：`level2Provider=deepseek-official` + `level2Model=qwen3.7-plus`（该 id 只属于 `qwen-token-plan-cn`）时，`pipeline_spawn_module_lead` 把这对值原样交给 DeepSeek，API 返回 `The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed qwen3.7-plus.`。现在 provider 与 model 在三处被绑定：
  - `pipeline_model_setup` 清单按 provider 分组：非当前 provider 的组前直接给一行可复制的 `/pipe-config level2Provider <id>`；当前配置本身配对无效时额外打印 `🚨 当前 L2 配对无效…` 及修复命令。
  - `pipeline_model_setup({apply:'custom', level2Model})` 未显式给 provider 时，按发现结果自动配套正确 provider 并写 warning；显式给了 provider 的仍尊重，只警告。
  - `pipeline_spawn_module_lead` 派发前做 best-effort 校验（`ctx.llm.listModels`，2s 超时、60s 缓存）：模型不在指定 provider 下时自动改到提供它的 provider，结果返回 `providerNote`；显式传 `provider` 的调用不改写、只警告；llm 不可用或模型未知时不阻断派发。
- `pipeline_selftest` 新增 `L2 model/provider` 检查：模型不在 provider 列表时标为 degraded，并给出「它在哪个 provider 下、该发哪条命令」。

### 测试
- 新增 `dev/smoke/v122_l2_provider_smoke.mjs`（23 断言）：清单按 provider 分组 + 可复制 provider 行 + 顺序、当前坏配对告警、`apply:'custom'` 自动配套并落盘、spawn 自动改 provider 且模型不变、显式 provider 被尊重且给警告、未知模型警告不阻断、selftest 报 degraded。
- 测试链 16 → 17 套件，`npm test` 全绿。

### 文档
- README / QUICKSTART：补「模型属于哪个 provider」的说明与排查方式。

版本 1.25.0 → 1.26.0（行为变化：跨 provider 选 L2 模型不再需要手动补 provider 命令；派发前会自动纠正并在 `providerNote` 说明）。

## v121 — 1.25.0（每个项目开工先定二级/三级模型）

### 变更
- 新增 L1 工具 `pipeline_model_setup`：在每个项目开工、锁定需求之前调用一次。它动态发现二级候选（`ctx.llm.listProviders()` + `listModels()`，跨 provider 合并并标注 provider）和三级候选（`GET <level3Endpoint>/models`，保持引擎返回顺序 = 本机排序；引擎离线时回退配置值 + `MODEL_PROFILES` 档案，并明确标注「引擎未在线」）。
- 返回 `message`：可直接贴进对话的中文清单，每个模型一行可复制的 `/pipe-config level2Model <id>` / `/pipe-config level3Model <id>`，默认项标 `← 默认`；同一模型 id 出现在多个 provider 时提示再补一条 `/pipe-config level2Provider <provider>`。另返回 `question`，供 `ask_user_question` 三选一：用默认 / 我自己指定 / 本项目不用三级协作。
- 默认值：L2 = `deepseek-flash`（沿用配置的 provider）；L3 = 本机 `/models` 返回的第 1 个（引擎离线时取 `level3Model` 配置值）。`apply:'defaults'` 一键落默认，`apply:'custom'` 落用户指定值（未出现在发现列表里的 id 仍接受，但给 warning）。
- 选择结果按项目记忆到 `<stateDir>/model-setup.json`（`confirmed/mode/level2Model/level2Provider/level3Model/at`）；再次打开同一项目时返回 `alreadyConfigured:true`，只贴一行摘要，不重复追问。
- `pipeline_lock_requirements` 在项目尚未定模型时返回 `modelSetupHint`，提示先贴清单并问一次；定过之后 hint 为 `null`。
- 持久化仍复用 `/pipe-config` 的全局 `~/.dsh/pipeline/config.json`，项目级覆盖仍写 `<devDir>/pipeline-project.json`；换 L2 时甜点区照旧自动联动。
- protocol 提示词与 SKILL.md Phase 0 改为「开工第一件事」的四步流程（调用 → 原样贴 `message` → 问 `question` → 默认/自定义/关闭），两者字节同步。

### 测试
- 新增 `dev/smoke/v121_model_setup_smoke.mjs`（43 断言）：发现顺序/去重、跨 provider 合并、默认 L2 flash / 默认 L3 本机第 1、离线回退不谎称排序、可复制行与 `← 默认`/provider 提示/关闭出口、question 三选项、工具注册与 L1-only/footer、`apply:'defaults'` 落盘全局配置 + 项目记录、lock hint 前后、alreadyConfigured、custom 落盘、空 custom 沿用当前配置、未知 id 警告。
- 测试链 15 → 16 套件，`npm test` 全绿。

### 文档
- README：能力表/工具表/配置说明/使用一节补「开工先定模型」；测试清单 16 套件。
- TUTORIAL：四阶段第 1 步改为贴全量模型清单 + 默认值；工具表补 `pipeline_model_setup`。
- QUICKSTART：第 0 步补默认值说明。

版本 1.24.0 → 1.25.0（行为变化：每个新项目会在锁定需求前先贴出模型清单并问一次；不选则按默认落盘）。

## v120 — 1.24.0（`/pipe-research` 真正开始研讨，而不只是落一份空骨架）

### 变更
- `/pipe-research <议题>` 在写完 `knowledge/research/<日期>-<slug>.md` 后，调用 `invocation.agent.followup(...)` 唤醒当前 agent，注入一条 user-role 提示：先就第 1 步（立项）用 `ask_user_question` 问 1-2 个问题（问题本身、成功判据、预算），不要一次把 7 步问题倒完；用户回答后再逐节续写文件。此前命令只生成骨架并返回路径，研讨实际从未开始（用户反馈）。
- 注入消息是普通的 user/source `{kind:'user'}` 文本消息，带新 UUID；宿主不支持 `followup` 时命令仍成功，但文本明确说「没有可唤醒的 agent，请在对话里说开始研讨」，不谎称已发问。
- 消息里的笔记路径用工作区相对路径（`knowledge/research/...`），非绝对路径。
- 命令描述改为「open ... and start the 7-step interview」。

### 测试
- 新增 `dev/smoke/v120_research_handoff_smoke.mjs`（20 断言）：命令注册与描述、`followup` 恰好一次、user role/source/UUID/单 text block、内容含议题+相对路径+第 1 步+1-2 问、骨架仍含 7 节、成功文案声称已发问、无 `followup` 宿主降级且不谎称、空议题回退 `untitled topic`。
- 测试链 14 → 15 套件，`npm test` 全绿。

### 文档
- README「专题研讨」：说明 v120 起同一轮开始第 1 步提问，v119 及以前只落空骨架。
- SKILL.md / `prompts.js` SKILL_BODY：`/pipe-research` 一行改为「note + first-step interview starts in the same turn（v120）」，字节同步。
- README 测试清单更新为 15 套件。

版本 1.23.0 → 1.24.0（行为变化：`/pipe-research` 会立即触发一轮 agent 回复）。

## v119 — 1.23.0（质量门可退出：cmd 验收 + 计划期校验 + 状态卫生）

### 修复
- **缺陷 1（阻断）**：`pipeline_register_output` 现在记录 `l3SubtaskId = s.id`，L2 直写后 `pipeline_review` 的 `subtask-id-match` 恒假的死循环解除（此前 review 载荷为 `null`，与 `"t1-s1"` 比较必然失败）。
- **缺陷 2（死路）**：新增 `acceptanceMode` / `validateAcceptanceCriteria`，`pipeline_plan` 落盘前校验每条验收：断言 / `cmd:` / 关键词分三种模式。关键词分封顶 0.5 而阈值 > 0.5 时直接报错，并给出三种改法（写 `add(2,3)==5`、写 `cmd: ...`、或显式把 `semanticGateThreshold` 降到 ≤0.5）。L2 分解时若 LLM 生成的子任务验收不可用，回退模块验收，避免把子任务预埋成失败。
- **缺陷 3（文件类任务）**：新增 `cmd:` / `run:` / `command:` 验收模式（`executeCommandAcceptance`），在工作区根目录执行命令并以退出码判定；默认 120s 超时（新配置 `commandAcceptanceTimeoutMs`）。这是「集成验收」，与断言沙箱分离：断言沙箱仍禁止 `pathlib`/`os`/`open` 等 import/IO，文件任务应在工作区跑 `pytest`/同步检查脚本。多子任务模块的子任务级命令验收自动 defer 到模块门禁（`deferred`），由 task gate 真正判死。
- **缺陷 4（里程碑出口）**：`pipeline_accept_milestone` 失败时列出阻塞项（任务状态/原因 + 卡住的子任务 `id:state(reason)`），并提示先 `pipeline_review` 或修正 `acceptance`；不再是只有 `0/1` 的无信息报错。
- **缺陷 5（兜底切分）**：`splitIntoChunks` 只在句末标点（`。；！？`）或「点号 + 空白」处切分，不再把 `sync_pipeline_knowledge.py` 拆成 `. py`、`decisions.md` 拆成 `. md`。
- **缺陷 6（状态卫生）**：新 `pipeline_lock_requirements` 会把上一轮遗留的 `in_progress` / `replaced` L2 标为 `archived`（保留 `done`），`waitingFor` 不再永久挂着旧 agent。
- **缺陷 7（误导信息）**：`pipeline_status` 新增 `countersNote`，说明 `llmCalls`/`tokensIn`/`tokensOut` 只统计插件侧 L3/LLM，L2 会话真实用量只计入 `measuredTokens`（与 `tokensUsed` 同源）；L1 上下文超预算告警明确标注「仅告警，不阻断」并返回 `warningOnly:true` / `blocks:false`；`pipeline_scan` 与 check-stale 默认跳过 `_scratch`。
- **健壮性**：`cmd:` 命令执行在禁止管道 stdio 的宿主（如 DSH Windows 沙箱）上自动以 `stdio:'ignore'` 重试，仍以退出码判定，不会因 EPERM 误判失败。

### 测试
- 新增 `dev/smoke/v119_gate_exit_smoke.mjs`（41 断言）：register→review id 匹配、plan 拒绝不可通过验收、`cmd:` 文件任务通过/非零退出/执行开关、断言沙箱仍拒绝 pathlib、多子任务 defer、里程碑阻塞项、兜底切分文件名完整、lock 归档、countersNote、warningOnly、`_scratch` 跳过、`commandAcceptanceTimeoutMs` 默认与校验。
- 测试链 13 → 14 套件，`npm test` 全绿。

### 文档
- README：能力表、配置表、工具表、已知限制补 `cmd:` 验收与计划期校验；测试清单更新为 14 套件。
- TUTORIAL：示例 TaskPlan 改为断言形态，补充三种验收写法与排障说明。
- SKILL.md / `prompts.js` SKILL_BODY：需求访谈阶段写明断言或 `cmd:` 验收（字节同步保持）。

版本 1.22.0 → 1.23.0（行为变化：不可执行的验收在 plan 期报错；新 run 会归档旧 L2）。

## v118 — 1.22.0（隔离契约 + 检索语义）

### 变更
- **P1 路径收口**：新增 `resolveInside(root, p)`；`pipeline_scan` / `pipeline_ledger` 的 `root`、`pipeline_checkpoint` 的 `path`、`resumeFrom`、`scopeDir`、`devDir` 只接受工作区内的路径，绝对路径与 `..` 越界直接报错（带修正提示）。此前在 B 项目执行 `pipeline_scan({root:'A'})` 会把 A 的内容写进 B 的知识库。
- **P2 去兜底**：`createStore` / `runtimeStateDir` / `executeAcceptance` 不再回退 `process.cwd()`，缺工作区根时显式报错（避免把状态写进 DSH profile 目录）。
- **recall 语义**：命中带 `kind`（code / decision / candidate / research）；返回 `coverage`、`partial`、`generatedAt`（hashes.json 优先，mtime 兜底）、`rootMismatch`；未填完的 `/pipe-research` 草稿（第 7 节无正文）不参与检索；去掉「没有 index.md 就报错」的硬前置——有任何可检索文件即返回结果并标 `partial`，真的空才报错。
- **只读项目内容**：不新增 `pipeline_decide`、不写 `decisions.json` 侧车、不创建/修改项目 `decisions.md`；项目已有 `dev/decisions.md` 时以只读外部目标加入检索。
- 测试：新增 `dev/smoke/v118_isolation_smoke.mjs`（45 断言）；修 `dev/smoke/verify-v82.mjs` / `v89` / `v90` / `v92` 的 store patch 锚点与 `createStore` 调用；`v98` 的 research fixture 补第 7 节。全量 13 套件绿。
- 文档：README 新增「隔离与检索语义（v118）」、TUTORIAL §4.9、design doc §19、SKILL.md Phase 0 两行（已同步字节校验）。
- 版本 1.21.3 → 1.22.0（行为变化：越界参数从静默接受变为报错）。

## v117 — 1.21.3（知识层文档补全 + 研讨笔记可检索）

### 变更
- 补上一直存在、但所有文档都没讲清楚的「专题研讨」能力：
  - README 知识层新增「专题研讨（`/pipe-research`）」小节：知识库如何随开发积累、什么时候该开研讨、7 步议程、三条防呆、结论如何回写。
  - TUTORIAL 新增 §4.8：把 `/pipe-research` 当「会议议程」用，含证据补齐、回写与检索闭环。
  - design doc 新增 §18：知识层与专题研讨的设计动机、为什么不做 RAG、刻意没做的自动化。
  - SKILL.md Phase 0：知识库随 run 增长；瓶颈时用 `/pipe-research`，结论回写后 `pipeline_recall` 可检索。
- `pipeline_recall` 默认检索目标新增 `knowledge/research/*.md`：此前研讨笔记写进磁盘却检索不到，属于「写死记忆」。
- 描述文案：`pipeline_recall` 覆盖 research notes；`/pipe-research` 注明笔记可被检索。
- `dev/smoke/v98_knowledge_smoke.mjs` 新增断言：research 笔记默认参与检索。
- 无其它运行时行为变化；版本 1.21.2 → 1.21.3。

## v116 — 1.21.2（仓库布局：包移到 plugins/dsh-tripipelines/，满足 market catalog CI）

### 变更
- 仓库结构调整：插件包从 plugin/ 移到 **plugins/dsh-tripipelines/**；dev/（测试、release、preflight、文档）留在仓库根。catalog CI 只认根 package.json 或 packages|plugins|apps/<子包>/package.json。
- 路径同步：scripts.test 改为 ../../dev/smoke/*.mjs；dev/smoke/*.mjs、dev/release.mjs、dev/preflight.mjs、dev/_sync_skill.mjs 的源目录与 repoRoot 引用；.gitignore；README/TUTORIAL 中的仓库路径。
- 无运行时行为变化；版本 1.21.1 → 1.21.2。

## v115 — 1.21.1（措辞：不再把层级和具体模型绑定）

### 变更
- 全仓移除「一级=pro、二级=flash」的说法。层级只描述**职责**（L1 由你在会话里选的模型担任，L2 默认取 `level2Provider`/`level2Model` 且可按模块覆盖，L3 为本地引擎），不再暗示某层必须是某个模型。
- 影响面：README、TUTORIAL、`docs/agent-lifecycle-design.md`、`package.json` description、插件 skill 描述、`prompts.js` 的协议行与 L2 启动提示、`config.js` 的 `level2ContextBudget` 描述、`l1.js` 的 classify 理由、`l2l3.js` 注释、SKILL.md（已同步字节校验）。
- 无功能变化；版本 1.21.0 → 1.21.1。

## v114 — 1.21.0（改名 dsh-tripipelines，准备发布 npm / market）

### 变更
- npm 包名 `dsh-pipeline` 已被他人占用（owner `tudamu`，0.0.1 占位），发布名改为 **`dsh-tripipelines`**（已确认 npm 上可用）。功能无变化，仅包身份与安装命令变化。
- 同步改名：`cordis.patch.yml` 的 bundle 名、Web 客户端 loader `id`、`package.json`、README / QUICKSTART / TUTORIAL 的安装命令、`dev/release.mjs` 的快照目录前缀与 GUI 步骤文案。
- 兼容：客户端启动时清除旧 localStorage 键 `dsh-pipeline.workspace`；旧快照目录 `~/.dsh/dsh-pipeline-v*` 不再被发布脚本 `--verify` 列出，仍可手工回滚。
- `package.json` 新增 `keywords`（deepseek-harness / dsh / dsh-plugin / pipeline / orchestration / multi-agent），便于 market 与 npm 搜索命中；版本 1.20.1 → 1.21.0。

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


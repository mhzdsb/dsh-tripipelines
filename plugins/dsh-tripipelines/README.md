# dsh-tripipelines · 流水线

> **分层协作，按需分配模型。** 把大活拆成每个模型都吃得下的份量——钱花在刀刃上，代码写得经得起十年。

一个 **DeepSeek Harness（DSH）原生插件**：一级（你在会话里选的模型）负责规划与验收，二级（默认配置的模型，可按模块覆盖）负责写模块代码，三级本地模型干碎活。三级严格相邻、逐任务验收、全程可暂停可回溯。

纯 Node 内置依赖，零外部 npm 包，不碰你的 DSH 源码。

```
用户 ──只和 L1 对话──▶ L1(你选的模型) ◀──汇报迭代──▶ L2(模块负责人) ──强制下发──▶ L3(本地引擎)
      规划·验收·不写码     重新锚定·按异常汇报     分解·写码·审核        完整文件·多试几次·干不了反馈
      严格相邻：L1 ↔ L2 ↔ L3，同级/越级禁止
```

---

## 为什么需要它

一个 **大模型从头写到尾**：聪明，但贵、慢，而且上下文越写越糊——到了第 30 个文件，它已经记不清第 1 个文件的接口。

**全交给本地小模型**：便宜，但写不对，来回返工的钱比省下来的多。

**流水线**把这两种钱花在对的地方：

| 层 | 谁 | 干什么 | 成本 |
|---|---|---|---|
| L1 | 你在会话里选的模型 | 拆任务、定验收、终审、只和用户对话 | 花在刀刃上 |
| L2 | 默认配置的模型（可按模块覆盖） | 模块负责人，写完整文件、跑质量门 | 主力劳动 |
| L3 | 本地引擎（通常最便宜） | 单函数/小片段，检查验收断言 | 碎活 |

外加三个设计让这条产线**不会失控**：一次性激活确认、预算护栏（token/时长/文件数触顶自动暂停）、里程碑硬验收（不许悄悄跳过）。

## 30 秒判断要不要用

**适合**
- 中大型/多文件的真实项目（≥ 3 个模块）
- 想省 token 钱、又不想降质量的开发
- 本机/局域网有 OpenAI 兼容的本地推理引擎（ninfer / vLLM / llama.cpp 都行）
- 需要一条产线跑几十分钟、中途还能停下来的活

**不适合**
- 一次性脚本、单文件小改（直接让主 agent 写更快）
- 没有本地引擎（三级退化成两级，价值减半）
- 要求「一句话出全部代码」的即时小任务

---

## 快速开始（3 分钟）

装插件 → 配本地引擎 → 说第一句话。三步详细版见 **[QUICKSTART.md](QUICKSTART.md)**。

```bash
# 1. 安装（发布后走 npm / market；本地开发用快照 link）
dsh plugin --profile <profile> add dsh-tripipelines        # npm / market（发布后）
plugin_manager install_bundle('link:C:/path/to/dsh-tripipelines-vNN')  # 本地快照 / dev

# 2. 确认三级都活着
/pipe-selftest

# 3. 说一句话（不用你拆模块）
"帮我做一个带登录和任务列表的待办应用"
```

主 agent 会自动走「引导开机 → 需求访谈 → 适配性评估 → 自适应调度」四阶段：先问你几个关键问题并锁定需求，然后拆模块、spawn 二级、下放三级、逐节点汇报、到里程碑弹窗让你验收。

## 它怎么工作

### 四阶段工作流
1. **引导开机**：新工作区首次询问一次「要启用流水线吗」（A 启用 / B 普通 / C 记住此工作区），答案存 `.dsh/pipeline/activation.json`。
2. **需求访谈**：用弹窗问关键问题（框架/数据库/认证/测试期望…），锁定为 `requirement_lock.json`。
3. **适配性评估**：任务太简单就直说「不用三级」，别硬套。
4. **自适应调度**：拆模块（天然接缝 + 负载均衡）→ spawn L2 → L2 分解出 L3 子任务 → 批量执行 → 质量门 → 里程碑验收 → checkpoint。

### 四条硬约束（不是靠模型自觉）
| 约束 | 怎么强制 |
|---|---|
| **严格相邻** | agent 消息层 + `tools.guard` 双重：L1 只能调 L1 工具，L2/L3 越级直接拒 |
| **里程碑验收** | 里程碑完成未验收时，spawn/send 被硬 Gate 拦住；工具结果尾部实时显示进度 |
| **预算护栏** | token / 时长 / 文件数任一触顶 → run 自动暂停、执行类工具被拒 |
| **随时能停** | `/pipe-stop` 只冻结（磁盘全保留）、`/pipe-resume` 继续、`/pipe-off` 变回单 agent |

## 核心特性

| 能力 | 说明 |
|---|---|
| **三级模型路由** | L1=你在界面选的模型（主 agent，不一定是 pro）、L2=默认配置的模型（长活 subagent，可按模块覆盖，不一定是 flash）、L3=任意 OpenAI 兼容本地引擎 |
| **严格相邻** | agent 消息层 + `tools.guard` 双重强制，同级/越级禁止 |
| **二级长活** | L2 是长活 subagent，复用不重开，上下文累积 |
| **逐任务验收标准** | 每级下发的任务由**下发方现场生成**各自的验收标准，质量门按它打分 |
| **失败有界 + cannot-do** | L3 干不了明确回 `cannot-do`；输出错了重试 `maxLevel3Retries` 次，超限 L2 接管 |
| **批量 L3 执行** | `pipeline_execute_batch` 一次提交 N 个子任务，内部串行、一次返回，省 N 倍推理 token |
| **质量门跑代码断言** | 验收里有 `函数(参数)==期望` 就真跑（JS/TS 用 node、Python 用受控子进程）；**全部断言通过才算过**，没有断言才回退关键词分 |
| **按异常汇报 + 禁止轮询** | L1/L2 不轮询看板，靠 push 汇报，大幅省 token |
| **GUI 看板（v92/v94）** | Web UI 侧栏内嵌一张与「余额」卡同款的小卡：run 状态 / 里程碑 / 每层甜点区（绿黄红）/ 活跃 L2 与模型 / token 预算，模型看不到，用户随时看得见 |
| **每 L2 独立工作目录（v92）** | `pipeline_spawn_module_lead` 传 `scopeDir` → subagent 真实 `cwd` 隔离，多个 lead 不踩文件 |
| **每 L2 独立模型（v94）** | 同一个 lead 可传 `provider` / `model` 覆盖默认配置——难模块换更强模型，其余照旧省钱 |
| **里程碑状态机** | 里程碑完成 → 弹窗验收 → 落盘；未验收硬 Gate；冷启动自动恢复 |
| **预算护栏** | `maxTotalTokensPerRun` / `maxDurationPerRun` / `maxFilesPerRun`（0=不限） |
| **一次性激活 Gate** | 新工作区只问一次，答案按工作区记忆，之后不再打扰 |
| **健康自检** | `/pipe-selftest` 检查 subagents API、llm 服务、L3 引擎；启动时也会非阻塞 ping |
| **模块化解耦** | 15 个模块（最大约 600 行），`pnpm test` 串起 12 套 smoke 回归 |
| **四阶段工作流** | 引导开机 → 需求访谈 → 适配性评估 → 自适应调度 |

> 完整功能清单见 [CHANGELOG.md](CHANGELOG.md)，架构细节见 [docs/agent-lifecycle-design.md](docs/agent-lifecycle-design.md)。

## 安装

### 前置条件
1. **DSH** 已运行。
2. **本地推理引擎**：任意 OpenAI 兼容服务（llama.cpp / vLLM / Ollama / strata 等）。在 profile 的 `llm-pi-ai` 里声明 provider 后，用 `/pipe-config level3Endpoint` 与 `level3Model` 指向它；自检 `curl <endpoint>/models`，或直接 `/pipe-selftest`。
3. 默认的 L2 模型在 DSH 里可用（`deepseek-official` / `deepseek-flash`，可按模块覆盖）。

### 安装步骤
本插件是「目录」形式 bundle（`package.json` + `cordis.patch.yml` + `lib/` + `skills/`）：

- **方式 A（推荐）**：DSH 插件管理器 GUI 或 `plugin_manager install_bundle`，指向插件目录。
- **方式 B**：`dsh plugin add <绝对路径>`（需要 pnpm）。
- **方式 C（手动）**：junction 到 `profiles/<profile>/node_modules/dsh-tripipelines`，并在 profile 的 `cordis.patch.yml` 追加：
  ```yaml
  - insert:
      - id: pipeline
        name: 'dsh-tripipelines'
  ```

### 验证
新开会话输入 `/pipe-config`，能看到配置列表；`listTools` 里出现 `pipeline_*` 工具即成功。更完整：`/pipe-selftest`。

### ⚠️ 改代码后必须重装（Electron 缓存）
Electron 按「模块真实路径」缓存导入，且不支持非 Node 内置依赖。**每次改 `lib/*` 后**：复制到**全新目录** + 改包名后缀 + 重新安装（并移除旧 bundle），否则命中旧代码。

## 配置（`/pipe-config`）

```text
/pipe-config                    # 查看全部
/pipe-config <key>              # 查看单项
/pipe-config <key> <值>         # 修改单项
/pipe-config list               # 列出可配置项
/pipe-config reset              # 恢复默认
```

| 键 | 默认 | 说明 |
|---|---|---|
| `level1Model` | `deepseek-pro` | 一级模型（仅甜点区档案查询，不切换实际 L1） |
| `level2Provider` / `level2Model` | `deepseek-official` / `deepseek-flash` | 二级模型 |
| `level3Model` / `level3Endpoint` | 由配置指定 / **空**（必须显式配置） | 三级本地引擎（OpenAI 协议）；`level3Provider` 默认 `ninfer-local`，用 `/pipe-config level3Endpoint http://127.0.0.1:8080/v1` 指向本机引擎 |
| `level3Engine` | `auto` | 引擎提示（auto/ollama/vllm/llamacpp/openai-compat/other） |
| `maxCodeLines` | `100` | L3 交付代码行数上限 |
| `maxLevel3Retries` | `5` | L3 失败最大重试，超限 L2 接管 |
| `maxLevel3Concurrency` | `1` | L3 最大并发（本地单实例串行） |
| `maxLevel2Retries` | `3` | L2 最大尝试，超限上报 L1 |
| `maxLevel2Agents` | `10` | 二级模块负责人上限 |
| `level2ContextBudget` | `32000` | 二级上下文预算（模块小型化参考） |
| `level2SweetSpotRatio` | `0.25` | 二级甜点区占窗口比例（换模型自动重算） |
| `level2HandoffTtlMs` | `300000` | 旧二级交接存活毫秒（超时强制 drain） |
| `level1ContextBudget` | `64000` | 一级上下文甜点区（接近时建议 checkpoint） |
| `level1SweetSpotRatio` | `0.5` | 一级甜点区占窗口比例 |
| `level1ContextWarnRatio` | `0.8` | 一级上下文警告比例 |
| `autoTuneSweetSpot` | `true` | 换模型时自动联动甜点区 |
| `devDir` | `dev` | 开发过程文档目录（与生产文件分离） |
| `level3TimeoutMs` | `900000` | 三级子任务超时（=15 分钟） |
| `level3InputBudget` | `500` | 三级子任务输入 token 上限（超过自动压缩） |
| `level3MaxOutputTokens` | `4096` | 三级输出 token 上限 |
| `semanticGateThreshold` | `0.7` | 质量门阈值 |
| `mode` | `auto` | `auto`=按项目评估 / `on`=强制三级 / `off`=单 agent |
| `activationGate` | `true` | 新工作区一次性激活询问 |
| `maxTotalTokensPerRun` | `500000` | 单 run token 预算上限（0=不限） |
| `maxDurationPerRun` | `7200000` | 单 run 时长上限毫秒（2 小时，0=不限） |
| `maxFilesPerRun` | `200` | 单 run 改动文件数上限（0=不限） |

**配置分层**：`DEFAULT_CONFIG` < 传入 config < 全局 `~/.dsh/pipeline/config.json` < 项目级 `<devDir>/pipeline-project.json`。不同 `devDir` 互不污染。

**甜点区自适应**：换 `level1Model`/`level2Model` 时按 `MODEL_PROFILES` 档案（窗口 × 比例）自动重算预算；不在档案里则提示手动设。

## 使用

新开一个会话，直接描述你要做的东西（几句话，不用拆模块），主 agent 会自己走四阶段。

- 不需要三级：说「不用三级模式」或 `/pipe-config mode off`。
- 看状态：`/pipe-config` 或（L1）`pipeline_status`。
- 暂停/继续：`/pipe-stop` / `/pipe-resume`；彻底关掉：`/pipe-off`。
- 卡住了：`/pipe-research <议题>` 生成 7 步研讨骨架（见下方「知识层」）。
- 到里程碑：主 agent 弹窗问「我很满意 / 我要提出意见」；满意后旧 L2 无条件交接并灭活，新 L2 继续下一段。

## 工具面

| 工具 | 层级 | 作用 |
|---|---|---|
| `pipeline_lock_requirements` | L1 | 锁定需求，开 run（可带 `activation`） |
| `pipeline_plan` | L1 | 记录 TaskPlan（依赖 DAG + 环检测 + 里程碑声明） |
| `pipeline_spawn_module_lead` | L1→L2 | 生成长活模块负责人（默认配置的模型；可传 `scopeDir` 独立工作目录、`provider`/`model` 单独指定模型） |
| `pipeline_send_to_lead` | L1↔L2 | 复用二级发后续任务 |
| `pipeline_drain_leads` | L1 | 里程碑重建后释放旧二级 |
| `pipeline_checkpoint` | L1 | 写 10 节交接文档 + 冷启动 prompt |
| `pipeline_accept_milestone` | L1 | 记录里程碑用户验收 |
| `pipeline_selftest` | L1 | 健康检查（subagents / llm / L3 引擎） |
| `pipeline_classify` | L1 | 能力匹配分类（L1/L2/L3） |
| `pipeline_status` | L1 | 状态面板 / Trace / token 统计 |
| `pipeline_decompose` | L2 | 把模块拆成 L3 子任务 |
| `pipeline_execute_local` | L2→L3 | 同步派发单个 L3 子任务 |
| `pipeline_execute_batch` | L2→L3 | 一次提交 N 个子任务，内部串行一次返回（省推理 token） |
| `pipeline_spawn_local_executor` | L2→L3 | agent 式派发 L3（可选重路径） |
| `pipeline_review` | L2/L1 | 质量门（跑代码断言优先 + JSON + DoD；可传 `filePath`） |
| `pipeline_register_output` | L2 | L2 接管直写盘后回填看板 |
| `pipeline_scan` | L1 | 扫仓库生成知识库（index.md 骨架 + map.json 符号表 + 每模块一页） |
| `pipeline_ledger` | L1 | 从交接文档抽「关键决策/结论」候选，标出缺失字段待分类 |
| `pipeline_recall` | L1 | 在知识库内检索（中英关键词），返回 `file:line` + 片段，命中不到就说没有 |

## 知识层（v98）：让 L1 不靠暴力读源码

大型项目里，L1 最大的浪费不是写代码，而是**为了理解项目而把整个仓库读一遍**。知识层把这件事变成一次扫描 + 按需检索：

```
pipeline_scan(root=".")      # 一次机械扫描，产出 .dsh/pipeline/knowledge/
pipeline_scan(check=true)    # 只报哪些代码文件/模块页过期，不重写
pipeline_recall(query="backtest 引擎怎么调用核心")   # 每次只取命中片段
pipeline_ledger()            # 从交接文档抽决策候选
```

- `index.md`：一页骨架（仓库规模、模块清单与行数、模块角色、超大文件、TODO 计数、启动命令、近期提交）——**冷启动先读这一页**（stock 实测 ≈1.6K token）。
- `modules/<模块>.md`：每模块一页（角色、入口文件、公开接口、依赖、信号）。
- `map.json`：符号表（每个代码文件的 sha1 前缀、大小、行数），供后续做「代码变了但文档没变」的陈旧检测。
- 检索不到就返回「no hits」，不编造——知识层是机械抽取，不做语义判断。

### 专题研讨（`/pipe-research`）：瓶颈时开一次「有据可查的会」

知识库不是一次扫描就结束的静态快照，而是**跟着项目长出来的 wiki**：每次 `pipeline_scan` 刷新 `index.md` 与每模块一页，`pipeline_ledger` 把交接文档里的决策/结论沉淀成台账，`pipeline_recall` 让新会话在几行内找回上下文。项目越大、跑得越久，这层越值钱。

真正卡住的时候（架构摇摆、两个方案二选一、同一处反复返工、性能/兼容性取舍），不要靠「再读一遍代码」硬想：

```
/pipe-research 下一步投哪条路径
```

它会在 `<工作区>/.dsh/pipeline/knowledge/research/<日期>-<议题>.md` 生成一份 7 步研讨骨架：

1. **立项** —— 问题、成功判据（错了能被提前暴露）、预算
2. **证据** —— 每条带 `file:line` 或台账 `#n` 指针
3. **候选方案** —— ≥2 个，否则不叫决策
4. **反方** —— 每个候选最硬的反方理由 + 证据
5. **最小实验** —— 能区分候选的那一个
6. **建议** —— 带置信度，理由必须有数字或指针
7. **记录** —— 「错了会怎么暴露」，以及要回写台账的条目

模板自带三条防呆：无数值的理由删掉或补数字；带指针证据不足 3 条先去 `pipeline_recall`；没回答「错了会怎么暴露」不能当决策依据。研讨结论回写 `decisions.md`（或 checkpoint 的决策节），**v117 起 `pipeline_recall` 默认也会检索 `research/*.md`**——下次同一议题不用从头吵。

> 研讨层目前是手动触发：先跑 2~3 次，确认真能减少返工，再谈自动阈值。

### 隔离与检索语义（v118）

知识层天生要读项目、写知识库，所以 v118 把边界写成契约并用测试锁住：

- **只写当前工作区**：`pipeline_scan` / `pipeline_ledger` 的 `root`、`pipeline_checkpoint` 的 `path`、`pipeline_spawn_module_lead` 的 `resumeFrom` / `scopeDir`、`devDir` 配置都只接受工作区内的路径；绝对路径或 `..` 越界直接报错，不会在 B 项目里写入 A 项目的内容。
- **不碰项目仓库**：插件不创建 `decisions.md`、不写 `dev/`、不替项目做决策；项目自己维护的 `dev/decisions.md` 只会被只读检索。
- **检索结果带证据等级**：每条命中带 `kind`（`code` / `decision` / `candidate` / `research`），并返回 `coverage`（scan / modules / candidates / decisions / researchFilled / researchDrafts）、`partial`、`generatedAt`（取 scan 的 `hashes.json`，不是文件 mtime）、`rootMismatch`（知识库属于别的工作区时告警）。
- **未填完的研讨不参与检索**：只有第 7 节有正文的 `research/*.md` 才算已填，模板骨架不会被当成结论。
- **不猜工作区**：没有会话 cwd / 工作区根时工具直接报错，不再回退到进程 cwd 把状态写进 DSH profile 目录。

## 版本

- **包版本**（`package.json`）：语义化 `x.y.z`，市场/发布用。
- **迭代代号**（`vN`）：开发部署号，出现在部署目录与内部文档里（Electron 缓存要求每次改代码换新目录，见上方安装注意）。
- 完整历史见 [CHANGELOG.md](CHANGELOG.md)。

## 健壮性：抗阻塞与单点

- **L1 必须响应**：收到 L2 汇报必须回复（一行「继续」或重新锚定），绝不让 L2 干等。
- **L2 汇报自包含**：含「做完了什么 + 下一步 + 需要的决策」，L1 延迟回复也不丢进度。
- **持久化兜底**：看板 / trace / `l2_state.md` 全落盘，卡住能恢复。

> 诚实说明：L1 **彻底不可用**（模型挂了 / 会话断了）时没有替代者，这是「L1 唯一协调者」的固有单点，靠用户手动介入或重开会话兜底。其余情况不阻塞、不丢进度。

## 已知限制

1. **桌面端不能加载非内置依赖**：可视化设置页需要 `schemastery`，用 `/pipe-config` 命令代替。
2. **`deepseek-v4.1-flash` 不存在**，正确 id 是 `deepseek-flash`。
3. **Agent Teams teammate 不能指定模型**（继承父 agent 的模型），所以二级长活用 **continuable subagent**。
4. 质量门是「执行断言优先 + 语义关键词兜底」，断言 **fail-closed**：没有可用 runner、代码被静态安全门拦下、或任一断言失败，都判失败，不会回落关键词分。语义分本身封顶 0.5，默认阈值 0.7 下无法单独过门。
5. **JS/TS 与 Python 都支持**：JS 走 `node` 子进程，Python 走 AST 静态安全门 + 子进程；宿主机执行可通过 `allowCodeExecution=false` 整体关闭（关闭后含断言的验收一律不通过）。

## 目录结构

```
dsh-tripipelines/
├── package.json                          # 插件清单（dsh.bundle.patch → cordis.patch.yml；dsh.client → Web 状态条）
├── cordis.patch.yml                      # bundle 补丁（插入插件行）
├── client.js                             # Web UI 看板卡片（左侧栏底部，2.5s 轮询 /pipeline/board）
├── lib/
│   ├── plugin.js                         # 薄入口：name / inject / apply 装配、工具分发（~360 行）
│   ├── workspaces.js                     # 工作区注册表：root 归一化 / 会话归位 / 看板选工作区
│   ├── config.js                         # 模型档案 / 配置键 / 分层合并与迁移 / /pipe-config
│   ├── store.js                          # 看板 + run 状态机 + 预算 + 激活（全部落盘）
│   ├── gates.js                          # 质量门：执行断言 / DoD / 语义评分 / 任务校验
│   ├── prompts.js                        # 三级协议 / L2 提示 / L3 提示 / 技能正文（SKILL_BODY）
│   ├── util.js                           # 文本 / token 估算 / 压缩 / 语义评分等纯函数
│   ├── dsh-compat.js                     # DSH 版本差异适配（session / tokenMeter / 引擎探测）
│   ├── board-route.js                    # host 只读路由 GET /pipeline/board（看板数据快照）
│   ├── guards.js                         # 严格相邻 / 里程碑硬 Gate / 预算护栏
│   ├── knowledge/                        # 知识层：scan（机械索引）/ ledger（决策候选）/ recall（关键词检索）
│   └── tools/
│       ├── l1.js                         # L1 工具：lock/plan/status/spawn/send/drain/checkpoint/classify/selftest/accept
│       ├── l2l3.js                       # L2/L3 工具：decompose/execute_local/execute_batch/review/register/local_executor
│       └── knowledge.js                  # pipeline_scan / pipeline_ledger / pipeline_recall
├── skills/pipeline-orchestration/SKILL.md  # 编排技能
├── docs/agent-lifecycle-design.md        # 架构定稿
├── examples/                             # 一句话需求示例（可直接粘给 DSH）
├── QUICKSTART.md                         # 3 分钟上手
├── README.md                             # 本文档
├── TUTORIAL.md                           # 使用与配置教程
└── CHANGELOG.md                          # 版本日志
```

`pnpm test`（在 `plugins/dsh-tripipelines/` 下）一键跑 12 套回归：配置/项目分层 82 断言、控制面 49 断言、工具工厂装配探针、看板/目录隔离、知识层 15 断言、知识层加固 32 断言（含脱敏与 recall 路径围栏）、技能字节同步检查、工作区隔离 48 断言（含看板跟随当前工作区、切换器与折叠栏同步）、质量门与角色矩阵 34 断言、生命周期 16 断言（重 plan/验收确认/drain/重派发上限/计数持久化）、审计修复 28 断言、v112 回归 40 断言（实测计量 / 协议瘦身 / off 面）。

---

**Made with ❤️ by merhentz**

# 三级模型协作插件 —— 使用与配置教程

本插件 `dsh-tripipelines` 是一套在 DeepSeek Harness (DSH) 中运行的
**三级模型分层协作开发系统**。它已经安装并激活在你的桌面端里，无需重启即可使用。
> Level-3 走任意 **OpenAI 兼容**本地引擎（llama.cpp / vLLM / Ollama / strata 等）：端点用 `level3Endpoint`、模型用 `level3Model`，`/pipe-selftest` 会探测 `/v1/models`。
> 适配 DSH 新版 subagents API（`startActivation` / `drainChildren`）；插件名 `dsh-tripipelines`、命令 `/pipe-*`、工具 `pipeline_*`，代码拆成 `lib/` 下多个模块。

---

## 0. 一分钟看懂它是什么

```
Level 1（主模型 / 协调者）    Level 2（副模型 / 模块负责人）     Level 3（本地模型 / 执行器）
   规划 · 分解 · 验收   ──▶      再分解 · 写主代码 · 审核  ──▶   只跑极简子任务
 你在界面选的模型              默认 deepseek-flash（可按模块覆盖）  level3Model（如 qwen3.8-27b…）
```

- **指令自上而下**：L1 分配模块任务 → L2 拆成 ≤200 token 的子任务 → L3 执行。
- **信息自下而上**：L3 返回结果 → L2 审核 → L1 验收。
- **任务状态机**：`pending → in_progress → review → done`（失败则 `failed` 后重新分配）。
- **上游失败阻断下游**：依赖未完成 / 审核不通过，下游任务不会启动。
- **失败有界**：三级子任务失败 ≤ `maxLevel3Retries` 次，超限升级不重试。

> 说明：插件提供两条执行路径——**工具式**（主 agent 直接调 `pipeline_*` 工具）与
> **agent 层级式**（continuable subagent 长活二级 + one-shot 三级，真子 agent）。
> 两者都受「严格相邻」约束：一级禁止直接调二/三级工具，只能 spawn/send 二级。
> 完整架构见 `docs/agent-lifecycle-design.md`。

---

## 0.5 四阶段工作流（新项目自动走）

新项目启动后，主 agent（唯一跟用户对话的 agent）会按下面流程走，无需你手动指挥：

1. **引导开机**：主动贴出当前三级模型 + 可复制的改模型命令（如 `/pipe-config level2Model deepseek-flash`），并告知「不需要三级就回复『不用三级模式』或 `/pipe-config mode off`」。
2. **需求访谈**（多轮）：用 5 Whys → MoSCoW 范围 → 模块/依赖 → INVEST + Given-When-Then 验收 → 约束，逐轮追问直到每个模块都能机械验收。
3. **适配性评估**：主动告诉你该不该用三级——「多模块/多纯函数/依赖 DAG/看重成本」适用；「单文件小脚本/需求模糊/无本地 ninfer/强耦合」不适用，并给关闭方式。
4. **自适应调度**：按需求拆模块（规模→模块数推荐：单文件 1 个、3–8 文件 2–3 个、多子系统 4–8 个；≥3 个独立关注点必须 ≥3 个 L2） → 每模块 spawn 一个长活二级（复用）→ 二级分解写码、极简单函数下沉三级 → 依赖 DAG 排序 → `pipeline_classify` 路由。

---

## 1. 工具（这是你实际要调用的东西）

| 工具 | 层级 | 作用 |
|---|---|---|
| `pipeline_lock_requirements` | L1 | 需求确认后锁定，生成 `requirement_lock.json`，开启一个 run（可带 `activation` 激活答案） |
| `pipeline_plan` | L1 | 提交并校验结构化 TaskPlan（任务分解 + 里程碑声明 `milestones`） |
| `pipeline_spawn_module_lead` | L1→L2 | 生成长活二级（continuable subagent；默认配置模型，可传 `provider`/`model` 覆盖） |
| `pipeline_send_to_lead` | L1↔L2 | 复用长活二级发后续任务（不重开） |
| `pipeline_drain_leads` | L1 | 里程碑重建后释放一批旧二级 |
| `pipeline_checkpoint` | L1 | 写项目交接文档（10 节契约）+ 冷启动 prompt |
| `pipeline_accept_milestone` | L1 | 记录里程碑用户验收（全部任务 done 后置 accepted） |
| `pipeline_selftest` | L1 | 健康检查：subagents API / llm / L3 引擎 `/v1/models` |
| `pipeline_decompose` | L2 | 把单个任务拆成极简子任务（≤200 token / ≤10 行） |
| `pipeline_spawn_local_executor` | L2→L3 | 生成一次性三级执行器（provider 取 `level2Provider`，agent 式重路径） |
| `pipeline_execute_local` | L3 | 在本地引擎上执行**一个**子任务（L1 压缩，文本进→JSON 出，失败计数） |
| `pipeline_execute_batch` | L2→L3 | 一次提交 N 个子任务，工具内部**串行**执行并一次返回（每任务独立 15 分钟看门狗，失败不连锁；`maxBatchMs` 可选护栏只停派新任务） |
| `pipeline_review` | L2/L1 | 质量门控审核（断言执行 fail-closed + JSON 校验 + 语义评分兜底；可传 `filePath` 读真实文件） |
| `pipeline_register_output` | L2 | L2 接管直写盘后，把代码回填看板（可传 `filePath`） |
| `pipeline_classify` | L1 | 能力匹配分类器（工具需求/规模/可验证性/架构 → L1/L2/L3） |
| `pipeline_scan` | L1 | 机械扫描仓库 → 知识库 `index.md` + `map.json`（+ 每模块一页）；`check:true` 只报陈旧 |
| `pipeline_ledger` | L1 | 从已有文档抽决策候选（KEEP/REVIEW/DROP 三档） |
| `pipeline_recall` | — | 知识库里按关键词检索，返回 `file:line` 命中 |
| `pipeline_status` | — | 查看状态面板、消息 Trace、token 统计（含 failCount） |

> **严格相邻**：一级（主 agent）**无权调用** `pipeline_decompose`、`pipeline_execute_local`、
> `pipeline_execute_batch`、`pipeline_spawn_local_executor`（由 `tools.guard` 运行时拒绝，系统提示词提前告知）。
> 一级要触达二级/三级能力，只能 `pipeline_spawn_module_lead` / `pipeline_send_to_lead` 委托二级。

---

## 2. 安装

### 2.1 桌面端（当前运行的应用）

本仓库的发布脚本会把 `plugins/dsh-tripipelines/` 复制为 `~/.dsh/dsh-tripipelines-vNN` 快照再安装；实际装的是哪个版本，以插件管理器 `list_plugins` 的显示为准（版本号见 `package.json`）。已装好就跳到第 4 节；升级见第 7 节。

> 说明：包名带 `-vN` 后缀是为了绕过 Electron 进程的模块缓存——**每次改代码都要复制到新目录、把包名 `-vN` 加 1、再重装**（install 新版 → remove 旧版 → 对新版 enable/disable 一次）。只改目录不改包名，DSH 仍会加载旧缓存。

### 2.2 Web 配置档（CLI 启动的 `dsh web`）

桌面端默认不带 Web 档的安装。若要在 `dsh web` 里使用，任选一种方式：

```bash
# 方式 A：官方插件管理器（需要 pnpm 在 PATH）
dsh plugin --profile web add <本插件目录的绝对路径>

# 方式 B：手动（junction + patch）
# 1) 把插件目录 link 到 profiles/node_modules/
# 2) 在 profiles/web/cordis.patch.yml 末尾加：
#    - insert:
#        - id: pipeline
#          name: 'dsh-tripipelines'
```

> 装好后用 web 档新开会话，`listTools` 里应出现 `pipeline_*`；若没有，确认 `profiles/web/cordis.patch.yml` 里确实有 `pipeline` 行。

---

## 3. 配置（用 `/pipe-config` 命令，桌面端可用）

现在不用改文件，直接在聊天输入框输入命令即可，改完即时生效、持久化到
`~/.dsh/pipeline/config.json`，重启后仍生效。

```text
/pipe-config                         # 查看全部配置
/pipe-config <key>                   # 查看单项
/pipe-config <key> <值>              # 修改单项
/pipe-config list                    # 列出可配置项
/pipe-config reset                   # 恢复默认
```

示例：

```text
/pipe-config level3Model qwen3.8-27b-gsq-rco-iq3-s-mtp
/pipe-config level2Model deepseek-flash
/pipe-config semanticGateThreshold 0.6
/pipe-config maxLevel2Agents 4
/pipe-config level3Compression L0
```

### 3.1 全部配置项

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `level2Provider` | `deepseek-official` | 二级模型 provider |
| `level2Model` | `deepseek-flash` | 二级模块负责人模型 |
| `level3Model` | `qwen3.8-27b-gsq-rco-iq3-s-mtp` | 三级本地模型（ninfer） |
| `level3Endpoint` | 空（必须显式配置） | OpenAI 兼容接口基址，例如 `http://127.0.0.1:8080/v1` |
| `level3Provider` | `ninfer-local` | agent 式 L3 执行器使用的 LLM provider |
| `spawnProvider` | `spawn` | subagent provider 名（一般不用改） |
| `level3InputBudget` | `1200` | 三级子任务输入 token 上限（超限先压缩，仍超则提示拆分） |
| `level3MaxOutputTokens` | `4096` | 三级输出 token 上限 |
| `semanticGateThreshold` | `0.7` | 质量门评分阈值（0~1） |
| `maxCodeLines` | `100` | 三级子任务代码行数上限 |
| `maxLevel3Retries` | `5` | 三级子任务最大重试次数（超限升级不重试） |
| `maxLevel3Concurrency` | `1` | 三级本地执行器最大并发（ninfer 单实例串行） |
| `maxLevel2Retries` | `3` | 二级接管/任务最大尝试次数（超限上报 L1 干不了） |
| `maxLevel2Agents` | `10` | 二级模块负责人数量上限 |
| `activationGate` | `true` | 是否要求新工作区首次激活询问（A 启用 / B 普通 / C 记住） |
| `maxTotalTokensPerRun` | `500000` | 单次 run 的 token 预算上限（0=不限，超限自动暂停） |
| `maxDurationPerRun` | `7200000` | 单次 run 时长上限，毫秒（0=不限，超限自动暂停） |
| `maxFilesPerRun` | `200` | 单次 run 改动文件数上限（0=不限，超限自动暂停） |
| `level3Engine` | `auto` | L3 引擎类型提示（auto/ollama/vllm/llamacpp/openai-compat/other；统一走 OpenAI 兼容接口） |
| `mode` | `auto` | 三级模式开关（`auto`=按项目评估，`on`=强制，`off`=单 agent） |
| `level3Compression` | `L1` | 压缩层级（`L1`=关键事实提取，`L0`=全文） |
| `devDir` | `dev` | 开发过程文档目录（checkpoint / L2 state / 交接文件，与生产文件分离） |

> **为什么 L2 不能配置 maxToken 和行数？**
> L2 是 DSH 的 subagent（continuable），它的模型由 `level2Model` 指定，但**输出 token 数由 DSH 自己控制**（`agentOptions.maxTokens`），插件不干预。行数上限（`maxCodeLines`）只对 L3 有意义——L3 是「本地模型直出代码字符串」，能数行数；L2 是「agent 用工具直接写文件」，没有「单次输出的行数上限」这个概念。所以配置里只有 `level2Model`/`level2Provider`（指定用哪个模型），没有 `level2MaxTokens`/`level2MaxCodeLines`。

> 注意：`deepseek-v4.1-flash` 实测在 `deepseek-official` 上不存在，用 `deepseek-flash`。

### 3.2 换一个本地模型

```bash
# 1) 启动任意 OpenAI 兼容引擎（llama.cpp / vLLM / Ollama / strata…），记下 baseURL
# 2) 在 profile 的 llm-pi-ai 里声明该 provider（baseURL 指向 /v1）
# 3) 让插件指向它：
/pipe-config level3Endpoint http://127.0.0.1:8080/v1
/pipe-config level3Model <该引擎的模型 id>
/pipe-selftest            # 探测 /v1/models 确认可达
```

---

## 4. 使用

### 4.1 完整工作流

直接对主模型（L1）说类似的话即可，它会按流程自动调用工具：

> “用三级模型协作开发一个加减法计算库，先锁定需求再规划。”

主模型会自动执行以下 6 步。下面给出每一步的**工具输入 / 输出示例**，供你理解或手动调用。

### 4.2 第 1 步：锁定需求

```
工具: pipeline_lock_requirements
输入:
{
  "requirement": "开发一个加减法计算库",
  "scope": "演示",
  "constraints": ["Python"],
  "reuseNote": "调研后无现成方案，需自研",
  "activation": "enable"
}
输出:
{
  "run_id": "run-1791953918035-b9aa8dc4",
  "requirement": "开发一个加减法计算库",
  "lockedAt": "2026-...",
  "activationHint": "（首次工作区时才出现：请先询问用户 A 启用 / B 普通 / C 记住）"
}
```

- 锁定后生成**工作区**内的 `.dsh/pipeline/requirement_lock.json`（v83 起按工作区隔离，不再是全局 `~/.dsh/`），之后**系统自持运行**，只在索取凭据时才联系你。
- `activation`（v89）：`enable`/`normal`/`remember` 承接一次性激活询问的答案；工作区已记录选择后可省略。

### 4.3 第 2 步：规划任务（L1）

```
工具: pipeline_plan
输入:
{
  "taskPlan": {
    "tasks": [
      { "id": "T1", "desc": "实现加法函数 add(a,b)",
        "assignee": "calculator",
        "acceptance": "add 函数返回两数之和",
        "depends_on": [] },
      { "id": "T2", "desc": "实现减法函数 sub(a,b)",
        "assignee": "calculator",
        "acceptance": "sub 函数返回两数之差",
        "depends_on": ["T1"] }
    ],
    "milestones": [
      { "id": "M1", "name": "核心函数可用", "taskIds": ["T1", "T2"] }
    ]
  }
}
```

- `assignee` 由 L1 按职责**自由命名**（如 `calculator` / `backend` / `frontend`），同一模块同名、不同模块不同名即可；上限见 `maxLevel2Agents`（默认 10）。
- `milestones`（v89，可选）：声明里程碑及其包含的 taskIds；任务全 `done` 后里程碑自动 `done`，用户验收后调 `pipeline_accept_milestone`。
- `acceptance` 必须**可机械检查**（如“JSON 可解析”“返回正确和值”）。
- `depends_on` 声明依赖：`T2` 依赖 `T1`，所以 `T1` 完成前 `T2` 不能开始。

### 4.4 第 3 步：分解任务（L2）

```
工具: pipeline_decompose
输入: { "taskId": "T1" }
输出:
{
  "ok": true,
  "taskId": "T1",
  "subtasks": [ { "id": "T1-s1", "desc": "实现加法函数 add(a,b)" } ]
}
```

如果此时去分解 `T2`（依赖 `T1` 未完成），会返回：

```json
{ "ok": false, "blocked": true, "taskId": "T2", "waitingFor": ["T1"] }
```

—— 这就是**上游失败/未完成阻断下游**。

### 4.5 第 4 步：本地执行（L3）

```
工具: pipeline_execute_local
输入: { "subtaskId": "T1-s1" }
输出:
{
  "ok": true,
  "subtaskId": "T1-s1",
  "state": "review",
  "code": "function add(a, b) {\n  return a + b;\n}",
  "status": "done",
  "compressed": true,          // 已做 L1 压缩
  "usage": { "promptTokens": 108, "completionTokens": 528 }
}
```

这一步真正调用本地 ninfer（`qwen3.8-27b-gsq-rco-iq3-s-mtp`，OpenAI `/v1/chat/completions`），纯文本进、结构化 JSON 出，**不调用工具**。

### 4.5.1 批量执行（v88，L2 有多个子任务时推荐）

多个子任务时用 `pipeline_execute_batch` 一次提交：工具内部**串行**执行，全部跑完一次返回，L2 只推理一轮，省推理 token。

```
工具: pipeline_execute_batch
输入:
{
  "tasks": [
    { "id": "T1-s1", "desc": "实现加法函数 add(a,b)", "acceptance": "add(2,3)==5" },
    { "id": "T1-s2", "desc": "实现减法函数 sub(a,b)", "acceptance": "sub(2,3)==-1" }
  ],
  "maxBatchMs": 0
}
输出:
{ "total": 2, "done": 2, "failed": 0, "remaining": 0, "results": [ /* 每项结构与单任务返回一致 */ ] }
```

- 每个任务仍走自己的 `level3TimeoutMs`（15 分钟）看门狗；某个任务失败/超时/cannot-do 只记入该任务结果，**不连锁**、后续任务继续跑。
- `maxBatchMs` 默认 `0`=无总时长护栏；`>0` 时到点只**停止派新任务**（未派发的计入 `remaining`），绝不中断已在跑的任务。

### 4.6 第 5 步：审核（L2 → L1）

```
工具: pipeline_review
输入: { "subtaskId": "T1-s1" }     # L2 审核 L3 产出
输出:
{
  "level": 3, "id": "T1-s1", "ok": true, "score": 0.9, "state": "done",
  "checks": [
    { "name": "json-validity", "pass": true },
    { "name": "subtask-id-match", "pass": true },
    { "name": "non-empty-code", "pass": true },
    { "name": "code-lines<=100", "pass": true },
    { "name": "status-in-enum", "pass": true },
    { "name": "semantic-score>=0.7", "pass": true, "score": 0.9 }
  ]
}
```

子任务全部 `done` 后，再审核模块任务（L1 审核 L2）：

```
工具: pipeline_review
输入: { "taskId": "T1" }
```

审核不通过 → 状态 `failed`，可重新分配；通过 → `done`。

### 4.7 第 6 步：查看状态

```
工具: pipeline_status
输入: {}
输出（摘要）:
{
  "taskStates":     { "pending":0, "in_progress":1, "review":0, "done":1, "failed":0 },
  "subtaskStates":  { "pending":1, "in_progress":0, "review":0, "done":1, "failed":0 },
  "counters":       { "llmCalls":1, "tokensIn":108, "tokensOut":528 },
  "budget":         { "mode":"normal", "withinBudget":true },
  "acceptance":     { "A3_task_state_machine":true, "A4_context_compression":true, ... }
}
```

### 4.8 卡住的时候：开一次专题研讨（`/pipe-research`）

写代码拆得再细，也挡不住「往哪走」这类架构分叉。这时不要靠再读一遍仓库硬想——知识库里已经攒了 index、模块页和决策台账，缺的只是把讨论过程钉下来：

```
/pipe-research 你的问题
```

它会在 `<工作区>/.dsh/pipeline/knowledge/research/<日期>-<议题>.md` 生成一份 7 步研讨骨架（立项 → 证据 → 候选 → 反方 → 最小实验 → 建议 → 记录），并附三条防呆：理由必须带数字或 `file:line` 指针、带指针证据不足 3 条先去 `pipeline_recall`、必须回答「错了会怎么暴露」。

用法上它是一张**会议议程**，不是自动结论：

1. 先 `pipeline_recall("<议题关键词>")`，把已有证据带指针贴进第 2 步（不凭记忆复述数字）；
2. 候选不足两个就补，反方理由写最硬的那条，别写稻草人；
3. 结论回写 `decisions.md` 或 `pipeline_checkpoint` 的决策节，下次 `pipeline_recall` 能直接检索到（v117 起 `research/*.md` 默认参与检索）。

---

---

### 4.9 隔离与检索语义（v118）

- 插件只写当前工作区的 `.dsh/pipeline/`（以及 devDir 里的流程文档）；`pipeline_scan` / `pipeline_ledger` 的 `root`、`pipeline_checkpoint` 的 `path`、`resumeFrom`、`scopeDir`、`devDir` 都只能在作区内，绝对路径或 `..` 会直接报错。
- 插件不创建、不修改项目自己的 `decisions.md`；项目里有 `dev/decisions.md` 时，`pipeline_recall` 只读它。
- `pipeline_recall` 的每条命中带 `kind`：`code`（index / 模块页）、`decision`（decisions.md）、`candidate`（ledger-candidates.md）、`research`（研讨笔记）。看到 `candidate` / `research` 别当已拍板结论用。
- 返回里还有 `coverage`、`partial`、`generatedAt`（来自 `hashes.json`，不是 mtime）、`rootMismatch`。没有 `index.md` 但已有研讨笔记时 `partial:true`，仍可检索；从未扫描过则明确报「knowledge base empty」。
- 没填完的研讨草稿（第 7 节没正文）不会出现在检索结果里——先填完再指望它被找回来。

## 5. 状态机与 Trace（审计）

每个状态转移都会写一条消息（含消息头 `sender/state/group_id` 和消息体
`message_type/next_speaker/task_id/task_desc/task_conclusion/acceptance_criteria`），
追加到：

```
<工作区>/.dsh/pipeline/trace-<run_id>.jsonl   # 完整 Trace
<工作区>/.dsh/pipeline/board.json             # 当前面板快照
<工作区>/.dsh/pipeline/requirement_lock.json  # 需求锁定
<工作区>/.dsh/pipeline/run.json               # run 状态机快照（v89）
<工作区>/.dsh/pipeline/activation.json        # 激活选择（v89）
```

用 `meta.run_id`（= 上面的 `run_id`）即可回查整条链路。

---

## 6. 纪律（已内置，无需手动执行）

- **工具验证事实**：每条可机械检查的承诺都有验收项兜底。
- **角色边界**：L1 不写码；L3 不调用工具、不改架构；L3 产出由 L2 审核、L2 产出由 L1 审核。
- **上游失败阻断下游**：依赖失败 → 下游不启动（质量门控通过才放行）。
- **需求锁定**：锁定后不再向用户索取信息（凭据除外）。

---

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 工具不出现（`listTools` 里没有 pipeline_*） | bundle 未启用；用插件管理器确认 `dsh-tripipelines` 为 enabled，或重装 |
| 提示 `order must be a finite number` | 旧缓存版本；已通过 `-vN` 改名解决。如再遇到，重装即可 |
| `pipeline_execute_local` 报 `level3Endpoint 未配置` / `connection refused` | 先 `/pipe-config level3Endpoint http://127.0.0.1:<port>/v1` 指向你的引擎，并确认 `/v1/models` 可访问 |
| 报模型不存在 | 把 `level3Model` 改成 ninfer 已加载的模型 id（`/v1/models` 里可见） |
| 一级调二/三级工具被拒（「已被守卫拦截」） | 正常：一级只能 `pipeline_spawn_module_lead`/`pipeline_send_to_lead` 委托二级；不要重试 |
| 三级子任务反复失败 | 受 `maxLevel3Retries`(5) 限制，超限返回 `escalated:true` 并升级到二级接管，不会无限重试 |
| 三级模型输出不是 JSON | 已用 `format:json` + 容错解析（剥 markdown 围栏/取花括号）；仍失败会返回 `local model returned non-JSON` |
| 子任务被拒（token 超限） | 子任务输入超过 `level3InputBudget`(500)；把任务描述拆得更细，或调大上限 |
| 语义评分偏低导致 `failed` | `acceptance` 关键词与产出不匹配；用「函数名 + 返回什么」这类具体措辞，或降低 `semanticGateThreshold` |

---

## 8. 验证

安装后验证：

1. 新会话输入 `/pipe-config`，能列出配置项即插件已激活；
2. `listTools` 里应有 `pipeline_*` 工具；
3. 直接描述一个任务（如「做一个加密解密 CLI」），看主 agent 是否自动走四阶段流程。

> 说明：语义评分是确定性的「结构 + 词干关键词覆盖」代理（结构 60% + 关键词 40%），
> 阈值默认 0.7；v104 起该代理**封顶 0.5**，因此没有可执行断言时无法单独过门——这是有意的 fail-closed：
> 要过质量门，验收里请写 `函数(参数)==期望`（JS 与 Python 都支持），或显式把 `semanticGateThreshold` 调到 0.5 以下。

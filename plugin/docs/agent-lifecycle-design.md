# 三级 Agent 协作架构（最终定稿）

本插件实现「三级模型协作开发」：一级 pro 主 agent 规划调度，二级 flash 模块负责人写码，三级本地 ninfer 执行器干具体小活。本文档是最终架构定稿。

---

## 0. 设计原则

1. **三级固定模型**：L1=你在界面选的模型、L2=flash、L3=本地，每层模型固定（配置项，不是逐任务决策）。
2. **严格相邻**：L1↔L2↔L3 逐级，同级/越级禁止；用户(L0)只和 L1 对话。
3. **领导抓大放小**：L1 只做关键决策（拆模块、判断、验收），不事无巨细。
4. **能下沉就下沉**：纯活尽量给本地 L3，少让 L2 接手、少让 pro 介入。
5. **按异常汇报**：正常进度不打扰上级，出问题第一时间上报。
6. **省 token 优先**：不轮询、不重复、每层只背自己用得到的信息。

---

## 1. 三级拓扑 + 严格相邻

```
用户(L0) ──只和一级对话──▶ L1(你选的模型) ◀──汇报节点迭代──▶ L2(flash) ──强制下发──▶ L3(本地)
```

| 层级 | 模型 | 机制 | 只能和谁沟通 |
|---|---|---|---|
| L0 用户 | — | — | 只和 L1 |
| L1 | 你选的模型（主 agent） | 规划·验收·判断 | L0(用户) + L2 |
| L2 | flash | continuable subagent（长活） | L1 + L3 |
| L3 | 本地 ninfer | one-shot 执行器 | 只 L2 |

**严格相邻三层强制**：
1. agent 消息层：DSH `subagents.sendMessage` 只允许「直接父/直接子」，同级/越级硬拒。
2. 工具层：`tools.guard` 拦 L1 直接调二/三级工具；v84 起新版 `SubagentStartRequest` 删除了 `toolFilter`，L2/L3 的越级调用改由同一守卫按「根 agent 判定 + 已登记 lead/executor」拒绝，摘掉 L1 专属工具 + 面向用户工具（`ask_user_question`/`present`）。

---

## 2. 模型路由

| 层级 | provider | model | 谁决定 |
|---|---|---|---|
| L1 | 界面选择器 | 用户选的任意模型 | 固定 |
| L2 | `level2Provider` | `level2Model`（deepseek-flash） | 固定配置 |
| L3 | 任意 OpenAI 兼容引擎（profile 的 llm-pi-ai 注册） | `level3Model`（如 qwen3.8-flash-next-iq3_xxs） | 固定配置 |

「能力匹配」是**把任务路由到哪一层**（`pipeline_classify`），不是「给某层挑模型」。

---

## 3. Agent 机制

- **L2 = continuable subagent（长活）**：`pipeline_spawn_module_lead` 生成（v84 起走 `subs.startActivation`），`agentOptions` 指定 flash；`pipeline_send_to_lead` 复用（不重开），上下文累积。
- **L3 = one-shot**：默认走轻量工具路径 `pipeline_execute_local`（单次 OpenAI `/v1/chat/completions` 请求，L3 吐完整代码）；`pipeline_spawn_local_executor`（agent 式真 subagent，provider 取 `level2Provider`）作可选重路径。

---

## 4. L2 → L3 下放规则（硬规则）

> 子任务满足**全部**：**单文件/小特性**（无网络、无外部工具、不多文件）、≤ `maxCodeLines`(100) 行、有可机械验收标准 → **必须下放 L3**（L2 不允许自己写）。
> 否则（网络/外部工具/多文件/无验收）→ L2 自己写。

- **降低 L2 接手**：L3 输出错了也允许重试（`pipeline_review` 语义门不过 → 标记 pending 可重试，而非直接 failed），`maxLevel3Retries`(5) 次后才 L2 接管。
- **L3 干不了 → cannot-do 反馈**：L3 明确回 `{"status":"cannot-do","reason":...}`，工具检测后立即返回 `cannotDo:true` 给 L2（不重试），L2 接管。
- **L2 接管后回填**：`pipeline_register_output(subtaskId, code)` 把 L2 直写的代码回填看板，避免看板误报「无代码」。

---

## 5. 汇报节点迭代 + 重新锚定（L1↔L2）

- L1 给每个模块设 **2-3 个关键节点**；L2 只在关键节点或异常时上报（正常进度不打扰）。
- 异常（失败/阻塞/偏离规格）**无次数上限，必须立即上报**。
- L1 收到汇报才判断：「一切正常」回一句「继续」；异常才真正调整。
- **每个节点 L1 重新锚定 L2**：(1) 你到了哪、(2) 下一步干什么、(3) 总目标——防小模型（flash）跑偏/失忆。
- 最终验收时 L1 才跨模块汇总。

---

## 6. 逐任务验收标准

- 每级下发任务时，**由下发方现场生成该任务自己的验收标准**（各不同、不继承），作为 `acceptance` 参数传递。
- 质量门（`pipeline_review`）：JSON 合法性 + 非空代码 + 行数 ≤ `maxCodeLines` + status 枚举 + 评分 ≥ `semanticGateThreshold`。
- 评分是「执行断言优先」：验收里有 `函数(参数)==期望` 就真跑 Python 验证（`passed/总数` 为分）；没有断言（或 Python 不可用）才回退到确定性语义分（结构 60% + 词干 40%，对措辞长度不敏感）。

---

## 7. 失败有界 + 升级阶梯 + L3 超时看门狗

```
L3 失败/出错 → 重试(≤ maxLevel3Retries) → 仍失败 → L2 接管(回填看板) → L2 再试(≤ maxLevel2Retries) → 仍失败 → 上报 L1
```

- `failCount` 跟踪每次失败；超限返回 `escalated:true`，之后调用被「only pending can execute」硬拦。
- **L3 超时看门狗**：`level3TimeoutMs`（默认 900000=15 分钟）到点 → `AbortController` 掐断客户端请求 → 走上面的失败重试链。ninfer 为单实例串行（`maxLevel3Concurrency` 默认 1），并用 `max_tokens` 封顶输出；v84 不再需要 `ollama stop`。
- **防死循环双保险**：`num_predict` 封顶输出 + `think:false` 关闭 `qwen3` 的 thinking 模式（推理模型的「思考」耗光 GPU/token 是死循环、不输出的根因）。

---

## 8. 四阶段工作流（技能内置）

```
Phase 0 引导开机 ──▶ Phase 1 需求访谈 ──▶ Phase 2 适配性评估 ──▶ Phase 3 自适应调度
```

- **Phase 0**：主 agent 主动贴当前三级模型 + 可复制的改模型命令 + 「不需要就说不用三级/`mode off`」。
- **Phase 1**：多轮访谈（5 Whys → MoSCoW → 模块/依赖 → INVEST+Given-When-Then → 约束），直到每个模块可机械验收。
- **Phase 2**：主动告知该不该用三级；不适用则建议单 agent + 给关闭方式。
- **Phase 3**：拆模块 → 每模块 spawn 一个长活 L2 → L2 按硬规则下放 L3 → 依赖 DAG 排序 → 最终验收。

---

## 9. 审计（board / trace / 生命周期）

- **统一 trace**：工具式路径（task_assignment/task_result/review_result）和 agent 式路径（agent_spawn/agent_send/agent_spawn_l3/agent_l3_result）都写同一条 `trace-<run_id>.jsonl`。
- **board 生命周期**：`agents` 集合记录 L2/L3 的 `in_progress → done/failed`；L3 的 code/status 解析后回填。
- **看板是给 L1 终审的全局快照**，不是给 L2 追踪进度的（L2 靠派发工具的同步返回值）。
- **状态按工作区隔离（v83）**：`board.json` / `requirement_lock.json` / `trace-*.jsonl` / L3 断言执行目录统一落在运行时状态目录 `runtimeStateDir()` = `<process.cwd()>/.dsh/pipeline`；多项目并行各自锁需求、各自看板，互不覆盖。`config.json` 仍全局唯一（`~/.dsh/pipeline/config.json`），项目级覆盖仍走 `<devDir>/pipeline-project.json`。
- **成本分账**：`counters` 按层记录 `l2Spawns`/`l2Sends`（二级）与 `l3Calls`/`l3TokensIn`/`l3TokensOut`（本地模型精确 token），`pipeline_status` 展示。
- **文件真相**：`pipeline_review`/`pipeline_register_output` 支持 `filePath`，评审可读磁盘真实文件而非看板投影代码。

---

## 10. 省 token（贯穿始终）

1. **禁止轮询**：L1 等 push 汇报（只在终审查板）；L2 被 deny `pipeline_status`（靠工具返回值）。
2. **按异常汇报**：正常进度不打扰上级。
3. **系统提示词压缩**：只留 5 句核心（三级角色、工具边界、禁止轮询、模式+重试+阈值、纪律）。
4. **工具 description 精简**：每个一句话。
5. **分层提示词**：L2 只背局部协议，L3 只背「完成一个任务、返回 JSON」，不背整棵树。
6. **L3 轻量工具路径**：单次 HTTP，不 spawn 重 subagent。
7. **L2 自压缩**：L2 保持运行摘要 + 节点落盘，从重新锚定重建记忆，上下文不腐坏。
8. **L2 批量执行（v88）**：多个 L3 子任务用 `pipeline_execute_batch` 一次提交，工具内部串行跑完再一次返回，L2 只推理 1 次而不是 N 次。

---

## 11. 配置项（默认值）

| 键 | 默认 | 说明 |
|---|---|---|
| `level1Model` | `deepseek-pro` | L1 模型名（仅用于甜点区档案查询，不切换实际 L1 模型） |
| `level2Provider` / `level2Model` | `deepseek-official` / `deepseek-flash` | 二级模型 |
| `level3Model` / `level3Endpoint` | `qwen3.8-27b-gsq-rco-iq3-s-mtp` / `http://127.0.0.1:18200/v1` | 三级本地模型（ninfer，OpenAI 协议） |
| `maxCodeLines` | `100` | L3 交付代码行数上限 |
| `maxLevel3Retries` | `5` | L3 最大重试次数 |
| `maxLevel3Concurrency` | `1` | L3 本地执行器最大并发（ninfer 单实例串行） |
| `maxLevel2Retries` | `3` | L2 接管/任务最大尝试次数 |
| `maxLevel2Agents` | `10` | L2 数量上限 |
| `level2ContextBudget` | `32000` | L2 上下文 token 预算（flash 甜点区） |
| `level2HandoffTtlMs` | `300000` | 旧 L2 交接存活毫秒（=5 分钟） |
| `level1ContextBudget` | `64000` | L1 上下文 token 甜点区 |
| `level1SweetSpotRatio` / `level2SweetSpotRatio` | `0.5` / `0.25` | 甜点区占模型窗口比例（L1 / L2，换模型时联动） |
| `autoTuneSweetSpot` | `true` | 换模型时自动联动甜点区 |
| `level3TimeoutMs` | `900000` | L3 超时毫秒（=15 分钟） |
| `semanticGateThreshold` | `0.7` | 质量门评分阈值 |
| `mode` | `auto` | auto/on/off |

> **为什么 L2 不能配置 maxToken 和行数？** L2 是 DSH 的 subagent（continuable），模型由 `level2Model` 指定，但**输出 token 数由 DSH 自己控制**（`agentOptions.maxTokens`），插件不干预。行数上限（`maxCodeLines`）只对 L3 有意义——L3 是「本地模型直出代码字符串」能数行数；L2 是「agent 用工具直接写文件」，没有「单次输出行数上限」这个概念。所以配置只有 `level2Provider`/`level2Model`（指定用哪个模型），没有 `level2MaxTokens`/`level2MaxCodeLines`。

### 11.1 配置分层（全局默认 → 模型档案 → 项目覆盖）

甜点区不再是一组写死的绝对值，而是「模型能力档案 + 分层覆盖」的结果（v82）：

- **模型档案（`MODEL_PROFILES`）**：每个模型声明 `contextWindow` 与 `sweetSpotRatio`（L1 0.5 / L2 0.25），L3 声明 `numCtx`；甜点区 = `Math.round(contextWindow × 该层比例)`。档案是「知识」而非「配置」——它决定换模型时联动到什么值。
- **分层优先级**：`DEFAULT_CONFIG`（全局默认 64000 / 32000 / 16384，与 v81 一致）→ 插件传入 config → 全局 `~/.dsh/pipeline/config.json` → 项目 `<devDir>/pipeline-project.json`（最高）。后者覆盖前者；`undefined` 不覆盖，非对象层忽略，`devDir` 由前三层先确定再读项目文件。
- **联动时机**：只在「用户改模型键」时重算（`autoTuneSweetSpot` 默认开），启动/加载时不重算——所以手动设置的甜点区值优先且稳定，不会被静默改写；`level1Model` 仅用于档案查询，不切换实际 L1 模型（L1 模型由 harness 决定）。
- **项目隔离**：项目级文件按 `devDir` 定位，不同项目（不同 devDir）各自覆盖、互不污染；模型不在档案里则不联动，改为提示用户手动覆盖甜点区键。
- **向后兼容**：不设任何新键时，合并结果与 v81 完全相同（默认值不变、无联动触发）。v84 起 L3 默认值改为 ninfer；若全局 config.json 仍是 v83 的精确旧默认值（`qwen3:14b` + `localhost:11434/api/generate`），加载时在内存中迁移为 ninfer（不改写用户文件，自定义值不覆盖）。

---

## 12. 抗阻塞与单点

L1 是唯一协调者（唯一和用户对话、唯一终审），因此有单点风险，设计了抗阻塞防护：

- **L1 必须响应**：收到 L2 汇报必须回复（一行「继续」或重新锚定），绝不让 L2 干等。
- **L2 汇报自包含**：每次汇报含「状态（做完了什么）+ 下一步 + 需要的决策」，即使 L1 延迟回复，进度也不丢。
- **持久化兜底**：看板 / trace / `l2_state.md` 全落盘，卡住也能恢复；用户（L0）随时可 ping L1 让它续上。

> 诚实说明：L1 **彻底不可用**（模型挂了 / 会话断了）时，终审和用户对话没有替代者，这是「L1 唯一协调者」架构的固有单点，只能靠用户手动介入或重开会话兜底。其余情况（L1 延迟 / 短暂不响应）不会阻塞、不丢进度。

---

## 13. 里程碑用户验收 + 强制重建（无条件交接）

- **规划时设里程碑 + 节点小型化**：L1 设 2–3 个里程碑；激进拆分模块，让每个 L2 待在 `level2ContextBudget`（flash 甜点区 ~32K）内，绝不派一个干不完的任务。
- **到点用户验收（L0）**：L1 停下，用 `ask_user_question` 弹窗问「我很满意 / 我要提出意见」。
  - 「我很满意」→ 继续。
  - 「我要提出意见」→ 弹窗收集 → 按作用域路由（全局意见进全局上下文，局部意见进对应模块）。**意见本身在切换前收集（验收门）；但意见触发的改造工作默认推迟到 checkpoint 切换之后实施**（写进待办，交给新会话按意见改），除非用户明确要求切换前完成。
- **触发重建（无条件）**：里程碑「我很满意」后，无论 L2 上下文是否逼近 `level2ContextBudget`，一律交接 + 灭活旧 L2，后续任务重新生成 L2。
- **项目级重建（非一对一）**：
  1. 暂停：各 L2 完成当前原子步骤 + 写盘 + 待命；
  2. L1 写小「全局上下文」文件（需求 + 约定 + 依赖 DAG）；
  3. L1 **重新规划**模块数（1–5）；
  4. 每新模块写一份 scoped 交接索引（完成文件 / 进行中文件+进度 / 待办 / 依赖 / 约定 / 验收 / 下一步），从已有笔记抄，不重新推导；
  5. spawn 新 L2（`resumeFrom`）→ 新 L2 先回「我理解的现状」→ L1 确认；
  6. 确认后 `pipeline_drain_leads` 释放旧 L2。
- **新旧交替豁免**：重建窗口期新旧并存，总数可暂时超过 `maxLevel2Agents`（豁免，不违规）。
- **旧 L2 TTL**：`replacingChildId` 标记 replaced + 时间戳；验证后显式 drain，若忘记则 `cleanupExpiredL2s` 在 `level2HandoffTtlMs`（5 分钟）后自动清理。

---

## 14. L1 checkpoint / 冷启动（L1 记忆治理）

- **触发顺序**：里程碑验收在前、转移在后。到里程碑先问「我很满意 / 我要提出意见」，用户「我很满意」之后才检查 L1 上下文；逼近 `level1ContextBudget`（64K 甜点区）才提议 checkpoint 转移。绝不在验收前（或代替验收）提议转移。
- **客观 token 计量（v81）**：`pipeline_status.level1Context` + `/pipe-tokens` 命令给出客观的 L1 上下文 token（挂钩 DSH `tokenMeter`，确定性、零 LLM token）；`level1ContextWarnRatio`（默认 0.8）触发 checkpoint 提示，替代不可靠的自评。
- **意见改造推迟到切换后**：验收门（满意/意见）仍在切换前；用户意见触发的改造默认放到 checkpoint 切换后（写进待办交给新会话），当前已变长的上下文不做改造，除非用户明确要求切换前完成。
- **交接文档（9 节契约，索引式）**：`pipeline_checkpoint` 生成 `project_checkpoint.md`——恢复指令 / 需求 / 全局上下文 / 已完成 / 进行中 / 待办 / 关键决策 / 遗留坑 / 活跃L2 / 恢复步骤。§3–§7 是「指针 + 一行状态」，细节在磁盘文件 + 各 L2 交接文件里。文档内（§8 handoff、§9 恢复步骤）与冷启动 prompt 引用的交接文件路径一律是 `resolve()` 后的绝对路径（v83），新会话从任何 cwd 打开都能直接读到。
- **目录分离（生产 vs 过程文档）**：交付的生产代码与开发过程文档（checkpoint、L2 state、交接文件）分离存放——过程文档统一写进 `devDir`（默认 `dev/`）：`dev/project_checkpoint.md`、`dev/team_board/*_state.md`；绝不与交付代码混放。
- **冷启动 prompt**：工具同时返回 `coldStartPrompt`（身份声明 + 项目一句话 + 文档位置 + 恢复步骤 + 约束）。用户只需贴这一小段开新会话，不必贴整个文档。
- **新会话恢复**：新 L1 读 checkpoint + 磁盘文件对账 → `resumeFrom` 重新拉起各 L2 → 继续里程碑。旧 L2 在旧会话关闭时被 DSH 自动 drain（新会话不能「重连」旧 L2，只能「从文件重新 spawn」）。

---

## 15. 规划平衡 + 全局治理 + L1 有界兜底（v78）

规划期（Phase 3）与运行期（Phase 4）新增治理约定，目标：均衡负载、保证内聚、防屎山，同时省 token。

- **拆 + 均衡**：只在天然接缝拆（一句话接口测试：接口说不清 = 强内聚 = 不拆）；松耦合拆成量子，LPT 装箱（最大量子 → 最空 L2）到 ~75% 水位留余量；**质量（内聚）> 均衡**。
- **架构宪法 + 契约**：一份不可变宪法文件（目录 / 单向分层 / 命名 / 错误 / 日志约定 / 禁止反模式 + 全部接口契约单一事实源），所有 L2 开工前必读必守。
- **校准**：里程碑重规划用上一轮实测（`pipeline_status`：每模块子任务数 / token / 重试）校准拆分，不拍脑袋。
- **组装门**：里程碑验收前对照宪法审「组装后的整体」（接口一致 / 命名分层 / DRY），脏则派「重构去重」模块给 L2。
- **胶水分家**：接口契约 = L1（每接缝一行）；集成代码 = 模块派给 L2（验收 = 端到端通过）。
- **L1 有界兜底**：L2 报 cannot-do 或满 `maxLevel2Retries` 失败 → 最多重派 1 次 → L1 兜底直写卡点（过门 + 留痕）；默认不写码，只在极端情况兜底。
- **负载护栏**：`pipeline_send_to_lead` 确定性检查，`estimatedTokens ≥ 0.8×预算` 返回 warning（零 LLM token）。
- **单 L2 快路径**：整块小 + 内聚 + 串行速度可接受 → 1 个 L2，跳过均衡（无「之间」可均衡），保留质量（宪法缩水为「约定 + 分层」、组装门、兜底、里程碑重建）。

---

## 16. 批量 L3 执行 `pipeline_execute_batch`（v88）

**为什么 batch**：L2 原本要给 N 个 L3 子任务，就得串行调 N 次 `pipeline_execute_local`；每次工具返回后 L2 都要重新推理一遍（下一轮的上下文 + 决策），N 个子任务 = N 轮推理 token。v88 让 L2 在**一次工具调用**里提交 N 个任务（`tasks: [{ id?, desc, acceptance }]`），工具内部按 `maxLevel3Concurrency=1` **串行**执行、一次返回 `{ total, done, failed, remaining, results[] }`——L2 只推理 1 次，省的是**推理 token**，L3 侧的实际生成量不变。

**实现要点**：

- **单任务内核复用**：`pipeline_execute_local` 的 execute 核心抽成 `executeOneL3Task(subtask, cfg, r, exec)`（token 预算 → L1 压缩 prompt → ninfer `/v1/chat/completions` → JSON 容错解析 → 失败计数 / cannot-do / 升级）。`pipeline_execute_local` 变为「校验 subtask → 调内核 → 返回」，行为与 v87 完全一致；batch 对每个任务调同一个内核，单任务语义不漂移。
- **每任务独立 15 分钟看门狗**：看门狗在 `executeOneL3Task` 内部（每个任务各建一个 `AbortController` + `level3TimeoutMs`，默认 900000ms），因此 batch 中单个任务超时只会终止它自己。**绝不设 batch 整体超时**——总时长不确定是本地模型生成的常态，一刀切会误杀长任务。
- **失败不连锁**：任务失败 / 超时 / `cannot-do` / 内核抛异常都只记入该任务的结果项（`ok:false` + `state`/`error`），循环继续下一个任务；`results[i].i` 保留原始下标，汇总给出 `done` / `failed` / `remaining`。L2 可在一次返回里看到全部成败，再决定重派 / 接管。
- **`maxBatchMs` 护栏（可选，默认 0=不限）**：只作为「停止派发新任务」的软护栏——到点后不再启动新任务（未派发的计入 `remaining`），**不 abort 正在跑的任务**，避免 batch 半途砍断已投入的生成。
- **守卫不变**：batch 与 `pipeline_execute_local`、`pipeline_decompose`、`pipeline_spawn_local_executor` 一样属于 L2/L3 工具，L1 直接调用仍被 `tools.guard` 拒绝；L2 用它是正常相邻调用，严格相邻规则不变。

---

## 17. 控制面：激活 / 预算 / 里程碑 / 自检（v89）

**为什么控制面**：三级流水线的最大风险不是「不会写代码」，而是**用户失控**（不知道要花多少、停不下来）和**模型遗忘**（跨会话丢掉任务状态、把已完成未验收的里程碑悄悄跳过）。v89 用「状态机 + 硬门禁 + 可回读文件」把这两件事在结构上堵死，而不是靠提示词祈祷。

**设计原则：状态落成文件，门禁落成守卫，用户随时能停。**

- **激活 Gate（一次性）**：流水线不是默认开启的。新工作区第一次 `pipeline_lock_requirements` 前，L1 必须用 `ask_user_question` 问一次「A 启用 / B 只做普通回答 / C 记住此工作区」，答案写进工作区 `runtimeStateDir()/activation.json`。工具在未记录选择时返回 `activationHint`（提示词层）；`pipeline_lock_requirements` 新增 `activation=enable|normal|remember` 参数承接答案——同一工作区以后不再问。选择「B 普通」不影响生成，只是 L1 不主动启动三级。
- **预算护栏（三层上限 + 自动暂停）**：`maxTotalTokensPerRun`(500K) / `maxDurationPerRun`(2h) / `maxFilesPerRun`(200)，`0` 表示不限。`addRunUsage` 在每次 L2 派发（按 prompt 估算 token）、每次 L3 执行（按 usage 精确 token）后累加；任一上限触顶 → `run.paused=true` + `pauseReason`；`tools.guard` 对执行类工具（spawn / send / decompose / execute_local / execute_batch / spawn_local_executor）返回拒绝原因。已在跑的 L3 完成时仍会把 token 记入（钱已经花掉，不能装看不见）。
- **run 状态机（持久化 + 冷启动恢复）**：`store.run = { id, status, startedAt, milestones, tokensUsed, filesTouched, scope, activation, paused, pauseReason }` 落盘 `run.json`。`createStore` 启动时若发现 `status=active` 的 run，就恢复它；同时从 `board.json` 反查重建 tasks / subtasks / subtaskIds / agents（文件是真相，内存只是缓存）。
- **里程碑状态机（计算而非存储）**：`pipeline_plan` 接受 `milestones: [{ id, name, taskIds[] }]`；`milestoneStates(store)` 从任务 `state` 实时计算 `pending → done → accepted`，不单独持久化重复状态（避免漂移）。完成 ≠ 验收：`pipeline_accept_milestone` 要求该里程碑全部任务 `done`，才置 `accepted` 并记 `note`。**硬 Gate**：存在 `done` 未 `accepted` 的里程碑时，`pipeline_spawn_module_lead` / `pipeline_send_to_lead` 被拒绝——模型无法「跳过验收直接推进」。每个 L1 工具结果尾部追加 `runFooter`（暂停原因 / 里程碑 m/n / 未验收提醒），把状态钉在模型眼前。
- **随时可停**：`/pipe-stop` 冻结（状态 `paused`，已派发 L2 做完当前步骤后等待，磁盘文件保留）、`/pipe-resume` 恢复、`/pipe-off` 关掉流水线（mode off）。停止不销毁数据，只停止派发。
- **健康自检**：`pipeline_selftest` 检查三件事：①subagents 服务是否暴露 `startActivation` / `drainChildren`（DSH 升级检测点）；②llm 服务是否可用；③L3 引擎 `<level3Endpoint>/v1/models` 是否可访问、配置的 `level3Model` 是否在模型列表里。`apply()` 启动时另做一次**非阻塞**引擎 ping，失败只 `console.warn`，绝不让一个没开引擎的会话卡死。
- **错误翻译**：`subagents service is unavailable` 等底层错误统一翻译成中文行动提示（「先跑 /pipe-selftest」「先启动引擎」），避免用户看到英文堆栈。
- **引擎泛化打底**：`level3Engine`（auto / ollama / vllm / llamacpp / openai-compat / other）只是提示键；L3 一律走 OpenAI 兼容 `<level3Endpoint>/chat/completions`，因此 Ollama / vLLM / llama.cpp server / 任意兼容网关都能接。引擎不可用时沿用既有失败阶梯（重试 → 升级 → L2 接管），不新增脆弱分支。

**刻意没做（留给 v90）**：作用域「硬拦」（DSH 的 write 工具不在插件控制内，硬拦需要工具层 patch，暂以 L1 声明 + 事后审计代替——`filesTouched` 已记录）；自动 checkpoint 写文件（改为最后一个里程碑验收后**提示** L1 调 `pipeline_checkpoint`，避免自动覆盖人工交接文档）。

**测试**：`dev/smoke/v89_control_smoke.mjs`（49 断言：配置键 / run 状态机 / 里程碑计算 / 预算暂停 / 冷启动恢复 / 断言并发隔离）+ `dev/smoke/verify-v82.mjs`（73 断言回归）+ `dev/smoke/skill_sync_check.mjs`（SKILL.md 与 SKILL_BODY 字节一致）。

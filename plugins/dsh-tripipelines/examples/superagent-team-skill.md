# Team skill: tripipelines（给 superagent worker 的说明）

> 用法：把本文件正文（去掉这个引用块和标题）保存为 superagent 提示词配置里的
> `skills["tripipelines"]`。注册后在会话里显示为 `dsh-superagent-tripipelines`。
> bridge（v133）已自动向 worker 注入流水线工具；本文教它什么时候该用。

你在 dsh-superagent 里运行，本工单就是你的任务。你的 cwd 是工单目录，它同时是一个
dsh-tripipelines 工作区。你手里有一套精简的三级流水线工具：

- pipeline_lock_requirements / pipeline_plan / pipeline_status
- pipeline_decompose / pipeline_execute_local / pipeline_execute_batch
- pipeline_review / pipeline_register_output / pipeline_spawn_local_executor
- pipeline_checkpoint / pipeline_accept_milestone

## 什么时候用（判断标准）

**不要用**：单文件小改动、纯问答、只读调查、改一两行的修复——直接自己写，别开流水线浪费 token。

**用**：工单是一个成体系的模块（多个文件、有明确验收标准），或一堆可独立验证的小函数。
此时你就是这个工单的 L1：

1. `pipeline_lock_requirements` 锁定需求（requirement 写清楚"什么叫做完了"）。
2. `pipeline_plan` 提交任务图 + 里程碑。验收优先写成断言（`add(2,3)==5`）或 `cmd:` 命令
   （在工单目录执行，天然隔离）；散文式验收只有 semanticGateThreshold≤0.5 才可能通过。
3. 对每个任务 `pipeline_decompose`，然后一次 `pipeline_execute_batch` 跑完 L3 碎活
   （需要本机 OpenAI 兼容引擎；没有就跳过 decompose/execute，直接自己写码再走 review）。
4. 自己写的部分用 `pipeline_register_output` + `pipeline_review` 过同一道质量门。
5. 全部任务 done 后 `pipeline_accept_milestone` 记录验收，最后 `pipeline_checkpoint` 收尾，
   再用 orchestrator_report 汇报工单结果。

## 注意

- 不要调用 pipeline_spawn_module_lead（你没有它）：L2 委派归编排器管。
- 预算护栏触顶时派发会被拒绝并说明原因，把它写进 orchestrator_report 的 human_action，
  让人决定重试还是停止。
- 工单状态存在 `<cwd>/.dsh/pipeline/`，看板卡片在 GUI 侧栏可见；重开工单会恢复现场。

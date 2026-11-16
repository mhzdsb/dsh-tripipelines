# 与 dsh-superagent-prototype 融合指南（v133+）

官方原型 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
是一个「收件箱 → 工单」的自主编排层：来源消息经准入评估变成工单（ticket），每个工单跑在一个
专用 worker 会话里。本插件（dsh-tripipelines）是项目内的三级模型协作流水线。两者互补：
superagent 决定**做什么、什么时候做**，tripipelines 决定**怎么把一块开发任务拆给不同的模型去做完**。

## 共存前提

两个插件安装在**同一个 profile** 即可。superagent 要求专用 profile（它会改 PATH/git 配置，见其
docs/006-deployment.md），把本插件也装进那个 profile：

```yaml
# superagent profile 的 cordis.patch.yml 追加一行
- insert:
    - id: pipeline
      name: 'dsh-tripipelines'
```

没有安装 superagent 时，本插件的 bridge 完全惰性（探测不到 `orchestrator` 服务就退出），零开销。

## bridge 自动做了什么（P1，无需配置）

加载时检测到 superagent 的 `orchestrator` 服务后，bridge 会：

1. 监听 `agent/created` 事件，识别 worker 会话（preset 含 `dsh-superagent-worker`，或标题以
   `worker-` 开头）；启动时还会补扫一遍已存在的会话（插件加载顺序颠倒也不怕）。
2. 在每个 worker 会话上**按 agent 作用域**注册一套精简的流水线工具（共 11 个）。这是关键：
   superagent 对 worker 施加的是 `ctx.tools.restrict({ allow })` 全局白名单，但宿主文档明确
   **caller 自己作用域里的注册不受 allow/deny 遮蔽**——它的 orchestrator_* 工具就是这么注册的。
3. 注入的工具集刻意**不含** `pipeline_spawn_module_lead / send_to_lead / drain_leads`：
   L2 负责人由编排器的调度层负责，worker 只拿到规划 + 验收门 + L3 本地执行这一层
   （lock / plan / status / decompose / execute_local / execute_batch / review /
   spawn_local_executor / register_output / checkpoint / accept_milestone）。
4. worker 的会话 cwd 就是工单目录，也就是本插件工作区注册表的天然 key——工单的看板状态存在
   `<工单目录>/.dsh/pipeline/`，你在交互会话里打开同一目录就能用侧边栏卡片看它的进度。
5. 邻接守卫认 worker 为 L1（bridge 会在该工作区的 board 里记一条 `kind:l1 via:bridge` 标记），
   所以 review / register_output 对 worker 合法，而派发类工具仍被拒——角色矩阵不被绕过。

## 团队技能注入（P0，操作员一次性配置）

superagent 的提示词系统支持 team skills（`PromptConfig.skills`），会注册进**每一个**被装饰的
会话（包括 worker）。把 `examples/superagent-team-skill.md` 的内容通过管理面板 PUT `/prompts`
或 `orchestrator_prompts_save` 保存为 `skills["tripipelines"]`，worker 就会知道何时该用流水线
工具（名字会被加上 `dsh-superagent-` 前缀，即 `dsh-superagent-tripipelines`）。

要点（文本里都写了）：
- 工单只是"改一个函数"级别 → 直接写，别开流水线；
- 工单是一个多文件模块 → lock → plan（带验收断言）→ decompose → execute_batch/review；
- 验收命令 `cmd:` 在工单目录里跑，天然隔离；
- 预算护栏照常生效，触顶会暂停并说明原因。

## 边界与风险

- 原型是研究代码、未发布 npm、无 semver 承诺。bridge 的每一处探测都有 try/catch：将来它改名或
  挪结构，最坏结果是"没注入"，日志会给出 `[pipeline] superagent bridge: ...`，不会拖垮流水线本体。
- worker 会话的子代理仍受 superagent 自己的 restrict 管（它们看不到 pipeline_* 工具）；这正是
  设计意图——委派留在编排器手里。
- 两套看板互不写入：superagent 面板读 `/orchestrator/api/*`，本插件卡片读 `/pipeline/board`；
  工单目录相同，所以数据同源、视图分开。

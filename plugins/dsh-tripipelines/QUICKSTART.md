# QUICKSTART · 3 分钟上手流水线

> 不读长文档，跟着三步走。卡住了再看文末「常见问题」。

## 第 0 步：前提（30 秒）

**什么都不用装、不用配。** 插件自带默认值，开工时它会贴出你机器上实际可用的模型清单让你挑（或直接回车用默认）。三级执行器有三条路，任选其一，也可以一个都不选：

| 路线 | 前提 | 适合 |
|---|---|---|
| **A. 本地引擎（executor）** | 任意 OpenAI 兼容端点活着（llama.cpp / vLLM / Ollama / LM Studio / strata…），默认地址 `http://127.0.0.1:8080/v1` | 想省云端 token；碎活交给本地小模型 |
| **B. 云端模型（agent）** | 无额外前提——复用 DSH 已配置的 LLM provider（含 Token Plan 等自定义 provider） | 没有本地引擎，又想三级分工 |
| **C. 两级模式（off）** | 无额外前提 | 只想 L1 规划 + L2 写码，最简单 |

验证 A 路引擎是否在线（可选）：

```bash
curl http://127.0.0.1:8080/v1/models
```

- 返回 `{"data":[{"id":"..."}]}` → 好了，记下模型 id。端口/名字不同也没关系，开工清单里会按真实来源列出。
- 连不上 → 完全没关系：选 B（把某个云端模型当 L3，`pipeline_model_setup` 会自动配对 provider）或选 C（关掉三级）。

## 第 1 步：装插件（1 分钟）

**A. 插件市场 / npm（推荐）**：在 DSH 的插件页搜索 `dsh-tripipelines` 安装；或让主 agent 执行：

```
plugin_manager install_bundle('dsh-tripipelines')
```

**B. 命令行**：

```bash
dsh plugin --profile <profile> add dsh-tripipelines
```

**C. 本地快照 / 开发（link 安装）**：

```
plugin_manager install_bundle('link:C:/path/to/dsh-tripipelines')
```

> 装好后**新开一个会话**（或刷新页面），才能加载插件的提示词与工具。升级同理：重装新版本后开新会话；正常发布流程不需要手动换目录（历史版本里的 `-vNN` 快照目录只是作者本机的开发手段）。

## 第 2 步：自检（30 秒）

在新会话里输入：

```
/pipe-selftest
```

看到类似：

```
subagents service      OK
startActivation        OK
drainChildren          OK
llm service            OK (level2 qwen-token-plan-cn/qwen3.7-plus)
L2 model/provider      OK (qwen3.7-plus ✔)
L3 engine              OK (HTTP 200；模型 local-a, local-b)
```

核心五项 OK 就能跑。`L3 engine` 不可达不算坏——说明还没选 B/C 路，工具会给出对应命令（`/pipe-config level3Mode agent` 或 `off`）。

## 第 3 步：说第一句话（1 分钟）

**不需要拆模块、不需要写任务书**，直接用自然语言描述你要的东西：

```
帮我做一个带登录和任务列表的待办应用，React + Vite，数据存 localStorage
```

接下来主 agent 会自动：

1. **先定模型（一次性弹窗）**：贴出本机全部二级/三级模型 + 可复制的 `/pipe-config ...` 行，问一次「用默认 / 我自己指定 / 只用 L1+L2 / 不用三级协作」；这个弹窗同时完成本工作区的一次性启用确认，不会连着弹两个窗。不选就用默认（L2 = flash 模型，L3 = 本机引擎排序第 1）。
2. **问你几个关键问题**（框架/数据库/认证/测试期望…），然后用弹窗锁定需求 → `requirement_lock.json`
3. **评估要不要三级**：任务太简单会直说「不用三级」
4. **拆模块、开干**：spawn L2、L2 分解出 L3 碎活、批量执行、质量门、逐节点汇报
5. **到里程碑弹窗验收**：你点「我很满意」才继续，否则主 agent 会先修正
6. **最后写 checkpoint**：下一个会话能直接续接

### 期间你可以用的控制键

| 想要 | 做什么 |
|---|---|
| 暂停（保留所有桌面文件） | `/pipe-stop`（或说「暂停」） |
| 继续 | `/pipe-resume` |
| 彻底关掉，变回普通 agent | `/pipe-off` |
| 看当前进度 | `pipeline_status`（或 `/pipe-config`） |
| 改配置 | `/pipe-config <键> <值>`（模型名直接写，provider 自动配对；可带 `mode=agent`） |

## 常见问题

**Q：我没有任何本地引擎，能用吗？**
→ 能。开工弹窗选「我自己指定」，从 L2 清单里挑一个云端模型发 `/pipe-config level3Model <id> mode=agent`（v123 起一条命令自动配对 provider）；或者选「只用 L1+L2」，`/pipe-config level3Mode off`，最省事。

**Q：`/pipe-selftest` 报 L3 engine 不可达？**
→ 上面两条路任选；真想用本地引擎就把服务拉起来再跑 `/pipe-selftest`。

**Q：plug 装好了但 `pipeline_status` 不存在？**
→ 插件只在新会话加载。关掉会话重开，或刷新 GUI 页面。

**Q：它把我的普通提问也拿来拆模块了？**
→ 告诉它「不用三级模式」，或执行 `/pipe-config mode off`。`mode=auto` 时会按项目复杂度自动评估，简单任务不会硬套。

**Q：改了模型后 L2 派发报 "supported API model names are ..."？**
→ 那是模型和 provider 没配对。v123 起 `/pipe-config level2Model <id>` 会自动配套 provider；老配置可用 `/pipe-config level2Provider <正确 provider>` 修一次，`pipeline_selftest` 的 `L2 model/provider` 一项也会直接告诉你该发哪条命令。

**Q：到里程碑卡住不动了？**
→ 里程碑验收是硬 Gate：主 agent 弹窗问你「满意吗」。回答后它会继续。如果你不小心关掉了弹窗，说「继续」即可。

**Q：预算被暂停了（工具结果出现 ⏸️）？**
→ 默认单 run 上限 50 万 token / 2 小时 / 200 文件。确认继续就 `/pipe-resume`；想放宽就 `/pipe-config maxTotalTokensPerRun <新值>`（0 = 不限）。

---

更完整的用法看 [README.md](README.md)（English: [README.en.md](README.en.md)），配置项看 [TUTORIAL.md](TUTORIAL.md)，架构原理看 [docs/agent-lifecycle-design.md](docs/agent-lifecycle-design.md)。

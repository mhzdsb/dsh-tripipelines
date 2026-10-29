# QUICKSTART · 3 分钟上手流水线

> 不读长文档，跟着三步走。卡住了再看文末「常见问题」。

## 第 0 步：前提（1 分钟）

确认本地推理引擎活着（OpenAI 兼容，任选其一）：

```bash
curl http://127.0.0.1:8080/v1/models
```

- 返回 `{"data":[{"id":"..."}]}` → 好了，记下模型 id。
- 连不上 → 启动你的引擎（llama.cpp / vLLM / Ollama / strata 等），或先跳过：没有 L3 时，L2 仍可直写降级，效果打折但能用。

如果引擎端口/模型名不是这个值，装好后用 `/pipe-config level3Endpoint <你的地址>` 与 `/pipe-config level3Model <模型 id>` 改。

## 第 1 步：装插件（1 分钟）

二选一（`dsh-tripipelines-vNN` 是发布快照目录，`NN` 为迭代号）：

**A. npm / market（发布后，推荐）**：在 DSH 的插件页搜索 `dsh-tripipelines` 安装，或让主 agent 执行：

```bash
dsh plugin --profile <profile> add dsh-tripipelines
```

**B. 本地快照 / 开发（link 安装）**：

```
plugin_manager install_bundle('link:C:/path/to/dsh-tripipelines-vNN')
```

> 装好后**新开一个会话**（或刷新页面），才能加载插件的提示词与工具。

## 第 2 步：自检（30 秒）

在新会话里输入：

```
/pipe-selftest
```

看到类似：

```
subagents service   OK
startActivation     OK
drainChildren       OK
llm service         OK
L3 engine           OK (http://127.0.0.1:18200/v1, model qwen3.8-...)
```

五项都 OK 就完美。L3 engine 显示不可达也没关系——流水线自动降级为两级（L2 直写），只是省钱的 L3 环节不参与。

## 第 3 步：说第一句话（1 分钟）

**不需要拆模块、不需要写任务书**，直接用自然语言描述你要的东西：

```
帮我做一个带登录和任务列表的待办应用，React + Vite，数据存 localStorage
```

接下来主 agent 会自动：

1. **问你几个关键问题**（框架/数据库/认证/测试期望…），然后用弹窗锁定需求 → `requirement_lock.json`
2. **评估要不要三级**：任务太简单会直说「不用三级」
3. **拆模块、开干**：spawn L2、L2 分解出 L3 碎活、批量执行、质量门、逐节点汇报
4. **到里程碑弹窗验收**：你点「我很满意」才继续，否则主 agent 会先修正
5. **最后写 checkpoint**：下一个会话能直接续接

### 期间你可以用的控制键

| 想要 | 做什么 |
|---|---|
| 暂停（保留所有桌面文件） | `/pipe-stop`（或说「暂停」） |
| 继续 | `/pipe-resume` |
| 彻底关掉，变回普通 agent | `/pipe-off` |
| 看当前进度 | `pipeline_status`（或 `/pipe-config`） |
| 改配置 | `/pipe-config <键> <值>` |

## 常见问题

**Q：`/pipe-selftest` 报 L3 engine 不可达？**
→ 启动本地引擎即可。没有本地引擎也能跑，但 L3 省不了钱，建议按 `TUTORIAL.md` 配一个。

**Q：plug 装好了但 `pipeline_status` 不存在？**
→ 插件只在新会话加载。关掉会话重开，或刷新 GUI 页面。

**Q：它把我的普通提问也拿来拆模块了？**
→ 告诉它「不用三级模式」，或执行 `/pipe-config mode off`。`mode=auto` 时会按项目复杂度自动评估，简单任务不会硬套。

**Q：改完插件代码后不生效？**
→ Electron 按模块路径缓存，必须「复制到新目录 + 改包名后缀 + 重装 + 移除旧 bundle」（见 README 安装说明）。

**Q：到里程碑卡住不动了？**
→ 里程碑验收是硬 Gate：主 agent 弹窗问你「满意吗」。回答后它会继续。如果你不小心关掉了弹窗，说「继续」即可。

**Q：预算被暂停了（工具结果出现 ⏸️）？**
→ 默认单 run 上限 50 万 token / 2 小时 / 200 文件。确认继续就 `/pipe-resume`；想放宽就 `/pipe-config maxTotalTokensPerRun <新值>`（0 = 不限）。

---

更完整的用法看 [README.md](README.md)，配置项看 [TUTORIAL.md](TUTORIAL.md)，架构原理看 [docs/agent-lifecycle-design.md](docs/agent-lifecycle-design.md)。

# dsh-pipeline 最终审计报告

- 审计时间：2026-10-29
- 审计对象：`Merhentz_plugin/plugin` 源码 @ `4b1f893`（v109 / 1.18.0）
- 发布快照：`C:\Users\Merhnztz\.dsh\dsh-pipeline-v109`（29 文件，与源码逐字节一致）
- 安装状态：`profiles/desktop` 依赖与 junction 均指向 `dsh-pipeline-v109`，version `1.18.0`
- 审计方式：10 套 smoke 全量重跑 + 静态残留检查 + 源码/快照/安装副本三方一致性 + 路由实机核验

## 结论

**可以上线。** 原始评审的 4 个 P0 与全部 P1 关键项均已闭环，10 套回归全绿（272 断言 + 2 个装配/看板探针 + skill 字节校验），源码、快照、安装副本三方一致。剩余风险均为「已知限制」而非未修缺陷，列在文末。

## 版本与产物一致性

| 检查项 | 结果 |
|---|---|
| `plugin/package.json` version | 1.18.0 ✅ |
| `plugin/lib/board-route.js` `BUILD_TAG` | `v109` ✅ |
| CHANGELOG 顶部条目 | `## v109 — 1.18.0` ✅ |
| 快照 vs 源码 | 29 文件逐字节一致 ✅ |
| profile 依赖 / junction | `link:...dsh-pipeline-v109` / 指向 v109 ✅ |
| git 工作区 | clean @ `7811256` ✅ |

## 回归矩阵（2026-10-29 09:1x 全量重跑）

| 套件 | 结果 |
|---|---|
| verify-v82（配置分层/转换） | 82 passed, 0 failed |
| v89_control_smoke（状态机/预算/验收） | 49 passed, 0 failed |
| v90_tool_factory_probe（19 工具/7 命令装配） | ALL PASS |
| v92_board_smoke（看板路由/快照） | ALL PASS |
| v98_knowledge_smoke | 15 passed, 0 failed |
| v99_knowledge_hardening_smoke（脱敏/路径围栏） | 32 passed, 0 failed |
| skill_sync_check（SKILL.md 与 SKILL_BODY） | PASS（字节一致） |
| v103_workspace_isolation_smoke | 44 passed, 0 failed |
| v104_gate_roles_smoke | 34 passed, 0 failed |
| v105_lifecycle_smoke | 16 passed, 0 failed |

## 原始问题闭环

| 原始问题 | 状态 | 证据 |
|---|---|---|
| P0-1 质量门对 JS/TS 不设防、ran:false 回落关键词分 | 已修 | JS/Python 双 runner；断言存在时全部通过才算过，runner 不可用/被静态门拒绝一律失败；语义分封顶 0.5（v104 34） |
| P0-2 跨工作区状态串味（单 store + lock 复制 + restore 只合并） | 已修 | per-workspace registry（`lib/workspaces.js`）；stateDir 创建时固定；删 lock 复制；冷恢复先清空（v103 44） |
| P0-3 三层路由只在 prompt、守卫 fail-open | 已修 | 显式角色矩阵：L1 只能派发、L2/L3 不能自行派发、无归因 fail-closed（v103/v104） |
| P0-4 秘密泄露（checkpoint 摘录未脱敏、recall 任意路径读） | 已修 | 统一 `redact()` 覆盖 scan/ledger/recall；recall 拒绝绝对路径/盘符/`..` 越界（v99 32） |
| P1 冻结假（paused 旁路） | 已修 | `budgetRefusal` 先判 paused；/pipe-stop 冻结可拦（v103） |
| P1 页脚死（render 返回数组） | 已修 | `withRunFooter` 支持数组并追加到最后一个 text block（v103） |
| P1 验收自证 / 恒真检查 | 已修 | `pipeline_accept_milestone` 强制 `userConfirmed:true`；重 plan 保留状态、done-unaccepted 拒绝；gateTask 空子任务不再恒真（v104/v105） |
| P1 cwd 相对路径（profile 目录） | 已修 | checkpoint/handoff/knowledge/gate scratch 全部走 `store.workspaceRoot` |
| P1 配置回写污染全局 / 默认值绑作者机器 | 已修 | 只写显式键；endpoint 默认空并给配置指引；level3Provider/spawnProvider 可配置 |
| P1 反轮询对 L1 无机械约束 | 已修 | A 协议补句 + B `concludeTurn()` + D 守卫 fail-closed（v103/v104） |
| P1 账目（分解不计数、filesTouched 死、counters 不持久化） | 已修 | v105 16 断言覆盖 |
| P1 测试发布（test 只串 5 套、release 先写快照、版本差一） | 已修 | test 串 10 套；release 先检查后写；BUILD_TAG/CHANGELOG/version 三方校验 |
| P1 文档失真 11 条 / 缺 LICENSE | 已修 | README/TUTORIAL/QUICKSTART/design 校正；MIT LICENSE 入包 |
| P1 路由无鉴权 / 双写头 / 冷启动 404 | 部分修 | 先 build 再 writeHead、headersSent 兜底、冷启动 200 idle；**未加鉴权**（见风险） |
| P1 看板无工作区切换器（多项目只能跟 lastActive） | 已修 | `~/.dsh/pipeline/workspaces.json` 记录已知工作区；卡片下拉切换，`?workspace=` 按需从磁盘加载；v103 42 断言覆盖切换/冷加载/删除过滤 |
| P1 折叠栏与展开卡片的选择不同步（小组件显示全局 lastActive） | 已修 | 选择改为模块级共享状态 + `localStorage('dsh-pipeline.workspace')`；任一挂载切换，折叠栏/卡片全部跟随并持久化；v103 44 断言（含 2 条客户端源码断言） |

## 残留风险与已知限制

1. **质量门不是 OS 沙箱**：断言 runner 用本机 node/python 子进程执行模型代码，仅靠静态黑名单（Python AST / JS 模式）拦截；`allowCodeExecution` 默认 true。适用于本机受信模型，不适合执行不受信来源的代码。
2. **无真实 L2/L3 集成测试**：smoke 用假 Host 服务，模型分解、子代理派发、L3 `/chat/completions` 的端到端行为只在实机使用中验证。
3. **L3 默认未配置**：`level3Endpoint` 默认空（有意），首次使用需 `/pipe-config level3Endpoint <url>`；否则 L3 子任务直接 blocked。
4. **切换器只列「已知工作区」**：`~/.dsh/pipeline/workspaces.json` 只记录在本 daemon 里至少有过一次 pipeline 调用的项目（最多 32 条，目录被删除后自动过滤）；从未用过的项目可先用 `?workspace=<绝对路径>` 手动打开，或用任意 `pipeline_*` 工具激活。
5. **`/pipeline/board` 仍无鉴权**：绑定本机 web 服务，局域网不可达；但同一台机器上的任意本地进程可读看板数据（含需求文本、路径）。
6. **客户端更新必须重启**：Electron 按真实路径缓存 ESM，改 client.js 需生成新快照 + 重装 + 重启才能生效（发布流程已固化）。
7. **旧快照会累积**：`~/.dsh/dsh-pipeline-v102…v108` 每份约 30 文件，确认稳定后可手工删除旧目录。

## 部署与回滚

- 本次已安装 v109；延迟重启脚本启动后，daemon 加载 1.18.0，侧栏图标为 `◫`（待命）/`▣`（运行中），看板卡片出现工作区下拉，折叠栏与卡片始终显示同一个工作区。
- 重启后自检：`GET /pipeline/board` 应返回 200、`debug.build="v109"`；多项目时卡片右上角下拉列出已知工作区。
- 回滚：把 `profiles/desktop` 的 `dsh-pipeline` 依赖指回 `C:/Users/Merhnztz/.dsh/dsh-pipeline-v108`（`dev/_backup/20261029` 另有 v102 源码快照），重启 daemon 即可。

## 提交历史

```
4b1f893 v109: share the workspace pick across the sidebar card and the collapsed rail (module state + localStorage, stale-pick cleanup, workspace name in tooltip)
7811256 v108: workspace switcher (known-workspace registry + ?workspace= on-demand load + board picker), v103 42 assertions
aecce0e v107 (1.16.0): sidebar icon board glyph instead of wrench; docs default-value rows aligned
79dc66d v106: idle board snapshot on cold start (card no longer vanishes) + client keeps last snapshot
e42ae11 release --verify: check only the newest snapshot
be8f788 batch E: lifecycle invariants + release v105 (1.14.0)
e88ce73 batch D: release v104 (1.13.0) — BUILD_TAG/version/changelog aligned, docs, LICENSE
8af740f batch C: anti-poll hardening, explicit config keys, secret redaction
95502eb batch B: fail-closed quality gate + role matrix (v104)
698a5bb batch A: per-workspace store registry (v103) + fail-closed guard + footer fix
7b9db27 baseline: dsh-pipeline 1.11.0 (v102) before fix batches A-E
```

# 发布指南：npm → GitHub → DSH market

当前状态（本机实测）：node v25.2.1、npm 11.6.2、git 2.50.1；npm 未登录；git 全局身份为空；仓库无 remote；包名 `dsh-tripipelines` 未发布（npm 404 可用）。

## 0. 账号：只需要两个

| 账号 | 是否已有 | 用途 | 费用 |
|---|---|---|---|
| **npm**（npmjs.com） | ❌ 需要注册 | 发布包 `dsh-tripipelines`，market 按 npm 版本检查更新 | 免费 |
| **GitHub** | ✅ 已有 | 公开仓库 + 给 catalog 提 PR（fork + 网页 PR 即可） | 免费 |

不需要：market 账号（收录靠 GitHub PR）、域名、付费计划、Apple/Google 开发者账号。
可选：GitHub Personal Access Token（不想用浏览器弹窗推送时用；Windows 的 Git Credential Manager 默认会弹浏览器授权，不必须）。

npm 注册要点：验证邮箱后才能 publish；建议开 2FA（发布时会要求输入 6 位 OTP）。

## 1. 一次性准备

```powershell
# git 身份（当前为空，必须先设）
git config --global user.name  "你的名字"
git config --global user.email "你的 GitHub 邮箱"

# 确认包名仍可用（应输出 E404）
npm view dsh-tripipelines version
```

`package.json` 建议补（发布前）：`repository` / `homepage` / `bugs` / `engines.node >=18`。

## 2. 关键：catalog 的目录结构要求

catalog CI 要求 `dsh.bundle` 出现在**仓库根 `package.json`**，或 `packages/`、`plugins/`、`apps/` 下的子包。**我们现在的包在 `plugin/`（单数），会被 CI 拒绝。** 三选一：

- **方案 A（推荐，单插件仓库）：把包放到仓库根**
  `package.json` / `lib/` / `client.js` / `skills/` / `cordis.patch.yml` 在根；`dev/` 留在根下（`files` 不含它，不会发到 npm）。
  需要改：`scripts.test` 路径、`dev/smoke/*.mjs` 的 repoRoot 引用、`dev/release.mjs` 的源目录、`.gitignore`、README 里 `plugin/` 路径。
- **方案 B（改动小）：`plugin/` → `plugins/dsh-tripipelines/`**
  只改路径深度（测试脚本 `../../dev/smoke`，release.mjs 源目录，README 路径）。
- **方案 C：保持现状，另建公开分发仓库**，根目录 = 插件包内容（release 快照），开发仓库保持私有。多一套同步成本。

不确定选哪个就先别上传——选 A 或 B 我可以直接改好并跑通 12 套测试。

## 3. 发布到 npm

```powershell
cd <包目录>
npm login          # 浏览器授权 / 用户名+密码+OTP
npm whoami         # 应输出你的 npm 用户名

node ..\dev\preflight.mjs   # 发布前体检（本指南附带）
npm pack --dry-run          # 应约 29 files / ~157 kB
npm publish                # 开 2FA 时输入 OTP
npm view dsh-tripipelines version   # 应输出 1.21.0
```

后续每次发版：

```powershell
npm version patch -m "v%s"   # 或 minor / major，自动改版本 + git tag
npm publish
git push --follow-tags
```

## 4. 推到 GitHub

1. 网页新建**公开**仓库 `dsh-tripipelines`（不要勾 "Add a README" / .gitignore，否则首次 push 冲突）。
2. 本地：

```powershell
git remote add origin https://github.com/<你的用户名>/dsh-tripipelines.git
git branch -M main
git push -u origin main

# 打 tag + Release（market 的 "What changed" 会链接到 release）
git tag v1.21.0
git push origin v1.21.0
# 然后在仓库 Releases 页面用 v1.21.0 tag 建一个 Release，正文粘 CHANGELOG 的 v114 段
```

仓库建议：描述写一句（英文），topics 填 `dsh`、`deepseek-harness`、`plugin`、`multi-agent`；README 里的安装命令保持有效。

## 5. 提交到 market（catalog）

1. Fork `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。
2. 新增 **一个文件**：`data/plugins/<你的用户名>__<仓库名>.yml`（双下划线）。

```yaml
url: https://github.com/<你的用户名>/dsh-tripipelines
name: <你的用户名>/dsh-tripipelines
category: Tools            # 从仓库 README 的分类表里选，主题类只给主题插件
description:
  en: "Three-tier model collaboration for DSH: an L1 coordinator, flash L2 module leads and local L3 executors, with strict tier adjacency, per-subtask acceptance gates and a live status board."
  zh: "三层模型协作：L1 统筹、flash L2 模块负责人、本地 L3 执行器，严格分层调度、逐子任务验收门与实时看板。"
# icon: https://...   # 可选，图片必须公网可访问
```

CI 会检查：`url` 与仓库完全一致、`name` 为 `owner/repo`、`description.en` 必填、单 PR ≤3 条、仓库年龄 ≥1 天、awesome-lint 通过。

3. 提交 PR，等 CI 和 review。收录后市场从 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` 同步（GitHub Pages 有镜像）。也可以在 DSH 的 `Plugins → Discover → Index sources` 里手动加这个 index.json 先自查。

## 6. 常见坑

- 仓库年龄 <1 天：CI 直接拒，建完仓库隔天再提 PR。
- `plugin/`（单数）目录名：见第 2 节，CI 不认。
- 忘记 `npm publish` 只推了 GitHub：market 按 npm 版本判断更新，用户装到的可能是旧版本甚至装不上。
- `files` 里漏了 `skills/` 或 `cordis.patch.yml`：安装后插件能加载但 skill/board 异常，`preflight.mjs` 会检查。
- README 链接到仓库内文档：仓库未公开前这些链接在 npm 页面是断的，公开后自动生效。
- 2FA 开启后 CI/脚本发布需要 granular token（Automation 类型）或用 OTP 手动发。

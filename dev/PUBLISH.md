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

## 1.5 npm 网站打不开怎么办（实测：registry API 是通的）

本机实测：`npm ping --registry=https://registry.npmjs.org` → `PONG 871ms`，`git ls-remote github.com` 也通。
**网站（npmjs.com）被风控/代理挡住 ≠ 不能发布**——publish 只走 registry API + token，不需要打开官网。

三条登录/发布路线：

1. **legacy 登录（推荐，不经过网页）**：
   ```powershell
   npm login --auth-type=legacy
   # 输入 npm 用户名 / 密码 / 6 位 OTP（开了 2FA 的话）
   npm whoami
   ```
2. **Access Token**（在能打开官网的网络里建一次，之后本机长期可用）：
   npmjs.com → Profile → Access Tokens → Granular Access Token（勾 Publish），然后写进 `~/.npmrc`：
   ```
   //registry.npmjs.org/:_authToken=npm_xxxxxxxx
   ```
3. **CI 发布**：把 token 存成 GitHub Secret（`NPM_TOKEN`），让 Actions 在打 tag 时 `npm publish`（见第 7 节的 workflow 示例）。

只影响装包速度时用镜像（**镜像不能发布**）：

```powershell
npm config set registry https://registry.npmmirror.com   # 只用于 install
npm publish --registry=https://registry.npmjs.org        # 发布必须直连官方 registry
```

如果连 registry 都不通（公司代理/证书）：`npm config set proxy http://127.0.0.1:7890` + `npm config set https-proxy http://127.0.0.1:7890`；自签证书用 `NODE_EXTRA_CA_CERTS`。

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

## 4. GitHub：从空账号到第一次推送

### 4.1 认证（二选一）

- **HTTPS + Git Credential Manager**（Windows 版 Git 自带）：第一次 `git push` 会弹浏览器让你登录 GitHub；登录后凭据自动记住。
  如果浏览器被代理挡住：GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → 权限 `Contents: Read and write`（只用 1 天/30 天有效），在弹窗里把 token 当密码粘贴一次即可。
- **SSH**（长期推荐，不依赖弹窗）：
  ```powershell
  ssh-keygen -t ed25519 -C "你的GitHub邮箱"       # 一路回车
  Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub   # 复制输出
  # 粘贴到 GitHub → Settings → SSH and GPG keys → New SSH key
  ssh -T git@github.com                              # 看到 "Hi xxx!" 即成功
  ```

### 4.2 创建空仓库并推送

1. 网页 github.com → New repository：名字 `dsh-tripipelines`、Public、**不要**勾 README / .gitignore / license（否则首次 push 会冲突，需要 `--allow-unrelated-histories`）。
2. 本地：
   ```powershell
   cd C:\Users\Merhnztz\Documents\Vibecoding\DSH\Merhentz_plugin
   git remote add origin https://github.com/<你的用户名>/dsh-tripipelines.git
   git branch -M main
   git push -u origin main
   ```
3. 如果推送被拒（历史里已有中文路径/大文件等），先看报错；最常见是「仓库端已有提交」→ `git pull --rebase origin main` 后再推。

### 4.3 版本与 Release

```powershell
git tag v1.21.0
git push origin v1.21.0
```

然后在仓库 **Releases → Draft a new release** 选 `v1.21.0`，正文粘 `CHANGELOG.md` 的 v114 段，勾 "Set as latest"。
market 卡片的 "What changed" 会链接到这个 Release，**这一步不要省**。

### 4.4 仓库设置（一次就好）

- Description：一句英文，例如 `Three-tier model collaboration plugin for DeepSeek Harness.`
- Topics：`dsh`、`deepseek-harness`、`dsh-plugin`、`multi-agent`、`orchestration`
- **不需要** GitHub Pages / Actions 也能上 market；Actions 只用于跑测试（可选）。
- 仓库年龄 ≥1 天才能被 catalog CI 通过，所以**今天就建仓库**。

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

## 7. 空账号的 GitHub 管理习惯（以后每个项目都照这个来）

### 7.1 仓库组织

- **一个项目一个仓库**（不要把所有东西塞进一个仓库）；仓库名 = 项目名，kebab-case：`dsh-tripipelines`。
- 每个仓库都放：`README.md`（是什么/安装/用法/截图/许可）、`LICENSE`、`.gitignore`。
- 以后项目多了再考虑 GitHub Organization（免费），market 收录只认 `owner/repo`，个人仓库和组织的都行。
- 建议把个人主页仓库（名 = 用户名）的 README 当作项目索引，方便别人和你自己找入口。

### 7.2 分支与提交

```powershell
git checkout -b feat/xxx        # 新功能从 main 切分支
# ... 改代码、跑 npm test ...
git add -A
git commit -m "feat: 一句话说明"
git push -u origin feat/xxx     # 然后在网页开 PR，自己 review 自己，Squash 合并
```

- `main` 永远可发布；改动走分支 + PR（哪怕一个人开发，也方便回滚和写变更说明）。
- 提交前缀：`feat:` / `fix:` / `docs:` / `test:` / `chore:`。
- 合并后删掉分支（网页有按钮）。

### 7.3 版本与发布

```powershell
npm version patch -m "v%s"   # 或 minor/major；自动改 package.json + 打 tag
git push --follow-tags
```
- 每个可发布版本：tag `vX.Y.Z` + GitHub Release（正文写变更）。
- 版本号语义：修 bug = patch，加功能 = minor，破坏性 = major。

### 7.4 CI（可选但推荐）

`.github/workflows/ci.yml`：

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm test
        working-directory: plugin    # 结构改到根目录后改成 .
```

发布自动化可以在打 tag 时加一步 `npm publish`（需要仓库 Secret `NPM_TOKEN`）。

### 7.5 日常维护清单

- **Issues**：bug 用复现步骤 + 期望/实际；feature 写用户故事。自己用也建议记，避免忘。
- **看板**：小项目不需要 Projects；≥3 个并行任务时再用。
- **安全**：开启 2FA；不要把 token/密钥提交进仓库（`.gitignore` + GitHub Secret Scanning 默认开启）；定期 `git status` 确认没有意外文件。
- **备份**：`git push` 本身就是备份；本地别只留一个目录（可再 clone 一份到别的盘）。
- **依赖更新**：仓库 Settings → Code security → 开 Dependabot（这个插件没有运行时依赖，影响很小）。
- **README 是第一门面**：market 卡片、GitHub 首页、npm 页面都读它；安装命令、截图、示例优先级最高。

### 7.6 没有 npm 也能先上 GitHub / market 吗

- **GitHub 推送不受影响**：npm 网站打不开只影响 `npm login` 和 `npm publish`；`git push` 走的是 github.com（本机实测可达）。
- **catalog 收录本身不强制 npm**：CI 检查仓库结构、年龄和 lint，不检查 npm 包；先用 GitHub-only 提交是可行的。
- 但市场安装/更新最稳的是 npm 包（`dsh plugin add dsh-tripipelines` 走 npm registry）。所以建议：**先把 GitHub 推上去、tag/Release 打好，等 npm 登录问题解决后再补 `npm publish`**——两边互不影响，market 之后会按 npm 版本提示更新。


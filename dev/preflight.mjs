#!/usr/bin/env node
// dev/preflight.mjs — 发布前体检（只读，不改任何文件 / 不发版）。
// 用法: node dev/preflight.mjs [包目录]
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const pkgDir = process.argv[2] ? resolve(process.argv[2]) : join(repoRoot, 'plugins', 'dsh-tripipelines')
const pkgPath = join(pkgDir, 'package.json')

const blockers = []
const warnings = []
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => { blockers.push(m); console.log(`  FAIL ${m}`) }
const warn = (m) => { warnings.push(m); console.log(`  warn ${m}`) }

function run(cmd, args, opts = {}) {
  const quote = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s))
  const line = [cmd, ...args].map(quote).join(' ')
  try {
    return { out: execSync(line, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim() }
  } catch (err) {
    return { err: String(err.stderr || err.stdout || err.message || err).trim() }
  }
}

function section(title) { console.log(`\n${title}`) }

// ---------- 1. toolchain ----------
section('1. 工具链')
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= 18) ok(`node ${process.versions.node}`)
else bad(`node ${process.versions.node} 太旧，需要 >=18`)
const npmVer = run('npm', ['--version'])
if (npmVer.out) ok(`npm ${npmVer.out}`)
else bad('找不到 npm')

// ---------- 2. git identity ----------
section('2. git 身份（首次提交/PR 都需要）')
const gName = run('git', ['config', '--global', 'user.name']).out || ''
const gMail = run('git', ['config', '--global', 'user.email']).out || ''
if (gName && gMail) ok(`user.name=${gName} user.email=${gMail}`)
else bad(`git 全局身份未设置（user.name='${gName}' email='${gMail}'）→ git config --global user.name "名字" && git config --global user.email "邮箱"`)

// ---------- 3. package.json ----------
section(`3. 包结构（${pkgDir}）`)
if (!existsSync(pkgPath)) {
  bad(`找不到 ${pkgPath}`)
} else {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  ok(`name=${pkg.name} version=${pkg.version}`)

  // catalog CI: dsh.bundle must be in the ROOT package.json or packages|plugins|apps subpackage
  const rel = relative(repoRoot, pkgPath).replace(/\\/g, '/')
  const validLocation = rel === 'package.json' || /^(packages|plugins|apps)\/[^/]+\/package\.json$/.test(rel)
  if (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) ok(`dsh.bundle.patch=${pkg.dsh.bundle.patch}`)
  else bad('package.json 缺少 dsh.bundle.patch（market CI 会拒绝）')
  if (validLocation) ok(`包位置合法：${rel}`)
  else bad(`包位置 ${rel} 不满足 catalog CI（只认根 package.json 或 packages|plugins|apps/<子包>/package.json）`)

  // shipped files
  const required = ['lib/', 'skills/', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE']
  const files = Array.isArray(pkg.files) ? pkg.files : []
  const missing = required.filter((f) => !files.includes(f))
  if (!missing.length) ok(`files 清单包含 ${required.length} 个必需项`)
  else bad(`files 清单缺少：${missing.join(', ')}（安装后会出现 skill/board 缺失）`)
  if (!pkg.repository) warn('package.json 没有 repository 字段（npm 页面不会链到仓库）')
  if (!pkg.engines || !pkg.engines.node) warn('package.json 没有 engines.node（market 无法展示宿主要求）')

  // tests point at real files
  const testCmd = String((pkg.scripts && pkg.scripts.test) || '')
  const testFiles = [...testCmd.matchAll(/node\s+(\S+\.mjs)/g)].map((m) => m[1])
  const missingTests = testFiles.filter((f) => !existsSync(resolve(pkgDir, f)))
  if (!testFiles.length) warn('package.json 没有 test 脚本')
  else if (!missingTests.length) ok(`test 脚本引用的 ${testFiles.length} 个文件都存在`)
  else bad(`test 脚本引用的文件缺失：${missingTests.join(', ')}`)

  // CHANGELOG mentions the version
  const cl = join(pkgDir, 'CHANGELOG.md')
  if (existsSync(cl) && readFileSync(cl, 'utf8').includes(String(pkg.version))) ok(`CHANGELOG 包含 ${pkg.version}`)
  else warn(`CHANGELOG 未提到当前版本 ${pkg.version}`)

  // ---------- 4. npm auth / name ----------
  section('4. npm')
  const who = run('npm', ['whoami'])
  if (who.out) ok(`已登录：${who.out}`)
  else if (/ENEEDAUTH|not logged in/i.test(who.err)) bad('npm 未登录 → 先运行 npm login（注册 npmjs.com 并验证邮箱）')
  else warn(`无法确认 npm 登录状态：${who.err.split('\n')[0]}`)

  const view = run('npm', ['view', pkg.name, 'version'])
  if (view.err && /E404|404 Not Found/i.test(view.err)) ok(`包名 ${pkg.name} 可用（npm 404）`)
  else if (!view.err) warn(`${pkg.name} 已发布过（最新 ${view.out}）——确认是不是你自己发布的，发布前需先 npm version`)
  else warn(`npm view 失败（网络或 registry）：${view.err.split('\n')[0]}`)

  // ---------- 5. tarball ----------
  section('5. 打包内容')
  const pack = run('npm', ['pack', '--dry-run', '--json'], { cwd: pkgDir })
  if (pack.err) {
    warn(`npm pack --dry-run 失败：${pack.err.split('\n')[0]}`)
  } else {
    try {
      const info = JSON.parse(pack.out)[0]
      const names = (info.files || []).map((f) => f.path.replace(/\\/g, '/'))
      const need = ['lib/plugin.js', 'client.js', 'cordis.patch.yml', 'package.json', 'skills/pipeline-orchestration/SKILL.md']
      const miss = need.filter((n) => !names.includes(n))
      if (!miss.length) ok(`${names.length} 个文件，unpacked ${(info.unpackedSize / 1024).toFixed(0)} KB，tarball ${(info.size / 1024).toFixed(0)} KB`)
      else bad(`tarball 缺少关键文件：${miss.join(', ')}`)
      if (names.some((n) => n.startsWith('dev/'))) warn('tarball 里出现了 dev/ 文件，检查 files 清单')
    } catch {
      warn('无法解析 npm pack 输出')
    }
  }
}

// ---------- 6. git ----------
section('6. git 仓库')
const st = run('git', ['status', '--porcelain'], { cwd: repoRoot })
if (st.err) warn(`git 状态读取失败：${st.err.split('\n')[0]}`)
else if (!st.out) ok('工作树干净')
else warn(`工作树有 ${st.out.split('\n').length} 处未提交改动——发布前先提交`)
const remotes = run('git', ['remote', '-v'], { cwd: repoRoot })
if (remotes.out) ok(remotes.out.split('\n')[0])
else warn('仓库还没有 remote → 创建 GitHub 仓库后 git remote add origin <url>')

// ---------- summary ----------
console.log('\n' + '='.repeat(60))
if (!blockers.length) {
  console.log(`PASS  ${warnings.length ? `${warnings.length} 条提醒，不阻塞发布` : '全部通过'}`)
} else {
  console.log(`FAIL  ${blockers.length} 个阻塞项：`)
  blockers.forEach((b, i) => console.log(`  ${i + 1}. ${b}`))
  if (warnings.length) console.log(`另有 ${warnings.length} 条提醒`)
}
process.exit(blockers.length ? 1 : 0)

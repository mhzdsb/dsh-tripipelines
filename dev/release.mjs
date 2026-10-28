#!/usr/bin/env node
/**
 * release.mjs — one command from "code works" to "snapshot is ready to install".
 *
 * Why this exists: v96→v98 我三次把「计划」当成「事实」报了「已部署」。
 * 这个脚本把能自动化的部分全部自动化，剩下的两件必须人工（只因为它们要 GUI）：
 *   - plugin_manager remove_bundle / install_bundle
 *   - listTools 核对新工具
 *
 * 用法:
 *   node dev/release.mjs v104                # 默认 version 1.13.0（vN → 1.(N-91).0）
 *   node dev/release.mjs v104 --version 1.13.1 # 指定版本号
 *   node dev/release.mjs v104 --dry           # 只做检查，不复制
 *   node dev/release.mjs --verify            # 只核对快照与源码一致性（三查①②）
 *
 * 退出码 0 = 可以安装；非 0 = 先修问题，不要重装。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
  statSync, rmSync, cpSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const pluginDir = join(repoRoot, 'plugin')
const smokeDir = join(repoRoot, 'dev', 'smoke')
const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
const snapshotsRoot = join(home, '.dsh')

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null
}
const dry = opt('dry') === true
const verifyOnly = opt('verify') === true
const versionArg = typeof opt('version') === 'string' ? opt('version') : null
// v101c: the tag may carry a letter suffix (v101b, v101c); the numeric part still
// drives the default version and the CHANGELOG anchor.
const vArg = args.find((a) => /^v\d+[a-z]?$/i.test(a))
const tag = vArg ? vArg.toLowerCase() : null
const vNum = tag ? Number(tag.replace(/^v/, '').replace(/[a-z]+$/, '')) : null
const defaultVersion = vNum ? `1.${vNum - 91}.0` : null
const version = versionArg ?? defaultVersion

const problems = []
const notes = []
const fail = (msg) => { problems.push(msg); console.log(`FAIL  ${msg}`) }
const pass = (msg) => { notes.push(msg); console.log(`PASS  ${msg}`) }

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function walkFiles(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, base, acc)
    else acc.push(relative(base, full).split(sep).join('/'))
  }
  return acc
}

function compareTrees(src, dst, ignore = []) {
  if (!existsSync(dst)) return { missingDir: true, missing: [], extra: [], diff: [] }
  const a = new Set(walkFiles(src))
  const b = new Set(walkFiles(dst))
  const skip = (p) => ignore.includes(p)
  const missing = [...a].filter((p) => !b.has(p) && !skip(p))
  const extra = [...b].filter((p) => !a.has(p) && !skip(p))
  const diff = [...a].filter((p) => b.has(p) && !skip(p) && sha(join(src, p)) !== sha(join(dst, p)))
  return { missingDir: false, missing, extra, diff }
}

// ---------------------------------------------------------------- verify mode
function verifySnapshot(snapshotDir, label) {
  if (!existsSync(snapshotDir)) { fail(`${label}: snapshot missing at ${snapshotDir}`); return }
  const cmp = compareTrees(pluginDir, snapshotDir, ['package.json'])
  if (cmp.missingDir) { fail(`${label}: snapshot directory missing`); return }
  if (cmp.missing.length) fail(`${label}: ${cmp.missing.length} file(s) in src not in snapshot (${cmp.missing.slice(0, 3).join(', ')})`)
  if (cmp.extra.length) fail(`${label}: ${cmp.extra.length} stale file(s) only in snapshot (${cmp.extra.slice(0, 3).join(', ')})`)
  if (cmp.diff.length) fail(`${label}: ${cmp.diff.length} file(s) differ (${cmp.diff.slice(0, 3).join(', ')})`)
  if (!cmp.missing.length && !cmp.extra.length && !cmp.diff.length) pass(`${label}: snapshot identical to source (${walkFiles(pluginDir).length} files)`)
  const srcVer = readJson(join(pluginDir, 'package.json')).version
  const snapVer = readJson(join(snapshotDir, 'package.json')).version
  if (srcVer === snapVer) pass(`${label}: package.json version ${srcVer} matches source`)
  else fail(`${label}: version mismatch — source ${srcVer} vs snapshot ${snapVer}`)
}

if (verifyOnly) {
  const all = existsSync(snapshotsRoot)
    ? readdirSync(snapshotsRoot).filter((n) => /^dsh-pipeline-v\d+[a-z]?$/.test(n))
      .map((n) => ({ name: n, num: Number((n.match(/v(\d+)/) ?? [])[1] ?? 0) }))
      .sort((a, b) => a.num - b.num)
    : []
  if (!all.length) fail('no dsh-pipeline-v* snapshot under ~/.dsh')
  if (all.length > 1) {
    console.log(`note: ${all.length} snapshots found; verifying only the newest (${all.at(-1).name}).`)
    console.log('      older snapshots are historical and intentionally differ from source.')
    console.log('')
  }
  const newest = all.at(-1)
  if (newest) verifySnapshot(join(snapshotsRoot, newest.name), newest.name)
  console.log('')
  console.log(problems.length ? `${problems.length} problem(s) — do NOT reinstall yet.` : 'snapshot verification clean.')
  process.exit(problems.length ? 1 : 0)
}

// ---------------------------------------------------------------- release mode
if (!tag) { console.error('usage: node dev/release.mjs vNN[x] [--version x.y.z] [--dry] | --verify'); process.exit(2) }
if (!/^\d+\.\d+\.\d+$/.test(String(version))) { console.error(`bad version: ${version}`); process.exit(2) }
const snapshotDir = join(snapshotsRoot, `dsh-pipeline-${tag}`)

console.log(`release ${tag} (version ${version})`)
console.log(`  source   ${pluginDir}`)
console.log(`  snapshot ${snapshotDir}`)
console.log('')

// 1. CHANGELOG must already have the entry (doc-before-code-order guard)
const changelog = join(pluginDir, 'CHANGELOG.md')
if (!existsSync(changelog)) fail('CHANGELOG.md missing')
if (existsSync(changelog)) {
  const txt = readFileSync(changelog, 'utf8')
  if (new RegExp(`^#{2,3}\\s*${tag}\\b`, 'm').test(txt)) pass(`CHANGELOG.md has a ${tag} entry`)
  else fail(`CHANGELOG.md has no "## ${tag}" entry — write it first (三查③)`)
  const verAnchor = new RegExp(`^#{2,3}\\s*${tag}\\s*[—–-]\\s*${version.replace(/\./g, '\\.')}\\b`, 'm')
  if (verAnchor.test(txt)) pass(`CHANGELOG ${tag} entry names version ${version}`)
  else fail(`CHANGELOG ${tag} entry must carry version ${version}`)
}

// 3. source version must equal the target version
const srcPkg = readJson(join(pluginDir, 'package.json'))
if (srcPkg.version === version) pass(`source package.json version is ${version}`)
else fail(`source package.json version is ${srcPkg.version}, expected ${version} — bump it before releasing`)

// 3b. board-route BUILD_TAG must agree with the tag being released
const boardSrc = readFileSync(join(pluginDir, 'lib', 'board-route.js'), 'utf8')
const buildTag = (boardSrc.match(/const BUILD_TAG = '([^']+)'/) ?? [])[1]
if (!buildTag) fail('board-route.js has no BUILD_TAG')
else if (buildTag.toLowerCase() === tag) pass(`board-route BUILD_TAG is ${tag}`)
else fail(`board-route BUILD_TAG is ${buildTag}, expected ${tag}`)

// 3. every smoke test must pass
const tests = readdirSync(smokeDir).filter((n) => n.endsWith('_smoke.mjs') || n === 'v90_tool_factory_probe.mjs' || n === 'verify-v82.mjs' || n === 'skill_sync_check.mjs')
if (!tests.length) fail('no smoke tests found')
for (const t of tests) {
  // stdio:'inherit' keeps the suite's own PASS/FAIL lines visible here and, unlike
  // piped stdio, also works when this script itself runs inside a restricted sandbox.
  const r = spawnSync(process.execPath, [join(smokeDir, t)], { stdio: 'inherit', timeout: 180000 })
  if (r.status === 0) pass(`test ${t}`)
  else fail(`test ${t} failed (exit ${r.status ?? r.signal ?? 'spawn-error'})`)
}

// 4. stop before touching the snapshot if anything is wrong
if (problems.length) {
  console.log('')
  console.log(`release BLOCKED — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
  console.log('snapshot NOT written.')
  process.exit(1)
}

// 5. copy source -> snapshot (never the other way round)
if (!dry) {
  rmSync(snapshotDir, { recursive: true, force: true })
  mkdirSync(snapshotDir, { recursive: true })
  cpSync(pluginDir, snapshotDir, { recursive: true, filter: (s) => !s.includes('node_modules') })
  const snapPkgPath = join(snapshotDir, 'package.json')
  const snapPkg = readJson(snapPkgPath)
  snapPkg.version = version
  writeFileSync(snapPkgPath, JSON.stringify(snapPkg, null, 2) + '\n')
  pass(`snapshot written (${walkFiles(snapshotDir).length} files, version ${version})`)
}

// 6. snapshot must be byte-identical to source (version field excepted)
if (!dry) verifySnapshot(snapshotDir, tag)

// 6. what still needs a human — because it needs the GUI
console.log('')
if (problems.length) {
  console.log(`release BLOCKED — ${problems.length} problem(s):`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
if (dry) {
  console.log('release dry-run: all checks passed; snapshot NOT written.')
  process.exit(0)
}
console.log('snapshot is ready. Now do the two GUI steps (cannot be automated from here):')
console.log('')
console.log("  1) plugin_manager action=remove_bundle target='dsh-pipeline'")
console.log(`  2) plugin_manager action=install_bundle target='${snapshotDir.replace(/\\/g, '/')}'`)
console.log(`  3) plugin_manager action=list_plugins  → confirm version + source under .dsh/dsh-pipeline-${tag}`)
console.log('')
console.log('then verify (三查):')
console.log('  - listTools            → new tools present')
console.log(`  - version              → ${version}`)
console.log(`  - CHANGELOG.md         → ## ${tag}`)
console.log('')
console.log('after install, re-run: node dev/release.mjs --verify')
process.exit(0)

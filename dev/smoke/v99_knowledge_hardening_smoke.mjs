/**
 * v99 harden smoke — knowledge layer P1/P2:
 *   1. secrets are never read (path/size only) and never leak into the knowledge base
 *   2. `checkStale` detects changed / added / removed code files
 *   3. ledger triage splits candidates into keep / review / drop
 *   4. generic layouts (Go cmd·internal·pkg, Java src/main/java) group sanely
 *
 * Run: node dev/smoke/v99_knowledge_hardening_smoke.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanRepo, buildModulePages, checkStale } from '../../plugin/lib/knowledge/scan.js'
import { extractDecisions } from '../../plugin/lib/knowledge/ledger.js'

let passed = 0
let failed = 0
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS  ${name}`) }
  else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

const root = mkdtempSync(join(tmpdir(), 'v99-knowledge-'))
const w = (rel, body) => {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}
const SECRET_VALUE = 'supersecretvalue123'

// --- fixture: a Go + Java mix with material dirs and secret files -----------------
w('go.mod', 'module example.com/app\n\ngo 1.22\n')
w('cmd/app/main.go', 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n')
w('internal/store/store.go', 'package store\n\n// Store persists rows.\ntype Store struct{}\n')
w('pkg/util/util.go', 'package util\n\nfunc Add(a, b int) int { return a + b }\n')
w('src/main/java/com/acme/App.java', 'package com.acme;\n\npublic class App {\n  public static void main(String[] a) {}\n}\n')
w('docs/GUIDE.md', '# Guide\n\nHow to run things.\n')
w('data/notes.csv', 'a,b\n1,2\n')
w('.env', `DB_PASSWORD=${SECRET_VALUE}\nAPI_TOKEN=abc123456789012345\n`)
w('config/secret.key', `-----BEGIN PRIVATE KEY-----\n${SECRET_VALUE}\n-----END PRIVATE KEY-----\n`)
w('dev/project_checkpoint.md', [
  '# sample',
  '',
  '## 6. 关键决策',
  '',
  '1. 用 SQLite 而不是 Postgres，因为单机部署足够，可逆性 high。证据：cmd/app/main.go:12',
  '2. 服务启动时必须预热缓存。',
  '3. 分页默认 20 条，因为前端一次渲染 20 行。证据：pkg/util/util.go:9',
  '',
  '## 7. 结论与结案',
  '',
  '1. 方案 Y 已结案：实测不达标，不再追，作废；归档保留实验脚本与数据，以备后人复跑验证。',
  '',
  '## 8. 背景',
  '',
  ...Array.from({ length: 22 }, (_, i) => `第 ${i + 1} 段填充：真实项目的交接文档通常几万字符，这个样本刻意写长以通过抽取器的 800 字符文档门槛。`),
].join('\n'))

const out = join(root, '.dsh', 'knowledge')

// --- scan ------------------------------------------------------------------------
const scan = scanRepo({ root, outDir: out })
const ids = new Set(scan.map.modules.map((m) => m.id))
ok('go layout groups cmd/app', ids.has('cmd/app'), [...ids].join(','))
ok('go layout groups internal/store', ids.has('internal/store'))
ok('go layout groups pkg/util', ids.has('pkg/util'))
ok('java layout groups src/main/java', ids.has('src/main/java'))
ok('secret files are counted separately', scan.stats.secretFiles >= 2, String(scan.stats.secretFiles))
ok('.env is not a code file', !scan.map.modules.some((m) => m.entries.some((e) => e.path === '.env')))

const idx = readFileSync(join(out, 'index.md'), 'utf8')
const mapJson = readFileSync(join(out, 'map.json'), 'utf8')
ok('index.md has code modules', /## code modules/.test(idx))
ok('secret value never leaks into index.md', !idx.includes(SECRET_VALUE))
ok('secret value never leaks into map.json', !mapJson.includes(SECRET_VALUE))
ok('hashes.json written', existsSync(join(out, 'hashes.json')))
const hashes = JSON.parse(readFileSync(join(out, 'hashes.json'), 'utf8'))
ok('hashes.json excludes secret files', !('.env' in hashes.files) && !('config/secret.key' in hashes.files))
ok('hashes.json tracks go/java files', 'pkg/util/util.go' in hashes.files && 'src/main/java/com/acme/App.java' in hashes.files)

// --- checkStale ------------------------------------------------------------------
const fresh = checkStale({ root, outDir: out })
ok('checkStale available after scan', fresh.available === true)
ok('checkStale reports clean tree', fresh.stale === false, JSON.stringify({ c: fresh.changed, a: fresh.added, r: fresh.removed }))

writeFileSync(join(root, 'pkg/util/util.go'), 'package util\n\nfunc Add(a, b int) int { return a + b }\n\nfunc Sub(a, b int) int { return a - b }\n')
w('internal/extra/extra.go', 'package extra\n\nfunc X() {}\n')
unlinkSync(join(root, 'cmd/app/main.go'))
const stale = checkStale({ root, outDir: out })
ok('checkStale detects modified file', stale.changed.includes('pkg/util/util.go'), JSON.stringify(stale.changed))
ok('checkStale detects added file', stale.added.includes('internal/extra/extra.go'), JSON.stringify(stale.added))
ok('checkStale detects removed file', stale.removed.includes('cmd/app/main.go'), JSON.stringify(stale.removed))
ok('checkStale names touched modules', stale.modules.includes('pkg/util') && stale.modules.includes('internal/extra'))

const missing = checkStale({ root, outDir: join(root, 'nope') })
ok('checkStale degrades without hashes.json', missing.available === false && /hashes\.json/.test(missing.reason ?? ''))

// --- pages do not read secrets ----------------------------------------------------
const pages = buildModulePages({ root, outDir: out, map: scanRepo({ root, outDir: out }).map })
ok('pages generated', pages.pages > 0, String(pages.pages))
let pageLeak = false
for (const m of scan.map.modules) {
  const p = join(out, 'modules', m.id.replace(/[\\/]/g, '__').replace(/[^\w.-]/g, '_') + '.md')
  if (existsSync(p) && readFileSync(p, 'utf8').includes(SECRET_VALUE)) pageLeak = true
}
ok('no module page leaks the secret', pageLeak === false)

// --- ledger triage ----------------------------------------------------------------
const led = extractDecisions({ root, outDir: out })
ok('ledger extractor sees decisions', led.counts.decision >= 3, JSON.stringify(led.counts))
ok('ledger keeps the pointer+rationale decision', led.counts.keep >= 1, JSON.stringify(led.counts))
ok('ledger drops the bare claim', led.counts.drop >= 1, JSON.stringify(led.counts))
ok('ledger reviews the closure verdict', led.counts.review >= 1, JSON.stringify(led.counts))
const cand = readFileSync(join(out, 'ledger-candidates.md'), 'utf8')
ok('candidates.md starts with the KEEP section', cand.indexOf('## KEEP') >= 0 && cand.indexOf('## KEEP') < cand.indexOf('## REVIEW'))
ok('candidates.md states the tier counts', /keep \d+ \/ review \d+ \/ drop \d+/.test(cand))

console.log('')
console.log(`v99 knowledge hardening smoke: ${passed} passed, ${failed} failed`)
rmSync(root, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)



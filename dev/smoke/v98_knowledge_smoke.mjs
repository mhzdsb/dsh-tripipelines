// v98 knowledge smoke — exercises the knowledge layer on a synthetic repo.
// Run: node dev/smoke/v98_knowledge_smoke.mjs
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { scanRepo, buildModulePages } from '../../plugins/dsh-tripipelines/lib/knowledge/scan.js'
import { extractDecisions } from '../../plugins/dsh-tripipelines/lib/knowledge/ledger.js'
import { recall } from '../../plugins/dsh-tripipelines/lib/knowledge/recall.js'

let passed = 0
let failed = 0
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`PASS  ${name}`) }
  else { failed++; console.log(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

// --- synthetic repo ---------------------------------------------------------
const root = join(tmpdir(), `pipe-kb-${Date.now()}`)
const out = join(root, '.dsh', 'pipeline', 'knowledge')
const w = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }

w('backend/app/api/main.py', `"""HTTP endpoints for the sample service."""\n\ndef get_items():\n    return []\n\ndef add_item(name):\n    return {"name": name}\n`)
w('backend/app/services/svc.py', `"""Business logic layer: keeps storage dumb."""\n\nclass Svc:\n    def run(self):\n        pass\n`)
w('frontend/src/views/Home.vue', `<template><div/></template>\n<script>\nexport default { name: 'Home' }\n</script>\n`)
w('frontend/src/components/Card.vue', `<script>\nexport default { props: ['title'] }\n</script>\n`)
w('assets/logo.bin', 'BINARY')
w('dev/project_checkpoint.md', [
  '# Sample project',
  '',
  '## 6. 关键决策',
  '',
  '1. 用 SQLite 而不是 Postgres，因为单机够用，可逆性 high。证据：bench/result.json:12',
  '2. API 必须分页，默认 20 条，否则前端会崩。',
  '',
  '## 7. 结论与结案',
  '',
  '1. 方案 X 已结案：实测不达标，不再追，作废，归档留证据以防后人重跑。',
  '',
  '## 8. 背景',
  '',
  ...Array.from({ length: 14 }, (_, i) => `第 ${i + 1} 段填充：这一段是为了让文档超过八百字符的门槛，从而覆盖 verdict 段抽取路径；真实项目的交接文档通常几万字符。`),
].join('\n'))

try {
  // --- scan -----------------------------------------------------------------
  const scan = scanRepo({ root, outDir: out })
  ok('scan returns counts', Number(scan?.stats?.files) > 0, JSON.stringify(scan?.stats ?? null))
  ok('index.md written', existsSync(join(out, 'index.md')))
  const idx = readFileSync(join(out, 'index.md'), 'utf8')
  ok('index.md has header', /knowledge index/.test(idx))
  ok('index.md lists a module', /backend|frontend/.test(idx))
  ok('map.json written + hashes', (() => {
    const p = join(out, 'map.json')
    if (!existsSync(p)) return false
    const m = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(m.modules) && m.modules.some((x) => (x.entries ?? []).some((e) => typeof e.sha8 === 'string' && e.sha8.length === 8))
  })())
  ok('binary file not indexed as code', (() => {
    const m = JSON.parse(readFileSync(join(out, 'map.json'), 'utf8'))
    return (m.modules ?? []).every((x) => (x.entries ?? []).every((e) => !String(e.path).endsWith('.bin')))
  })())

  // --- module pages ---------------------------------------------------------
  const map = JSON.parse(readFileSync(join(out, 'map.json'), 'utf8'))
  const pages = buildModulePages({ root, outDir: out, map })
  ok('module pages generated', Number(pages?.pages) > 0, JSON.stringify(pages ?? null))
  ok('a module page exists', existsSync(join(out, 'modules', '_index.md')))
  const pageFiles = readFileSync(join(out, 'modules', '_index.md'), 'utf8')
  ok('page index lists modules', /backend|frontend/.test(pageFiles))

  // --- ledger ---------------------------------------------------------------
  const led = extractDecisions({ root, outDir: out })
  ok('ledger extracts candidates', Number(led?.counts?.total) > 0, JSON.stringify(led?.counts ?? null))
  ok('ledger records the SQLite decision', (() => {
    const p = join(out, 'ledger-candidates.md')
    return existsSync(p) && /SQLite/.test(readFileSync(p, 'utf8'))
  })())
  ok('ledger catches verdict section', /方案 X/.test(readFileSync(join(out, 'ledger-candidates.md'), 'utf8')))

  // --- recall ---------------------------------------------------------------
  const hit1 = recall({ knowledgeDir: out, query: 'SQLite' })
  ok('recall finds SQLite with line number', hit1.hits.length > 0 && hit1.hits[0].line > 0, JSON.stringify(hit1.hits.slice(0, 1)))
  const hit2 = recall({ knowledgeDir: out, query: '分页' })
  ok('recall handles Chinese query', hit2.hits.length > 0)
  const hit3 = recall({ knowledgeDir: out, query: 'zzz-no-such-term-zzz' })
  ok('recall returns no false hits', hit3.hits.length === 0)

  // --- research notes (v117) -------------------------------------------------
  mkdirSync(join(out, 'research'), { recursive: true })
  writeFileSync(
    join(out, 'research', '2026-10-29-path.md'),
    '# 研讨：下一步投哪条路径\n\n## 2. 证据\n- E1 见 bench/result.json:12，吞吐提升 1.8x\n',
  )
  const hit4 = recall({ knowledgeDir: out, query: '吞吐' })
  ok('recall indexes research notes by default', hit4.hits.some((h) => h.source.startsWith('research/')), JSON.stringify(hit4.hits.slice(0, 2)))
} finally {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

console.log(`\nv98 knowledge smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1






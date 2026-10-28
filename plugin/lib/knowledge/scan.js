import { readText, redact } from '../util.js'
/**
 * Knowledge layer — mechanical repo scanner (pipeline_scan v98).
 *
 * Turns a repository into artifacts an L1 agent can read instead of re-reading
 * the whole codebase:
 *   - map.json       : machine-readable inventory (modules / files / hashes / git state)
 *   - index.md       : one-page index (~1.6K tokens for a 1500-file repo)
 *   - modules/*.md   : one page per code module (role / entry points / surface / deps)
 *
 * Everything is extracted mechanically (docstrings, __all__, top-level defs,
 * imports, TODO markers) — 0 model tokens, never drifts from the code.
 * Read-only w.r.t. the scanned repo.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const SKIP_DIRS = new Set([
  '.git', '.venv', 'venv', 'env', 'node_modules', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next', '.idea', '.vscode',
  'coverage', 'htmlcov', '.tox', '.m17_stage', '.dsh',
])
const SKIP_EXT = new Set([
  '.parquet', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.pyc', '.pyo', '.db', '.sqlite', '.sqlite3', '.pkl', '.pickle', '.zip', '.gz',
  '.tar', '.7z', '.exe', '.dll', '.so', '.dylib', '.npy', '.npz', '.h5', '.onnx',
  '.woff', '.woff2', '.ttf', '.map', '.pdf', '.xlsx', '.csv',
])
const CODE_EXT = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.sql', '.sh', '.ps1', '.psm1',
  '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.cs', '.fs', '.rb', '.php', '.swift', '.lua', '.pl',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.dart', '.ex', '.exs', '.clj', '.hs', '.jl', '.r',
])
const DOC_EXT = new Set(['.md', '.rst', '.txt', '.adoc'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

// v99: files that almost always carry credentials are recorded by path/size only — never read.
const SECRET_NAME = /(?:^|[._-])(?:env|secrets?|credentials?|passwords?|tokens?|keys?|auth)(?:[._-]|$)|^\.env|\.(?:pem|p12|pfx|jks|keystore)$|^id_(?:rsa|ed25519|ecdsa|dsa)$/i
// v104: all knowledge-layer writes go through util.redact() — see scan index,
// module pages and ledger candidates. Nothing here may persist a raw secret.

const sha8 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 8)
const lineCount = (p) => { try { return readText(p).split('\n').length - 1 } catch { return 0 } }
const clean = (s) => String(s).replace(/-{3,}/g, ' ').replace(/[`*#]/g, '').replace(/\s+/g, ' ').trim()
const oneLine = (s, max = 180) => clean(s).slice(0, max)
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))
const slug = (id) => String(id).replace(/[\\/]/g, '__').replace(/[^\w.-]/g, '_')

// dirs that are material (docs / research data / checkpoints), not product code.
// v99: generic defaults + pattern fallback so non-Python/Go/Java projects group sanely.
const MATERIAL_DIRS = new Set(['dev', 'docs', 'doc', 'design', 'data', 'reference', 'references', 'samples', 'examples', 'assets', 'resources', 'team_board'])
const MATERIAL_RE = /^(?:dev|docs?|design|reference|references|samples?|examples?|assets?|resources?|data|team_board|材料|资料|参考|笔记)$/i
const isMaterial = (id) => MATERIAL_DIRS.has(id) || MATERIAL_RE.test(id)

const MODULE_HINTS = {
  'backend/app/api': 'HTTP endpoints',
  'backend/app/services': 'business logic',
  'backend/app/core': 'domain engines',
  'backend/app/data': 'data access layer',
  'backend/app/models': 'ORM models',
  'backend/app/schemas': 'schemas',
  'backend/tests': 'test suites',
  'backend/scripts': 'one-off jobs',
  'frontend/src/views': 'page views',
  'frontend/src/components': 'reusable components',
  'frontend/src/utils': 'pure helpers',
  'frontend/src/api': 'HTTP client',
  'frontend/src/stores': 'state stores',
  'frontend/src/router': 'routes',
  // generic conventions (Go / Rust / Java / Node workspaces) — v99
  'cmd': 'executables / entrypoints',
  'internal': 'private packages',
  'pkg': 'public packages',
  'src': 'source root',
  'src/main': 'application source',
  'src/main/java': 'java sources',
  'src/main/kotlin': 'kotlin sources',
  'src/test': 'test sources',
  'app': 'application layer',
  'server': 'server side',
  'api': 'API layer',
  'web': 'web client',
  'ui': 'UI layer',
  'lib': 'library',
  'core': 'core logic',
  'services': 'services',
  'tests': 'test suites',
  'test': 'test suites',
  'scripts': 'one-off jobs',
  'migrations': 'db migrations',
  'crates': 'rust crates',
  'packages': 'workspace packages',
  'modules': 'modules',
}

// roots that group code into `<root>/<pkg>` modules
const GROUP_ROOTS = new Set(['backend', 'frontend', 'server', 'client', 'web', 'apps', 'packages', 'crates', 'services', 'cmd', 'internal', 'pkg', 'src', 'app', 'lib', 'core', 'modules'])

function moduleOf(rel) {
  const parts = rel.split('/')
  const top = parts[0]
  if (isMaterial(top)) return top
  const p1 = parts[1]
  // backend/app/x · frontend/src/x · src/main/java/x · apps/web/src/x → keep three segments
  if (p1 && (p1 === 'app' || p1 === 'src' || p1 === 'main') && parts.length > 3) return parts.slice(0, 3).join('/')
  if (GROUP_ROOTS.has(top) && parts.length > 2) return parts.slice(0, 2).join('/')
  return top
}

function walk(root, dir, acc, depth = 0) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (depth < 12) walk(root, full, acc, depth + 1)
      continue
    }
    if (!e.isFile()) continue
    const ext = extname(e.name).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    let st
    try { st = statSync(full) } catch { continue }
    if (st.size > MAX_FILE_BYTES) continue
    acc.push({ full, rel: relative(root, full).split(sep).join('/'), ext, size: st.size, mtime: st.mtimeMs, secret: SECRET_NAME.test(e.name) })
  }
  return acc
}

function checkpointState(root) {
  for (const p of ['dev/project_checkpoint.md', 'dev/checkpoint.md', 'PROJECT_CHECKPOINT.md', 'docs/project_checkpoint.md']) {
    const full = join(root, p)
    if (!existsSync(full)) continue
    const txt = readText(full)
    if (!txt) continue
    const m = txt.match(/##\s*0\.[^\n]*\n+([\s\S]{0,1200}?)(?=\n##\s|\n*$)/)
    const body = (m ? m[1] : txt.slice(0, 1000)).replace(/\s+/g, ' ').trim()
    return { path: p, excerpt: redact(body).slice(0, 420) }
  }
  return null
}

function gitInfo(root) {
  const git = { head: null, subject: null, dirty: null, commits: [] }
  try {
    const log = execFileSync('git', ['-C', root, 'log', '--format=%h|%ad|%s', '--date=short', '-8'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    git.commits = log.trim().split('\n').filter(Boolean).map((l) => {
      const [h, d, s] = l.split('|')
      return { hash: h, date: d, subject: (s ?? '').slice(0, 100) }
    })
    git.head = git.commits[0]?.hash ?? null
    git.subject = git.commits[0]?.subject ?? null
    git.dirty = String(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })).trim().length > 0
  } catch { /* not a git repo */ }
  return git
}

function bigDirs(root) {
  const out = []
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const p = join(root, e.name)
      let n = 0, bytes = 0
      const stack = [p]
      while (stack.length) {
        const cur = stack.pop()
        let ents
        try { ents = readdirSync(cur, { withFileTypes: true }) } catch { continue }
        for (const x of ents) {
          if (x.isDirectory()) { if (!SKIP_DIRS.has(x.name)) stack.push(join(cur, x.name)) }
          else { n++; try { bytes += statSync(join(cur, x.name)).size } catch { /* skip */ } }
        }
        if (n > 400000) break
      }
      if (bytes > 50 * 1024 * 1024) out.push({ dir: e.name, files: n, mb: Math.round(bytes / 1048576) })
    }
  } catch { /* best-effort */ }
  return out
}

/** Scan a repo and write map.json + index.md. Returns the map plus counts. */
export function scanRepo({ root, outDir }) {
  if (!root || !existsSync(root)) throw new Error(`pipeline_scan: root not found: ${root}`)
  const files = walk(root, root, [])
  const modules = new Map()
  const codeHashes = {}
  for (const f of files) {
    const id = moduleOf(f.rel)
    if (!modules.has(id)) modules.set(id, { id, files: 0, lines: 0, bytes: 0, codeFiles: 0, docFiles: 0, secretFiles: 0, entries: [], newest: 0 })
    const m = modules.get(id)
    m.files++
    m.bytes += f.size
    m.newest = Math.max(m.newest, f.mtime)
    if (f.secret) { m.secretFiles++; continue }
    if (CODE_EXT.has(f.ext)) {
      m.codeFiles++
      const lines = lineCount(f.full)
      m.lines += lines
      const h = sha8(readFileSync(f.full))
      codeHashes[f.rel] = h
      if (m.entries.length < 12) m.entries.push({ path: f.rel, lines, size: f.size, sha8: h })
    } else if (DOC_EXT.has(f.ext)) {
      m.docFiles++
    }
  }
  const moduleList = [...modules.values()]
    .filter((m) => m.codeFiles > 0 || m.docFiles > 0)
    .map((m) => ({
      id: m.id,
      kind: isMaterial(m.id) ? 'material' : 'code',
      hint: MODULE_HINTS[m.id] ?? '',
      files: m.files,
      codeFiles: m.codeFiles,
      docFiles: m.docFiles,
      secretFiles: m.secretFiles,
      lines: m.lines,
      bytes: m.bytes,
      newest: new Date(m.newest).toISOString().slice(0, 10),
      entries: m.entries.sort((a, b) => b.lines - a.lines).slice(0, 10),
    }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files)

  const isDoc = (f) => {
    if (f.secret) return false
    if (f.rel.startsWith('data/')) return false
    const ext = extname(f.rel).toLowerCase()
    if (ext === '.md' || ext === '.rst') return true
    if (ext !== '.txt') return false
    if (isMaterial(f.rel.split('/')[0])) return false
    return !/(requirements|all_symbols|lock|sha256)/i.test(f.rel)
  }
  const docs = files
    .filter(isDoc)
    .map((f) => ({ path: f.rel, bytes: f.size, head: oneLine(redact(readText(f.full).split('\n').slice(0, 3).join(' ')), 110), mtime: new Date(f.mtime).toISOString().slice(0, 10) }))
    .sort((a, b) => b.bytes - a.bytes)

  const state = checkpointState(root)
  const git = gitInfo(root)
  const heavy = bigDirs(root)
  const map = {
    tool: 'pipeline_scan',
    version: 98,
    generatedAt: new Date().toISOString(),
    root,
    git,
    totals: {
      scannedFiles: files.length,
      codeFiles: files.filter((f) => CODE_EXT.has(f.ext)).length,
      docFiles: files.filter((f) => DOC_EXT.has(f.ext)).length,
      codeLines: moduleList.reduce((s, m) => s + m.lines, 0),
    },
    bigDirs: heavy,
    modules: moduleList,
    docs,
  }

  const name = root.split(/[\\/]/).pop() || root
  const codeMods = moduleList.filter((m) => m.kind === 'code' && m.codeFiles > 0)
  const matMods = moduleList.filter((m) => m.kind === 'material')
  const idx = []
  idx.push(`# ${name} — knowledge index (auto-generated by pipeline_scan)`)
  idx.push('')
  idx.push(`scanned ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · head \`${git.head ?? 'n/a'}\` · ${fmt(files.length)} files · product code ${fmt(codeMods.reduce((s, m) => s + m.lines, 0))} lines`)
  idx.push('')
  if (state) {
    idx.push(`## current state (from \`${state.path}\`)`)
    idx.push('')
    idx.push(`> ${state.excerpt}`)
    idx.push('')
  }
  idx.push('## code modules')
  idx.push('| module | files | lines | role |')
  idx.push('|---|---:|---:|---|')
  for (const m of codeMods.slice(0, 12)) idx.push(`| [\`${m.id}\`](modules/${slug(m.id)}.md) | ${m.codeFiles} | ${fmt(m.lines)} | ${m.hint || '—'} |`)
  if (codeMods.length > 12) idx.push(`| _+${codeMods.length - 12} smaller modules_ | | | |`)
  idx.push('')
  idx.push('> one page per module under `modules/` (role, entry points, public surface, deps, signals)')
  idx.push('')
  if (matMods.length) {
    idx.push('## material dirs (docs / research / data — not product code)')
    for (const m of matMods.sort((a, b) => b.bytes - a.bytes)) idx.push(`- \`${m.id}/\` ${fmt(m.files)} files · ${fmt(m.bytes)}B · ${m.hint || 'material'}`)
    idx.push('')
  }
  idx.push('## docs (largest first)')
  for (const d of docs.slice(0, 12)) idx.push(`- \`${d.path}\` ${fmt(d.bytes)}B — ${d.head || '(no heading)'}`)
  if (docs.length > 12) idx.push(`- _+${docs.length - 12} more_`)
  idx.push('')
  if (heavy.length) {
    idx.push('## data / heavy dirs (not walked)')
    for (const b of heavy) idx.push(`- \`${b.dir}/\` ${b.files} files ≈ ${b.mb} MB`)
    idx.push('')
  }
  if (git.commits.length) {
    idx.push('## recent commits')
    for (const c of git.commits.slice(0, 5)) idx.push(`- \`${c.hash}\` ${c.date} ${c.subject}`)
    idx.push('')
  }
  idx.push('## how to use')
  idx.push('- read this file first; open `map.json` only for exact file lists/hashes')
  idx.push('- drill into one module page at a time; never re-read the whole repo')
  const indexMd = idx.join('\n') + '\n'

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'map.json'), JSON.stringify(map, null, 1))
  writeFileSync(join(outDir, 'index.md'), indexMd)
  writeFileSync(join(outDir, 'hashes.json'), JSON.stringify({ version: 99, generatedAt: map.generatedAt, root, files: codeHashes }))
  return { map, indexMd, stats: { files: files.length, modules: moduleList.length, docs: docs.length, codeLines: map.totals.codeLines, secretFiles: files.filter((f) => f.secret).length } }
}

/**
 * v99: is the knowledge base stale? Compares hashes.json (written by scanRepo) against the
 * working tree. Read-only, no model tokens. Returns the changed/added/removed files plus the
 * modules whose pages should be regenerated.
 */
export function checkStale({ root, outDir }) {
  if (!root || !existsSync(root)) throw new Error(`pipeline_scan: root not found: ${root}`)
  const empty = { available: false, changed: [], added: [], removed: [], modules: [], stale: false }
  const hp = join(outDir, 'hashes.json')
  if (!existsSync(hp)) return { ...empty, reason: 'no hashes.json — run pipeline_scan once without check first' }
  let prev
  try { prev = JSON.parse(readFileSync(hp, 'utf8')) } catch { return { ...empty, reason: 'hashes.json unreadable — re-run pipeline_scan' } }
  const old = prev.files && typeof prev.files === 'object' ? prev.files : {}
  const files = walk(root, root, [])
  const now = new Map()
  for (const f of files) {
    if (f.secret || !CODE_EXT.has(f.ext)) continue
    now.set(f.rel, sha8(readFileSync(f.full)))
  }
  const changed = []
  const added = []
  const removed = []
  for (const [p, h] of now) {
    if (!(p in old)) added.push(p)
    else if (old[p] !== h) changed.push(p)
  }
  for (const p of Object.keys(old)) if (!now.has(p)) removed.push(p)
  const touched = new Set()
  for (const p of [...changed, ...added, ...removed]) touched.add(moduleOf(p))
  const out = {
    available: true,
    generatedAt: prev.generatedAt ?? null,
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
    modules: [...touched].sort(),
    stale: changed.length + added.length + removed.length > 0,
  }
  return out
}

// ---------- module pages ----------
const PY_TOP = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm
const APP_IMPORT = /^\s*from\s+app\.([\w.]+)\s+import/gm
const TODO = /\b(TODO|FIXME|HACK|XXX)\b/g

const pyDocstring = (src) => {
  const m = src.match(/^\s*(?:#![^\n]*\n)?\s*(?:#[^\n]*\n\s*)*("""|''')([\s\S]*?)\1/)
  return m ? oneLine(m[2]) : ''
}
const jsExports = (src) => {
  const names = new Set()
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_]\w*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^\s*export\s+const\s+([A-Za-z_]\w*)/gm)) names.add(m[1])
  for (const m of src.matchAll(/^\s*export\s+class\s+([A-Za-z_]\w*)/gm)) names.add(m[1])
  return [...names]
}
const jsHeader = (src) => {
  const m = src.match(/^\s*\/\*\*([\s\S]{0,240}?)\*\//)
  if (!m) return ''
  const txt = clean(m[1])
  return txt.length >= 12 && !/^[0-9\s→\-]/.test(txt) ? oneLine(txt, 160) : ''
}
const headerDoc = (rel, src) => (rel.endsWith('.py') ? pyDocstring(src) : jsHeader(src))

function filesUnder(dir, skipDirs = new Set(), acc = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of ents) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (['__pycache__', 'node_modules', 'dist'].includes(e.name)) continue
      if (skipDirs.has(e.name)) continue
      filesUnder(full, skipDirs, acc)
      continue
    }
    acc.push(full)
  }
  return acc
}

function modulePage(root, map, m) {
  const dir = join(root, m.id)
  const children = map.modules.filter((x) => x.id !== m.id && x.id.startsWith(m.id + '/'))
  const childNames = new Set(children.map((x) => x.id.slice(m.id.length + 1).split('/')[0]))
  const all = filesUnder(dir, childNames)
  const srcFiles = all.filter((f) => {
    const base = f.split(/[\\/]/).pop() || ''
    if (SECRET_NAME.test(base)) return false
    return CODE_EXT.has(extname(f).toLowerCase())
  })

  let role = ''
  for (const n of ['__init__.py', 'index.js', 'index.ts', 'mod.ts']) {
    const p = join(dir, n)
    if (existsSync(p)) { role = headerDoc(n, readText(p)); if (role) break }
  }
  if (!role) {
    const largest = srcFiles.map((f) => ({ f, lines: lineCount(f) })).sort((a, b) => b.lines - a.lines)[0]
    if (largest) role = headerDoc(largest.f, readText(largest.f))
  }

  const entries = srcFiles
    .map((f) => ({ path: f.slice(dir.length + 1).split('\\').join('/'), lines: lineCount(f), f }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 6)
    .map((e) => {
      const src = readText(e.f)
      if (e.f.endsWith('.py')) return { path: e.path, lines: e.lines, what: redact(oneLine(headerDoc(e.f, src), 100)) }
      const names = jsExports(src).slice(0, 3)
      return { path: e.path, lines: e.lines, what: names.length ? `exports: ${names.join(', ')}` : '' }
    })

  let surface = []
  const initPy = join(dir, '__init__.py')
  if (existsSync(initPy)) {
    const src = readText(initPy)
    const mAll = src.match(/__all__\s*=\s*\[([\s\S]*?)\]/)
    if (mAll) {
      surface = [...mAll[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
    } else {
      const names = new Set()
      for (const mm of src.matchAll(/^from\s+\.\S*\s+import\s+\(?([^)\n]+)\)?/gm)) {
        for (const n of mm[1].split(',')) { const t = n.trim().split(/\s+as\s+/).pop(); if (t && t !== '*') names.add(t) }
      }
      surface = [...names]
    }
  }
  if (surface.length === 0) {
    const names = new Set()
    for (const f of srcFiles.filter((x) => x.endsWith('.py')).slice(0, 12)) {
      for (const mm of readText(f).matchAll(PY_TOP)) if (!mm[1].startsWith('_')) names.add(mm[1])
    }
    surface = [...names].slice(0, 14)
  }
  surface = surface.slice(0, 16)

  const selfPkg = m.id.startsWith('backend/app') ? 'app.' + m.id.replace('backend/app', '').replace(/^\//, '').split('/')[0] : ''
  const depCount = new Map()
  for (const f of srcFiles.filter((x) => x.endsWith('.py')).slice(0, 40)) {
    for (const mm of readText(f).matchAll(APP_IMPORT)) {
      const head = `app.${mm[1].split('.')[0]}`
      if (head === selfPkg) continue
      depCount.set(head, (depCount.get(head) ?? 0) + 1)
    }
  }
  const deps = [...depCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)

  let todos = 0
  for (const f of srcFiles) todos += (readText(f).match(TODO) ?? []).length
  const oversized = entries.filter((e) => e.lines > 800)

  const jsNames = m.id.startsWith('frontend/') ? [...new Set(srcFiles.flatMap((f) => jsExports(readText(f))))].slice(0, 10) : []
  if (!role && jsNames.length) role = `exports: ${jsNames.join(', ')}`

  const L = []
  L.push(`# ${m.id}`)
  L.push('')
  L.push(`> ${redact(role) || '(no module docstring — describe this module in one sentence)'}`)
  L.push('')
  L.push(`\`${m.codeFiles}\` files · \`${m.lines}\` lines · newest \`${m.newest}\``)
  L.push('')
  L.push('## entry points')
  L.push('| file | lines | what |')
  L.push('|---|---:|---|')
  for (const e of entries) L.push(`| \`${e.path}\` | ${e.lines} | ${e.what || '—'} |`)
  L.push('')
  if (surface.length) {
    L.push('## public surface')
    L.push('```')
    L.push(surface.join(', '))
    L.push('```')
    L.push('')
  }
  if (deps.length) {
    L.push('## depends on')
    L.push(deps.map(([d]) => `\`${d}\``).join(' · '))
    L.push('')
  }
  const sig = []
  if (todos > 0) sig.push(`${todos} TODO/FIXME marker(s)`)
  for (const o of oversized) sig.push(`oversized file: \`${o.path}\` (${o.lines} lines) — consider splitting`)
  if (sig.length) { L.push('## signals'); for (const s of sig) L.push(`- ${s}`); L.push('') }

  return { slug: slug(m.id), id: m.id, text: L.join('\n') }
}

/** Write one page per code module + a pages index. */
export function buildModulePages({ root, outDir, map }) {
  const pageDir = join(outDir, 'modules')
  mkdirSync(pageDir, { recursive: true })
  const pages = map.modules
    .filter((m) => m.kind === 'code' && m.codeFiles > 0)
    .map((m) => modulePage(root, map, m))
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const p of pages) writeFileSync(join(pageDir, `${p.slug}.md`), p.text + '\n')
  const totalChars = pages.reduce((s, p) => s + p.text.length, 0)
  const idx = []
  idx.push('# module pages')
  idx.push('')
  idx.push(`${pages.length} pages · ${totalChars} chars total · generated from \`map.json\` (mechanical extraction, 0 model tokens)`)
  idx.push('')
  idx.push('| module | page |')
  idx.push('|---|---|')
  for (const p of pages) idx.push(`| \`${p.id}\` | [${p.slug}.md](${p.slug}.md) |`)
  idx.push('')
  idx.push('> Read a page before touching that module; correct its `>` role line if the extraction is wrong.')
  const indexMd = idx.join('\n') + '\n'
  writeFileSync(join(pageDir, '_index.md'), indexMd)
  return { pages: pages.length, chars: totalChars, avg: Math.round(totalChars / Math.max(1, pages.length)), indexMd }
}


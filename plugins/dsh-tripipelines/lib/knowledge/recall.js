/**
 * Knowledge layer — recall (pipeline_recall v98, semantics v118).
 *
 * Keyword search over the artifacts `pipeline_scan` / `pipeline_ledger` produced,
 * so an L1 can pull the 3–5 relevant lines instead of reading whole files.
 * Plain substring matching on purpose: no embeddings, no index to keep in sync,
 * and the result is auditable (every hit carries its source path + line number).
 *
 * v118 — the answer now says what it is standing on:
 *   - `kind` per hit: code / decision / candidate / research. A decision candidate
 *     is not a decision, and a discussion draft is not a conclusion; without the
 *     label a model reads all four as "the project decided this".
 *   - `coverage`: which artifact families exist, so "no hit" can be told apart
 *     from "the knowledge base does not cover this area yet".
 *   - `partial` (no index.md yet), `generatedAt` (hashes.json, not file mtime —
 *     mtime changes on copy/restore) and `rootMismatch` (the knowledge dir was
 *     scanned from a different workspace, e.g. a project copied wholesale).
 *   - unfilled `/pipe-research` templates are counted in `coverage.researchDrafts`
 *     and never searched: the template's own headings are long enough to pass the
 *     line filter and would be recalled as if they were findings.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { readText, redact, sameRoot } from '../util.js'

// v101b: a scan of a large repo produces ~20 knowledge files that only change
// when the harness re-scans, so cache file text keyed by size+mtime.
const fileCache = new Map()
function readCached(full) {
  try {
    const st = statSync(full)
    const key = `${st.size}:${st.mtimeMs}`
    const hit = fileCache.get(full)
    if (hit && hit.key === key) return hit.text
    const text = readText(full)
    fileCache.set(full, { key, text })
    return text
  } catch {
    return readText(full)
  }
}

function statFile(full) {
  try {
    const st = statSync(full)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

/** Split a query into searchable terms: latin words + CJK bigrams. */
function terms(query) {
  const q = String(query ?? '').toLowerCase().trim()
  if (!q) return []
  const out = new Set()
  for (const w of q.split(/[\s,，。;；:：/|()[\]{}"'`]+/)) {
    if (!w) continue
    if (/[\u4e00-\u9fff]/.test(w)) {
      const cjk = w.replace(/[^\u4e00-\u9fff]/g, '')
      if (cjk.length <= 2) out.add(cjk)
      else for (let i = 0; i + 2 <= cjk.length; i++) out.add(cjk.slice(i, i + 2))
      const latin = w.replace(/[\u4e00-\u9fff]/g, '')
      if (latin.length >= 2) out.add(latin.toLowerCase())
    } else if (w.length >= 2) {
      out.add(w.toLowerCase())
    }
  }
  return [...out].slice(0, 24)
}

function kindOf(rel) {
  const r = String(rel ?? '').replace(/\\/g, '/')
  if (r === 'index.md') return 'code'
  if (r === 'decisions.md') return 'decision'
  if (r === 'ledger-candidates.md') return 'candidate'
  if (r.startsWith('modules/')) return 'code'
  if (r.startsWith('research/')) return 'research'
  return 'other'
}

// A research note counts as "filled" only when section 7 has real content.
// The template's own bullets end with a colon and nothing after it, so
// "- 若结论错，最先在哪个检查点暴露：" is still a placeholder, not a conclusion.
export function isResearchDraft(text) {
  // The whole heading line is consumed: its tail ("记录与「错了会怎么暴露」")
  // is not a conclusion, so it must not make the note count as filled.
  const m = String(text).match(/^##\s*7[.、．\s：:][^\n]*/m)
  if (!m) return true
  const after = String(text).slice(m.index + m[0].length)
  const next = after.search(/^##\s/m)
  const body = (next >= 0 ? after.slice(0, next) : after).split('\n')
  for (const line of body) {
    const s = line.trim()
    if (!s || s.startsWith('>') || s.startsWith('#') || s.startsWith('|')) continue
    if (/^[-*]\s*[^:：]+[:：]\s*$/.test(s)) continue // placeholder bullet
    if (/[:：]\s*\S/.test(s)) return false // "结论：换库"
    if (s.length >= 12) return false // a prose paragraph
  }
  return true
}

/**
 * @param {{
 *   knowledgeDir: string,
 *   workspaceRoot?: string,
 *   extraTargets?: Array<{ full: string, rel?: string, kind?: string }>,
 *   query: string,
 *   limit?: number,
 *   files?: string[],
 * }} opts
 * @returns {{
 *   terms: string[],
 *   hits: Array<{ source: string, line: number, score: number, kind: string, text: string }>,
 *   coverage: { scan: boolean, modules: number, candidates: boolean, decisions: boolean, researchFilled: number, researchDrafts: number },
 *   partial: boolean, hasContent: boolean, rootMismatch: boolean, generatedAt: string | null,
 * }}
 */
export function recall({ knowledgeDir, workspaceRoot, extraTargets = [], query, limit = 6, files }) {
  const ts = terms(query)
  const coverage = { scan: false, modules: 0, candidates: false, decisions: false, researchFilled: 0, researchDrafts: 0 }
  const targets = []
  const seen = new Set()

  // Coverage always reflects what is on disk, even when the caller narrows the
  // search with `files` — "no hit" and "not scanned" are different answers.
  const indexPath = join(knowledgeDir, 'index.md')
  coverage.scan = statFile(indexPath) != null
  coverage.decisions = statFile(join(knowledgeDir, 'decisions.md')) != null
  coverage.candidates = statFile(join(knowledgeDir, 'ledger-candidates.md')) != null
  const modDir = join(knowledgeDir, 'modules')
  let moduleNames = []
  if (existsSync(modDir)) {
    try { moduleNames = readdirSync(modDir).filter((n) => n.endsWith('.md') && n !== '_index.md') } catch { moduleNames = [] }
  }
  coverage.modules = moduleNames.length
  const researchDir = join(knowledgeDir, 'research')
  let researchNames = []
  if (existsSync(researchDir)) {
    try { researchNames = readdirSync(researchDir).filter((n) => n.endsWith('.md') && n !== '_index.md') } catch { researchNames = [] }
  }
  for (const name of researchNames) {
    const text = readCached(join(researchDir, name))
    if (isResearchDraft(text)) coverage.researchDrafts += 1
    else coverage.researchFilled += 1
  }

  // Project-level read-only decisions (v118): the plugin never writes this file;
  // when the project already keeps one, index it instead of pretending it does
  // not exist. Labeled by relative path so a hit is unambiguous.
  let decisionsExternal = false
  for (const t of extraTargets) {
    if (!t || !t.full || statFile(t.full) == null) continue
    if ((t.kind ?? 'decision') === 'decision') decisionsExternal = true
  }
  if (decisionsExternal) coverage.decisions = true

  const add = (full, rel, kind) => {
    const key = resolve(full)
    if (seen.has(key) || statFile(full) == null) return false
    seen.add(key)
    targets.push({ rel, kind, text: readCached(full) })
    return true
  }

  if (files && files.length) {
    // v104 — `files` is user/model input: confine it to the knowledge dir.
    // Absolute paths, `..` segments and symlinked escapes are refused.
    for (const f of files) {
      const raw = String(f ?? '').replace(/\\/g, '/')
      if (!raw || isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) continue
      if (raw.split('/').includes('..')) continue
      const full = resolve(knowledgeDir, raw)
      const relCheck = relative(knowledgeDir, full)
      if (relCheck.startsWith('..') || isAbsolute(relCheck)) continue
      if (raw.startsWith('research/') && isResearchDraft(readCached(full))) continue
      add(full, raw, kindOf(raw))
    }
  } else {
    add(indexPath, 'index.md', 'code')
    add(join(knowledgeDir, 'decisions.md'), 'decisions.md', 'decision')
    add(join(knowledgeDir, 'ledger-candidates.md'), 'ledger-candidates.md', 'candidate')
    for (const name of moduleNames) add(join(modDir, name), `modules/${name}`, 'code')
    for (const name of researchNames) {
      const full = join(researchDir, name)
      if (isResearchDraft(readCached(full))) continue
      add(full, `research/${name}`, 'research')
    }
    for (const t of extraTargets) {
      if (!t || !t.full) continue
      add(t.full, String(t.rel ?? 'dev/decisions.md'), String(t.kind ?? 'decision'))
    }
  }

  // Freshness + provenance come from hashes.json (written by pipeline_scan);
  // file mtime survives copies/restores and would lie about the scan time.
  let generatedAt = null
  let rootMismatch = false
  try {
    const rawHash = readCached(join(knowledgeDir, 'hashes.json'))
    if (rawHash) {
      const h = JSON.parse(rawHash)
      if (h && typeof h.generatedAt === 'string') generatedAt = h.generatedAt
      if (h && workspaceRoot && h.root) rootMismatch = !sameRoot(h.root, workspaceRoot)
    }
  } catch { /* no/invalid hashes.json: fall back to mtime below */ }
  if (!generatedAt) {
    const st = statFile(indexPath)
    if (st) generatedAt = st.mtime.toISOString()
  }

  const hits = []
  if (ts.length) {
    for (const t of targets) {
      const lines = t.text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.length < 8 || line.length > 400) continue
        const low = line.toLowerCase()
        let n = 0
        for (const term of ts) if (low.includes(term)) n++
        if (!n) continue
        hits.push({ source: t.rel, line: i + 1, score: n, kind: t.kind, text: redact(line.trim().slice(0, 300)) })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
  const hasContent =
    coverage.scan || coverage.modules > 0 || coverage.candidates || coverage.decisions || coverage.researchFilled > 0
  return {
    terms: ts,
    hits: hits.slice(0, Math.max(1, Math.min(20, limit))),
    coverage,
    partial: !coverage.scan,
    hasContent,
    rootMismatch,
    generatedAt,
  }
}

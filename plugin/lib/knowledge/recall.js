/**
 * Knowledge layer — recall (pipeline_recall v98).
 *
 * Keyword search over the artifacts `pipeline_scan` / `pipeline_ledger` produced,
 * so an L1 can pull the 3–5 relevant lines instead of reading whole files.
 * Plain substring matching on purpose: no embeddings, no index to keep in sync,
 * and the result is auditable (every hit carries its source path + line number).
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readText } from '../util.js'

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

/**
 * @param {{ knowledgeDir: string, query: string, limit?: number, files?: string[] }} opts
 * @returns {{ terms: string[], hits: Array<{ source: string, line: number, score: number, text: string }> }}
 */
export function recall({ knowledgeDir, query, limit = 6, files }) {
  const ts = terms(query)
  if (!ts.length) return { terms: [], hits: [] }
  const targets = []
  const push = (rel) => { const full = join(knowledgeDir, rel); if (existsSync(full)) targets.push({ rel, text: readCached(full) }) }
  if (files && files.length) for (const f of files) push(f)
  else {
    push('index.md')
    push('decisions.md')
    push('ledger-candidates.md')
    const modDir = join(knowledgeDir, 'modules')
    if (existsSync(modDir)) {
      try { for (const name of readdirSync(modDir)) if (name.endsWith('.md') && name !== '_index.md') push(join('modules', name)) } catch { /* best-effort */ }
    }
  }
  const hits = []
  for (const t of targets) {
    const lines = t.text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length < 8 || line.length > 400) continue
      const low = line.toLowerCase()
      let n = 0
      for (const term of ts) if (low.includes(term)) n++
      if (!n) continue
      hits.push({ source: t.rel, line: i + 1, score: n, text: line.trim().slice(0, 300) })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
  return { terms: ts, hits: hits.slice(0, limit) }
}

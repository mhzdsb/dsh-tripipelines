import { readText } from '../util.js'
/**
 * Knowledge layer — decision-ledger extractor (pipeline_ledger v98).
 *
 * Repos already contain decisions; they are buried in checkpoints,
 * preregistration docs and "verdict" sections. This pulls them out mechanically
 * so a model only has to *classify* them (status / reversibility / invalidation)
 * instead of re-reading 300 KB of docs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const clean = (s) => String(s).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = clean(s); return t.length > n ? t.slice(0, n) + '…' : t }
const stripLead = (s) => clean(s).replace(/^[：:，,。.\-\s]+/, '')

const CHECKPOINTS = ['dev/project_checkpoint.md', 'dev/checkpoint.md', 'PROJECT_CHECKPOINT.md', 'docs/project_checkpoint.md', 'docs/checkpoint.md']
const VERDICT_SEC = /(结论|判定|收口|结案|归档|verdict|decision|decision log|reject|否决)/i
const STRONG = /(⇒|作废|弃用|驳回|不批|拒绝|不再|结案|封存|reject|blocked|approved|verdict|no_candidate|未采购|放弃)/
const DOC_DIRS = ['docs', 'dev']

function parseIntoSections(text) {
  const out = []
  const re = /^#{2,3}\s*([^\n]+)\n/gm
  const heads = []
  let m
  while ((m = re.exec(text))) heads.push({ title: m[1].trim(), start: m.index, bodyStart: m.index + m[0].length })
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : text.length
    out.push({ title: heads[i].title, body: text.slice(heads[i].bodyStart, end) })
  }
  return out
}

function numberedItems(body) {
  const items = []
  const re = /^(\d{1,2})[.、]\s+([^\n]+(?:\n(?![ \t]*\d{1,2}[.、]\s)[^\n]*)*)/gm
  let m
  while ((m = re.exec(body))) {
    const raw = m[2]
    const bold = raw.match(/^\*\*(.+?)\*\*/)
    const title = clean(bold ? bold[1] : raw.split(/[：:]/)[0])
    const rest = stripLead(bold ? raw.slice(bold[0].length) : raw.slice(title.length))
    if (title.length < 4) continue
    items.push({ n: m[1], title: clip(title, 90), body: clip(rest, 420) })
  }
  return items
}

function missingFields(text) {
  const miss = []
  if (!/(因为|由于|原因|because|→|⇒)/.test(text)) miss.push('rationale')
  if (!/(失效|推翻|重审|invalidate|revisit|重启条件|否则)/.test(text)) miss.push('invalidation')
  if (!/(可逆|不可逆|reversib)/.test(text)) miss.push('reversibility')
  if (!/[\w./-]+\.(py|js|mjs|ts|tsx|jsx|md|json|ya?ml|toml|go|java|kt|rs|cs|rb|php|vue|svelte|sql|sh|ps1):\d+/.test(text)) miss.push('pointer')
  return miss
}

/** Extract decision/verdict/lesson candidates from a repo. Returns counts + paths. */
export function extractDecisions({ root, outDir }) {
  if (!root || !existsSync(root)) throw new Error(`pipeline_ledger: root not found: ${root}`)
  mkdirSync(outDir, { recursive: true })
  const candidates = []

  const cpPath = CHECKPOINTS.find((p) => existsSync(join(root, p)))
  if (cpPath) {
    const text = readText(join(root, cpPath))
    for (const sec of parseIntoSections(text)) {
      if (!/(关键决策|决策记录|key decisions)/i.test(sec.title)) continue
      for (const it of numberedItems(sec.body)) {
        candidates.push({ kind: 'decision', source: `${cpPath}#${sec.title}`, n: it.n, title: it.title, body: it.body, missing: missingFields(it.title + ' ' + it.body) })
      }
    }
    for (const sec of parseIntoSections(text)) {
      if (!/(遗留坑|坑|教训|pitfalls|lessons)/i.test(sec.title)) continue
      for (const it of numberedItems(sec.body)) {
        candidates.push({ kind: 'lesson', source: `${cpPath}#${sec.title}`, n: it.n, title: it.title, body: it.body, missing: missingFields(it.title + ' ' + it.body) })
      }
    }
  }

  const seenBodies = new Set()
  let docsScanned = 0
  for (const d of DOC_DIRS) {
    const dir = join(root, d)
    if (!existsSync(dir)) continue
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!/\.(md|txt)$/i.test(name)) continue
      const text = readText(join(dir, name))
      if (text.length < 800) continue
      docsScanned++
      const rel = `${d}/${name}`
      for (const sec of parseIntoSections(text)) {
        if (!VERDICT_SEC.test(sec.title)) continue
        for (const raw of sec.body.split('\n')) {
          const line = stripLead(raw.replace(/^[-*\d.\s]+/, ''))
          if (line.length < 30 || line.length > 280) continue
          if (!STRONG.test(line)) continue
          const key = line.slice(0, 60)
          if (seenBodies.has(key)) continue
          seenBodies.add(key)
          candidates.push({ kind: 'verdict', source: `${rel}#${sec.title}`, n: '', title: clip(sec.title, 40), body: clip(line, 260), missing: missingFields(line) })
        }
      }
    }
  }

/**
 * v99: mechanical triage. A candidate that already carries a pointer plus either a
 * rationale or an invalidation condition is worth a human/model minute; one with
 * nothing but a claim is noise that would pollute the ledger forever.
 */
function tierOf(c) {
  const has = (f) => !c.missing.includes(f)
  if (c.kind === 'lesson') return 'drop'
  if (c.kind === 'decision') {
    if (has('pointer') && (has('rationale') || has('invalidation'))) return 'keep'
    if (has('pointer') || has('rationale') || has('invalidation')) return 'review'
    return 'drop'
  }
  if (has('invalidation') && (has('pointer') || has('rationale'))) return 'keep'
  return 'review'
}

  candidates.sort((a, b) => (a.kind === b.kind ? 0 : a.kind < b.kind ? -1 : 1))
  for (const c of candidates) c.tier = tierOf(c)
  const byKind = { decision: [], lesson: [], verdict: [] }
  for (const c of candidates) byKind[c.kind].push(c)
  const byTier = { keep: [], review: [], drop: [] }
  for (const c of candidates) byTier[c.tier].push(c)

  const L = []
  L.push('# decision ledger — candidates (auto-extracted, not yet classified)')
  L.push('')
  L.push(`scanned ${cpPath ?? '(no checkpoint)'} + ${docsScanned} docs · ${candidates.length} candidates · **keep ${byTier.keep.length} / review ${byTier.review.length} / drop ${byTier.drop.length}**`)
  L.push('')
  L.push('> **Work the KEEP list first.** For each keeper assign **status** (accepted / rejected / superseded / retired), **reversibility** (low / medium / high), **invalidation** (what would reopen it) and **evidence** (measured / cited / decision / inferred), then write `decisions.md`. REVIEW items need one more piece of evidence to become keepers. DROP items are too thin to maintain — they stay in `ledger.json` for audit but should not enter the ledger.')
  L.push('')
  const emit = (list) => {
    L.push('| # | kind | title | claim | source | missing |')
    L.push('|---|---|---|---|---|---|')
    for (const c of list) {
      const claim = clip(stripLead(c.body), c.kind === 'lesson' ? 120 : 150).replace(/\|/g, '/')
      L.push(`| ${c.n || '·'} | ${c.kind} | ${clip(c.title, 80).replace(/\|/g, '/')} | ${claim || '—'} | \`${c.source}\` | ${c.missing.join(' ')} |`)
    }
    L.push('')
  }
  if (byTier.keep.length) { L.push(`## KEEP — classify these into decisions.md (${byTier.keep.length})`); L.push(''); emit(byTier.keep) }
  if (byTier.review.length) { L.push(`## REVIEW — need evidence before they can be kept (${byTier.review.length})`); L.push(''); emit(byTier.review) }
  if (byTier.drop.length) {
    L.push(`## DROP — too thin, audit only (${byTier.drop.length})`)
    L.push('')
    emit(byTier.drop.slice(0, 15))
    if (byTier.drop.length > 15) { L.push(`_… +${byTier.drop.length - 15} more in \`ledger.json\`_`); L.push('') }
  }
  const candidatesMd = L.join('\n')
  writeFileSync(join(outDir, 'ledger-candidates.md'), candidatesMd)
  writeFileSync(join(outDir, 'ledger.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    checkpoint: cpPath ?? null,
    docsScanned,
    counts: { decision: byKind.decision.length, verdict: byKind.verdict.length, lesson: byKind.lesson.length, keep: byTier.keep.length, review: byTier.review.length, drop: byTier.drop.length },
    candidates,
  }, null, 1))
  return {
    counts: { decision: byKind.decision.length, verdict: byKind.verdict.length, lesson: byKind.lesson.length, keep: byTier.keep.length, review: byTier.review.length, drop: byTier.drop.length, total: candidates.length },
    docsScanned,
    checkpoint: cpPath ?? null,
    candidatesMd,
    chars: candidatesMd.length,
  }
}

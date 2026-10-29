/**
 * Knowledge-layer tools (v98): pipeline_scan / pipeline_ledger / pipeline_recall.
 *
 * Motivation: an L1 that re-reads a large repo burns six figures of tokens before
 * it can even decide anything. These tools produce and query a mechanical
 * knowledge base under `<workspace>/.dsh/pipeline/knowledge/` so the cold start is
 * one index page + two module pages + the decision ledger.
 *
 * All three are L1-only (they shape long-lived project memory, not a subtask).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { text } from '../util.js'
import { resolveWorkspaceRoot } from '../dsh-compat.js'
import { scanRepo, buildModulePages, checkStale } from '../knowledge/scan.js'
import { extractDecisions } from '../knowledge/ledger.js'
import { recall as recallHits } from '../knowledge/recall.js'

const knowledgeDir = (r) => join(r?.store?.stateDir ?? process.cwd(), 'knowledge')
const workspaceOf = (ctx, exec, args, r) =>
  String(args?.root ?? '').trim() || r?.store?.workspaceRoot || resolveWorkspaceRoot(ctx, exec) || process.cwd()

const render = (_a, value) => text(JSON.stringify(value))

export function makeScanTool(ctx, cfg, r) {
  return {
    name: 'pipeline_scan',
    description: 'Scan workspace → index.md + map.json + one page per module (no model calls). check:true = stale only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Repo root (default: workspace).' },
        pages: { type: 'boolean', description: 'Also generate per-module pages (default true).' },
        check: { type: 'boolean', description: 'Stale only: changed/added/removed files + pages to rebuild.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args, exec) {
      const root = workspaceOf(ctx, exec, args, r)
      const outDir = knowledgeDir(r)
      if (args?.check === true) {
        const stale = checkStale({ root, outDir })
        return {
          ok: true,
          mode: 'check',
          root,
          knowledgeDir: outDir,
          ...stale,
          hint: !stale.available
            ? stale.reason
            : stale.stale
              ? `Knowledge base is stale: regenerate with pipeline_scan (${stale.changed.length} changed, ${stale.added.length} added, ${stale.removed.length} removed).`
              : 'Knowledge base is up to date — no code file changed since the last scan.',
        }
      }
      const scan = scanRepo({ root, outDir })
      const wantPages = args?.pages !== false
      const pages = wantPages ? buildModulePages({ root, outDir, map: scan.map }) : null
      return {
        ok: true,
        root,
        knowledgeDir: outDir,
        files: scan.stats.files,
        modules: scan.stats.modules,
        codeLines: scan.stats.codeLines,
        docs: scan.stats.docs,
        secretFiles: scan.stats.secretFiles,
        indexChars: scan.indexMd.length,
        indexTokensEst: Math.ceil(scan.indexMd.length / 3.2),
        pageCount: pages?.pages ?? 0,
        pageChars: pages?.chars ?? 0,
        index: `${outDir}/index.md`,
        hint: wantPages
          ? 'Read index.md first, then at most 2–3 module pages. Run pipeline_ledger to get the decision ledger.'
          : 'Read index.md first. Pages were skipped (pages:false).',
      }
    },
  }
}

export function makeLedgerTool(ctx, cfg, r) {
  return {
    name: 'pipeline_ledger',
    description: 'Extract decision candidates; classify keepers into decisions.md.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Repo root (default: workspace).' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args, exec) {
      const root = workspaceOf(ctx, exec, args, r)
      const outDir = knowledgeDir(r)
      const res = extractDecisions({ root, outDir })
      return {
        ok: true,
        root,
        checkpoint: res.checkpoint,
        docsScanned: res.docsScanned,
        counts: res.counts,
        candidatesChars: res.chars,
        candidatesFile: `${outDir}/ledger-candidates.md`,
        hint:
          res.counts.total === 0
            ? 'No decision-like sections found. Most repos keep decisions in a checkpoint/prereg; if this project has none, skip the ledger.'
            : `Read ledger-candidates.md once (${res.counts.total} rows), keep the durable ones and write decisions.md with status / reversibility / invalidation / evidence per decision.`,
      }
    },
  }
}

export function makeRecallTool(ctx, cfg, r) {
  return {
    name: 'pipeline_recall',
    description: 'Keyword search over the knowledge base (index / decisions / module pages / research notes); returns file:line hits.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Keywords (CN/EN), substring match.' },
        limit: { type: 'number', description: 'Max hits (default 6, cap 20).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Restrict to these files (e.g. ["decisions.md"]).' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render },
    async execute(args) {
      const dir = knowledgeDir(r)
      if (!existsSync(join(dir, 'index.md'))) {
        return { ok: false, error: `knowledge base missing at ${dir} — run pipeline_scan first` }
      }
      const limit = Math.min(20, Math.max(1, Number(args?.limit) > 0 ? Number(args.limit) : 6))
      const res = recallHits({ knowledgeDir: dir, query: args?.query ?? '', limit, files: Array.isArray(args?.files) ? args.files.map(String) : undefined })
      return {
        ok: true,
        knowledgeDir: dir,
        terms: res.terms,
        hitCount: res.hits.length,
        hits: res.hits.map((h) => ({ source: `${h.source}:${h.line}`, score: h.score, text: h.text })),
        hint: res.hits.length ? 'Cite these sources when you report; do not paraphrase numbers from memory.' : 'No hit — the knowledge base does not cover this yet; ask the user or scan a narrower path.',
      }
    },
  }
}

export function makeKnowledgeTools(ctx, cfg, r) {
  return [makeScanTool(ctx, cfg, r), makeLedgerTool(ctx, cfg, r), makeRecallTool(ctx, cfg, r)]
}

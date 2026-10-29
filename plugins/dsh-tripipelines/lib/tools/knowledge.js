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
import { text, resolveInside } from '../util.js'
import { resolveWorkspaceRoot } from '../dsh-compat.js'
import { scanRepo, buildModulePages, checkStale } from '../knowledge/scan.js'
import { extractDecisions } from '../knowledge/ledger.js'
import { recall as recallHits } from '../knowledge/recall.js'

// v118 — no process.cwd() fallback: the daemon's cwd is the profile dir, and
// writing a knowledge base there is how two projects end up sharing state.
const knowledgeDir = (r) => {
  const stateDir = r?.store?.stateDir
  if (!stateDir) throw new Error('知识库不可用：当前调用没有绑定工作区（v118 隔离契约，不再回退到进程 cwd）。')
  return join(stateDir, 'knowledge')
}

// Resolve the calling workspace; a supplied `root` must stay inside it.
// Scanning another project and storing the result here is the cross-project
// contamination path v118 closes (see docs/agent-lifecycle-design.md §19).
const workspaceOf = (ctx, exec, args, r) => {
  const base = r?.store?.workspaceRoot || resolveWorkspaceRoot(ctx, exec)
  if (!base) throw new Error('无法定位当前工作区：请在项目目录内调用（插件按会话 cwd 绑定工作区）。')
  const raw = String(args?.root ?? '').trim()
  return raw ? resolveInside(base, raw, 'root') : base
}

const render = (_a, value) => text(JSON.stringify(value))

export function makeScanTool(ctx, cfg, r) {
  return {
    name: 'pipeline_scan',
    description: 'Scan workspace → index.md + map.json + one page per module (no model calls). check:true = stale only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        root: { type: 'string', description: 'Repo root inside the current workspace (default: workspace).' },
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
        root: { type: 'string', description: 'Repo root inside the current workspace (default: workspace).' },
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
    description:
      'Keyword search over the knowledge base (index / decisions / module pages / research notes, plus a project-owned dev/decisions.md read-only); returns file:line hits with a `kind` label (code / decision / candidate / research) and coverage.',
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
    async execute(args, exec) {
      const dir = knowledgeDir(r)
      const root = r?.store?.workspaceRoot || resolveWorkspaceRoot(ctx, exec)
      if (!root) throw new Error('无法定位当前工作区：请在项目目录内调用（插件按会话 cwd 绑定工作区）。')
      // The plugin never creates or edits this file; it only indexes a project
      // decision log when the project already keeps one (v118 read-only boundary).
      const devAbs = resolveInside(root, String(cfg?.devDir ?? 'dev'), 'devDir')
      const extra = join(devAbs, 'decisions.md')
      const extraTargets = existsSync(extra) ? [{ full: extra, rel: `${String(cfg?.devDir ?? 'dev').replace(/\\/g, '/')}/decisions.md`, kind: 'decision' }] : []
      const limit = Math.min(20, Math.max(1, Number(args?.limit) > 0 ? Number(args.limit) : 6))
      const res = recallHits({
        knowledgeDir: dir,
        workspaceRoot: root,
        extraTargets,
        query: args?.query ?? '',
        limit,
        files: Array.isArray(args?.files) ? args.files.map(String) : undefined,
      })
      if (!res.hasContent) {
        return { ok: false, error: `knowledge base empty at ${dir} — run pipeline_scan first (nothing indexed yet).` }
      }
      const hint = res.hits.length
        ? res.partial
          ? 'Hits are partial (no full scan yet): point at the files directly for anything absent. Cite sources; do not turn a `candidate`/`research` hit into a decision.'
          : 'Cite these sources when you report; a `candidate` hit is not a decision, and a `research` hit is a discussion note.'
        : res.partial
          ? 'No hit and the knowledge base has no full scan — run pipeline_scan (or check the coverage field) before concluding the codebase lacks this.'
          : 'No hit in the indexed knowledge. The scan covers code structure and docs it recorded; confirm with a targeted read before concluding.'
      return {
        ok: true,
        knowledgeDir: dir,
        terms: res.terms,
        hitCount: res.hits.length,
        hits: res.hits.map((h) => ({ source: `${h.source}:${h.line}`, score: h.score, kind: h.kind, text: h.text })),
        coverage: res.coverage,
        partial: res.partial,
        generatedAt: res.generatedAt,
        ...(res.rootMismatch ? { rootMismatch: true, warning: 'knowledge base was scanned from a different workspace — re-run pipeline_scan' } : {}),
        hint,
      }
    },
  }
}

export function makeKnowledgeTools(ctx, cfg, r) {
  return [makeScanTool(ctx, cfg, r), makeLedgerTool(ctx, cfg, r), makeRecallTool(ctx, cfg, r)]
}

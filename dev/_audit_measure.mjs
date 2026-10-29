// AUDIT ONLY — measure fixed per-request and per-call token footprints. No writes to plugin/.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const plugin = join(root, 'plugin')
const cfgMod = await import(new URL('../plugin/lib/config.js', import.meta.url).href)
const prompts = await import(new URL('../plugin/lib/prompts.js', import.meta.url).href)
const l1 = await import(new URL('../plugin/lib/tools/l1.js', import.meta.url).href)
const l2l3 = await import(new URL('../plugin/lib/tools/l2l3.js', import.meta.url).href)
const kn = await import(new URL('../plugin/lib/tools/knowledge.js', import.meta.url).href)

const cfg = cfgMod.DEFAULT_CONFIG
const store = {
  stateDir: join(root, '.dsh', 'pipeline'), workspaceRoot: root, runId: 'r', requirement: null, locked: false,
  tasks: new Map(), subtasks: new Map(), agents: new Map(), messages: [],
  counters: { llmCalls: 0, tokensIn: 0, tokensOut: 0, l2Spawns: 0, l2Sends: 0, l3Calls: 0, l3TokensIn: 0, l3TokensOut: 0 },
  l3Concurrent: 0, context: { level1Tokens: 0 }, run: { id: 'r', status: 'idle' },
}
const r = { store, stateDir: store.stateDir, record: () => ({}), run: store.run }
const ctx = { get: () => undefined }
const tools = [
  l1.makeLockTool(ctx, cfg, r), l1.makePlanTool(ctx, cfg, r), l2l3.makeDecomposeTool(ctx, cfg, r),
  l2l3.makeExecuteLocalTool(ctx, cfg, r), l2l3.makeExecuteBatchTool(ctx, cfg, r), l2l3.makeReviewTool(ctx, cfg, r),
  l1.makeStatusTool(ctx, cfg, r), l1.makeSpawnModuleLeadTool(ctx, cfg, r), l1.makeSendToLeadTool(ctx, cfg, r),
  l1.makeDrainLeadsTool(ctx, cfg, r), l1.makeCheckpointTool(ctx, cfg, r), l1.makeClassifyTool(ctx, cfg, r),
  l2l3.makeSpawnLocalExecutorTool(ctx, cfg, r), l2l3.makeRegisterOutputTool(ctx, cfg, r), l1.makeSelftestTool(ctx, cfg, r),
  l1.makeAcceptMilestoneTool(ctx, cfg, r), ...kn.makeKnowledgeTools(ctx, cfg, r),
]
const est = (s) => Math.ceil(String(s).length / 4)
const rows = tools.map((t) => {
  const def = { name: t.name, description: t.description, input: t.input ?? t.parameters ?? t.schema }
  const json = JSON.stringify(def)
  return { name: t.name, chars: json.length, tok: est(json) }
})
const totalChars = rows.reduce((s, x) => s + x.chars, 0)
console.log('TOOL DEFINITIONS:', rows.length)
for (const x of rows.sort((a, b) => b.chars - a.chars)) console.log(`  ${x.name.padEnd(34)} ${String(x.chars).padStart(5)} chars  ~${x.tok} tok`)
console.log(`TOTAL tool defs: ${totalChars} chars ~${est('x'.repeat(totalChars))} tok (json-only estimate)`)

const proto = prompts.buildProtocolText(cfg)
console.log(`\nPROTOCOL SECTION: ${proto.length} chars ~${est(proto)} tok`)
const skill = readFileSync(join(plugin, 'skills/pipeline-orchestration/SKILL.md'), 'utf8')
console.log(`SKILL.md (loaded on demand): ${skill.length} chars ~${est(skill)} tok`)
const l2p = prompts.buildL2LeadPrompt('do the thing', 'it works', cfg, null, null)
console.log(`L2 lead prompt (per spawn): ${l2p.length} chars ~${est(l2p)} tok`)

// Real-run evidence
try {
  const board = JSON.parse(readFileSync(join(root, 'dev/_backup/20261029/_dsh_pipeline_backup/pipeline/board.json'), 'utf8'))
  console.log(`\nREAL RUN board.json: agents=${board.agents?.length} tasks=${board.tasks?.length} subtasks=${board.subtasks?.length}`)
  const code = (board.agents ?? []).reduce((s, a) => s + String(a.code ?? '').length, 0)
  console.log(`  agent.code total chars: ${code} (~${Math.ceil(code / 4)} tok)`)
  console.log(`  compact JSON size: ${JSON.stringify(board).length} chars (~${Math.ceil(JSON.stringify(board).length / 4)} tok)`)
  console.log(`  pretty board.json on disk: ${readFileSync(join(root, 'dev/_backup/20261029/_dsh_pipeline_backup/pipeline/board.json')).length} B`)
} catch (e) { console.log('board.json evidence unavailable:', e.message) }
try {
  const tdir = join(root, 'dev/_backup/20261029/_dsh_pipeline_backup/pipeline')
  const files = readdirSync(tdir).filter((f) => f.startsWith('trace-'))
  for (const f of files) {
    const lines = readFileSync(join(tdir, f), 'utf8').trim().split('\n')
    const sizes = lines.map((l) => l.length).sort((a, b) => b - a)
    console.log(`\n${f}: ${lines.length} events, largest ${sizes[0]} chars, top5 ${sizes.slice(0, 5).join(',')}`)
    const types = {}
    for (const l of lines) { try { const e = JSON.parse(l); types[e.type ?? e.event ?? '?'] = (types[e.type ?? e.event ?? '?'] ?? 0) + 1 } catch {} }
    console.log('  event types:', JSON.stringify(types))
    const big = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0]
    console.log('  largest event keys:', Object.keys(big || {}).join(','), '| preview:', JSON.stringify(big).slice(0, 300))
  }
} catch (e) { console.log('trace evidence unavailable:', e.message) }

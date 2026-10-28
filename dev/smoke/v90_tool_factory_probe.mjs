// v90 tool-factory probe: instantiate EVERY tool factory from the split modules and
// fail fast on ReferenceError / TypeError from missing imports or stale wiring.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = new URL('../../', import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'v90-tools-'))
let failed = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`PASS  ${label}`)
  else { failed++; console.log(`FAIL  ${label}${extra ? `  :: ${extra}` : ''}`) }
}

const flat = ['util.js', 'store.js', 'gates.js', 'prompts.js', 'dsh-compat.js', 'guards.js', 'board-route.js']
for (const f of flat) copyFileSync(new URL('plugin/lib/' + f, root), join(tmp, f))
mkdirSync(join(tmp, 'tools'), { recursive: true })
mkdirSync(join(tmp, 'knowledge'), { recursive: true })
for (const f of ['knowledge/scan.js', 'knowledge/ledger.js', 'knowledge/recall.js']) {
  copyFileSync(new URL('plugin/lib/' + f, root), join(tmp, f))
}
for (const f of ['l1.js', 'l2l3.js', 'knowledge.js']) copyFileSync(new URL('plugin/lib/tools/' + f, root), join(tmp, 'tools', f))

const cfgSrc = readFileSync(new URL('plugin/lib/config.js', root), 'utf8')
  .replace(
    "export const CONFIG_FILE = join(homedir(), '.dsh', 'pipeline', 'config.json')",
    `export const CONFIG_FILE = ${JSON.stringify(join(tmp, 'config.json').replace(/\\/g, '/'))}`,
  )
writeFileSync(join(tmp, 'config.js'), cfgSrc, 'utf8')
const stSrc = readFileSync(new URL('plugin/lib/store.js', root), 'utf8')
  .replace(
    "return join(process.cwd(), '.dsh', 'pipeline')",
    `return ${JSON.stringify(join(tmp, 'state').replace(/\\/g, '/'))}`,
  )
writeFileSync(join(tmp, 'store.js'), stSrc, 'utf8')
copyFileSync(new URL('plugin/lib/plugin.js', root), join(tmp, 'plugin.js'))

const imp = (rel) => import(pathToFileURL(join(tmp, rel)).href)
const cfgMod = await imp('config.js')
const storeMod = await imp('store.js')
const l1 = await imp('tools/l1.js')
const l2 = await imp('tools/l2l3.js')
const pluginMod = await imp('plugin.js')

const cfg = { ...cfgMod.DEFAULT_CONFIG, stateDir: join(tmp, 'state') }
const r = storeMod.createStore(cfg)
const ctx = {
  agent: { id: 'lead', sessionId: 's1' },
  llm: { stream: async () => ({ content: '["a","b"]' }) },
  subagents: { startActivation: async () => ({ childId: 'c1' }), drainChildren: async () => {} },
}

const expected = {
  makeLockTool: { module: l1, name: 'pipeline_lock_requirements' },
  makePlanTool: { module: l1, name: 'pipeline_plan' },
  makeStatusTool: { module: l1, name: 'pipeline_status' },
  makeSpawnModuleLeadTool: { module: l1, name: 'pipeline_spawn_module_lead' },
  makeSendToLeadTool: { module: l1, name: 'pipeline_send_to_lead' },
  makeDrainLeadsTool: { module: l1, name: 'pipeline_drain_leads' },
  makeCheckpointTool: { module: l1, name: 'pipeline_checkpoint' },
  makeClassifyTool: { module: l1, name: 'pipeline_classify' },
  makeSelftestTool: { module: l1, name: 'pipeline_selftest' },
  makeAcceptMilestoneTool: { module: l1, name: 'pipeline_accept_milestone' },
  makeDecomposeTool: { module: l2, name: 'pipeline_decompose' },
  makeExecuteLocalTool: { module: l2, name: 'pipeline_execute_local' },
  makeExecuteBatchTool: { module: l2, name: 'pipeline_execute_batch' },
  makeReviewTool: { module: l2, name: 'pipeline_review' },
  makeSpawnLocalExecutorTool: { module: l2, name: 'pipeline_spawn_local_executor' },
  makeRegisterOutputTool: { module: l2, name: 'pipeline_register_output' },
}

for (const [fnName, spec] of Object.entries(expected)) {
  try {
    const factory = spec.module[fnName]
    check(`${fnName} exported`, typeof factory === 'function')
    if (typeof factory !== 'function') continue
    const tool = factory(ctx, cfg, r)
    check(`${fnName} -> ${spec.name}`, tool && tool.name === spec.name, tool && tool.name)
    check(`${fnName} has description`, typeof tool.description === 'string' && tool.description.length > 20)
    check(`${fnName} has parameters`, !!tool.parameters || !!tool.inputSchema || !!tool.input)
  } catch (e) {
    failed++
    console.log(`FAIL  ${fnName} threw: ${e && e.message}`)
  }
}

check('plugin applies cleanly', (() => {
  try {
    const registered = []
    const commands = []
    const systemPrompt = { section: () => {}, }
    const ctx2 = {
      tools: { register: (t) => registered.push(t), guard: () => () => {} },
      systemPrompt: { section: () => {} },
      skills: { register: () => {} },
      commands: { register: (c) => commands.push(c) },
      llm: ctx.llm,
      subagents: ctx.subagents,
      agent: ctx.agent,
      logger: { info: () => {}, warn: () => {} },
    }
    pluginMod.apply(ctx2, { ...cfgMod.DEFAULT_CONFIG })
    check('19 tools registered', registered.length === 19, String(registered.length))
    check('7 commands registered', commands.length === 7, String(commands.length))
    return true
  } catch (e) {
    failed++
    console.log(`FAIL  apply threw: ${e && e.message}`)
    return false
  }
})())

rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\nv90 tool-factory probe: ALL PASS' : `\nv90 tool-factory probe: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

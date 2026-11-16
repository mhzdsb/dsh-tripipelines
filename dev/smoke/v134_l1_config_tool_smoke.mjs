// v134 (1.37.0) — the L1-side config-change smoke: proves pipeline_config_set
// and the layer-aware persistence unification from the m02259 request hold:
//   1. the tool is registered, L1-only by guard, and survives global mode=off
//      (repair path); it is NOT an EXECUTION tool so budget/off never blocks it.
//   2. changes run through the SAME engine as /pipe-config (handleConfigCommand):
//      view/list/unknown-key error passthrough.
//   3. project-layer redirect: a workspace with <devDir>/pipeline-project.json
//      gets changed keys written THERE (not silently re-shadowed next load).
//   4. pipeline_model_setup apply now persists layer-aware too (the C-gap fix:
//      its patch used to go global-only).
//   5. session-less fallback (null registry/source) behaves like pre-v132 global view.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
// dev/smoke/ mirror resolves one level deeper (repo root is ../../.. there).
const pkgRoot = existsSync(join(repoRoot, 'client.js'))
  ? repoRoot
  : join(repoRoot, 'plugins', 'dsh-tripipelines')
let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v134-'))
const libDir = join(tmp, 'lib')
const rootA = join(tmp, 'projA')
const rootB = join(tmp, 'projB')
const globalConfigPath = join(tmp, 'global-config.json')
mkdirSync(join(rootA, '.git'), { recursive: true })
mkdirSync(join(rootB, '.git'), { recursive: true })

function mkSession(id, cwd) {
  return {
    id,
    header: { cwd },
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    surface: {},
    snapshotEvents: () => [],
  }
}
const sessions = new Map([
  ['sA', mkSession('sA', rootA)],
  ['sB', mkSession('sB', rootB)],
])

const subagents = {
  async startActivation(request) {
    return { childId: `child-${request.label}`, messageId: 'msg', dispose() {} }
  },
  async drainChildren() {},
  async sendMessage() { return 'msg' },
}
const llm = {
  listProviders: () => [{ id: 'deepseek-official', name: 'deepseek-official' }],
  listModels: async () => [{ id: 'deepseek-flash', name: 'deepseek-flash' }],
  async *stream() { yield { type: 'text-delta', text: '[]' } },
}
const webServer = { register() { return () => {} } }

function makeCtx() {
  const tools = new Map()
  const commands = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] }
      if (name === 'agents') return { roots: () => [], get: () => undefined }
      if (name === 'tokenMeter') return { estimateMessage: () => 100, measure: () => ({ surfaceTokens: 300 }) }
      if (name === 'subagents') return subagents
      if (name === 'llm') return llm
      if (name === 'webServer') return webServer
      return undefined
    },
    tools: { register(def) { tools.set(def.name, def); return () => {} }, guard() { return () => {} } },
    systemPrompt: { section() {} },
    skills: { register() {} },
    commands: { register(def) { commands.set(def.name, def); return () => {} } },
  }
  return { ctx, tools, commands }
}

try {
  cpSync(join(pkgRoot, 'lib'), libDir, { recursive: true })
  const cfgPath = join(libDir, 'config.js')
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf8').replace(/export const CONFIG_FILE = .*$/m, `export const CONFIG_FILE = ${JSON.stringify(globalConfigPath)}`),
    'utf8',
  )
  const wsPath = join(libDir, 'workspaces.js')
  writeFileSync(
    wsPath,
    readFileSync(wsPath, 'utf8').replace(/export const DEFAULT_KNOWN_FILE = .*$/m, `export const DEFAULT_KNOWN_FILE = ${JSON.stringify(join(tmp, 'known-workspaces.json'))}`),
    'utf8',
  )

  const guards = await import(pathToFileURL(join(libDir, 'guards.js')).href)
  const conf = await import(pathToFileURL(join(libDir, 'config.js')).href)
  const applyMod = await import(pathToFileURL(join(libDir, 'config-apply.js')).href)

  section('1 — registration + guard placement')
  {
    check('tool in L1_ONLY_TOOLS', guards.L1_ONLY_TOOLS.has('pipeline_config_set'))
    check('NOT in EXECUTION_TOOLS (paused/off stays repairable)', !guards.EXECUTION_TOOLS.has('pipeline_config_set'))
    check('NOT in L2L3_TOOLS / ADVANCE', !guards.L2L3_TOOLS.has('pipeline_config_set') && !guards.ADVANCE_TOOLS.has('pipeline_config_set'))
    check('RUN_FOOTER_TOOLS carries it', guards.RUN_FOOTER_TOOLS.has('pipeline_config_set'))
    const denial = guards.strictAdjacencyDenial('l2', null, { name: 'pipeline_config_set' })
    check('adjacency denies L2 caller', typeof denial === 'string' && denial.includes('一级协调者（L1）专用'), String(denial))
    check('adjacency allows L1', guards.strictAdjacencyDenial('l1', null, { name: 'pipeline_config_set' }) === undefined)
    const pluginMod = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
    check('survives global mode=off (repair path)', pluginMod.shouldRegisterTool('pipeline_config_set', { mode: 'off' }) === true)
  }

  section('2 — same engine as /pipe-config (via live tool)')
  const h = makeCtx()
  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href + '?a=' + Date.now())
  apply(h.ctx, { mode: 'auto', level2Provider: 'deepseek-official', level2Model: 'deepseek-flash', level3Mode: 'off', semanticGateThreshold: 0.5 })
  const callIn = (sid, name, args = {}) => h.tools.get(name).execute(args, { agent: { id: sid }, signal: undefined })
  {
    check('tool registered', Boolean(h.tools.get('pipeline_config_set')))
    check('description names /pipe-config syntax', String(h.tools.get('pipeline_config_set').description).includes('/pipe-config'))
    const view = await callIn('sB', 'pipeline_config_set', { input: '' })
    check('empty input renders current config', view.kind === 'success' && view.text.includes('level2Model'), view.text.slice(0, 80))
    const one = await callIn('sB', 'pipeline_config_set', { input: 'maxCodeLines' })
    check('bare key views one value', one.kind === 'success' && /^maxCodeLines = /.test(one.text), one.text)
    const bad = await callIn('sB', 'pipeline_config_set', { input: 'bogusKey 1' })
    check('unknown key → error passthrough', bad.kind === 'error' && bad.text.includes('未知配置项'), bad.text)
    const set1 = await callIn('sB', 'pipeline_config_set', { input: 'maxCodeLines 64' })
    check('change reports prev → next', set1.kind === 'success' && set1.text.includes('→ 64') && set1.changed.includes('maxCodeLines'), set1.text)
    const off = await callIn('sB', 'pipeline_config_set', { input: 'level3Mode auto' })
    check('mode alias resolves to level3Mode', off.kind === 'success' && off.changed.includes('level3Mode'), JSON.stringify(off.changed))
    await callIn('sB', 'pipeline_config_set', { input: 'level3Mode off' })
  }

  section('3 — project-layer redirect (workspace A has a project file)')
  {
    const devAbs = join(rootA, 'dev')
    mkdirSync(devAbs, { recursive: true })
    const projFile = join(devAbs, 'pipeline-project.json')
    writeFileSync(projFile, JSON.stringify({ maxCodeLines: 42 }, null, 2), 'utf8')
    // First touch creates A's store with the merged view (project layer wins).
    const st = await callIn('sA', 'pipeline_status')
    void st
    const res = await callIn('sA', 'pipeline_config_set', { input: 'maxCodeLines 77' })
    check('change succeeds with redirect note', res.kind === 'success' && res.text.includes('改动已写入项目层'), res.text.replace(/\n/g, ' | ').slice(0, 200))
    const proj = JSON.parse(readFileSync(projFile, 'utf8'))
    check('project file carries the new value', proj.maxCodeLines === 77, JSON.stringify(proj))
    const globalCfg = existsSync(globalConfigPath) ? JSON.parse(readFileSync(globalConfigPath, 'utf8')) : {}
    check('global also kept consistent (project still wins on merge)', globalCfg.maxCodeLines === 77, JSON.stringify(globalCfg))
    // B must not inherit A's project layer.
    const bView = await callIn('sB', 'pipeline_config_set', { input: 'maxCodeLines' })
    check('B unaffected by A redirect', bView.kind === 'success' && !bView.text.includes('改动已写入项目层'), bView.text)
  }

  section('4 — pipeline_model_setup persists layer-aware (C-gap fix)')
  {
    const projFile = join(rootA, 'dev', 'pipeline-project.json')
    // A fresh workspace root: the store must be created WITH the project layer
    // already present (registry caches merged views; editing the file after the
    // store exists would not change what model_setup mutates).
    const rootC = join(tmp, 'projC')
    mkdirSync(join(rootC, '.git'), { recursive: true })
    mkdirSync(join(rootC, 'dev'), { recursive: true })
    writeFileSync(projFile, JSON.stringify({ maxCodeLines: 42 }, null, 2), 'utf8')
    writeFileSync(join(rootC, 'dev', 'pipeline-project.json'), JSON.stringify({ maxCodeLines: 9 }, null, 2), 'utf8')
    sessions.set('sC', mkSession('sC', rootC))
    const h2 = makeCtx()
    const mod2 = await import(pathToFileURL(join(libDir, 'plugin.js')).href + '?b=' + Date.now())
    // level2Model starts DIFFERENT from the project's target — set() skips
    // no-op changes and returns an empty patch (probe-verified).
    mod2.apply(h2.ctx, { mode: 'auto', level2Provider: 'deepseek-official', level2Model: 'other-model', level3Mode: 'off', semanticGateThreshold: 0.5 })
    const setup = await h2.tools.get('pipeline_model_setup').execute({ apply: 'custom', level2Model: 'deepseek-flash' }, { agent: { id: 'sC' }, signal: undefined })
    void setup
    const projC = join(rootC, 'dev', 'pipeline-project.json')
    const after = JSON.parse(readFileSync(projC, 'utf8'))
    check('model_setup patch mirrored into project layer', after.level2Model === 'deepseek-flash' && after.maxCodeLines === 9, JSON.stringify(after))
    const globalCfg2 = existsSync(globalConfigPath) ? JSON.parse(readFileSync(globalConfigPath, 'utf8')) : {}
    check('global kept consistent too', globalCfg2.level2Model === 'deepseek-flash', JSON.stringify(globalCfg2).slice(0, 160))
  }

  section('5 — session-less fallback + command parity')
  {
    // Direct applyConfigChange with no registry/source: global view only, no throw.
    const cfgClone = { ...conf.DEFAULT_CONFIG }
    const { result } = await applyMod.applyConfigChange({ get: () => undefined }, cfgClone, null, 'maxCodeLines 88', null)
    check('null registry falls back to global flow', result.kind === 'success' && result.text.includes('→ 88'), result.text)
    // The slash command goes through the same module now: compare outputs shape.
    const cmd = h.commands.get('pipe-config')
    const viaCmd = await cmd.handler({ rawInput: 'maxCodeLines', agent: { id: 'sB' } })
    check('pipe-config handler still works (thin wrapper)', viaCmd.kind === 'success' && /^maxCodeLines = /.test(viaCmd.text), viaCmd.text)
  }

  section('6 — pairing corrections land in the redirected layer')
  {
    const projFile = join(rootA, 'dev', 'pipeline-project.json')
    let proj = JSON.parse(readFileSync(projFile, 'utf8'))
    proj.level2Model = 'deepseek-flash'
    writeFileSync(projFile, JSON.stringify(proj, null, 2), 'utf8')
    rmSync(join(rootA, '.dsh'), { recursive: true, force: true })
    const h3 = makeCtx()
    const mod3 = await import(pathToFileURL(join(libDir, 'plugin.js')).href + '?c=' + Date.now())
    mod3.apply(h3.ctx, { mode: 'auto', level2Provider: 'deepseek-official', level2Model: 'deepseek-flash', level3Mode: 'off', semanticGateThreshold: 0.5 })
    // Touch A first so its store+merged cfg exist.
    await h3.tools.get('pipeline_status').execute({}, { agent: { id: 'sA' }, signal: undefined })
    const r3 = await h3.tools.get('pipeline_config_set').execute({ input: 'level2Model deepseek-flash' }, { agent: { id: 'sA' }, signal: undefined })
    const after = JSON.parse(readFileSync(projFile, 'utf8'))
    check('no-op change keeps project layer intact', r3.kind === 'success' && after.level2Model === 'deepseek-flash', JSON.stringify(after).slice(0, 200))
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v134_l1_config_tool_smoke — ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

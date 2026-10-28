// v92 board smoke: the host-side /pipeline/board snapshot + route registration,
// the per-lead work directory (real cwd isolation), and the client bundle's
// wiring. Copies the lib modules to a temp dir and patches the two absolute-path
// constants, exactly like the v90 probe.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = new URL('../../', import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'v92-board-'))
let failed = 0
const check = (label, cond, extra) => {
  if (cond) console.log(`PASS  ${label}`)
  else {
    failed++
    console.log(`FAIL  ${label}${extra ? `  :: ${extra}` : ''}`)
  }
}

const flat = ['util.js', 'store.js', 'gates.js', 'prompts.js', 'dsh-compat.js', 'guards.js', 'board-route.js']
for (const f of flat) copyFileSync(new URL('plugin/lib/' + f, root), join(tmp, f))
mkdirSync(join(tmp, 'tools'), { recursive: true })
for (const f of ['l1.js', 'l2l3.js']) copyFileSync(new URL('plugin/lib/tools/' + f, root), join(tmp, 'tools', f))

const cfgSrc = readFileSync(new URL('plugin/lib/config.js', root), 'utf8').replace(
  "export const CONFIG_FILE = join(homedir(), '.dsh', 'pipeline', 'config.json')",
  `export const CONFIG_FILE = ${JSON.stringify(join(tmp, 'config.json').replace(/\\/g, '/'))}`,
)
writeFileSync(join(tmp, 'config.js'), cfgSrc, 'utf8')
const stSrc = readFileSync(new URL('plugin/lib/store.js', root), 'utf8').replace(
  "return join(root ?? process.cwd(), '.dsh', 'pipeline')",
  `return ${JSON.stringify(join(tmp, 'state').replace(/\\/g, '/'))}`,
)
writeFileSync(join(tmp, 'store.js'), stSrc, 'utf8')
copyFileSync(new URL('plugin/lib/plugin.js', root), join(tmp, 'plugin.js'))

const imp = (rel) => import(pathToFileURL(join(tmp, rel)).href)
const cfgMod = await imp('config.js')
const storeMod = await imp('store.js')
const board = await imp('board-route.js')
const l1 = await imp('tools/l1.js')

const cfg = { ...cfgMod.DEFAULT_CONFIG, stateDir: join(tmp, 'state') }

// ---------------------------------------------------------------------------
// 1. snapshot shape
// ---------------------------------------------------------------------------
const r = storeMod.createStore(cfg)
r.store.runId = 'run-test'
r.store.requirement = 'build a calculator'
r.store.locked = true
r.store.run = {
  id: 'run-test',
  status: 'active',
  startedAt: new Date().toISOString(),
  milestones: [{ id: 'm1', name: 'MVP', taskIds: ['t1'], state: 'pending' }],
  tokensUsed: 1234,
  filesTouched: ['a.js'],
  scope: [],
  activation: 'enable',
  paused: false,
  pauseReason: null,
}
r.store.tasks.set('t1', { id: 't1', desc: 'calc core', assignee: 'backend', state: 'done', subtaskIds: [] })
r.store.agents.set('c1', { id: 'c1', kind: 'l2', label: 'backend', state: 'in_progress', scopeDir: 'src/calc', estimatedTokens: 10 })
r.store.messages.push({ sender: 'level1_main', message_type: 'agent_spawn', task_desc: 'calc core' })

const snap = board.buildBoardSnapshot(r, cfg)
check('snapshot ok flag', snap.ok === true)
check('snapshot run id', snap.run.id === 'run-test')
check('snapshot requirement', snap.run.requirement === 'build a calculator')
check('milestone state computed from task (done)', snap.milestones[0].state === 'done' && snap.milestones[0].done === 1)
check('tasks present with state', snap.tasks.length === 1 && snap.tasks[0].state === 'done')
check('l2 agent with scopeDir', snap.agents.length === 1 && snap.agents[0].scopeDir === 'src/calc')
check('budget maxTokens from cfg', snap.budget.maxTokens === Number(cfg.maxTotalTokensPerRun))
check('budget tokensUsed', snap.budget.tokensUsed === 1234)
check('recent event type', snap.recentEvents.length === 1 && snap.recentEvents[0].type === 'agent_spawn')

// ---------------------------------------------------------------------------
// 2. route registration + handler
// ---------------------------------------------------------------------------
let registered = null
const fakeCtx = {
  get: (k) => (k === 'webServer' ? { register: (opt) => { registered = opt; return () => {} } } : undefined),
}
const dispose = board.installBoardRoute(fakeCtx, r, cfg)
check('route registered exact /pipeline/board', !!registered && registered.path === '/pipeline/board' && registered.kind === 'exact')
check('install returns disposer', typeof dispose === 'function')
let status = 0
let body = ''
registered.handler({}, { writeHead: (s) => { status = s }, end: (b) => { body = b } })
const parsed = JSON.parse(body)
check('handler 200 + json body', status === 200 && parsed.ok === true && parsed.run.id === 'run-test')
check('soft capability without webServer', typeof board.installBoardRoute({ get: () => undefined }, r, cfg) === 'function')
check('soft capability with broken webServer', typeof board.installBoardRoute({ get: () => ({ register: () => { throw new Error('x') } }) }, r, cfg) === 'function')

// Late registration: on a profile cold start the plugin applies BEFORE the web
// server exists. The route must appear via cordis inject instead of dying as a no-op.
let lateRegistered = null
let injectDeps = null
const lateCtx = {
  get: () => undefined,
  inject: (deps, cb) => {
    injectDeps = deps
    cb({ get: (k) => (k === 'webServer' ? { register: (opt) => { lateRegistered = opt; return () => {} } } : undefined) })
    return { dispose() {} }
  },
}
const lateDispose = board.installBoardRoute(lateCtx, r, cfg)
check('late path injects webServer dependency', Array.isArray(injectDeps) && injectDeps.includes('webServer'))
check('late route registered via inject', !!lateRegistered && lateRegistered.path === '/pipeline/board' && lateRegistered.kind === 'exact')
check('late disposer is callable', typeof lateDispose === 'function')

// 'ready' fallback when inject is unavailable (service appears only after apply)
let readyRegistered = null
let getCalls = 0
const readyCtx = {
  get: (k) => {
    if (k !== 'webServer') return undefined
    getCalls++
    return getCalls > 1 ? { register: (opt) => { readyRegistered = opt; return () => {} } } : undefined
  },
  on: (event, cb) => {
    if (event === 'ready') cb()
    return () => {}
  },
}
board.installBoardRoute(readyCtx, r, cfg)
check('ready fallback registers route', !!readyRegistered && readyRegistered.path === '/pipeline/board')

// ---------------------------------------------------------------------------
// 3. per-lead work directory: cwd + prompt + record
// ---------------------------------------------------------------------------
const r2 = storeMod.createStore(cfg)
const captured = []
const subs = {
  startActivation: async (spec) => {
    captured.push(spec)
    return { childId: `child-${captured.length}`, messageId: 'msg' }
  },
  drainChildren: async () => {},
}
const ctx2 = { get: (k) => (k === 'subagents' ? subs : undefined) }
const spawn = l1.makeSpawnModuleLeadTool(ctx2, cfg, r2)
const exec = { agent: { id: 'lead' }, signal: undefined }

const out = await spawn.execute(
  { name: 'backend', description: 'core', prompt: 'do core', acceptance: 'calc works', scopeDir: 'src/calc' },
  exec,
)
check('spawn echoes scopeDir', out.scopeDir === 'src/calc')
check('request.cwd is absolute scope dir', captured[0].request.cwd === resolve('src/calc'))
check(
  'prompt carries WORK DIRECTORY block',
  String(captured[0].request.prompt[0].text).includes('WORK DIRECTORY (v92)') && String(captured[0].request.prompt[0].text).includes('src/calc'),
)
check('scope dir created on disk', existsSync(resolve('src/calc')))
check('agent record keeps scopeDir', r2.store.agents.get(out.childId)?.scopeDir === 'src/calc')

// v94 — per-lead model: one module can run on a stronger model while the rest
// stay on the configured level2 default.
const out3 = await spawn.execute(
  { name: 'ml', description: 'm', prompt: 'p', acceptance: 'a', provider: 'deepseek-official', model: 'deepseek-pro' },
  exec,
)
check('spawn passes per-lead model to subagents', captured[captured.length - 1].request.agentOptions?.model === 'deepseek-pro')
check('agent record keeps per-lead model', r2.store.agents.get(out3.childId)?.model === 'deepseek-pro')
check('agent without override keeps level2 model', r2.store.agents.get(out.childId)?.model === cfg.level2Model)
check('snapshot exposes per-lead model', board.buildBoardSnapshot(r2, cfg).agents?.some((a) => a.model === 'deepseek-pro') === true)

const out2 = await spawn.execute({ name: 'd b!', description: 'x', prompt: 'y', acceptance: 'z' }, exec)
check('default scopeDir sanitized under .dsh/pipeline/work', out2.scopeDir === join('.dsh', 'pipeline', 'work', 'd_b_'))
check('default scope dir created', existsSync(resolve(join('.dsh', 'pipeline', 'work', 'd_b_'))))

// ---------------------------------------------------------------------------
// 4. client bundle wiring (static)
// ---------------------------------------------------------------------------
const clientSrc = readFileSync(new URL('plugin/client.js', root), 'utf8')
check('client loader declares package id', clientSrc.includes("id: 'dsh-pipeline'"))
check('client registers sidebar.footer.action', clientSrc.includes("'sidebar.footer.action'"))
check('client keeps a single board id (no probes)', !clientSrc.includes('pipeline-probe') && (clientSrc.match(/'pipeline-board'/g) || []).length === 1)
check('client has exactly one seat (no composer strip, no floating card)', !clientSrc.includes('conversation.composer.dock') && !clientSrc.includes('shell.overlay') && !clientSrc.includes('pipeline-panel'))
check('client polls /pipeline/board', clientSrc.includes("fetch('/pipeline/board'"))
check('client keeps an idle posture', clientSrc.includes("=== 'idle'"))
check('client uses theme tokens', clientSrc.includes('--dsw-alias-'))
const pkg = JSON.parse(readFileSync(new URL('plugin/package.json', root), 'utf8'))
check('package.json exports ./client', pkg.exports?.['./client'] === './client.js')
check('package.json ships client.js', Array.isArray(pkg.files) && pkg.files.includes('client.js'))
check('package.json declares dsh.client', pkg.dsh?.client?.platform === 'web' && pkg.dsh?.client?.immediately === true)
const pluginMainSrc = readFileSync(new URL('plugin/lib/plugin.js', root), 'utf8')
check('plugin opts out of bootstrap restore', pluginMainSrc.includes('createStore(cfg, { restore: false })'))
check('route handler has a build tag', readFileSync(new URL('plugin/lib/board-route.js', root), 'utf8').includes('BUILD_TAG'))
// v96 — module-count nudges: soft hints on plan + spawn, and a sizing guide in the skill.
const l1Src = readFileSync(new URL('plugin/lib/tools/l1.js', root), 'utf8')
const skillSrc = readFileSync(new URL('plugin/skills/pipeline-orchestration/SKILL.md', root), 'utf8')
check('plan returns a module-count hint', l1Src.includes('planHint'))
check('plan hint targets collapsed plans', l1Src.includes('tasks.length >= 3') && l1Src.includes('assignees.length === 1'))
check('spawn returns an unspawned-module hint', l1Src.includes('spawnHint'))
check('skill has a module count guide', skillSrc.includes('MODULE COUNT GUIDE'))
check('skill requires >=3 leads for >=3 concerns', skillSrc.includes('≥3 independent concerns MUST get ≥3 L2s'))
check('skill keeps the single-file fast path', skillSrc.includes('single-file') || skillSrc.includes('single file / script / small fix'))

// v101c — context readout must use surfaceTokens (what the model sees), never the
// cumulative session-log total; otherwise the strip shows absurd ratios like 3290%.
const brSrc = readFileSync(new URL('plugin/lib/board-route.js', root), 'utf8')
const compatSrc = readFileSync(new URL('plugin/lib/dsh-compat.js', root), 'utf8')
check('agent token read prefers surfaceTokens', brSrc.includes('measurement?.surfaceTokens ?? measurement?.totalTokens'))
check('level1 read uses the tail-window estimate', compatSrc.includes('tailSurfaceTokens') && !compatSrc.includes('m.surfaceTokens ?? m.totalTokens'))
const { measureAgentTokens } = await imp('board-route.js')
const probeCtx = {
  get(name) {
    if (name === 'agents') return { get: () => ({ session: { id: 'probe-l2' } }) }
    if (name === 'tokenMeter') return { measure: () => ({ surfaceTokens: 4321, totalTokens: 999999 }) }
    return undefined
  },
}
const probeRead = measureAgentTokens(probeCtx, 'probe-l2')
check('measureAgentTokens returns the surface reading', probeRead === 4321, String(probeRead))

rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\nv92 board smoke: ALL PASS' : `\nv92 board smoke: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)

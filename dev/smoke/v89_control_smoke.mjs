// v89 verification: control plane + run state machine.
// Loads a patched COPY of plugins/dsh-tripipelines/lib/plugin.js (temp state dir + internal exports)
// and asserts the v89 contracts:
//  1) new config keys exist in DEFAULT_CONFIG AND CONFIG_KEYS
//  2) run state machine: idle -> active, saveRun persists run.json
//  3) milestoneStates is computed from task states (done/pending/accepted)
//  4) budgetRefusal: token / file-count caps; zero = unlimited
//  5) addRunUsage accumulates + auto-pauses at a cap + never grows while paused
//  6) cold start: run.json + board.json are reloaded (file is the truth)
//  7) executeAcceptance: per-call scratch dir + cleanup (v89 P0 race fix)
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = new URL('../../', import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'v89-verify-'))
const tmpState = join(tmp, 'state').replace(/\\/g, '/')
const tmpPlugin = join(tmp, 'plugin.js')

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${extra ? `  :: ${extra}` : ''}`)
  }
}

// v90 split: the store/gates modules own the tested helpers now. Copy them next to
// patched copies (config gets a temp CONFIG_FILE, store a temp runtime state dir).
for (const f of ['util.js', 'store.js', 'gates.js', 'prompts.js', 'dsh-compat.js', 'guards.js', 'board-route.js']) {
  copyFileSync(new URL('plugins/dsh-tripipelines/lib/' + f, root), join(tmp, f))
}
mkdirSync(join(tmp, 'tools'), { recursive: true })
for (const f of ['l1.js', 'l2l3.js']) {
  copyFileSync(new URL('plugins/dsh-tripipelines/lib/tools/' + f, root), join(tmp, 'tools', f))
}
const configSrc = readFileSync(new URL('plugins/dsh-tripipelines/lib/config.js', root), 'utf8')
const patchedConfig = configSrc.replace(
  "export const CONFIG_FILE = join(homedir(), '.dsh', 'pipeline', 'config.json')",
  `export const CONFIG_FILE = ${JSON.stringify(join(tmp, 'config.json').replace(/\\/g, '/'))}`,
)
if (patchedConfig === configSrc) {
  console.log('FAIL  could not patch config source (anchor changed)')
  process.exit(1)
}
writeFileSync(join(tmp, 'config.js'), patchedConfig, 'utf8')
const storeSrc = readFileSync(new URL('plugins/dsh-tripipelines/lib/store.js', root), 'utf8')
const patchedStore = storeSrc.replace(
  "return join(base, '.dsh', 'pipeline')",
  `return ${JSON.stringify(tmpState)}`,
)
if (patchedStore === storeSrc) {
  console.log('FAIL  could not patch store source (state dir anchor changed)')
  process.exit(1)
}
writeFileSync(join(tmp, 'store.js'), patchedStore, 'utf8')
const storeMod = await import(pathToFileURL(join(tmp, 'store.js')).href)
const gatesMod = await import(pathToFileURL(join(tmp, 'gates.js')).href)
const cfgMod = await import(pathToFileURL(join(tmp, 'config.js')).href)
const { createStore, milestoneStates, budgetRefusal, addRunUsage, runFooter } = storeMod
const { executeAcceptance } = gatesMod
const { DEFAULT_CONFIG, CONFIG_KEYS } = cfgMod

const freshRun = (over = {}) => ({
  id: 'r1',
  status: 'active',
  startedAt: new Date().toISOString(),
  milestones: [],
  tokensUsed: 0,
  filesTouched: [],
  scope: [],
  activation: 'enabled',
  paused: false,
  pauseReason: null,
  ...over,
})

// --- 1) new config keys ----------------------------------------------------
for (const key of ['activationGate', 'maxTotalTokensPerRun', 'maxDurationPerRun', 'maxFilesPerRun', 'level3Engine']) {
  check(`DEFAULT_CONFIG has ${key}`, key in DEFAULT_CONFIG)
  check(`CONFIG_KEYS has ${key}`, key in CONFIG_KEYS)
}
check('activationGate default true', DEFAULT_CONFIG.activationGate === true)
check('maxTotalTokensPerRun default 500000', DEFAULT_CONFIG.maxTotalTokensPerRun === 500000)
check('maxDurationPerRun default 7200000', DEFAULT_CONFIG.maxDurationPerRun === 7200000)
check('maxFilesPerRun default 200', DEFAULT_CONFIG.maxFilesPerRun === 200)
check("level3Engine type enum", CONFIG_KEYS.level3Engine.type === 'enum' && CONFIG_KEYS.level3Engine.values.includes('auto'))

// --- 2) run state machine + persistence -----------------------------------
const cfg = { ...DEFAULT_CONFIG, maxTotalTokensPerRun: 100, maxFilesPerRun: 2, maxDurationPerRun: 0 }
const r = createStore(cfg, { root: join(tmp, 'proj') })
check('run starts idle', r.store.run.status === 'idle')
check('run milestones starts empty', Array.isArray(r.store.run.milestones) && r.store.run.milestones.length === 0)
r.store.run = freshRun({ id: 'r1', scope: ['src'] })
r.saveRun()
check('run.json written', existsSync(join(tmpState, 'run.json')))
const savedRun = JSON.parse(readFileSync(join(tmpState, 'run.json'), 'utf8'))
check('run.json keeps status/scope', savedRun.status === 'active' && savedRun.scope[0] === 'src')

// --- 3) milestoneStates computed from task states -------------------------
r.store.tasks.set('t1', { id: 't1', state: 'done' })
r.store.tasks.set('t2', { id: 't2', state: 'in_progress' })
r.store.run.milestones = [
  { id: 'm1', name: '模块A', taskIds: ['t1'], state: 'pending' },
  { id: 'm2', name: '模块B', taskIds: ['t2'], state: 'pending' },
]
let ms = milestoneStates(r.store)
check('milestone done when all tasks done', ms[0].state === 'done')
check('milestone pending when a task runs', ms[1].state === 'pending')
check('milestone progress counts', ms[0].done === 1 && ms[0].total === 1 && ms[1].done === 0)
r.store.run.milestones[0].state = 'accepted'
check('accepted milestone stays accepted', milestoneStates(r.store)[0].state === 'accepted')
check('unknown task ids are ignored', milestoneStates({ run: { milestones: [{ id: 'x', name: 'x', taskIds: ['nope'], state: 'pending' }] }, tasks: new Map() })[0].state === 'pending')

// --- 4) budgetRefusal ------------------------------------------------------
check('no refusal under cap', budgetRefusal(r, cfg) === '')
r.store.run.tokensUsed = 100
check('token cap refusal', /token 预算/.test(budgetRefusal(r, cfg)))
r.store.run.tokensUsed = 0
r.store.run.filesTouched = ['a.js', 'b.js']
check('file cap refusal', /文件数/.test(budgetRefusal(r, cfg)))
const unlimited = { ...DEFAULT_CONFIG, maxTotalTokensPerRun: 0, maxFilesPerRun: 0, maxDurationPerRun: 0 }
r.store.run.filesTouched = []
check('zero caps = unlimited', budgetRefusal(r, unlimited) === '')
r.store.run.paused = true
check('paused run always refuses', /暂停/.test(budgetRefusal(r, cfg)))
r.store.run.paused = false

// --- 5) addRunUsage accumulates + auto-pauses -----------------------------
// token cap uses maxFilesPerRun:0 so the file cap cannot fire first
const cfgTok = { ...DEFAULT_CONFIG, maxTotalTokensPerRun: 100, maxFilesPerRun: 0, maxDurationPerRun: 0 }
const r2 = createStore(cfgTok, { root: join(tmp, 'proj') })
r2.store.run = freshRun({ id: 'r2' })
addRunUsage(r2, cfgTok, 60, ['a.js', 'b.js'])
check('tokens accumulated', r2.store.run.tokensUsed === 60)
check('files accumulated', r2.store.run.filesTouched.length === 2)
addRunUsage(r2, cfgTok, 0, ['a.js'])
check('files deduped', r2.store.run.filesTouched.length === 2)
addRunUsage(r2, cfgTok, 50, ['c.js'])
check('auto-paused at token cap', r2.store.run.paused === true)
check('pause reason mentions token', /token 预算/.test(r2.store.run.pauseReason))
const before = r2.store.run.tokensUsed
addRunUsage(r2, cfgTok, 5, [])
check('in-flight tokens still counted after pause', r2.store.run.tokensUsed === before + 5)
check('paused run persisted', JSON.parse(readFileSync(join(tmpState, 'run.json'), 'utf8')).paused === true)

// --- 6) runFooter ---------------------------------------------------------
const footer = runFooter(r2)
check('footer mentions paused', footer.includes('⏸️'))
check('footer mentions milestone count', runFooter({ store: { run: freshRun({ milestones: [{ id: 'm1', name: 'A', taskIds: [], state: 'accepted' }] }), tasks: new Map() } }).includes('1/1'))

// --- 7) cold start reload (run.json + board.json) -------------------------
const board = {
  run_id: 'r2',
  requirement: 'x',
  locked: true,
  counters: {},
  tasks: [{ id: 't1', desc: 'd', assignee: 'backend', deadline: null, acceptance: 'a', depends_on: [], state: 'done', subtaskCount: 1, reason: null }],
  subtasks: [{ id: 's1', parent: 't1', desc: 'sd', acceptance: 'sa', state: 'done', status: 'done', codeLines: 2, failCount: 0, reason: null }],
  agents: [{ id: 'c1', kind: 'l2', label: 'backend', state: 'in_progress', estimatedTokens: 10 }],
}
writeFileSync(join(tmpState, 'board.json'), JSON.stringify(board, null, 2), 'utf8')
const r3 = createStore(cfg, { root: join(tmp, 'proj') })
check('cold start restores active+paused run', r3.store.run.status === 'active' && r3.store.run.paused === true)
check('cold start restores task', r3.store.tasks.has('t1') && r3.store.tasks.get('t1').state === 'done')
check('cold start rebuilds subtaskIds', r3.store.tasks.get('t1').subtaskIds.includes('s1'))
check('cold start restores subtask', r3.store.subtasks.has('s1') && r3.store.subtasks.get('s1').parent === 't1')
check('cold start restores agents', r3.store.agents.has('c1') && r3.store.agents.get('c1').kind === 'l2')
check('cold start restores run_id', r3.store.runId === 'r2' || r3.store.run.id === 'r2')

// --- 8) executeAcceptance: per-call dir + cleanup -------------------------
// NOTE: the harness executes PYTHON code (v53 design). JS/TS projects fall
// back to the semantic score with ran:false, by design.
const a1 = executeAcceptance('def add(a, b):\n    return a + b', 'add(2,3)==5', tmpState)
check('acceptance ran + passed', a1.ran === true && a1.passed === 1 && a1.total === 1)
const a2 = executeAcceptance('def add(a, b):\n    return a + b', 'add(1,1)==3', tmpState)
check('acceptance detects failure', a2.ran === true && a2.passed === 0)
const a3 = executeAcceptance('def broken(', 'x(1)==1', tmpState)
check('syntax error -> ran:false', a3.ran === false)
const execRoot = join(tmpState, 'exec')
const leftovers = existsSync(execRoot) ? readdirSync(execRoot) : []
check('exec scratch dirs cleaned up', leftovers.length === 0, `leftovers=${leftovers.join(',')}`)
const noAssertion = executeAcceptance('x', 'looks nice', tmpState)
check('no assertion -> null', noAssertion === null)

// --- cleanup ---------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true })
console.log(`\nv89 control verification: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

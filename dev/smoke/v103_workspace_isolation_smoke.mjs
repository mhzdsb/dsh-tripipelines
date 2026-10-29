// v103 — per-workspace store isolation smoke test.
//
// The v102 plugin kept ONE process-wide store and re-homed it on every tool
// call (r.alignTo), so two projects open in the same daemon overwrote each
// other's lock/board/run. v103 keys one store per workspace root. This suite
// proves: A cannot overwrite B, child sessions land in their parent's store,
// the guard is fail-closed, /pipe-stop really freezes, the run footer renders,
// ?workspace= picks the requested board, and a fresh registry restores from
// disk without smearing state across workspaces.
import { mkdirSync, mkdtempSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v103-'))
const libDir = join(tmp, 'lib')

function mkProject(name) {
  const root = join(tmp, name)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

const rootA = mkProject('proj-a')
const rootB = mkProject('proj-b')
const rootC = mkProject('proj-c')

function mkSession(id, cwd) {
  return {
    id,
    header: { cwd },
    seq: 0,
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    surface: {},
    snapshotEvents: () => [],
  }
}

// Shared fake host services.
let childSeq = 0
const subagents = {
  async startActivation() {
    childSeq += 1
    return {
      childId: `child-${childSeq}`,
      messageId: `msg-${childSeq}`,
      result: Promise.resolve({ finalText: '' }),
      dispose() {},
    }
  },
  async drainChildren() {},
}
const llm = {
  async *stream() {
    yield { type: 'text-delta', text: '["calc add function","calc mul function"]' }
  },
}
const routes = []
const webServer = {
  register(route) {
    routes.push(route)
    return () => {}
  },
}

function makeCtx({ sessions, roots, withAgents = true }) {
  const tools = new Map()
  const commands = new Map()
  let guardFn = null
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] }
      if (name === 'agents') return withAgents ? { roots: () => roots, get: () => undefined } : undefined
      if (name === 'tokenMeter') return { estimateMessage: () => 120, measure: () => ({ surfaceTokens: 400 }) }
      if (name === 'subagents') return subagents
      if (name === 'llm') return llm
      if (name === 'webServer') return webServer
      return undefined
    },
    tools: {
      register(def) { tools.set(def.name, def); return () => {} },
      guard(fn) { guardFn = fn; return () => {} },
    },
    systemPrompt: { section() {} },
    skills: { register() {} },
    commands: { register(def) { commands.set(def.name, def); return () => {} } },
  }
  return { ctx, tools, commands, guard: () => guardFn }
}

function call(h, name, args, sessionId) {
  const def = h.tools.get(name)
  if (!def) throw new Error(`missing tool: ${name}`)
  return def.execute(args, { agent: { id: sessionId }, signal: undefined })
}

function statusOf(h, sessionId) {
  return call(h, 'pipeline_status', {}, sessionId)
}

try {
  // Work on a throwaway copy so the test never reads the user's saved config.
  cpSync(join(repoRoot, 'plugins', 'dsh-tripipelines', 'lib'), libDir, { recursive: true })
  const cfgPath = join(libDir, 'config.js')
  const cfgSrc = readFileSync(cfgPath, 'utf8')
  writeFileSync(
    cfgPath,
    cfgSrc.replace(/export const CONFIG_FILE = .*$/m, `export const CONFIG_FILE = ${JSON.stringify(join(tmp, 'global-config.json'))}`),
    'utf8',
  )
  // v108 — the registry persists known workspaces for the switcher. Same trick:
  // point the test copy at a throwaway file instead of ~/.dsh/pipeline.
  const knownFile = join(tmp, 'known-workspaces.json')
  const wsPath = join(libDir, 'workspaces.js')
  const wsSrc = readFileSync(wsPath, 'utf8')
  writeFileSync(
    wsPath,
    wsSrc.replace(/export const DEFAULT_KNOWN_FILE = .*$/m, `export const DEFAULT_KNOWN_FILE = ${JSON.stringify(knownFile)}`),
    'utf8',
  )

  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
  const { normalizeRoot } = await import(pathToFileURL(join(libDir, 'workspaces.js')).href)

  const sessions = new Map([
    ['a1', mkSession('a1', rootA)],
    ['b1', mkSession('b1', rootB)],
  ])
  const h1 = makeCtx({ sessions, roots: [{ id: 'a1' }, { id: 'b1' }] })
  apply(h1.ctx, { mode: 'auto' })

  section('registration')
  check('19 tools registered', h1.tools.size === 19, `got ${h1.tools.size}`)
  check('7 commands registered', h1.commands.size === 7, `got ${h1.commands.size}`)
  check('one board route registered', routes.length === 1, `got ${routes.length}`)

  section('A locks a run; B must not inherit it')
  const lock = await call(h1, 'pipeline_lock_requirements', { requirement: 'build a calc module', activation: 'enable' }, 'a1')
  check('A lock returns a run id', typeof lock.run_id === 'string' && lock.run_id.startsWith('run-'), String(lock.run_id))
  const aLockFile = join(rootA, '.dsh', 'pipeline', 'requirement_lock.json')
  const bLockFile = join(rootB, '.dsh', 'pipeline', 'requirement_lock.json')
  check('A wrote its own lock file', existsSync(aLockFile))
  check('B did not get a copied lock file', !existsSync(bLockFile))

  const bStatus = await statusOf(h1, 'b1')
  check('B status is a fresh idle workspace', bStatus.run_id !== lock.run_id && bStatus.locked !== true, JSON.stringify({ run: bStatus.run_id, locked: bStatus.locked }))
  check('B still has no lock file after a status call', !existsSync(bLockFile))

  const aStatus = await statusOf(h1, 'a1')
  check('A still owns its run', aStatus.run_id === lock.run_id && aStatus.locked === true)
  check('A requirement survived the B call', aStatus.requirement === 'build a calc module')

  section('plan -> spawn -> child decompose lands in A')
  await call(h1, 'pipeline_plan', { taskPlan: { tasks: [{ id: 't1', desc: 'calc add', acceptance: 'add(2,3)==5', assignee: 'mod-a' }] } }, 'a1')
  const spawn = await call(h1, 'pipeline_spawn_module_lead', { name: 'mod-a', prompt: 'write calc add', acceptance: 'add(2,3)==5' }, 'a1')
  check('spawn returns a childId', typeof spawn.childId === 'string' && spawn.childId.length > 0, String(spawn.childId))
  check('spawn records scopeDir', typeof spawn.scopeDir === 'string' && spawn.scopeDir.includes('mod-a'), String(spawn.scopeDir))

  if (typeof spawn.childId === 'string') {
    sessions.set(spawn.childId, mkSession(spawn.childId, join(rootA, '.dsh', 'pipeline', 'work', 'mod-a')))
    const dec = await call(h1, 'pipeline_decompose', { taskId: 't1' }, spawn.childId)
    check('child decompose ran in the parent store', dec.ok === true && Array.isArray(dec.subtasks) && dec.subtasks.length >= 1)
    check('child scopeDir did not get its own .dsh', !existsSync(join(rootA, '.dsh', 'pipeline', 'work', 'mod-a', '.dsh')))
    const aAfter = await statusOf(h1, 'a1')
    check('A board received the subtasks', Array.isArray(aAfter.subtasks) && aAfter.subtasks.length >= 1, `got ${aAfter.subtasks?.length}`)
  }

  section('guard: tier matrix is fail-closed')
  const guard = h1.guard()
  check('guard was registered', typeof guard === 'function')
  check('L1 cannot call pipeline_execute_local', typeof guard({ name: 'pipeline_execute_local', agent: { id: 'a1' } }) === 'string')
  check('child cannot call pipeline_status', typeof guard({ name: 'pipeline_status', agent: { id: `child-${childSeq}` } }) === 'string')
  check('child may call pipeline_decompose', guard({ name: 'pipeline_decompose', agent: { id: `child-${childSeq}` } }) === undefined)

  section('/pipe-stop actually freezes dispatch')
  const stop = h1.commands.get('pipe-stop')
  await stop.handler({ agent: { id: 'a1' }, rawInput: '', signal: undefined })
  const pausedDenial = guard({ name: 'pipeline_spawn_module_lead', agent: { id: 'a1' } })
  check('paused run blocks spawn', typeof pausedDenial === 'string' && /暂停/.test(pausedDenial), String(pausedDenial))

  section('run footer renders on arrays')
  const pausedStatus = await statusOf(h1, 'a1')
  const rendered = h1.tools.get('pipeline_status').output.render({}, pausedStatus)
  check('status render returns an array', Array.isArray(rendered))
  const flat = JSON.stringify(rendered)
  check('footer block was appended', flat.includes('流水线'))
  check('footer shows the pause marker', flat.includes('⏸'))

  section('board route picks ?workspace=')
  const resB = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[0].handler({ url: `/pipeline/board?workspace=${encodeURIComponent(rootB)}` }, resB)
  const snapB = resB.statusCode === 200 ? JSON.parse(resB.body) : null
  check('route returns 200 for B', resB.statusCode === 200, `status ${resB.statusCode}`)
  check('route reports the B workspace key', snapB && snapB.debug && snapB.debug.workspace === normalizeRoot(rootB), JSON.stringify(snapB?.debug))
  check('route reports two stores', snapB && snapB.debug && snapB.debug.stores === 2, JSON.stringify(snapB?.debug))
  // v108 — the card's workspace switcher is fed by this list.
  check('board lists both known workspaces', Array.isArray(snapB?.workspaces) && snapB.workspaces.length === 2, JSON.stringify(snapB?.workspaces))
  check('switcher list carries project names', snapB?.workspaces?.some((w) => w.name === 'proj-a') && snapB?.workspaces?.some((w) => w.name === 'proj-b'), JSON.stringify(snapB?.workspaces))
  check('switcher list marks the active workspace', snapB?.workspaces?.find((w) => w.active)?.key === normalizeRoot(rootB), JSON.stringify(snapB?.workspaces))

  const resX = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[0].handler({ url: `/pipeline/board?workspace=${encodeURIComponent(join(tmp, 'does-not-exist'))}` }, resX)
  check('unknown workspace is a 404', resX.statusCode === 404, `status ${resX.statusCode}`)

  section('mode=off blocks dispatch (new apply)')
  const sessionsOff = new Map([['c1', mkSession('c1', rootC)]])
  const hOff = makeCtx({ sessions: sessionsOff, roots: [{ id: 'c1' }] })
  apply(hOff.ctx, { mode: 'off' })
  const offGuard = hOff.guard()
  const offDenial = offGuard({ name: 'pipeline_spawn_module_lead', agent: { id: 'c1' } })
  check('mode=off denies spawn', typeof offDenial === 'string', String(offDenial))

  section('unattributed caller is refused (fail-closed)')
  const sessionsUnknown = new Map([['u1', mkSession('u1', rootA)]])
  const hUnknown = makeCtx({ sessions: sessionsUnknown, roots: [], withAgents: false })
  apply(hUnknown.ctx, { mode: 'auto' })
  const unknownGuard = hUnknown.guard()
  const unknownDenial = unknownGuard({ name: 'pipeline_spawn_module_lead', agent: { id: 'u1' } })
  check('unknown tier denies spawn', typeof unknownDenial === 'string', String(unknownDenial))

  section('client widget follows the current workspace')
  // v110: the card must track the DSH workspace the user is looking at. Slot
  // components receive the shell's `useSessions` hook, and the main view's session
  // carries `retainedBy.mainView > 0` plus its cwd — so the widget sends that cwd
  // and the host resolves it to a project root even before any pipeline tool ran
  // there. v108/v109 persisted the pick in localStorage, which pinned the card to
  // a stale project across switches; the legacy key must stay cleared and the
  // picker must offer a "follow" entry.
  const clientSrc = readFileSync(join(repoRoot, 'plugins', 'dsh-tripipelines', 'client.js'), 'utf8')
  check('client reads the main-view session cwd', clientSrc.includes('retainedBy') && clientSrc.includes('mainView') && clientSrc.includes('cwd'), '')
  check('client offers a follow-current-workspace entry', clientSrc.includes('跟随当前工作区'), '')
  check('client clears the legacy persisted pick', clientSrc.includes('removeItem') && !clientSrc.includes('localStorage.setItem'), '')
  check('rail and card share the pick hook', clientSrc.includes('usePickedWorkspace') && !clientSrc.includes('setPicked'), '')

  section('cold start restores per workspace')
  const h2 = makeCtx({ sessions, roots: [{ id: 'a1' }, { id: 'b1' }] })
  apply(h2.ctx, { mode: 'auto' })
  // v108: the registry persists the projects it served, so a cold board restores
  // the newest one (which is what the switcher shows) instead of idle.
  const resCold = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[routes.length - 1].handler({ url: '/pipeline/board' }, resCold)
  const coldSnap = resCold.statusCode === 200 ? JSON.parse(resCold.body) : null
  check('cold board answers 200', resCold.statusCode === 200, `status ${resCold.statusCode}`)
  check('cold board restores the newest known workspace', coldSnap?.debug?.workspace === normalizeRoot(rootB), JSON.stringify(coldSnap?.debug))
  check('cold board lists the known workspaces', Array.isArray(coldSnap?.workspaces) && coldSnap.workspaces.length === 2, JSON.stringify(coldSnap?.workspaces))

  // The switcher may ask for a project this daemon has not loaded yet.
  const resLoadA = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[routes.length - 1].handler({ url: `/pipeline/board?workspace=${encodeURIComponent(rootA)}` }, resLoadA)
  const loadA = resLoadA.statusCode === 200 ? JSON.parse(resLoadA.body) : null
  check('cold board can load A from disk by key', resLoadA.statusCode === 200 && loadA?.debug?.workspace === normalizeRoot(rootA), `status ${resLoadA.statusCode}`)
  check('loaded A restores its run', loadA?.run?.id === lock.run_id, JSON.stringify({ run: loadA?.run?.id }))

  // v110 — the sidebar widget sends the current session's cwd, which is often a
  // subdirectory of the project (e.g. the session was started in src/). The route
  // must walk up to the project root instead of 404ing or creating a store there.
  mkdirSync(join(rootA, 'src', 'nested'), { recursive: true })
  const resSub = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[routes.length - 1].handler({ url: `/pipeline/board?workspace=${encodeURIComponent(join(rootA, 'src', 'nested'))}` }, resSub)
  const subSnap = resSub.statusCode === 200 ? JSON.parse(resSub.body) : null
  check('a session cwd subdirectory resolves to its project root', resSub.statusCode === 200 && subSnap?.debug?.workspace === normalizeRoot(rootA), `status ${resSub.statusCode} · ${JSON.stringify(subSnap?.debug)}`)
  check('the subdirectory probe did not create a nested store', !existsSync(join(rootA, 'src', 'nested', '.dsh')))

  const coldA = await statusOf(h2, 'a1')
  check('cold start restores A lock', coldA.run_id === lock.run_id && coldA.locked === true, JSON.stringify({ run: coldA.run_id, locked: coldA.locked }))
  check('cold start keeps B empty', !existsSync(bLockFile))
  const coldB = await statusOf(h2, 'b1')
  check('B still does not inherit A run', coldB.run_id !== lock.run_id)

  section('a daemon with no known workspace shows idle, not an error')
  rmSync(knownFile, { force: true })
  const h3 = makeCtx({ sessions: new Map(), roots: [], withAgents: false })
  apply(h3.ctx, { mode: 'auto' })
  const resIdle = { statusCode: 0, body: null, headersSent: false, writeHead(code) { this.statusCode = code; this.headersSent = true }, end(body) { this.body = body } }
  routes[routes.length - 1].handler({ url: '/pipeline/board' }, resIdle)
  const idleSnap = resIdle.statusCode === 200 ? JSON.parse(resIdle.body) : null
  check('cold board without state answers 200 idle', resIdle.statusCode === 200 && idleSnap?.ok === true && idleSnap?.run?.status === 'idle', `status ${resIdle.statusCode}`)
  check('idle snapshot is marked idle in debug', idleSnap?.debug?.idle === true && idleSnap?.debug?.stores === 0, JSON.stringify(idleSnap?.debug))
} catch (err) {
  failed += 1
  console.log(`  ✗ fatal: ${err && err.stack ? err.stack : err}`)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

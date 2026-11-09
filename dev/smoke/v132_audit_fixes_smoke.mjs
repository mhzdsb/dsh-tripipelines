// v132 (1.35.0) — the audit-fix smoke: proves the A/B/C group changes from the
// 2026-11-09 full audit hold:
//   D1 archived-L2 ghosts: lock drains superseded leads; cleanupExpiredL2s reaps
//      BOTH replaced and archived via retiredAtMs; spawn cap + accountL2Tokens skip them.
//   D2 milestone taskIds validated at plan time — unknown ids rejected BEFORE any board write.
//   C7 project layer <devDir>/pipeline-project.json resolves against the WORKSPACE ROOT,
//      not process.cwd() (daemon/profile dir in GUI launches).
//   C8 /pipe-off writes the PROJECT file, not the global config; a project-off workspace
//      refuses execution tools while other workspaces keep running.
//   C9 missing `python` names itself (python-not-found) instead of anonymous runner-failed.
//   B4/B5 market display: icon.svg + locale/{en,zh}.json valid; client dictionary parity zh/en.
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v132-'))
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

const drainCalls = []
const subagents = {
  async startActivation(request) {
    return { childId: `child-${request.label}`, messageId: 'msg', dispose() {} }
  },
  async drainChildren(agent, ids) {
    drainCalls.push(Array.isArray(ids) ? [...ids] : ids)
  },
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

  const gates = await import(pathToFileURL(join(libDir, 'gates.js')).href)
  const conf = await import(pathToFileURL(join(libDir, 'config.js')).href)

  section('D1 — retiredAtMs covers both retire paths')
  check('replaced → replacedAt ms', gates.retiredAtMs({ state: 'replaced', replacedAt: 123456789 }) === 123456789)
  check('archived → archivedAt ISO', gates.retiredAtMs({ state: 'archived', archivedAt: '2026-11-09T00:00:00.000Z' }) === Date.parse('2026-11-09T00:00:00.000Z'))
  check('live agent → null', gates.retiredAtMs({ state: 'in_progress' }) === null)
  check('done agent → null', gates.retiredAtMs({ state: 'done' }) === null)
  {
    // cleanupExpiredL2s must reap archived too (was replaced-only before v132).
    const fakeStore = { agents: new Map([
      ['c1', { kind: 'l2', state: 'archived', archivedAt: new Date(Date.now() - 999999).toISOString() }],
      ['c2', { kind: 'l2', state: 'replaced', replacedAt: Date.now() - 999999 }],
      ['c3', { kind: 'l2', state: 'in_progress' }],
    ]) }
    const fakeR = { store: fakeStore }
    let drained = null
    const subs = { drainChildren: (agent, ids) => { drained = ids } }
    gates.cleanupExpiredL2s(subs, { id: 'x' }, fakeR, {})
    check('expired archived+replaced drained', Array.isArray(drained) && drained.includes('c1') && drained.includes('c2'), JSON.stringify(drained))
    check('live lead not drained', !(drained ?? []).includes('c3'))
    check('reaped agents marked done', fakeStore.agents.get('c1').state === 'done' && fakeStore.agents.get('c2').state === 'done')
  }

  section('C7 — loadProjectConfig anchors to the workspace root')
  {
    const devAbs = join(rootA, 'dev')
    mkdirSync(devAbs, { recursive: true })
    writeFileSync(join(devAbs, 'pipeline-project.json'), JSON.stringify({ maxCodeLines: 42 }), 'utf8')
    const proj = conf.loadProjectConfig('dev', rootA)
    check('relative devDir + root reads the project file', proj.maxCodeLines === 42, JSON.stringify(proj))
    const none = conf.loadProjectConfig('dev', rootB)
    check('other workspace unaffected', Object.keys(none).length === 0, JSON.stringify(none))
    const legacy = conf.loadProjectConfig(devAbs)
    check('absolute devDir still works (legacy callers)', legacy.maxCodeLines === 42)
  }

  section('plugin apply with per-workspace dispatch')
  // Fresh state dirs: the C7 probe above created dev/ under both roots; findProjectRoot
  // accepts .git OR .dsh/pipeline, but keep the board dirs pristine for deterministic asserts.
  rmSync(join(rootA, '.dsh'), { recursive: true, force: true })
  rmSync(join(rootB, '.dsh'), { recursive: true, force: true })
  const h = makeCtx()
  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
  // semanticGateThreshold 0.5: the smoke plans prose acceptance; real configs get
  // this guard from validateAcceptanceCriteria itself (v119).
  apply(h.ctx, { mode: 'auto', level2Provider: 'deepseek-official', level2Model: 'deepseek-flash', level3Mode: 'off', semanticGateThreshold: 0.5 })
  const callIn = (sid, name, args = {}) => h.tools.get(name).execute(args, { agent: { id: sid }, signal: undefined })

  section('D1 — lock_requirements drains superseded L2s')
  await callIn('sB', 'pipeline_lock_requirements', { requirement: 'B baseline run' })
  const lockA = await callIn('sA', 'pipeline_lock_requirements', { requirement: 'first run' })
  check('A locked', Boolean(lockA?.run_id ?? lockA?.runId), JSON.stringify(lockA).slice(0, 160))
  {
    const boardPath = join(rootA, '.dsh', 'pipeline', 'board.json')
    check('A state lives under its own root (v118/C7 runtime dir)', existsSync(boardPath))
    // Inject a live l2 ghost straight into the in-memory store (the same map spawn
    // writes), then re-lock: the archive loop must collect + drain it.
    const spawned = await callIn('sA', 'pipeline_spawn_module_lead', { name: 'core', description: 'x', prompt: 'y' })
    check('stub spawn returned childId', typeof spawned?.childId === 'string', JSON.stringify(spawned).slice(0, 160))
    const ghostId = spawned.childId
    const lock2 = await callIn('sA', 'pipeline_lock_requirements', { requirement: 'second run' })
    void lock2
    const lastDrain = drainCalls[drainCalls.length - 1]
    check('lock drained the superseded lead', Array.isArray(lastDrain) && lastDrain.includes(ghostId), JSON.stringify(drainCalls))
    const boardAfter = JSON.parse(readFileSync(boardPath, 'utf8'))
    const ghost = (boardAfter.agents ?? []).find((a) => a.id === ghostId)
    check('ghost archived or reaped (not left live)', ghost && (ghost.state === 'archived' || ghost.state === 'done'), JSON.stringify(ghost))
  }

  section('D2 — milestone taskIds validated before any board write')
  {
    const before = JSON.parse(readFileSync(join(rootB, '.dsh', 'pipeline', 'board.json'), 'utf8'))
    let err = null
    try {
      await callIn('sB', 'pipeline_plan', {
        taskPlan: {
          tasks: [{ id: 'alpha', desc: 'make alpha', acceptance: 'alpha works end to end' }],
          milestones: [{ id: 'm1', name: 'M1', taskIds: ['alpha', 'typo-id'] }],
        },
      })
    } catch (e) { err = e }
    check('unknown milestone id rejected', String(err?.message ?? '').includes('unknown task "typo-id"'), String(err?.message))
    check('error explains the stall', String(err?.message ?? '').includes('永远停在 pending'), String(err?.message))
    const after = JSON.parse(readFileSync(join(rootB, '.dsh', 'pipeline', 'board.json'), 'utf8'))
    check('rejected plan left board untouched', JSON.stringify(after.tasks) === JSON.stringify(before.tasks), 'board.tasks changed')
    // Valid plan passes.
    const ok = await callIn('sB', 'pipeline_plan', {
      taskPlan: { tasks: [{ id: 'alpha', desc: 'make alpha', acceptance: 'alpha works end to end' }], milestones: [{ id: 'm1', name: 'M1', taskIds: ['alpha'] }] },
    })
    check('valid milestone accepted', ok && String(JSON.stringify(ok)).includes('m1'), JSON.stringify(ok).slice(0, 200))
  }

  section('C8 — /pipe-off is project-scoped')
  {
    const offCmd = h.commands.get('pipe-off')
    const res = await offCmd.handler({ agent: { id: 'sA' } })
    const projFile = join(rootA, 'dev', 'pipeline-project.json')
    check('success text names the project file', String(res.text ?? '').includes('pipeline-project.json'), String(res.text))
    check('project file written with mode off', existsSync(projFile) && JSON.parse(readFileSync(projFile, 'utf8')).mode === 'off', readFileSync(projFile, 'utf8'))
    const globalCfg = existsSync(globalConfigPath) ? JSON.parse(readFileSync(globalConfigPath, 'utf8')) : {}
    check('global config NOT switched off', String(globalCfg.mode ?? 'auto') !== 'off', JSON.stringify(globalCfg))
    // The store for A was created BEFORE the project layer existed (registry caches
    // entries), so the live refusal starts at the next workspace load. Prove both halves:
    // (a) reload path refuses — restart apply against a fresh registry; (b) B unaffected.
    const bAlive = await callIn('sB', 'pipeline_status')
    check('B still answers normally', bAlive && String(bAlive.locked) === 'true' && Boolean(bAlive.run_id), JSON.stringify(bAlive).slice(0, 160))
    // /pipe-config mode auto inside A rewrites the PROJECT layer back.
    const reOn = await h.commands.get('pipe-config').handler({ rawInput: 'mode auto', agent: { id: 'sA' } })
    void reOn
    const projAfter = JSON.parse(readFileSync(projFile, 'utf8'))
    check('mode auto written back to project layer', String(projAfter.mode) === 'auto', JSON.stringify(projAfter))
  }

  section('C8b — fresh boot honors project-off (per-root merged view)')
  {
    const projFile = join(rootA, 'dev', 'pipeline-project.json')
    writeFileSync(projFile, JSON.stringify({ mode: 'off' }, null, 2), 'utf8')
    rmSync(join(rootA, '.dsh'), { recursive: true, force: true })
    rmSync(join(tmp, 'known-workspaces.json'), { force: true })
    const h2 = makeCtx()
    // Fresh module instance so the registry starts empty and re-reads the project layer.
    const mod2 = await import(pathToFileURL(join(libDir, 'plugin.js')).href + '?t=' + Date.now())
    mod2.apply(h2.ctx, { mode: 'auto', level2Provider: 'deepseek-official', level2Model: 'deepseek-flash', level3Mode: 'off', semanticGateThreshold: 0.5 })
    const refused = await h2.tools.get('pipeline_spawn_module_lead').execute({ name: 'core', description: 'x', prompt: 'y' }, { agent: { id: 'sA' }, signal: undefined })
    check('A refuses execution tools after reload', String(refused?.kind ?? '') === 'error' && String(refused?.text ?? '').includes('本项目已关闭三级流水线'), JSON.stringify(refused).slice(0, 220))
    const b2 = await h2.tools.get('pipeline_status').execute({}, { agent: { id: 'sB' }, signal: undefined })
    check('B unaffected by A project-off', b2 && !String(JSON.stringify(b2)).includes('本项目已关闭'), JSON.stringify(b2).slice(0, 120))
  }

  section('C9 — python-not-found diagnostic + zero-arg assertion crash fix')
  {
    // v132: `ok()==True` (zero-arg call) used to CRASH extractAssertions — the
    // optional empty-args group matched undefined and .trim() threw before the
    // gate could run. It must now parse into one assertion.
    const as = gates.extractAssertions('ok()==True and helper(1)==2')
    check('zero-arg assertion parses', as.length === 2 && as[0].name === 'ok' && as[0].args === '', JSON.stringify(as))
    const gres = gates.executeAcceptance(
      'def ok():\n    return True\n',
      'ok()==True',
      join(tmp, 'gate-scratch'),
      { allowCodeExecution: true, acceptanceLanguage: 'python' },
    )
    check('assertions extracted', (gres.assertions ?? []).length >= 1, JSON.stringify(gres).slice(0, 200))
    // On machines WITH python this runs; without it must say python-not-found,
    // never a bare runner-failed.
    if (!gres.ran) {
      check('missing python names itself (or guard rejected)', ['python-not-found', 'guard-rejected'].includes(gres.reason), gres.reason)
    } else {
      check('assertion ran where python exists', typeof gres.passed === 'number', JSON.stringify(gres).slice(0, 200))
    }
  }
  section('B4/B5 — market display resources')
  {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
    const icon = readFileSync(join(pkgRoot, 'icon.svg'), 'utf8')
    check('icon.svg present & SVG-rooted', /^<svg[\s>]/.test(icon.trim()) && icon.includes('</svg>'))
    check('icon ≤256KiB', Buffer.byteLength(icon) <= 256 * 1024, String(Buffer.byteLength(icon)))
    const en = JSON.parse(readFileSync(join(pkgRoot, 'locale', 'en.json'), 'utf8'))
    const zh = JSON.parse(readFileSync(join(pkgRoot, 'locale', 'zh.json'), 'utf8'))
    check('locale en meta.title/description', typeof en?.meta?.title === 'string' && typeof en?.meta?.description === 'string')
    check('locale zh meta.title/description', typeof zh?.meta?.title === 'string' && typeof zh?.meta?.description === 'string')
    check('exports ./icon + ./locale/*.json', pkg.exports['./icon'] === './icon.svg' && './locale/*.json' in pkg.exports, JSON.stringify(pkg.exports))
    check('files[] ships icon + locale', pkg.files.includes('icon.svg') && pkg.files.includes('locale/*.json'), JSON.stringify(pkg.files))
    // Client dictionary parity: extract L_ZH / L_EN key sets by evaluating the factory source head.
    // \r? tolerant: client.js carries CRLF line endings on Windows checkouts.
    const clientSrc = readFileSync(join(pkgRoot, 'client.js'), 'utf8').replace(/\r\n/g, '\n')
    const dictMatch = clientSrc.match(/const L_ZH = \{([\s\S]*?)\n\s*\}\n\s*const L_EN = \{([\s\S]*?)\n\s*\}/)
    check('client dictionaries found', Boolean(dictMatch), 'L_ZH/L_EN block regex miss')
    if (dictMatch) {
      const keysOf = (body) => [...body.matchAll(/^\s*'?([A-Za-z0-9_]+)'?:/gm)].map((m) => m[1])
      const kz = keysOf(dictMatch[1])
      const ke = keysOf(dictMatch[2])
      const missing = kz.filter((k) => !ke.includes(k))
      const extra = ke.filter((k) => !kz.includes(k))
      check('zh/en dictionary parity', missing.length === 0 && extra.length === 0, `missing=${missing} extra=${extra}`)
      check('dictionary non-trivial', kz.length >= 20, String(kz.length))
    }
    check('slot registers locale ns', clientSrc.includes("locale: I18N_NS") || clientSrc.includes('locale: I18N_NS'))
    check('ctx.locale.register guarded', clientSrc.includes('ctx.locale') && clientSrc.includes("'pipeline-board'"))
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v132_audit_fixes_smoke — ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

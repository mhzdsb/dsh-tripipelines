// v119 — the quality gate must have an exit.
//
// The v118 gate could plan work it would never accept:
//   1) pipeline_register_output never recorded l3SubtaskId, so every L2 takeover
//      review failed `subtask-id-match` (null !== "t1-s1");
//   2) with prose acceptance the semantic score is capped at 0.5, so the default
//      0.7 gate could never pass — yet pipeline_plan happily accepted the plan;
//   3) the AST fuse blocks pathlib/os/open, so a real file task could not be
//      verified by an assertion at all;
//   4) the cascade made milestones permanently 0/1 with an unhelpful error.
// This suite pins the v119 contract:
//   * register_output → review passes subtask-id-match;
//   * pipeline_plan rejects an unpassable acceptance with actionable guidance;
//   * `cmd: ...` acceptance runs in the workspace and decides file tasks;
//   * the sandboxed assertion runner still blocks imports/IO for model code;
//   * accept_milestone names the blocking task/subtask instead of "0/1";
//   * deterministic decompose never inserts spaces into filenames;
//   * a new run archives previous L2s; status explains its counters and the
//     L1 context warning is explicitly warning-only;
//   * pipeline_scan skips _scratch.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const load = (rel) => import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines', rel)).href)
const { createStore } = await load('lib/store.js')
const { makeLockTool, makePlanTool, makeStatusTool, makeAcceptMilestoneTool } = await load('lib/tools/l1.js')
const { makeDecomposeTool, makeRegisterOutputTool, makeReviewTool } = await load('lib/tools/l2l3.js')
const { gateSubtask, gateTask, extractCommand, acceptanceMode, validateAcceptanceCriteria, executeCommandAcceptance } = await load('lib/gates.js')
const { splitIntoChunks, SEMANTIC_SCORE_CAP } = await load('lib/util.js')
const { measureLevel1Context } = await load('lib/dsh-compat.js')
const { scanRepo, checkStale } = await load('lib/knowledge/scan.js')
const { DEFAULT_CONFIG, validateConfigValue } = await load('lib/config.js')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v119-'))
let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${t}`) }

const cfg = {
  devDir: 'dev',
  maxCodeLines: 100,
  semanticGateThreshold: 0.7,
  allowCodeExecution: true,
  maxLevel3Retries: 2,
  maxLevel2Retries: 2,
  maxLevel2Agents: 5,
  level2Provider: 'test-provider',
  level2Model: 'test-model',
  level3Endpoint: 'http://127.0.0.1:9/v1',
  level3InputBudget: 1200,
  commandAcceptanceTimeoutMs: 60000,
  maxTotalTokensPerRun: 1000000,
  maxDurationPerRun: 7200000,
  maxFilesPerRun: 100,
}
const ctx = { get: () => undefined }
const exec = { agent: { id: 'l1' }, signal: undefined }

function newStore(name) {
  const root = join(tmp, name)
  mkdirSync(root, { recursive: true })
  const r = createStore(cfg, { root, restore: false })
  r.store.locked = true
  r.store.runId = `run-${name}`
  r.store.run = { id: r.store.runId, status: 'active', milestones: [], tokensUsed: 0, filesTouched: [], spawnCounts: {}, paused: false }
  r.store.requirement = 'v119 regression fixture'
  r.saveRun()
  return r
}

function addTask(r, id, acceptance, subtaskIds = []) {
  r.store.tasks.set(id, { id, desc: `task ${id}`, assignee: 'calc', acceptance, depends_on: [], state: 'pending', reason: null, subtaskIds })
}
function addSubtask(r, id, parent, acceptance, overrides = {}) {
  r.store.subtasks.set(id, {
    id, parent, desc: `subtask ${id}`, acceptance, state: 'pending', status: null,
    code: null, filePath: null, reason: null, failCount: 0, ...overrides,
  })
}

try {
  section('defect 1 — register_output → review records subtask-id-match')
  {
    const r = newStore('p1')
    addTask(r, 't1', 'add(1,2)===3', ['s1'])
    addSubtask(r, 's1', 't1', 'add(1,2)===3')
    const register = makeRegisterOutputTool(ctx, cfg, r)
    const reg = await register.execute({ subtaskId: 's1', code: 'function add(a,b){ return a+b }' }, exec)
    check('register sets l3SubtaskId to the subtask id', r.store.subtasks.get('s1').l3SubtaskId === 's1')
    check('register puts the subtask in review', reg.state === 'review')
    const review = makeReviewTool(ctx, cfg, r)
    const rv = await review.execute({ subtaskId: 's1' }, exec)
    check('review passes subtask-id-match', rv.ok === true && rv.checks.some((c) => c.name === 'subtask-id-match' && c.pass), JSON.stringify(rv.checks))
    check('review runs the assertion', rv.checks.some((c) => /execution-assertions 1\/1/.test(c.name)))
    check('review advances the subtask to done', rv.state === 'done')
  }

  section('defect 2 — plan refuses an acceptance the gate can never pass')
  {
    const r = newStore('p2')
    const plan = makePlanTool(ctx, cfg, r)
    let err = null
    try {
      await plan.execute({ taskPlan: { tasks: [{ id: 't1', desc: 'sync', acceptance: '连跑两次都成功' }] } }, exec)
    } catch (e) { err = e }
    check('prose acceptance + 0.7 threshold is rejected at plan time', !!err)
    check('the error offers assertions / cmd: / lower threshold', /断言|cmd:|semanticGateThreshold/.test(String(err?.message)))
    check('the error names the offending task', /t1/.test(String(err?.message)))

    const cmdPlan = await plan.execute({ taskPlan: { tasks: [{ id: 't2', desc: 'sync', acceptance: 'cmd: node -e "process.exit(0)"' }] } }, exec)
    check('cmd: acceptance is accepted by the plan', cmdPlan.tasks.some((t) => t.id === 't2'))

    const lowCfg = { ...cfg, semanticGateThreshold: SEMANTIC_SCORE_CAP }
    const low = makePlanTool(ctx, lowCfg, r)
    const lowPlan = await low.execute({ taskPlan: { tasks: [{ id: 't3', desc: 'docs', acceptance: '写清楚就行' }] } }, exec)
    check('prose acceptance is allowed when the threshold is explicitly ≤ cap', lowPlan.tasks.some((t) => t.id === 't3'))

    const noExec = makePlanTool(ctx, { ...cfg, allowCodeExecution: false }, r)
    let cmdErr = null
    try {
      await noExec.execute({ taskPlan: { tasks: [{ id: 't4', desc: 'run', acceptance: 'cmd: node -e "process.exit(0)"' }] } }, exec)
    } catch (e) { cmdErr = e }
    check('cmd: acceptance is rejected when code execution is disabled', !!cmdErr && /allowCodeExecution/.test(String(cmdErr.message)))
    check('acceptanceMode classifies the three forms',
      acceptanceMode('add(1,2)===3') === 'assertion' &&
      acceptanceMode('cmd: node x.mjs') === 'command' &&
      acceptanceMode('looks nice') === 'semantic')
    check('extractCommand reads a multiline acceptance', extractCommand('first line\ncmd:  node  dev/check.mjs\nlast') === 'node  dev/check.mjs')
  }

  section('defect 3 — cmd: acceptance verifies file tasks without weakening the sandbox')
  {
    const r = newStore('p3')
    const root = r.store.workspaceRoot
    writeFileSync(join(root, 'target.md'), 'hello\n', 'utf8')
    mkdirSync(join(root, 'dev'), { recursive: true })
    writeFileSync(
      join(root, 'dev', 'check_sync.py'),
      [
        'from pathlib import Path',
        'import sys',
        'p = Path("target.md")',
        'sys.exit(0 if p.exists() and p.read_text(encoding="utf-8") == "hello\\n" else 3)',
        '',
      ].join('\n'),
      'utf8',
    )
    const acceptance = 'cmd: python dev/check_sync.py'
    addTask(r, 't1', acceptance, ['s1'])
    addSubtask(r, 's1', 't1', acceptance, { state: 'done', code: 'from pathlib import Path\n' })
    const taskGate = gateTask(r.store.tasks.get('t1'), [...r.store.subtasks.values()], cfg, null, r.store.stateDir, root)
    check('cmd: acceptance passes when the workspace check exits 0', taskGate.ok === true && taskGate.checks.some((c) => /command-acceptance exit 0/.test(c.name)), JSON.stringify(taskGate.checks))

    writeFileSync(join(root, 'target.md'), 'bye\n', 'utf8')
    const badGate = gateTask(r.store.tasks.get('t1'), [...r.store.subtasks.values()], cfg, null, r.store.stateDir, root)
    check('cmd: acceptance fails on a non-zero exit', badGate.ok === false && badGate.checks.some((c) => /command-acceptance exit 3/.test(c.name)), JSON.stringify(badGate.checks))

    const blocked = gateSubtask(
      { subtask_id: 's9', code: 'from pathlib import Path\ndef add(a, b):\n    return a + b', status: 'done' },
      's9', 'add(2,3)==5', cfg, r.store.stateDir, root,
    )
    check('the assertion sandbox still blocks pathlib imports', blocked.ok === false && blocked.checks.some((c) => /guard-rejected/.test(c.name)), JSON.stringify(blocked.checks))

    const deferred = gateSubtask(
      { subtask_id: 's8', code: 'x = 1', status: 'done' },
      's8', 'cmd: python dev/check_sync.py', cfg, r.store.stateDir, root, { deferCommand: true },
    )
    check('a multi-subtask module may defer command acceptance to the task gate', deferred.ok === true && deferred.checks.some((c) => c.deferred === true), JSON.stringify(deferred.checks))

    const direct = executeCommandAcceptance('node -e "process.exit(0)"', root, cfg)
    check('command runner reports a clean exit', direct.ran === true && direct.exitCode === 0)
    const disabled = executeCommandAcceptance('node -e "process.exit(0)"', root, { ...cfg, allowCodeExecution: false })
    check('command runner respects allowCodeExecution=false', disabled.ran === false && disabled.reason === 'execution-disabled')
  }

  section('defect 4 — accept_milestone names the blockers')
  {
    const r = newStore('p4')
    addTask(r, 't1', 'add(1,2)===3', ['s1'])
    addSubtask(r, 's1', 't1', 'add(1,2)===3', { state: 'failed', reason: 'quality gate failed (subtask-id-match)' })
    r.store.run.milestones = [{ id: 'm1', name: 'M1', taskIds: ['t1'], state: 'pending' }]
    const accept = makeAcceptMilestoneTool(ctx, cfg, r)
    let err = null
    try { await accept.execute({ milestoneId: 'm1', userConfirmed: true }, exec) } catch (e) { err = e }
    const msg = String(err?.message ?? '')
    check('blocked milestone still refuses acceptance', !!err)
    check('the error lists the blocking task', /task t1 pending/.test(msg))
    check('the error lists the blocking subtask and reason', /s1:failed/.test(msg) && /subtask-id-match/.test(msg))
    r.store.tasks.get('t1').state = 'done'
    const ok = await accept.execute({ milestoneId: 'm1', userConfirmed: true }, exec)
    check('acceptance succeeds once every task is done', ok.ok === true && r.store.run.milestones[0].state === 'accepted')
  }

  section('defect 5 — deterministic decompose keeps filenames intact')
  {
    const src = '创建 dev/knowledge/sync_pipeline_knowledge.py：在 dev/knowledge/decisions.md 中登记；然后运行 --check 确认 ALL IN SYNC。'
    const chunks = splitIntoChunks(src, 20)
    const joined = chunks.join(' ')
    check('sentence split keeps .py / .md filenames intact', !/\.\s+(py|md)\b/.test(joined), joined)
    check('sentence split still produces boundaries', chunks.length >= 2, JSON.stringify(chunks))

    const r = newStore('p5')
    addTask(r, 't1', 'add(1,2)===3')
    const dec = makeDecomposeTool({ get: () => undefined }, cfg, r)
    const d = await dec.execute({ taskId: 't1' }, exec)
    const descs = d.subtasks.map((s) => s.desc).join(' ')
    check('deterministic decompose reports its fallback reason', d.via === 'deterministic' && typeof d.fallbackReason === 'string')
    check('fallback descriptions do not split filenames', !/\.\s+(py|md)\b/.test(descs), descs)
    check('fallback subtasks inherit the validated module acceptance', d.subtasks.every((s) => s.acceptance === 'add(1,2)===3'))
  }

  section('defect 5b — decompose never assigns an unpassable per-subtask acceptance')
  {
    const r = newStore('p5b')
    addTask(r, 't1', 'add(1,2)===3')
    const llm = {
      get: () => undefined,
      llm: {
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: JSON.stringify([{ desc: 'write add', acceptance: '看起来没问题' }]) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      },
    }
    const dec = makeDecomposeTool(llm, cfg, r)
    const d = await dec.execute({ taskId: 't1' }, exec)
    check('prose per-subtask acceptance falls back to the module acceptance', d.subtasks[0].acceptance === 'add(1,2)===3', d.subtasks[0].acceptance)
  }

  section('defect 6 — a new run archives stale L2s')
  {
    const r = newStore('p6')
    r.store.agents.set('l2-old', { id: 'l2-old', kind: 'l2', label: 'old', state: 'in_progress', desc: 'old work' })
    r.store.agents.set('l2-replaced', { id: 'l2-replaced', kind: 'l2', label: 'old2', state: 'replaced', desc: 'old work' })
    r.store.agents.set('l2-done', { id: 'l2-done', kind: 'l2', label: 'done', state: 'done', desc: 'finished' })
    const lock = makeLockTool(ctx, cfg, r)
    await lock.execute({ requirement: 'new run', activation: 'enable' }, exec)
    check('a live L2 from the previous run is archived', r.store.agents.get('l2-old').state === 'archived')
    check('a replaced L2 is archived too', r.store.agents.get('l2-replaced').state === 'archived')
    check('a finished L2 keeps its done state', r.store.agents.get('l2-done').state === 'done')
    const status = makeStatusTool(ctx, cfg, r)
    const st = await status.execute({}, exec)
    check('waitingFor is empty after the new run starts', st.waitingFor === undefined, JSON.stringify(st.waitingFor))
  }

  section('defect 7 — counters are explained, context warning is warning-only, _scratch is skipped')
  {
    const r = newStore('p7')
    r.store.counters.measuredTokens = 62466
    r.store.run.tokensUsed = 64416
    const status = makeStatusTool(ctx, cfg, r)
    const st = await status.execute({}, exec)
    check('status explains plugin-side counters vs measured L2 tokens', /measuredTokens/.test(String(st.countersNote)) && /L2/.test(String(st.countersNote)))
    check('measuredTokens is still exposed', st.measuredTokens === 62466 && st.tokensUsed === 64416)

    const fakeSession = { id: 's1', surface: true, requestHeader: () => ({}) }
    const meterCtx = { get: (name) => (name === 'tokenMeter' ? { measure: () => ({ totalTokens: 699000 }) } : undefined) }
    const mc = measureLevel1Context(meterCtx, { session: fakeSession }, cfg)
    check('an over-budget context reading carries warningOnly/blocks=false', mc && mc.warningOnly === true && mc.blocks === false, JSON.stringify(mc))
    check('the context warning says 仅告警', /仅告警/.test(String(mc?.warning)))

    const root = join(tmp, 'scan-root')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'dev', '_scratch'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.js'), 'export const x = 1\n', 'utf8')
    writeFileSync(join(root, 'dev', '_scratch', 'tmp.js'), 'console.log("scratch")\n', 'utf8')
    const outDir = join(tmp, 'scan-out')
    const scan = scanRepo({ root, outDir })
    check('scan does not count _scratch files', scan.stats.files === 1, `${scan.stats.files} files`)
    writeFileSync(join(root, 'dev', '_scratch', 'later.js'), 'console.log("later")\n', 'utf8')
    const stale = checkStale({ root, outDir })
    check('check-stale ignores new _scratch files', stale.available === true && stale.added.length === 0, JSON.stringify(stale.added))

    check('commandAcceptanceTimeoutMs is a known default', DEFAULT_CONFIG.commandAcceptanceTimeoutMs === 120000)
    let cfgErr = null
    try { validateConfigValue('commandAcceptanceTimeoutMs', 500) } catch (e) { cfgErr = e }
    check('commandAcceptanceTimeoutMs rejects sub-second values', !!cfgErr && /1000/.test(String(cfgErr.message)))
  }
} catch (err) {
  failed += 1
  console.log(`  ✗ fatal: ${err && err.stack ? err.stack : err}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nv119 smoke: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

// v105 — lifecycle invariants that used to be "advertised but not enforced":
//   * re-planning no longer reopens finished work or erases a done-but-unaccepted
//     milestone (explicit reset:true is required);
//   * milestone acceptance needs an explicit user confirmation;
//   * a failed drain is a real failure (agents fail, drain reports ok:false);
//   * re-dispatching the same module is bounded by maxLevel2Retries;
//   * counters survive a cold start;
//   * L2 decomposition tokens are counted;
//   * an L2 takeover file counts toward maxFilesPerRun.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const { createStore } = await import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib/store.js')).href)
const { makePlanTool, makeAcceptMilestoneTool, makeDrainLeadsTool, makeSpawnModuleLeadTool } = await import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib/tools/l1.js')).href)
const { makeDecomposeTool, makeRegisterOutputTool } = await import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib/tools/l2l3.js')).href)

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v105-'))
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
  level2ContextBudget: 32000,
  level3Model: 'test-l3',
  level3Provider: 'ninfer-local',
  spawnProvider: 'spawn',
  level3Endpoint: 'http://127.0.0.1:9/v1',
  level3InputBudget: 1200,
  maxTotalTokensPerRun: 1000000,
  maxDurationPerRun: 7200000,
  maxFilesPerRun: 100,
  level3Compression: 'L1',
}

let spawnSeq = 0
let failDrain = false
const subagents = {
  async startActivation() { spawnSeq += 1; return { childId: `child-${spawnSeq}`, messageId: 'msg', dispose() {} } },
  async drainChildren() { if (failDrain) throw new Error('drain boom') },
  async sendMessage() { return 'msg' },
}
const llm = {
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: '["add function","mul function"]' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const ctx = { get: (name) => (name === 'subagents' ? subagents : undefined), llm }
const exec = { agent: { id: 'l1' }, signal: undefined }

try {
  const r = createStore(cfg, { root: join(tmp, 'proj-a'), restore: false })
  r.store.locked = true
  r.store.runId = 'run-test'
  r.store.run = { id: 'run-test', status: 'active', paused: false, startedAt: new Date().toISOString(), milestones: [], tokensUsed: 0, filesTouched: [], counters: { l2Spawns: 0, l2Sends: 0, l3Calls: 0 } }
  r.store.requirement = 'build a tiny calculator module'
  r.saveRun()

  const plan = makePlanTool(ctx, cfg, r)
  const accept = makeAcceptMilestoneTool(ctx, cfg, r)

  section('plan preserves finished work')
  await plan.execute({ taskPlan: { tasks: [{ id: 't1', desc: 'add', acceptance: 'add(1,2)==3' }], milestones: [{ id: 'm1', name: 'M', taskIds: ['t1'] }] } })
  r.store.tasks.get('t1').state = 'done'
  let threw = false
  try {
    await plan.execute({ taskPlan: { tasks: [{ id: 't1', desc: 'add', acceptance: 'add(1,2)==3' }], milestones: [{ id: 'm1', name: 'M', taskIds: ['t1'] }] } })
  } catch { threw = true }
  check('re-plan over a done-unaccepted milestone is refused', threw)
  await plan.execute({ taskPlan: { tasks: [{ id: 't1', desc: 'add', acceptance: 'add(1,2)==3' }], milestones: [{ id: 'm1', name: 'M', taskIds: ['t1'] }] }, reset: true })
  check('done task state survives re-plan', r.store.tasks.get('t1').state === 'done')
  check('milestone is still pending until accepted', r.store.run.milestones[0].state === 'pending')

  section('acceptance needs the user')
  threw = false
  try { await accept.execute({ milestoneId: 'm1' }) } catch { threw = true }
  check('accept without userConfirmed is refused', threw)
  const accepted = await accept.execute({ milestoneId: 'm1', userConfirmed: true })
  check('accept with userConfirmed succeeds', accepted.ok === true && r.store.run.milestones[0].state === 'accepted')
  await plan.execute({ taskPlan: { tasks: [{ id: 't1', desc: 'add', acceptance: 'add(1,2)==3' }], milestones: [{ id: 'm1', name: 'M', taskIds: ['t1'] }] } })
  check('accepted milestone is carried across re-plan', r.store.run.milestones[0].state === 'accepted')

  section('drain failure is reported')
  r.store.agents.set('c9', { id: 'c9', kind: 'l2', state: 'in_progress' })
  const drain = makeDrainLeadsTool(ctx, cfg, r)
  failDrain = true
  const bad = await drain.execute({ childIds: ['c9'] }, exec)
  check('failed drain returns ok:false', bad.ok === false && typeof bad.error === 'string')
  check('failed drain marks the agent failed', r.store.agents.get('c9').state === 'failed')
  failDrain = false
  r.store.agents.get('c9').state = 'in_progress'
  const good = await drain.execute({ childIds: ['c9'] }, exec)
  check('successful drain returns ok:true', good.ok === true && good.drained.includes('c9'))
  check('successful drain marks the agent done', r.store.agents.get('c9').state === 'done')

  section('re-dispatch is bounded')
  const spawn = makeSpawnModuleLeadTool(ctx, cfg, r)
  await spawn.execute({ name: 'mod-a', description: 'a', prompt: 'do a' }, exec)
  await spawn.execute({ name: 'mod-a', description: 'a', prompt: 'do a' }, exec)
  threw = false
  try { await spawn.execute({ name: 'mod-a', description: 'a', prompt: 'do a' }, exec) } catch { threw = true }
  check('third spawn of the same module is refused', threw)

  section('counters survive a cold start')
  r.store.counters.l2Spawns = 7
  r.snapshotBoard()
  const cold = createStore(cfg, { root: join(tmp, 'proj-a') })
  check('counters restored from board.json', cold.store.counters.l2Spawns === 7)

  section('L2 decomposition is counted')
  r.store.tasks.set('t2', { id: 't2', desc: 'calc', acceptance: 'add(1,2)==3', assignee: 'x', depends_on: [], state: 'pending', subtaskIds: [] })
  const before = r.store.run.tokensUsed
  const decompose = makeDecomposeTool(ctx, cfg, r)
  const dec = await decompose.execute({ taskId: 't2' }, exec)
  check('decompose uses the LLM path', dec.via === 'llm' && dec.subtasks.length === 2)
  check('decomposition tokens are recorded', r.store.run.tokensUsed > before)
  check('decomposition counter is incremented', r.store.counters.l2Decompose === 1)

  section('takeover files count toward maxFilesPerRun')
  r.store.subtasks.set('s1', { id: 's1', parent: 't1', desc: 'x', acceptance: 'x', state: 'pending', code: null, status: null, failCount: 0 })
  const file = join(tmp, 'proj-a', 'out.js')
  writeFileSync(file, 'function add(a, b) { return a + b }\n')
  const register = makeRegisterOutputTool(ctx, cfg, r)
  // v111 (B3): tool-supplied paths must be workspace-relative.
  await register.execute({ subtaskId: 's1', filePath: 'out.js' }, exec)
  check('register_output records the file', r.store.run.filesTouched.some((f) => f.endsWith('out.js')))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

// v112 — audit P1/P2 fixes:
//   * B9  estimateTokens is CJK-aware (no more chars/4 under-counting Chinese);
//   * B10 measureLevel1Context prefers tokenMeter.measure() (live request pressure);
//   * B2  the config typo no longer hides level3MaxOutputTokens from validation;
//   * B5  allowLevel1Takeover is the explicit L1-takeover exception in the guard;
//   * B6  the run footer travels on the result value (no shared mutable variable);
//   * B11 restore replays the trace tail into store.messages;
//   * B15 selftest separates "ran" (ok) from "ready" (core services present);
//   * O3  pipeline_plan echoes a routing skeleton, not every full task text;
//   * O4  buildProtocolText is short; buildProtocolOffText exists for mode=off;
//   * O7/B14 pipeline_status separates tracked / measured / budget tokens;
//   * O8  mode=off registers only the diagnostic tool subset;
//   * O10 board.json is compact JSON.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const load = (p) => import(pathToFileURL(join(repoRoot, 'plugin/lib', p)).href)
const { estimateTokens, numCfg } = await load('util.js')
const { validateConfigValue, CONFIG_KEYS, DEFAULT_CONFIG } = await load('config.js')
const { withRunFooter, setResultFooter, strictAdjacencyDenial } = await load('guards.js')
const { buildProtocolText, buildProtocolOffText } = await load('prompts.js')
const { createStore } = await load('store.js')
const { makePlanTool, makeStatusTool, makeSelftestTool } = await load('tools/l1.js')
const plugin = await load('plugin.js')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v112-'))
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
function section(t) {
  console.log(`\n${t}`)
}

const cfg = {
  devDir: 'dev',
  mode: 'auto',
  allowLevel1Takeover: false,
  maxCodeLines: 100,
  semanticGateThreshold: 0.7,
  allowCodeExecution: true,
  maxLevel3Retries: 5,
  maxLevel2Retries: 3,
  maxLevel2Agents: 5,
  level2Provider: 'test-provider',
  level2Model: 'test-model',
  level2ContextBudget: 32000,
  level3Model: 'test-l3',
  level3Provider: 'ninfer-local',
  spawnProvider: 'spawn',
  level3Endpoint: '',
  maxTotalTokensPerRun: 1000000,
  maxDurationPerRun: 7200000,
  maxFilesPerRun: 100,
  level1ContextBudget: 64000,
  level1ContextWarnRatio: 0.8,
}

function baseStore(root) {
  const r = createStore(cfg, { root, restore: false })
  r.store.locked = true
  r.store.runId = 'run-v112'
  r.store.run = {
    id: 'run-v112',
    status: 'active',
    paused: false,
    startedAt: new Date().toISOString(),
    milestones: [],
    tokensUsed: 0,
    filesTouched: [],
  }
  r.store.requirement = 'build a tiny calc module'
  r.saveRun()
  return r
}

try {
  section('B9 — CJK-aware token estimate')
  const cjk = estimateTokens('中文字符测试内容八个字')
  const ascii = estimateTokens('abcdefgh')
  check('CJK estimate is above length/4', cjk > Math.ceil(8 / 4), `cjk=${cjk}`)
  check('same-length ASCII estimate is smaller', ascii < cjk, `ascii=${ascii} cjk=${cjk}`)
  check('estimate is at least 1', estimateTokens('') === 1)

  section('B2 — config validation typo fixed')
  let threw = false
  try {
    validateConfigValue('level3MaxOutputTokens', 0)
  } catch {
    threw = true
  }
  check('level3MaxOutputTokens 0 is rejected', threw)
  check('allowLevel1Takeover is a documented key', !!CONFIG_KEYS.allowLevel1Takeover)
  check('allowLevel1Takeover defaults to false', DEFAULT_CONFIG.allowLevel1Takeover === false)
  check('maxLevel3Retries fallback is 5', numCfg({}, 'maxLevel3Retries', 5) === 5)

  section('O4 — protocol text is short, mode-off text exists')
  const proto = buildProtocolText(cfg)
  check('protocol text < 1200 chars', proto.length < 1200, `len=${proto.length}`)
  check('protocol still names the L2/L3 boundary', /pipeline_spawn_module_lead/.test(proto))
  check('off text names mode=off', /mode=off/.test(buildProtocolOffText()))

  section('B5 — L1 takeover exception is explicit')
  const reviewExec = { name: 'pipeline_review' }
  check('review denied for L1 by default', !!strictAdjacencyDenial('l1', null, reviewExec))
  check('review allowed for L1 with allowLevel1Takeover', strictAdjacencyDenial('l1', null, reviewExec, { allowLevel1Takeover: true }) === undefined)
  check(
    'execute_local still denied with takeover on',
    !!strictAdjacencyDenial('l1', null, { name: 'pipeline_execute_local' }, { allowLevel1Takeover: true }),
  )
  check('takeover does not apply to execute tools', !!strictAdjacencyDenial('l2', null, { name: 'pipeline_spawn_module_lead' }, { allowLevel1Takeover: true }))
  check('L2 review stays allowed (no L1-only rule)', strictAdjacencyDenial('l2', null, reviewExec, { allowLevel1Takeover: true }) === undefined)

  section('B6 — footer stays off the result value (WeakMap keyed by the value)')
  const value = { ok: true }
  setResultFooter(value, '\n「流水线」test-footer')
  const tool = withRunFooter({ name: 'pipeline_status', output: { render: () => [{ type: 'text', text: 'body' }] } })
  const rendered = tool.output.render({}, value, {})
  check('render appends the footer', Array.isArray(rendered) && rendered.at(-1).text.endsWith('test-footer'))
  check(
    'result value stays plain JSON (host validates it)',
    Object.keys(value).length === 1 && !('__pipelineFooter' in value) && JSON.stringify(value) === '{"ok":true}',
  )
  const plain = withRunFooter({ name: 'pipeline_status', output: { render: () => [{ type: 'text', text: 'body' }] } })
  check('no footer when the value has none', plain.output.render({}, { ok: true }, {})[0].text === 'body')

  section('O3 — plan echoes a routing skeleton')
  const root = join(tmp, 'proj')
  const r = baseStore(root)
  const plan = makePlanTool({ get: () => undefined }, cfg, r)
  const longDesc = 'implement the calculator core with add/mul/sub and a tiny CLI wrapper around it'
  const planned = await plan.execute({
    taskPlan: {
      tasks: [
        { id: 't1', desc: longDesc, acceptance: 'add(1, 2) === 3', assignee: 'calc' },
        { id: 't2', desc: 'mul', acceptance: 'mul(2, 3) === 6', assignee: 'calc' },
      ],
      milestones: [{ id: 'm1', name: 'core', taskIds: ['t1', 't2'] }],
    },
  })
  check('lean plan omits acceptance', planned.tasks[0].acceptance === undefined)
  const verbosePlan = await plan.execute({
    taskPlan: { tasks: [{ id: 't1', desc: longDesc, acceptance: 'add(1, 2) === 3', assignee: 'calc' }] },
    verbose: true,
  })
  check('verbose plan keeps acceptance', verbosePlan.tasks[0].acceptance === 'add(1, 2) === 3')
  check('lean plan caps desc', planned.tasks[0].desc.length <= 81, `len=${planned.tasks[0].desc.length}`)

  section('O7/B14 — status separates tracked / measured tokens')
  const seen = new Set()
  const session = { id: 'l2-a', requestHeader: () => ({ version: 1 }) }
  const meterCtx = {
    get: (n) => {
      if (n === 'tokenMeter') {
        return {
          measure: () => ({ totalTokens: 1234, surfaceTokens: 9999 }),
          estimateMessage: () => 10,
        }
      }
      if (n === 'sessions') return { get: (id) => (id === 'l2-a' || id === 'l1' ? session : undefined) }
      return undefined
    },
  }
  r.store.agents.set('l2-a', {
    id: 'l2-a', kind: 'l2', label: 'calc', state: 'in_progress', estimatedTokens: 100,
  })
  r.store.counters.measuredTokens = 0
  const status = makeStatusTool(meterCtx, cfg, r)
  const st = await status.execute({}, { agent: { id: 'l1' } })
  check('status reports trackedTokens', typeof st.trackedTokens === 'number')
  check('status reports measuredTokens from the meter', st.measuredTokens === 1234, `got ${st.measuredTokens}`)
  check('status reports the budget number', typeof st.tokensUsed === 'number')
  check('agent carries measured tokens', st.agents[0].tokens === 1234)
  check('level1Context is sourced from the meter', st.level1Context?.source === 'tokenMeter.measure')
  check('status has no verbose payload everywhere (compact)', !JSON.stringify(st).includes('100000'))

  section('B15 — selftest separates ok from ready')
  const selftestCtx = {
    get: (n) => {
      if (n === 'subagents') return { startActivation() {}, sendMessage() {}, drainChildren() {} }
      if (n === 'llm') return { stream() {} }
      return undefined
    },
  }
  const selftest = makeSelftestTool
    ? await makeSelftestTool(selftestCtx, cfg, r).execute({})
    : null
  if (selftest) {
    check('ok is true when the check ran', selftest.ok === true)
    check('ready is false with no L3 engine', selftest.ready === false)
    check('degraded names the L3 engine', selftest.degraded.includes('L3 engine'))
  } else {
    check('makeSelftestTool is exported from l2l3 (fallback)', false)
  }

  section('B11/O10 — compact board.json and trace replay on restore')
  r.record('level1_main', 'in_progress', 'task_assignment', 'calc', 't1', 'add', null, 'add(1, 2) === 3')
  const boardRaw = readFileSync(join(root, '.dsh', 'pipeline', 'board.json'), 'utf8')
  check('board.json is compact JSON', !boardRaw.includes('\n'), `len=${boardRaw.length}`)
  const r2 = createStore(cfg, { root, restore: true })
  check('restore replays trace messages', r2.store.messages.length >= 1 && r2.store.messages.at(-1).sender === 'level1_main')

  section('O8 — mode=off registers only the diagnostic subset')
  const offCfg = { ...cfg, mode: 'off' }
  check('mode=off keeps status', plugin.shouldRegisterTool('pipeline_status', offCfg) === true)
  check('mode=off keeps scan/recall', plugin.shouldRegisterTool('pipeline_scan', offCfg) && plugin.shouldRegisterTool('pipeline_recall', offCfg))
  check('mode=off drops spawn_module_lead', plugin.shouldRegisterTool('pipeline_spawn_module_lead', offCfg) === false)
  check('mode=off drops execute_local', plugin.shouldRegisterTool('pipeline_execute_local', offCfg) === false)
  check('mode=off keeps 6 of 19 tools', plugin.OFF_MODE_TOOLS.size === 6)
  const registered = []
  const sections = []
  const fakeCtx = {
    get: () => undefined,
    tools: { register: (t) => registered.push(t.name), guard: () => {} },
    commands: { register: () => {} },
    systemPrompt: { section: (s) => sections.push(s) },
    skills: { register: () => {} },
  }
  plugin.apply(fakeCtx, { ...cfg, mode: 'auto' })
  const fullNames = [...registered]
  check('mode=auto registers 19 tools', fullNames.length === 19, `${fullNames.length}`)
  check('mode=auto registers spawn_module_lead', fullNames.includes('pipeline_spawn_module_lead'))
  check('mode=auto registers the full protocol section', sections.length === 1 && /pipeline_spawn_module_lead/.test(sections[0].text))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

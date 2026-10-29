// v111 — audit P0 fixes:
//   * B3  path confinement: tool-supplied paths may not be absolute or escape the workspace;
//   * B4  pipeline_decompose gives every subtask its OWN acceptance (module acceptance is fallback);
//   * B7/O6 execute writes the file to disk and returns path/lines/sha8 instead of the code, and
//     pipeline_review gates the real file (missing file = gate failure);
//   * O1/B1 pipeline_status returns a compact projection (agents carry no code, recentMessages capped);
//   * O2  pipeline_checkpoint returns metadata, not the 18K-character document (verbose:true keeps it).
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const { createStore } = await import(pathToFileURL(join(repoRoot, 'plugin/lib/store.js')).href)
const { makePlanTool, makeStatusTool, makeCheckpointTool } = await import(pathToFileURL(join(repoRoot, 'plugin/lib/tools/l1.js')).href)
const { makeDecomposeTool, makeExecuteLocalTool, makeReviewTool, makeRegisterOutputTool } = await import(
  pathToFileURL(join(repoRoot, 'plugin/lib/tools/l2l3.js')).href
)

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v111-'))
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

// LLM that yields a fixed JSON payload for pipeline_decompose.
function llmCtx(payload) {
  return {
    get: () => undefined,
    llm: {
      stream() {
        return (async function* () {
          yield { type: 'text-delta', text: JSON.stringify(payload) }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
}
const ctx = { get: () => undefined }
const exec = { agent: { id: 'l1' }, signal: undefined }

// L3 endpoint stub: echoes the requested subtask id back with fixed code.
const ADD_CODE = 'function add(a, b) {\n  return a + b\n}\n'
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body)
  const prompt = body.messages[0].content
  const id = (/"subtask_id":\s*"([^"]+)"/.exec(prompt) ?? [])[1] ?? 'inline'
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ subtask_id: id, code: ADD_CODE, status: 'done' }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }),
  }
}

try {
  const root = join(tmp, 'proj')
  const r = createStore(cfg, { root, restore: false })
  r.store.locked = true
  r.store.runId = 'run-v111'
  r.store.run = {
    id: 'run-v111',
    status: 'active',
    paused: false,
    startedAt: new Date().toISOString(),
    milestones: [],
    tokensUsed: 0,
    filesTouched: [],
    counters: { l2Spawns: 0, l2Sends: 0, l3Calls: 0 },
  }
  r.store.requirement = 'build a tiny add module'
  r.saveRun()

  const plan = makePlanTool(ctx, cfg, r)
  await plan.execute({
    taskPlan: {
      tasks: [
        { id: 't1', desc: 'add', acceptance: 'add(1, 2) === 3', assignee: 'calc' },
        { id: 't2', desc: 'mul', acceptance: 'mul(2, 3) === 6', assignee: 'calc' },
        { id: 't3', desc: 'sub', acceptance: 'sub(3, 1) === 2', assignee: 'calc' },
      ],
    },
  })

  section('B4 — per-subtask acceptance from pipeline_decompose')
  const dec = makeDecomposeTool(llmCtx([{ desc: 'write add()', acceptance: 'add(1, 2) === 3' }]), cfg, r)
  const d1 = await dec.execute({ taskId: 't1' }, exec)
  check('subtask created', d1.ok && d1.subtasks.length === 1)
  check('acceptance comes from the L2 output, not the module', r.store.subtasks.get('t1-s1').acceptance === 'add(1, 2) === 3')
  check('decompose echoes the per-subtask acceptance', d1.subtasks[0].acceptance === 'add(1, 2) === 3')
  const decStr = makeDecomposeTool(llmCtx(['write mul()']), cfg, r)
  await decStr.execute({ taskId: 't2' }, exec)
  check('string payload falls back to module acceptance', r.store.subtasks.get('t2-s1').acceptance === 'mul(2, 3) === 6')
  const decFail = makeDecomposeTool({ get: () => undefined, llm: null }, cfg, r)
  const d3 = await decFail.execute({ taskId: 't3' }, exec)
  check('LLM failure reports why it fell back', d3.via === 'deterministic' && typeof d3.fallbackReason === 'string')

  section('B3 — paths are confined to the workspace')
  const reg = makeRegisterOutputTool(ctx, cfg, r)
  let threw = false
  try {
    reg.execute({ subtaskId: 't2-s1', filePath: join(tmp, 'outside.js') })
  } catch (err) {
    threw = /absolute path not allowed/.test(String(err?.message))
  }
  check('register_output refuses an absolute path', threw)
  threw = false
  try {
    reg.execute({ subtaskId: 't2-s1', filePath: '..\\escape.js' })
  } catch (err) {
    threw = /escapes the workspace/.test(String(err?.message))
  }
  check('register_output refuses a .. escape', threw)
  // Review validates the path after the state check; force the state so the
  // assertion is about confinement, not about the lifecycle.
  r.store.subtasks.get('t2-s1').state = 'review'
  const review0 = makeReviewTool(ctx, cfg, r)
  threw = false
  try {
    await review0.execute({ subtaskId: 't2-s1', filePath: join(tmp, 'outside.js') })
  } catch (err) {
    threw = /absolute path not allowed/.test(String(err?.message))
  }
  check('review refuses an absolute filePath', threw)

  section('B7/O6 — execute writes the file, review gates the file on disk')
  const local = makeExecuteLocalTool(ctx, cfg, r)
  const ex = await local.execute({ subtaskId: 't1-s1', filePath: 'src/add.js' }, exec)
  const addPath = join(root, 'src', 'add.js')
  check('file written to the workspace', existsSync(addPath))
  check('result carries path/lines/sha8, not the code', ex.ok && ex.path === 'src/add.js' && ex.code === undefined && typeof ex.sha8 === 'string', JSON.stringify(Object.keys(ex)))
  check('board keeps the relative path', r.store.subtasks.get('t1-s1').filePath === 'src/add.js')
  check('written bytes match the generated code', readFileSync(addPath, 'utf8') === ADD_CODE)
  const review = makeReviewTool(ctx, cfg, r)
  const rv = await review.execute({ subtaskId: 't1-s1' }, exec)
  check('review gates the real file', rv.ok === true && rv.state === 'done', JSON.stringify(rv.checks))
  check('review adds a file-on-disk check', rv.checks.some((c) => c.name === 'file-on-disk' && c.pass))

  section('B7 — a missing deliverable fails the gate')
  const dec3 = makeDecomposeTool(llmCtx([{ desc: 'write sub()', acceptance: 'sub(3, 1) === 2' }]), cfg, r)
  await dec3.execute({ taskId: 't3' }, exec)
  const ex2 = await local.execute({ subtaskId: 't3-s1', filePath: 'src/sub.js' }, exec)
  check('second file written', ex2.ok && existsSync(join(root, 'src', 'sub.js')))
  rmSync(join(root, 'src', 'sub.js'), { force: true })
  const rv2 = await review.execute({ subtaskId: 't3-s1' }, exec)
  check('missing file is a gate failure', rv2.ok === false)
  check('gate names the missing file', rv2.checks.some((c) => c.name.startsWith('file-on-disk') && c.pass === false))

  section('O1/B1 — status is a compact projection')
  r.store.tasks.get('t1').desc = 'd'.repeat(800)
  r.record('level3_local', 'review', 'task_result', 'level1_main', 't1-s1', 'L'.repeat(500), 'C'.repeat(500), 'A'.repeat(500))
  r.store.agents.set('l2-a', { id: 'l2-a', kind: 'l2', label: 'calc', desc: 'D'.repeat(1200), state: 'in_progress', model: 'deepseek-flash' })
  r.store.agents.set('l3-a', { id: 'l3-a', kind: 'l3', label: 'level3-executor', desc: 'E'.repeat(800), state: 'done', code: 'X'.repeat(3000), status: 'done' })
  const status = makeStatusTool(ctx, cfg, r)
  const st = await status.execute({}, exec)
  const stJson = JSON.stringify(st)
  check(`status payload stays compact (${stJson.length} chars)`, stJson.length < 3000, `${stJson.length} chars`)
  check('agents are projected (no code field)', st.agents.every((a) => !('code' in a)))
  check('agent desc is capped', st.agents.every((a) => String(a.desc ?? '').length <= 81))
  check('task desc is capped', st.tasks[0].desc.length <= 61)
  const lastMsg = st.recentMessages[st.recentMessages.length - 1]
  check('recentMessages are projected to a capped note', String(lastMsg.note).length <= 140 && lastMsg.task_desc === undefined)
  const stv = await status.execute({ verbose: true }, exec)
  check('verbose restores the full task text', stv.tasks[0].desc.length === 800)

  section('O2 — checkpoint returns metadata')
  const cp = makeCheckpointTool(ctx, cfg, r)
  const co = await cp.execute({ done: 'src/add.js' }, exec)
  check('checkpoint file written', existsSync(co.path) && co.path.endsWith('project_checkpoint.md'))
  check('return has path/bytes/lines', typeof co.bytes === 'number' && co.bytes > 0 && co.lines > 10)
  check('document is NOT echoed by default', co.content === undefined)
  check('coldStartPrompt is still returned', typeof co.coldStartPrompt === 'string' && /冷启动/.test(co.coldStartPrompt))
  const cov = await cp.execute({ done: 'src/add.js', verbose: true }, exec)
  check('verbose restores the full document', typeof cov.content === 'string' && cov.content.includes('## 1. 需求'))
} catch (err) {
  failed += 1
  console.log(`  ✗ fatal: ${err && err.stack ? err.stack : err}`)
} finally {
  globalThis.fetch = realFetch
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\nv111 smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

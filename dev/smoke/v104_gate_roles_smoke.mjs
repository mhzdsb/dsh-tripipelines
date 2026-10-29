// v104 — quality gate fail-closed + explicit role matrix.
//
// v103 and earlier accepted a "semantic score" fallback whenever the Python
// assertion runner failed, checked a tautological `isPlainObj({code})`, matched
// a fabricated subtask_id against itself, and allowed 3/4 assertions to pass.
// This suite pins the new contract:
//   * assertions run for Python AND JavaScript;
//   * every assertion must pass;
//   * no runner / blocked code / syntax error = FAIL (never keyword fallback);
//   * model-written code cannot import, eval, spawn processes or touch the net;
//   * only L1 advances the graph; L1 never executes L2/L3 tools.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const { executeAcceptance, gateSubtask, gateTask, extractAssertions } = await import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib/gates.js')).href)
const { strictAdjacencyDenial } = await import(pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib/guards.js')).href)

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v104-'))
let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
function section(t) { console.log(`\n${t}`) }

const cfg = {
  maxCodeLines: 100,
  semanticGateThreshold: 0.7,
  allowCodeExecution: true,
  acceptanceLanguage: 'auto',
}
const baseDir = join(tmp, 'state')

try {
  section('assertion parsing')
  const a = extractAssertions('add(2,3)==5 and mul(2,3)===6')
  check('parses == and ===', a.length === 2 && a[0].op === '==' && a[1].op === '===', JSON.stringify(a))
  check('no assertion -> null runner', executeAcceptance('x', 'looks nice', baseDir, cfg) === null)

  section('JavaScript runner')
  const jsPass = executeAcceptance('function add(a, b) { return a + b }', 'add(2,3)===5', baseDir, cfg)
  check('JS pass runs', jsPass && jsPass.ran === true && jsPass.language === 'javascript', JSON.stringify(jsPass))
  check('JS pass is 1/1', jsPass && jsPass.passed === 1 && jsPass.total === 1)
  const jsFail = executeAcceptance('function add(a, b) { return a - b }', 'add(2,3)===5', baseDir, cfg)
  check('JS wrong result is 0/1', jsFail && jsFail.ran === true && jsFail.passed === 0)
  const jsBlocked = executeAcceptance("const fs = require('fs')\nfunction add(a,b){return a+b}", 'add(2,3)===5', baseDir, cfg)
  check('JS require is blocked', jsBlocked && jsBlocked.ran === false && jsBlocked.reason === 'unsafe-code', JSON.stringify(jsBlocked))

  section('Python runner')
  const pyPass = executeAcceptance('def add(a, b):\n    return a + b', 'add(2,3)==5', baseDir, cfg)
  check('Python pass runs', pyPass && pyPass.ran === true && pyPass.language === 'python', JSON.stringify(pyPass))
  check('Python pass is 1/1', pyPass && pyPass.passed === 1 && pyPass.total === 1)
  const pyFail = executeAcceptance('def add(a, b):\n    return a - b', 'add(2,3)==5', baseDir, cfg)
  check('Python wrong result is 0/1', pyFail && pyFail.ran === true && pyFail.passed === 0)
  const pyBlocked = executeAcceptance('import os\nos.system("echo pwned")\ndef add(a,b):\n    return a+b', 'add(2,3)==5', baseDir, cfg)
  check('Python import/os.system is blocked', pyBlocked && pyBlocked.ran === false, JSON.stringify(pyBlocked))
  const pySyntax = executeAcceptance('def broken(', 'x(1)==1', baseDir, cfg)
  check('Python syntax error fails closed', pySyntax && pySyntax.ran === false)

  section('execution switch')
  const disabled = executeAcceptance('function add(a,b){return a+b}', 'add(2,3)===5', baseDir, { ...cfg, allowCodeExecution: false })
  check('allowCodeExecution=false refuses to run', disabled && disabled.ran === false && disabled.reason === 'execution-disabled', JSON.stringify(disabled))

  section('subtask gate')
  const good = gateSubtask({ subtask_id: 's1', code: 'function add(a,b){return a+b}', status: 'done' }, 's1', 'add(2,3)===5', cfg, baseDir)
  check('gate accepts correct JS', good.ok === true, JSON.stringify(good.checks))
  check('gate requires every assertion', good.checks.some((c) => /execution-assertions 1\/1/.test(c.name)))
  const badId = gateSubtask({ subtask_id: 's2', code: 'function add(a,b){return a+b}', status: 'done' }, 's1', 'add(2,3)===5', cfg, baseDir)
  check('gate rejects a mismatched subtask_id', badId.ok === false)
  const partial = gateSubtask(
    { subtask_id: 's3', code: 'function add(a,b){return a+b}', status: 'done' },
    's3',
    'add(2,3)===5; add(1,1)===2',
    cfg,
    baseDir,
  )
  check('2/2 assertions required to pass', partial.ok === true, JSON.stringify(partial.checks))
  const partial2 = gateSubtask(
    { subtask_id: 's4', code: 'function add(a,b){return a-b}', status: 'done' },
    's4',
    'add(2,3)===5; add(1,1)===2',
    cfg,
    baseDir,
  )
  check('0/2 assertions fail the gate', partial2.ok === false)
  const blockedGate = gateSubtask(
    { subtask_id: 's5', code: 'import os\nos.system("x")\ndef add(a,b):\n    return a+b', status: 'done' },
    's5',
    'add(2,3)==5',
    cfg,
    baseDir,
  )
  check('blocked code fails closed (no semantic rescue)', blockedGate.ok === false)
  const noAssert = gateSubtask({ subtask_id: 's6', code: 'function add(a,b){return a+b}', status: 'done' }, 's6', 'looks nice', cfg, baseDir)
  check('no-assertion acceptance still uses the semantic score', noAssert.checks.some((c) => /semantic-score/.test(c.name)), JSON.stringify(noAssert.checks))
  check('semantic fallback is capped below the default gate', noAssert.ok === false && Number(noAssert.score) <= 0.5, `${noAssert.score}`)

  section('task gate')
  const task = { id: 't1', acceptance: 'add(2,3)===5' }
  const taskOk = gateTask(task, [{ state: 'done', code: 'function add(a,b){return a+b}' }], cfg, null, baseDir)
  check('task gate runs assertions on concatenated code', taskOk.ok === true, JSON.stringify(taskOk.checks))
  const taskEmpty = gateTask(task, [], cfg, null, baseDir)
  check('task gate refuses an empty subtask list', taskEmpty.ok === false)
  const taskWrong = gateTask(task, [{ state: 'done', code: 'function add(a,b){return a-b}' }], cfg, null, baseDir)
  check('task gate rejects wrong code', taskWrong.ok === false)
  const taskSemantic = gateTask({ id: 't2', acceptance: 'looks nice' }, [{ state: 'done', code: 'function add(a,b){return a+b}' }], cfg, null, baseDir)
  check('task gate falls back to semantic only without assertions', taskSemantic.checks.some((c) => /semantic-score/.test(c.name)))

  section('role matrix (guards)')
  const deny = (tier, name) => strictAdjacencyDenial(tier, null, { name })
  check('L1 may spawn', deny('l1', 'pipeline_spawn_module_lead') === undefined)
  check('L1 may send', deny('l1', 'pipeline_send_to_lead') === undefined)
  check('L2 may decompose', deny('l2', 'pipeline_decompose') === undefined)
  check('L2 may execute local', deny('l2', 'pipeline_execute_local') === undefined)
  check('L2 may not spawn L2', typeof deny('l2', 'pipeline_spawn_module_lead') === 'string')
  check('L2 may not call status', typeof deny('l2', 'pipeline_status') === 'string')
  check('L1 may not execute local', typeof deny('l1', 'pipeline_execute_local') === 'string')
  check('L1 may not decompose', typeof deny('l1', 'pipeline_decompose') === 'string')
  check('unknown may not advance', typeof deny('unknown', 'pipeline_spawn_module_lead') === 'string')
  check('unknown may not call status', typeof deny('unknown', 'pipeline_status') === 'string')
} catch (err) {
  failed += 1
  console.log(`  ✗ fatal: ${err && err.stack ? err.stack : err}`)
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

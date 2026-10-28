// dsh-pipeline — deterministic quality gates: execution-first assertions (Python
// subprocess), JSON/DoD checks and the semantic fallback score.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isPlainObj, RESULT_STATUS_OK, normalizeStatus, semanticScore } from './util.js'
import { runtimeStateDir } from './store.js'

// ---------------------------------------------------------------------------
// Quality gates (DoD + JSON + semantic) — deterministic, mechanically checkable
// ---------------------------------------------------------------------------

// Drain replaced old L2s whose handoff TTL has expired. This is a lazy safety net: the primary
// path is pipeline_drain_leads (explicit), but if L1 forgets or the verification stalls, the next
// spawn reaps expired old L2s so they do not linger forever (no background timer, no token cost).
export function cleanupExpiredL2s(subs, agent, r, cfg) {
  if (!subs || typeof subs.drainChildren !== 'function') return
  const ttl = Number(cfg.level2HandoffTtlMs) > 0 ? Number(cfg.level2HandoffTtlMs) : 300000
  const now = Date.now()
  const expired = []
  for (const [id, a] of r.store.agents) {
    if (a.kind === 'l2' && a.state === 'replaced' && a.replacedAt && now - a.replacedAt > ttl) expired.push(id)
  }
  if (expired.length === 0) return
  try { subs.drainChildren(agent, expired) } catch { /* best-effort */ }
  for (const id of expired) {
    const a = r.store.agents.get(id)
    if (a) a.state = 'done'
  }
}

// Execute the code and run the assertions extracted from the acceptance criteria
// (e.g. "add(2,3)==5"). Returns null when no assertion is present (caller falls
// back to the semantic keyword score). Uses a Python subprocess with result file
// (no piped stdout, so it works under the DSH sandbox).
export function executeAcceptance(code, acceptance) {
  const assertionRe = /([A-Za-z_]\w*)\s*\(\s*([^)]*)\s*\)\s*==\s*([^\s,;]+)/g
  const assertions = []
  let m
  while ((m = assertionRe.exec(String(acceptance ?? ''))) !== null) {
    assertions.push({ name: m[1], args: m[2], expected: m[3] })
  }
  if (assertions.length === 0) return null

  // v89 — per-call scratch dir: concurrent L3 reviews no longer overwrite each other.
  const dir = join(runtimeStateDir(), 'exec', randomUUID())
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  const testFile = join(dir, 'test.py')
  const resultFile = join(dir, 'result.json')
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  const harness = [
    'import json',
    `exec(${JSON.stringify(String(code))})`,
    `assertions = ${JSON.stringify(assertions)}`,
    'results = []',
    'for a in assertions:',
    '    call = a["name"] + "(" + a["args"] + ")"',
    '    try:',
    '        actual = eval(call)',
    '        expected = eval(a["expected"])',
    '        results.append({"call": call, "passed": actual == expected, "actual": repr(actual)})',
    '    except Exception as e:',
    '        results.append({"call": call, "passed": False, "actual": "error: " + str(e)})',
    `open(${JSON.stringify(resultFile)}, "w").write(json.dumps(results))`,
  ].join('\n')

  try {
    writeFileSync(testFile, harness, 'utf8')
    execFileSync('python', [testFile], { cwd: dir, stdio: 'ignore', timeout: 30000 })
  } catch {
    cleanup()
    return { ran: false, checks: [], assertions, passed: 0, total: assertions.length }
  }

  let results
  try {
    results = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch {
    cleanup()
    return { ran: false, checks: [], assertions, passed: 0, total: assertions.length }
  }

  const passed = results.filter((r) => r.passed).length
  const checks = results.map((r) => ({ name: `assert ${r.call}`, pass: r.passed, actual: r.actual }))
  cleanup()
  return { ran: true, checks, assertions, passed, total: results.length }
}

export function gateSubtask(result, expectedId, acceptance, cfg) {
  const checks = []
  let ok = true

  const jsonOk = isPlainObj(result)
  checks.push({ name: 'json-validity', pass: jsonOk })
  if (!jsonOk) ok = false

  const idOk = jsonOk && result.subtask_id === expectedId
  checks.push({ name: 'subtask-id-match', pass: idOk })
  if (!idOk) ok = false

  const codeOk = jsonOk && typeof result.code === 'string' && result.code.trim().length > 0
  checks.push({ name: 'non-empty-code', pass: codeOk })
  if (!codeOk) ok = false

  const lineOk = jsonOk && codeOk && String(result.code).split('\n').length <= cfg.maxCodeLines
  checks.push({ name: `code-lines<=${cfg.maxCodeLines}`, pass: lineOk })
  if (!lineOk) ok = false

  const statusOk = jsonOk && RESULT_STATUS_OK.includes(normalizeStatus(result.status))
  checks.push({ name: 'status-in-enum', pass: statusOk })
  if (!statusOk) ok = false

  // Execution-first quality: run the code assertions; fall back to the semantic
  // keyword score when no assertion is present (or Python is unavailable).
  let score
  if (codeOk) {
    const exec = executeAcceptance(result.code, acceptance)
    if (exec && exec.ran) {
      checks.push(...exec.checks)
      score = exec.total > 0 ? exec.passed / exec.total : 0
      const qOk = score >= cfg.semanticGateThreshold
      checks.push({ name: `execution-assertions>=${cfg.semanticGateThreshold}`, pass: qOk, score: Number(score.toFixed(3)) })
      if (!qOk) ok = false
    } else {
      score = semanticScore(result.code, acceptance)
      const semOk = score >= cfg.semanticGateThreshold
      checks.push({ name: `semantic-score>=${cfg.semanticGateThreshold}`, pass: semOk, score: Number(score.toFixed(3)) })
      if (!semOk) ok = false
    }
  } else {
    score = 0
  }

  return { ok, score: Number(score.toFixed(3)), checks }
}

export function gateTask(task, subtaskRecords, cfg, fileCode) {
  const checks = []
  let ok = true
  const allDone = subtaskRecords.every((s) => s.state === 'done')
  checks.push({ name: 'all-subtasks-done', pass: allDone })
  if (!allDone) ok = false

  // v93 — a real file on disk may stand in for the board code: when an L2 wrote
  // the module by hand (register_output / filePath review), the workspace file is
  // the source of truth, not the per-subtask board snippets.
  const fromDisk = String(fileCode ?? '')
  const code = fromDisk.trim().length > 0
    ? fromDisk
    : subtaskRecords.map((s) => s.code).filter(Boolean).join('\n\n')
  const jsonOk = isPlainObj({ code })
  checks.push({ name: 'module-code-present', pass: code.trim().length > 0 && jsonOk })
  if (code.trim().length === 0) ok = false

  const score = semanticScore(code, task.acceptance)
  const semOk = score >= cfg.semanticGateThreshold
  checks.push({ name: `semantic-score>=${cfg.semanticGateThreshold}`, pass: semOk, score: Number(score.toFixed(3)) })
  if (!semOk) ok = false

  return { ok, score: Number(score.toFixed(3)), checks }
}

// ---------------------------------------------------------------------------
// Plan / dependency validation
// ---------------------------------------------------------------------------

export function validateTaskPlan(taskPlan) {
  const tasks = Array.isArray(taskPlan) ? taskPlan : taskPlan?.tasks
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('taskPlan.tasks must be a non-empty array')
  }
  const seen = new Set()
  for (const t of tasks) {
    if (!isPlainObj(t)) throw new Error('each task must be an object')
    if (typeof t.id !== 'string' || !t.id.trim()) throw new Error('task.id must be a non-empty string')
    if (typeof t.desc !== 'string' || !t.desc.trim()) throw new Error(`task ${t.id}: desc must be a non-empty string`)
    if (t.assignee !== undefined && (typeof t.assignee !== 'string' || !t.assignee.trim())) {
      throw new Error(`task ${t.id}: assignee must be a non-empty string (L1 names each L2 freely, e.g. backend / frontend / database)`)
    }
    if (typeof t.acceptance !== 'string' || !t.acceptance.trim()) {
      throw new Error(`task ${t.id}: acceptance must be a non-empty, mechanically-checkable string`)
    }
    if (t.depends_on !== undefined && !Array.isArray(t.depends_on)) {
      throw new Error(`task ${t.id}: depends_on must be an array`)
    }
    if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`)
    seen.add(t.id)
  }
  // Dependency graph: no unknown refs, no cycles.
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks) {
    for (const d of t.depends_on ?? []) {
      if (!ids.has(d)) throw new Error(`task ${t.id}: unknown dependency ${d}`)
    }
  }
  const state = new Map(tasks.map((t) => [t.id, 0]))
  const adjacency = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]))
  function visit(id, stack) {
    if (state.get(id) === 1) throw new Error(`cycle detected at task ${id}`)
    if (state.get(id) === 2) return
    state.set(id, 1)
    for (const d of adjacency.get(id) ?? []) visit(d, stack)
    state.set(id, 2)
  }
  for (const t of tasks) visit(t.id)
  return tasks
}

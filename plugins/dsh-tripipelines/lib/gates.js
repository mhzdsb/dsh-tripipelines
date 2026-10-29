// dsh-tripipelines — deterministic quality gates: execution-first assertions (Python
// subprocess), JSON/DoD checks and the semantic fallback score.
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isPlainObj, RESULT_STATUS_OK, normalizeStatus, semanticScore } from './util.js'

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

// v104 — assertions may be written as `f(a)==v` (Python) or `f(a)===v`
// (JavaScript); nested calls are still out of scope by design (a check that
// cannot be parsed must not silently pass).
const ASSERTION_RE = /([A-Za-z_$][\w$]*)\s*\(\s*([^)]*)??\s*\)\s*(===|==)\s*([^\s,;]+)/g

export function extractAssertions(acceptance) {
  const source = String(acceptance ?? '')
  const out = []
  let m
  ASSERTION_RE.lastIndex = 0
  while ((m = ASSERTION_RE.exec(source)) !== null) {
    out.push({ name: m[1], args: m[2].trim(), expected: m[4], op: m[3] })
  }
  return out
}

// Only a rough language guess is needed: the guard below is conservative either
// way, and a wrong guess fails closed instead of falling back to keywords.
export function detectLanguage(code, acceptance, cfg) {
  const forced = String(cfg?.acceptanceLanguage ?? 'auto')
  if (forced === 'python' || forced === 'javascript') return forced
  const src = String(code ?? '')
  const crit = String(acceptance ?? '')
  if (crit.includes('===')) return 'javascript'
  if (/\bdef\s+\w+\s*\(/.test(src) || /^\s*(import|from)\s+\w+/m.test(src)) return 'python'
  if (/\bfunction\b|=>|^\s*(const|let|var)\s+\w+/m.test(src)) return 'javascript'
  return 'python'
}

const PY_BAD_MODULES = new Set([
  'os', 'sys', 'subprocess', 'socket', 'shutil', 'pathlib', 'ctypes', 'importlib',
  'builtins', 'requests', 'urllib', 'http', 'ftplib', 'telnetlib', 'multiprocessing',
  'threading', 'asyncio', 'pickle', 'marshal', 'pty', 'resource', 'signal', 'tempfile',
])
const PY_BAD_NAMES = new Set([
  'eval', 'exec', 'compile', 'open', '__import__', 'input', 'globals', 'locals',
  'getattr', 'setattr', 'delattr', 'vars', 'dir', 'breakpoint', 'help', 'memoryview',
])
const PY_BAD_ATTRS = new Set([
  'system', 'popen', 'spawn', 'spawnl', 'spawnv', 'fork', 'execv', 'execve', 'remove',
  'unlink', 'rmdir', 'rename', 'chmod', 'chown', 'kill', 'connect', 'send', 'sendall',
  'recv', 'read', 'write', 'open',
])

const PY_GUARD = [
  'import ast, sys',
  'src = open(sys.argv[1], encoding="utf-8").read()',
  'try:',
  '    tree = ast.parse(src)',
  'except SyntaxError as e:',
  '    print("syntax-error: %s" % e, file=sys.stderr)',
  '    sys.exit(2)',
  `bad_modules = ${JSON.stringify([...PY_BAD_MODULES].sort())}`,
  `bad_names = ${JSON.stringify([...PY_BAD_NAMES].sort())}`,
  `bad_attrs = ${JSON.stringify([...PY_BAD_ATTRS].sort())}`,
  'for node in ast.walk(tree):',
  '    if isinstance(node, (ast.Import, ast.ImportFrom)):',
  '        names = [a.name.split(".")[0] for a in node.names]',
  '        root = names[0] if names else ""',
  '        if isinstance(node, ast.ImportFrom) and node.module:',
  '            root = node.module.split(".")[0]',
  '        if root in bad_modules or isinstance(node, ast.Import):',
  '            print("blocked-import: %s" % root, file=sys.stderr)',
  '            sys.exit(3)',
  '    if isinstance(node, ast.Name) and node.id in bad_names:',
  '        print("blocked-name: %s" % node.id, file=sys.stderr)',
  '        sys.exit(3)',
  '    if isinstance(node, ast.Attribute) and node.attr in bad_attrs:',
  '        print("blocked-attr: %s" % node.attr, file=sys.stderr)',
  '        sys.exit(3)',
].join('\n')

const JS_BAD_PATTERNS = [
  [/\brequire\s*\(/, 'require'],
  [/\bimport\s+[^;]*\bfrom\b/, 'import-from'],
  [/\bimport\s*\(/, 'dynamic-import'],
  [/\bchild_process\b/, 'child_process'],
  [/\bprocess\s*\./, 'process'],
  [/\bglobalThis\b/, 'globalThis'],
  [/\bFunction\s*\(/, 'Function'],
  [/\beval\s*\(/, 'eval'],
  [/\bReflect\b/, 'Reflect'],
  [/\bfetch\s*\(/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bnode:[a-z]+/, 'node-builtin'],
  [/\bhttp[s]?\s*\./, 'http'],
  [/\.constructor\s*\(/, 'constructor'],
]

function staticSafetyError(code, language) {
  const src = String(code ?? '')
  if (language === 'javascript') {
    for (const [re, label] of JS_BAD_PATTERNS) {
      if (re.test(src)) return `blocked-js: ${label}`
    }
  }
  return null
}

// Execute the code and run the assertions extracted from the acceptance criteria
// (e.g. "add(2,3)==5"). Returns null when NO assertion is present (the caller
// may then use the keyword score). When assertions exist the runner is
// mandatory: no interpreter, a blocked program, a syntax error or a crash all
// return `ran:false` and the gate MUST fail — never fall back to keywords.
export function executeAcceptance(code, acceptance, baseDir, cfg) {
  const assertions = extractAssertions(acceptance)
  if (assertions.length === 0) return null
  if (!baseDir) throw new Error('executeAcceptance: baseDir is required（v118 不再回退到进程 cwd；调用方传 store.stateDir）。')
  if (cfg && cfg.allowCodeExecution === false) {
    return { ran: false, reason: 'execution-disabled', assertions, passed: 0, total: assertions.length }
  }
  const language = detectLanguage(code, acceptance, cfg)
  const unsafe = staticSafetyError(code, language)
  if (unsafe) {
    return { ran: false, reason: 'unsafe-code', error: unsafe, language, assertions, passed: 0, total: assertions.length }
  }

  // v89 — per-call scratch dir: concurrent L3 reviews no longer overwrite each other.
  // v103 — scratch lives under the calling WORKSPACE's state dir, not the daemon cwd.
  const dir = join(baseDir, 'exec', randomUUID())
  try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
  const resultFile = join(dir, 'result.json')
  const cleanup = () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  try {
    if (language === 'javascript') {
      const jsAssertions = assertions.map((a) => ({ call: `${a.name}(${a.args})`, expected: a.expected }))
      const harness = [
        "import { writeFileSync as __dsh_write } from 'node:fs'",
        String(code ?? ''),
        `const __dsh_assertions = ${JSON.stringify(jsAssertions)}`,
        'const __dsh_results = []',
        'for (const __dsh_a of __dsh_assertions) {',
        '  try {',
        '    const __dsh_actual = eval(__dsh_a.call)',
        '    const __dsh_expected = eval(__dsh_a.expected)',
        '    __dsh_results.push({ call: __dsh_a.call, passed: __dsh_actual === __dsh_expected, actual: String(__dsh_actual) })',
        '  } catch (e) {',
        '    __dsh_results.push({ call: __dsh_a.call, passed: false, actual: `error: ${e && e.message ? e.message : e}` })',
        '  }',
        '}',
        `__dsh_write(${JSON.stringify(resultFile)}, JSON.stringify(__dsh_results))`,
      ].join('\n')
      writeFileSync(join(dir, 'test.mjs'), harness, 'utf8')
      execFileSync(process.execPath, [join(dir, 'test.mjs')], { cwd: dir, stdio: 'ignore', timeout: 15000 })
    } else {
      // Python: an AST guard runs first (no imports at all, no eval/exec/open,
      // no dangerous attributes), then the code executes with the assertions.
      writeFileSync(join(dir, 'submission.py'), String(code ?? ''), 'utf8')
      writeFileSync(join(dir, 'guard.py'), PY_GUARD, 'utf8')
      try {
        execFileSync('python', [join(dir, 'guard.py'), join(dir, 'submission.py')], { cwd: dir, stdio: 'ignore', timeout: 10000 })
      } catch {
        cleanup()
        return { ran: false, reason: 'guard-rejected', language, assertions, passed: 0, total: assertions.length }
      }
      const harness = [
        'import json',
        'ns = {}',
        `exec(compile(${JSON.stringify(String(code ?? ''))}, "submission.py", "exec"), ns)`,
        `assertions = ${JSON.stringify(assertions)}`,
        'results = []',
        'for a in assertions:',
        '    call = a["name"] + "(" + a["args"] + ")"',
        '    try:',
        '        actual = eval(call, ns)',
        '        expected = eval(a["expected"], ns)',
        '        results.append({"call": call, "passed": actual == expected, "actual": repr(actual)})',
        '    except Exception as e:',
        '        results.append({"call": call, "passed": False, "actual": "error: " + str(e)})',
        `open(${JSON.stringify(resultFile)}, "w").write(json.dumps(results))`,
      ].join('\n')
      writeFileSync(join(dir, 'test.py'), harness, 'utf8')
      execFileSync('python', [join(dir, 'test.py')], { cwd: dir, stdio: 'ignore', timeout: 30000 })
    }
  } catch {
    cleanup()
    return { ran: false, reason: 'runner-failed', language, assertions, passed: 0, total: assertions.length }
  }

  let results
  try {
    results = JSON.parse(readFileSync(resultFile, 'utf8'))
  } catch {
    cleanup()
    return { ran: false, reason: 'runner-failed', language, assertions, passed: 0, total: assertions.length }
  }

  const passed = results.filter((r) => r.passed).length
  const checks = results.map((r) => ({ name: `assert ${r.call}`, pass: r.passed, actual: r.actual }))
  cleanup()
  return { ran: true, language, checks, assertions, passed, total: results.length }
}

function assertionSummary(exec) {
  const checks = exec.assertions.map((a, i) => ({
    name: `assert ${a.name}(${a.args})`,
    pass: Boolean(exec.checks?.[i]?.pass),
    actual: exec.checks?.[i]?.actual,
  }))
  return checks
}

export function gateSubtask(result, expectedId, acceptance, cfg, baseDir) {
  const checks = []
  let ok = true

  const jsonOk = isPlainObj(result)
  if (!jsonOk) {
    checks.push({ name: 'json-validity', pass: false })
    return { ok: false, score: 0, checks }
  }
  checks.push({ name: 'json-validity', pass: true })

  const idOk = result.subtask_id === expectedId
  checks.push({ name: 'subtask-id-match', pass: idOk })
  if (!idOk) ok = false

  const codeOk = typeof result.code === 'string' && result.code.trim().length > 0
  checks.push({ name: 'non-empty-code', pass: codeOk })
  if (!codeOk) ok = false

  const lineOk = codeOk && String(result.code).split('\n').length <= cfg.maxCodeLines
  checks.push({ name: `code-lines<=${cfg.maxCodeLines}`, pass: lineOk })
  if (!lineOk) ok = false

  const statusOk = RESULT_STATUS_OK.includes(normalizeStatus(result.status))
  checks.push({ name: 'status-in-enum', pass: statusOk })
  if (!statusOk) ok = false

  // v104 — execution-first and fail-closed: if the acceptance contains
  // assertions the runner decides, and every assertion must pass. A blocked or
  // crashed run is a failure, not a keyword-score opportunity.
  let score = 0
  if (codeOk) {
    const exec = executeAcceptance(result.code, acceptance, baseDir, cfg)
    if (exec === null) {
      score = semanticScore(result.code, acceptance)
      const semOk = score >= cfg.semanticGateThreshold
      checks.push({ name: `semantic-score>=${cfg.semanticGateThreshold}`, pass: semOk, score: Number(score.toFixed(3)) })
      if (!semOk) ok = false
    } else if (exec.ran) {
      checks.push(...assertionSummary(exec))
      score = exec.total > 0 ? exec.passed / exec.total : 0
      const qOk = exec.total > 0 && exec.passed === exec.total
      checks.push({ name: `execution-assertions ${exec.passed}/${exec.total}`, pass: qOk, score: Number(score.toFixed(3)) })
      if (!qOk) ok = false
    } else {
      checks.push({ name: `execution-assertions (${exec.reason ?? 'not-run'})`, pass: false })
      ok = false
    }
  }

  return { ok, score: Number(score.toFixed(3)), checks }
}

export function gateTask(task, subtaskRecords, cfg, fileCode, baseDir) {
  const checks = []
  let ok = true
  const records = Array.isArray(subtaskRecords) ? subtaskRecords : []
  const allDone = records.length > 0 && records.every((s) => s.state === 'done')
  checks.push({ name: 'all-subtasks-done', pass: allDone })
  if (!allDone) ok = false

  // v93 — a real file on disk may stand in for the board code: when an L2 wrote
  // the module by hand (register_output / filePath review), the workspace file is
  // the source of truth, not the per-subtask board snippets.
  const fromDisk = String(fileCode ?? '')
  const code = fromDisk.trim().length > 0
    ? fromDisk
    : records.map((s) => s.code).filter(Boolean).join('\n\n')
  const codeOk = code.trim().length > 0
  checks.push({ name: 'module-code-present', pass: codeOk })
  if (!codeOk) ok = false

  if (codeOk) {
    const exec = executeAcceptance(code, task.acceptance, baseDir, cfg)
    if (exec === null) {
      const score = semanticScore(code, task.acceptance)
      const semOk = score >= cfg.semanticGateThreshold
      checks.push({ name: `semantic-score>=${cfg.semanticGateThreshold}`, pass: semOk, score: Number(score.toFixed(3)) })
      if (!semOk) ok = false
      return { ok, score: Number(score.toFixed(3)), checks }
    }
    if (exec.ran) {
      checks.push(...assertionSummary(exec))
      const qOk = exec.total > 0 && exec.passed === exec.total
      checks.push({ name: `execution-assertions ${exec.passed}/${exec.total}`, pass: qOk })
      if (!qOk) ok = false
      return { ok, score: Number((exec.total > 0 ? exec.passed / exec.total : 0).toFixed(3)), checks }
    }
    checks.push({ name: `execution-assertions (${exec.reason ?? 'not-run'})`, pass: false })
    ok = false
  }

  return { ok, score: 0, checks }
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

// dsh-pipeline — per-workspace state: the in-memory board, the JSONL trace, the
// persisted run state machine, and the workspace activation memory.
import { existsSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir } from './util.js'
import { resolveSession, resolveSessionModel } from './dsh-compat.js'

// Runtime state directory (v83 / v93): board.json / requirement_lock.json /
// trace-*.jsonl / the L3 exec scratch dir belong to the CURRENT WORKSPACE, so two
// projects running in parallel never overwrite each other's board or lock.
// v93: derived from the SESSION's cwd (the user's workspace), not the daemon's
// process.cwd() — the plugin process runs inside the DSH profile directory, so
// process.cwd() would silently park every run under ~/.dsh/profiles/<profile>/.
// config.json stays GLOBAL (CONFIG_FILE): the global default plus the
// project-level <devDir>/pipeline-project.json overlay (v82) is what makes
// config per-project.
export function runtimeStateDir(root) {
  return join(root ?? process.cwd(), '.dsh', 'pipeline')
}

export function createStore(cfg, opts = {}) {
  // v103 — a store's state dir is fixed at creation from the workspace root the
  // registry resolved. No later re-homing: a process-wide mutable stateDir is
  // exactly what made two projects overwrite each other's board.
  const stateDir = opts.root ? runtimeStateDir(opts.root) : runtimeStateDir()
  ensureDir(stateDir)
  const store = {
    stateDir,
    workspaceRoot: opts.root ?? null,
    runId: null,
    requirement: null,
    locked: false,
    tasks: new Map(),
    subtasks: new Map(),
    agents: new Map(),
    messages: [],
    counters: { llmCalls: 0, tokensIn: 0, tokensOut: 0, l2Spawns: 0, l2Sends: 0, l3Calls: 0, l3TokensIn: 0, l3TokensOut: 0 },
    l3Concurrent: 0,
    // v94 — sweet-spot telemetry for the sidebar card: L1 context pressure measured by
    // the tokenMeter on tool calls (best effort), L2 pressure estimated per agent.
    context: { level1Tokens: 0 },
    // v89 — 控制权 / 里程碑 / 预算状态机（持久化到 run.json）
    run: {
      id: null,
      status: 'idle',
      startedAt: null,
      milestones: [],
      tokensUsed: 0,
      filesTouched: [],
      scope: [],
      activation: 'unknown',
      paused: false,
      pauseReason: null,
    },
  }

  // v103 — restore is safe now: the dir belongs to this workspace only, and the
  // board maps are cleared first so a reload never merges two snapshots.
  if (opts.restore !== false) restoreFromDir(stateDir)

  // v89/v93 — cold-start recovery: the files are the truth. run.json carries the
  // control state machine, board.json the historical board, and
  // requirement_lock.json the durable requirement lock.
  function restoreFromDir(dir) {
    // v103 — files on disk are the truth for THIS workspace: clear before load so
    // a repeated restore (or a fresh registry) can never keep a merged board.
    store.tasks.clear()
    store.subtasks.clear()
    store.agents.clear()
    store.messages.length = 0
    store.requirement = null
    store.locked = false
    store.runId = null
    try {
      const runFile = join(dir, 'run.json')
      if (existsSync(runFile)) {
        const saved = JSON.parse(readFileSync(runFile, 'utf8'))
        if (saved && typeof saved.status === 'string' && saved.status !== 'idle') {
          store.run = { ...store.run, ...saved, filesTouched: Array.isArray(saved.filesTouched) ? saved.filesTouched : [] }
          if (saved.id && !store.runId) store.runId = saved.id
        }
      }
    } catch {
      // best-effort
    }
    try {
      const boardFile = join(dir, 'board.json')
      if (existsSync(boardFile)) {
        const saved = JSON.parse(readFileSync(boardFile, 'utf8'))
        if (saved && Array.isArray(saved.tasks)) {
          for (const t of saved.tasks) {
            if (!t || !t.id) continue
            store.tasks.set(t.id, {
              id: t.id,
              desc: t.desc ?? '',
              assignee: t.assignee ?? '',
              deadline: t.deadline ?? null,
              acceptance: t.acceptance ?? '',
              depends_on: Array.isArray(t.depends_on) ? t.depends_on : [],
              state: t.state ?? 'pending',
              subtaskIds: [],
              reason: t.reason ?? null,
            })
          }
          for (const s of saved.subtasks ?? []) {
            if (!s || !s.id) continue
            store.subtasks.set(s.id, {
              id: s.id,
              parent: s.parent ?? null,
              desc: s.desc ?? '',
              acceptance: s.acceptance ?? '',
              state: s.state ?? 'pending',
              status: s.status ?? null,
              code: null,
              failCount: s.failCount ?? 0,
              reason: s.reason ?? null,
              compressed: null,
              inputTokens: 0,
              usage: null,
            })
          }
          if (saved.requirement != null) store.requirement = saved.requirement
          if (typeof saved.locked === 'boolean') store.locked = saved.locked
          for (const s of store.subtasks.values()) {
            const t = store.tasks.get(s.parent)
            if (t && !t.subtaskIds.includes(s.id)) t.subtaskIds.push(s.id)
          }
          for (const a of saved.agents ?? []) {
            if (a && a.id) store.agents.set(a.id, { ...a })
          }
          if (saved.run_id && !store.runId) store.runId = saved.run_id
        }
      }
    } catch {
      // best-effort
    }
    // v93 — board.json can predate the run being homed onto the workspace, so its
    // requirement/locked fields may be empty; requirement_lock.json is the durable
    // record written by pipeline_lock_requirements. Recover from it when needed.
    try {
      const lockFile = join(dir, 'requirement_lock.json')
      if (existsSync(lockFile)) {
        const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
        if (lock && lock.requirement != null && store.requirement == null) {
          store.requirement = lock.requirement
          store.locked = true
          if (typeof lock.run_id === 'string' && !store.runId) store.runId = lock.run_id
        }
      }
    } catch {
      // best-effort
    }
  }

  function tracePath() {
    return join(store.stateDir, `trace-${store.runId ?? 'none'}.jsonl`)
  }

  function boardPath() {
    return join(store.stateDir, 'board.json')
  }

  function runPath() {
    return join(store.stateDir, 'run.json')
  }

  // v103 — bind the calling session to this (fixed) workspace store. Only the
  // display model and the session handle change; the state dir never moves.
  function bindSession(ctx, source) {
    try {
      const info = resolveSessionModel(ctx, source)
      if (info && info.model) {
        store.context.level1Model = info.model
        store.context.level1Provider = info.provider || ''
        if (info.contextWindow > 0) store.context.level1Window = info.contextWindow
      }
    } catch {
      // best-effort; the board falls back to config
    }
    try {
      const sess = resolveSession(ctx, source)
      if (sess) store.lastSession = sess
    } catch {
      // best-effort; token metering falls back to the config budget
    }
    return true
  }

  // v93 — the dashboard route has no session ctx to re-home with, so let it adopt
  // whatever board the current stateDir holds.
  function reloadFromDisk() {
    restoreFromDir(store.stateDir)
  }

  // Persist the v89 control-state (milestones / budget / scope / activation) so
  // a cold L1 can resume the same run without asking the user again.
  function saveRun() {
    try {
      writeFileSync(runPath(), JSON.stringify(store.run, null, 2), 'utf8')
    } catch {
      // best-effort persistence
    }
  }

  function appendTrace(message) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      run_id: store.runId,
      ...message,
    })
    try {
      appendFileSync(tracePath(), line + '\n', 'utf8')
    } catch {
      // Trace is best-effort; the in-memory board remains authoritative.
    }
  }

  function snapshotBoard() {
    try {
      writeFileSync(boardPath(), JSON.stringify(storeToBoard(store), null, 2), 'utf8')
    } catch {
      // best-effort persistence
    }
  }

  function record(sender, state, messageType, nextSpeaker, taskId, taskDesc, taskConclusion, acceptanceCriteria) {
    const message = {
      sender,
      state,
      group_id: store.runId ?? 'none',
      message_type: messageType,
      next_speaker: nextSpeaker,
      task_id: taskId ?? null,
      task_desc: taskDesc ?? null,
      task_conclusion: taskConclusion ?? null,
      acceptance_criteria: acceptanceCriteria ?? null,
    }
    store.messages.push(message)
    appendTrace(message)
    snapshotBoard()
    return message
  }

  return { store, record, tracePath, boardPath, stateDir, saveRun, bindSession, reloadFromDisk, snapshotBoard }
}

export function storeToBoard(store) {
  const tasks = [...store.tasks.values()].map((t) => ({
    id: t.id,
    desc: t.desc,
    assignee: t.assignee,
    deadline: t.deadline ?? null,
    acceptance: t.acceptance,
    depends_on: t.depends_on,
    state: t.state,
    subtaskCount: t.subtaskIds.length,
    reason: t.reason ?? null,
  }))
  const subtasks = [...store.subtasks.values()].map((s) => ({
    id: s.id,
    parent: s.parent,
    desc: s.desc,
    acceptance: s.acceptance,
    state: s.state,
    status: s.status ?? null,
    codeLines: s.code ? String(s.code).split('\n').length : 0,
    failCount: s.failCount ?? 0,
    reason: s.reason ?? null,
  }))
  const agents = [...store.agents.values()].map((a) => ({ ...a }))
  return {
    run_id: store.runId,
    requirement: store.requirement,
    locked: store.locked,
    counters: store.counters,
    tasks,
    subtasks,
    agents,
  }
}

// v89 — computed milestone progress (the files are the truth: derive from task
// states, never persist duplicate state that can drift out of sync).
export function milestoneStates(store) {
  const list = Array.isArray(store.run?.milestones) ? store.run.milestones : []
  return list.map((ms) => {
    const tasks = ms.taskIds.map((id) => store.tasks.get(id)).filter(Boolean)
    const doneCount = tasks.filter((t) => t.state === 'done').length
    const allDone = tasks.length > 0 && doneCount === tasks.length
    const state = ms.state === 'accepted' ? 'accepted' : allDone ? 'done' : 'pending'
    return { id: ms.id, name: ms.name, taskIds: ms.taskIds, state, done: doneCount, total: ms.taskIds.length }
  })
}

// v89 — budget guard: a refusal reason when the run exceeded a configured cap,
// else ''. Zero means unlimited.
export function budgetRefusal(r, cfg) {
  const run = r.store.run
  if (!run || run.status === 'idle') return ''
  // v103 — pause wins over the status field: /pipe-stop writes both, but a
  // hand-edited or half-restored run.json may only carry one.
  if (run.paused || run.status === 'paused') {
    return `run 已暂停（${run.pauseReason ?? '手动'}）；先 /pipe-resume 或 /pipe-stop`
  }
  if (run.status !== 'active') {
    return `run 状态为 ${run.status}，不能继续派发；先 /pipe-resume 或 /pipe-stop`
  }
  if (Number(cfg.maxTotalTokensPerRun) > 0 && run.tokensUsed >= Number(cfg.maxTotalTokensPerRun)) {
    return `token 预算已用尽（${run.tokensUsed}/${cfg.maxTotalTokensPerRun}）；调 /pipe-config maxTotalTokensPerRun <值> 或 /pipe-stop`
  }
  if (Number(cfg.maxDurationPerRun) > 0 && run.startedAt && Date.now() - Date.parse(run.startedAt) >= Number(cfg.maxDurationPerRun)) {
    return `时长预算已用尽（>${Math.round(Number(cfg.maxDurationPerRun) / 60000)} 分钟）；调 /pipe-config maxDurationPerRun <毫秒> 或 /pipe-stop`
  }
  const touched = Array.isArray(run.filesTouched) ? run.filesTouched.length : 0
  if (Number(cfg.maxFilesPerRun) > 0 && touched >= Number(cfg.maxFilesPerRun)) {
    return `改动文件数达到上限（${touched}/${cfg.maxFilesPerRun}）；调 /pipe-config maxFilesPerRun <值> 或 /pipe-stop`
  }
  return ''
}

// v89 — additive budget counters; auto-pauses the run when a cap is hit.
export function addRunUsage(r, cfg, tokens, files) {
  const run = r.store.run
  if (!run || run.status !== 'active') return
  if (Number.isFinite(tokens) && tokens > 0) run.tokensUsed = Math.round(run.tokensUsed + tokens)
  for (const f of files ?? []) {
    if (typeof f === 'string' && f && !run.filesTouched.includes(f)) run.filesTouched.push(f)
  }
  const refusal = budgetRefusal(r, cfg)
  if (refusal) {
    run.paused = true
    run.pauseReason = refusal
  }
  r.saveRun()
}

// v89 — live footer appended to every L1 tool result, so the model can never
// silently drop a finished-but-unaccepted milestone or a spent budget.
export function runFooter(r) {
  const run = r.store.run
  if (!run || run.status === 'idle') return ''
  const parts = []
  if (run.paused) parts.push(`⏸️ run 已暂停（${run.pauseReason ?? '预算/手动'}）`)
  const ms = milestoneStates(r.store)
  const accepted = ms.filter((m) => m.state === 'accepted')
  const doneUnaccepted = ms.filter((m) => m.state === 'done')
  if (ms.length > 0) {
    parts.push(`📊 里程碑 ${accepted.length}/${ms.length} 已验收：${ms.map((m) => `${m.name}=${m.state}`).join(' / ')}`)
  }
  if (doneUnaccepted.length > 0) {
    parts.push(`⚠️ 验收未做：${doneUnaccepted.map((m) => m.name).join('、')} 已完成但未验收——先 ask_user_question 弹窗验收，再 pipeline_accept_milestone`)
  }
  return parts.length > 0 ? `\n\n「流水线」${parts.join('；')}` : ''
}

// v89 — workspace activation gate: remembered per workspace, so a returning
// user is asked once, not on every run. The gate itself is a prompt-layer
// behaviour (L1 asks with ask_user_question); these helpers only record the
// answer so the next run knows it already has one.
export function activationPath(stateDir) {
  return join(stateDir, 'activation.json')
}
export function loadActivation(stateDir) {
  try {
    const v = JSON.parse(readFileSync(activationPath(stateDir), 'utf8'))
    return { confirmed: v?.confirmed === true, choice: typeof v?.choice === 'string' ? v.choice : null }
  } catch {
    return { confirmed: false, choice: null }
  }
}
export function saveActivation(stateDir, choice) {
  try {
    writeFileSync(activationPath(stateDir), JSON.stringify({ confirmed: true, choice, at: new Date().toISOString() }, null, 2), 'utf8')
  } catch {
    // best-effort
  }
}

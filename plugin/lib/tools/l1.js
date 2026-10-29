// dsh-pipeline — Level-1 tool factories: lock/plan, L2 lifecycle (spawn/send/
// drain/checkpoint), status, classify, selftest and milestone acceptance.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { text, LEVEL2_NAMES, TASK_STATES, estimateTokens, ensureDir, numCfg, jsonOutput } from '../util.js'
import { validateTaskPlan, cleanupExpiredL2s } from '../gates.js'
import { milestoneStates, loadActivation, saveActivation, addRunUsage, storeToBoard } from '../store.js'
import { buildL2LeadPrompt } from '../prompts.js'
import { measureLevel1Context, measureSessionTokens, resolveWorkspaceRoot } from '../dsh-compat.js'

// v92.1 — workspace root for resolving relative scopeDir paths. v103 — the
// registry store carries the fixed workspace root, so prefer it; the session
// header is only a fallback (and process.cwd() is the profile dir, never the
// project).
function workspaceRoot(ctx, exec, r) {
  return (r && r.store && r.store.workspaceRoot) || resolveWorkspaceRoot(ctx, exec) || process.cwd()
}

// Resolve subagents or fail with an actionable diagnosis (never a bare "unavailable").
function requireSubagents(ctx, method, action) {
  const subs = ctx.get ? ctx.get('subagents') : undefined
  if (!subs || typeof subs[method] !== 'function') {
    throw new Error(`subagents service is unavailable（DSH 版本不匹配或插件未重载）——先跑 /pipe-selftest 定位，重载插件后重试；不要重复${action ?? '调用'}浪费 token。`)
  }
  return subs
}

// v112 (O7/B14) — until now an L2's context pressure was only ever ESTIMATED
// from the text L1 sent it (`estimatedTokens` grows by prompt length, so the
// meter and the budget guard under-reported the real session). Measure each live
// L2 session through the tokenMeter (deterministic, no LLM call) and charge only
// the DELTA, keeping a high-water mark so compaction does not re-charge the same
// tokens. A missing service or session is skipped silently (older hosts).
function accountL2Tokens(ctx, cfg, r) {
  const store = r?.store
  if (!store?.agents) return 0
  let delta = 0
  for (const a of store.agents.values()) {
    if (!a || a.kind !== 'l2' || a.state === 'replaced' || a.state === 'failed') continue
    let measured = null
    try { measured = measureSessionTokens(ctx, a.id) } catch { measured = null }
    if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) continue
    a.tokens = measured
    const before = Number(a.measuredTokens ?? 0)
    a.measuredTokens = Math.max(before, measured)
    if (measured > before) delta += measured - before
  }
  if (delta > 0) {
    store.counters.measuredTokens = Number(store.counters.measuredTokens ?? 0) + delta
    addRunUsage(r, cfg, delta, [])
  }
  return delta
}

export function makeLockTool(ctx, cfg, r) {
  return {
    name: 'pipeline_lock_requirements',
    description: 'Lock requirements + open a run (writes requirement_lock.json).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['requirement'],
      properties: {
        requirement: { type: 'string', description: 'Finalized requirement.' },
        scope: { type: 'string', description: 'Optional scope boundary.' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints.' },
        reuseNote: { type: 'string', description: 'Optional: reusable pieces found while researching.' },
        activation: {
          type: 'string',
          enum: ['enable', 'normal', 'remember'],
          description: 'One-time activation answer: enable / normal / remember (ask user first).',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_a, value) => text(`Requirement locked.\nrun_id: ${value.run_id}\n${value.requirement}${value.activationHint ? `\n\n${value.activationHint}` : ''}`),
    },
    async execute(args) {
      if (typeof args.requirement !== 'string' || !args.requirement.trim()) {
        throw new Error('requirement must be a non-empty string')
      }
      // v89 — one-time activation gate, remembered per workspace.
      const activation = loadActivation(r.stateDir)
      if (args.activation) saveActivation(r.stateDir, args.activation)
      let activationHint = null
      if (cfg.activationGate && !activation.confirmed && !args.activation) {
        activationHint = 'ACTIVATION GATE (one-time): before this run, ask the user once with ask_user_question — 三级流水线要在这里启用吗？A 启用（推荐） / B 只做普通回答 / C 记住此工作区以后默认启用。Then call pipeline_lock_requirements again with activation=enable|normal|remember (a locked run keeps working, this only records the choice).'
      }
      r.store.runId = `run-${Date.now()}-${randomUUID().slice(0, 8)}`
      r.store.requirement = args.requirement.trim()
      r.store.locked = true
      r.store.tasks.clear()
      r.store.subtasks.clear()
      r.store.messages.length = 0
      // v89 — open the run: active state machine, zeroed budget, recorded scope.
      r.store.run = {
        id: r.store.runId,
        status: 'active',
        startedAt: new Date().toISOString(),
        milestones: [],
        tokensUsed: 0,
        filesTouched: [],
        scope: typeof args.scope === 'string' && args.scope.trim() ? [args.scope.trim()] : [],
        activation: args.activation ?? activation.choice ?? 'unknown',
        paused: false,
        pauseReason: null,
      }
      r.saveRun()
      const lock = {
        run_id: r.store.runId,
        requirement: r.store.requirement,
        scope: args.scope ?? null,
        constraints: args.constraints ?? [],
        reuseNote: args.reuseNote ?? null,
        activationHint,
        lockedAt: new Date().toISOString(),
      }
      try {
        writeFileSync(join(r.stateDir, 'requirement_lock.json'), JSON.stringify(lock, null, 2), 'utf8')
      } catch {
        // best-effort
      }
      r.record('level1_main', 'pending', 'discussion', 'level1_main', null, r.store.requirement, 'requirement locked', null)
      return lock
    },
  }
}

export function makePlanTool(ctx, cfg, r) {
  return {
    name: 'pipeline_plan',
    description: 'Record + validate the L1 TaskPlan (DAG + cycle check) and milestones.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskPlan'],
      properties: {
        taskPlan: {
          type: 'object',
          additionalProperties: true,
          properties: {
            tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            milestones: {
              type: 'array',
              description: 'Milestones [{id,name,taskIds}]; auto-done, hard gate until accepted.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  taskIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        reset: { type: 'boolean', description: 'Allow re-planning over a done-but-unaccepted milestone (drops that acceptance gate).' },
        verbose: { type: 'boolean', description: 'Echo each task desc in full plus its acceptance (default: compact routing skeleton).' },
      },
    },
    output: jsonOutput(),
    async execute(args) {
      const cap = (s, n) => {
        const t = String(s ?? '')
        return t.length > n ? `${t.slice(0, n - 1)}…` : t
      }
      if (!r.store.locked || !r.store.runId) {
        throw new Error('lock requirements first with pipeline_lock_requirements')
      }
      const tasks = validateTaskPlan(args.taskPlan)
      for (const t of tasks) {
        const prevTask = r.store.tasks.get(t.id)
        r.store.tasks.set(t.id, {
          id: t.id,
          desc: t.desc.trim(),
          assignee: t.assignee ?? LEVEL2_NAMES[0],
          deadline: t.deadline ?? null,
          acceptance: t.acceptance.trim(),
          depends_on: t.depends_on ?? [],
          // v104 — re-planning must not silently reopen finished work.
          state: prevTask?.state ?? 'pending',
          reason: prevTask?.reason ?? null,
          subtaskIds: prevTask?.subtaskIds ?? [],
        })
        r.record('level1_main', 'pending', 'task_assignment', t.assignee ?? LEVEL2_NAMES[0], t.id, t.desc, null, t.acceptance)
      }
      // v89 — acceptance milestones (state is computed lazily from task states).
      const rawMilestones = Array.isArray(args.taskPlan?.milestones) ? args.taskPlan.milestones : []
      const prior = new Map((r.store.run.milestones ?? []).map((m) => [m.id, m]))
      const nextMilestones = rawMilestones
        .map((m, i) => ({
          id: String(m?.id ?? `m${i + 1}`),
          name: String(m?.name ?? m?.id ?? `milestone ${i + 1}`),
          taskIds: Array.isArray(m?.taskIds) ? m.taskIds.map(String) : [],
          state: 'pending',
        }))
        .filter((m) => m.taskIds.length > 0)
      // v104 — a done-but-unaccepted milestone must not be silently erased by a
      // re-plan; require an explicit reset, and carry accepted state forward.
      const doneUnaccepted = [...prior.values()].filter((m) => {
        if (m.state === 'accepted') return false
        const st = milestoneStates(r.store).find((x) => x.id === m.id)
        return st && st.state === 'done'
      })
      if (doneUnaccepted.length > 0 && args.reset !== true) {
        throw new Error(`里程碑 ${doneUnaccepted.map((m) => m.id).join(', ')} 已完成但未验收；先 pipeline_accept_milestone 验收，或显式传 reset:true 放弃该验收门`)
      }
      for (const m of nextMilestones) {
        const old = prior.get(m.id)
        if (old?.state === 'accepted') {
          m.state = 'accepted'
          m.acceptedAt = old.acceptedAt ?? null
          m.note = old.note ?? null
        }
      }
      r.store.run.milestones = nextMilestones
      r.saveRun()
      // v96 — module-count nudge (soft, never blocks): a large plan collapsed into 1-2 leads.
      const assignees = [...new Set(tasks.map((t) => (t.assignee ?? LEVEL2_NAMES[0]).trim()))]
      const bigRequirement = String(r.store.requirement ?? '').length >= 600
      let planHint = null
      if (assignees.length === 1 && tasks.length >= 3) {
        planHint = `MODULE COUNT: ${tasks.length} tasks but 1 module (${assignees[0]}). If they touch independent concerns, re-plan with more L2s (≥3 concerns → ≥3 leads).`
      } else if (assignees.length <= 2 && bigRequirement) {
        planHint = `MODULE COUNT: large requirement planned with ${assignees.length} lead(s) (${assignees.join(', ')}). Independent concerns must each get a lead; consider 3+ before spawning.`
      }
      return {
        run_id: r.store.runId,
        // v112 (O3) — a plan ack only needs the routing skeleton; the full
        // desc/acceptance text was echoed back on every (re-)plan. verbose:true
        // restores the previous full echo.
        tasks: storeToBoard(r.store).tasks.map((t) => ({
          id: t.id,
          desc: cap(t.desc, args?.verbose === true ? 100000 : 80),
          assignee: t.assignee,
          state: t.state,
          depends_on: t.depends_on,
          subtaskCount: t.subtaskCount,
          ...(args?.verbose === true ? { acceptance: t.acceptance } : {}),
        })),
        milestones: milestoneStates(r.store),
        ...(planHint ? { planHint } : {}),
      }
    },
  }
}

export function makeStatusTool(ctx, cfg, r) {
  return {
    name: 'pipeline_status',
    description: 'Read the board, trace, and token accounting.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verbose: { type: 'boolean', description: 'Include full task/subtask/agent text (default: compact projection).' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      // v112 (O7) — charge the real L2 session growth before reporting totals.
      const measuredDelta = accountL2Tokens(ctx, cfg, r)
      const board = storeToBoard(r.store)
      const v = args?.verbose === true
      const cap = (s, n) => {
        const t = String(s ?? '')
        return t.length > n ? `${t.slice(0, n - 1)}…` : t
      }
      const byState = (arr) => {
        const m = {}
        for (const s of TASK_STATES) m[s] = 0
        for (const x of arr) m[x.state] = (m[x.state] ?? 0) + 1
        return m
      }
      const tasksDone = board.tasks.filter((t) => t.state === 'done').length
      const subtasksDone = board.subtasks.filter((s) => s.state === 'done').length
      const totalTokens = r.store.counters.tokensIn + r.store.counters.tokensOut
      // v104 — tell the coordinator WHY it should stop looking: live L2s push
      // their reports, so polling adds nothing and burns tokens.
      const waitingFor = board.agents.filter((a) => a.state === 'in_progress').map((a) => a.label || String(a.id ?? ''))
      // v111 (O1) — status is a read, not a data export: long prose and agent
      // prompts used to be ~70% of this payload, and agent records carried the L3
      // `code`. Project to routing fields; verbose:true restores full text.
      return {
        run_id: board.run_id,
        locked: board.locked,
        requirement: cap(board.requirement, v ? 100000 : 400),
        taskStates: byState(board.tasks),
        subtaskStates: byState(board.subtasks),
        counters: r.store.counters,
        // v112 (B14) — three distinct numbers, explicitly named: `trackedTokens`
        // is what this plugin could account for, `measuredTokens` includes the
        // real size of live L2 sessions, `tokensUsed` is the budget guard's number.
        trackedTokens: totalTokens,
        measuredTokens: Number(r.store.counters.measuredTokens ?? 0),
        tokensUsed: Number(r.store.run?.tokensUsed ?? 0),
        measuredDelta,
        totalTokens,
        tasksDone,
        subtasksDone,
        tasks: board.tasks.map((t) => ({
          id: t.id,
          desc: cap(t.desc, v ? 100000 : 60),
          assignee: t.assignee,
          state: t.state,
          depends_on: t.depends_on,
          subtaskCount: t.subtaskCount,
          reason: t.reason ? cap(t.reason, 120) : null,
        })),
        subtasks: board.subtasks.map((s) => ({
          id: s.id,
          parent: s.parent,
          desc: cap(s.desc, v ? 100000 : 50),
          state: s.state,
          status: s.status,
          codeLines: s.codeLines,
          failCount: s.failCount,
          reason: s.reason ? cap(s.reason, 120) : null,
          ...(v ? { acceptance: s.acceptance } : {}),
        })),
        agents: board.agents.map((a) => ({
          id: a.id,
          kind: a.kind ?? null,
          label: a.label ?? null,
          state: a.state ?? null,
          model: a.model ?? null,
          scopeDir: a.scopeDir ?? null,
          estimatedTokens: a.estimatedTokens ?? null,
          ...(Number.isFinite(a.tokens) ? { tokens: a.tokens } : {}),
          ...(Number.isFinite(a.measuredTokens) ? { measuredTokens: a.measuredTokens } : {}),
          desc: cap(a.desc, v ? 100000 : 80),
        })),
        ...(waitingFor.length > 0
          ? { waitingFor, hint: `L2 正在处理（${waitingFor.join('、')}）；不要轮询——结束回合等待 push 汇报，宿主动会通知你。` }
          : {}),
        level1Context: measureLevel1Context(ctx, exec, cfg),
        // v111 (B1) — the old cap keyed on a `text` field the board never reads.
        // Project each event to who/what happened + one capped note: the raw
        // record (4-5 long string fields) cost ~500 chars per message.
        recentMessages: r.store.messages.slice(-6).map((m) => ({
          sender: m?.sender ?? null,
          state: m?.state ?? null,
          type: m?.message_type ?? null,
          task_id: m?.task_id ?? null,
          note: cap(m?.task_conclusion ?? m?.task_desc ?? m?.acceptance_criteria ?? '', 100),
        })),
      }
    },
  }
}

// Spawn a long-lived Level-2 module-lead as a CONTINUABLE subagent on the flash
// model (agentOptions carries provider/model, so it does NOT inherit the parent).
// Reuse the returned childId for every task of its module; do NOT re-spawn.
export function makeSpawnModuleLeadTool(ctx, cfg, r) {
  return {
    name: 'pipeline_spawn_module_lead',
    description:
      'Spawn a long-lived L2 lead; reuse its childId. One per module; provider/model optional.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'description', 'prompt'],
      properties: {
        name: { type: 'string', description: 'Kebab-case duty name (cli-core, api-auth).' },
        description: { type: 'string', description: 'One-line responsibility.' },
        prompt: { type: 'string', description: 'Standing prompt / first task.' },
        acceptance: { type: 'string', description: "Module acceptance, one checkable sentence." },
        provider: { type: 'string', description: 'Optional provider override.' },
        model: { type: 'string', description: 'Optional model override (hard module → stronger).' },
        scopeDir: { type: 'string', description: 'Optional work dir; default .dsh/pipeline/work/<name>/.' },
        resumeFrom: { type: 'string', description: 'Optional handoff file to resume.' },
        replacingChildId: { type: 'string', description: 'Optional old L2 id marked replaced.' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const subs = requireSubagents(ctx, 'startActivation', 'spawn')
      // v105 — bound re-dispatch per module: maxLevel2Retries was documented in the L2
      // prompt ("at most N attempts per task") but never enforced. Count spawns per
      // module name in the run and refuse to re-spawn past the budget.
      const retryCap = numCfg(cfg, 'maxLevel2Retries', 3)
      const attemptKey = String(args.name ?? '').trim()
      const spawnCounts = (r.store.run.spawnCounts ??= {})
      if (attemptKey && (spawnCounts[attemptKey] ?? 0) >= retryCap) {
        throw new Error(`模块 ${attemptKey} 已派发 ${spawnCounts[attemptKey]} 次，达到 maxLevel2Retries=${retryCap}；请自己接手、或向用户报告 cannot-do，不要再起同类 L2。`)
      }
      if (attemptKey) {
        spawnCounts[attemptKey] = (spawnCounts[attemptKey] ?? 0) + 1
        r.saveRun()
      }
      // Module-lead cap.
      const liveL2 = [...r.store.agents.values()].filter((a) => a.kind === 'l2' && a.state !== 'done' && a.state !== 'replaced')
      const cap = numCfg(cfg, 'maxLevel2Agents', 10)
      if (liveL2.length >= cap) {
        throw new Error(`已达 L2 上限 ${cap}：先 pipeline_drain_leads 清理已完成/旧的模块负责人，再 spawn 新模块。`)
      }
      cleanupExpiredL2s(subs, exec.agent, r, cfg)
      let handoff = null
      if (args.resumeFrom) {
        try { handoff = readFileSync(resolve(workspaceRoot(ctx, exec, r), args.resumeFrom), 'utf8') } catch { /* missing handoff file is non-fatal */ }
      }
      // v92 — per-lead work directory (real cwd isolation between modules).
      const rawScope = typeof args.scopeDir === 'string' && args.scopeDir.trim() ? args.scopeDir.trim().replace(/\\/g, '/') : ''
      const scopeRel = rawScope || join('.dsh', 'pipeline', 'work', String(args.name ?? 'lead').replace(/[^a-zA-Z0-9._-]+/g, '_'))
      const scopeAbs = resolve(workspaceRoot(ctx, exec, r), scopeRel)
      try { ensureDir(scopeAbs) } catch { /* best-effort: a lead can still write absolute paths */ }
      const promptText = buildL2LeadPrompt(args.prompt, args.acceptance, cfg, handoff, scopeRel)
      const promptTokens = estimateTokens(promptText)
      // v94 — per-lead model override (a hard module can get a stronger model).
      const l2Provider = typeof args.provider === 'string' && args.provider.trim() ? args.provider.trim() : cfg.level2Provider
      const l2Model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : cfg.level2Model
      // v84 — startActivation (no toolFilter; adjacency lives in the registry guard).
      const result = await subs.startActivation({
        provider: cfg.spawnProvider || 'spawn',
        label: args.name,
        request: {
          prompt: [{ type: 'text', text: promptText }],
          parent: exec.agent,
          cwd: scopeAbs,
          agentOptions: { provider: l2Provider, model: l2Model },
        },
        signal: exec.signal,
        delivery: 'parent',
      })
      r.record('level1_main', 'in_progress', 'agent_spawn', args.name, result.childId, args.prompt, null, null)
      r.store.counters.l2Spawns += 1
      addRunUsage(r, cfg, promptTokens, [])
      r.store.agents.set(result.childId, {
        id: result.childId,
        kind: 'l2',
        label: args.name,
        desc: args.prompt,
        acceptance: args.acceptance ?? null,
        state: 'in_progress',
        provider: l2Provider,
        model: l2Model,
        estimatedTokens: promptTokens,
        scopeDir: scopeRel,
      })
      // v103 — the L2 session's cwd is its scopeDir, not the project root; record
      // the mapping so its pipeline_* calls land in this workspace's store.
      try { r.bindChild?.(result.childId) } catch { /* best-effort */ }
      // v112 (O7) — first real measurement of the new session (usually tiny).
      accountL2Tokens(ctx, cfg, r)
      // v104 — hard anti-poll: the host ends this turn after the tool result, so
      // the coordinator cannot keep polling the board while L2 works.
      try { exec.concludeTurn?.() } catch { /* host without turn control */ }
      // Mark the old lead as replaced now; the real drain happens later via drain_leads.
      if (args.replacingChildId) {
        const old = r.store.agents.get(args.replacingChildId)
        if (old) { old.state = 'replaced'; old.replacedBy = result.childId; old.replacedAt = Date.now() }
      }
      // v96 — soft nudge: a large plan must not stay on 1-2 leads.
      const plannedAssignees = [...new Set([...r.store.tasks.values()].map((t) => String(t.assignee ?? '').trim()).filter(Boolean))]
      const liveLabels = new Set(liveL2.map((a) => a.label))
      const unspawned = plannedAssignees.filter((a) => !liveLabels.has(a))
      let spawnHint = null
      if (unspawned.length >= 2) {
        spawnHint = `MODULE COUNT: ${unspawned.length} planned module(s) still have no L2 (${unspawned.join(', ')}). Spawn them before dispatching more work to this one.`
      }
      return {
        childId: result.childId,
        messageId: result.messageId,
        label: args.name,
        provider: l2Provider,
        model: l2Model,
        scopeDir: scopeRel,
        ...(spawnHint ? { spawnHint } : {}),
      }
    },
  }
}

// Send a follow-up task to a long-lived continuable Level-2 child (reuse, not re-spawn).
export function makeSendToLeadTool(ctx, cfg, r) {
  return {
    name: 'pipeline_send_to_lead',
    description: 'Follow-up task to a live L2 (reuse, no re-spawn).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childId', 'message'],
      properties: {
        childId: { type: 'string', description: 'childId from spawn.' },
        message: { type: 'string', description: 'The follow-up task message.' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const subs = requireSubagents(ctx, 'sendMessage', 'send')
      const messageId = await subs.sendMessage(exec.agent, args.childId, [{ type: 'text', text: args.message }], { signal: exec.signal })
      const msgTokens = estimateTokens(args.message)
      r.record('level1_main', 'in_progress', 'agent_send', args.childId, args.childId, args.message, null, null)
      r.store.counters.l2Sends += 1
      addRunUsage(r, cfg, msgTokens, [])
      const l2 = r.store.agents.get(args.childId)
      if (l2) l2.estimatedTokens = (l2.estimatedTokens ?? 0) + msgTokens
      // v112 (O7) — the send grew the child's real session; charge the delta.
      accountL2Tokens(ctx, cfg, r)
      // v104 — same hard anti-poll rule as spawn: dispatch ends the coordinator's turn.
      try { exec.concludeTurn?.() } catch { /* host without turn control */ }
      const warnThreshold = Math.floor(Number(cfg.level2ContextBudget) * 0.8)
      if (l2 && Math.max(Number(l2.tokens ?? 0), Number(l2.estimatedTokens ?? 0)) >= warnThreshold) {
        return { childId: args.childId, messageId, warning: `此 L2 负载已近上限（measured≈${l2.tokens ?? '—'} / estimated≈${l2.estimatedTokens}/${cfg.level2ContextBudget}），建议拆分剩余工作或改派更闲的 L2` }
      }
      return { childId: args.childId, messageId }
    },
  }
}

// Release a batch of old Level-2 leads after milestone recreation. Absent ids are no-ops.
export function makeDrainLeadsTool(ctx, cfg, r) {
  return {
    name: 'pipeline_drain_leads',
    description: 'Drain old L2 leads after recreation; unknown ids are no-ops.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['childIds'],
      properties: {
        childIds: { type: 'array', items: { type: 'string' }, description: 'Old L2 childIds.' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const subs = requireSubagents(ctx, 'drainChildren', 'drain')
      const ids = (args.childIds ?? []).filter((x) => typeof x === 'string' && x)
      try {
        await subs.drainChildren(exec.agent, ids)
      } catch (e) {
        // v104 — a failed drain is a real failure: do not report ids as drained and
        // do not flip the board to done.
        const message = String(e?.message ?? e)
        for (const id of ids) {
          const a = r.store.agents.get(id)
          if (a) { a.state = 'failed'; a.reason = `drain failed: ${message}` }
        }
        r.record('level1_main', 'failed', 'agent_drain', null, null, message, null, null)
        return { ok: false, drained: [], requested: ids, error: message }
      }
      // v112 (O7) — take the final measurement before the sessions go away.
      accountL2Tokens(ctx, cfg, r)
      for (const id of ids) {
        const a = r.store.agents.get(id)
        if (a) a.state = 'done'
      }
      return { ok: true, drained: ids }
    },
  }
}

// Write a resumable checkpoint document (9 sections) for a fresh L1 session.
export function makeCheckpointTool(ctx, cfg, r) {
  return {
    name: 'pipeline_checkpoint',
    description: 'Write project_checkpoint.md (cold-start contract for the next L1).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        done: { type: 'string', description: 'Optional: completed files/modules (index list).' },
        pending: { type: 'string', description: 'Optional: in-progress files + progress notes.' },
        todo: { type: 'string', description: 'Optional: pending files/modules.' },
        decisions: { type: 'string', description: 'Optional: key decisions that affect later work.' },
        pitfalls: { type: 'string', description: 'Optional: pitfalls / notes for the next L1.' },
        path: { type: 'string', description: 'Optional output path (default <devDir>/project_checkpoint.md).' },
        verbose: { type: 'boolean', description: 'Return the full document text (default: only path/size/line count).' },
      },
    },
    output: jsonOutput(),
    execute(args, exec) {
      // Absolute paths: document + coldStartPrompt must work from another cwd.
      // v103 — default paths live under the calling WORKSPACE, never the daemon cwd.
      const root = workspaceRoot(ctx, exec, r)
      const file = args.path ? resolve(root, args.path) : resolve(join(root, cfg.devDir, 'project_checkpoint.md'))
      const handoffDir = join(root, cfg.devDir, 'team_board')
      const agents = [...r.store.agents.values()]
      const lines = [
        '# 项目交接文档 (checkpoint)',
        '',
        '## 0. 恢复指令',
        '这是项目交接文档。请按 §9 恢复步骤继续本项目：先读文件对账，再 resumeFrom 重新拉起 L2，然后继续里程碑推进。',
        '',
        '## 1. 需求',
        String(r.store.requirement ?? '(未锁定)'),
        '',
        '## 2. 全局上下文',
        `L1 甜点区 ${cfg.level1ContextBudget} tokens；L2=${cfg.level2Model}；L3=${cfg.level3Model}；mode=${cfg.mode}`,
        '',
        '## 3. 已完成（索引）',
        args.done ? String(args.done) : '（补充：已完成的文件/模块，一行一个）',
        '',
        '## 4. 进行中（文件 + 进度）',
        args.pending ? String(args.pending) : '（补充：进行中的文件 + 进度备注）',
        '',
        '## 5. 待办（索引）',
        args.todo ? String(args.todo) : '（补充：待办文件/模块）',
        '',
        '## 6. 关键决策',
        args.decisions ? String(args.decisions) : '（补充：影响后续工作的关键选择）',
        '',
        '## 7. 遗留坑 / 注意',
        args.pitfalls ? String(args.pitfalls) : '（补充：注意事项）',
        '',
        '## 8. 活跃 L2 状态',
      ]
      if (agents.length === 0) lines.push('(无活跃 L2)')
      for (const a of agents) {
        const tok = a.estimatedTokens ? `, estimatedTokens=${a.estimatedTokens}` : ''
        const handoff = a.kind === 'l2' ? `, handoff=${join(handoffDir, `${a.label}_state.md`)}` : ''
        lines.push(`- ${a.label} [${a.state}] childId=${a.id}${tok}${handoff}`)
      }
      lines.push(
        '',
        '## 9. 恢复步骤（新会话）',
        `1. 读本文件「${file}」+ 磁盘文件对账（文件是真相，细节在文件里，本文件只是索引）`,
        `2. 对每个「in_progress」的 L2：pipeline_spawn_module_lead(resumeFrom=<其 handoff 文件，位于 ${handoffDir}>) 重新拉起`,
        '3. 继续按里程碑推进；里程碑「我很满意」才验收',
      )
      const text = lines.join('\n')
      try { ensureDir(dirname(file)); writeFileSync(file, text, 'utf8') } catch { /* best-effort */ }
      const coldStartPrompt = [
        '【项目续接 · 冷启动】这不是新任务，是续接。',
        `项目：${String(r.store.requirement ?? '(见交接文档)').slice(0, 200)}`,
        '',
        '请执行：',
        `1. 读「${file}」（9 节交接契约）。`,
        `2. 读各 L2 交接文件 ${join(handoffDir, '*_state.md')}，并读磁盘文件对账（文件是真相）。`,
        '3. 对每个 in_progress 的 L2：pipeline_spawn_module_lead(resumeFrom=<其交接文件>) 重新拉起。',
        '4. 继续按里程碑推进；里程碑「我很满意」才验收。',
        '约束：严格走插件三级架构（L1→L2→L3），不要用 Agent Teams。',
      ].join('\n')
      // v111 (O2) — the document lives on disk; echoing it back cost ~5K tokens
      // per call. verbose:true restores the old full-text behavior.
      const out = {
        path: file,
        bytes: Buffer.byteLength(text, 'utf8'),
        lines: text.split('\n').length,
        coldStartPrompt,
      }
      if (args.verbose === true) out.content = text
      return out
    },
  }
}

// Deterministic capability-matching classifier: route a task to L1/L2/L3.
export function makeClassifyTool(ctx, cfg, r) {
  return {
    name: 'pipeline_classify',
    description: 'Classify a task to L1/L2/L3 (deterministic).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['desc'],
      properties: {
        desc: { type: 'string', description: 'Task description.' },
        acceptance: { type: 'string', description: 'Optional acceptance criteria.' },
      },
    },
    output: jsonOutput(),
    execute(args) {
      const desc = String(args.desc || '')
      const acceptance = String(args.acceptance || '')
      const tokens = estimateTokens(desc)
      const lines = desc.split('\n').length
      const needsTools = /read|edit|write|run|test|fetch|search|exec|file|refactor|multi|integrat|across|tool|测试|文件|读取|写入|重构|请求|网络|运行|跑|多文件|跨文件/i.test(desc + ' ' + acceptance)
      const verifiable = /正确|返回|等于|通过|pass|assert|expect|==|断言/i.test(acceptance)
      const small = tokens <= 200 && lines <= 10 && /函数|function|return|snippet|单文件|纯函数|字段|helper/i.test(desc + ' ' + acceptance)
      const architecture = /架构|architecture|接口|设计|方案|需求|跨模块|整合|验收|模块划分|系统|final/i.test(desc)
      const reasons = []
      let tier
      if (architecture) {
        tier = 'L1'
        reasons.push('架构 / 接口 / 跨模块 / 验收类任务，归主 agent（pro）')
      } else if (needsTools || tokens > 2000 || lines > 40) {
        tier = 'L2'
        reasons.push(needsTools ? '需要工具或多文件改动' : `规模过大（${tokens} token / ${lines} 行）`)
      } else if (small) {
        tier = 'L3'
        reasons.push(`极简（${tokens} token / ${lines} 行）`)
        if (verifiable) reasons.push('有可机械验证的验收标准')
      } else {
        tier = 'L2'
        reasons.push('超出 L3 极简范围（无工具但非纯函数或偏大）')
      }
      return { tier, tokens, lines, needsTools, verifiable, reasons }
    },
  }
}

// DSH-compat / engine health check (actionable diagnosis after an upgrade).
export function makeSelftestTool(ctx, cfg, r) {
  return {
    name: 'pipeline_selftest',
    description: 'Health check: subagents / llm / L3 engine reachability.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: jsonOutput(),
    async execute() {
      const checks = []
      const add = (name, ok, detail) => checks.push({ name, ok, detail })
      const subs = ctx.get ? ctx.get('subagents') : undefined
      add('subagents service', !!subs, subs ? 'available' : 'unavailable — spawn/send will fail')
      add('subagents.startActivation', !!subs && typeof subs.startActivation === 'function', 'v84+ API (startContinuable removed)')
      add('subagents.drainChildren', !!subs && typeof subs.drainChildren === 'function', 'drain old L2s')
      const llm = ctx.get ? ctx.get('llm') : undefined
      add('llm service', !!llm, llm ? `level2 ${cfg.level2Provider}/${cfg.level2Model}` : 'unavailable — L2 decompose/review fail')
      const endpoint = String(cfg.level3Endpoint ?? '').replace(/\/$/, '')
      let engineOk = false
      let engineDetail = '未配置 level3Endpoint'
      if (endpoint) {
        try {
          const res = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(4000) })
          engineOk = res.ok
          engineDetail = `HTTP ${res.status}`
          if (res.ok) {
            const data = await res.json().catch(() => null)
            const models = Array.isArray(data?.data) ? data.data.map((m) => m.id) : []
            engineDetail += models.length ? `；模型 ${models.slice(0, 6).join(', ')}` : ''
            if (models.length && !models.includes(cfg.level3Model)) engineDetail += `；⚠️ 配置的 ${cfg.level3Model} 不在列表`
          }
        } catch (err) {
          engineDetail = `不可达：${err?.message ?? err}（本地引擎不可用时会自动降级为 L2 直写）`
        }
      }
      add('L3 engine', engineOk, engineDetail)
      const degraded = checks.filter((c) => !c.ok).map((c) => c.name)
      // v112 (B15) — `ok` used to be false whenever the optional L3 engine was
      // missing, which read as "the plugin is broken". `ready` is the real
      // verdict (all core services present); `degraded` lists optional pieces and
      // the caller decides whether that matters.
      return { ok: true, ready: degraded.length === 0, degraded, checks }
    },
  }
}

// The only exit from the milestone-acceptance hard gate.
export function makeAcceptMilestoneTool(ctx, cfg, r) {
  return {
    name: 'pipeline_accept_milestone',
    description: 'Record user acceptance of a finished milestone (unblocks the gate).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['milestoneId', 'userConfirmed'],
      properties: {
        milestoneId: { type: 'string', description: 'Milestone id.' },
        userConfirmed: { type: 'boolean', description: 'True only after the user actually accepted this milestone in chat (ask_user_question).' },
        note: { type: 'string', description: 'Optional note.' },
      },
    },
    output: jsonOutput(),
    execute(args) {
      // v104 — acceptance is a user act, not an L1 self-certification.
      if (args.userConfirmed !== true) {
        throw new Error('pipeline_accept_milestone 需要 userConfirmed:true，且只能在用户于对话中明确验收后调用（先 ask_user_question 确认）')
      }
      const ms = r.store.run?.milestones ?? []
      const m = ms.find((x) => x.id === args.milestoneId)
      if (!m) throw new Error(`unknown milestone id: ${args.milestoneId}`)
      const st = milestoneStates(r.store).find((x) => x.id === m.id)
      if (!st || st.state !== 'done') {
        throw new Error(`milestone ${m.id} 尚未完成（${st?.done ?? 0}/${st?.total ?? 0}）——先让其任务全部 done`)
      }
      m.state = 'accepted'
      m.acceptedAt = new Date().toISOString()
      m.note = args.note ?? null
      r.saveRun()
      const states = milestoneStates(r.store)
      const allAccepted = states.length > 0 && states.every((x) => x.state === 'accepted')
      return {
        ok: true,
        milestoneId: m.id,
        name: m.name,
        milestones: states,
        // Automatic handoff once the whole plan is accepted.
        ...(allAccepted ? { checkpointHint: '所有里程碑已验收。现在调 pipeline_checkpoint 把状态固化成文件（交接契约），这样下一个会话可以冷启动继续。' } : {}),
      }
    },
  }
}

// v89 — L1 tools whose render gets the live run footer (milestones / budget).

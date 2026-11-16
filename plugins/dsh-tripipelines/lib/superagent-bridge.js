// dsh-tripipelines — superagent bridge (v133, P1).
//
// deepseek-ai/dsh-superagent-prototype runs each ticket in a dedicated worker
// Session whose tool surface is an ALLOWLIST computed from its own WORK_TOOLS
// list (src/app/sessions.ts workOnly): ctx.tools.restrict({ allow }) masks the
// GLOBAL registry, so our pipeline_* tools are invisible inside worker sessions.
// The host documents that registrations made in an agent's OWN scope stay
// outside allow/deny masks (scoped visibility), which is exactly how the
// prototype registers its orchestrator_* tools — so this bridge re-registers a
// reduced pipeline surface scoped on each worker agent it recognizes.
//
// Detection is best-effort and version-guarded: no superagent installed ⇒ the
// whole module is inert (ctx.get('orchestrator') returns undefined). A future
// prototype that renames its events or fields must degrade to "no injection",
// never to a crash on boot — every probe below is wrapped for that reason.
import { homedir } from 'node:os'

import { resolveSession } from './dsh-compat.js'
import { normalizeRoot } from './workspaces.js'
import { makeLockTool, makePlanTool, makeStatusTool, makeCheckpointTool, makeAcceptMilestoneTool } from './tools/l1.js'
import { makeDecomposeTool, makeExecuteLocalTool, makeExecuteBatchTool, makeReviewTool, makeSpawnLocalExecutorTool, makeRegisterOutputTool } from './tools/l2l3.js'

const WINDOWS = process.platform === 'win32'

// Worker sessions carry the prototype's role preset id (WORKER_PRESET in
// src/app/sessions.ts). Match on the preset first; fall back to the session
// label convention only when the host exposes no preset field.
const PRESET_RE = /superagent.*worker|worker.*superagent/i
const LABEL_RE = /^worker-/i

// The injected surface is deliberately smaller than the global one: a worker IS
// the L1 of its ticket (its cwd is the ticket dir, which doubles as the project
// root our registry keys on), but L2 leads would run under the router preset
// with the interactive tool set and no ticket guard — so delegation stays with
// the prototype and the pipeline contributes planning + gates + local execution.
const BRIDGE_TOOL_NAMES = new Set([
  'pipeline_lock_requirements',
  'pipeline_plan',
  'pipeline_status',
  'pipeline_decompose',
  'pipeline_execute_local',
  'pipeline_execute_batch',
  'pipeline_review',
  'pipeline_spawn_local_executor',
  'pipeline_register_output',
  'pipeline_checkpoint',
  'pipeline_accept_milestone',
])

function buildBridgeTools(ctx, cfg, r) {
  return [
    makeLockTool(ctx, cfg, r),
    makePlanTool(ctx, cfg, r),
    makeStatusTool(ctx, cfg, r),
    makeDecomposeTool(ctx, cfg, r),
    makeExecuteLocalTool(ctx, cfg, r),
    makeExecuteBatchTool(ctx, cfg, r),
    makeReviewTool(ctx, cfg, r),
    makeSpawnLocalExecutorTool(ctx, cfg, r),
    makeRegisterOutputTool(ctx, cfg, r),
    makeCheckpointTool(ctx, cfg, r),
    makeAcceptMilestoneTool(ctx, cfg, r),
  ]
}

// One bridge per plugin load. `registry` is the workspace registry from
// plugin.js; we reuse its stores so a ticket workspace shares board/state with
// any interactive session opened in the same directory.
export function installSuperagentBridge(ctx, cfg, registry, log = (m) => console.log(m)) {
  // The prototype's Runtime instance surfaces as ctx.orchestrator (its own
  // source subpackages use it the same way); ctx.get stays as fallback.
  let orchestrator = null
  try {
    orchestrator = ctx.orchestrator ?? (typeof ctx.get === 'function' ? ctx.get('orchestrator') : undefined)
  } catch { /* service absent */ }
  if (!orchestrator) return null // no superagent in this profile: stay inert

  const injected = new Map() // agentId -> disposer[]

  const looksLikeWorker = (session) => {
    try {
      const preset = String(session?.header?.config?.agentPreset ?? '')
      if (preset && PRESET_RE.test(preset)) return true
      const title = String(session?.header?.title ?? '')
      if (title && LABEL_RE.test(title)) return true
    } catch { /* malformed header: not a worker */ }
    return false
  }

  const ticketRoot = (session) => {
    // The prototype's env hint DSH_SUPERAGENT_DIR is PER-TICKET and only exists
    // inside the worker's own tool processes — reading it at plugin scope would
    // route every session to one stale directory. Session cwd is the truth:
    // sessions.ensure() creates the workspace from the ticket dir itself.
    try {
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd.trim()) {
        // v133 — NO walk-up here: findProjectRoot climbs to .git/.dsh markers,
        // which for a scratch ticket under the home tree resolves to $HOME and
        // then trips the home guard below. The ticket dir IS the workspace root
        // the prototype created (sessions.ensure -> workspaceRegistry.create).
        const key = normalizeRoot(cwd)
        if (key) return key
      }
    } catch { /* no cwd yet */ }
    return null
  }

  const injectInto = (source, why) => {
    let session = null
    try { session = resolveSession(ctx, source) } catch { return }
    if (!session || !looksLikeWorker(session)) return
    const agentId = String(session.agent?.id ?? session.id ?? '')
    if (!agentId || injected.has(agentId)) return
    const key = ticketRoot(session)
    if (!key) return
    // A ticket dir without a project marker still gets a store (plain folder is
    // a valid workspace); but the HOME directory itself and its bare ancestors
    // are never ticket roots — only reject those, not real subdirectories.
    const home = (() => { try { return normalizeRoot(homedir()) } catch { return null } })()
    if (home && key === home) return

    let entry = null
    try {
      entry = registry.ensure ? registry.ensure(key) : null
    } catch { return }
    if (!entry) return

    const disposers = []
    // v133 — the worker's tier must resolve as 'l1' in the global adjacency
    // guard: registry.tierOf consults agents.roots() first (a worker session is
    // NOT a root — it has its own preset), then falls through to the spawn
    // records keyed by AGENT id. Record one marker per agent under its own id
    // (same kind:'l1' shape lock_requirements writes for level1_main) and bind
    // childRoot so tool calls land on this workspace's store. That makes
    // pipeline_review / register_output legal for the worker while L2-style
    // tools stay denied.
    try {
      if (!entry.r.store.agents.has(agentId)) {
        entry.r.store.agents.set(agentId, {
          id: agentId,
          kind: 'l1',
          state: 'in_progress',
          label: `worker-${String(session.id ?? agentId).slice(0, 8)}`,
          via: 'bridge',
          model: null,
          scopeDir: key,
          estimatedTokens: 0,
        })
        entry.r.snapshotBoard?.()
      }
      entry.r.bindChild?.(agentId)
    } catch { /* older store shape: guard fails closed, which is safe */ }

    for (const t of buildBridgeTools(ctx, entry.cfg || cfg, entry.r)) {
      if (!BRIDGE_TOOL_NAMES.has(t.name)) continue
      try {
        // Scoped registration on THIS agent's context: survives their restrict
        // (host docs: caller-scope registrations are outside allow/deny masks).
        const d = (session.agent?.ctx ?? ctx).tools.register({
          ...t,
          description: `${t.description}（superagent bridge v133：本会话是工单 worker，这里你就是该工单的 L1；L2 负责人由编排器负责，不要调用 pipeline_spawn_module_lead）`,
        })
        if (d) disposers.push(d)
      } catch (err) {
        log(`[pipeline] superagent bridge: 注册 ${t.name} 失败（${err?.message ?? err}），跳过该工具`)
      }
    }
    if (disposers.length) {
      injected.set(agentId, disposers)
      log(`[pipeline] superagent bridge: 已注入 ${disposers.length} 个流水线工具到 worker 会话 ${agentId.slice(0, 8)}（${why}）`)
    }
  }

  // Primary hook: the prototype decorates worker sessions via ctx.on('agent/created').
  // Our listener added later runs after theirs, so restrict is already applied —
  // and scoped registrations bypass it anyway. If event ordering ever flips,
  // scoped visibility keeps working regardless.
  let unhookCreate = null
  try {
    unhookCreate = ctx.on?.('agent/created', (payload) => {
      try { injectInto(payload?.agent ?? payload, 'agent/created') } catch { /* never break their decorate flow */ }
    })
  } catch { /* event ext missing */ }

  // Safety net for sessions created before our load (profile restart order can
  // put superagent first): scan existing sessions once, then on each new ticket
  // via the sessions service if present.
  void (async () => {
    try {
      const sessions = ctx.get?.('sessions')
      if (!sessions || typeof sessions.list !== 'function') return
      const all = await sessions.list()
      const list = Array.isArray(all) ? all : (all?.sessions ?? [])
      for (const s of list) {
        injectInto({ session: s }, 'startup-scan')
      }
    } catch { /* older hosts without list(): startup-scan skipped */ }
  })()

  return {
    active: () => injected.size,
    dispose() {
      try { unhookCreate?.() } catch { /* best-effort */ }
      for (const ds of injected.values()) for (const d of ds) { try { d.dispose?.() ?? d() } catch { /* ignore */ } }
      injected.clear()
    },
  }
}

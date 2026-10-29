// GUI status board (v92): a read-only JSON snapshot of the run, served over HTTP so
// client.js can poll it. Without webServer the route is simply not registered.
import { milestoneStates } from './store.js'
import { measureLevel1Context } from './dsh-compat.js'
import { numCfg } from './util.js'

const BUILD_TAG = 'v107'

function clip(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// Real L2 context pressure, zero extra tokens: a live L2 is an Agent here, so
// tokenMeter.measure(session) replays its own log locally. Falls back to the
// spawn-time estimate when the lead is drained or the services are missing.
// v101b: the GUI polls every 2.5s and measure() replays a whole session log, so
// cache the hit briefly (successes only — misses stay cheap and retry next poll).
const AGENT_TTL_MS = 1500
const agentTokenCache = new Map()
export function measureAgentTokens(ctx, sessionId) {
  if (!sessionId) return undefined
  const now = Date.now()
  const hit = agentTokenCache.get(sessionId)
  if (hit && now - hit.at < AGENT_TTL_MS) return hit.value
  let value
  try {
    const agents = ctx?.get ? ctx.get('agents') : undefined
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    const session = agent?.session ?? agent?.context?.session
    const meter = session && ctx?.get ? ctx.get('tokenMeter') : undefined
    if (session && meter && typeof meter.measure === 'function') {
      const measurement = meter.measure(session)
      // v101c: surfaceTokens is the context the model actually sees right now;
      // totalTokens is the cumulative session log (includes replaced history).
      const total = Number(measurement?.surfaceTokens ?? measurement?.totalTokens)
      if (Number.isFinite(total) && total > 0) value = total
    }
  } catch {
    value = undefined
  }
  if (value !== undefined) agentTokenCache.set(sessionId, { at: now, value })
  return value
}

export function buildBoardSnapshot(r, cfg, measureTokens) {
  const store = r.store
  const run = store.run ?? { status: 'idle' }
  const milestones = milestoneStates(store).map((m) => ({ id: m.id, name: m.name, state: m.state, done: m.done, total: m.total }))
  const tasks = [...store.tasks.values()].map((t) => ({
    id: t.id,
    desc: clip(t.desc, 120),
    assignee: t.assignee ?? '',
    state: t.state ?? 'pending',
  }))
  const agents = [...store.agents.values()]
    .filter((a) => a && a.kind === 'l2')
    .map((a) => {
      // Cache the live reading on the record so a finished lead keeps its truth.
      let measured = null
      let live = false
      if (typeof measureTokens === 'function') {
        const value = measureTokens(a.id)
        if (Number.isFinite(value) && value > 0) {
          measured = value
          a.tokens = value
          live = true
        }
      }
      if (measured === null && Number.isFinite(Number(a.tokens)) && Number(a.tokens) > 0) measured = Number(a.tokens)
      // measured=false tells the client to label an estimate with 估.
      return {
        id: a.id,
        label: a.label ?? '',
        state: a.state ?? 'in_progress',
        model: a.model ?? '',
        scopeDir: a.scopeDir ?? null,
        estimatedTokens: Number(a.estimatedTokens) || 0,
        tokens: measured,
        measured: live,
      }
    })
  const subtasks = [...store.subtasks.values()]
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    run: {
      id: run.id ?? null,
      status: run.status ?? 'idle',
      paused: run.paused === true,
      pauseReason: run.pauseReason ?? null,
      startedAt: run.startedAt ?? null,
      activation: run.activation ?? 'unknown',
      requirement: store.requirement ? clip(store.requirement, 200) : null,
    },
    milestones,
    tasks,
    agents,
    subtasks: {
      total: subtasks.length,
      done: subtasks.filter((s) => s.state === 'done').length,
      failed: subtasks.filter((s) => s.state === 'failed').length,
    },
    budget: {
      tokensUsed: Number(run.tokensUsed) || 0,
      maxTokens: numCfg(cfg, 'maxTotalTokensPerRun', 0),
      maxDurationMs: numCfg(cfg, 'maxDurationPerRun', 0),
      maxFiles: numCfg(cfg, 'maxFilesPerRun', 0),
      filesTouched: Array.isArray(run.filesTouched) ? run.filesTouched.length : 0,
    },
    counters: {
      l2Spawns: store.counters?.l2Spawns ?? 0,
      l2Sends: store.counters?.l2Sends ?? 0,
      l3Calls: store.counters?.l3Calls ?? 0,
      tokensIn: store.counters?.tokensIn ?? 0,
      tokensOut: store.counters?.tokensOut ?? 0,
    },
    // Window pressure per level for the UI bar (sweet / transition / danger zones).
    // level1 is the model the user picked for this chat, not a plugin default.
    context: {
      models: {
        level1: store.context?.level1Model || cfg?.level1Model || '',
        level2: cfg?.level2Model ?? '',
      },
      level1: {
        tokens: Number(store.context?.level1Tokens) || 0,
        budget: Number(cfg?.level1ContextBudget) || 0,
        // Past the danger line the model's effective capability degrades hard.
        danger: Number(cfg?.level1DangerBudget) || 0,
        window: Number(cfg?.level1ContextWindow) || 0,
      },
      level2: {
        tokens: agents.length
          ? Math.max(...agents.map((a) => Number(a.tokens ?? a.estimatedTokens) || 0))
          : 0,
        budget: Number(cfg?.level2ContextBudget) || 0,
        danger: Number(cfg?.level2DangerBudget) || 0,
        window: Number(cfg?.level2ContextWindow) || 0,
      },
    },
    recentEvents: store.messages.slice(-6).map((m) => ({
      type: m?.message_type ?? 'event',
      sender: m?.sender ?? '',
      text: clip(m?.task_conclusion || m?.task_desc || m?.message_type, 90),
    })),
  }
}

// v106 — a fresh daemon (or a workspace that has not called any pipeline_* tool
// yet) has no store at all. The GUI card polls every 2.5s, so answering 404 here
// made the whole card vanish after every restart. Return a normal "idle" payload
// instead; the client renders its muted 待命 state and the card stays in place.
export function idleBoardSnapshot(cfg, stores) {
  const num = (v) => Number(v) || 0
  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    run: {
      id: null,
      status: 'idle',
      paused: false,
      pauseReason: null,
      startedAt: null,
      activation: 'unknown',
      requirement: null,
    },
    milestones: [],
    tasks: [],
    agents: [],
    subtasks: { total: 0, done: 0, failed: 0 },
    budget: {
      tokensUsed: 0,
      maxTokens: numCfg(cfg, 'maxTotalTokensPerRun', 0),
      maxDurationMs: numCfg(cfg, 'maxDurationPerRun', 0),
      maxFiles: numCfg(cfg, 'maxFilesPerRun', 0),
      filesTouched: 0,
    },
    counters: { l2Spawns: 0, l2Sends: 0, l3Calls: 0, tokensIn: 0, tokensOut: 0 },
    context: {
      models: { level1: cfg?.level1Model || '', level2: cfg?.level2Model ?? '' },
      level1: {
        tokens: 0,
        budget: num(cfg?.level1ContextBudget),
        danger: num(cfg?.level1DangerBudget),
        window: num(cfg?.level1ContextWindow),
      },
      level2: {
        tokens: 0,
        budget: num(cfg?.level2ContextBudget),
        danger: num(cfg?.level2DangerBudget),
        window: num(cfg?.level2ContextWindow),
      },
    },
    recentEvents: [],
    debug: {
      build: BUILD_TAG,
      workspace: null,
      stateDir: null,
      cwd: process.cwd(),
      stores: Number(stores) || 0,
      idle: true,
    },
  }
}

// Register the read-only route; returns a disposer (no-op without webServer).
// On a profile cold start apply() can run BEFORE webServer exists, so a missing
// service must not mean "give up": inject on it, and fall back to 'ready'.
// v103 — `source` may be the workspace registry (per-workspace stores) or a
// legacy single store; the handler never re-homes anything and always builds the
// snapshot BEFORE writing the status line.
export function installBoardRoute(ctx, source, cfg) {
  const registry = source && typeof source.entryForRoute === 'function' ? source : null
  const legacyR = registry ? null : source
  const register = (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') return () => {}
    try {
      return webServer.register({
        kind: 'exact',
        path: '/pipeline/board',
        handler: (req, res) => {
          try {
            let r
            let workspaceKey = null
            if (registry) {
              let qs = ''
              try {
                const u = String(req?.url ?? '')
                const i = u.indexOf('?')
                if (i >= 0) qs = u.slice(i + 1)
              } catch { qs = '' }
              const picked = registry.entryForRoute(qs)
              if (picked && picked.idle) {
                const snap = idleBoardSnapshot(cfg, registry.size())
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify(snap))
                return
              }
              if (!picked || picked.error || !picked.entry) {
                res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(JSON.stringify({ ok: false, error: picked?.error ?? 'no workspace state yet' }))
                return
              }
              r = picked.entry.r
              workspaceKey = picked.entry.key
            } else {
              r = legacyR
            }
            if (!r || !r.store) {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: 'no board store' }))
              return
            }
            try {
              if (r.store.tasks.size === 0 && typeof r.reloadFromDisk === 'function') r.reloadFromDisk()
            } catch {
              // best-effort — fall through with the in-memory store
            }
            // Refresh the L1 reading on every poll (local meter, zero tokens).
            try {
              const src = r.lastSession ? { session: r.lastSession } : undefined
              const m = measureLevel1Context(ctx, src, cfg)
              if (m && typeof m.totalTokens === 'number') {
                r.store.context = { ...(r.store.context || {}), level1Tokens: m.totalTokens }
              }
            } catch {
              // best-effort — keep the cached reading
            }
            // v103 — build first: a throwing snapshot must not leave a 200 header
            // already on the wire (ERR_HTTP_HEADERS_SENT).
            const snap = buildBoardSnapshot(r, cfg, (id) => measureAgentTokens(ctx, id))
            snap.debug = {
              build: BUILD_TAG,
              workspace: workspaceKey,
              stateDir: r?.store?.stateDir ?? null,
              cwd: process.cwd(),
              stores: registry ? registry.size() : 1,
            }
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(snap))
          } catch (err) {
            try {
              if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            } catch { /* headers already sent */ }
            try { res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) })) } catch { /* closed */ }
          }
        },
      })
    } catch (err) {
      // v101b: a silent failure here is exactly the "dashboard is 404" bug the user
      // hit once — surface it in the host log instead of failing invisibly.
      try { console.warn(`[pipeline] board route registration failed: ${err?.message ?? err}`) } catch { /* no console */ }
      return () => {}
    }
  }

  // Fast path: the web server is already up (runtime install / bundle reload).
  try {
    const now = ctx?.get ? ctx.get('webServer') : undefined
    if (now) return register(now)
  } catch { /* fall through to late registration */ }

  const disposers = []
  let registered = null
  const registerOnce = (sub) => {
    if (registered) return
    try {
      const webServer = sub?.get ? sub.get('webServer') : undefined
      if (webServer) registered = register(webServer)
    } catch { /* soft capability */ }
  }

  // Late path 1: cordis dependency injection — fires when webServer appears.
  try {
    if (typeof ctx?.inject === 'function') {
      let handle
      try {
        handle = ctx.inject(['webServer'], (sub) => registerOnce(sub))
      } catch { handle = undefined }
      if (handle && typeof handle.dispose === 'function') {
        disposers.push(() => {
          try { handle.dispose() } catch { /* best-effort */ }
        })
      }
    }
  } catch { /* soft capability */ }

  // Late path 2: the profile 'ready' event (covers hosts where a late-injected
  // service does not re-run the callback).
  try {
    if (typeof ctx?.on === 'function') {
      const off = ctx.on('ready', () => registerOnce(ctx))
      if (typeof off === 'function') disposers.push(off)
    }
  } catch { /* soft capability */ }

  return () => {
    try { registered?.() } catch { /* best-effort */ }
    for (const d of disposers) {
      try { d() } catch { /* best-effort */ }
    }
  }
}

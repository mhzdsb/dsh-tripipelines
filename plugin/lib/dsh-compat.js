// dsh-pipeline — DSH compatibility helpers: best-effort session resolution and
// L1 context pressure measurement (tokenMeter). Kept in one place so a DSH
// service-API change only ever touches this file.
export function resolveSession(ctx, source) {
  try {
    const candidates = [
      source && source.session,
      source && source.agent && source.agent.session,
      source && source.agent,
    ]
    for (const c of candidates) {
      if (c && typeof c.requestHeader === 'function' && c.surface) return c
    }
    const sessions = ctx && ctx.get ? ctx.get('sessions') : undefined
    if (sessions && typeof sessions.get === 'function') {
      const agent = source && source.agent
      const id = agent && (agent.id ?? agent.sessionId)
      if (id) {
        const s = sessions.get(id)
        if (s) return s
      }
      if (typeof sessions.list === 'function') {
        const all = sessions.list()
        if (all && all.length === 1) return all[0]
      }
    }
  } catch {
    // best-effort; measurement is optional
  }
  return undefined
}

// v92.1 / v93 — workspace root: the session header's absolute cwd (the user's
// project). The daemon's process.cwd() is the DSH profile directory, never the
// project, so returning undefined here is meaningful ("no workspace known yet").
export function resolveWorkspaceRoot(ctx, source) {
  try {
    const sess = resolveSession(ctx, source)
    const cwd = sess && sess.header && sess.header.cwd
    if (typeof cwd === 'string' && cwd.trim()) return cwd
  } catch {
    // best-effort; the caller decides the fallback
  }
  return undefined
}

// v95 — the L1 model is NOT a plugin setting: it is whatever model the user picked
// for the current chat. DSH exposes it through the session's request context
// (provider + model); config.level1Model is only a fallback for the sweet-spot
// profile lookup. Reading the real one keeps the board and docs from telling users
// that "L1 must be pro".
export function resolveSessionModel(ctx, source) {
  try {
    const sess = resolveSession(ctx, source)
    if (!sess) return undefined
    const rc = typeof sess.requestContext === 'function' ? sess.requestContext() : undefined
    if (rc && typeof rc.model === 'string' && rc.model.trim()) {
      return {
        provider: typeof rc.provider === 'string' ? rc.provider : '',
        model: rc.model.trim(),
        contextWindow: Number(rc.contextWindow) || 0,
      }
    }
    const header = typeof sess.requestHeader === 'function' ? sess.requestHeader() : undefined
    const config = header && header.config
    if (config && typeof config.model === 'string' && config.model.trim()) {
      return {
        provider: typeof config.provider === 'string' ? config.provider : '',
        model: config.model.trim(),
        contextWindow: 0,
      }
    }
  } catch {
    // best-effort; callers fall back to config
  }
  return undefined
}

// Measure the L1 context token pressure via DSH's tokenMeter (deterministic,
// no LLM call). Returns null when the meter or the session is unavailable.
// v101b: the GUI polls the board every few seconds and measure() replays the
// session log, so cache the raw count briefly instead of replaying per poll.
const METER_TTL_MS = 1500
const meterCache = new Map()
// v101d: surfaceTokens still counts every historical node the proxy has since
// compacted away (a long chat measures ~2.1M on a 128K model), so it is useless
// as "context pressure". Approximate the live window instead: price the most
// recent surface events. Cheap — no session-log replay, no measure() call.
const TAIL_EVENTS = 40
const SURFACE_EVENT_TYPES = new Set([
  'system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result',
])
function tailSurfaceTokens(session, meter) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return 0
    const seq = Number(session.seq) || 0
    const events = session.snapshotEvents(Math.max(0, seq - TAIL_EVENTS)) || []
    let sum = 0
    for (const ev of events) {
      if (!ev || !SURFACE_EVENT_TYPES.has(ev.type)) continue
      let msg = null
      try {
        if (typeof session.deriveEventMessage === 'function') msg = session.deriveEventMessage(ev)
      } catch {
        msg = null
      }
      if (!msg) continue
      const n = typeof meter.estimateMessage === 'function' ? Number(meter.estimateMessage(msg)) : 0
      if (Number.isFinite(n) && n > 0) sum += n
    }
    return sum
  } catch {
    return 0
  }
}
export function measureLevel1Context(ctx, source, cfg) {
  try {
    const meter = ctx && ctx.get ? ctx.get('tokenMeter') : undefined
    if (!meter || typeof meter.estimateMessage !== 'function') return null
    const session = resolveSession(ctx, source)
    if (!session) return null
    const key = String(session.id ?? 'l1')
    const now = Date.now()
    const hit = meterCache.get(key)
    let totalTokens
    if (hit && now - hit.at < METER_TTL_MS) totalTokens = hit.tokens
    else {
      totalTokens = tailSurfaceTokens(session, meter)
      meterCache.set(key, { at: now, tokens: totalTokens })
    }
    const budget = Number(cfg.level1ContextBudget) || 64000
    const ratio = budget > 0 ? totalTokens / budget : 0
    const warnRatio = Number(cfg.level1ContextWarnRatio) > 0 ? Number(cfg.level1ContextWarnRatio) : 0.8
    const warning = ratio >= warnRatio
      ? `L1 上下文已到 ${Math.round(ratio * 100)}%（${totalTokens}/${budget}，阈值 ${Math.round(warnRatio * 100)}%），建议 checkpoint 交接`
      : null
    return { totalTokens, budget, ratio: Number(ratio.toFixed(3)), warnRatio, warning }
  } catch {
    return null
  }
}

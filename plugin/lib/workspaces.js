// dsh-pipeline — per-workspace store registry (v103).
//
// Before v103 a single process-wide store was re-homed on every tool call
// (`r.alignTo`): whichever workspace called last owned the global `stateDir`,
// so two projects in one daemon overwrote each other's lock/board/run. The
// registry below keys one store per normalized workspace root and keeps it
// fixed from creation. Resolution order:
//
//   1. child map   — a subagent we spawned (L2/L3) -> its parent's workspace key
//   2. session cwd — header.cwd of the calling session
//   3. walk-up     — nearest ancestor with `.dsh/pipeline` or `.git` (<= 32)
//   4. cwd itself  — non-repo projects still get their own state
//
// Creation is lazy: nothing is created or read until a tool/command/board
// request actually names a workspace. No token is spent here: restoring a
// store is local file I/O only.
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { createStore } from './store.js'
import { resolveSession } from './dsh-compat.js'

const WINDOWS = process.platform === 'win32'
const MAX_WALK = 32

// Normalize a path into a stable registry key: absolute, symlink-resolved,
// lowercased on Windows, no trailing separator.
export function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  let abs = resolve(value)
  try { abs = realpathSync.native(abs) } catch { /* keep the resolved path */ }
  if (WINDOWS) abs = abs.toLowerCase()
  abs = abs.replace(/[\\/]+$/, '')
  if (!abs) abs = WINDOWS ? 'c:' : '/'
  return abs
}

// Nearest ancestor that is a project root (git repo or an existing pipeline
// state dir). Falls back to the cwd itself so a plain folder still works.
export function findProjectRoot(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  let dir = resolve(cwd)
  for (let i = 0; i < MAX_WALK; i++) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.dsh', 'pipeline'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(cwd)
}

function sessionOf(ctx, source) {
  try { return resolveSession(ctx, source) } catch { return undefined }
}

function agentIdOf(source) {
  const agent = source && (source.agent || (source.session && source.session.agent))
  const id = agent && agent.id
  return id == null ? null : String(id)
}

export function createWorkspaceRegistry({ ctx, cfg, buildTools, log }) {
  const entries = new Map()
  const childRoot = new Map()
  let lastActiveKey = null

  function keyFor(source) {
    const sess = sessionOf(ctx, source)
    const id = sess && sess.id != null ? String(sess.id) : agentIdOf(source)
    if (id && childRoot.has(id)) return childRoot.get(id)
    const cwd = sess && sess.header && sess.header.cwd
    if (typeof cwd === 'string' && cwd.trim()) {
      const root = findProjectRoot(cwd)
      const key = normalizeRoot(root)
      if (key) return key
    }
    return null
  }

  function ensure(key) {
    let entry = entries.get(key)
    if (entry) return entry
    const r = createStore(cfg, { root: key })
    // A subagent's session cwd is its scopeDir (e.g. dev/module), not the
    // project root; record the mapping at spawn time so its tool calls land in
    // the parent workspace instead of creating dev/module/.dsh.
    r.bindChild = (childId) => {
      if (childId != null) childRoot.set(String(childId), key)
    }
    const list = buildTools(r)
    const tools = new Map((Array.isArray(list) ? list : []).map((tool) => [tool.name, tool]))
    entry = { key, root: r.store.workspaceRoot || key, r, tools }
    entries.set(key, entry)
    if (typeof log === 'function') log(`[pipeline] workspace store ready: ${entry.root}`)
    return entry
  }

  function resolve(source) {
    const key = keyFor(source)
    if (!key) return null
    const entry = ensure(key)
    if (typeof entry.r.bindSession === 'function') entry.r.bindSession(ctx, source)
    lastActiveKey = key
    return entry
  }

  // Read-only lookup for guards: never creates a store.
  function peek(source) {
    const key = keyFor(source)
    return key ? entries.get(key) ?? null : null
  }

  function bindChild(childId, key) {
    if (childId != null && key) childRoot.set(String(childId), key)
  }

  // Explicit role detection: roots() is the authority when the service exists;
  // otherwise fall back to our own spawn records, then 'unknown'.
  function tierOf(source) {
    const id = agentIdOf(source) || (() => {
      const sess = sessionOf(ctx, source)
      return sess && sess.id != null ? String(sess.id) : null
    })()
    if (!id) return 'unknown'
    try {
      const agents = ctx && ctx.get ? ctx.get('agents') : undefined
      if (agents && typeof agents.roots === 'function') {
        const roots = agents.roots()
        if (Array.isArray(roots) && roots.length > 0) {
          return roots.some((a) => a && a.id != null && String(a.id) === id) ? 'l1' : 'child'
        }
      }
    } catch { /* fall through to records */ }
    for (const entry of entries.values()) {
      const rec = entry.r.store.agents.get(id)
      if (rec && rec.kind) return rec.kind
    }
    if (childRoot.has(id)) return 'child'
    return 'unknown'
  }

  // Route selection: explicit ?workspace=<path|key> must already exist; the
  // default is the workspace that called a pipeline tool most recently.
  function entryForRoute(rawQuery) {
    let wanted = null
    try {
      const qs = typeof rawQuery === 'string' ? rawQuery : ''
      wanted = new URLSearchParams(qs).get('workspace')
    } catch { wanted = null }
    if (wanted) {
      const key = normalizeRoot(wanted) || String(wanted).trim().toLowerCase()
      const entry = entries.get(key)
      if (entry) {
        lastActiveKey = key
        return { entry }
      }
      return { error: `no pipeline state for workspace: ${wanted}` }
    }
    if (lastActiveKey && entries.has(lastActiveKey)) return { entry: entries.get(lastActiveKey) }
    const all = [...entries.values()]
    if (all.length === 1) return { entry: all[0] }
    // v106: a daemon that just restarted has no store for any workspace yet. That
    // is an empty state, not an error — the GUI card must stay visible. Callers
    // render an idle snapshot for it.
    if (all.length === 0) return { idle: true }
    return { error: 'no active workspace yet — call any pipeline_* tool first' }
  }

  return {
    keyFor,
    resolve,
    peek,
    bindChild,
    tierOf,
    entryForRoute,
    lastActive: () => lastActiveKey,
    size: () => entries.size,
    keys: () => [...entries.keys()],
  }
}

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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { createStore } from './store.js'
import { resolveSession } from './dsh-compat.js'

const WINDOWS = process.platform === 'win32'
const MAX_WALK = 32
const MAX_KNOWN = 32

// v108 — the board card can switch workspaces. The registry remembers every
// project it has served (paths only, never content) so the switcher survives a
// daemon restart. This file is plain local I/O and spends zero tokens.
export const DEFAULT_KNOWN_FILE = join(homedir(), '.dsh', 'pipeline', 'workspaces.json')

function readKnown(file) {
  const out = new Map()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(raw && raw.workspaces) ? raw.workspaces : []
    for (const item of list) {
      if (!item || typeof item.key !== 'string') continue
      const key = normalizeRoot(item.key)
      if (!key) continue
      out.set(key, { key, lastActive: Number(item.lastActive) || 0 })
    }
  } catch {
    // first run or a corrupt file — start empty, never fail the plugin
  }
  return out
}

function writeKnown(file, known) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const list = [...known.values()]
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, MAX_KNOWN)
      .map(({ key, lastActive }) => ({ key, lastActive }))
    writeFileSync(file, JSON.stringify({ version: 1, workspaces: list }, null, 2))
  } catch {
    // best-effort: a read-only profile must not break workspace routing
  }
}

function nameOf(key) {
  const base = basename(key)
  return base || key
}

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

export function createWorkspaceRegistry({ ctx, cfg, buildTools, log, knownFile = DEFAULT_KNOWN_FILE }) {
  const entries = new Map()
  const childRoot = new Map()
  const known = readKnown(knownFile)
  let lastActiveKey = null
  let lastPersist = 0

  // Remember this project for the board switcher (path only, never content).
  function record(key) {
    const prev = known.get(key)
    known.set(key, { key, lastActive: Date.now() })
    const now = Date.now()
    if (!prev || now - lastPersist > 1000) {
      lastPersist = now
      writeKnown(knownFile, known)
    }
  }

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
    record(key)
    if (typeof log === 'function') log(`[pipeline] workspace store ready: ${entry.root}`)
    return entry
  }

  function resolve(source) {
    const key = keyFor(source)
    if (!key) return null
    const entry = ensure(key)
    if (typeof entry.r.bindSession === 'function') entry.r.bindSession(ctx, source)
    if (lastActiveKey !== key) record(key)
    lastActiveKey = key
    return entry
  }

  // Read-only lookup for guards: never creates a store.
  function peek(source) {
    const key = keyFor(source)
    return key ? entries.get(key) ?? null : null
  }

  // Known workspaces, newest first, for the board switcher. Only paths that
  // still exist are offered; a deleted project silently drops out.
  function listKnown() {
    const keys = new Set([...entries.keys(), ...known.keys()])
    const out = []
    for (const key of keys) {
      try {
        if (!existsSync(key)) continue
      } catch {
        continue
      }
      out.push({ key, root: key, name: nameOf(key), lastActive: known.get(key)?.lastActive ?? 0 })
    }
    out.sort((a, b) => b.lastActive - a.lastActive)
    return out.slice(0, MAX_KNOWN)
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

  // Route selection: explicit ?workspace=<path|key> may name a workspace this
  // daemon has not loaded yet (the switcher does exactly that) — load it from
  // disk. The default is the workspace that called a pipeline tool most
  // recently, then the newest known project.
  function entryForRoute(rawQuery) {
    let wanted = null
    try {
      const qs = typeof rawQuery === 'string' ? rawQuery : ''
      wanted = new URLSearchParams(qs).get('workspace')
    } catch { wanted = null }
    if (wanted) {
      const key = normalizeRoot(wanted) || String(wanted).trim().toLowerCase()
      let entry = key ? entries.get(key) : null
      if (!entry && key && known.has(key)) {
        try {
          if (existsSync(key)) entry = ensure(key)
        } catch { /* fall through to error */ }
      }
      if (entry) {
        lastActiveKey = entry.key
        record(entry.key)
        return { entry }
      }
      return { error: `no pipeline state for workspace: ${wanted}` }
    }
    if (lastActiveKey && entries.has(lastActiveKey)) return { entry: entries.get(lastActiveKey) }
    const all = [...entries.values()]
    if (all.length === 1) return { entry: all[0] }
    if (all.length === 0) {
      const recent = listKnown()[0]
      if (recent) {
        const entry = ensure(recent.key)
        lastActiveKey = recent.key
        return { entry }
      }
      // v106: a daemon that just restarted has no store for any workspace yet. That
      // is an empty state, not an error — the GUI card must stay visible. Callers
      // render an idle snapshot for it.
      return { idle: true }
    }
    return { error: 'no active workspace yet — call any pipeline_* tool first' }
  }

  return {
    keyFor,
    resolve,
    peek,
    bindChild,
    tierOf,
    entryForRoute,
    listKnown,
    lastActive: () => lastActiveKey,
    size: () => entries.size,
    keys: () => [...entries.keys()],
  }
}

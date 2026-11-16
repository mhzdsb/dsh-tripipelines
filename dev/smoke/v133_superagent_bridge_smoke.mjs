// v133 smoke: superagent bridge (P1 fusion) — detection, scoped injection, tier
// marker, store sharing, and the inert path when no orchestrator service exists.
// Mirrors dev/smoke/v133_superagent_bridge_smoke.mjs. Runs offline with stubs;
// never touches the real ~/.dsh.
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const repoRoot = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const pkgRoot = existsSync(join(repoRoot, 'client.js')) ? repoRoot : join(repoRoot, 'plugins', 'dsh-tripipelines')

let passed = 0
let failed = 0
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}`) }
}

const { installSuperagentBridge } = await import(pathToFileURL(join(pkgRoot, 'lib', 'superagent-bridge.js')).href)
const { createWorkspaceRegistry } = await import(pathToFileURL(join(pkgRoot, 'lib', 'workspaces.js')).href)
const { DEFAULT_CONFIG } = await import(pathToFileURL(join(pkgRoot, 'lib', 'config.js')).href)

const root = join(tmpdir(), `sa-bridge-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const cfg = { ...DEFAULT_CONFIG, stateDir: join(root, 'global-state'), semanticGateThreshold: 0.5, activationGate: false }

function makeFakeCtx({ orchestrator = null, worker = true }) {
  const events = new Map()
  const globalRegistered = []
  const agentScoped = new Map() // agentId -> registered[]
  const sessions = new Map()
  const ctx = {
    get(name) {
      if (name === 'orchestrator') return orchestrator
      if (name === 'sessions') return { get: (id) => sessions.get(id), list: async () => [...sessions.values()] }
      if (name === 'agents') return { roots: () => [] } // workers are NOT roots
      return undefined
    },
    on(ev, fn) { events.set(ev, fn); return () => events.delete(ev) },
    tools: { register(t) { globalRegistered.push(t); return { dispose() {} } }, guard() { return () => {} } },
    skills: { register() {} },
    systemPrompt: { section() {} },
    commands: { register() {} },
    __events: events,
    __global: globalRegistered,
    __scoped: agentScoped,
    __sessions: sessions,
  }
  const ticketDir = join(root, 'work', 'ticket-42')
  mkdirSync(ticketDir, { recursive: true })
  const agentId = `agent-${randomUUID().slice(0, 8)}`
  const session = {
    id: `sess-${agentId}`,
    header: {
      cwd: ticketDir,
      title: worker ? 'worker-ticket-42' : 'interactive chat',
      config: worker ? { agentPreset: 'dsh-superagent-worker' } : {},
    },
    requestHeader: () => ({ cwd: ticketDir }),
    surface: {},
    agent: {
      id: agentId,
      ctx: {
        tools: { register(t) { const arr = agentScoped.get(agentId) ?? []; arr.push(t); agentScoped.set(agentId, arr); return { dispose() {} } } },
      },
    },
  }
  sessions.set(session.id, session)
  sessions.set(agentId, session) // resolveSession falls back to get(agent.id)
  ctx.__session = session
  ctx.__agentId = agentId
  return ctx
}

async function fire(ctx, ev, payload) {
  const fn = ctx.__events.get(ev)
  if (!fn) return false // listener absent (e.g. bridge inert) — caller asserts on effects
  await fn(payload)
  return true
}

// ---------------------------------------------------------------------------
console.log('bridge stays inert without an orchestrator service')
{
  const ctx = makeFakeCtx({ orchestrator: null })
  const registry = createWorkspaceRegistry({ ctx, cfg, buildTools: () => [], log: () => {} })
  const bridge = installSuperagentBridge(ctx, cfg, registry, () => {})
  ok(bridge === null, 'returns null when ctx.get("orchestrator") is undefined')
  await fire(ctx, 'agent/created', { agent: ctx.__session.agent })
  ok((ctx.__scoped.get(ctx.__agentId) ?? []).length === 0, 'no scoped registration after event')
}

// ---------------------------------------------------------------------------
console.log('bridge injects on agent/created when orchestrator present')
{
  const ctx = makeFakeCtx({ orchestrator: { sources: {} } })
  const registry = createWorkspaceRegistry({ ctx, cfg, buildTools: () => [], log: (m) => logs.push(m) })
  // NOTE: buildTools empty is fine — the bridge builds its OWN tool list via factories.
  const logs = []
  const bridge = installSuperagentBridge(ctx, cfg, registry, (m) => logs.push('BRIDGE ' + m))
  ok(bridge && typeof bridge.active === 'function', 'bridge handle returned with orchestrator')
  await fire(ctx, 'agent/created', { agent: ctx.__session.agent })
  if (logs.length) console.log('    logs:', JSON.stringify(logs.slice(0, 4)))
  const scoped = ctx.__scoped.get(ctx.__agentId) ?? []
  const names = scoped.map((t) => t.name)
  ok(scoped.length >= 9, `scoped registrations present (${scoped.length})`)
  ok(names.includes('pipeline_lock_requirements') && names.includes('pipeline_plan') && names.includes('pipeline_status'), 'L1-planning trio injected')
  ok(names.includes('pipeline_review') && names.includes('pipeline_register_output'), 'gate/takeover pair injected')
  ok(!names.includes('pipeline_spawn_module_lead') && !names.includes('pipeline_send_to_lead'), 'L2 delegation tools deliberately excluded')
  ok(names.includes('pipeline_execute_local') && names.includes('pipeline_decompose'), 'L3 execution surface injected')
  const desc = scoped.find((t) => t.name === 'pipeline_lock_requirements')?.description ?? ''
  ok(desc.includes('superagent bridge'), 'injected description carries the bridge marker')
  // idempotence: a second event for the same agent must not double-register
  await fire(ctx, 'agent/created', { agent: ctx.__session.agent })
  ok((ctx.__scoped.get(ctx.__agentId) ?? []).length === scoped.length, 'second event is a no-op (per-agent idempotent)')
  // tier marker: agents record kind l1 + childRoot binding
  const entry = registry.peek({ agent: ctx.__session.agent })
  ok(entry, 'registry resolved the ticket workspace from session cwd')
  const rec = entry?.r.store.agents.get(ctx.__agentId)
  ok(rec && rec.kind === 'l1' && rec.via === 'bridge', 'tier marker recorded as kind:l1 via:bridge')
  ok(registry.tierOf({ agent: ctx.__session.agent }) === 'l1', 'tierOf resolves the worker as l1 (guard adjacency legal)')
  // lock through the bridge tool writes to the SHARED per-workspace store
  const lockTool = scoped.find((t) => t.name === 'pipeline_lock_requirements')
  const res = await lockTool.execute({ requirement: 'bridge smoke run' }, { agent: ctx.__session.agent })
  ok(res && res.run_id, 'lock via bridge tool returns a run_id')
  ok(existsSync(join(entry.r.store.stateDir, 'run.json')), 'run.json landed in the TICKET workspace state dir')
  const board = JSON.parse(readFileSync(join(entry.r.store.stateDir, 'board.json'), 'utf8'))
  ok(board.requirement === 'bridge smoke run', 'board.json shares the same store')
  // non-worker session must be skipped entirely
  const ctx2 = makeFakeCtx({ orchestrator: { sources: {} }, worker: false })
  const reg2 = createWorkspaceRegistry({ ctx: ctx2, cfg, buildTools: () => [], log: () => {} })
  installSuperagentBridge(ctx2, cfg, reg2, () => {})
  await fire(ctx2, 'agent/created', { agent: ctx2.__session.agent })
  ok((ctx2.__scoped.get(ctx2.__agentId) ?? []).length === 0, 'interactive (non-worker) session untouched')
  bridge.dispose?.()
}

// ---------------------------------------------------------------------------
console.log('startup scan catches pre-existing workers (plugin loaded after superagent)')
{
  const ctx = makeFakeCtx({ orchestrator: { sources: {} } })
  const registry = createWorkspaceRegistry({ ctx, cfg, buildTools: () => [], log: () => {} })
  installSuperagentBridge(ctx, cfg, registry, () => {})
  await new Promise((r) => setTimeout(r, 50)) // the scan is a fired-and-forget async probe
  const scoped = ctx.__scoped.get(ctx.__agentId) ?? []
  ok(scoped.length >= 9, `startup scan injected ${scoped.length} tools into the existing worker`)
}

console.log(`\nv133 superagent bridge smoke: ${passed} passed, ${failed} failed`)
rmSync(root, { recursive: true, force: true })
if (failed > 0) process.exit(1)

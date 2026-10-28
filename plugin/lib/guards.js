// dsh-pipeline — tool guards: L1-only tool boundary, strict adjacency, the v89
// milestone hard gate, and the live run-footer wrapper.
import { runFooter } from './store.js'

export const RUN_FOOTER_TOOLS = new Set([
  'pipeline_lock_requirements',
  'pipeline_plan',
  'pipeline_status',
  'pipeline_spawn_module_lead',
  'pipeline_send_to_lead',
  'pipeline_drain_leads',
  'pipeline_checkpoint',
  'pipeline_classify',
  'pipeline_selftest',
  'pipeline_accept_milestone',
  'pipeline_scan',
  'pipeline_ledger',
  'pipeline_recall',
])

export function withRunFooter(tool, r) {
  const original = tool.output?.render
  return {
    ...tool,
    output: {
      ...(tool.output ?? {}),
      render: (args, value, detail) => {
        const base = original ? original(args, value, detail) : { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }
        const footer = runFooter(r)
        if (!footer) return base
        if (typeof base === 'string') return base + footer
        if (base && base.type === 'text') return { ...base, text: `${base.text ?? ''}${footer}` }
        return base
      },
    },
  }
}

export const L1_ONLY_TOOLS = new Set([
  'pipeline_lock_requirements',
  'pipeline_plan',
  'pipeline_classify',
  'pipeline_status',
  'pipeline_spawn_module_lead',
  'pipeline_send_to_lead',
  'pipeline_drain_leads',
  'pipeline_checkpoint',
  'pipeline_decompose',
  'pipeline_selftest',
  'pipeline_accept_milestone',
  'pipeline_scan',
  'pipeline_ledger',
  'pipeline_recall',
  'ask_user_question',
  'present',
])

// v89 — tools that advance the run. A finished-but-unaccepted milestone blocks
// all of them (the hard gate), so acceptance can never be silently skipped.
export const ADVANCE_TOOLS = new Set(['pipeline_spawn_module_lead', 'pipeline_send_to_lead'])

// v89 — tools that spend budget / spawn models; refused once a run cap is hit.
export const EXECUTION_TOOLS = new Set([
  'pipeline_spawn_module_lead',
  'pipeline_send_to_lead',
  'pipeline_decompose',
  'pipeline_execute_local',
  'pipeline_execute_batch',
  'pipeline_spawn_local_executor',
])

export function isRootCoordinator(ctx, agent) {
  if (!agent) return true // cannot attribute the caller -> fail open (never block L1)
  try {
    const agents = ctx.get ? ctx.get('agents') : undefined
    if (!agents || typeof agents.roots !== 'function') return true
    const roots = agents.roots()
    if (!Array.isArray(roots) || roots.length === 0) return true
    return roots.some((a) => a && a.id === agent.id)
  } catch {
    return true
  }
}

export function strictAdjacencyDenial(ctx, r, execution) {
  if (!execution || !L1_ONLY_TOOLS.has(execution.name)) return undefined
  const known = r.store.agents.get(execution.agent?.id)
  const tier = known && (known.kind === 'l2' || known.kind === 'l3') ? known.kind.toUpperCase() : null
  if (tier) {
    return `${execution.name} 是一级协调者（L1）专用工具；${tier} 只能使用本层相邻工具，严格相邻不允许越级（不要重试）。`
  }
  if (isRootCoordinator(ctx, execution.agent)) return undefined
  return `${execution.name} 是一级协调者（L1）专用工具；子代理（L2/L3）无权调用，严格相邻只允许使用本层相邻工具（不要重试）。`
}

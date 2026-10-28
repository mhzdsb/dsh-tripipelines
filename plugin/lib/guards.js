// dsh-pipeline — tool guards: L1-only tool boundary, strict adjacency, the v89
// milestone hard gate, and the live run-footer wrapper.
//
// v103 — role attribution no longer trusts a single optional field: the tier is
// resolved by the workspace registry (agents.roots() -> l1 / child, spawn records
// -> l2/l3). An execution whose tier cannot be established is refused for every
// privileged tool (fail-closed); v102's `isRootCoordinator` returned true for a
// missing agent, a missing service, empty roots, and any exception, which made
// the whole three-tier boundary advisory.
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

// v103 — render() returns ContentBlock[] (util.text/jsonOutput), so the footer
// must be appended to the array's last text block. v102 only handled a bare
// string or a single {type:'text'} object, which no pipeline tool ever returns:
// the "every tool result carries the run state" promise was dead code.
export function withRunFooter(tool, getR) {
  const original = tool.output?.render
  const resolveR = typeof getR === 'function' ? getR : () => getR
  return {
    ...tool,
    output: {
      ...(tool.output ?? {}),
      render: (args, value, detail) => {
        const base = original
          ? original(args, value, detail)
          : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        const r = resolveR()
        const footer = r ? runFooter(r) : ''
        if (!footer) return base
        if (typeof base === 'string') return base + footer
        if (Array.isArray(base)) {
          if (base.length === 0) return [{ type: 'text', text: footer.trim() }]
          const last = base[base.length - 1]
          if (last && last.type === 'text') {
            return [...base.slice(0, -1), { ...last, text: `${last.text ?? ''}${footer}` }]
          }
          return [...base, { type: 'text', text: footer.trim() }]
        }
        if (base && base.type === 'text') return { ...base, text: `${base.text ?? ''}${footer}` }
        return base
      },
    },
  }
}

// v103 — pipeline_decompose is an L2 tool (it turns one module task into L3
// subtasks). v102 listed it as L1-only while the protocol forbade L1 from calling
// it and the L2 guard rejected L2 callers: it had no legal caller at all.
export const L1_ONLY_TOOLS = new Set([
  'pipeline_lock_requirements',
  'pipeline_plan',
  'pipeline_classify',
  'pipeline_status',
  'pipeline_spawn_module_lead',
  'pipeline_send_to_lead',
  'pipeline_drain_leads',
  'pipeline_checkpoint',
  'pipeline_selftest',
  'pipeline_accept_milestone',
  'pipeline_scan',
  'pipeline_ledger',
  'pipeline_recall',
  'ask_user_question',
  'present',
])

// v103 — L2/L3-delegated tools. L1 delegates; it never runs them itself.
export const L2L3_TOOLS = new Set([
  'pipeline_decompose',
  'pipeline_execute_local',
  'pipeline_execute_batch',
  'pipeline_review',
  'pipeline_spawn_local_executor',
  'pipeline_register_output',
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

// v103/v104 — tier: 'l1' | 'l2' | 'l3' | 'child' | 'unknown'. The role matrix is
// enforced here (not in a prompt): L1 delegates and never executes L2/L3 tools;
// only L1 may advance the graph (spawn/send); L1-only tools are refused for every
// child; an unattributable caller is refused (fail-closed).
export function strictAdjacencyDenial(tier, r, execution) {
  if (!execution) return undefined
  if (L2L3_TOOLS.has(execution.name) && tier === 'l1') {
    return `${execution.name} 是二级/三级工具，一级协调者必须委派，禁止自己执行（已被守卫拦截；不要重试）。请改用 pipeline_spawn_module_lead / pipeline_send_to_lead。`
  }
  if (ADVANCE_TOOLS.has(execution.name) && tier !== 'l1') {
    return `${execution.name} 只能由一级协调者调用；${String(tier ?? 'unknown').toUpperCase()} 不能自行派发或改写任务图（不要重试）。`
  }
  if (!L1_ONLY_TOOLS.has(execution.name)) return undefined
  if (tier === 'l1') return undefined
  if (tier === 'l2' || tier === 'l3' || tier === 'child') {
    return `${execution.name} 是一级协调者（L1）专用工具；${String(tier).toUpperCase()} 只能使用本层相邻工具，严格相邻不允许越级（不要重试）。`
  }
  return `${execution.name} 是一级协调者（L1）专用工具；当前调用者身份无法归属（agents.roots() 不可用），已按 fail-closed 拒绝。请在项目主会话中重试。`
}

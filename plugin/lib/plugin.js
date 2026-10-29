// dsh-tripipelines — native DSH plugin implementing a three-tier
// model collaboration system:
//   Level 1 (coordinator) -> Level 2 (module leads) -> Level 3 (local executors)
//
// Self-contained plugin: Node builtins plus the injected `tools`, `systemPrompt`,
// `skills`, and `commands` services. No external npm dependencies.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG, loadPersistedConfig, savePersistedConfig, migratePersistedLevel3Config, mergeConfigLayers, loadProjectConfig, handleConfigCommand } from './config.js'
import { milestoneStates, budgetRefusal, runFooter } from './store.js'
import { createWorkspaceRegistry } from './workspaces.js'
import { buildProtocolText, buildProtocolOffText, SKILL_BODY } from './prompts.js'
import { measureLevel1Context } from './dsh-compat.js'
import { installBoardRoute } from './board-route.js'
import { RUN_FOOTER_TOOLS, withRunFooter, setResultFooter, ADVANCE_TOOLS, EXECUTION_TOOLS, strictAdjacencyDenial } from './guards.js'
import { makeLockTool, makePlanTool, makeStatusTool, makeSpawnModuleLeadTool, makeSendToLeadTool, makeDrainLeadsTool, makeCheckpointTool, makeClassifyTool, makeSelftestTool, makeAcceptMilestoneTool } from './tools/l1.js'
import { makeKnowledgeTools } from './tools/knowledge.js'
import { makeDecomposeTool, makeExecuteLocalTool, makeExecuteBatchTool, makeReviewTool, makeSpawnLocalExecutorTool, makeRegisterOutputTool } from './tools/l2l3.js'

const name = 'pipeline'
const inject = ['tools', 'systemPrompt', 'skills', 'commands', 'llm']

// v112 (O8) — with mode=off the orchestration surface is dead weight in every
// request's tool list. Keep only the read-only/diagnostic subset registered;
// `/pipe-config mode auto` + reload restores the full surface.
export const OFF_MODE_TOOLS = new Set([
  'pipeline_status',
  'pipeline_classify',
  'pipeline_selftest',
  'pipeline_scan',
  'pipeline_ledger',
  'pipeline_recall',
])

export function shouldRegisterTool(toolName, cfg) {
  if (String(cfg?.mode) !== 'off') return true
  return OFF_MODE_TOOLS.has(toolName)
}

// v103 — tool factories only need a store-shaped object while the plugin is
// registered; the real per-workspace stores are created lazily by the registry.
// This stub keeps registration side-effect free (no state dir, no files, no
// cwd-relative writes).
function definitionStore() {
  const run = {
    id: null, status: 'idle', startedAt: null, milestones: [], tokensUsed: 0,
    filesTouched: [], scope: [], activation: 'unknown', paused: false, pauseReason: null,
  }
  const store = {
    stateDir: '', workspaceRoot: null, runId: null, requirement: null, locked: false,
    tasks: new Map(), subtasks: new Map(), agents: new Map(), messages: [],
    counters: { llmCalls: 0, tokensIn: 0, tokensOut: 0, l2Spawns: 0, l2Sends: 0, l3Calls: 0, l3TokensIn: 0, l3TokensOut: 0, measuredTokens: 0 },
    l3Concurrent: 0, context: { level1Tokens: 0 }, run,
  }
  return { store, stateDir: '', record: () => ({}), tracePath: () => '', boardPath: () => '', saveRun: () => {}, snapshotBoard: () => {}, bindSession: () => true }
}

function buildEntryTools(ctx, cfg, r) {
  return [
    makeLockTool(ctx, cfg, r),
    makePlanTool(ctx, cfg, r),
    makeDecomposeTool(ctx, cfg, r),
    makeExecuteLocalTool(ctx, cfg, r),
    makeExecuteBatchTool(ctx, cfg, r),
    makeReviewTool(ctx, cfg, r),
    makeStatusTool(ctx, cfg, r),
    makeSpawnModuleLeadTool(ctx, cfg, r),
    makeSendToLeadTool(ctx, cfg, r),
    makeDrainLeadsTool(ctx, cfg, r),
    makeCheckpointTool(ctx, cfg, r),
    makeClassifyTool(ctx, cfg, r),
    makeSpawnLocalExecutorTool(ctx, cfg, r),
    makeRegisterOutputTool(ctx, cfg, r),
    makeSelftestTool(ctx, cfg, r),
    makeAcceptMilestoneTool(ctx, cfg, r),
    ...makeKnowledgeTools(ctx, cfg, r),
  ]
}


// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  // Config layering (v82): DEFAULT_CONFIG <- apply() config <- global config.json
  // <- project-level <devDir>/pipeline-project.json (highest priority). devDir is only
  // known after the first three layers, so the project file is read last.
  const runtimeConfig = config && typeof config === 'object' ? config : {}
  const persisted = migratePersistedLevel3Config(loadPersistedConfig())
  const baseCfg = mergeConfigLayers(DEFAULT_CONFIG, runtimeConfig, persisted, null)
  const cfg = mergeConfigLayers(baseCfg, loadProjectConfig(baseCfg.devDir), null, null)

  // v103 — one fixed store per normalized workspace root. Created lazily, on the
  // first tool call / command / board request that names a session or workspace,
  // so loading the plugin enumerates nothing and reads no other project's state.
  const definitionR = definitionStore()
  const registry = createWorkspaceRegistry({
    ctx,
    cfg,
    buildTools: (storeR) => buildEntryTools(ctx, cfg, storeR),
    log: (msg) => console.log(msg),
  })

  // v112 (B13) — a host that dropped one of these APIs used to fail with a raw
  // TypeError at the first dispatch (unreadable for the user). Probe the Service
  // surface once at load and name exactly what is missing; the L3 engine and the
  // tokenMeter stay optional (degraded, not broken).
  void (async () => {
    const required = [
      ['subagents', ['startActivation', 'sendMessage', 'drainChildren']],
      ['sessions', ['get']],
      ['llm', ['stream']],
    ]
    const optional = [
      ['tokenMeter', ['measure', 'estimateMessage']],
    ]
    const missing = []
    const soft = []
    for (const [svc, methods] of required) {
      const s = ctx.get?.(svc)
      if (!s) { missing.push(`${svc} service`); continue }
      for (const m of methods) if (typeof s[m] !== 'function') missing.push(`${svc}.${m}`)
    }
    for (const [svc, methods] of optional) {
      const s = ctx.get?.(svc)
      if (!s) { soft.push(`${svc} service`); continue }
      for (const m of methods) if (typeof s[m] !== 'function') soft.push(`${svc}.${m}`)
    }
    if (missing.length) {
      console.warn(`[pipeline] 宿主缺少必需 API：${missing.join('、')}。本插件需要带 startActivation / sessions / llm 的 DSH 构建；请升级宿主或关闭插件（否则工具会在调用时报错）。`)
    }
    if (soft.length) {
      console.warn(`[pipeline] 宿主缺少可选 API：${soft.join('、')}；上下文计量退回估算，读数偏小（功能可用）。`)
    }
  })()

  // v89 — startup self-check (non-blocking): probe the local L3 engine once so a
  // dead endpoint shows up in the log now rather than at the first L3 dispatch.
  // v104 — an unset endpoint is a configuration state, not a network failure.
  void (async () => {
    const endpoint = String(cfg.level3Endpoint ?? '').trim()
    if (!endpoint) {
      console.warn('[pipeline] level3Endpoint 未配置：三级执行暂不可用。用 /pipe-config level3Endpoint http://127.0.0.1:8080/v1 指向本机 OpenAI 兼容引擎。')
      return
    }
    try {
      const url = `${endpoint.replace(/\/+$/, '')}/models`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) console.warn(`[pipeline] L3 engine self-check: ${url} -> HTTP ${res.status}`)
    } catch (e) {
      console.warn(`[pipeline] L3 engine self-check failed (${cfg.level3Endpoint}): ${e?.message ?? e}. Run /pipe-selftest after starting the engine.`)
    }
  })()

  // v112 (O8) — with mode=off the whole orchestration surface is dead weight in
  // every request's tool list (~1.7K tokens of schemas). Register only the
  // read-only/diagnostic subset; /pipe-config mode auto + reload restores the
  // full surface. Runtime /pipe-off keeps the registered tools (guard refuses)
  // until the next reload.
  const modeOff = String(cfg.mode) === 'off'

  // 1. Routing protocol injected into every model step.
  ctx.systemPrompt.section({
    name: 'pipeline:protocol',
    // Finite sort order in the team-policy neighborhood (TEAM_POLICY=600).
    order: 650,
    text: modeOff ? buildProtocolOffText() : buildProtocolText(cfg),
  })

  // 2. Runtime skill registration (the on-disk skills/ folder satisfies the
  //    Agent Plugin packaging structure; this makes it live in DSH).
  ctx.skills.register({
    name: 'pipeline-orchestration',
    description: 'Three-tier model collaboration (L1 = the model you picked for this chat, L2 flash module leads, L3 local executors) for building software: onboarding, requirement interview, fit assessment, adaptive scheduling.',
    whenToUse: 'When the user wants to build software — a tool, library, CLI, script, or any development/coding project. Load it to plan modules, spawn module leads, and run the three-tier workflow automatically (no need for the user to say "three-tier").',
    content: SKILL_BODY,
    source: 'runtime',
    provider: name,
    invocation: { modelInvocable: true, userInvocable: true },
  })

  // 2b. GUI board (v92): a read-only GET /pipeline/board route that the Web UI
  //     status strip (client.js) polls. Soft capability: skipped on hosts without
  //     a webServer, and the model still has pipeline_status as the text view.
  installBoardRoute(ctx, registry, cfg)

  // 3. Tool surface (v89: every L1 tool result carries the live run footer;
  //    v103: each call is dispatched to the store of ITS workspace;
  //    v112: the footer travels ON the result value, so concurrent calls from
  //    different workspaces can never render each other's run state).
  for (const t of buildEntryTools(ctx, cfg, definitionR)) {
    if (!shouldRegisterTool(t.name, cfg)) continue
    const registered = {
      ...t,
      execute: async (args, exec) => {
        const entry = registry.resolve(exec)
        if (!entry) {
          throw new Error('pipeline: 无法定位工作区（当前 session 没有 cwd）。请在项目目录里发起对话，或先调 pipeline_lock_requirements。')
        }
        // v95/v103 — adopt the model the user actually picked for this chat and
        // remember the live session for the board's L1 token meter.
        entry.r.bindSession(ctx, exec)
        // v94 — keep the sidebar card's L1 sweet-spot reading fresh (tokenMeter,
        // deterministic, no LLM call; silently skipped when the meter is absent).
        try {
          const m = measureLevel1Context(ctx, exec, cfg)
          if (m && typeof m.totalTokens === 'number') {
            entry.r.store.context = { ...(entry.r.store.context || {}), level1Tokens: m.totalTokens }
          }
        } catch { /* best-effort */ }
        const target = entry.tools.get(t.name)
        if (!target || typeof target.execute !== 'function') {
          throw new Error(`pipeline: ${t.name} 未在该工作区初始化`)
        }
        const result = await target.execute(args, exec)
        if (RUN_FOOTER_TOOLS.has(t.name) && result && typeof result === 'object') {
          try {
            // v112.1 — the footer lives in a WeakMap keyed by the result value, so
            // the value itself stays plain JSON (host validation) and concurrent
            // calls from different workspaces cannot see each other's footer.
            setResultFooter(result, runFooter(entry.r))
          } catch {
            // best-effort: render simply omits the footer
          }
        }
        return result
      },
    }
    ctx.tools.register(RUN_FOOTER_TOOLS.has(t.name) ? withRunFooter(registered) : registered)
  }

  // Strict adjacency + role separation at the tool layer (v103). A caller whose
  // tier cannot be established is refused for privileged tools (fail-closed), so
  // a missing host service can no longer silently open the three tiers.
  ctx.tools.guard((execution) => {
    const tier = registry.tierOf(execution)
    const entry = registry.peek(execution)
    const adjacency = strictAdjacencyDenial(tier, entry?.r, execution, { allowLevel1Takeover: cfg.allowLevel1Takeover === true })
    if (adjacency) return adjacency
    // v89 hard gate: a finished-but-unaccepted milestone blocks every advancing tool.
    if (ADVANCE_TOOLS.has(execution.name) && entry) {
      const pending = milestoneStates(entry.r.store).filter((m) => m.state === 'done')
      if (pending.length > 0) {
        return `有已完成未验收的里程碑：${pending.map((m) => m.name).join('、')}。先 ask_user_question 弹窗验收，再调用 pipeline_accept_milestone 记录；验收后才能继续推进。`
      }
    }
    // v104: the role matrix (L1 vs L2/L3, advancing vs delegated tools) now
    // lives in guards.strictAdjacencyDenial, so the same rules apply to every
    // caller and are unit-tested directly.
    // v89 budget guard + v103 real off switch: execution tools are refused once
    // the run hits a cap or the user turned the pipeline off.
    if (EXECUTION_TOOLS.has(execution.name)) {
      if (tier === 'unknown') {
        return '无法确认当前调用者的层级（agents.roots() 不可用）；已按 fail-closed 拒绝派发。请运行 /pipe-selftest 排查，并在项目主会话中重试。'
      }
      if (String(cfg.mode) === 'off') {
        return '三级流水线已关闭（mode=off）；用 /pipe-config mode auto 重新启用后再派发。'
      }
      if (entry) {
        const refusal = budgetRefusal(entry.r, cfg)
        if (refusal) return refusal
      }
    }
    return undefined
  })

  // 4. Interactive configuration command (works on desktop; no file editing).
  ctx.commands.register({
    name: 'pipe-config',
    description: 'view or change the three-tier orchestrator configuration (models, thresholds, budget)',
    input: { hint: '[<key> [<value>] | list | reset]' },
    handler: (invocation) => handleConfigCommand(cfg, invocation.rawInput),
  })

  ctx.commands.register({
    name: 'pipe-tokens',
    description: 'show L1 context token usage vs sweet spot (objective, via DSH tokenMeter)',
    input: { hint: '查看 L1 上下文 token 用量（无参数）' },
    handler: (invocation) => {
      const lc = measureLevel1Context(ctx, invocation, cfg)
      if (!lc) return { kind: 'error', text: 'tokenMeter 服务不可用（或无法定位当前会话）' }
      const pct = Math.round(lc.ratio * 100)
      let text = `L1 上下文 token：${lc.totalTokens} / ${lc.budget}（${pct}%，警告阈值 ${Math.round(lc.warnRatio * 100)}%）`
      if (lc.warning) text += `\n⚠️ ${lc.warning}`
      return { kind: 'success', text }
    },
  })

  // v89 — control commands: freeze / resume / turn off / health check.
  ctx.commands.register({
    name: 'pipe-stop',
    description: 'freeze the current run: no new L2/L3 dispatch (files already on disk are kept)',
    input: { hint: '冻结当前 run（无参数）' },
    handler: (invocation) => {
      const entry = registry.resolve(invocation)
      if (!entry) return { kind: 'error', text: '无法定位当前工作区（session 没有 cwd）。' }
      const run = entry.r.store.run
      if (!run || run.status === 'idle') return { kind: 'error', text: '当前没有活跃的 run。' }
      run.paused = true
      run.pauseReason = '用户手动冻结（/pipe-stop）'
      run.status = 'paused'
      entry.r.saveRun()
      return { kind: 'success', text: '已冻结当前 run：新的 L2/L3 派发会被预算护栏拒绝；已派发的 L2 完成当前步骤后等待。已生成的文件保留。用 /pipe-resume 恢复。' }
    },
  })

  ctx.commands.register({
    name: 'pipe-resume',
    description: 'resume a run that was frozen by /pipe-stop or by the budget guard',
    input: { hint: '恢复当前 run（无参数）' },
    handler: (invocation) => {
      const entry = registry.resolve(invocation)
      if (!entry) return { kind: 'error', text: '无法定位当前工作区（session 没有 cwd）。' }
      const run = entry.r.store.run
      if (!run) return { kind: 'error', text: '没有 run。' }
      run.paused = false
      run.pauseReason = null
      if (run.status === 'paused') run.status = 'active'
      entry.r.saveRun()
      return { kind: 'success', text: '已恢复 run。' }
    },
  })

  ctx.commands.register({
    name: 'pipe-research',
    description: 'open a structured research note (7 steps + anti-laziness rules) for a hard decision',
    input: { hint: '<议题，例如：下一步投哪条路径>' },
    handler: (invocation) => {
      const entry = registry.resolve(invocation)
      if (!entry) return { kind: 'error', text: '无法定位当前工作区（session 没有 cwd）。' }
      const topic = String(invocation.rawInput ?? '').trim() || 'untitled topic'
      const dir = join(entry.r.store.stateDir, 'knowledge', 'research')
      try { mkdirSync(dir, { recursive: true }) } catch { /* best-effort */ }
      const slug = topic.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'topic'
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`)
      const template = [
        `# 研讨：${topic}`,
        '',
        '> 由 /pipe-research 生成的骨架。7 步全填完才算一次研讨；第 7 步缺失的建议不可采信。',
        '',
        '## 1. 立项',
        '- 问题：',
        '- 成功判据（什么叫做完了，且错了能被提前暴露）：',
        '- 预算：',
        '',
        '## 2. 证据（每条带 file:line 或台账 #n 指针）',
        '| # | 证据 | 来源 |',
        '|---|---|---|',
        '| E1 |  |  |',
        '',
        '## 3. 候选方案（≥2 个，否则不叫决策）',
        '- A.',
        '- B.',
        '',
        '## 4. 反方（每个候选最硬的反方理由 + 证据）',
        '| 候选 | 最硬的反方理由 | 证据 |',
        '|---|---|---|',
        '',
        '## 5. 能区分候选的最小实验',
        '',
        '## 6. 建议（+ 置信度）',
        '- 建议：',
        '- 置信度：',
        '- 理由（每个理由必须带数字或指针，禁止「因为更好」）：',
        '',
        '## 7. 记录与「错了会怎么暴露」',
        '- 若结论错，最先在哪个检查点暴露：',
        '- 需要回写台账的条目：',
        '- 消耗了多少预算 / 是否动了确认性检验机会：',
        '',
        '## 防呆（三条，逐条自查）',
        '1. 有没有「因为更好」这类无数值的理由？→ 删掉或补数字。',
        '2. 有没有 ≥3 条带指针的证据？→ 不够就先去 pipeline_recall。',
        '3. 有没有回答「错了会怎么暴露」？→ 没答就不能作为决策依据。',
      ].join('\n')
      try {
        writeFileSync(file, template, 'utf8')
      } catch (err) {
        return { kind: 'error', text: `无法写入研讨文件：${err?.message ?? err}` }
      }
      return {
        kind: 'success',
        text: `研讨骨架已创建：${file}\n\n填完后用 pipeline_checkpoint 或直接编辑 decisions.md 把结论回写台账。\n（v98：研讨层目前手动触发，先跑 2~3 次再考虑自动化阈值。）`,
      }
    },
  })

  ctx.commands.register({
    name: 'pipe-off',
    description: 'turn the three-tier pipeline off (single-agent mode; existing files untouched)',
    input: { hint: '关闭三级流水线（无参数）' },
    handler: () => {
      cfg.mode = 'off'
      try {
        savePersistedConfig({ mode: 'off' })
      } catch {
        // best-effort
      }
      return { kind: 'success', text: '三级流水线已关闭（mode=off），回到单 agent；已生成文件不动。用 /pipe-config mode auto 重新启用。' }
    },
  })

  ctx.commands.register({
    name: 'pipe-selftest',
    description: 'DSH-compat health check (services + local engine)',
    input: { hint: '体检（无参数）' },
    handler: async (invocation) => {
      try {
        const entry = registry.peek(invocation)
        const result = await makeSelftestTool(ctx, cfg, entry?.r ?? definitionR).execute({})
        const lines = result.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}`)
        if (result.degraded?.length) lines.push('', `⚠️ 降级：${result.degraded.join('、')}`)
        return { kind: result.ready ? 'success' : 'error', text: lines.join('\n') }
      } catch (err) {
        return { kind: 'error', text: `自检失败：${err?.message ?? err}` }
      }
    },
  })

  // 5. Level-3 agents run on the `ninfer-local` provider registered by the
  //    profile's llm-pi-ai plugin (OpenAI protocol). v84 removed the plugin-owned
  //    Ollama adapter entirely — no registerAdapter call is needed.
}

export { name, inject, apply }

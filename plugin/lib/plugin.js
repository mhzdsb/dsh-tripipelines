// dsh-pipeline — native DSH plugin implementing a three-tier
// model collaboration system:
//   Level 1 (coordinator) -> Level 2 (module leads) -> Level 3 (local executors)
//
// Self-contained plugin: Node builtins plus the injected `tools`, `systemPrompt`,
// `skills`, and `commands` services. No external npm dependencies.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG, loadPersistedConfig, savePersistedConfig, migratePersistedLevel3Config, mergeConfigLayers, loadProjectConfig, handleConfigCommand } from './config.js'
import { createStore, milestoneStates, budgetRefusal } from './store.js'
import { buildProtocolText, SKILL_BODY } from './prompts.js'
import { resolveSession, measureLevel1Context } from './dsh-compat.js'
import { installBoardRoute } from './board-route.js'
import { RUN_FOOTER_TOOLS, withRunFooter, ADVANCE_TOOLS, EXECUTION_TOOLS, strictAdjacencyDenial } from './guards.js'
import { makeLockTool, makePlanTool, makeStatusTool, makeSpawnModuleLeadTool, makeSendToLeadTool, makeDrainLeadsTool, makeCheckpointTool, makeClassifyTool, makeSelftestTool, makeAcceptMilestoneTool } from './tools/l1.js'
import { makeKnowledgeTools } from './tools/knowledge.js'
import { makeDecomposeTool, makeExecuteLocalTool, makeExecuteBatchTool, makeReviewTool, makeSpawnLocalExecutorTool, makeRegisterOutputTool } from './tools/l2l3.js'

const name = 'pipeline'
const inject = ['tools', 'systemPrompt', 'skills', 'commands', 'llm']


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
  const r = createStore(cfg, { restore: false })

  // v93 — re-home the state onto the real workspace once a session is resolvable
  // (cold start: run.json may already exist under the profile-directory fallback).
  setImmediate(() => { try { r.alignTo(ctx) } catch { /* best-effort */ } })

  // v89 — startup self-check (non-blocking): probe the local L3 engine once so a
  // dead endpoint shows up in the log now rather than at the first L3 dispatch.
  void (async () => {
    try {
      const url = `${String(cfg.level3Endpoint ?? '').replace(/\/+$/, '')}/models`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      const res = await fetch(url, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) console.warn(`[pipeline] L3 engine self-check: ${url} -> HTTP ${res.status}`)
    } catch (e) {
      console.warn(`[pipeline] L3 engine self-check failed (${cfg.level3Endpoint}): ${e?.message ?? e}. Run /pipe-selftest after starting the engine.`)
    }
  })()

  // 1. Routing protocol injected into every model step.
  ctx.systemPrompt.section({
    name: 'pipeline:protocol',
    // Finite sort order in the team-policy neighborhood (TEAM_POLICY=600).
    order: 650,
    text: buildProtocolText(cfg),
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
  installBoardRoute(ctx, r, cfg)

  // 3. Tool surface (v89: every L1 tool result carries the live run footer).
  const tools = [
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
  // v93 — every tool call first re-homes the run state onto the SESSION workspace
  // (idempotent; the profile-directory bootstrap is only a fallback, because the
  // plugin process cwd is the DSH profile dir, never the user's project).
  for (const t of tools) {
    const aligned = {
      ...t,
      execute: async (args, exec) => {
        try { r.alignTo(ctx, exec) } catch { /* best-effort */ }
        // v96 — remember the live L1 session so /pipeline/board can re-measure the
        // context meter on every poll (not only after a pipeline_* tool call).
        try {
          const sess = resolveSession(ctx, exec)
          if (sess) r.lastSession = sess
        } catch { /* best-effort */ }
        // v94 — keep the sidebar card's L1 sweet-spot reading fresh (tokenMeter,
        // deterministic, no LLM call; silently skipped when the meter is absent).
        try {
          const m = measureLevel1Context(ctx, exec, cfg)
          if (m && typeof m.totalTokens === 'number') {
            r.store.context = { ...(r.store.context || {}), level1Tokens: m.totalTokens }
          }
        } catch { /* best-effort */ }
        return t.execute(args, exec)
      },
    }
    ctx.tools.register(RUN_FOOTER_TOOLS.has(t.name) ? withRunFooter(aligned, r) : aligned)
  }

  // Strict adjacency at the tool level.
  // (a) L2/L3 must never reach L1-only tools — this replaces the removed
  //     SubagentStartRequest.toolFilter (v84); see strictAdjacencyDenial.
  // (b) The coordinator (L1) must NOT call Level-2 decompose or Level-3 execute
  //     tools directly; it delegates via spawn/send of a module-lead subagent.
  ctx.tools.guard((execution) => {
    const adjacency = strictAdjacencyDenial(ctx, r, execution)
    if (adjacency) return adjacency
    // v89 hard gate: a finished-but-unaccepted milestone blocks every advancing tool.
    if (ADVANCE_TOOLS.has(execution.name)) {
      const pending = milestoneStates(r.store).filter((m) => m.state === 'done')
      if (pending.length > 0) {
        return `有已完成未验收的里程碑：${pending.map((m) => m.name).join('、')}。先 ask_user_question 弹窗验收，再调用 pipeline_accept_milestone 记录；验收后才能继续推进。`
      }
    }
    // v89 budget guard: execution tools are refused once the run hits a cap.
    if (EXECUTION_TOOLS.has(execution.name)) {
      const refusal = budgetRefusal(r, cfg)
      if (refusal) return refusal
    }
    if (execution.name !== 'pipeline_decompose' && execution.name !== 'pipeline_execute_local' && execution.name !== 'pipeline_execute_batch' && execution.name !== 'pipeline_spawn_local_executor') return undefined
    try {
      const teams = ctx.get ? ctx.get('agentTeams') : undefined
      if (teams && typeof teams.membership === 'function' && teams.membership(execution.agent)?.role === 'lead') {
        return `${execution.name} 是二级/三级工具，一级协调者无权调用（已被守卫拦截）。请改用 pipeline_spawn_module_lead / pipeline_send_to_lead 委托二级模块负责人；不要重试本调用，重试仍会被拦截、浪费 token。`
      }
    } catch {
      // subagent (not a team member) -> allow
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
    handler: () => {
      const run = r.store.run
      if (!run || run.status === 'idle') return { kind: 'error', text: '当前没有活跃的 run。' }
      run.paused = true
      run.pauseReason = '用户手动冻结（/pipe-stop）'
      run.status = 'paused'
      r.saveRun()
      return { kind: 'success', text: '已冻结当前 run：新的 L2/L3 派发会被预算护栏拒绝；已派发的 L2 完成当前步骤后等待。已生成的文件保留。用 /pipe-resume 恢复。' }
    },
  })

  ctx.commands.register({
    name: 'pipe-resume',
    description: 'resume a run that was frozen by /pipe-stop or by the budget guard',
    input: { hint: '恢复当前 run（无参数）' },
    handler: () => {
      const run = r.store.run
      if (!run) return { kind: 'error', text: '没有 run。' }
      run.paused = false
      run.pauseReason = null
      if (run.status === 'paused') run.status = 'active'
      r.saveRun()
      return { kind: 'success', text: '已恢复 run。' }
    },
  })

  ctx.commands.register({
    name: 'pipe-research',
    description: 'open a structured research note (7 steps + anti-laziness rules) for a hard decision',
    input: { hint: '<议题，例如：下一步投哪条路径>' },
    handler: (invocation) => {
      const topic = String(invocation.rawInput ?? '').trim() || 'untitled topic'
      const dir = join(r.store.stateDir, 'knowledge', 'research')
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
        savePersistedConfig(cfg)
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
    handler: async () => {
      try {
        const result = await makeSelftestTool(ctx, cfg, r).execute({})
        const lines = result.checks.map((c) => `${c.ok ? '✅' : '❌'} ${c.name}：${c.detail}`)
        return { kind: result.ok ? 'success' : 'error', text: lines.join('\n') }
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

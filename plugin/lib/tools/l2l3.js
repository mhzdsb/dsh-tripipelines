// dsh-pipeline — Level-2/3 tool factories: LLM decomposition, the L3 executor core
// (executeOneL3Task + single/batch dispatch), review, takeover registration and the
// one-shot local-executor spawn.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { text, safeParseJson, splitIntoChunks, estimateTokens, compressText, normalizeStatus, contentText, numCfg, LEVEL2_NAMES, jsonOutput } from '../util.js'
import { buildL3ExecutorPrompt } from '../prompts.js'
import { gateSubtask, gateTask } from '../gates.js'
import { addRunUsage } from '../store.js'

// Level-2 decomposition via the configured flash model (deepseek-v4.1-flash).
// Returns an array of subtask descriptions, or throws to trigger the
// deterministic fallback.
async function decomposeViaLlm(ctx, cfg, task, signal) {
  const llm = ctx.llm
  if (!llm) throw new Error('llm service unavailable')
  const prompt = [
    'You are a Level-2 module lead. Split the following task into tiny subtasks for a Level-3 local executor.',
    `Each subtask is a single concrete step of at most ${cfg.maxCodeLines} lines of code or ${cfg.level3InputBudget} tokens of input.`,
    'Return ONLY a JSON array of strings (the subtask descriptions). No prose, no markdown fences.',
    `Task: ${task.desc}`,
    `Acceptance criteria: ${task.acceptance}`,
  ].join('\n\n')
  let text = ''
  for await (const chunk of llm.stream({
    provider: cfg.level2Provider,
    model: cfg.level2Model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 1000,
    signal,
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(chunk.reason.failure?.message ?? 'Level-2 model call failed')
    }
  }
  const parsed = safeParseJson(text)
  if (!Array.isArray(parsed)) throw new Error('Level-2 model returned a non-array')
  const subs = parsed.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
  if (subs.length === 0) throw new Error('Level-2 model returned no subtasks')
  return subs
}

export function makeDecomposeTool(ctx, cfg, r) {
  return {
    name: 'pipeline_decompose',
    description: 'Split a task into tiny L3 subtasks; upstream failure blocks downstream.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'The task id from pipeline_plan.' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const task = r.store.tasks.get(args.taskId)
      if (!task) throw new Error(`unknown task id: ${args.taskId}`)

      // Upstream gate.
      const failedDep = (task.depends_on ?? []).find((d) => r.store.tasks.get(d)?.state === 'failed')
      if (failedDep) {
        task.state = 'failed'
        task.reason = `blocked by upstream failure: ${failedDep}`
        r.record(task.assignee, 'failed', 'task_result', 'level1_main', task.id, task.desc, task.reason, task.acceptance)
        return { ok: false, blocked: true, taskId: task.id, reason: task.reason, state: 'failed' }
      }
      const notDone = (task.depends_on ?? []).filter((d) => r.store.tasks.get(d)?.state !== 'done')
      if (notDone.length > 0) {
        return { ok: false, blocked: true, taskId: task.id, waitingFor: notDone, state: 'pending' }
      }

      task.state = 'in_progress'
      r.record(task.assignee, 'in_progress', 'task_assignment', 'level3_local', task.id, task.desc, null, task.acceptance)

      // Level-2 decomposition: prefer the configured flash model; fall back to
      // deterministic sentence splitting if the model is unavailable or fails.
      let chunks
      let via
      try {
        chunks = await decomposeViaLlm(ctx, cfg, task, exec.signal)
        via = 'llm'
      } catch {
        chunks = splitIntoChunks(task.desc, cfg.level3InputBudget)
        via = 'deterministic'
      }
      const created = []
      let n = task.subtaskIds.length
      for (const chunk of chunks) {
        const sid = `${task.id}-s${++n}`
        r.store.subtasks.set(sid, {
          id: sid,
          parent: task.id,
          desc: chunk,
          acceptance: task.acceptance,
          state: 'pending',
          status: null,
          code: null,
          reason: null,
          failCount: 0,
        })
        task.subtaskIds.push(sid)
        created.push(sid)
        r.record(LEVEL2_NAMES[0], 'pending', 'task_assignment', 'level3_local', sid, chunk, null, task.acceptance)
      }
      return {
        ok: true,
        taskId: task.id,
        assignee: task.assignee,
        via,
        subtasks: created.map((id) => ({ id, desc: r.store.subtasks.get(id).desc })),
      }
    },
  }
}

// OpenAI protocol: level3Endpoint is the /v1 base, so the route is built once.
function level3ChatEndpoint(cfg) {
  return `${String(cfg.level3Endpoint || '').replace(/\/$/, '')}/chat/completions`
}

export function makeExecuteLocalTool(ctx, cfg, r) {
  return {
    name: 'pipeline_execute_local',
    description: 'Run ONE tiny subtask on the local L3 engine (text in, JSON out).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subtaskId: { type: 'string', description: 'Stored subtask id from pipeline_decompose.' },
        subtask: {
          type: 'object',
          additionalProperties: true,
          description: 'Inline subtask {id, desc, acceptance} for direct execution without a plan.',
        },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      let subtask
      if (args.subtaskId) {
        subtask = r.store.subtasks.get(args.subtaskId)
        if (!subtask) throw new Error(`unknown subtask id: ${args.subtaskId}`)
        if (subtask.state !== 'pending') {
          throw new Error(`subtask ${subtask.id} is ${subtask.state}; only pending subtasks can execute`)
        }
      } else if (args.subtask) {
        subtask = makeSubtask(args.subtask, `inline-${Date.now()}`)
        if (!r.store.subtasks.has(subtask.id)) r.store.subtasks.set(subtask.id, subtask)
      } else {
        throw new Error('provide either subtaskId or an inline subtask object')
      }

      // Same execution path as pipeline_execute_batch (executeOneL3Task).
      return executeOneL3Task(subtask, cfg, r, exec)
    },
  }
}

// Board record shared by pipeline_execute_local (inline) and pipeline_execute_batch.
function makeSubtask(spec, fallbackId) {
  return {
    id: String(spec.id ?? fallbackId),
    parent: null,
    desc: String(spec.desc ?? ''),
    acceptance: String(spec.acceptance ?? spec.desc ?? ''),
    state: 'pending',
    status: null,
    code: null,
    reason: null,
    failCount: 0,
  }
}

// Execute ONE Level-3 subtask: budget guard -> compressed prompt -> OpenAI call ->
// JSON parse -> retry / escalation / bookkeeping. Shared by local + batch.
async function executeOneL3Task(subtask, cfg, r, exec) {
  // Token-budget guard (avoids small-model long-context degradation).
  const inTokens = estimateTokens(subtask.desc)
  if (inTokens > cfg.level3InputBudget) {
    subtask.state = 'failed'
    subtask.reason = `input ${inTokens} tokens exceeds Level-3 budget ${cfg.level3InputBudget}`
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, blocked: true, subtaskId: subtask.id, reason: subtask.reason, inputTokens: inTokens }
  }

  // L1 context compression.
  const compressedDesc = compressText(subtask.desc, cfg.level3Compression)
  const compressedAcceptance = compressText(subtask.acceptance, cfg.level3Compression)

  subtask.state = 'in_progress'
  r.record('level3_local', 'in_progress', 'task_assignment', 'level3_local', subtask.id, subtask.desc, null, subtask.acceptance)

  const prompt = [
    'You are a Level-3 executor. Do only this one tiny subtask. No reasoning, no tool calls.',
    'Output ONLY a single JSON object. Use this EXACT skeleton — keep "status":"done" unchanged, put your code in "code":',
    `{"subtask_id": "${subtask.id}", "code": "<your code here>", "status": "done"}`,
    `Subtask description:\n${compressedDesc}`,
    `Acceptance criteria:\n${compressedAcceptance}`,
    `Return code of at most ${cfg.maxCodeLines} lines.`,
  ].join('\n\n')

  let parsed
  let usage = { promptTokens: null, completionTokens: null }
  // Per-task watchdog: every Level-3 task gets its own level3TimeoutMs, including
  // each task inside pipeline_execute_batch (never a batch-wide timeout).
  const timeoutMs = numCfg(cfg, 'level3TimeoutMs', 900000)
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort(new Error(`L3 timed out after ${Math.round(timeoutMs / 60000)}min`)) }, timeoutMs)
  try {
    const signal = exec.signal ? AbortSignal.any([exec.signal, controller.signal]) : controller.signal
    const res = await fetch(level3ChatEndpoint(cfg), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: cfg.level3Model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: numCfg(cfg, 'level3MaxOutputTokens', 4096),
        temperature: 0,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`ninfer ${res.status}: ${body.slice(0, 400)}`)
    }
    const data = await res.json()
    const choice = data.choices?.[0]
    usage.promptTokens = data.usage?.prompt_tokens ?? null
    usage.completionTokens = data.usage?.completion_tokens ?? null
    // OpenAI-protocol reasoning models put the visible answer in message.content;
    // drop reasoning_content entirely (it must never leak into the code field).
    const raw = typeof choice?.message?.content === 'string' ? choice.message.content : JSON.stringify(choice?.message?.content ?? '')
    parsed = safeParseJson(raw)
  } catch (err) {
    subtask.failCount = (subtask.failCount ?? 0) + 1
    const max = numCfg(cfg, 'maxLevel3Retries', 2)
    subtask.reason = `local model call failed: ${err?.message ?? err}`
    if (subtask.failCount >= max) {
      subtask.state = 'failed'
      subtask.reason += ` (retried ${subtask.failCount}/${max}; escalate: Level-2 takes over, then Level-1)`
      r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
      return { ok: false, subtaskId: subtask.id, state: 'failed', escalated: true, failCount: subtask.failCount, reason: subtask.reason }
    }
    subtask.state = 'pending' // retryable within budget
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, subtaskId: subtask.id, state: 'pending', retryable: true, failCount: subtask.failCount, reason: `${subtask.reason} (attempt ${subtask.failCount}/${max}; escalate after ${max - subtask.failCount} more)` }
  } finally {
    clearTimeout(timer)
  }

  // L3 cannot-do -> immediate L2 takeover, no retry.
  if (parsed && normalizeStatus(parsed.status) === 'cannot-do') {
    subtask.state = 'failed'
    subtask.reason = `L3 reports cannot-do: ${parsed.reason ?? 'task too complex'}`
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, subtaskId: subtask.id, state: 'failed', cannotDo: true, reason: subtask.reason }
  }

  r.store.counters.llmCalls += 1
  r.store.counters.tokensIn += usage.promptTokens ?? inTokens
  r.store.counters.tokensOut += usage.completionTokens ?? 0
  r.store.counters.l3Calls += 1
  r.store.counters.l3TokensIn += usage.promptTokens ?? inTokens
  r.store.counters.l3TokensOut += usage.completionTokens ?? 0
  // v89 — feed the run budget (L3 tokens; L2 tokens are not observable here).
  addRunUsage(r, cfg, (usage.promptTokens ?? inTokens) + (usage.completionTokens ?? 0), [])

  subtask.code = typeof parsed.code === 'string' ? parsed.code : JSON.stringify(parsed.code ?? parsed)
  subtask.status = normalizeStatus(parsed.status)
  subtask.state = 'review'
  r.record('level3_local', 'review', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.status, subtask.acceptance)
  return {
    ok: true,
    subtaskId: subtask.id,
    state: 'review',
    code: subtask.code,
    status: subtask.status,
    compressed: cfg.level3Compression === 'L1',
    inputTokens: inTokens,
    usage,
  }
}

// Batched Level-3 dispatch: N subtasks in ONE tool call, executed SERIALLY (single
// slot). Per-task watchdog lives in executeOneL3Task; maxBatchMs only stops STARTING
// new tasks. A failed / timed-out / cannot-do task is recorded and the loop goes on.
export function makeExecuteBatchTool(ctx, cfg, r) {
  return {
    name: 'pipeline_execute_batch',
    description: 'Run L3 subtasks serially in one call; per-task timeout, no cascade.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks'],
      properties: {
        tasks: {
          type: 'array',
          description: '子任务数组（非空）。每项 {id?, desc, acceptance}；各自独立超时、失败不连锁。',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['desc'],
            properties: {
              id: { type: 'string', description: '可选子任务 id；缺省为 batch-<index>。' },
              desc: { type: 'string', description: '子任务描述（单文件 / 小功能）。' },
              acceptance: { type: 'string', description: '该子任务自己的验收标准（一句话，可机械验证；缺省回退为 desc）。' },
            },
          },
        },
        maxBatchMs: { type: 'number', description: '可选总时长护栏毫秒（默认 0=无总时长护栏；到点后只停止派发新任务，不中断正在跑的任务）。' },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      if (tasks.length === 0) throw new Error('tasks must be a non-empty array')
      const maxBatchMs = numCfg(args, 'maxBatchMs', 0)
      const startedAt = Date.now()
      const results = []
      let done = 0
      let failed = 0
      let remaining = 0
      for (let i = 0; i < tasks.length; i++) {
        // Soft batch guard: stop STARTING new tasks. The task already in flight
        // keeps its own per-task watchdog and is never aborted from here.
        if (maxBatchMs > 0 && Date.now() - startedAt >= maxBatchMs) {
          remaining = tasks.length - i
          for (let j = i; j < tasks.length; j++) {
            const spec = tasks[j] ?? {}
            r.record('level3_local', 'pending', 'task_assignment', LEVEL2_NAMES[0], String(spec.id ?? `batch-${j}`), String(spec.desc ?? ''), 'deferred: maxBatchMs guard', String(spec.acceptance ?? spec.desc ?? ''))
          }
          break
        }
        const spec = tasks[i] ?? {}
        const subtask = makeSubtask(spec, `batch-${i}`)
        // v89 — never reuse an existing board record: a duplicate id gets a unique suffix.
        if (r.store.subtasks.has(subtask.id)) {
          const base = subtask.id
          let n = 2
          while (r.store.subtasks.has(`${base}-${n}`)) n += 1
          subtask.id = `${base}-${n}`
        }
        r.store.subtasks.set(subtask.id, subtask)
        try {
          // Per-task isolation: one task's failure (throw) is recorded and the
          // batch moves on; it never cancels the remaining tasks.
          const out = await executeOneL3Task(subtask, cfg, r, exec)
          if (out && out.ok) done += 1
          else failed += 1
          results.push({ i, ...out })
        } catch (err) {
          failed += 1
          const reason = err?.message ?? String(err)
          if (r.store.subtasks.has(subtask.id)) {
            const s = r.store.subtasks.get(subtask.id)
            s.state = 'failed'
            s.reason = reason
          }
          r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, reason, subtask.acceptance)
          results.push({ i, ok: false, subtaskId: subtask.id, state: 'failed', error: reason })
        }
      }
      return { total: tasks.length, done, failed, remaining, results }
    },
  }
}

const failedNames = (gate) => gate.checks.filter((c) => !c.pass).map((c) => c.name).join(', ')

export function makeReviewTool(ctx, cfg, r) {
  return {
    name: 'pipeline_review',
    description: 'Quality-gate a subtask (L2) or module task (L1).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subtaskId: { type: 'string', description: 'Review one Level-3 subtask output.' },
        taskId: { type: 'string', description: 'Review one Level-2 module task (requires all its subtasks done).' },
        agentId: { type: 'string', description: 'Review one agent-path Level-3 executor (from pipeline_spawn_local_executor).' },
        filePath: { type: 'string', description: 'Optional: read and review this real file on disk instead of the board code.' },
      },
    },
    output: jsonOutput(),
    async execute(args) {
      if (args.subtaskId) {
        const s = r.store.subtasks.get(args.subtaskId)
        if (!s) throw new Error(`unknown subtask id: ${args.subtaskId}`)
        if (s.state !== 'review') throw new Error(`subtask ${s.id} is ${s.state}; must be review`)
        let code = s.code
        if (args.filePath) {
          try { code = readFileSync(resolve(args.filePath), 'utf8') } catch { throw new Error(`cannot read file: ${args.filePath}`) }
        }
        const gate = gateSubtask({ subtask_id: s.id, code, status: s.status }, s.id, s.acceptance, cfg)
        if (gate.ok) {
          s.state = 'done'
          s.reason = null
          r.record(LEVEL2_NAMES[0], 'done', 'review_result', 'level1_main', s.id, s.desc, 'accepted', s.acceptance)
        } else {
          // Wrong output is retryable within budget: prefer letting L3 try again over L2 takeover.
          s.failCount = (s.failCount ?? 0) + 1
          const max = numCfg(cfg, 'maxLevel3Retries', 5)
          const failedChecks = failedNames(gate)
          if (s.failCount >= max) {
            s.state = 'failed'
            s.reason = `quality gate failed (${failedChecks}); retried ${s.failCount}/${max} -> Level-2 takeover`
            r.record(LEVEL2_NAMES[0], 'failed', 'review_result', 'level1_main', s.id, s.desc, s.reason, s.acceptance)
          } else {
            s.state = 'pending' // retryable: L2 re-dispatches to L3
            s.reason = `quality gate failed (${failedChecks}); attempt ${s.failCount}/${max}, retryable`
            r.record(LEVEL2_NAMES[0], 'failed', 'review_result', 'level1_main', s.id, s.desc, s.reason, s.acceptance)
          }
        }
        return { level: 3, id: s.id, ok: gate.ok, score: gate.score, checks: gate.checks, state: s.state }
      }

      if (args.taskId) {
        const t = r.store.tasks.get(args.taskId)
        if (!t) throw new Error(`unknown task id: ${args.taskId}`)
        const subs = t.subtaskIds.map((id) => r.store.subtasks.get(id)).filter(Boolean)
        // v93 — a real workspace file may stand in for the board snippets.
        let fileCode
        if (args.filePath) {
          try { fileCode = readFileSync(resolve(args.filePath), 'utf8') } catch { throw new Error(`cannot read file: ${args.filePath}`) }
        }
        // Upstream (Level-3) failure blocks module acceptance — unless L1 reviews a
        // real workspace file, which supersedes the stale/broken board record.
        const failedSub = subs.find((s) => s.state === 'failed')
        if (failedSub && !fileCode) {
          t.state = 'failed'
          t.reason = `subtask ${failedSub.id} failed: ${failedSub.reason}`
          r.record(t.assignee, 'failed', 'review_result', 'level1_main', t.id, t.desc, t.reason, t.acceptance)
          return { level: 2, id: t.id, ok: false, blocked: true, reason: t.reason, state: 'failed' }
        }
        const gate = gateTask(t, subs, cfg, fileCode)
        if (gate.ok) {
          if (failedSub) {
            failedSub.state = 'done'
            failedSub.reason = null
            if (fileCode) failedSub.code = fileCode
          }
          t.state = 'done'
          t.reason = null
          r.record('level1_main', 'done', 'review_result', 'level1_main', t.id, t.desc, 'accepted', t.acceptance)
        } else {
          t.state = 'failed'
          t.reason = `quality gate failed: ${failedNames(gate)}`
          r.record('level1_main', 'failed', 'review_result', 'level1_main', t.id, t.desc, t.reason, t.acceptance)
        }
        return { level: 2, id: t.id, ok: gate.ok, score: gate.score, checks: gate.checks, state: t.state }
      }

      if (args.agentId) {
        const a = r.store.agents.get(args.agentId)
        if (!a) throw new Error(`unknown agent id: ${args.agentId}`)
        if (a.kind !== 'l3') throw new Error(`agent ${a.id} is ${a.kind}; only Level-3 executors can be reviewed`)
        if (a.state === 'in_progress') throw new Error(`agent ${a.id} is still in_progress`)
        const acceptance = a.acceptance ?? a.desc
        const gate = gateSubtask({ subtask_id: a.id, code: a.code, status: a.status }, a.id, acceptance, cfg)
        a.state = gate.ok ? 'done' : 'failed'
        a.reason = gate.ok ? null : `quality gate failed: ${failedNames(gate)}`
        r.record(LEVEL2_NAMES[0], a.state, 'review_result', 'level1_main', a.id, a.desc, a.reason ?? 'accepted', acceptance)
        return { level: 3, id: a.id, ok: gate.ok, score: gate.score, checks: gate.checks, state: a.state }
      }

      throw new Error('provide subtaskId, taskId, or agentId')
    },
  }
}

// Spawn a one-shot Level-3 executor subagent on the local ninfer model (provider
// ninfer-local, model level3Model). Used by a Level-2 module lead for ONE tiny subtask.
export function makeSpawnLocalExecutorTool(ctx, cfg, r) {
  return {
    name: 'pipeline_spawn_local_executor',
    description: 'Spawn a one-shot L3 executor on the local engine.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Tiny subtask for the executor.' },
        acceptance: { type: 'string', description: "Mechanically checkable acceptance." },
      },
    },
    output: jsonOutput(),
    async execute(args, exec) {
      const subs = ctx.get ? ctx.get('subagents') : undefined
      if (!subs || typeof subs.startActivation !== 'function') throw new Error('subagents service is unavailable')

      // Concurrency limit: ninfer runs one generation at a time per slot, so the
      // default is 1 (configurable via maxLevel3Concurrency).
      const slots = numCfg(cfg, 'maxLevel3Concurrency', 1)
      const queueDeadline = Date.now() + 120000
      while (r.store.l3Concurrent >= slots) {
        if (Date.now() > queueDeadline) throw new Error(`Level-3 concurrency queue timed out (${slots} slots busy)`)
        await new Promise((res) => setTimeout(res, 200))
      }
      r.store.l3Concurrent++
      const timeoutMs = numCfg(cfg, 'level3TimeoutMs', 900000)
      const controller = new AbortController()
      const timer = setTimeout(() => { controller.abort(new Error(`L3 timed out after ${Math.round(timeoutMs / 60000)}min`)) }, timeoutMs)
      try {
        const signal = exec.signal ? AbortSignal.any([exec.signal, controller.signal]) : controller.signal
        // v84: startActivation replaced the old one-shot start(name, request) path.
        const run = await subs.startActivation({
          provider: 'spawn',
          label: 'level3-executor',
          request: {
            prompt: [{ type: 'text', text: buildL3ExecutorPrompt(args.prompt, args.acceptance, cfg) }],
            parent: exec.agent,
            agentOptions: { provider: 'ninfer-local', model: cfg.level3Model },
          },
          signal,
          delivery: 'parent',
        })
        r.record(LEVEL2_NAMES[0], 'in_progress', 'agent_spawn_l3', 'level3_local', run.childId, args.prompt, null, null)
        r.store.agents.set(run.childId, {
          id: run.childId,
          kind: 'l3',
          label: 'level3-executor',
          desc: args.prompt,
          acceptance: args.acceptance ?? null,
          state: 'in_progress',
          provider: 'ninfer-local',
          model: cfg.level3Model,
        })
        // Await the one-shot run's completion (with a timeout) so the board tracks done/failed.
        let state = 'done'
        let reason = null
        let code = null
        let status = null
        try {
          const result = await run.result
          const raw = contentText(result.output)
          if (result.stopReason !== 'completed') {
            state = 'failed'
            reason = result.diagnostic ?? `stopReason: ${result.stopReason}`
          } else {
            // Align with the tool path: strip markdown fences, extract code/status.
            try {
              const parsed = safeParseJson(raw)
              code = typeof parsed.code === 'string' ? parsed.code : JSON.stringify(parsed.code ?? parsed)
              status = normalizeStatus(parsed.status)
            } catch {
              reason = `local model returned non-JSON output: ${raw.slice(0, 200)}`
            }
          }
        } catch (err) {
          state = 'failed'
          reason = err?.message ?? String(err)
        }
        const agent = r.store.agents.get(run.childId)
        if (agent) {
          agent.state = state
          agent.reason = reason
          agent.code = code
          agent.status = status
        }
        r.record(LEVEL2_NAMES[0], state, 'agent_l3_result', 'level3_local', run.childId, args.prompt, reason ?? status ?? state, null)
        return { runId: run.childId, provider: 'ninfer-local', model: cfg.level3Model, state, reason, code, status }
      } finally {
        clearTimeout(timer)
        r.store.l3Concurrent--
      }
    },
  }
}

// Register code L2 wrote directly (L3 bypassed) so the quality gate can see it.
export function makeRegisterOutputTool(ctx, cfg, r) {
  return {
    name: 'pipeline_register_output',
    description: 'Register L2-written code into the board (takeover after L3 failed).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subtaskId'],
      properties: {
        subtaskId: { type: 'string', description: 'The subtask id from pipeline_decompose.' },
        code: { type: 'string', description: 'Code L2 wrote to disk.' },
        filePath: { type: 'string', description: 'Optional: read code from this file.' },
      },
    },
    output: jsonOutput(),
    execute(args) {
      const s = r.store.subtasks.get(args.subtaskId)
      if (!s) throw new Error(`unknown subtask id: ${args.subtaskId}`)
      let code = args.code
      if (!code && args.filePath) {
        try { code = readFileSync(resolve(args.filePath), 'utf8') } catch { throw new Error(`cannot read file: ${args.filePath}`) }
      }
      if (typeof code !== 'string' || !code.trim()) throw new Error('code (or filePath) must provide non-empty code')
      s.code = code.trim()
      if (args.filePath) s.filePath = resolve(args.filePath)
      s.status = 'done'
      s.state = 'review'
      r.record(LEVEL2_NAMES[0], 'review', 'task_result', 'level1_main', s.id, s.desc, 'done (L2 takeover)', s.acceptance)
      return { subtaskId: s.id, state: s.state, registered: true }
    },
  }
}

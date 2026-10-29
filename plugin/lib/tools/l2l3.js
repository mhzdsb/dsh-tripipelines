// dsh-pipeline — Level-2/3 tool factories: LLM decomposition, the L3 executor core
// (executeOneL3Task + single/batch dispatch), review, takeover registration and the
// one-shot local-executor spawn.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { text, safeParseJson, splitIntoChunks, estimateTokens, compressText, normalizeStatus, contentText, numCfg, LEVEL2_NAMES, jsonOutput } from '../util.js'
import { buildL3ExecutorPrompt } from '../prompts.js'
import { gateSubtask, gateTask } from '../gates.js'
import { addRunUsage } from '../store.js'

// v103 — resolve tool-supplied paths against the calling workspace, not the
// daemon process cwd (which is the profile directory).
// v111 (B3) — confine to the workspace: absolute paths and `..` escapes are
// refused, so a prompt-injected L2 cannot read/write files outside the project.
function wsPath(r, p) {
  const root = resolve((r && r.store && r.store.workspaceRoot) || process.cwd())
  const raw = String(p ?? '').trim()
  if (!raw) throw new Error('path must be a non-empty string')
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`absolute path not allowed: ${raw} (pass a workspace-relative path)`)
  }
  const abs = resolve(root, raw)
  const win = process.platform === 'win32'
  const normRoot = win ? root.toLowerCase() : root
  const normAbs = win ? abs.toLowerCase() : abs
  if (normAbs !== normRoot && !normAbs.startsWith(normRoot + sep)) {
    throw new Error(`path escapes the workspace: ${raw}`)
  }
  return abs
}

const sha8 = (s) => createHash('sha1').update(String(s ?? '')).digest('hex').slice(0, 8)

// Paths recorded by the plugin were confined when written; legacy board records
// may still hold an absolute path, so only NEW tool arguments go through wsPath.
function fileAbs(r, p) {
  const raw = String(p ?? '').trim()
  if (!raw) return null
  if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) return resolve(raw)
  return wsPath(r, raw)
}

// v111 (B7/O6) — write L3 output to the real workspace file at execute time so
// the reviewer gates the file on disk and the code is shipped exactly once.
// The absolute path is kept OUTSIDE the board payload; results carry the
// workspace-relative path only.
function writeWorkspaceFile(r, cfg, relPath, code) {
  const abs = wsPath(r, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, code, 'utf8')
  addRunUsage(r, cfg, 0, [abs])
  return abs
}

// Level-2 decomposition via the configured flash model (deepseek-v4.1-flash).
// Returns an array of subtask descriptions, or throws to trigger the
// deterministic fallback.
async function decomposeViaLlm(ctx, cfg, task, signal) {
  const llm = ctx.llm
  if (!llm) throw new Error('llm service unavailable')
  const prompt = [
    'You are a Level-2 module lead. Split the following task into tiny subtasks for a Level-3 local executor.',
    `Each subtask is a single concrete step of at most ${cfg.maxCodeLines} lines of code or ${cfg.level3InputBudget} tokens of input.`,
    'Return ONLY a JSON array of objects: [{"desc":"...","acceptance":"..."}]. No prose, no markdown fences.',
    'Every subtask must carry its OWN acceptance: one short mechanically checkable sentence or an assertion, not the module acceptance.',
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
  // v111 (B4) — accept both shapes: an object with its own acceptance, or a
  // bare string (older models). A missing per-subtask acceptance falls back to
  // the module acceptance in the caller, never silently reused here.
  const subs = parsed
    .map((s) => (typeof s === 'string'
      ? { desc: s.trim(), acceptance: null }
      : { desc: String(s?.desc ?? '').trim(), acceptance: String(s?.acceptance ?? '').trim() || null }))
    .filter((s) => s.desc)
  if (subs.length === 0) throw new Error('Level-2 model returned no subtasks')
  // v105 — account for the L2 decomposition call (it used to be invisible in the run ledger).
  return { subs, tokens: estimateTokens(prompt) + estimateTokens(text) }
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
      let fallbackReason
      try {
        const result = await decomposeViaLlm(ctx, cfg, task, exec.signal)
        chunks = result.subs
        via = 'llm'
        if (result.tokens > 0) {
          addRunUsage(r, cfg, result.tokens, [])
          r.store.counters.l2Decompose = (r.store.counters.l2Decompose ?? 0) + 1
        }
      } catch (err) {
        chunks = splitIntoChunks(task.desc, cfg.level3InputBudget)
        via = 'deterministic'
        // v111 — surface WHY the L2 model was bypassed instead of hiding it.
        fallbackReason = String(err?.message ?? err).slice(0, 160)
      }
      const created = []
      let n = task.subtaskIds.length
      for (const chunk of chunks) {
        const item = typeof chunk === 'string' ? { desc: chunk, acceptance: null } : chunk
        const sid = `${task.id}-s${++n}`
        // v111 (B4) — each subtask carries its OWN acceptance; the module
        // acceptance is only the fallback for a deterministic split.
        const acceptance = item.acceptance ?? task.acceptance
        r.store.subtasks.set(sid, {
          id: sid,
          parent: task.id,
          desc: item.desc,
          acceptance,
          state: 'pending',
          status: null,
          code: null,
          reason: null,
          failCount: 0,
        })
        task.subtaskIds.push(sid)
        created.push(sid)
        r.record(LEVEL2_NAMES[0], 'pending', 'task_assignment', 'level3_local', sid, item.desc, null, acceptance)
      }
      return {
        ok: true,
        taskId: task.id,
        assignee: task.assignee,
        via,
        ...(fallbackReason ? { fallbackReason } : {}),
        subtasks: created.map((id) => {
          const s = r.store.subtasks.get(id)
          return { id, desc: s.desc, acceptance: s.acceptance }
        }),
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
    description:
      'Run ONE tiny subtask on the local L3 engine (text in, JSON out). With filePath the plugin writes the file and returns path/lines/sha8 instead of the code.',
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
        filePath: {
          type: 'string',
          description: 'Optional workspace-relative file to write the L3 code to (recommended: avoids echoing the code back).',
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
      if (args.filePath) subtask.filePath = String(args.filePath)

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
    filePath: spec.filePath ? String(spec.filePath) : null,
    fileSha8: null,
    reason: null,
    failCount: 0,
  }
}

// Execute ONE Level-3 subtask: budget guard -> compressed prompt -> OpenAI call ->
// JSON parse -> retry / escalation / bookkeeping. Shared by local + batch.
async function executeOneL3Task(subtask, cfg, r, exec) {
  if (!String(cfg.level3Endpoint ?? '').trim()) {
    subtask.state = 'failed'
    subtask.reason = 'level3Endpoint 未配置（/pipe-config level3Endpoint http://127.0.0.1:8080/v1）'
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, blocked: true, subtaskId: subtask.id, reason: subtask.reason }
  }
  // L1 context compression happens BEFORE the budget check: if compression can
  // bring the task under budget, run it; only a still-oversized task is refused.
  const compressedDesc = compressText(subtask.desc, cfg.level3Compression)
  const compressedAcceptance = compressText(subtask.acceptance, cfg.level3Compression)
  // Token-budget guard (avoids small-model long-context degradation).
  const inTokens = estimateTokens(compressedDesc)
  if (inTokens > cfg.level3InputBudget) {
    subtask.state = 'failed'
    subtask.reason = `input ${inTokens} tokens still exceeds Level-3 budget ${cfg.level3InputBudget}; split the subtask into smaller steps`
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, blocked: true, subtaskId: subtask.id, reason: subtask.reason, inputTokens: inTokens }
  }

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

  // v104 — a non-object payload (null, a bare string, malformed JSON) is a
  // failed subtask, not code="null" queued for review.
  if (!parsed || typeof parsed !== 'object') {
    subtask.failCount = (subtask.failCount ?? 0) + 1
    const max = numCfg(cfg, 'maxLevel3Retries', 2)
    subtask.reason = `local model returned a non-object payload: ${String(parsed).slice(0, 120)}`
    if (subtask.failCount >= max) {
      subtask.state = 'failed'
      subtask.reason += ` (retried ${subtask.failCount}/${max}; escalate: Level-2 takes over, then Level-1)`
      r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
      return { ok: false, subtaskId: subtask.id, state: 'failed', escalated: true, failCount: subtask.failCount, reason: subtask.reason }
    }
    subtask.state = 'pending'
    r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
    return { ok: false, subtaskId: subtask.id, state: 'pending', retryable: true, failCount: subtask.failCount, reason: `${subtask.reason} (attempt ${subtask.failCount}/${max})` }
  }

  r.store.counters.llmCalls += 1
  r.store.counters.tokensIn += usage.promptTokens ?? inTokens
  r.store.counters.tokensOut += usage.completionTokens ?? 0
  r.store.counters.l3Calls += 1
  r.store.counters.l3TokensIn += usage.promptTokens ?? inTokens
  r.store.counters.l3TokensOut += usage.completionTokens ?? 0
  // v89 — feed the run budget (L3 tokens; L2 tokens are not observable here).
  addRunUsage(r, cfg, (usage.promptTokens ?? inTokens) + (usage.completionTokens ?? 0), [])

  // v104 — keep the id the model echoed so the review gate can verify it; the
  // board always carries OUR subtask id, never a self-certified copy of it.
  subtask.l3SubtaskId = typeof parsed.subtask_id === 'string' ? parsed.subtask_id : null
  subtask.code = typeof parsed.code === 'string'
    ? parsed.code
    : (parsed.code == null ? null : JSON.stringify(parsed.code))
  subtask.status = normalizeStatus(parsed.status)

  // v111 (B7/O6) — with a filePath the code is shipped to disk right here and is
  // NEVER echoed back: the reviewer gates the real file, the caller gets
  // path/lines/sha8 (one payment instead of two).
  if (subtask.filePath && typeof subtask.code === 'string' && subtask.code.trim()) {
    try {
      subtask.filePathAbs = writeWorkspaceFile(r, cfg, subtask.filePath, subtask.code)
      subtask.fileSha8 = sha8(subtask.code)
      subtask.codeBytes = Buffer.byteLength(subtask.code, 'utf8')
    } catch (err) {
      subtask.state = 'failed'
      subtask.reason = `cannot write ${subtask.filePath}: ${err?.message ?? err}`
      r.record('level3_local', 'failed', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.reason, subtask.acceptance)
      return { ok: false, subtaskId: subtask.id, state: 'failed', reason: subtask.reason }
    }
  }

  subtask.state = 'review'
  r.record('level3_local', 'review', 'task_result', LEVEL2_NAMES[0], subtask.id, subtask.desc, subtask.status, subtask.acceptance)
  const out = {
    ok: true,
    subtaskId: subtask.id,
    state: 'review',
    status: subtask.status,
    compressed: cfg.level3Compression === 'L1',
    inputTokens: inTokens,
    usage,
  }
  if (subtask.filePath) {
    out.path = subtask.filePath
    out.lines = String(subtask.code ?? '').split('\n').length
    out.sha8 = subtask.fileSha8 ?? null
  } else {
    out.code = subtask.code
  }
  return out
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
              filePath: { type: 'string', description: '可选：工作区相对路径；给出后插件写入该文件并只回 path/lines/sha8（不回代码）。' },
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
        // v111 (B7) — an explicit filePath must stay inside the workspace; a
        // path recorded by the plugin is already confined (legacy records may be
        // absolute). When a file is known, the FILE is the truth.
        const explicitAbs = args.filePath ? wsPath(r, args.filePath) : null
        const recordedAbs = !explicitAbs && s.filePath ? fileAbs(r, s.filePath) : null
        const abs = explicitAbs ?? recordedAbs
        let gate
        if (abs) {
          let readErr = null
          if (existsSync(abs)) {
            try { code = readFileSync(abs, 'utf8') } catch (err) { readErr = err }
          }
          if (readErr || !existsSync(abs)) {
            gate = {
              ok: false,
              score: 0,
              checks: [{ name: `file-on-disk (${s.filePath ?? args.filePath})`, pass: false }],
            }
          } else {
            s.code = code
            s.filePath = args.filePath ? String(args.filePath) : s.filePath
            s.fileSha8 = sha8(code)
            gate = gateSubtask({ subtask_id: s.l3SubtaskId ?? null, code, status: s.status }, s.id, s.acceptance, cfg, r.store.stateDir)
            gate.checks = [{ name: 'file-on-disk', pass: true }, ...gate.checks]
          }
        } else {
          gate = gateSubtask({ subtask_id: s.l3SubtaskId ?? null, code, status: s.status }, s.id, s.acceptance, cfg, r.store.stateDir)
        }
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
          try { fileCode = readFileSync(wsPath(r, args.filePath), 'utf8') } catch { throw new Error(`cannot read file: ${args.filePath}`) }
        }
        // v111 (B7) — a subtask that recorded a file must still HAVE that file:
        // module acceptance must not hide a missing deliverable.
        if (!args.filePath) {
          const missing = subs.filter((s) => s.filePath && !existsSync(fileAbs(r, s.filePath)))
          if (missing.length > 0) {
            const reason = `missing files: ${missing.map((s) => `${s.id}:${s.filePath}`).join(', ')}`
            t.state = 'failed'
            t.reason = reason
            r.record(t.assignee, 'failed', 'review_result', 'level1_main', t.id, t.desc, reason, t.acceptance)
            return { level: 2, id: t.id, ok: false, blocked: true, reason, state: 'failed' }
          }
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
        const gate = gateTask(t, subs, cfg, fileCode, r.store.stateDir)
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
        const gate = gateSubtask({ subtask_id: a.subtaskId ?? null, code: a.code, status: a.status }, a.subtaskId ?? null, acceptance, cfg, r.store.stateDir)
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
        filePath: { type: 'string', description: 'Optional workspace-relative file; the plugin writes it and returns path/lines instead of code.' },
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
          provider: cfg.spawnProvider || 'spawn',
          label: 'level3-executor',
          request: {
            prompt: [{ type: 'text', text: buildL3ExecutorPrompt(args.prompt, args.acceptance, cfg) }],
            parent: exec.agent,
            agentOptions: { provider: cfg.level3Provider || 'ninfer-local', model: cfg.level3Model },
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
          provider: cfg.level3Provider || 'ninfer-local',
          model: cfg.level3Model,
        })
        // v103 — L3 runs in the daemon profile cwd; bind it to this workspace.
        try { r.bindChild?.(run.childId) } catch { /* best-effort */ }
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
        // v111 (B7/O6) — with filePath the generated code lands on disk here and
        // is not echoed back to the caller.
        const out = {
          runId: run.childId,
          provider: cfg.level3Provider || 'ninfer-local',
          model: cfg.level3Model,
          state,
          reason,
          status,
        }
        if (args.filePath && state === 'done' && typeof code === 'string' && code.trim()) {
          try {
            const abs = writeWorkspaceFile(r, cfg, args.filePath, code)
            out.path = String(args.filePath)
            out.lines = code.split('\n').length
            out.sha8 = sha8(code)
            if (agent) {
              agent.filePath = out.path
              agent.filePathAbs = abs
              agent.fileSha8 = out.sha8
            }
          } catch (err) {
            state = 'failed'
            reason = `cannot write ${args.filePath}: ${err?.message ?? err}`
            out.state = state
            out.reason = reason
          }
        } else {
          out.code = code
        }
        if (agent) {
          agent.state = state
          agent.reason = reason
          agent.code = code
          agent.status = status
        }
        r.record(LEVEL2_NAMES[0], state, 'agent_l3_result', 'level3_local', run.childId, args.prompt, reason ?? status ?? state, null)
        return out
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
        filePath: { type: 'string', description: 'Optional workspace-relative file; when given the file is the truth.' },
      },
    },
    output: jsonOutput(),
    execute(args) {
      const s = r.store.subtasks.get(args.subtaskId)
      if (!s) throw new Error(`unknown subtask id: ${args.subtaskId}`)
      let code = args.code
      let abs = null
      // v111 (B3) — filePath is confined to the workspace; a listed file wins
      // over an inlined copy.
      if (args.filePath) {
        abs = wsPath(r, args.filePath)
        try { code = readFileSync(abs, 'utf8') } catch { throw new Error(`cannot read file: ${args.filePath}`) }
      }
      if (typeof code !== 'string' || !code.trim()) throw new Error('code (or filePath) must provide non-empty code')
      s.code = code.trim()
      if (abs) {
        s.filePath = String(args.filePath)
        s.filePathAbs = abs
        s.fileSha8 = sha8(s.code)
        // v105 — a takeover that lands code on disk counts toward maxFilesPerRun.
        addRunUsage(r, cfg, 0, [abs])
      }
      s.status = 'done'
      s.state = 'review'
      r.record(LEVEL2_NAMES[0], 'review', 'task_result', 'level1_main', s.id, s.desc, 'done (L2 takeover)', s.acceptance)
      return { subtaskId: s.id, state: s.state, registered: true, ...(s.filePath ? { path: s.filePath } : {}) }
    },
  }
}

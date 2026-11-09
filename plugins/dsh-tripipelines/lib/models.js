// dsh-tripipelines — per-project model onboarding (v121).
//
// The user must be able to pick the L2 / L3 model at the START of every project,
// without remembering model ids or editing config files. This module is the
// single place that answers "what is available on this machine?":
//   - L2: every model each `ctx.llm` provider advertises (listProviders/listModels)
//   - L3: every id the local OpenAI-compatible engine returns from GET /models,
//         in engine order (so the first one is "本机排序第一")
// Both discoveries have a deterministic fallback (configured value + built-in
// MODEL_PROFILES) because the local engine is often offline when a project starts.
// Rendering is pure: one copyable `/pipe-config ...` line per model.
import { DEFAULT_CONFIG, MODEL_PROFILES, TUNE_TARGETS, FALLBACK_SWEET_RATIO, FALLBACK_DANGER_RATIO, savePersistedConfig } from './config.js'

const L2_PROFILE_IDS = Object.entries(MODEL_PROFILES).filter(([, p]) => p.tier === 'l2').map(([id]) => id)
const L3_PROFILE_IDS = Object.entries(MODEL_PROFILES).filter(([, p]) => p.tier === 'l3').map(([id]) => id)

export const MODEL_SETUP_TIMEOUT_MS = 4000

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

function withTimeout(promise, ms, label = 'operation') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

// Accepts the OpenAI `/models` shape ({data:[{id}]}), a bare array, or a bare
// `{models:[...]}` payload. Order is preserved and empty ids are dropped.
export function extractModelIds(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : []
  const ids = []
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id
    if (typeof id === 'string' && id.trim() && !ids.includes(id.trim())) ids.push(id.trim())
  }
  return ids
}

// v122 — a model id is only valid on the providers that advertise it. Sending
// `qwen3.7-plus` to `deepseek-official` fails at the API with an opaque
// "supported API model names are ..." error, which lands in the user's chat.
// Discovery is cached briefly because spawning checks the same pairing often.
const MODEL_CACHE = new Map()
const MODEL_CACHE_TTL_MS = 60_000

async function providerModelIds(llm, provider, timeoutMs) {
  const now = Date.now()
  const hit = MODEL_CACHE.get(provider)
  if (hit && now - hit.at < MODEL_CACHE_TTL_MS) return hit.ids
  const list = await withTimeout(llm.listModels(provider), timeoutMs, `listModels(${provider})`)
  const ids = (Array.isArray(list) ? list : [])
    .map((m) => (typeof m === 'string' ? m : m?.id))
    .filter((id) => typeof id === 'string' && id.trim())
  MODEL_CACHE.set(provider, { at: now, ids })
  return ids
}

// Does `provider` actually serve `model`? Returns
//   {ok:true}                              pairing valid (or llm unavailable → skipped)
//   {ok:false, suggested, providers}       model lives on another provider
//   {ok:false, unknown:true}               no provider advertises it (warn only)
// Never throws: a broken llm must not block a spawn.
export async function resolveModelProvider(ctx, { provider, model } = {}, { timeoutMs = 2000 } = {}) {
  const result = { ok: true, provider, model, providers: [], suggested: null, unknown: false, skipped: false, error: null }
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm
  if (!llm || typeof llm.listModels !== 'function' || !model) {
    result.skipped = true
    return result
  }
  let providerIds = []
  try {
    const list = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    providerIds = (Array.isArray(list) ? list : []).map((p) => p?.id ?? p?.provider).filter(Boolean)
  } catch (e) {
    result.skipped = true
    result.error = String(e?.message ?? e)
    return result
  }
  try {
    const own = await providerModelIds(llm, provider, timeoutMs)
    if (own.includes(model)) return result
    const matches = []
    for (const pid of providerIds) {
      if (!pid || pid === provider) continue
      try {
        const ids = await providerModelIds(llm, pid, timeoutMs)
        if (ids.includes(model)) matches.push(pid)
      } catch { /* one broken provider must not hide the others */ }
    }
    if (matches.length > 0) {
      result.ok = false
      result.providers = matches
      result.suggested = matches[0]
    } else {
      result.ok = false
      result.unknown = true
    }
    return result
  } catch (e) {
    result.skipped = true
    result.error = String(e?.message ?? e)
    return result
  }
}

// L2 candidates: {models:[{id,name,providers,fallback}], providers, errors, source}.
export async function discoverLevel2Models(ctx, cfg = DEFAULT_CONFIG, { timeoutMs = MODEL_SETUP_TIMEOUT_MS } = {}) {
  const llm = ctx && typeof ctx.get === 'function' ? ctx.get('llm') : ctx?.llm
  const models = []
  const providers = []
  const errors = []
  let providerList = []
  try {
    providerList = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  } catch (e) {
    errors.push(`listProviders: ${e?.message ?? e}`)
  }
  for (const p of Array.isArray(providerList) ? providerList : []) {
    const pid = p?.id ?? p?.provider
    if (!pid || providers.includes(pid)) continue
    providers.push(pid)
    if (typeof llm?.listModels !== 'function') {
      errors.push('llm.listModels 不可用')
      break
    }
    try {
      const list = await withTimeout(llm.listModels(pid), timeoutMs, `listModels(${pid})`)
      for (const m of Array.isArray(list) ? list : []) {
        const id = typeof m === 'string' ? m : m?.id
        if (!id) continue
        const hit = models.find((x) => x.id === id)
        if (hit) {
          if (!hit.providers.includes(pid)) hit.providers.push(pid)
        } else {
          models.push({
            id,
            name: (typeof m === 'object' && m?.name) || id,
            providers: [pid],
            fallback: false,
          })
        }
      }
    } catch (e) {
      errors.push(`${pid}: ${e?.message ?? e}`)
    }
  }
  let source = 'llm'
  if (models.length === 0) {
    source = 'fallback'
    for (const id of uniq([cfg?.level2Model, DEFAULT_CONFIG.level2Model, ...L2_PROFILE_IDS])) {
      models.push({
        id,
        name: id,
        providers: uniq([cfg?.level2Provider, DEFAULT_CONFIG.level2Provider]),
        fallback: true,
      })
    }
    if (errors.length === 0) errors.push('llm 服务不可用（ctx.llm 未注入或没有 provider）')
  }
  return { models, providers, errors, source }
}

// Default L2 = flash model (the user's stated default), provider stays the
// configured one when that provider actually offers it.
export function pickDefaultLevel2(discovery, cfg = DEFAULT_CONFIG) {
  const models = discovery?.models ?? []
  if (models.length === 0) return null
  const preferredProvider = cfg?.level2Provider ?? DEFAULT_CONFIG.level2Provider
  const chosen =
    models.find((m) => m.id === DEFAULT_CONFIG.level2Model) ??
    models.find((m) => /flash/i.test(m.id)) ??
    models.find((m) => m.id === cfg?.level2Model) ??
    models[0]
  const provider = chosen.providers.includes(preferredProvider) ? preferredProvider : chosen.providers[0] ?? preferredProvider
  return { model: chosen.id, name: chosen.name, provider }
}

// L3 candidates: {models:[{id,rank,source}], source, endpoint, errors, configured}.
// `rank` is the /models order (1-based); it is null for the offline fallback so
// the UI never claims a local ranking it could not observe.
export async function discoverLevel3Models(cfg = DEFAULT_CONFIG, { fetchImpl, timeoutMs = MODEL_SETUP_TIMEOUT_MS } = {}) {
  const endpoint = String(cfg?.level3Endpoint ?? '').trim().replace(/\/+$/, '')
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  const errors = []
  let ids = []
  let source = 'fallback'
  if (endpoint && doFetch) {
    const url = `${endpoint}/models`
    try {
      const res = await withTimeout(doFetch(url, { signal: AbortSignal.timeout(timeoutMs) }), timeoutMs + 1500, `GET ${url}`)
      if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? '?'}`)
      const found = extractModelIds(await withTimeout(res.json(), timeoutMs, `解析 ${url}`))
      if (found.length > 0) {
        ids = found
        source = 'engine'
      } else {
        errors.push(`${url} 没有返回模型 id`)
      }
    } catch (e) {
      errors.push(`${endpoint}: ${e?.message ?? e}`)
    }
  } else if (!endpoint) {
    errors.push('level3Endpoint 未配置')
  } else {
    errors.push('当前宿主没有 fetch')
  }
  if (ids.length === 0) {
    ids = uniq([cfg?.level3Model, DEFAULT_CONFIG.level3Model, ...L3_PROFILE_IDS])
  }
  return {
    models: ids.map((id, i) => ({ id, name: id, rank: source === 'engine' ? i + 1 : null, source })),
    source,
    endpoint,
    errors,
    configured: cfg?.level3Model ?? DEFAULT_CONFIG.level3Model,
  }
}

export function pickDefaultLevel3(discovery, cfg = DEFAULT_CONFIG) {
  const models = discovery?.models ?? []
  if (models.length === 0) return null
  const chosen =
    (discovery?.source === 'engine' ? models[0] : null) ??
    models.find((m) => m.id === cfg?.level3Model) ??
    models.find((m) => m.id === DEFAULT_CONFIG.level3Model) ??
    models[0]
  return { model: chosen.id, name: chosen.name, rank: chosen.rank, source: discovery?.source ?? 'fallback' }
}

// The block the L1 pastes into the chat VERBATIM. Every model gets its own
// copyable line; the defaults are marked; provider ambiguity is explained.
export function renderModelSetupMessage({ l2, l3, defaults, current, alreadyConfigured = false, applied = null, activationAsk = false } = {}) {
  const l2Models = l2?.models ?? []
  const l3Models = l3?.models ?? []
  const l2Default = defaults?.level2
  const l3Default = defaults?.level3
  const cur = current ?? {
    level2Provider: DEFAULT_CONFIG.level2Provider,
    level2Model: DEFAULT_CONFIG.level2Model,
    level3Model: DEFAULT_CONFIG.level3Model,
  }
  const lines = []
  const off = cur.level3Mode === 'off'
  if (applied) {
    lines.push(`✅ 模型已定：L2 = ${cur.level2Provider}/${cur.level2Model} ｜ L3 = ${off ? '已关闭（两级协作）' : `${cur.level3Model}（${cur.level3Mode ?? 'auto'} 模式）`}`)
    lines.push(
      applied.changed?.length
        ? `（已更新：${applied.changed.join(', ')}；本项目记下了这套选择。）`
        : '（沿用当前 /pipe-config 配置，已按本项目记下；要换就复制上面的命令。）',
    )
    lines.push('')
  } else if (alreadyConfigured) {
    lines.push('✅ 本项目已经定过模型（下面是当前值；要换模型复制对应命令发给我即可）。')
    lines.push('')
  }
  lines.push('🚦 开工前先定模型 —— 不指定就直接用【默认】；想换哪个，把下面任意一行命令复制到输入框发给我即可。')
  if (activationAsk) {
    // v125 — the one-time workspace activation gate rides along, so a brand-new
    // project only ever sees ONE onboarding dialog instead of two in a row.
    lines.push('（这也是本工作区第一次启用三级流水线：下一条提问会顺带确认是否启用，不用再单独问一次。）')
  }
  lines.push('')
  lines.push(`当前：L1 = 本对话所用模型 ｜ L2 = ${cur.level2Provider ?? '?'}/${cur.level2Model ?? '?'} ｜ L3 = ${off ? '已关闭（两级协作）' : `${cur.level3Model ?? '?'}（${cur.level3Mode ?? 'auto'} 模式）`}`)
  const curEntry = l2Models.find((m) => m.id === cur.level2Model)
  const pairingBroken = curEntry && curEntry.providers?.length && !curEntry.providers.includes(cur.level2Provider)
  if (pairingBroken) {
    lines.push(`🚨 当前 L2 配对无效：${cur.level2Model} 不在 ${cur.level2Provider ?? '?'} 下（应在 ${curEntry.providers.join(', ')}）。先发：/pipe-config level2Provider ${curEntry.providers[0]}`)
  }
  lines.push(
    `默认：L2 = ${l2Default?.model ?? cur.level2Model ?? '?'}` +
      (off
        ? ' ｜ L3 = 无（关闭三级时默认就是两级；恢复见下面 ②）'
        : ` ｜ L3 = ${l3Default?.model ?? cur.level3Model ?? '?'}` +
          (l3?.source === 'engine' ? '（本机 /models 排序第 1）' : '（引擎未在线，取配置值）')),
  )
  lines.push('')
  lines.push('① 二级模型 L2（模块负责人：拆任务 + 写多文件代码）')
  if (l2Models.length === 0) {
    lines.push('   （没有发现可用模型；检查 llm 服务后重跑 pipeline_model_setup）')
  } else {
    // v122 — group by provider so a model line copied from here can never keep the
    // wrong provider. Models under the current provider need no extra line; every
    // other group gets a copyable `/pipe-config level2Provider` line above it.
    const curProvider = cur.level2Provider
    const groups = []
    for (const m of l2Models) {
      const pid = (m.providers && m.providers[0]) || '未知 provider'
      let group = groups.find((g) => g.provider === pid)
      if (!group) {
        group = { provider: pid, models: [] }
        groups.push(group)
      }
      group.models.push(m)
    }
    for (const group of groups) {
      if (group.provider !== curProvider) {
        lines.push(`   # provider ${group.provider}（当前 L2 provider 是 ${curProvider ?? '?'}；选下面任一模型前先发这一行）`)
        lines.push(`   /pipe-config level2Provider ${group.provider}`)
      }
      for (const m of group.models) {
        const isDefault = l2Default?.model === m.id
        const providers = m.providers?.length ? m.providers.join(', ') : '未知 provider'
        const name = m.name && m.name !== m.id ? ` · ${m.name}` : ''
        const fallback = m.fallback ? '（内置候选）' : ''
        lines.push(`   /pipe-config level2Model ${m.id}${isDefault ? '   ← 默认' : ''}   # ${providers}${name}${fallback}`)
      }
    }
    lines.push('   只发 level2Model 会沿用当前 provider；跨 provider 选模型时，把该分组上方的 level2Provider 行一起发。')
  }
  lines.push('')
  if (cur.level3Mode === 'off') {
    // v124 — L3 is switched off: no executor list to offer, just the way back.
    lines.push('② 三级模型 L3 —— 已关闭（level3Mode=off）')
    lines.push('   当前为两级协作：L1 规划 + L2 自己写代码，不派发三级执行器。')
    lines.push('   /pipe-config level3Model <id> mode=auto   # 想恢复三级：重新指定模型并回到 auto/executor/agent')
    lines.push('   /pipe-config level3Mode auto              # 或只切回模式（沿用原模型）')
    lines.push('')
    lines.push('不想用三级协作：回复「不用三级模式」或 /pipe-config mode off。')
    return lines.join('\n')
  }
  lines.push('② 三级模型 L3（executor：本机端点一次性执行 ｜ agent：DSH 子代理，走云端 provider）')
  if (l3Models.length === 0) {
    lines.push('   （没有发现可用模型；检查 level3Endpoint 后重跑 pipeline_model_setup）')
  } else {
    for (const m of l3Models) {
      const isDefault = l3Default?.model === m.id
      const rank = m.rank ? `本机第 ${m.rank} 位` : m.source === 'fallback' ? '内置档案' : '本机模型'
      lines.push(`   /pipe-config level3Model ${m.id}${isDefault ? '   ← 默认' : ''}   # ${rank}`)
    }
    const example = l2Models[0]?.id ?? cur.level2Model
    if (example) {
      lines.push('   云端模型也能当 L3（agent 模式；provider 自动配对，不需要 level3Endpoint）：')
      lines.push(`   /pipe-config level3Model ${example} mode=agent   # 示例：换成上面 L2 列表里任意模型`)
    }
    // v124 — the L3-off switch lives next to the L3 list it disables.
    lines.push('   不想用三级执行器（只留 L1+L2，二级自己写代码）：')
    lines.push('   /pipe-config level3Mode off')
  }
  lines.push('')
  const l2Incomplete = l2?.source !== 'llm' && l2Models.length > 0
  const l3Offline = l3?.source !== 'engine' && l3Models.length > 0
  if (l2Incomplete) {
    lines.push(`⚠️ L2 列表不完整（${(l2?.errors ?? []).join('；')}），以上含配置值与内置档案。`)
  }
  if (l3Offline) {
    lines.push(`⚠️ 三级引擎未在线（${(l3?.errors ?? []).join('；')}），L3 列表来自配置与内置档案；启动引擎后重跑本工具可看到真实排序。`)
  }
  if (l2Incomplete || l3Offline) lines.push('')
  lines.push('不想用三级协作：回复「不用三级模式」或 /pipe-config mode off。')
  return lines.join('\n')
}

// ask_user_question payload the L1 should raise right after posting the message.
// v125 — when `activation` is passed (the workspace has never confirmed the
// pipeline itself), the onboarding question doubles as the one-time activation
// gate so a brand-new project faces ONE dialog instead of two back-to-back ones.
export function buildModelSetupQuestion({ defaults, level3Mode, activation } = {}) {
  // v125 — tri-state `activation`: true = the workspace gate is open and this dialog
  // carries it; false = gate already closed (plain model question); undefined =
  // legacy callers, keep the soft "前三项会记住启用" framing.
  const l2 = defaults?.level2?.model ?? DEFAULT_CONFIG.level2Model
  const off = level3Mode === 'off'
  const l3 = off ? '关闭（只用 L1+L2）' : defaults?.level3?.model ?? '本机排序第 1'
  const options = [
    { label: '用默认（推荐）', description: `L2 = ${l2}；L3 = ${l3}（不指定即默认）` },
    { label: '我自己指定', description: '复制消息里的 /pipe-config 命令发送，我按你的选择跑' },
  ]
  // v124 — a third path between "three tiers" and "no pipeline at all": keep L1+L2
  // but drop the executor tier. Only offer it when L3 is not already off.
  if (!off) {
    options.push({ label: '只用 L1+L2（关闭三级执行器）', description: '二级自己写代码（/pipe-config level3Mode off），一级规划与验收照常' })
  } else {
    options.push({ label: '恢复三级执行器', description: '重新启用 L3（/pipe-config level3Mode auto，沿用当前三级模型）' })
  }
  const mergedActivation = activation === undefined && !off
  options.push(
    mergedActivation
      ? { label: '本项目不用三级协作（并记住此工作区以后默认启用）', description: '这次单 agent 工作（/pipe-config mode off），下次直接启用流水线' }
      : { label: '本项目不用三级协作', description: '单 agent 工作（/pipe-config mode off）' },
  )
  return {
    header: '开工前定模型',
    question: activation === true
      ? `三级流水线要在这里启用吗？顺便定一下模型（默认 L2 = ${l2}，L3 = ${l3}；想换哪个，把上面对应的命令复制发给我）。选前三项都会启用。`
      : activation === false
        ? `本项目用哪套模型？（默认 L2 = ${l2}，L3 = ${l3}；想换哪个，把上面对应的命令复制发给我）`
        : `本项目用哪套模型？（默认 L2 = ${l2}，L3 = ${l3}；想换哪个，把上面对应的命令复制发给我）前三项同时会记住此工作区以后默认启用三级流水线。`,
    options,
    ...(activation === true || mergedActivation ? { activationMerged: true } : {}),
  }
}

// v128 — resolve the model's REAL context window for sweet-spot tuning. Profile hit
// wins; otherwise ask the host (`llm.resolveModelInfo`, 2s timeout, never throws).
export async function resolveHostTuning(ctx, cfg, tierKey, { timeoutMs = 2500 } = {}) {
  const keys = TUNE_TARGETS[tierKey]
  if (!keys || !cfg) return null
  const profile = MODEL_PROFILES[cfg[tierKey]]
  if (profile && Number.isFinite(profile.contextWindow)) {
    const window = Math.round(profile.contextWindow)
    // A built-in profile is exact for the models it lists; keep tuneSweetSpot's
    // precedence (its own ratio first, then the profile's). Only an explicit
    // sweetSpotRatio override can beat it.
    const ratio = Number.isFinite(cfg[keys.ratio]) ? Number(cfg[keys.ratio]) : Number(profile.sweetSpotRatio)
    if (!Number.isFinite(ratio) || ratio <= 0) return null
    const dangerRatio = Number(cfg[keys.dangerRatio]) > 0 ? Number(cfg[keys.dangerRatio]) : Number(profile.dangerRatio) || FALLBACK_DANGER_RATIO
    return { window, budget: Math.round(window * ratio), danger: Math.round(window * dangerRatio), source: 'profile' }
  }
  let llm = null
  try {
    llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
  } catch {
    llm = null
  }
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null
  const provider = tierKey === 'level1Model' ? null : cfg[String(tierKey).replace('Model', 'Provider')]
  let info = null
  try {
    info = await withTimeout(Promise.resolve(llm.resolveModelInfo(provider, cfg[tierKey])), timeoutMs, 'resolveModelInfo')
  } catch {
    return null
  }
  const window = Number(info?.context?.contextWindow)
  if (!Number.isFinite(window) || window <= 0) return null
  const ratio = Number.isFinite(cfg[keys.ratio]) && cfg[keys.ratio] > 0 ? Number(cfg[keys.ratio]) : FALLBACK_SWEET_RATIO
  const dangerRatio = Number.isFinite(cfg[keys.dangerRatio]) && cfg[keys.dangerRatio] > 0 ? Number(cfg[keys.dangerRatio]) : FALLBACK_DANGER_RATIO
  return { window: Math.round(window), budget: Math.round(window * ratio), danger: Math.round(window * dangerRatio), source: 'host' }
}

// v123 — `/pipe-config` is a sync command with no ctx, so after a model change the
// plugin wraps it with this best-effort follow-up: the provider (and for L3 the
// mode) must follow the model or the API rejects it with "supported API model
// names are ...". Mutates cfg, persists only the keys it corrected, returns notes.
export async function autoPairAfterConfig(ctx, cfg, changed = [], { timeoutMs = 2500, store = null } = {}) {
  const set = new Set(Array.isArray(changed) ? changed : [])
  const notes = []
  const patch = {}
  if (!cfg || typeof cfg !== 'object') return notes

  if (set.has('level2Model') && !set.has('level2Provider') && cfg.level2Model) {
    const probe = await resolveModelProvider(ctx, { provider: cfg.level2Provider, model: cfg.level2Model }, { timeoutMs })
    if (probe.suggested) {
      const from = cfg.level2Provider
      cfg.level2Provider = probe.suggested
      patch.level2Provider = probe.suggested
      notes.push(`🔧 ${cfg.level2Model} 不在 ${from} 下，已自动配套 level2Provider=${probe.suggested}`)
    } else if (probe.unknown) {
      notes.push(`⚠️ llm 列表里没找到 ${cfg.level2Model}，level2Provider 保持 ${cfg.level2Provider}`)
    } else if (probe.error) {
      notes.push(`⚠️ 无法校验 L2 provider（${probe.error}），保持 ${cfg.level2Provider}`)
    }
  }

  // v128 — sweet-spot numbers must follow the REAL window of the chosen model.
  // Built-in MODEL_PROFILES only covers a handful of ids; for anything else ask
  // the host (`resolveModelInfo`) and retune budget/danger/window from it, so the
  // board never paints an honest-looking meter against stale defaults (a 1M-window
  // qwen measured against deepseek-flash's old 32K/96K/128K). resolveHostTuning
  // reads ctx.get('llm') directly — no cfg injection needed.
  const retune = async (tierKey, label) => {
    if (!set.has(tierKey) || cfg.autoTuneSweetSpot !== true) return
    const t = await resolveHostTuning(ctx, cfg, tierKey, { timeoutMs })
    if (!t) {
      notes.push(`ℹ️ ${label} ${cfg[tierKey]}：内置档案与宿主都查不到窗口，甜点区保持现值——看板会标注“未知”，不画假刻度`)
      return
    }
    const keys = TUNE_TARGETS[tierKey]
    const pairs = [[keys.window, t.window], [keys.budget, t.budget], [keys.danger, t.danger]]
    let any = false
    for (const [field, to] of pairs) {
      if (cfg[field] !== to) {
        notes.push(`🔧 ${field}: ${cfg[field]} → ${to}（按${t.source === 'host' ? '宿主上报' : '内置档案'}窗口 ${t.window} 重算）`)
        cfg[field] = to
        patch[field] = to
        any = true
      }
    }
    if (!any) notes.push(`✔ ${label} 甜点区已对齐${t.source === 'host' ? '宿主' : '档案'}窗口（${t.window}）`)
  }
  await retune('level2Model', 'L2 甜点区')
  // v130 — L1 is not a config key: it's whatever model the chat session runs (v95).
  // bindSession caches its real window on store.context.level1Window; use that to
  // keep the L1 sweet spot honest when no profile knows the chat model. The async
  // host lookup in resolveHostTuning reads cfg.level1Model, which is display-only
  // for L1 and would tune against the WRONG model — so here the cached window wins.
  if (cfg.autoTuneSweetSpot === true) {
    const live = store?.context || {}
    const l1Keys = TUNE_TARGETS.level1Model
    const liveWindow = Number(live.level1Window) > 0 ? Math.round(Number(live.level1Window)) : null
    if (liveWindow && !MODEL_PROFILES[live.level1Model]) {
      const ratio = Number.isFinite(cfg[l1Keys.ratio]) && cfg[l1Keys.ratio] > 0 ? Number(cfg[l1Keys.ratio]) : FALLBACK_SWEET_RATIO
      const dangerRatio = Number.isFinite(cfg[l1Keys.dangerRatio]) && cfg[l1Keys.dangerRatio] > 0 ? Number(cfg[l1Keys.dangerRatio]) : FALLBACK_DANGER_RATIO
      const t = { window: liveWindow, budget: Math.round(liveWindow * ratio), danger: Math.round(liveWindow * dangerRatio), source: 'session' }
      let any = false
      for (const [field, to] of [[l1Keys.window, t.window], [l1Keys.budget, t.budget], [l1Keys.danger, t.danger]]) {
        if (cfg[field] !== to) {
          notes.push(`🔧 ${field}: ${cfg[field]} → ${to}（按会话实测窗口 ${t.window} 重算 L1）`)
          cfg[field] = to
          patch[field] = to
          any = true
        }
      }
      if (!any) notes.push(`✔ L1 甜点区已对齐会话模型窗口（${t.window}）`)
    } else if (set.has('level1Model') || !liveWindow) {
      // profiled chat model, or no cached window yet — the classic path tunes from
      // cfg.level1Model (a display fallback); with neither signal there is nothing
      // better to use, so still try it.
      await retune('level1Model', 'L1')
    }
  }

  if (set.has('level3Model') && cfg.level3Model) {
    // `mode=auto` means "detect", so only an explicit executor/agent survives
    // detection; a caller that changed level3Mode to auto still gets auto-picked.
    const modeExplicit = set.has('level3Mode') && cfg.level3Mode !== 'auto'
    const providerExplicit = set.has('level3Provider')
    // v124 — the user explicitly switched L3 off; never auto-re-enable it by
    // pairing a model they just stopped using. An explicit `mode=auto` on the
    // same command IS the re-enable signal and falls through to detection.
    if (cfg.level3Mode === 'off' && !(set.has('level3Mode') && modeExplicit)) {
      notes.push('ℹ️ 三级已关闭（level3Mode=off）：模型改动不会自动恢复三级；要重新启用发 /pipe-config level3Mode auto。')
      return notes
    }
    const engine = await discoverLevel3Models(cfg, { timeoutMs: Math.min(timeoutMs, 2500) })
    const inEngine = engine.source === 'engine' && engine.models.some((m) => m.id === cfg.level3Model)
    if (inEngine) {
      if (!modeExplicit && cfg.level3Mode !== 'executor') {
        cfg.level3Mode = 'executor'
        patch.level3Mode = 'executor'
        notes.push(`🔧 ${cfg.level3Model} 是本机引擎模型，level3Mode 已设为 executor`)
      }
    } else {
      const probe = await resolveModelProvider(ctx, { provider: cfg.level3Provider, model: cfg.level3Model }, { timeoutMs })
      if (probe.suggested) {
        if (!providerExplicit) {
          cfg.level3Provider = probe.suggested
          patch.level3Provider = probe.suggested
          notes.push(`🔧 ${cfg.level3Model} 是云端模型：已自动配套 level3Provider=${probe.suggested}`)
        }
        if (!modeExplicit) {
          cfg.level3Mode = 'agent'
          patch.level3Mode = 'agent'
          notes.push('🔧 level3Mode 已设为 agent（DSH 子代理，不经过 level3Endpoint）')
        }
      } else if (probe.ok && !probe.skipped) {
        if (!modeExplicit) {
          cfg.level3Mode = 'agent'
          patch.level3Mode = 'agent'
          notes.push(`🔧 ${cfg.level3Model} 由 ${cfg.level3Provider} 提供，level3Mode 已设为 agent`)
        }
      } else if (probe.unknown) {
        notes.push(`⚠️ ${cfg.level3Model} 不在本机引擎、也不在已发现的 llm provider 里；level3Mode 保持 ${cfg.level3Mode ?? 'auto'}`)
      }
    }
  }

  if (Object.keys(patch).length > 0) {
    try { savePersistedConfig(patch) } catch { /* best-effort */ }
  }
  return notes
}

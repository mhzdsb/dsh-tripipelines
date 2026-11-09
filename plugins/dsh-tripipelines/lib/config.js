// dsh-tripipelines — configuration: defaults, layered merge, sweet-spot tuning,
// and the /pipe-config command body. No DSH service access.
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { isPlainObj } from './util.js'

// Model capability profiles (v82). The "sweet spot" is no longer a hard-coded
// absolute value: it follows the model. Each profile declares the context window
// and (for L1/L2) the sweet-spot ratio of that window; L3 declares its num_ctx.
// `tier` documents which level the model is normally used at. This table is only
// a lookup for sweet-spot tuning — it never switches the actual L1 model (the
// harness decides that); `level1Model` exists purely to query this table.
export const MODEL_PROFILES = {
  // v129 — DeepSeek V4 family ships a 1M-token window (model card: "million-token
  // context intelligence"; Think Max recommends >=384K). Pre-v129 these were stuck
  // at the old 128K assumption, so the sweet spot said 32K for deepseek-flash —
  // far below what users observed in practice.
  // CAUTION: 'deepseek-pro' / 'deepseek-chat' / 'deepseek-reasoner' are legacy
  // aliases kept only so an old config still finds a profile; the harness's real
  // ids today are deepseek-flash / deepseek-v4-pro. Do NOT advertise them as L1
  // candidates (they resolve to nothing on the modern API).
  'deepseek-pro': { tier: 'l1', contextWindow: 1000000, sweetSpotRatio: 0.5, dangerRatio: 0.75 },
  'deepseek-chat': { tier: 'l1', contextWindow: 1000000, sweetSpotRatio: 0.5, dangerRatio: 0.75 },
  'deepseek-reasoner': { tier: 'l1', contextWindow: 1000000, sweetSpotRatio: 0.5, dangerRatio: 0.75 },
  'deepseek-v4-pro': { tier: 'l1', contextWindow: 1000000, sweetSpotRatio: 0.5, dangerRatio: 0.75 },
  'deepseek-flash': { tier: 'l2', contextWindow: 1000000, sweetSpotRatio: 0.25, dangerRatio: 0.75 },
  'qwen3:14b': { tier: 'l3', contextWindow: 32768, numCtx: 16384, dangerRatio: 0.9 },
  'qwen3:8b': { tier: 'l3', contextWindow: 32768, numCtx: 16384, dangerRatio: 0.9 },
  'qwen2.5:7b': { tier: 'l3', contextWindow: 32768, numCtx: 8192, dangerRatio: 0.9 },
  'qwen3.8-27b-gsq-rco-iq3-s-mtp': { tier: 'l3', contextWindow: 204800, numCtx: 204800, dangerRatio: 0.9 },
  // v93 — strata-local (local OpenAI-compatible engine registered in the
  // profile's cordis.patch.yml as `strata-local`, 127.0.0.1:8080/v1).
  'qwen3.8-flash-next-iq3_xxs': { tier: 'l3', contextWindow: 131072, numCtx: 131072, dangerRatio: 0.9 },
}

export const DEFAULT_CONFIG = {
  // Global CONFIG directory only (config.json). Runtime state — board.json,
  // requirement_lock.json, trace-*.jsonl, the L3 exec scratch dir — is
  // per-workspace since v83; see runtimeStateDir().
  stateDir: join(homedir(), '.dsh', 'pipeline'),
  level1Model: 'deepseek-pro',
  level2Provider: 'deepseek-official',
  level2Model: 'deepseek-flash',
  level3Model: 'qwen3.8-27b-gsq-rco-iq3-s-mtp',
  // v104 — no default endpoint: a fresh install must point this at its own
  // OpenAI-compatible engine (e.g. http://127.0.0.1:8080/v1) instead of silently
  // inheriting the author's machine.
  level3Endpoint: '',
  level3Provider: 'ninfer-local',
  // v123 — L3 is not necessarily the local one-shot engine. `auto` keeps both
  // paths available (legacy behaviour); `executor` forces the OpenAI-compatible
  // HTTP path; `agent` forces the DSH subagent path on a cloud provider.
  level3Mode: 'auto',
  spawnProvider: 'spawn',
  level3InputBudget: 1200,
  level3MaxOutputTokens: 4096,
  level3TimeoutMs: 900000,
  // v119 — `cmd:` acceptance runs in the workspace; bound it so a hung test
  // command fails the gate instead of hanging the review tool.
  commandAcceptanceTimeoutMs: 120000,
  semanticGateThreshold: 0.7,
  mode: 'auto',
  maxCodeLines: 100,
  maxLevel3Retries: 5,
  maxLevel3Concurrency: 1,
  maxLevel2Retries: 3,
  maxLevel2Agents: 10,
  level2ContextBudget: 250000, // v129: 1M×0.25 (was 32K under the old 128K assumption)
  level2SweetSpotRatio: 0.25,
  level2HandoffTtlMs: 300000,
  level1ContextBudget: 500000, // v129: 1M×0.5 (was 64K under the old 128K assumption)
  level1SweetSpotRatio: 0.5,
  // v97 — the real red line: past this many tokens the model's effective
  // capability degrades hard, so the card must warn before that, not at the
  // (merely optimal) sweet spot.
  // v129 — defaults follow the V4-family 1M window (see MODEL_PROFILES):
  // sweet = 1M×0.5/0.25, danger = 1M×0.75. tuneSweetSpot recomputes these on
  // any model change anyway; these are only the never-touched starting values.
  level1DangerBudget: 750000,
  level2DangerBudget: 750000,
  level1ContextWindow: 1000000,
  level2ContextWindow: 1000000,
  level1DangerRatio: 0.75,
  level2DangerRatio: 0.75,
  level1ContextWarnRatio: 0.8,
  autoTuneSweetSpot: true,
  level3Compression: 'L1',
  devDir: 'dev',
  // v89 — 控制权与护栏
  activationGate: true,
  maxTotalTokensPerRun: 500000,
  maxDurationPerRun: 7200000,
  maxFilesPerRun: 200,
  level3Engine: 'auto',
  // v104 — the acceptance gate executes model-written code. It stays on by
  // default (the whole point is executable acceptance), but a site can turn it
  // off: assertions then can never pass, so the gate fails closed instead of
  // silently falling back to a keyword score.
  allowCodeExecution: true,
  // v112 (B5) — the SKILL promises a "bounded L1 takeover" (L1 writes the code
  // itself, then registers + gates it), but pipeline_register_output/review were
  // hard L2/L3-only, so the documented path had no legal caller. Off by default:
  // L1 still delegates; turn it on only for the documented last-resort takeover.
  allowLevel1Takeover: false,
}

// Editable config keys for the /pipe-config command. Each entry declares its
// type so values typed by a human can be coerced and validated.
export const CONFIG_KEYS = {
  level1Model: { type: 'string', desc: '一级模型名（仅用于甜点区档案查询，不切换实际 L1 模型，L1 模型由 harness 决定）' },
  level2Provider: { type: 'string', desc: '二级模型 provider（DeepSeek 官方）' },
  level2Model: { type: 'string', desc: '二级模块负责人模型（做任务分解）' },
  level3Model: { type: 'string', desc: '三级本地模型（ninfer / OpenAI 协议）' },
  level3Endpoint: { type: 'string', desc: '本机 OpenAI 兼容接口基址（默认空，必须显式配置，例如 http://127.0.0.1:8080/v1；工具自动追加 /chat/completions）' },
  level3Provider: { type: 'string', desc: 'Level-3 子代理使用的 LLM provider 名（默认 ninfer-local；agent 模式下用）' },
  level3Mode: {
    type: 'enum',
    values: ['auto', 'executor', 'agent', 'off'],
    desc: '三级执行模式：auto=两条路都可用；executor=只走 OpenAI 兼容 HTTP（本地/自建端点）；agent=只走 DSH 子代理（云端 provider，如 token plan）；off=关闭三级，只用 L1+L2（二级直写代码）',
  },
  spawnProvider: { type: 'string', desc: '子代理 provider 名（默认 spawn；startActivation 用，通常不用改）' },
  level3InputBudget: { type: 'number', desc: '三级子任务输入 token 上限（默认 1200；超限先压缩，仍超则提示拆分）' },
  level3MaxOutputTokens: { type: 'number', desc: '三级输出 token 上限（默认 4096）' },
  level3TimeoutMs: { type: 'number', desc: '三级子任务超时毫秒（默认 900000=15 分钟；超时终止并重派）' },
  commandAcceptanceTimeoutMs: { type: 'number', desc: 'cmd: 命令验收的超时毫秒（默认 120000=2 分钟；超时判失败）' },
  semanticGateThreshold: { type: 'number', desc: '质量门控语义评分阈值（0~1；>0.5 时验收必须含断言或 cmd: 命令，否则计划阶段直接报错）' },
  mode: { type: 'enum', values: ['auto', 'on', 'off'], desc: '三级模式开关（auto=按项目评估，on=强制，off=关闭走单 agent）' },
  maxCodeLines: { type: 'number', desc: '三级子任务代码行数上限' },
  maxLevel3Retries: { type: 'number', desc: '三级子任务最大重试次数（超过即升级，不再重试）' },
  maxLevel3Concurrency: { type: 'number', desc: '三级本地执行器最大并发数（默认 1；ninfer 单实例串行）' },
  maxLevel2Retries: { type: 'number', desc: '二级接管/任务最大尝试次数（超过即上报 L1 干不了）' },
  maxLevel2Agents: { type: 'number', desc: '二级模块负责人数量上限' },
  level2ContextBudget: { type: 'number', desc: '二级模块上下文 token 预算（二级默认模型甜点区，1M 窗口×0.25=250K，v129；模块小型化参考；重建已改为无条件触发）' },
  level2SweetSpotRatio: { type: 'number', desc: '二级甜点区占模型窗口比例（默认 0.25；换 level2Model 且 autoTuneSweetSpot 开时按窗口×比例重算 level2ContextBudget）' },
  level2HandoffTtlMs: { type: 'number', desc: '旧二级交接存活毫秒（默认 300000=5 分钟，超时强制 drain）' },
  level1ContextBudget: { type: 'number', desc: '一级上下文 token 甜点区（默认 500000=1M×0.5，v129；接近时建议 checkpoint 交接）' },
  level1DangerBudget: { type: 'number', desc: '一级上下文危险线 token（仅提示：装了压缩代理时压力过线不代表能力打折，看板只在逼近此线时变琥珀、过线才变红；默认 750000=1M×0.75）' },
  level2DangerBudget: { type: 'number', desc: '二级上下文危险线 token（同 L1：压力口径的提醒线，非硬限制；默认 750000=1M×0.75）' },
  level1ContextWindow: { type: 'number', desc: '一级模型上下文窗口 token（默认 1000000，V4 家族 1M 窗口；看板横条按窗口画满，读数超过甜点/危险线时变色）' },
  level2ContextWindow: { type: 'number', desc: '二级模型上下文窗口 token（默认 1000000；看板横条按窗口画满，读数超过甜点/危险线时变色）' },
  level1DangerRatio: { type: 'number', desc: '一级危险线占模型窗口比例（默认 0.75；换 level1Model 且 autoTuneSweetSpot 开时按窗口×比例重算 level1DangerBudget）' },
  level2DangerRatio: { type: 'number', desc: '二级危险线占模型窗口比例（默认 0.75；换 level2Model 且 autoTuneSweetSpot 开时按窗口×比例重算 level2DangerBudget）' },
  level1SweetSpotRatio: { type: 'number', desc: '一级甜点区占模型窗口比例（默认 0.5；换 level1Model 且 autoTuneSweetSpot 开时按窗口×比例重算 level1ContextBudget）' },
  level1ContextWarnRatio: { type: 'number', desc: '一级上下文警告阈值比例（默认 0.8；totalTokens/level1ContextBudget 达到即提示 checkpoint——压缩代理下压力口径偏大，仅建议不阻断）' },
  autoTuneSweetSpot: { type: 'boolean', desc: '换模型时自动联动甜点区（默认 true；关掉则甜点区只由手动设置决定）' },
  level3Compression: { type: 'enum', values: ['L0', 'L1'], desc: '三级上下文压缩层级' },
  devDir: { type: 'string', desc: '开发过程文档目录（checkpoint/L2 state/交接文件，与生产文件分离，默认 dev）' },
  activationGate: { type: 'boolean', desc: '首次在某个工作区遇开发任务时先询问是否启用三级流水线（默认 true；关掉则自动启用）' },
  maxTotalTokensPerRun: { type: 'number', desc: '单次 run 累计 token 预算（超限自动暂停，0=不限）' },
  maxDurationPerRun: { type: 'number', desc: '单次 run 最大时长毫秒（超限自动暂停，0=不限）' },
  maxFilesPerRun: { type: 'number', desc: '单次 run 最多改动的文件数（超限自动暂停，0=不限）' },
  level3Engine: { type: 'enum', values: ['auto', 'ninfer', 'ollama', 'llamacpp', 'vllm', 'lmstudio', 'custom'], desc: '三级本地引擎提示（仅用于显示/探测/诊断，实际走 OpenAI 兼容接口）' },
  allowCodeExecution: { type: 'boolean', desc: '质量门在宿主机执行验收断言（默认 true；关掉则含断言的验收一律不通过，不再回落关键词分）' },
  allowLevel1Takeover: { type: 'boolean', desc: '允许 L1 在兜底时直接写代码并调用 pipeline_register_output / pipeline_review（默认 false；文档里的 bounded takeover 路径）' },
}

export const CONFIG_FILE = join(homedir(), '.dsh', 'pipeline', 'config.json')

export function loadPersistedConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    // best-effort; fall back to defaults
  }
  return {}
}

// v104 — persist ONLY explicitly changed keys. Writing the whole merged config
// leaked project-layer overrides into the user's global config.json.
export function savePersistedConfig(patch, opts = {}) {
  const clean = {}
  if (isPlainObj(patch)) {
    for (const key of Object.keys(patch)) {
      if (key in CONFIG_KEYS) clean[key] = patch[key]
    }
  }
  const existing = opts.replace === true ? {} : loadPersistedConfig()
  const snapshot = { ...(isPlainObj(existing) ? existing : {}), ...clean }
  for (const key of Object.keys(snapshot)) {
    if (!(key in CONFIG_KEYS)) delete snapshot[key]
  }
  try {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify(snapshot, null, 2), 'utf8')
  } catch {
    // best-effort persistence
  }
}

// v84 migration: a config.json written by v83 (or earlier) pins the Ollama route,
// which has higher priority than DEFAULT_CONFIG and would silently keep L3 on
// Ollama. Only the exact legacy defaults are rewritten (in memory, so loading the
// plugin never mutates the user's file); any user-customized value is untouched.
const LEGACY_LEVEL3_MODEL = 'qwen3:14b'
const LEGACY_LEVEL3_ENDPOINT = 'http://localhost:11434/api/generate'

export function migratePersistedLevel3Config(persisted) {
  if (!isPlainObj(persisted)) return persisted
  let out = persisted
  // v90 rename: level3MaxTokens -> level3InputBudget (same meaning); level3NumCtx is
  // dead (never reached the engine) and is dropped instead of carried forever.
  if (out.level3MaxTokens !== undefined) {
    const legacy = out.level3MaxTokens
    const { level3MaxTokens, ...rest } = out
    out = out.level3InputBudget !== undefined ? { ...rest } : { ...rest, level3InputBudget: legacy }
  }
  if (out.level3NumCtx !== undefined) {
    const { level3NumCtx, ...rest } = out
    out = rest
  }
  if (out.level3Endpoint !== LEGACY_LEVEL3_ENDPOINT || out.level3Model !== LEGACY_LEVEL3_MODEL) return out
  return { ...out, level3Model: DEFAULT_CONFIG.level3Model, level3Endpoint: DEFAULT_CONFIG.level3Endpoint }
}

// Layered config merge (v82): later layers win. Non-object layers (null / array /
// scalar) are ignored, undefined values never override a real value, and no input
// is mutated. Order: DEFAULT_CONFIG -> apply() config -> global config.json ->
// project-level pipeline-project.json.
export function mergeConfigLayers(defaults, applyConfig, persisted, project) {
  const result = {}
  const layers = [defaults, applyConfig, persisted, project]

  for (const layer of layers) {
    if (typeof layer === 'object' && layer !== null && !Array.isArray(layer)) {
      for (const key in layer) {
        if (layer.hasOwnProperty(key)) {
          const value = layer[key]
          if (value !== undefined) {
            result[key] = value
          }
        }
      }
    }
  }

  return result
}

// Project-level config overlay (v82): <devDir>/pipeline-project.json. When present it
// overrides the global config.json for THIS project only — a different devDir is a
// different project, so projects never contaminate each other. A missing or broken
// file is just an empty layer (best-effort; never breaks the plugin).
export function loadProjectConfig(devDir) {
  try {
    const path = resolve(join(devDir || DEFAULT_CONFIG.devDir, 'pipeline-project.json'))
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // best-effort; fall back to no project layer
  }
  return {}
}

// Sweet-spot auto-tuning (v82): when a model key changes, recompute that level's
// sweet spot from the model profile (contextWindow x ratio), plus its danger line
// and window (v97). L3 has no sweet spot since v90. Mutates cfg only on real change.
const TUNE_TARGETS = {
  level1Model: { budget: 'level1ContextBudget', ratio: 'level1SweetSpotRatio', danger: 'level1DangerBudget', dangerRatio: 'level1DangerRatio', window: 'level1ContextWindow' },
  level2Model: { budget: 'level2ContextBudget', ratio: 'level2SweetSpotRatio', danger: 'level2DangerBudget', dangerRatio: 'level2DangerRatio', window: 'level2ContextWindow' },
}

// v128 — exported for the async host-window retune in models.js (same table, no duplication).
export { TUNE_TARGETS }

// v128 — the built-in MODEL_PROFILES only knows a handful of ids. Cloud models
// (qwen3.7-plus on a token plan, glm, kimi…) have no profile; historically tuning
// silently skipped them and the board painted an honest-looking meter against
// STALE numbers (a 1M-window model measured against deepseek-flash's old
// 32K/96K/128K defaults). The async retune in models.js now asks the host for the
// real window; this sync path stays profile-only. Ratios follow the L2 convention
// (0.25 sweet / 0.75 danger) — advisory under compression proxies (v127), never
// hard limits.
export const FALLBACK_SWEET_RATIO = 0.25
export const FALLBACK_DANGER_RATIO = 0.75

export function resolveTuning(cfg, changedKey, profiles) {
  if (typeof cfg !== 'object' || cfg === null) return null
  if (typeof profiles !== 'object' || profiles === null) profiles = {}
  const keys = TUNE_TARGETS[changedKey]
  if (!keys) return null
  const model = cfg[changedKey]
  const profile = profiles[model]
  if (!profile || !Number.isFinite(profile.contextWindow)) return null
  const window = Math.round(profile.contextWindow)
  const ratio = Number.isFinite(cfg[keys.ratio]) ? Number(cfg[keys.ratio]) : Number(profile.sweetSpotRatio)
  if (!Number.isFinite(ratio) || ratio <= 0) return null
  const dangerRatio = Number(cfg[keys.dangerRatio]) > 0 ? Number(cfg[keys.dangerRatio]) : Number(profile.dangerRatio) || FALLBACK_DANGER_RATIO
  return { window, budget: Math.round(window * ratio), danger: Math.round(window * dangerRatio), source: 'profile' }
}

export function tuneSweetSpot(cfg, changedKey, profiles) {
  if (typeof cfg !== 'object' || cfg === null) {
    return { changed: false, changes: [], target: null, model: null, profileMissing: false }
  }
  if (typeof profiles !== 'object' || profiles === null) profiles = {}
  const model = cfg[changedKey]
  const profile = profiles[model]
  const keys = TUNE_TARGETS[changedKey]
  if (!keys) return { changed: false, changes: [], target: null, model, profileMissing: !profile }

  const changes = []
  let changed = false
  const set = (field, to) => {
    if (cfg[field] === to) return
    const from = cfg[field]
    cfg[field] = to
    changed = true
    changes.push({ field, from, to })
  }
  // v128 — tuning now falls back to the host-reported window for models with no
  // built-in profile, instead of silently keeping stale numbers.
  const t = resolveTuning(cfg, changedKey, profiles)
  if (t) {
    set(keys.window, t.window)
    set(keys.budget, t.budget)
    set(keys.danger, t.danger)
  }
  return { changed, changes, target: keys.budget, model, profileMissing: !profile, tuning: t }
}

export function coerceConfigValue(key, raw) {
  const spec = CONFIG_KEYS[key]
  if (spec.type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`${key} 需要数字，收到 "${raw}"`)
    return n
  }
  if (spec.type === 'boolean') {
    const v = String(raw).trim().toLowerCase()
    if (['true', '1', 'on', 'yes'].includes(v)) return true
    if (['false', '0', 'off', 'no'].includes(v)) return false
    throw new Error(`${key} 需要布尔值（true/false），收到 "${raw}"`)
  }
  if (spec.type === 'enum') {
    if (!spec.values.includes(raw)) throw new Error(`${key} 只接受: ${spec.values.join(' / ')}`)
    return raw
  }
  return raw
}

// v104 — a value can be the right type and still be nonsense (0 lines, negative
// budget, ratio 2.0). Validate before it reaches a run.
const RATIO_KEYS = new Set(['level1SweetSpotRatio', 'level2SweetSpotRatio', 'level1DangerRatio', 'level2DangerRatio', 'level1ContextWarnRatio'])
const TIMEOUT_KEYS = new Set(['level3TimeoutMs', 'maxDurationPerRun', 'commandAcceptanceTimeoutMs'])
const POSITIVE_KEYS = new Set([
  'maxCodeLines', 'maxLevel3Retries', 'maxLevel3Concurrency', 'maxLevel2Retries',
  'maxLevel2Agents', 'level3MaxOutputTokens', 'level1ContextBudget', 'level2ContextBudget',
  'level1DangerBudget', 'level2DangerBudget', 'level1ContextWindow', 'level2ContextWindow',
  'level3InputBudget', 'maxTotalTokensPerRun', 'maxFilesPerRun',
])
export function validateConfigValue(key, value) {
  if (key === 'semanticGateThreshold') {
    if (!(value >= 0 && value <= 1)) throw new Error(`${key} 必须在 0~1 之间，收到 ${value}`)
    return
  }
  if (RATIO_KEYS.has(key)) {
    if (!(value > 0 && value <= 1)) throw new Error(`${key} 必须在 (0,1] 之间，收到 ${value}`)
    return
  }
  if (TIMEOUT_KEYS.has(key)) {
    if (value !== 0 && value < 1000) throw new Error(`${key} 最小 1000ms（0 = 不限），收到 ${value}`)
    return
  }
  if (POSITIVE_KEYS.has(key) && value < 1) {
    throw new Error(`${key} 必须 ≥ 1（0 = 不限只对预算/时长/文件数有效），收到 ${value}`)
  }
  if (key === 'level3Endpoint') {
    const s = String(value).trim()
    if (s && !/^https?:\/\//i.test(s)) throw new Error(`${key} 必须是 http(s):// 开头的 OpenAI 兼容基址，收到 "${value}"`)
    return
  }
  if (key === 'level3Provider' || key === 'spawnProvider') {
    if (!String(value).trim()) throw new Error(`${key} 不能为空`)
  }
  // v118 — devDir feeds checkpoint/handoff paths: it must stay inside the
  // workspace, so an absolute path or `..` segment is a config error.
  if (key === 'devDir') {
    const s = String(value).trim().replace(/\\/g, '/')
    if (!s) throw new Error('devDir 不能为空')
    if (isAbsolute(s) || /^[A-Za-z]:/.test(s)) throw new Error(`devDir 必须是相对工作区根目录的路径，收到 "${value}"`)
    if (s.split('/').includes('..')) throw new Error(`devDir 不能包含 ".."，收到 "${value}"`)
  }
}

export function renderConfig(cfg) {
  const lines = ['三级协作配置：']
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    lines.push(`  ${key} = ${cfg[key]}  (${spec.desc})`)
  }
  lines.push('', '用法：/pipe-config              查看配置', '/pipe-config <key>          查看单项', '/pipe-config <key> <值>     修改单项', '/pipe-config <key> <值> mode=agent provider=<pid>', '                            连带设 L3 模式 / provider（L2 直接写模型名即可，provider 自动配对）', '/pipe-config reset          恢复默认')
  return lines.join('\n')
}

export function handleConfigCommand(cfg, rawInput) {
  const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
  try {
    if (parts.length === 0) return { kind: 'success', text: renderConfig(cfg) }
    const [a] = parts
    if (a === 'list' || a === 'keys') {
      return { kind: 'success', text: `可配置项：${Object.keys(CONFIG_KEYS).join(', ')}` }
    }
    if (a === 'reset') {
      // Check the project layer BEFORE resetting devDir back to its default.
      const projectKeys = Object.keys(loadProjectConfig(cfg.devDir))
      for (const key of Object.keys(CONFIG_KEYS)) cfg[key] = DEFAULT_CONFIG[key]
      savePersistedConfig({}, { replace: true })
      let text = `已恢复默认配置：\n${renderConfig(cfg)}`
      if (projectKeys.length > 0) {
        text += '\n注意：本项目的 pipeline-project.json 仍会覆盖上述全局值（项目级配置优先级最高）。'
      }
      return { kind: 'success', text, changed: [] }
    }
    if (!a.includes('=') && !(a in CONFIG_KEYS)) {
      return { kind: 'error', text: `未知配置项 "${a}"。可用：${Object.keys(CONFIG_KEYS).join(', ')}` }
    }
    if (parts.length === 1 && !a.includes('=')) {
      return { kind: 'success', text: `${a} = ${cfg[a]}  (${CONFIG_KEYS[a].desc})` }
    }

    // v123 — one command can carry follow-up pairs:
    //   /pipe-config level3Model qwen3.7-plus mode=agent provider=qwen-token-plan-cn
    //   /pipe-config level2Model qwen3.7-plus provider=qwen-token-plan-cn
    // Bare key=value tokens may also form the whole command.
    const pairs = []
    if (a.includes('=')) {
      for (const tok of parts) {
        const i = tok.indexOf('=')
        if (i <= 0) throw new Error(`无法解析 "${tok}"；附加项请写成 key=value（例如 mode=agent）`)
        pairs.push([tok.slice(0, i), tok.slice(i + 1)])
      }
    } else {
      if (parts[1].includes('=')) throw new Error(`"${a}" 缺少值；可写成 ${a} <值> 或 ${a}=<值>`)
      pairs.push([a, parts[1]])
      for (const tok of parts.slice(2)) {
        if (tok.includes('=')) {
          const i = tok.indexOf('=')
          pairs.push([tok.slice(0, i), tok.slice(i + 1)])
        } else if (['auto', 'executor', 'agent', 'off'].includes(tok) && (a === 'level3Model' || a === 'level3Mode')) {
          // shorthand: /pipe-config level3Model <id> agent  |  /pipe-config level3Mode off
          pairs.push(['level3Mode', tok])
        } else {
          throw new Error(`多余参数 "${tok}"；附加项请写成 key=value（例如 mode=agent、provider=<provider>）`)
        }
      }
    }

    // Alias resolution: `mode` / `provider` follow whichever model tier the
    // command is configuring. L2 is always an agent, so mode there is a no-op.
    const keys = pairs.map((p) => p[0])
    const hasL2 = keys.some((k) => k === 'level2Model' || k === 'level2Provider')
    const hasL3 = keys.some((k) => k === 'level3Model' || k === 'level3Provider' || k === 'level3Mode')
    const notes = []
    const resolved = []
    for (const [key, value] of pairs) {
      if (key === 'mode') {
        if (!hasL3 && hasL2) {
          notes.push('二级固定为 agent 模式，mode 已忽略（mode 只用于 L3：level3Mode）')
          continue
        }
        resolved.push(['level3Mode', value])
        continue
      }
      if (key === 'provider') {
        if (hasL2 && hasL3) {
          throw new Error('同时改二级和三级时 provider= 有歧义，请写 level2Provider= 或 level3Provider=')
        }
        resolved.push([hasL3 ? 'level3Provider' : 'level2Provider', value])
        continue
      }
      resolved.push([key, value])
    }

    const patch = {}
    const lines = []
    for (const [key, raw] of resolved) {
      if (!(key in CONFIG_KEYS)) {
        throw new Error(`未知配置项 "${key}"。可用：${Object.keys(CONFIG_KEYS).join(', ')}`)
      }
      const value = coerceConfigValue(key, raw)
      validateConfigValue(key, value)
      const prev = cfg[key]
      cfg[key] = value
      patch[key] = value
      lines.push(`已更新 ${key}: ${prev} → ${value}`)
      if (key === 'level1Model' || key === 'level2Model' || key === 'level3Model') {
        if (cfg.autoTuneSweetSpot === true) {
          const tuned = tuneSweetSpot(cfg, key, MODEL_PROFILES)
          if (tuned.changed) {
            for (const c of tuned.changes) {
              patch[c.field] = cfg[c.field]
              lines.push(`已联动更新 ${c.field}: ${c.from} → ${c.to}`)
            }
          } else if (tuned.profileMissing) {
            lines.push('该模型无档案且宿主未报窗口，甜点区未联动——看板按“未知”显示不画假刻度；可手动 /pipe-config <甜点区键> <值> 覆盖')
          } else if (tuned.target) {
            lines.push(`甜点区无需联动（${tuned.target} = ${cfg[tuned.target]}）`)
          } else {
            lines.push('此层无甜点区需要联动（三级输入/输出预算固定，不随模型变）')
          }
        } else {
          lines.push('autoTuneSweetSpot 已关闭，甜点区未联动，可手动 /pipe-config <甜点区键> <值> 覆盖')
        }
      } else if ((key === 'level1ContextBudget' || key === 'level2ContextBudget') && cfg.autoTuneSweetSpot === true) {
        lines.push('（甜点区手动值优先；下次改对应层模型时会按模型档案重算）')
      } else if (
        (key === 'level1DangerRatio' || key === 'level2DangerRatio' ||
          key === 'level1SweetSpotRatio' || key === 'level2SweetSpotRatio' ||
          key === 'level1ContextWindow' || key === 'level2ContextWindow') &&
        cfg.autoTuneSweetSpot === true
      ) {
        const layerKey = key.startsWith('level1') ? 'level1Model' : 'level2Model'
        const tuned = tuneSweetSpot(cfg, layerKey, MODEL_PROFILES)
        if (tuned.changed) {
          for (const c of tuned.changes) {
            patch[c.field] = cfg[c.field]
            lines.push(`已联动更新 ${c.field}: ${c.from} → ${c.to}`)
          }
        } else {
          lines.push('该层模型无档案，未联动（可手动设对应 Budget 键）')
        }
      }
    }
    savePersistedConfig(patch)
    // v124 — turning L3 off is a mode change, not a model change: tell the caller
    // what the pipeline will do now so the note survives the /pipe-config output.
    if (patch.level3Mode === 'off') {
      lines.push('三级已关闭（level3Mode=off）：L2 自己写代码，pipeline_execute_local / pipeline_spawn_local_executor 会被拒绝；恢复用 /pipe-config level3Mode auto。')
    }
    return { kind: 'success', text: [...lines, ...notes].join('\n'), changed: Object.keys(patch) }
  } catch (error) {
    return { kind: 'error', text: error?.message ?? String(error) }
  }
}

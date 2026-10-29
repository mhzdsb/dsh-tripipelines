// v82 verification: sweet-spot model adaptation + project-level config.
// Loads a patched COPY of plugins/dsh-tripipelines/lib/plugin.js (temp CONFIG_FILE + extra exports)
// so no real user config/state is touched, then asserts the v82 contracts:
//  1) new keys exist in DEFAULT_CONFIG AND CONFIG_KEYS; boolean coerce works
//  2) v81 back-compat: defaults for the 3 sweet-spot keys + all other keys unchanged
//  3) mergeConfigLayers layering / undefined-skip / no mutation
//  4) /pipe-config <modelKey> auto-tunes the sweet spot and explains it
//  5) project-level pipeline-project.json overrides global, per-devDir isolated
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const root = new URL('../../', import.meta.url)
const tmp = mkdtempSync(join(tmpdir(), 'v82-verify-'))
const tmpConfig = join(tmp, 'config.json').replace(/\\/g, '/')

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${extra ? `  :: ${extra}` : ''}`)
  }
}

// v90 split: plugin.js now depends on sibling modules — copy them all next to the
// patched copies (config gets a temp CONFIG_FILE, store a temp state dir).
for (const f of ['util.js', 'store.js', 'gates.js', 'prompts.js', 'dsh-compat.js', 'guards.js', 'board-route.js', 'workspaces.js']) {
  copyFileSync(new URL('plugins/dsh-tripipelines/lib/' + f, root), join(tmp, f))
}
mkdirSync(join(tmp, 'tools'), { recursive: true })
mkdirSync(join(tmp, 'knowledge'), { recursive: true })
for (const f of ['knowledge/scan.js', 'knowledge/ledger.js', 'knowledge/recall.js']) {
  copyFileSync(new URL('plugins/dsh-tripipelines/lib/' + f, root), join(tmp, f))
}
for (const f of ['l1.js', 'l2l3.js', 'knowledge.js']) {
  copyFileSync(new URL('plugins/dsh-tripipelines/lib/tools/' + f, root), join(tmp, 'tools', f))
}
const configSrc = readFileSync(new URL('plugins/dsh-tripipelines/lib/config.js', root), 'utf8')
const patched = configSrc.replace(
  "export const CONFIG_FILE = join(homedir(), '.dsh', 'pipeline', 'config.json')",
  `export const CONFIG_FILE = ${JSON.stringify(tmpConfig)}`,
)
if (patched === configSrc) {
  console.log('FAIL  could not patch config source (anchor changed)')
  process.exit(1)
}
writeFileSync(join(tmp, 'config.js'), patched, 'utf8')
const storeSrc = readFileSync(new URL('plugins/dsh-tripipelines/lib/store.js', root), 'utf8')
const storePatched = storeSrc.replace(
  "return join(root ?? process.cwd(), '.dsh', 'pipeline')",
  `return ${JSON.stringify(join(tmp, 'state').replace(/\\/g, '/'))}`,
)
if (storePatched === storeSrc) {
  console.log('FAIL  could not patch store source (state dir anchor changed)')
  process.exit(1)
}
writeFileSync(join(tmp, 'store.js'), storePatched, 'utf8')
copyFileSync(new URL('plugins/dsh-tripipelines/lib/plugin.js', root), join(tmp, 'plugin.js'))
const mod = await import(pathToFileURL(join(tmp, 'config.js')).href)
const pluginMod = await import(pathToFileURL(join(tmp, 'plugin.js')).href)

const { DEFAULT_CONFIG, CONFIG_KEYS, MODEL_PROFILES, tuneSweetSpot, mergeConfigLayers, loadProjectConfig, handleConfigCommand, coerceConfigValue } = mod

// --- 1) new keys present in both tables -----------------------------------
for (const key of ['level1Model', 'level1SweetSpotRatio', 'level2SweetSpotRatio', 'autoTuneSweetSpot']) {
  check(`DEFAULT_CONFIG has ${key}`, key in DEFAULT_CONFIG)
  check(`CONFIG_KEYS has ${key}`, key in CONFIG_KEYS)
}
check('autoTuneSweetSpot default true', DEFAULT_CONFIG.autoTuneSweetSpot === true)
check('level1SweetSpotRatio default 0.5', DEFAULT_CONFIG.level1SweetSpotRatio === 0.5)
check('level2SweetSpotRatio default 0.25', DEFAULT_CONFIG.level2SweetSpotRatio === 0.25)
check("CONFIG_KEYS.autoTuneSweetSpot.type === 'boolean'", CONFIG_KEYS.autoTuneSweetSpot.type === 'boolean')
check('autoTuneSweetSpot in savePersisted snapshot keys', Object.keys(CONFIG_KEYS).includes('autoTuneSweetSpot'))

// --- 2) boolean coerce ----------------------------------------------------
check("coerce 'false' -> false", coerceConfigValue('autoTuneSweetSpot', 'false') === false)
check("coerce 'off' -> false", coerceConfigValue('autoTuneSweetSpot', 'off') === false)
check("coerce 'true' -> true", coerceConfigValue('autoTuneSweetSpot', 'true') === true)
let threw = false
try {
  coerceConfigValue('autoTuneSweetSpot', 'maybe')
} catch {
  threw = true
}
check('coerce rejects invalid boolean', threw)

// --- 3) defaults pinned (v104: endpoint is blank by design, L3 budget raised) --
const V81 = {
  stateDir: DEFAULT_CONFIG.stateDir,
  level2Provider: 'deepseek-official',
  level2Model: 'deepseek-flash',
  level3Model: 'qwen3.8-27b-gsq-rco-iq3-s-mtp',
  level3Endpoint: '',
  level3Provider: 'ninfer-local',
  spawnProvider: 'spawn',
  level3InputBudget: 1200,
  level3MaxOutputTokens: 4096,
  level3TimeoutMs: 900000,
  semanticGateThreshold: 0.7,
  mode: 'auto',
  maxCodeLines: 100,
  maxLevel3Retries: 5,
  maxLevel2Retries: 3,
  maxLevel2Agents: 10,
  level2ContextBudget: 32000,
  level2HandoffTtlMs: 300000,
  level1ContextBudget: 64000,
  level1ContextWarnRatio: 0.8,
  level3Compression: 'L1',
  devDir: 'dev',
}
for (const [key, value] of Object.entries(V81)) {
  check(`default pinned: ${key}`, DEFAULT_CONFIG[key] === value, `${DEFAULT_CONFIG[key]} !== ${value}`)
}
const noNewKeys = mergeConfigLayers(DEFAULT_CONFIG, {}, {}, null)
const v81Only = {}
for (const key of Object.keys(V81)) v81Only[key] = noNewKeys[key]
check('layer merge keeps pinned defaults', JSON.stringify(v81Only) === JSON.stringify(V81))

// --- 4) mergeConfigLayers behavior ---------------------------------------
const l1 = { a: 1, b: 1 }
const l2 = { b: 2, u: undefined }
const l3 = { c: 3 }
const merged = mergeConfigLayers(l1, l2, [9, 9], l3)
check('layer order last-wins', JSON.stringify(merged) === JSON.stringify({ a: 1, b: 2, c: 3 }), JSON.stringify(merged))
check('layers not mutated', JSON.stringify(l1) === JSON.stringify({ a: 1, b: 1 }) && JSON.stringify(l2) === JSON.stringify({ b: 2, u: undefined }))
check('null layer ignored', JSON.stringify(mergeConfigLayers({ a: 1 }, null, undefined, 'x')) === JSON.stringify({ a: 1 }))
check('undefined never overrides', merged.b === 2)

// --- 5) model-change linkage --------------------------------------------
function freshCfg() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
}

// 5a: a ratio change now retunes immediately (v97b) — assert that path
let cfg = freshCfg()
let res = handleConfigCommand(cfg, 'level2SweetSpotRatio 0.5')
check('ratio set ok', cfg.level2SweetSpotRatio === 0.5, res.text)
check('ratio change retunes level2ContextBudget', cfg.level2ContextBudget === 64000, String(cfg.level2ContextBudget))
check('ratio change explains old -> new', /已联动更新 level2ContextBudget: 32000 → 64000/.test(res.text), res.text)

// 5a2: model change still retunes when the manual budget is out of line
cfg = freshCfg()
handleConfigCommand(cfg, 'level2SweetSpotRatio 0.5')
handleConfigCommand(cfg, 'level2ContextBudget 11111')
res = handleConfigCommand(cfg, 'level2Model deepseek-pro')
check('linkage recomputes level2ContextBudget', cfg.level2ContextBudget === 64000, String(cfg.level2ContextBudget))
check('linkage text explains old -> new', /已联动更新 level2ContextBudget: 11111 → 64000/.test(res.text), res.text)

// 5b: profile miss -> explicit "no profile" message, no change
cfg = freshCfg()
res = handleConfigCommand(cfg, 'level2Model no-such-model')
check('profile miss keeps budget', cfg.level2ContextBudget === 32000)
check('profile miss message', /该模型无档案，甜点区未联动/.test(res.text), res.text)

// 5c: L3 has no sweet spot since v90 (level3NumCtx removed) — change must not touch budgets
cfg = freshCfg()
res = handleConfigCommand(cfg, 'level3Model qwen2.5:7b')
check('level3 model change keeps L3 budgets', cfg.level3InputBudget === 1200 && cfg.level3MaxOutputTokens === 4096, `${cfg.level3InputBudget}/${cfg.level3MaxOutputTokens}`)
check('level3 model text explains no linkage', /无甜点区/.test(res.text), res.text)

// 5d: autoTuneSweetSpot off -> no linkage
cfg = freshCfg()
res = handleConfigCommand(cfg, 'autoTuneSweetSpot false')
check('autoTune off persisted in cfg', cfg.autoTuneSweetSpot === false)
res = handleConfigCommand(cfg, 'level1Model deepseek-reasoner')
check('autoTune off -> budget untouched', cfg.level1ContextBudget === 64000)
check('autoTune off message', /autoTuneSweetSpot 已关闭/.test(res.text), res.text)

// 5e: manual sweet-spot value wins (no recompute at load) and persists
cfg = freshCfg()
res = handleConfigCommand(cfg, 'level1ContextBudget 12345')
check('manual budget wins immediately', cfg.level1ContextBudget === 12345, res.text)
check('manual budget hint mentions priority', /手动值优先/.test(res.text), res.text)
const persisted = JSON.parse(readFileSync(tmpConfig, 'utf8'))
check('manual budget persisted to config.json', persisted.level1ContextBudget === 12345)
check('persisted snapshot includes new keys', 'autoTuneSweetSpot' in persisted && 'level1Model' in persisted)
const reloaded = mergeConfigLayers(DEFAULT_CONFIG, {}, persisted, null)
check('reload does not recompute manual budget', reloaded.level1ContextBudget === 12345, String(reloaded.level1ContextBudget))

// 5f: plain (non-budget, non-model) key unchanged -> no linkage noise
cfg = freshCfg()
res = handleConfigCommand(cfg, 'maxCodeLines 80')
check('unrelated key text has no linkage note', res.text === '已更新 maxCodeLines: 100 → 80', res.text)

// 5i: v104 config value validation — right type, nonsense value must be rejected
cfg = freshCfg()
res = handleConfigCommand(cfg, 'maxCodeLines 0')
check('rejects maxCodeLines 0', res.kind === 'error' && cfg.maxCodeLines === 100, res.text)
res = handleConfigCommand(cfg, 'level2SweetSpotRatio 1.5')
check('rejects ratio > 1', res.kind === 'error', res.text)
res = handleConfigCommand(cfg, 'level1ContextBudget -5')
check('rejects negative budget', res.kind === 'error', res.text)
res = handleConfigCommand(cfg, 'level3Endpoint ftp://example')
check('rejects non-http endpoint', res.kind === 'error', res.text)
res = handleConfigCommand(cfg, 'level3Endpoint http://127.0.0.1:8080/v1')
check('accepts http endpoint', res.kind === 'success' && cfg.level3Endpoint === 'http://127.0.0.1:8080/v1', res.text)

// 5g: tuneSweetSpot is safe on bad input
check('tuneSweetSpot(null) safe', tuneSweetSpot(null, 'level2Model', MODEL_PROFILES).changed === false)
check('tuneSweetSpot level3 is a no-op', tuneSweetSpot({ autoTuneSweetSpot: true, level3Model: 'qwen2.5:7b' }, 'level3Model', MODEL_PROFILES).changed === false)

// 5h: default models already match profiles -> no spurious change
for (const modelKey of ['level1Model', 'level2Model', 'level3Model']) {
  const c = freshCfg()
  const t = tuneSweetSpot(c, modelKey, MODEL_PROFILES)
  check(`default ${modelKey} has a profile`, t.profileMissing === false)
}

// --- 6) project-level config override + per-devDir isolation --------------
const projA = join(tmp, 'projA')
const projB = join(tmp, 'projB')
mkdirSync(projA, { recursive: true })
mkdirSync(projB, { recursive: true })
writeFileSync(join(projA, 'pipeline-project.json'), JSON.stringify({ level2ContextBudget: 99999, level2Model: 'deepseek-chat' }), 'utf8')
writeFileSync(join(projB, 'pipeline-project.json'), JSON.stringify({ level2ContextBudget: 11111 }), 'utf8')
// global layer says 55555 -> project must win
writeFileSync(tmpConfig, JSON.stringify({ level2ContextBudget: 55555, level1ContextBudget: 4096 }), 'utf8')
check('loadProjectConfig reads file', loadProjectConfig(projA).level2ContextBudget === 99999)
check('loadProjectConfig missing dir -> {}', JSON.stringify(loadProjectConfig(join(tmp, 'nope'))) === '{}')
mkdirSync(join(projA, 'bad'), { recursive: true })
writeFileSync(join(tmp, 'bad-project.json'), '{ not json', 'utf8')

function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    systemPrompt: { section() {} },
    skills: { register() {} },
    tools: { register() {}, guard() {} },
    commands: { register: (spec) => handlers.set(spec.name, spec.handler) },
    logger: { warn() {} },
  }
}

// deterministic global layer for this section, then apply per project
function appliedConfig(devDir) {
  writeFileSync(tmpConfig, JSON.stringify({ level2ContextBudget: 55555, level1ContextBudget: 4096 }), 'utf8')
  const ctx = fakeCtx()
  pluginMod.apply(ctx, { devDir, stateDir: join(tmp, 'state-' + Math.random().toString(36).slice(2)) })
  const text = ctx.handlers.get('pipe-config')({ rawInput: '' }).text
  const read = (key) => {
    const m = text.match(new RegExp(`^\\s+${key} = ([^\\s]+)`, 'm'))
    return m ? m[1] : null
  }
  return { text, level2ContextBudget: read('level2ContextBudget'), level2Model: read('level2Model'), level1ContextBudget: read('level1ContextBudget') }
}

const a = appliedConfig(projA)
check('project A overrides global budget', a.level2ContextBudget === '99999', JSON.stringify(a.level2ContextBudget))
check('project A overrides global model', a.level2Model === 'deepseek-chat', JSON.stringify(a.level2Model))
check('project A inherits global level1ContextBudget', a.level1ContextBudget === '4096', JSON.stringify(a.level1ContextBudget))
const b = appliedConfig(projB)
check('project B sees only its own override', b.level2ContextBudget === '11111', JSON.stringify(b.level2ContextBudget))
check('project B not contaminated by A model', b.level2Model === 'deepseek-flash', JSON.stringify(b.level2Model))
const noProj = appliedConfig(join(tmp, 'projC'))
check('no project file -> global layer wins', noProj.level2ContextBudget === '55555', JSON.stringify(noProj.level2ContextBudget))

// broken project file must not break apply()
mkdirSync(join(tmp, 'projD'), { recursive: true })
writeFileSync(join(tmp, 'projD', 'pipeline-project.json'), '{ broken', 'utf8')
const d = appliedConfig(join(tmp, 'projD'))
check('broken project file falls back to global', d.level2ContextBudget === '55555', JSON.stringify(d.level2ContextBudget))

// reset mentions project layer when a project file exists
const ctxR = fakeCtx()
pluginMod.apply(ctxR, { devDir: projA, stateDir: join(tmp, 'state-reset') })
const resetRes = ctxR.handlers.get('pipe-config')({ rawInput: 'reset' })
check('reset warns about project layer', /pipeline-project\.json 仍会覆盖/.test(resetRes.text))
writeFileSync(tmpConfig, JSON.stringify({ level2ContextBudget: 55555, level1ContextBudget: 4096 }), 'utf8')

rmSync(tmp, { recursive: true, force: true })
console.log(`\nv82 verification: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

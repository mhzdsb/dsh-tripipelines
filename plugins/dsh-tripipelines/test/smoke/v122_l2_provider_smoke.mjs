// v122 — an L2 model id must never ride on a provider that does not serve it.
//
// Real failure this guards: user set L2 = qwen3.7-plus (served only by the
// `qwen-token-plan-cn` provider) while level2Provider stayed `deepseek-official`;
// the spawn forwarded the pair to DeepSeek, whose API answered
// "The supported API model names are deepseek-flash, deepseek-v4-pro, but you
// passed qwen3.7-plus." This suite proves:
//   * the onboarding message groups models by provider and prints a copyable
//     `/pipe-config level2Provider <id>` line before every foreign group;
//   * an already-broken pairing is called out in that message;
//   * `pipeline_model_setup({apply:'custom', level2Model})` carries the provider;
//   * `pipeline_spawn_module_lead` auto-corrects a mismatched pairing before
//     startActivation, but respects an explicit `provider` argument (with a note);
//   * `pipeline_selftest` reports the mismatch as degraded.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pkgRoot = fileURLToPath(new URL('../../', import.meta.url))
// v128 — ships inside the package (test/smoke); dev/smoke keeps a twin whose ../../
// is the REPO root, so fall back to the monorepo layout. Both copies run unchanged.
const repoRoot = existsSync(join(pkgRoot, 'lib')) ? pkgRoot : join(pkgRoot, 'plugins', 'dsh-tripipelines')
let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v122-'))
const libDir = join(tmp, 'lib')
const root = join(tmp, 'proj')
const globalConfigPath = join(tmp, 'global-config.json')
mkdirSync(join(root, '.git'), { recursive: true })

const MODEL_CATALOG = {
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'qwen-token-plan-cn': ['qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max'],
  'strata-local': ['qwen3.8-flash-next-coder-iq1_m'],
}

// v128 — host-side model metadata: qwen3.7-plus advertises a 1M window, everything
// else stays at 128K. resolveHostTuning uses this to retune the sweet spot so the
// board never measures a 1M model against deepseek-flash's stale 32K/96K defaults.
const MODEL_WINDOWS = { 'qwen3.7-plus': 1000000 }

function mkSession(id, cwd) {
  return {
    id,
    header: { cwd },
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    surface: {},
    snapshotEvents: () => [],
  }
}
const sessions = new Map([['s1', mkSession('s1', root)]])

const spawnRequests = []
const subagents = {
  async startActivation(request) {
    spawnRequests.push(request)
    return { childId: `child-${spawnRequests.length}`, messageId: 'msg', dispose() {} }
  },
  async drainChildren() {},
  async sendMessage() { return 'msg' },
}

const llm = {
  listProviders: () => Object.keys(MODEL_CATALOG).map((id) => ({ id, name: id })),
  listModels: async (provider) => (MODEL_CATALOG[provider] ?? []).map((id) => ({ id, name: id })),
  resolveModelInfo: (provider, model) => ({ context: { contextWindow: MODEL_WINDOWS[model] ?? 128000 } }),
  async *stream() { yield { type: 'text-delta', text: '[]' } },
}

const webServer = { register() { return () => {} } }

function makeCtx() {
  const tools = new Map()
  const commands = new Map()
  const ctx = {
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(String(id)), list: () => [...sessions.values()] }
      if (name === 'agents') return { roots: () => [], get: () => undefined }
      if (name === 'tokenMeter') return { estimateMessage: () => 100, measure: () => ({ surfaceTokens: 300 }) }
      if (name === 'subagents') return subagents
      if (name === 'llm') return llm
      if (name === 'webServer') return webServer
      return undefined
    },
    tools: { register(def) { tools.set(def.name, def); return () => {} }, guard() { return () => {} } },
    systemPrompt: { section() {} },
    skills: { register() {} },
    commands: { register(def) { commands.set(def.name, def); return () => {} } },
  }
  return { ctx, tools, commands }
}

try {
  cpSync(join(repoRoot, 'lib'), libDir, { recursive: true })
  const cfgPath = join(libDir, 'config.js')
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, 'utf8').replace(/export const CONFIG_FILE = .*$/m, `export const CONFIG_FILE = ${JSON.stringify(globalConfigPath)}`),
    'utf8',
  )
  const wsPath = join(libDir, 'workspaces.js')
  writeFileSync(
    wsPath,
    readFileSync(wsPath, 'utf8').replace(/export const DEFAULT_KNOWN_FILE = .*$/m, `export const DEFAULT_KNOWN_FILE = ${JSON.stringify(join(tmp, 'known-workspaces.json'))}`),
    'utf8',
  )

  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
  const h = makeCtx()
  apply(h.ctx, {
    mode: 'auto',
    level2Provider: 'deepseek-official',
    level2Model: 'deepseek-flash',
    level3Endpoint: 'http://127.0.0.1:9/v1',
  })

  const call = (name, args = {}) => h.tools.get(name).execute(args, { agent: { id: 's1' }, signal: undefined })
  const configCmd = (rawInput) => h.commands.get('pipe-config').handler({ rawInput })
  const readGlobal = () => JSON.parse(readFileSync(globalConfigPath, 'utf8'))

  section('onboarding message groups models by provider')
  const setup = await call('pipeline_model_setup')
  const msg = setup.message
  check('tool registered', Boolean(h.tools.get('pipeline_model_setup')))
  check('message names the foreign provider group', msg.includes('# provider qwen-token-plan-cn'), msg.slice(0, 400))
  check('message offers a copyable provider line', msg.includes('/pipe-config level2Provider qwen-token-plan-cn'), msg.slice(0, 400))
  const providerLineAt = msg.indexOf('/pipe-config level2Provider qwen-token-plan-cn')
  const qwenModelAt = msg.indexOf('/pipe-config level2Model qwen3.7-plus')
  check('provider line comes before the foreign model line', providerLineAt !== -1 && qwenModelAt !== -1 && providerLineAt < qwenModelAt, `${providerLineAt} < ${qwenModelAt}`)
  check('current-provider group has no redundant provider line', !msg.includes('/pipe-config level2Provider deepseek-official'))
  check('note explains that level2Model alone keeps the provider', msg.includes('只发 level2Model 会沿用当前 provider'))

  section('a bare model command self-pairs the provider (v123)')
  const repaired = await configCmd('level2Model qwen3.7-plus')
  check('command reports the auto-pairing', String(repaired.text ?? '').includes('已自动配套 level2Provider=qwen-token-plan-cn'), String(repaired.text))
  // v128 — the sweet spot follows the model's REAL window (qwen3.7-plus = 1M here),
  // not deepseek-flash's stale 32K/96K/128K defaults.
  check('sweet spot retuned to host window', String(repaired.text ?? '').includes('level2ContextBudget: 32000 → 250000'), String(repaired.text))
  check('danger line retuned too', String(repaired.text ?? '').includes('level2DangerBudget: 96000 → 750000'), String(repaired.text))
  check('window corrected to 1M', String(repaired.text ?? '').includes('level2ContextWindow: 128000 → 1000000'), String(repaired.text))
  check('retune persisted globally', readGlobal().level2ContextBudget === 250000, JSON.stringify(readGlobal()))
  const afterRepair = await call('pipeline_model_setup')
  check('message no longer flags an invalid pairing', !afterRepair.message.includes('🚨 当前 L2 配对无效'), afterRepair.message.slice(0, 400))
  check('current line shows the corrected provider', afterRepair.message.includes('qwen-token-plan-cn/qwen3.7-plus'), afterRepair.message.slice(0, 400))

  section('a broken pairing is still called out')
  await configCmd('level2Provider deepseek-official')
  const broken = await call('pipeline_model_setup')
  check('message flags the invalid pairing', broken.message.includes('🚨 当前 L2 配对无效'), broken.message.slice(0, 500))
  check('message names the correct provider', broken.message.includes('/pipe-config level2Provider qwen-token-plan-cn'))

  section('apply custom carries the provider with the model')
  const applied = await call('pipeline_model_setup', { apply: 'custom', level2Model: 'qwen3.7-plus' })
  check('applied provider switched to qwen-token-plan-cn', applied.applied?.level2Provider === 'qwen-token-plan-cn', JSON.stringify(applied.applied))
  check('warning explains the auto-pairing', (applied.warnings ?? []).some((w) => w.includes('已自动配套')), JSON.stringify(applied.warnings))
  check('global config persisted the provider', readGlobal().level2Provider === 'qwen-token-plan-cn', JSON.stringify(readGlobal()))

  section('spawn auto-corrects a mismatched pairing')
  await configCmd('level2Provider deepseek-official')
  await call('pipeline_lock_requirements', { requirement: 'demo', activation: 'enable' })
  const spawned = await call('pipeline_spawn_module_lead', { name: 'mod-good', description: 'd', prompt: 'p' })
  const goodRequest = spawnRequests.at(-1)
  check('startActivation received the corrected provider', goodRequest?.request?.agentOptions?.provider === 'qwen-token-plan-cn', JSON.stringify(goodRequest?.request?.agentOptions))
  check('model stayed qwen3.7-plus', goodRequest?.request?.agentOptions?.model === 'qwen3.7-plus')
  check('result reports the auto-correction', String(spawned.providerNote ?? '').includes('已自动改用'), JSON.stringify(spawned.providerNote))
  check('board record uses the corrected provider', spawned.provider === 'qwen-token-plan-cn')

  section('explicit provider override is respected (with a warning)')
  const explicit = await call('pipeline_spawn_module_lead', { name: 'mod-explicit', description: 'd', prompt: 'p', provider: 'deepseek-official', model: 'qwen3.7-plus' })
  const explicitRequest = spawnRequests.at(-1)
  check('explicit provider is not silently rewritten', explicitRequest?.request?.agentOptions?.provider === 'deepseek-official', JSON.stringify(explicitRequest?.request?.agentOptions))
  check('result warns instead of switching', String(explicit.providerNote ?? '').includes('显式指定'), JSON.stringify(explicit.providerNote))

  section('unknown model warns but does not block')
  const unknown = await call('pipeline_spawn_module_lead', { name: 'mod-unknown', description: 'd', prompt: 'p', model: 'no-such-model' })
  check('spawn still succeeded', Boolean(unknown.childId))
  check('result warns that the model is unknown', String(unknown.providerNote ?? '').includes('当前 llm 列表里没有'), JSON.stringify(unknown.providerNote))

  section('selftest reports the mismatch as degraded')
  await configCmd('level2Model qwen3.7-plus')
  await configCmd('level2Provider deepseek-official')
  const self = await call('pipeline_selftest')
  const pairing = (self.checks ?? []).find((c) => c.name === 'L2 model/provider')
  check('pairing check present', Boolean(pairing), JSON.stringify(self.checks))
  check('pairing check failed', pairing?.ok === false, JSON.stringify(pairing))
  check('degraded lists the pairing check', (self.degraded ?? []).includes('L2 model/provider'), JSON.stringify(self.degraded))
  check('detail names the provider that serves it', String(pairing?.detail ?? '').includes('qwen-token-plan-cn'), String(pairing?.detail))

  section('sweet spot follows the host window for profile-less models (v128)')
  // Drag the tuning back to flash's stale defaults behind autoPair's back, then
  // re-pairing must restore the 1M-window numbers — including in the global file.
  await configCmd('level2Model deepseek-flash')
  check('profile model restores its own numbers', readGlobal().level2ContextBudget === 32000, JSON.stringify(readGlobal()))
  const retuned = await configCmd('level2Model qwen3.7-plus')
  check('budget restored to 1M×0.25', String(retuned.text ?? '').includes('level2ContextBudget: 32000 → 250000'), String(retuned.text))
  check('retune persisted globally again', readGlobal().level2ContextBudget === 250000, JSON.stringify(readGlobal()))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v122_l2_provider_smoke — ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

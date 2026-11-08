// v121 — per-project model onboarding.
//
// The plugin used to mention model switching in one static Phase-0 sentence and
// never showed the available models, so every project started on whatever the
// global config happened to hold. v121 adds `pipeline_model_setup`: it discovers
// L2 models from the llm service and L3 models from the local engine's /models
// (engine order = local ranking), renders one copyable `/pipe-config ...` line
// per model, and applies either the defaults (L2 flash, L3 local #1) or a custom
// choice. This suite proves discovery, defaults, rendering, apply/persist and the
// lock-tool onboarding hint.
import { mkdirSync, mkdtempSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v121-'))
const libDir = join(tmp, 'lib')
const root = join(tmp, 'proj')
mkdirSync(join(root, '.git'), { recursive: true })

function mkSession(id, cwd) {
  return {
    id,
    header: { cwd },
    seq: 0,
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    requestContext: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    surface: {},
    snapshotEvents: () => [],
  }
}

const sessions = new Map([['s1', mkSession('s1', root)]])
const subagents = { async startActivation() { throw new Error('unused') }, async drainChildren() {}, async sendMessage() {} }
const llm = {
  listProviders: () => [{ id: 'deepseek-official' }, { id: 'deepseek-account' }],
  async listModels(provider) {
    if (provider === 'deepseek-official') {
      return [
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ]
    }
    return [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }]
  },
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
      if (name === 'tokenMeter') return { estimateMessage: () => 120, measure: () => ({ surfaceTokens: 400 }) }
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

function call(h, name, args) {
  const def = h.tools.get(name)
  if (!def) throw new Error(`missing tool: ${name}`)
  return def.execute(args, { agent: { id: 's1' }, signal: undefined })
}

async function main() {
  cpSync(join(repoRoot, 'plugins', 'dsh-tripipelines', 'lib'), libDir, { recursive: true })
  const cfgPath = join(libDir, 'config.js')
  const cfgSrc = readFileSync(cfgPath, 'utf8')
  writeFileSync(
    cfgPath,
    cfgSrc.replace(/export const CONFIG_FILE = .*$/m, `export const CONFIG_FILE = ${JSON.stringify(join(tmp, 'global-config.json'))}`),
    'utf8',
  )
  const wsPath = join(libDir, 'workspaces.js')
  const wsSrc = readFileSync(wsPath, 'utf8')
  writeFileSync(
    wsPath,
    wsSrc.replace(/export const DEFAULT_KNOWN_FILE = .*$/m, `export const DEFAULT_KNOWN_FILE = ${JSON.stringify(join(tmp, 'known-workspaces.json'))}`),
    'utf8',
  )

  const models = await import(pathToFileURL(join(libDir, 'models.js')).href)
  const guards = await import(pathToFileURL(join(libDir, 'guards.js')).href)

  section('pure discovery helpers')
  check('extractModelIds reads the OpenAI shape in order', JSON.stringify(models.extractModelIds({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })) === '["b","a"]')
  check('extractModelIds accepts a bare array and ignores empty ids', JSON.stringify(models.extractModelIds(['x', '', null, { id: 'y' }])) === '["x","y"]')

  const cfg = {
    level2Provider: 'deepseek-official',
    level2Model: 'deepseek-v4-pro',
    level3Model: 'configured-l3',
    level3Endpoint: 'http://127.0.0.1:1/v1',
    autoTuneSweetSpot: true,
  }
  const l2 = await models.discoverLevel2Models({ get: (n) => (n === 'llm' ? llm : undefined) }, cfg)
  check('L2 discovery covers every provider', l2.models.length === 2, JSON.stringify(l2.models))
  check('L2 discovery merges providers per id', l2.models.find((m) => m.id === 'deepseek-flash')?.providers.length === 2)
  const l2Def = models.pickDefaultLevel2(l2, cfg)
  check('default L2 is the flash model', l2Def?.model === 'deepseek-flash', JSON.stringify(l2Def))
  check('default L2 keeps the configured provider', l2Def?.provider === 'deepseek-official', JSON.stringify(l2Def))

  const engineDiscovery = await models.discoverLevel3Models(
    { level3Endpoint: 'http://engine/v1', level3Model: 'configured-l3' },
    { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: 'local-a' }, { id: 'local-b' }] }) }) },
  )
  check('L3 discovery preserves engine order', engineDiscovery.source === 'engine' && engineDiscovery.models[0]?.id === 'local-a')
  check('L3 rank is 1-based', engineDiscovery.models[1]?.rank === 2, JSON.stringify(engineDiscovery.models))
  check('default L3 is engine #1', models.pickDefaultLevel3(engineDiscovery, cfg)?.model === 'local-a')

  const offline = await models.discoverLevel3Models(
    { level3Endpoint: 'http://engine/v1', level3Model: 'configured-l3' },
    { fetchImpl: async () => { throw new Error('connect ECONNREFUSED') } },
  )
  check('offline L3 degrades to the configured value first', offline.source === 'fallback' && offline.models[0]?.id === 'configured-l3')
  check('offline L3 never claims a ranking', offline.models.every((m) => m.rank === null))
  check('offline L3 keeps the built-in profiles', offline.models.some((m) => m.id === 'qwen3.8-27b-gsq-rco-iq3-s-mtp'))

  const message = models.renderModelSetupMessage({
    l2,
    l3: engineDiscovery,
    defaults: { level2: l2Def, level3: models.pickDefaultLevel3(engineDiscovery, cfg) },
    current: { level2Provider: 'deepseek-official', level2Model: 'deepseek-flash', level3Model: 'local-a' },
  })
  check('renders one copyable L2 line per model', (message.match(/^\s*\/pipe-config level2Model /gm) ?? []).length === 2, message)
  check('renders one copyable L3 line per model', (message.match(/^\s*\/pipe-config level3Model .*# 本机第/gm) ?? []).length === 2, message)
  check('marks the default L2', /\/pipe-config level2Model deepseek-flash\s+← 默认/.test(message), message)
  check('marks the default L3 as local #1', /\/pipe-config level3Model local-a\s+← 默认/.test(message), message)
  check('tells the user to copy a line', message.includes('复制'), message.slice(0, 200))
  check('explains the provider command', message.includes('只发 level2Model 会沿用当前 provider'), message)
  check('keeps the no-three-tier escape hatch', message.includes('不用三级模式') && message.includes('/pipe-config mode off'), message)
  const question = models.buildModelSetupQuestion({ defaults: { level2: l2Def, level3: { model: 'local-a' } } })
  // v124 — the onboarding question grew a "只用 L1+L2（关闭三级执行器）" option.
  check('question has the four onboarding choices', question.options?.length === 4 && question.options[0].label.includes('默认'))

  section('tool registration + defaults apply')
  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
  const engineServer = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-local-a' }, { id: 'qwen-local-b' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => engineServer.listen(0, '127.0.0.1', resolve))
  const port = engineServer.address().port
  const h = makeCtx()
  apply(h.ctx, { mode: 'auto', level3Endpoint: `http://127.0.0.1:${port}/v1` })
  try {
    check('pipeline_model_setup is registered', h.tools.has('pipeline_model_setup'))
    check('tool is L1-only', guards.L1_ONLY_TOOLS.has('pipeline_model_setup'))
    check('tool carries the run footer', guards.RUN_FOOTER_TOOLS.has('pipeline_model_setup'))

    const setup = await call(h, 'pipeline_model_setup', {})
    check('first call is not yet configured', setup.alreadyConfigured === false)
    check('tool discovers the engine order', setup.l3[0]?.id === 'qwen-local-a', JSON.stringify(setup.l3))
    check('tool default L3 is engine #1', setup.defaults.level3?.model === 'qwen-local-a', JSON.stringify(setup.defaults))
    check('tool default L2 is flash', setup.defaults.level2?.model === 'deepseek-flash', JSON.stringify(setup.defaults))
    check('tool message is copyable verbatim', setup.message.includes('/pipe-config level3Model qwen-local-a'))
    check('no model-setup record before apply', !existsSync(join(root, '.dsh', 'pipeline', 'model-setup.json')))

    const lockBefore = await call(h, 'pipeline_lock_requirements', { requirement: 'build something' })
    check('lock asks for model onboarding first', typeof lockBefore.modelSetupHint === 'string' && lockBefore.modelSetupHint.includes('pipeline_model_setup'), String(lockBefore.modelSetupHint))

    const applied = await call(h, 'pipeline_model_setup', { apply: 'defaults' })
    check('apply defaults reports the change', applied.applied?.level3Model === 'qwen-local-a', JSON.stringify(applied.applied))
    check('apply defaults saved the record', existsSync(join(root, '.dsh', 'pipeline', 'model-setup.json')))
    const savedGlobal = JSON.parse(readFileSync(join(tmp, 'global-config.json'), 'utf8'))
    check('apply defaults persisted the local #1 to the global config', savedGlobal.level3Model === 'qwen-local-a', JSON.stringify(savedGlobal))
    const savedSetup = JSON.parse(readFileSync(join(root, '.dsh', 'pipeline', 'model-setup.json'), 'utf8'))
    check('apply defaults remembered L2 flash per project', savedSetup.level2Model === 'deepseek-flash', JSON.stringify(savedSetup))
    check('apply defaults remembered the local #1 per project', savedSetup.level3Model === 'qwen-local-a', JSON.stringify(savedSetup))

    const lockAfter = await call(h, 'pipeline_lock_requirements', { requirement: 'build something' })
    check('lock hint disappears once the project picked models', lockAfter.modelSetupHint === null, JSON.stringify(lockAfter.modelSetupHint))

    const again = await call(h, 'pipeline_model_setup', {})
    check('same project reports alreadyConfigured', again.alreadyConfigured === true)
    check('already-configured message keeps the current line', again.message.startsWith('✅ 本项目已经定过模型'), again.message.slice(0, 60))

    const custom = await call(h, 'pipeline_model_setup', { apply: 'custom', level2Model: 'deepseek-v4-pro', level3Model: 'qwen-local-b' })
    check('custom apply changes both models', custom.applied?.level2Model === 'deepseek-v4-pro' && custom.applied?.level3Model === 'qwen-local-b', JSON.stringify(custom.applied))
    const savedCustom = JSON.parse(readFileSync(join(tmp, 'global-config.json'), 'utf8'))
    check('custom apply persisted', savedCustom.level2Model === 'deepseek-v4-pro' && savedCustom.level3Model === 'qwen-local-b', JSON.stringify(savedCustom))

    const adopted = await call(h, 'pipeline_model_setup', { apply: 'custom' })
    check('custom without values adopts the current config', adopted.applied?.changed?.length === 0, JSON.stringify(adopted.applied))
    check('adopt message says it kept the current values', adopted.message.includes('沿用当前 /pipe-config 配置'), adopted.message.slice(0, 120))

    const unknown = await call(h, 'pipeline_model_setup', { apply: 'custom', level2Model: 'not-a-real-model' })
    check('unknown model is accepted with a warning', unknown.warnings.some((w) => w.includes('not-a-real-model')), JSON.stringify(unknown.warnings))
  } finally {
    // Close keep-alive sockets first: on Windows, process.exit() while undici is
    // tearing a socket down trips a libuv assertion in async.c.
    engineServer.closeAllConnections?.()
    await new Promise((resolve) => engineServer.close(resolve))
  }
}

try {
  await main()
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v121 model setup: ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

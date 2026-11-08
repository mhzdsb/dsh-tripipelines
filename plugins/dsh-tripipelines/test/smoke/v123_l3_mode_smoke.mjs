// v123 — L3 is not necessarily a local engine: a cloud provider model can be the
// executor's model, but then it must run in `agent` mode (a DSH subagent on that
// provider) because the HTTP executor path has no API key of its own. This suite
// proves:
//   * `/pipe-config level3Model <id> mode=agent` sets mode + auto-pairs provider;
//   * a bare `agent` token after the model is accepted as shorthand;
//   * `mode=auto` still lets detection decide (engine model → executor);
//   * an explicit mode is respected (cloud model + mode=executor stays executor);
//   * `pipeline_model_setup({apply:'custom'})` auto-detects agent mode for a cloud L3;
//   * execute_local is refused in agent mode, spawn_local_executor in executor mode;
//   * `/pipe-config level2Model ... mode=agent` ignores the mode with a note;
//   * selftest checks provider pairing in agent mode (not the local endpoint).
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v123-'))
const libDir = join(tmp, 'lib')
const root = join(tmp, 'proj')
const globalConfigPath = join(tmp, 'global-config.json')
mkdirSync(join(root, '.git'), { recursive: true })

const MODEL_CATALOG = {
  'deepseek-official': ['deepseek-flash', 'deepseek-v4-pro'],
  'qwen-token-plan-cn': ['qwen3.7-plus', 'qwen3.8-flash', 'qwen3.8-max'],
  'strata-local': ['qwen3.8-flash-next-coder-iq1_m'],
}

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

// Local engine so `mode=auto` can detect engine models (and rank them).
const engineServer = createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-a' }, { id: 'local-b' }] }))
    return
  }
  res.writeHead(404)
  res.end()
})
const port = await new Promise((resolve) => engineServer.listen(0, '127.0.0.1', () => resolve(engineServer.address().port)))
const endpoint = `http://127.0.0.1:${port}/v1`

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
    level3Endpoint: endpoint,
  })

  const call = (name, args = {}) => h.tools.get(name).execute(args, { agent: { id: 's1' }, signal: undefined })
  const configCmd = (rawInput) => h.commands.get('pipe-config').handler({ rawInput })
  const readGlobal = () => JSON.parse(readFileSync(globalConfigPath, 'utf8'))

  const defaults = await call('pipeline_model_setup', { apply: 'defaults' })
  check('defaults leave L3 mode auto', defaults.applied?.level3Mode === 'auto', JSON.stringify(defaults.applied))
  check('defaults persist level3Model', readGlobal().level3Model === 'local-a', JSON.stringify(readGlobal()))

  section('mode=agent on a cloud model pairs the provider')
  const cmd = await configCmd('level3Model qwen3.7-plus mode=agent')
  const afterCmd = readGlobal()
  check('mode persisted as agent', afterCmd.level3Mode === 'agent', JSON.stringify(afterCmd))
  check('provider auto-paired to qwen-token-plan-cn', afterCmd.level3Provider === 'qwen-token-plan-cn', JSON.stringify(afterCmd))
  check('command text reports the pairing', String(cmd.text ?? '').includes('已自动配套 level3Provider=qwen-token-plan-cn'), String(cmd.text))

  section('agent mode is checked against the provider, not the endpoint')
  const selfAgent = await call('pipeline_selftest')
  const agentCheck = (selfAgent.checks ?? []).find((c) => c.name === 'L3 agent provider')
  check('agent-mode check present', Boolean(agentCheck), JSON.stringify(selfAgent.checks))
  check('agent-mode check passes when paired', agentCheck?.ok === true, JSON.stringify(agentCheck))
  check('detail names the agent pairing', String(agentCheck?.detail ?? '').includes('qwen-token-plan-cn/qwen3.7-plus'), String(agentCheck?.detail))

  section('a broken agent pairing is reported')
  await configCmd('level3Provider deepseek-official')
  const selfBroken = await call('pipeline_selftest')
  const brokenCheck = (selfBroken.checks ?? []).find((c) => c.name === 'L3 agent provider')
  check('agent-mode mismatch fails', brokenCheck?.ok === false, JSON.stringify(brokenCheck))
  check('degraded lists the agent check', (selfBroken.degraded ?? []).includes('L3 agent provider'), JSON.stringify(selfBroken.degraded))
  check('detail suggests the provider fix', String(brokenCheck?.detail ?? '').includes('/pipe-config level3Provider qwen-token-plan-cn'), String(brokenCheck?.detail))

  section('execute_local is refused in agent mode')
  const blocked = await call('pipeline_execute_local', { subtask: { desc: 'tiny', acceptance: 'ok' } })
  check('executor call is blocked', blocked?.blocked === true, JSON.stringify(blocked))
  check('reason points to spawn_local_executor', String(blocked?.reason ?? '').includes('pipeline_spawn_local_executor'), String(blocked?.reason))

  section('executor mode refuses the agent spawn')
  await configCmd('level3Mode executor')
  let spawnError = null
  try { await call('pipeline_spawn_local_executor', { prompt: 'x' }) } catch (e) { spawnError = e }
  check('spawn_local_executor throws in executor mode', String(spawnError?.message ?? '').includes('executor 模式'), String(spawnError?.message))

  section('mode=auto lets detection decide (engine model → executor)')
  const autoCmd = await configCmd('level3Model local-b mode=auto')
  const afterAuto = readGlobal()
  check('engine model switches mode to executor', afterAuto.level3Mode === 'executor', JSON.stringify(afterAuto))
  check('auto-detection is explained', String(autoCmd.text ?? '').includes('本机引擎模型'), String(autoCmd.text))

  section('bare agent token after the model is shorthand')
  await configCmd('level3Model qwen3.7-plus agent')
  const afterShorthand = readGlobal()
  check('shorthand sets mode agent', afterShorthand.level3Mode === 'agent', JSON.stringify(afterShorthand))
  check('shorthand pairs the provider', afterShorthand.level3Provider === 'qwen-token-plan-cn', JSON.stringify(afterShorthand))

  section('model_setup custom auto-detects a cloud L3')
  await configCmd('level3Provider deepseek-official')
  const custom = await call('pipeline_model_setup', { apply: 'custom', level3Model: 'qwen3.7-plus' })
  check('custom apply switches L3 to agent', custom.current?.level3Mode === 'agent', JSON.stringify(custom.current))
  check('custom apply pairs the provider', custom.current?.level3Provider === 'qwen-token-plan-cn', JSON.stringify(custom.current))
  check('custom apply explains the detection', (custom.warnings ?? []).some((w) => w.includes('云端模型')), JSON.stringify(custom.warnings))

  section('mode on L2 is ignored with a note')
  const before = readGlobal().level3Mode
  const l2cmd = await configCmd('level2Model deepseek-flash mode=agent')
  check('L2 command leaves L3 mode unchanged', readGlobal().level3Mode === before, JSON.stringify(readGlobal()))
  check('note explains L2 is always an agent', String(l2cmd.text ?? '').includes('二级固定为 agent 模式'), String(l2cmd.text))
} finally {
  await new Promise((resolve) => {
    engineServer.closeAllConnections?.()
    engineServer.close(resolve)
  })
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v123_l3_mode_smoke — ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

// v124 — manual L3 off: the pipeline runs two-tier (L1 + L2 only). Proves:
//   * `/pipe-config level3Mode off` persists, warns about the refused tools;
//   * bare shorthand `/pipe-config level3Model <id> off`;
//   * while off, a model change does NOT auto-re-enable L3 (no fake pairing);
//   * `/pipe-config level3Model <id> mode=auto` re-enables and re-detects;
//   * execute_local / execute_batch are refused with l3Disabled, spawn throws;
//   * selftest reports "L3 disabled" as ok (never degraded) in off mode;
//   * pipeline_model_setup custom apply level3Mode:'off' persists + records it;
//   * defaults do not silently re-enable an off L3;
//   * setup message shows the off state + the way back; question offers 恢复三级.
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v124-'))
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

// Local engine so re-enable detection has a real /models to rank.
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
  cpSync(join(repoRoot, 'plugins', 'dsh-tripipelines', 'lib'), libDir, { recursive: true })
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

  section('/pipe-config level3Mode off persists and explains')
  const offCmd = await configCmd('level3Mode off')
  check('mode persisted as off', readGlobal().level3Mode === 'off', JSON.stringify(readGlobal()))
  check('command text announces two-tier', String(offCmd.text ?? '').includes('三级已关闭（level3Mode=off）'), String(offCmd.text))
  check('text names the refused tools', String(offCmd.text ?? '').includes('pipeline_execute_local'), String(offCmd.text))
  check('text gives the recovery command', String(offCmd.text ?? '').includes('/pipe-config level3Mode auto'), String(offCmd.text))

  section('bare shorthand: level3Model <id> off')
  await configCmd('level3Mode auto')
  const shortOff = await configCmd('level3Model local-a off')
  check('shorthand sets mode off', readGlobal().level3Mode === 'off', JSON.stringify(readGlobal()))
  check('shorthand keeps the model', readGlobal().level3Model === 'local-a', JSON.stringify(readGlobal()))

  section('while off, a model change does not auto-re-enable L3')
  const before = readGlobal().level3Mode
  const modelCmd = await configCmd('level3Model qwen3.7-plus')
  check('model written', readGlobal().level3Model === 'qwen3.7-plus', JSON.stringify(readGlobal()))
  check('mode stays off', readGlobal().level3Mode === before, JSON.stringify(readGlobal()))
  check('note says it stayed off', String(modelCmd.text ?? '').includes('三级已关闭'), String(modelCmd.text))

  section('explicit mode=auto on the same command re-enables + detects')
  const reOn = await configCmd('level3Model local-b mode=auto')
  check('engine model detected -> executor', readGlobal().level3Mode === 'executor', JSON.stringify(readGlobal()))
  check('re-enable is explained', String(reOn.text ?? '').includes('本机引擎模型'), String(reOn.text))

  section('off refuses every L3 dispatch tool')
  await configCmd('level3Mode off')
  const blockedLocal = await call('pipeline_execute_local', { subtask: { desc: 'tiny', acceptance: 'ok' } })
  check('execute_local blocked', blockedLocal?.blocked === true && blockedLocal?.l3Disabled === true, JSON.stringify(blockedLocal))
  check('reason points at register_output', String(blockedLocal?.reason ?? '').includes('pipeline_register_output'), String(blockedLocal?.reason))
  const blockedBatch = await call('pipeline_execute_batch', { tasks: [{ desc: 'a', acceptance: 'ok' }] })
  check('batch reports the disabled task', blockedBatch?.failed === 1 && blockedBatch.results[0]?.l3Disabled === true, JSON.stringify(blockedBatch))
  let spawnError = null
  try { await call('pipeline_spawn_local_executor', { prompt: 'x' }) } catch (e) { spawnError = e }
  check('spawn_local_executor throws in off mode', String(spawnError?.message ?? '').includes('level3Mode=off'), String(spawnError?.message))

  section('selftest treats off as a deliberate state, not degradation')
  const self = await call('pipeline_selftest')
  const disabledCheck = (self.checks ?? []).find((c) => c.name === 'L3 disabled')
  check('disabled check present', Boolean(disabledCheck), JSON.stringify(self.checks))
  check('disabled check passes', disabledCheck?.ok === true, JSON.stringify(disabledCheck))
  check('no L3 engine probe ran', !(self.checks ?? []).some((c) => c.name === 'L3 engine' || c.name === 'L3 agent provider'), JSON.stringify(self.checks.map((c) => c.name)))
  check('degraded excludes the disabled tier', !(self.degraded ?? []).includes('L3 disabled'), JSON.stringify(self.degraded))

  section('pipeline_model_setup custom apply can switch off')
  const offSetup = await call('pipeline_model_setup', { apply: 'custom', level3Mode: 'off' })
  check('setup applied off', offSetup.current?.level3Mode === 'off', JSON.stringify(offSetup.current))
  check('setup warns what changes', (offSetup.warnings ?? []).some((w) => w.includes('二级负责人自己写代码')), JSON.stringify(offSetup.warnings))
  check('off recorded per project', JSON.parse(readFileSync(join(root, '.dsh', 'pipeline', 'model-setup.json'), 'utf8')).level3Mode === 'off')
  check('message shows the closed tier', String(offSetup.message ?? '').includes('已关闭（level3Mode=off）'), String(offSetup.message).slice(0, 200))
  check('message offers the way back', String(offSetup.message ?? '').includes('/pipe-config level3Mode auto'), String(offSetup.message))
  check('question offers to restore L3', (offSetup.question?.options ?? []).some((o) => o.label.includes('恢复三级执行器')), JSON.stringify(offSetup.question?.options))

  section('defaults never silently re-enable an off L3')
  const defAfterOff = await call('pipeline_model_setup', { apply: 'defaults' })
  check('defaults keep mode off', defAfterOff.current?.level3Mode === 'off', JSON.stringify(defAfterOff.current))
  check('defaults still set the L2 pair', defAfterOff.applied?.level2Model === 'deepseek-flash' || readGlobal().level2Model === 'deepseek-flash', JSON.stringify(readGlobal()))

  section('re-enable through the tool works end to end')
  const reEnabled = await call('pipeline_model_setup', { apply: 'custom', level3Model: 'local-a', level3Mode: 'auto' })
  check('tool re-enable lands on executor (engine model)', reEnabled.current?.level3Mode === 'executor', JSON.stringify(reEnabled.current))
  const afterRe = await call('pipeline_execute_local', { subtask: { desc: 'tiny', acceptance: 'ok' } })
  check('execute_local no longer disabled-blocked', afterRe?.l3Disabled !== true, JSON.stringify(afterRe))
} finally {
  await new Promise((resolve) => {
    engineServer.closeAllConnections?.()
    engineServer.close(resolve)
  })
  rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v124_l3_off_smoke — ${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1

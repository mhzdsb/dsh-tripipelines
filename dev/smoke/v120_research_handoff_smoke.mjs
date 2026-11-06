// v120 — `/pipe-research` must start the 7-step discussion, not just write a file.
//
// v119 and earlier: the command created `knowledge/research/<date>-<slug>.md` and
// returned a path; the user had to notice the note and open the discussion by
// themselves. v120 wakes the current agent with a first-step prompt
// (`invocation.agent.followup(...)`) so the interview starts in the same turn.
//
// This suite proves: the handoff message is a user-role, user-sourced text
// message carrying the topic + note path; the note still exists with the full
// skeleton; a host without `followup` degrades to a truthful text hint instead
// of throwing.
import { mkdirSync, mkdtempSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v120-'))
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
const subagents = { async startActivation() { throw new Error('unused') }, async drainChildren() {} }
const llm = { async *stream() { yield { type: 'text-delta', text: '[]' } } }
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
  return { ctx, commands }
}

try {
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

  const { apply } = await import(pathToFileURL(join(libDir, 'plugin.js')).href)
  const h = makeCtx()
  apply(h.ctx, { mode: 'auto' })

  section('registration')
  const cmd = h.commands.get('pipe-research')
  check('pipe-research command registered', Boolean(cmd), [...h.commands.keys()].join(','))
  check('description advertises starting the interview', /start the 7-step interview/i.test(cmd?.description ?? ''), String(cmd?.description))

  section('handoff wakes the agent with a first-step prompt')
  const captured = []
  const agent = { id: 's1', followup(message) { captured.push(message) } }
  const res = await cmd.handler({ agent, rawInput: '下一步投哪条路径', attachments: [], signal: new AbortController().signal })

  check('command succeeds', res?.kind === 'success', JSON.stringify(res))
  check('followup called exactly once', captured.length === 1, String(captured.length))
  const msg = captured[0]
  check('message is user role', msg?.role === 'user', String(msg?.role))
  check('message source is user', msg?.source?.kind === 'user', JSON.stringify(msg?.source))
  check('message has a unique id', typeof msg?.id === 'string' && msg.id.length > 0, String(msg?.id))
  const text = msg?.content?.[0]?.text ?? ''
  check('content is one text block', msg?.content?.length === 1 && msg.content[0]?.type === 'text', JSON.stringify(msg?.content))
  check('content names the topic', text.includes('开始研讨：下一步投哪条路径'), text.slice(0, 120))
  check('content points at the note', /knowledge\/research\/\d{4}-\d{2}-\d{2}-.+\.md/.test(text), text.slice(0, 200))
  check('content prescribes step 1 and 1-2 questions', text.includes('第 1 步') && text.includes('1-2 个问题') && text.includes('ask_user_question'))

  const researchDir = join(root, '.dsh', 'pipeline', 'knowledge', 'research')
  const files = existsSync(researchDir) ? (await import('node:fs')).readdirSync(researchDir) : []
  check('research note still created', files.length === 1, files.join(','))
  const note = files.length ? readFileSync(join(researchDir, files[0]), 'utf8') : ''
  check('note keeps the 7-step skeleton', note.includes('## 1. 立项') && note.includes('## 7. 记录与「错了会怎么暴露」'))
  check('result text says the interview started', res?.text?.includes('已把第 1 步'), String(res?.text))
  check('result text names the path', res?.text?.includes(files[0] ?? '\u0000'), String(res?.text))

  section('older host without followup degrades to a truthful hint')
  const res2 = await cmd.handler({ agent: { id: 's1' }, rawInput: '另一个议题', attachments: [], signal: new AbortController().signal })
  check('command still succeeds', res2?.kind === 'success', JSON.stringify(res2))
  check('text admits no agent was woken', res2?.text?.includes('没有可唤醒的 agent'), String(res2?.text))
  check('no claim that questions were sent', !res2?.text?.includes('已把第 1 步'), String(res2?.text))

  section('empty topic still starts a discussion')
  const captured2 = []
  const res3 = await cmd.handler({ agent: { id: 's1', followup(m) { captured2.push(m) } }, rawInput: '  ', attachments: [], signal: new AbortController().signal })
  check('empty input falls back to a topic', res3?.kind === 'success' && captured2.length === 1, JSON.stringify(res3))
  check('fallback topic is untitled topic', String(captured2[0]?.content?.[0]?.text ?? '').includes('开始研讨：untitled topic'))
} finally {
  try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} v120 research handoff: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

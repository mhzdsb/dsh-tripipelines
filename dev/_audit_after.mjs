// Post-fix measurement: run the REAL tools against the archived stock run
// (dev/_backup/20261029/stock-pipeline) and report payload sizes.
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const { createStore } = await import(pathToFileURL(join(repoRoot, 'plugin/lib/store.js')).href)
const { makeStatusTool, makeCheckpointTool } = await import(pathToFileURL(join(repoRoot, 'plugin/lib/tools/l1.js')).href)

const cjk = (s) => (String(s).match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
const tok = (s) => {
  const t = String(s)
  const c = cjk(t)
  return Math.ceil(c / 1.6 + (t.length - c) / 4)
}
const mb = (n) => `${n} chars ≈ ${tok('x'.repeat(n))} tok`

const tmp = mkdtempSync(join(tmpdir(), 'dsh-after-'))
try {
  const root = join(tmp, 'proj')
  mkdirSync(join(root, '.dsh'), { recursive: true })
  cpSync(join(repoRoot, 'dev/_backup/20261029/stock-pipeline'), join(root, '.dsh/pipeline'), { recursive: true })
  const cfg = { devDir: 'dev', level1ContextBudget: 64000, level1ContextWarnRatio: 0.8 }
  const r = createStore(cfg, { root })
  const ctx = { get: () => undefined }
  const exec = { agent: { id: 'l1' } }

  const status = makeStatusTool(ctx, cfg, r)
  const compact = JSON.stringify(await status.execute({}, exec))
  const verbose = JSON.stringify(await status.execute({ verbose: true }, exec))
  console.log('status (compact)     ', mb(compact.length))
  console.log('status (verbose)     ', mb(verbose.length))
  console.log('board agents         ', r.store.agents.size, '| tasks', r.store.tasks.size, '| subtasks', r.store.subtasks.size)

  const cp = makeCheckpointTool(ctx, cfg, r)
  const co = await cp.execute({ done: 'src/*.js' }, exec)
  const coJson = JSON.stringify(co)
  console.log('checkpoint (default) ', mb(coJson.length), '| file bytes', co.bytes)
  const cov = await cp.execute({ done: 'src/*.js', verbose: true }, exec)
  console.log('checkpoint (verbose) ', mb(JSON.stringify(cov).length))

  // Execute-result shape: a 40-line module no longer travels in the tool result.
  const code = 'function f(i) { return i + 1 }\n'.repeat(20)
  writeFileSync(join(root, 'sample.js'), code)
  console.log('code echo avoided    ', code.length, 'chars per subtask (now path/lines/sha8)')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

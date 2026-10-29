// v118 — isolation + recall semantics:
//   * P1 path confinement: pipeline_scan/pipeline_ledger root, pipeline_checkpoint path,
//     devDir, resumeFrom and scopeDir may not leave the calling workspace; the plugin
//     never writes into another project's files (the old code scanned any `root` and
//     stored the result in the CURRENT workspace's knowledge base);
//   * P2 no process.cwd() fallback: createStore/runtimeStateDir/executeAcceptance refuse
//     to guess a workspace instead of silently parking state in the daemon profile dir;
//   * recall: hits carry `kind` (code / decision / candidate / research), `coverage`,
//     `partial`, `generatedAt` (hashes.json, not mtime), `rootMismatch`, unfilled
//     /pipe-research drafts are excluded, and a project-owned dev/decisions.md is read
//     read-only;
//   * A/B workspaces stay separate: B never sees A's knowledge.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const lib = (p) => pathToFileURL(join(repoRoot, 'plugins/dsh-tripipelines/lib', p)).href
const { resolveInside, sameRoot, DEFAULT_CONFIG } = await import(lib('util.js')).then(async (u) => ({
  ...u,
  DEFAULT_CONFIG: (await import(lib('config.js'))).DEFAULT_CONFIG,
}))
const storeMod = await import(lib('store.js'))
const { validateConfigValue } = await import(lib('config.js'))
const { makeScanTool, makeLedgerTool, makeRecallTool } = await import(lib('tools/knowledge.js'))
const { makeCheckpointTool, makeSpawnModuleLeadTool } = await import(lib('tools/l1.js'))
const { executeAcceptance } = await import(lib('gates.js'))

const tmp = mkdtempSync(join(tmpdir(), 'dsh-v118-'))
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
function section(t) {
  console.log(`\n${t}`)
}
const throws = async (fn, re) => {
  try {
    await fn()
    return false
  } catch (err) {
    return re ? re.test(String(err?.message ?? err)) : true
  }
}

const projA = join(tmp, 'proj-a')
const projB = join(tmp, 'proj-b')
const projC = join(tmp, 'proj-c')
const projD = join(tmp, 'proj-d')
for (const p of [projA, projB, projC, projD]) mkdirSync(p, { recursive: true })

const cfg = { ...DEFAULT_CONFIG, devDir: 'dev', level2Provider: 'spawn', level2Model: 'test-model', spawnProvider: 'spawn' }
const ctx = { get: () => undefined }
const exec = { agent: { id: 'lead' }, signal: undefined }

// ---------------------------------------------------------------------------
section('P1 — resolveInsideWorkspace')
// ---------------------------------------------------------------------------
check('relative path resolves inside root', resolveInside(projA, 'src/a.js') === join(projA, 'src', 'a.js'))
check('absolute path inside root is accepted', resolveInside(projA, join(projA, 'x')) === join(projA, 'x'))
check('.. escape is refused', await throws(() => resolveInside(projA, '../evil.md'), /越出|escape/))
check('absolute path outside is refused', await throws(() => resolveInside(projA, projB), /越出|escape/))
check('empty path is refused', await throws(() => resolveInside(projA, '  '), /不能为空|empty/))
check('missing root is refused', await throws(() => resolveInside('', 'x'), /工作区|workspace/))
check('sameRoot normalizes separators/case', sameRoot(projA, `${projA}\\`))

// ---------------------------------------------------------------------------
section('P2 — no process.cwd() fallback')
// ---------------------------------------------------------------------------
check('createStore without root throws', await throws(() => storeMod.createStore(cfg), /opts\.root|root/))
check('runtimeStateDir without root throws', await throws(() => storeMod.runtimeStateDir(''), /root/))
const rA = storeMod.createStore(cfg, { root: projA })
check('store stateDir derives from the workspace root', rA.store.stateDir === join(projA, '.dsh', 'pipeline'))
check('store workspaceRoot is the given root', rA.store.workspaceRoot === projA)
check('executeAcceptance requires baseDir', await throws(() => executeAcceptance('def add(a,b):\n return a+b', 'add(1,2)==3'), /baseDir/))
const gateOk = executeAcceptance('def add(a, b):\n    return a + b', 'add(1,2)==3', rA.store.stateDir)
check('executeAcceptance runs with an explicit baseDir', gateOk?.ran === true && gateOk?.passed === 1)

// ---------------------------------------------------------------------------
section('P1 — scan/ledger root confinement + A/B isolation')
// ---------------------------------------------------------------------------
mkdirSync(join(projA, 'src'), { recursive: true })
writeFileSync(join(projA, 'src', 'calc.js'), 'export function add(a, b) { return a + b }\n', 'utf8')
writeFileSync(join(projA, 'README.md'), '# proj A\n\ncalc module docs.\n', 'utf8')
const scanA = makeScanTool(ctx, cfg, rA)
const ledgerA = makeLedgerTool(ctx, cfg, rA)
check('scan refuses a root outside the workspace', await throws(() => scanA.execute({ root: projB }, exec), /越出|escape|root/))
check('scan refuses a ../ root', await throws(() => scanA.execute({ root: '../proj-b' }, exec), /越出|escape|root/))
const scanned = await scanA.execute({}, exec)
check('scan of the workspace succeeds', scanned.ok === true && scanned.root === projA)
check('scan writes knowledge into the workspace state dir', existsSync(join(rA.store.stateDir, 'knowledge', 'index.md')))
const sub = await scanA.execute({ root: 'src' }, exec)
check('scan of a workspace subdir is allowed', sub.ok === true && sub.root === join(projA, 'src'))
check('ledger refuses a root outside the workspace', await throws(() => ledgerA.execute({ root: projB }, exec), /越出|escape|root/))
const rB = storeMod.createStore(cfg, { root: projB })
const recallB = makeRecallTool(ctx, cfg, rB)
const emptyB = await recallB.execute({ query: 'add' }, exec)
check('B workspace does not see A knowledge', emptyB.ok === false, JSON.stringify(emptyB))
const recallA = makeRecallTool(ctx, cfg, rA)
const hitA = await recallA.execute({ query: 'calc' }, exec)
check('A workspace recalls its own scan', hitA.ok === true && hitA.hitCount > 0)

// ---------------------------------------------------------------------------
section('P1 — checkpoint path / devDir / resumeFrom / scopeDir')
// ---------------------------------------------------------------------------
const cpA = makeCheckpointTool(ctx, cfg, rA)
check('checkpoint refuses a ../ path', await throws(() => cpA.execute({ path: '../outside.md' }, exec), /越出|escape/))
check('checkpoint refuses an absolute outside path', await throws(() => cpA.execute({ path: join(projB, 'x.md') }, exec), /越出|escape/))
const cp = cpA.execute({ done: 'calc' }, exec)
check('checkpoint default path is inside the workspace', cp.path === join(projA, 'dev', 'project_checkpoint.md') && existsSync(cp.path))
check('devDir validation rejects absolute', await throws(() => validateConfigValue('devDir', 'C:/tmp/dev'), /相对|绝对/))
check('devDir validation rejects ..', await throws(() => validateConfigValue('devDir', '../dev'), /\.\./))

const subs = { startActivation: async () => ({ childId: 'c1', messageId: 'm1' }), drainChildren: async () => {} }
const ctxS = { get: (k) => (k === 'subagents' ? subs : undefined) }
const rS = storeMod.createStore(cfg, { root: projA })
const spawn = makeSpawnModuleLeadTool(ctxS, cfg, rS)
check('spawn refuses an absolute resumeFrom', await throws(() => spawn.execute({ name: 'm', prompt: 'p', acceptance: 'a', resumeFrom: join(projB, 'x.md') }, exec), /越出|escape/))
check('spawn refuses a ../ scopeDir', await throws(() => spawn.execute({ name: 'm', prompt: 'p', acceptance: 'a', scopeDir: '../escape' }, exec), /越出|escape/))
const sp = await spawn.execute({ name: 'm', prompt: 'p', acceptance: 'a', scopeDir: 'work/m' }, exec)
check('spawn keeps a workspace-relative scopeDir inside the workspace', sp.scopeDir === 'work/m' && existsSync(join(projA, 'work', 'm')))

// ---------------------------------------------------------------------------
section('recall — kind / coverage / partial / drafts / rootMismatch')
// ---------------------------------------------------------------------------
function seedKnowledge(root, withHashes = true, hashesRoot = root) {
  const kd = join(root, '.dsh', 'pipeline', 'knowledge')
  mkdirSync(join(kd, 'modules'), { recursive: true })
  mkdirSync(join(kd, 'research'), { recursive: true })
  writeFileSync(join(kd, 'index.md'), '# index\n\nalpha 索引入口 说明文字\n', 'utf8')
  writeFileSync(join(kd, 'decisions.md'), '- D1: alpha 采用方案 A\n', 'utf8')
  writeFileSync(join(kd, 'ledger-candidates.md'), '- 候选: alpha 路径 B 待验证\n', 'utf8')
  writeFileSync(join(kd, 'modules', 'm1.md'), 'alpha 模块 负责解析 abcdef\n', 'utf8')
  writeFileSync(
    join(kd, 'research', 'draft.md'),
    '# 研讨：草稿\n\n## 2. 证据\nalpha 相关证据 见 bench/result.json:12\n\n## 7. 记录与「错了会怎么暴露」\n- 若结论错，最先在哪个检查点暴露：\n- 需要回写台账的条目：\n',
    'utf8',
  )
  writeFileSync(join(kd, 'research', 'filled.md'), '# 研讨：结论\n\nalpha 讨论结论\n\n## 7. 记录\n- 结论：alpha 换库\n', 'utf8')
  if (withHashes) writeFileSync(join(kd, 'hashes.json'), JSON.stringify({ version: 99, generatedAt: '2026-01-01T00:00:00.000Z', root: hashesRoot, files: {} }), 'utf8')
  return kd
}
seedKnowledge(projB)
mkdirSync(join(projB, 'dev'), { recursive: true })
writeFileSync(join(projB, 'dev', 'decisions.md'), '- D9: alpha 项目决策 采用 X\n', 'utf8')
const recB2 = await recallB.execute({ query: 'alpha' }, exec)
const sources = recB2.hits.map((h) => h.source)
const kindOfHit = (h) => h.kind
check('recall returns hits with kind labels', recB2.ok === true && recB2.hits.every((h) => typeof h.kind === 'string'))
check('index.md hits are kind=code', recB2.hits.some((h) => h.source.startsWith('index.md') && kindOfHit(h) === 'code'))
check('decisions.md hits are kind=decision', recB2.hits.some((h) => h.source.startsWith('decisions.md') && kindOfHit(h) === 'decision'))
check('ledger-candidates hits are kind=candidate', recB2.hits.some((h) => h.source.startsWith('ledger-candidates.md') && kindOfHit(h) === 'candidate'))
check('module pages are kind=code', recB2.hits.some((h) => h.source.startsWith('modules/') && kindOfHit(h) === 'code'))
check('filled research notes are indexed as kind=research', recB2.hits.some((h) => h.source.startsWith('research/filled.md') && kindOfHit(h) === 'research'))
check('unfilled research drafts are never searched', !sources.some((s) => s.startsWith('research/draft.md')), JSON.stringify(sources))
check('project-owned dev/decisions.md is read read-only', sources.some((s) => s.startsWith('dev/decisions.md')), JSON.stringify(sources))
check('coverage counts scan/modules/candidates/decisions/research', (() => {
  const c = recB2.coverage
  return c && c.scan === true && c.modules === 1 && c.candidates === true && c.decisions === true && c.researchFilled === 1 && c.researchDrafts === 1
})(), JSON.stringify(recB2.coverage))
check('partial=false when index.md exists', recB2.partial === false)
check('generatedAt comes from hashes.json', recB2.generatedAt === '2026-01-01T00:00:00.000Z')
check('rootMismatch=false when the scan root matches', !recB2.rootMismatch)

// rootMismatch + partial directories
seedKnowledge(projC, true, projA)
const rC = storeMod.createStore(cfg, { root: projC })
const recC = await makeRecallTool(ctx, cfg, rC).execute({ query: 'alpha' }, exec)
check('rootMismatch=true when hashes.json points at another workspace', recC.rootMismatch === true && /different workspace/.test(String(recC.warning)))
mkdirSync(join(projD, '.dsh', 'pipeline', 'knowledge', 'research'), { recursive: true })
writeFileSync(join(projD, '.dsh', 'pipeline', 'knowledge', 'research', 'filled.md'), '# 研讨\n\nalpha 只有研讨笔记\n\n## 7. 记录\n- 结论：alpha 采用研究结论\n', 'utf8')
const rD = storeMod.createStore(cfg, { root: projD })
const recD = await makeRecallTool(ctx, cfg, rD).execute({ query: 'alpha' }, exec)
check('partial=true when there is no scan but a filled research note', recD.ok === true && recD.partial === true && recD.hitCount > 0, JSON.stringify(recD?.coverage))
const emptyDir = storeMod.createStore(cfg, { root: join(tmp, 'proj-empty') })
const recEmpty = await makeRecallTool(ctx, cfg, emptyDir).execute({ query: 'alpha' }, exec)
check('empty knowledge dir still fails closed', recEmpty.ok === false && /knowledge base empty/.test(String(recEmpty.error)))
const trav = await recallB.execute({ query: 'alpha', files: ['../../secret.md'] }, exec)
check('files filter still refuses traversal', trav.ok === true && trav.hitCount === 0, JSON.stringify(trav.hits))

// ---------------------------------------------------------------------------
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best-effort */ }
console.log(`\nv118 isolation smoke: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

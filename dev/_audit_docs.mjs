// AUDIT ONLY — docs/code consistency check.
import fs from 'node:fs'

const cfgSrc = fs.readFileSync('plugin/lib/config.js', 'utf8')
const keys = [...cfgSrc.matchAll(/^ {2}([a-zA-Z0-9]+): \{/gm)].map((m) => m[1])
const tools = [...new Set(
  ['plugin/lib/tools/l1.js', 'plugin/lib/tools/l2l3.js', 'plugin/lib/tools/knowledge.js']
    .flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/name: '(pipeline_[a-z_]+)'/g)].map((m) => m[1])),
)]
const cmds = ['pipe-config', 'pipe-tokens', 'pipe-stop', 'pipe-resume', 'pipe-research', 'pipe-off', 'pipe-selftest']
const docs = ['plugin/README.md', 'plugin/TUTORIAL.md', 'plugin/QUICKSTART.md', 'plugin/docs/agent-lifecycle-design.md',
  'plugin/examples/cli-tool.md', 'plugin/examples/rest-api.md', 'plugin/examples/todo-app.md']
console.log('CONFIG_KEYS', keys.length, '| tools', tools.length)
for (const d of docs) {
  const txt = fs.readFileSync(d, 'utf8')
  const t = [...new Set([...txt.matchAll(/pipeline_[a-z_]+/g)].map((m) => m[0]))]
  const unknown = t.filter((x) => !tools.includes(x) && x !== 'pipeline-orchestration')
  const c = [...new Set([...txt.matchAll(/\/pipe-[a-z]+/g)].map((m) => m[0].slice(1)))]
  const unknownC = c.filter((x) => !cmds.includes(x))
  const k = [...new Set([...txt.matchAll(/\b(level[123][A-Za-z]+|max[A-Z][A-Za-z]+|semanticGate[A-Za-z]*|allowCodeExecution|activationGate|autoTuneSweetSpot)\b/g)].map((m) => m[1]))]
  const unknownK = k.filter((x) => !keys.includes(x))
  console.log('---', d, '| tools', t.length, 'unknown:', unknown.join(',') || 'none', '| cmd unknown:', unknownC.join(',') || 'none', '| config unknown:', unknownK.join(',') || 'none')
}
// version/date drift
for (const d of docs) {
  const txt = fs.readFileSync(d, 'utf8')
  const v = [...new Set([...txt.matchAll(/\bv?1\.(1[0-9]|[0-9])\.[0-9]\b/g)].map((m) => m[0]))]
  if (v.length) console.log('version mentions', d, v.join(','))
}

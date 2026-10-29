// Verify SKILL_BODY (embedded in lib/prompts.js) is byte-identical to SKILL.md.
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const src = readFileSync(new URL('plugins/dsh-tripipelines/lib/prompts.js', root), 'utf8')
const m = src.match(/export const SKILL_BODY = `([\s\S]*?)`\n\n\/\/ -{10,}/)
if (!m) {
  console.log('FAIL  could not extract SKILL_BODY')
  process.exit(1)
}
const body = m[1]
const disk = readFileSync(new URL('plugins/dsh-tripipelines/skills/pipeline-orchestration/SKILL.md', root), 'utf8').replace(/\r\n/g, '\n')
// SKILL_BODY lives inside a template literal, so the sync step escapes ` $ \ .
// Undo exactly those three escapes before comparing, otherwise every backtick
// in the skill (tool names, paths) shows up as a false diff.
const unescape = (s) => String(s).replace(/\\([`$\\])/g, '$1')
const embedded = unescape(body).replace(/\r\n/g, '\n')
if (embedded === disk) {
  console.log('PASS  SKILL.md and SKILL_BODY are byte-identical')
} else {
  console.log('FAIL  SKILL.md and SKILL_BODY differ')
  const a = embedded.split('\n')
  const b = disk.split('\n')
  const n = Math.max(a.length, b.length)
  let shown = 0
  for (let i = 0; i < n && shown < 8; i++) {
    if (a[i] !== b[i]) {
      console.log(`  line ${i + 1}:\n    embedded: ${JSON.stringify(a[i])}\n    disk    : ${JSON.stringify(b[i])}`)
      shown++
    }
  }
  process.exit(1)
}

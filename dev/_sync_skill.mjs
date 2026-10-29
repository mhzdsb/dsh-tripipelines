// One-off: mirror plugin/skills/pipeline-orchestration/SKILL.md into the
// SKILL_BODY template literal in plugin/lib/prompts.js (byte-identical contract).
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const md = readFileSync(new URL('plugin/skills/pipeline-orchestration/SKILL.md', root), 'utf8').replace(/\r\n/g, '\n')
const escaped = md.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
const p = new URL('plugin/lib/prompts.js', root)
let src = readFileSync(p, 'utf8')
const re = /(export const SKILL_BODY = `)[\s\S]*?(`\n\n\/\/ -{10,})/
if (!re.test(src)) throw new Error('SKILL_BODY marker not found')
src = src.replace(re, (m, a, b) => a + escaped + b)
writeFileSync(p, src, 'utf8')
console.log(`synced ${md.length} skill chars into prompts.js`)

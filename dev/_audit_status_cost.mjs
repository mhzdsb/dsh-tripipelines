import { readFileSync } from 'node:fs'
const p = 'dev/_backup/20261029/stock-pipeline/board.json'
const board = JSON.parse(readFileSync(p, 'utf8'))
const cjk = (s) => (String(s).match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
const tokNaive = (s) => Math.ceil(String(s).length / 4)
const tokCjk = (s) => { const t = String(s); const c = cjk(t); return Math.ceil(c / 1.6 + (t.length - c) / 4) }
const rows = []
let totalChars = 0, totalCjk = 0
for (const [k, v] of Object.entries(board)) {
  if (k === 'agents' || k === 'subtasks' || k === 'tasks') continue
  const s = JSON.stringify(v)
  rows.push([k, s.length]); totalChars += s.length; totalCjk += cjk(s)
}
const tasks = JSON.stringify(board.tasks)
const subs = JSON.stringify(board.subtasks)
const agents = JSON.stringify(board.agents)
rows.push(['tasks[]', tasks.length], ['subtasks[]', subs.length], ['agents[]', agents.length])
totalChars += tasks.length + subs.length + agents.length
totalCjk += cjk(tasks) + cjk(subs) + cjk(agents)
console.log('field'.padEnd(14), 'chars')
for (const [k, n] of rows.sort((a, b) => b[1] - a[1])) console.log(String(k).padEnd(14), n)
console.log('TOTAL board-derived chars:', totalChars, 'cjk:', totalCjk, 'cjkRatio:', (totalCjk / totalChars).toFixed(2))
console.log('tokens naive/4:', tokNaive('x'.repeat(totalChars)), '| cjk-aware:', Math.ceil(totalCjk / 1.6 + (totalChars - totalCjk) / 4))
console.log('agents count:', board.agents.length, 'tasks:', board.tasks.length, 'subtasks:', board.subtasks.length)
console.log('sample agent desc len:', board.agents.map(a => (a.desc || '').length).sort((a,b)=>b-a).slice(0,3))
console.log('sample task desc/acc:', board.tasks.slice(0,2).map(t => [t.desc?.length, t.acceptance?.length]))

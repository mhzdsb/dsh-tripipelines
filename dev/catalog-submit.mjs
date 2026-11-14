// dev/catalog-submit.mjs — one-shot: commit entry+icon to fork branch, open PR against awesome-dsh-plugin (v1.35.0 submission)
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const out = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' })
let tok = ''
for (const line of out.split(/\r?\n/)) if (line.startsWith('password=')) tok = line.slice(9)
const H = { authorization: 'Bearer ' + tok, 'user-agent': 'dsh-lead', 'content-type': 'application/json' }

const info = JSON.parse(fs.readFileSync(process.env.TEMP + '\\gh-fork-info.json', 'utf8'))
const BR = 'add-mhzdsb-dsh-tripipelines'

async function main() {
  const ref = await (await fetch(`https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/ref/heads/${BR}`, { headers: H })).json()
  const commit = await (await fetch(ref.object.url, { headers: H })).json()
  const baseTree = commit.tree.sha

  const pngB64 = fs.readFileSync('assets/icon-180.png').toString('base64')
  const yml = fs.readFileSync('投稿/mhzdsb__dsh-tripipelines.yml', 'utf8')

  // explicit blobs (png must be base64; inline tree content guesses utf8 and corrupts binary)
  const b1 = await (await fetch('https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/blobs', { method: 'POST', headers: H, body: JSON.stringify({ content: pngB64, encoding: 'base64' }) })).json()
  const b2 = await (await fetch('https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/blobs', { method: 'POST', headers: H, body: JSON.stringify({ content: yml, encoding: 'utf-8' }) })).json()
  if (!b1.sha || !b2.sha) throw new Error('blob failed ' + JSON.stringify(b1) + JSON.stringify(b2))

  const tr = await (await fetch('https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/trees', {
    method: 'POST', headers: H,
    body: JSON.stringify({ base_tree: baseTree, entries: [
      { path: 'assets/icon-180.png', mode: '100644', type: 'blob', sha: b1.sha },
      { path: 'data/plugins/mhzdsb__dsh-tripipelines.yml', mode: '100644', type: 'blob', sha: b2.sha },
    ] }),
  })).json()
  if (!tr.sha) throw new Error('tree failed ' + JSON.stringify(tr))
  console.log('tree', tr.sha)

  const c = await (await fetch('https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/commits', {
    method: 'POST', headers: H,
    body: JSON.stringify({ message: 'Add dsh-tripipelines entry + storefront icon', tree: tr.sha, parents: [commit.sha] }),
  })).json()
  if (!c.sha) throw new Error('commit failed ' + JSON.stringify(c))
  console.log('commit', c.sha)

  const ur = await fetch(`https://api.github.com/repos/mhzdsb/awesome-dsh-plugin/git/refs/heads/${BR}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ sha: c.sha }),
  })
  console.log('ref update', ur.status)

  const bodyLines = [
    'Adding one entry file (data/plugins/mhzdsb__dsh-tripipelines.yml) plus its GitHub-hosted raster tile (assets/icon-180.png). No other files touched.',
    '',
    'Checks against the submission rules:',
    '- dsh.bundle manifest: declared in plugins/dsh-tripipelines/package.json ("dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }) — subpackage under plugins/, CI reads it there.',
    '- Repo age: created 2026-10-29 (>1 day).',
    '- Topic dsh-plugin: set on the repo.',
    '- Real working code: full plugin (host tools / gates / board route + web sidebar card), MIT, zero external dependencies.',
    '- Description claims are mechanism-specific and verifiable in source: three tiers L1/L2/L3 with strict tool adjacency (lib/guards.js), per-task acceptance gates (lib/gates.js), budget guards (lib/store.js budgetRefusal), live sidebar status board (lib/board-route.js + client.js), zh/en UI (locale/*.json + client dictionaries).',
    '- Not a meta-package; no dependency re-uploads (no runtime deps at all).',
    '- npm package not published yet — per contributing, listing works from GitHub source; the package repository field already points here for future auto-link.',
    '',
    'The PNG is rendered from the plugin\'s own in-package icon.svg motif (same M wordmark + three-tier dots).',
  ]
  const pr = await (await fetch('https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls', {
    method: 'POST', headers: H,
    body: JSON.stringify({ title: 'Add mhzdsb/dsh-tripipelines (workflow)', head: `${info.login}:${BR}`, base: 'main', body: bodyLines.join('\n') }),
  })).json()
  console.log('PR:', pr.html_url || JSON.stringify(pr))
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })

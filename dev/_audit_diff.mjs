import { readFileSync, mkdtempSync, cpSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const repo = process.cwd()
const load = (p) => import(pathToFileURL(join(repo, "plugin/lib", p)).href)
const { createStore } = await load("store.js")
const { makeStatusTool } = await load("tools/l1.js")
const { DEFAULT_CONFIG } = await load("config.js")
const tmp = mkdtempSync(join(tmpdir(), "dsh-diff-"))
cpSync(join(repo, "dev/_backup/20261029/stock-pipeline"), join(tmp, "proj/.dsh/pipeline"), { recursive: true })
const r = createStore(DEFAULT_CONFIG, { root: join(tmp, "proj"), restore: true })
const st = await makeStatusTool({ get: () => undefined }, DEFAULT_CONFIG, r).execute({})
for (const k of Object.keys(st)) console.log(k, JSON.stringify(st[k]).length)
console.log("total", JSON.stringify(st).length)
console.log("agent0", JSON.stringify(st.agents[0]))

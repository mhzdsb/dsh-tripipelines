import { mkdtempSync, cpSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
const repo = process.cwd()
const load = (p) => import(pathToFileURL(join(repo, "plugin/lib", p)).href)
const { createStore } = await load("store.js")
const { makePlanTool } = await load("tools/l1.js")
const { DEFAULT_CONFIG } = await load("config.js")
const tmp = mkdtempSync(join(tmpdir(), "dsh-plan-"))
cpSync(join(repo, "dev/_backup/20261029/stock-pipeline"), join(tmp, "proj/.dsh/pipeline"), { recursive: true })
const r = createStore(DEFAULT_CONFIG, { root: join(tmp, "proj"), restore: true })
r.store.locked = true
const plan = makePlanTool({ get: () => undefined }, DEFAULT_CONFIG, r)
const tasks = [...r.store.tasks.values()].map(t => ({ id: t.id, desc: t.desc, acceptance: t.acceptance, assignee: t.assignee, depends_on: t.depends_on }))
const lean = await plan.execute({ taskPlan: { tasks, milestones: r.store.run.milestones }, reset: true })
const verbose = await plan.execute({ taskPlan: { tasks, milestones: r.store.run.milestones }, verbose: true, reset: true })
const j = (v) => JSON.stringify(v).length
console.log("plan lean", j(lean), "verbose", j(verbose), "saved", j(verbose) - j(lean))
rmSync(tmp, { recursive: true, force: true })

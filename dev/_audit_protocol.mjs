import { pathToFileURL } from "node:url"
import { join } from "node:path"
const load = (p) => import(pathToFileURL(join(process.cwd(), "plugin/lib", p)).href)
const { buildProtocolText, buildProtocolOffText } = await load("prompts.js")
const { DEFAULT_CONFIG } = await load("config.js")
const p = buildProtocolText(DEFAULT_CONFIG), o = buildProtocolOffText()
const tok = (s) => Math.ceil(s.length / 4)
console.log("protocol chars", p.length, "tok~", tok(p))
console.log("off chars", o.length, "tok~", tok(o))

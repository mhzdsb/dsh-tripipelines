// Locate a literal string inside an Electron asar archive and report which packed file contains it.
// usage: node dev/_find_asar_string.mjs <asar> <needle>
import { readFileSync } from 'node:fs'

const [asarPath, needle] = process.argv.slice(2)
const buf = readFileSync(asarPath)
const sizeBuf = Buffer.alloc(8)
sizeBuf.writeUInt32LE(0, 0)
const headerStringSize = buf.readUInt32LE(12)
const headerString = buf.toString('utf8', 16, 16 + headerStringSize)
const header = JSON.parse(headerString)
const dataStart = 16 + headerStringSize
const dataLen = buf.length - dataStart

const files = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else if (typeof entry.offset === 'number') files.push({ p, offset: Number(entry.offset), size: entry.size })
  }
}
walk(header, '')

// chunked search with overlap
const needleBuf = Buffer.from(needle, 'utf8')
const chunk = 8 * 1024 * 1024
const hits = []
for (let base = 0; base < dataLen; base += chunk) {
  const end = Math.min(dataLen, base + chunk + needleBuf.length)
  const slice = buf.subarray(dataStart + base, dataStart + end)
  let idx = slice.indexOf(needleBuf)
  while (idx !== -1) {
    hits.push(base + idx)
    idx = slice.indexOf(needleBuf, idx + 1)
  }
}
console.log(`files=${files.length} dataLen=${dataLen} hits=${hits.length}`)
for (const h of hits.slice(0, 40)) {
  const file = files.find((f) => h >= f.offset && h < f.offset + f.size)
  console.log(`${file ? file.p : '(gap)'} @${h}`)
}

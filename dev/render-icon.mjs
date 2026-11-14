// render-icon.mjs — pure-Node rasterizer for the dsh-tripipelines storefront tile (v1.35.0 catalog submission)
// Draws the same motif as plugins/dsh-tripipelines/icon.svg (rounded dark bg, orange border ring,
// orange M wordmark polyline, three fading blue dots) at 180x180 and writes assets/icon-180.png.
import fs from 'node:fs'
import zlib from 'node:zlib'

function crc32(buf) {
  let c; const t = []
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = t[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const W = 180, H = 180, S = W / 64
const img = Buffer.alloc(W * H * 4)
function px(x, y, r, g, b, a) {
  const ix = Math.round(x * S), iy = Math.round(y * S)
  if (ix < 0 || iy < 0 || ix >= W || iy >= H || a <= 0) return
  const o = (iy * W + ix) * 4
  const sa = a / 255, da = img[o + 3] / 255
  const na = sa + da * (1 - sa)
  if (na <= 0) { img[o + 3] = 0; return }
  img[o] = (r * sa + img[o] * da * (1 - sa)) / na | 0
  img[o + 1] = (g * sa + img[o + 1] * da * (1 - sa)) / na | 0
  img[o + 2] = (b * sa + img[o + 2] * da * (1 - sa)) / na | 0
  img[o + 3] = na * 255 | 0
}
function distSeg(pxv, pyv, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((pxv - ax) * dx + (pyv - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(pxv - (ax + t * dx), pyv - (ay + t * dy))
}
function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x > w || y > h) return false
  if (x < r && y < r) return Math.hypot(x - r, y - r) <= r
  if (x > w - r && y < r) return Math.hypot(x - (w - r), y - r) <= r
  if (x < r && y > h - r) return Math.hypot(x - r, y - (h - r)) <= r
  if (x > w - r && y > h - r) return Math.hypot(x - (w - r), y - (h - r)) <= r
  return true
}

const M = [[14, 46], [14, 20], [24, 34], [34, 20], [34, 46]]
const DOTS = [[46, 22, 1], [46, 34, 0.75], [46, 46, 0.5]]

for (let piy = 0; piy < H; piy++) {
  const y = piy / S
  for (let pix = 0; pix < W; pix++) {
    const x = pix / S
    if (!inRoundedRect(x, y, 64, 64, 14)) continue
    let R = 0x1c, G = 0x1f, B = 0x26
    // border ring: outer minus inner rounded rect, orange @ .35 over bg
    if (!inRoundedRect(x - 2.2, y - 2.2, 64 - 4.4, 64 - 4.4, 11.8)) {
      const a = 0.35
      R = R * (1 - a) + 0xff * a | 0
      G = G * (1 - a) + 0x8a * a | 0
      B = B * (1 - a) + 0x3d * a | 0
    }
    // dots: soft-edged, per-dot opacity fade (top→bottom = L1→L3)
    for (const [cx, cy, op] of DOTS) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= 3.5) {
        const al = Math.min(1, op * (d <= 2.6 ? 1 : (3.5 - d) / 0.9))
        R = R * (1 - al) + 0x60 * al | 0
        G = G * (1 - al) + 0xa5 * al | 0
        B = B * (1 - al) + 0xfa * al | 0
      }
    }
    // M wordmark stroke 4.5 round caps/joins
    let md = 1e9
    for (let i = 0; i < M.length - 1; i++) md = Math.min(md, distSeg(x, y, M[i][0], M[i][1], M[i + 1][0], M[i + 1][1]))
    const hw = 4.5 / 2
    if (md <= hw) {
      const al = md <= hw - 0.7 ? 1 : (hw - md) / 0.7
      R = R * (1 - al) + 0xff * al | 0
      G = G * (1 - al) + 0x8a * al | 0
      B = B * (1 - al) + 0x3d * al | 0
    }
    px(x, y, R, G, B, 255)
  }
}

fs.mkdirSync('assets', { recursive: true })
const png = encodePng(W, H, img)
fs.writeFileSync('assets/icon-180.png', png)
console.log('assets/icon-180.png', png.length, 'bytes')

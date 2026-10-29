// dsh-pipeline — pure helpers and shared constants (no DSH service access).
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

// Task lifecycle states on the board.
export const TASK_STATES = ['pending', 'in_progress', 'review', 'done', 'failed']

// Default L2 assignee names (v87: up to maxLevel2Agents=10). v86 made this a
// fallback label, not a whitelist — L1 names each L2 freely by its responsibility.
export const LEVEL2_NAMES = [
  'level2_module_a', 'level2_module_b', 'level2_module_c', 'level2_module_d', 'level2_module_e',
  'level2_module_f', 'level2_module_g', 'level2_module_h', 'level2_module_i', 'level2_module_j',
]

export const RESULT_STATUS_OK = ['done', 'ok', 'success', 'complete', 'passed']

export function text(content) {
  return [{ type: 'text', text: String(content) }]
}

// Join text/reasoning blocks of a subagent result into one string.
export function contentText(blocks) {
  return (blocks ?? [])
    .map((b) => (b && (b.type === 'text' || b.type === 'reasoning') ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

// Create a directory (and its parents) when missing.
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// Rough token estimate. Latin text is ~4 chars/token, but CJK is ~1-1.6
// chars/token, so a flat /4 under-counted every Chinese doc/prompt by ~3x.
// v112 (B9): count CJK code points separately instead of assuming ASCII.
const CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/g
export function estimateTokens(input) {
  const s = typeof input === 'string' ? input : JSON.stringify(input)
  const cjk = (s.match(CJK_RE) ?? []).length
  const ascii = s.length - cjk
  return Math.max(1, Math.ceil(cjk / 1.6 + ascii / 4))
}

// L0 = full context; L1 = key-fact extraction (~2.5x reduction): keep code /
// identifiers / JSON / structured lines, drop prose filler, cap length.
export function compressText(input, level) {
  if (level !== 'L1') return input
  const lines = String(input).split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    const t = line.trim()
    if (t.length === 0) continue
    // Keep anything that looks structural or code-like; drop filler words.
    if (
      /[{}\[\]]/.test(t) ||
      /^[\s]*[a-zA-Z_$][\w$]*\s*[:=]/.test(t) ||
      /[().{};=<>]/.test(t) ||
      /"(?:[^"\\]|\\.)*"/.test(t) ||
      /'(?:[^'\\]|\\.)*'/.test(t)
    ) {
      kept.push(t)
    }
  }
  // Fallback: if nothing looked structural, keep the first few sentences.
  if (kept.length === 0) {
    const sentences = String(input).split(/[.;；。]\s*/).filter((s) => s.trim())
    kept.push(...sentences.slice(0, 3).map((s) => s.trim()))
  }
  return kept.join('\n')
}

export function keywordTokens(input) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'for', 'with', 'that', 'this', 'from', 'into',
    'must', 'should', 'shall', 'will', 'have', 'has', 'each', 'all', 'any', 'not',
    'are', 'was', 'were', 'been', 'being', 'its', 'your', 'our', 'their', 'also',
    'write', 'writes', 'function', 'functions', 'python', 'json', 'field', 'fields',
    'status', 'done', 'exactly', 'exact', 'prose', 'output', 'only', 'keep', 'use',
    'put', 'here', 'define', 'defines', 'body', 'parse', 'parses', 'strict', 'single',
    'object', 'value', 'values', 'required', 'criteria', 'acceptance', 'unchanged',
    'outside', 'skeleton', 'given', 'above', 'below',
    'def', 'return', 'returns', 'returning', 'print', 'import', 'class', 'pass', 'self',
    'true', 'false', 'none', 'if', 'else', 'elif', 'while', 'try', 'except', 'raise',
    'yield', 'lambda', 'assert', 'break', 'continue', 'code', 'string', 'number',
  ])
  return String(input)
    .toLowerCase()
    .match(/[a-z_$][a-z0-9_$]{2,}/g)
    ?.filter((w) => !stop.has(w)) ?? []
}

// Naive English stemming for deterministic keyword matching.
export function stem(word) {
  return word.replace(/(ing|ed|es|s)$/i, '') || word
}

// Does the output look like real code rather than prose or empty text?
export function hasStructure(code) {
  return /(def\b|function\b|=>|return\b|class\b|\bconst\b|\blet\b|\bvar\b|import\b|export\b|\{|\})/.test(String(code || ''))
}

// Deterministic semantic-quality proxy in [0,1]: structural presence (60%)
// plus stemmed keyword coverage of the acceptance criteria (40%). This is a
// mechanically checkable stand-in; a full deployment may replace it with a
// Level-2 model score. Threshold is configurable (default 0.7).
// v104 — cap at 0.5: a pair of braces or a matching keyword is not proof that the
// code is correct, so the proxy can never clear a 0.7 gate on its own. Assertions
// are the only path to "passed" unless the user lowers the threshold explicitly.
export function semanticScore(code, acceptance) {
  const words = [...new Set(keywordTokens(acceptance).map(stem))]
  const structural = hasStructure(code) ? 0.6 : 0
  if (words.length === 0) return Math.min(0.5, structural + 0.4)
  const hay = stem(String(code || '').toLowerCase())
  const hits = words.filter((w) => hay.includes(w)).length
  // Robust to verbose acceptance: cap the keyword count so a long acceptance
  // does not depress the ratio (prose words are no longer over-weighted).
  const capped = Math.min(words.length, 8)
  const coverage = hits / capped
  return Math.min(0.5, structural + 0.4 * coverage)
}

export function normalizeStatus(status) {
  const s = String(status || '').toLowerCase()
  if (RESULT_STATUS_OK.includes(s)) return 'done'
  return s || 'unknown'
}

export function isPlainObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Parse JSON from a small-model reply. Local models sometimes wrap JSON in
// markdown fences; this is the single parser every L3 output goes through.
export function safeParseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    if (m) {
      try {
        return JSON.parse(m[1].trim())
      } catch {
        /* fall through */
      }
    }
    const first = raw.indexOf('{')
    const last = raw.lastIndexOf('}')
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(raw.slice(first, last + 1))
      } catch {
        /* fall through */
      }
    }
    throw new Error(`local model returned non-JSON output: ${raw.slice(0, 200)}`)
  }
}

// Split text into <=maxTokens chunks while respecting sentence boundaries and a
// 10-line cap per subtask.
export function splitIntoChunks(input, maxTokens) {
  const sentences = String(input)
    .split(/(?<=[.;。；\n])\s*|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const chunks = []
  let current = ''
  for (const s of sentences) {
    const candidate = current ? `${current} ${s}` : s
    if (estimateTokens(candidate) <= maxTokens && candidate.split('\n').length <= 10) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      current = s
    }
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [String(input).trim()]
}

// Numeric config with a floor: 0 / absent / NaN -> fallback (one source of defaults).
export function numCfg(cfg, key, fallback) {
  const n = Number(cfg?.[key])
  return n > 0 ? n : fallback
}

// Shared tool result shape: compact JSON (no pretty-print) — the model reads it.
export function jsonOutput() {
  return { schema: { type: 'object', additionalProperties: true }, render: (_a, value) => text(JSON.stringify(value)) }
}

// Read a text file, '' when unreadable (knowledge modules share this).
export const readText = (p) => {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

// v104 — single redaction gate for every knowledge-layer write. A secret that
// leaks into an excerpt (a hardcoded key in source, a credential in a doc) must
// never reach index.md, a module page or the decision ledger.
const SECRET_CONTENT = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key)\s*[:=]\s*)['"]?[^\s'",]{6,}/gi,
]

export function redact(text) {
  let out = String(text)
  for (const re of SECRET_CONTENT) out = out.replace(re, (m, p1) => `${p1 ?? ''}[redacted]`)
  return out
}

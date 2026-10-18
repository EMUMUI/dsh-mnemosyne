/**
 * Text primitives shared by learning, recall, and the working set.
 *
 * Everything here is deterministic and dependency-free so the store can be
 * rebuilt from the same inputs on any machine, and so tests can assert on exact
 * weights. Tokenisation is deliberately bilingual: ASCII identifiers become
 * whole words, CJK runs become overlapping bigrams (the standard cheap
 * approximation of Chinese segmentation), which is enough for ranking recall
 * candidates and for spotting near-duplicate memories.
 */

/** Marker prefixed to command turns (DSH hook injections) so they are not learned as prose. */
export const COMMAND_MARKER = 'The user sent a command:'

/** DSH-injected context blocks that must never be treated as the user's own words. */
const INJECTED_BLOCK_RES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
]

/** Stop words that carry no discriminative signal in either language. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our', 'out',
  'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two', 'way', 'who',
  'did', 'does', 'let', 'put', 'say', 'she', 'too', 'use', 'that', 'this', 'with', 'have', 'from',
  'they', 'will', 'would', 'there', 'their', 'what', 'when', 'make', 'like', 'just', 'into', 'than',
  'then', 'some', 'could', 'should', 'about', 'after', 'also', 'been', 'were', 'which', 'while',
  'please', 'thanks', 'okay', 'want', 'need', 'help', 'using', 'still', 'very', 'more', 'most',
  'the', 'and', '嗯', '啊', '吧', '呢', '了', '的', '是', '我', '你', '他', '她', '它', '我们', '你们',
  '一下', '一个', '这个', '那个', '可以', '然后', '就是', '现在', '还是', '不是', '没有', '什么',
  '怎么', '为什么', '因为', '所以', '但是', '如果', '已经', '需要', '应该', '不要', '只是', '这样',
])

/** ASCII / alphanumeric words of interest, including dotted identifiers and paths. */
const ASCII_WORD_RE = /[A-Za-z][A-Za-z0-9_.\-/]{1,}/g

/** CJK ideograph runs. */
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * Normalise raw text: strip injected blocks, collapse whitespace, trim.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  let out = typeof text === 'string' ? text : ''
  for (const re of INJECTED_BLOCK_RES) out = out.replace(re, ' ')
  return out.replace(/\r\n?/g, '\n').replace(/[ \t\u3000]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Lexical tokens used for scoring: lowercased ASCII words (≥2 chars, without
 * leading/trailing path punctuation) followed by CJK bigrams (unigrams for
 * single-character runs, trigrams for three-character runs).
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const source = typeof text === 'string' ? text : ''
  const tokens = []
  for (const match of source.matchAll(ASCII_WORD_RE)) {
    const word = match[0].toLowerCase().replace(/[.\-/]+$/, '').replace(/^[.\-/]+/, '')
    if (word.length >= 2 && !STOP_WORDS.has(word)) tokens.push(word)
  }
  for (const match of source.matchAll(CJK_RUN_RE)) {
    const run = match[0]
    if (run.length === 1) {
      if (!STOP_WORDS.has(run)) tokens.push(run)
      continue
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2)
      if (!STOP_WORDS.has(gram)) tokens.push(gram)
    }
  }
  return tokens
}

/**
 * Distinct token set of a text (order-independent).
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenSet(text) {
  return new Set(tokenize(text))
}

/**
 * Weighted token map: each distinct token with its in-text frequency, scaled so
 * that longer, rarer words matter more than common bigrams.
 * @param {string} text
 * @returns {Map<string, number>}
 */
export function termWeights(text) {
  const weights = new Map()
  for (const token of tokenize(text)) {
    weights.set(token, (weights.get(token) ?? 0) + 1)
  }
  return weights
}

/**
 * FNV-1a 32-bit hash as lowercase hex. Used for stable content ids, never for
 * security.
 * @param {string} text
 * @returns {string}
 */
export function hashText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  // Mix in the length so that prefix collisions are far less likely.
  hash ^= text.length
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Characters that mark an imperative, actionable instruction. */
const ACTION_WORDS = [
  '必须', '一定要', '以后', '下次', '总是', '永远', '记住', '别再', '不要再', '请务必', '禁止', '不要',
  '开始都', '每次都', '统一', '规则', '规范', '偏好', '习惯', 'always', 'never', 'must', 'remember',
  'prefer', 'don\'t', 'do not', 'from now on', 'instead', 'default', 'please always', 'rule',
]

/** Characters that mark a personal fact about the user. */
const IDENTITY_WORDS = [
  '我叫', '我是', '我的名字', '叫我', '我在', '我的', '我喜欢', '我讨厌', '我习惯', '我负责', '我从事',
  'my name', 'i am', 'i\'m', 'i work', 'i live', 'i like', 'i hate', 'i prefer', 'i use', 'my ',
]

/** Words that mark a correction — evidence a preference was revised. */
const CORRECTION_WORDS = [
  '不对', '不是', '错了', '改一下', '改成', '纠正', '应该是', '其实', '别', '不要再', '说过',
  'wrong', 'actually', 'instead', 'no,', 'not what', 'i said', 'again', 'fix that',
]

/** Four-character-plus CJK phrases are rare enough to indicate a proper noun or term. */
const CJK_TERM_RE = /[\u4e00-\u9fff]{4,}/g

/**
 * Estimate how memorable a statement is, 0..1.
 *
 * Mirrors human salience: explicit instructions and identity facts are learned
 * strongly on sight; corrections are emotionally charged; rare terms, numbers,
 * and code identifiers stand out; long rambling text is discounted.
 * @param {string} text
 * @param {{ kind?: 'memory' | 'preference' }=} hint - optional caller-declared kind.
 * @returns {number} salience in [0.05, 1]
 */
export function salience(text, hint) {
  const source = normalizeText(text)
  if (source === '') return 0
  const lower = source.toLowerCase()
  let score = 0.3
  if (ACTION_WORDS.some(word => lower.includes(word))) score += 0.32
  if (IDENTITY_WORDS.some(word => lower.includes(word))) score += 0.2
  if (CORRECTION_WORDS.some(word => lower.includes(word))) score += 0.08
  if (/(?:\d+(?:\.\d+)?%?)/.test(source)) score += 0.05
  if (/[`][^`]{2,}[`]|\b[A-Za-z][A-Za-z0-9_]*[._][A-Za-z0-9_]+\b/.test(source)) score += 0.06
  const terms = source.match(CJK_TERM_RE)
  if (terms !== null) score += Math.min(0.08, terms.length * 0.02)
  if (source.length > 400) score -= 0.12
  if (source.length < 6) score -= 0.1
  if (hint === 'preference') score = Math.max(score, 0.55)
  if (hint === 'memory') score = Math.max(score, 0.35)
  return Math.max(0.05, Math.min(1, Math.round(score * 100) / 100))
}

/**
 * Token-level Jaccard similarity of two texts, 0..1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared += 1
  return shared / (left.size + right.size - shared)
}

/**
 * Semantic subject of a preference statement, used to decide whether two
 * preferences talk about the same thing and therefore supersede each other.
 *
 * The heuristic takes the statement's distinctive terms (dropping pronouns,
 * auxiliaries and stop words) and keeps the leading ones, which is exactly the
 * "what is this about" part of sentences like "以后回复都用中文" or
 * "always answer in English".
 * @param {string} text
 * @returns {string} a stable subject key (may be empty for unfocused statements)
 */
export function subjectKey(text) {
  const terms = tokenize(normalizeText(text))
  // Prefer CJK bigrams and ASCII words: they carry the noun phrase.
  const keyed = terms.filter(token => token.length >= 2).slice(0, 4)
  return keyed.join(' ')
}

/**
 * Pick the most specific memories that overlap a candidate, highest overlap
 * first. Returns up to `limit` entries as `{ item, score }`.
 * @template T
 * @param {string} text
 * @param {T[]} items
 * @param {(item: T) => string} render
 * @param {number} limit
 * @returns {{ item: T, score: number }[]}
 */
export function nearest(text, items, render, limit = 1) {
  const scored = []
  for (const item of items) {
    const score = similarity(text, render(item))
    if (score > 0) scored.push({ item, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, limit)
}

/** Secret-looking substrings, replaced before anything is persisted. */
const SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s"',]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

/**
 * Redact obvious credentials so memory files never become a secret dump.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = typeof text === 'string' ? text : ''
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]')
  return out
}

/**
 * Bound text to `limit` characters, preferring to cut at a sentence boundary
 * near the end so excerpts read naturally.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clip(text, limit) {
  const source = typeof text === 'string' ? text.trim() : ''
  if (source.length <= limit) return source
  const head = source.slice(0, Math.max(0, limit - 1))
  const boundary = Math.max(head.lastIndexOf('。'), head.lastIndexOf('.'), head.lastIndexOf('！'),
    head.lastIndexOf('!'), head.lastIndexOf('？'), head.lastIndexOf('?'), head.lastIndexOf('\n'))
  const cut = boundary >= limit * 0.6 ? head.slice(0, boundary + 1) : head
  return `${cut.trimEnd()}…`
}

/**
 * One-line form of text for listings and the working set.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function oneLine(text, limit = 140) {
  return clip(String(text ?? '').replace(/\s+/g, ' ').trim(), limit)
}

/** How many entries a single turn may contribute (keeps a rant from flooding memory). */
export const MAX_ENTRIES_PER_TURN = 8

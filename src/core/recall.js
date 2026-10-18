/**
 * Selection and the working set.
 *
 * A brain that recalls everything is as useless as one that recalls nothing.
 * Two stages mirror the human split between *priming* (cheap, always-on,
 * contextual) and *explicit recall* (effortful, query-directed):
 *
 *  - **Working set** — assembled before every turn without being asked:
 *    standing preferences the user set, the most recent conversation activity,
 *    and memories that resonate with the current request. It is small, bounded,
 *    and cites item ids so the agent can act on it (and so feedback can be
 *    attributed).
 *
 *  - **Recall** — the `mnemosyne_recall` tool's job: an explicit search over
 *    every store at a high threshold, returning ranked items with their
 *    current retention.
 *
 * Scoring is deliberately transparent:
 *
 *   score = (0.55·relevance + 0.25·importance + 0.20·strength) · usage
 *
 * where relevance is weighted lexical overlap, importance is the item's
 * salience, strength is its decayed memory strength, and `usage` is a soft
 * penalty for over-recalling the same item (habituation) and a project filter.
 */

import { DEFAULT_RECALL_THRESHOLD, DEFAULT_RETRIEVAL_SCORE, round } from './decay.js'
import { retentionOf } from './store.js'
import { normalizeText, oneLine, similarity, termWeights, tokenize } from './text.js'

/** Weights of the score components; sum to 1. */
export const WEIGHTS = { relevance: 0.55, importance: 0.25, strength: 0.2 }

/** Query tokens are weighted by inverse frequency across candidates. */
function queryProfile(query) {
  const weights = new Map(termWeights(query))
  return weights
}

/**
 * Relevance of a candidate to a query in [0, 1].
 *
 * Weighted overlap (each query token counted at most once) normalised by the
 * query's own mass, plus a small bonus for exact substring containment of a
 * longer query fragment, which favours "this memory literally mentions it".
 * @param {Map<string, number>} profile
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
export function relevanceOf(profile, query, text) {
  if (profile.size === 0) return 0
  const candidate = new Set(tokenize(text))
  let matched = 0
  let total = 0
  for (const [token, weight] of profile) {
    total += weight
    if (candidate.has(token)) matched += weight
  }
  const overlap = total === 0 ? 0 : matched / total
  const condensed = normalizeText(query).replace(/\s+/g, '')
  const contained = condensed.length >= 4 && normalizeText(text).includes(condensed.slice(0, 24)) ? 0.12 : 0
  return Math.min(1, overlap + contained)
}

/**
 * Score every candidate against a query.
 *
 * @param {object[]} candidates
 * @param {string} query
 * @param {{ now?: number, tuning: object, project?: string, habituation?: Map<string, number> }} context
 * @returns {{ item: object, score: number, parts: object }[]}
 */
export function rank(candidates, query, context) {
  const now = context.now ?? Date.now()
  const tuning = context.tuning
  const profile = queryProfile(query)
  const windowDays = Math.max(1, tuning.halfLifeDays)
  const ranked = []
  for (const item of candidates) {
    if (item.discardedAt) continue
    if (item.supersededBy) continue
    // Project isolation: a memory learned in another project only shows up
    // when it is a global one.
    if (item.project && context.project && item.project !== context.project) continue
    const text = `${item.title} ${item.content} ${item.tags?.join(' ') ?? ''} ${item.key ?? ''}`
    const relevance = relevanceOf(profile, query, text)
    const remembered = retentionOf(item, now, tuning)
    const strength = Math.max(0.02, Number(item.strength) || 0) * remembered
    const importance = Number(item.salience) || 0.3
    const base = WEIGHTS.relevance * relevance + WEIGHTS.importance * importance
      + WEIGHTS.strength * Math.min(1, strength)
    // Habituation: an item pushed in the three preceding turns is damped, but
    // never hidden — it may be exactly the thing being discussed.
    const recent = context.habituation?.get(item.id) ?? 0
    const usage = 1 / (1 + 0.35 * recent)
    // Recency: a tiny nudge so two equally relevant items prefer the fresh one.
    const ageDays = Math.max(0, now - (item.lastSeenAt ?? item.createdAt ?? now)) / 86_400_000
    const freshness = 0.04 * Math.exp(-ageDays / windowDays)
    const score = (base * usage) + freshness
    ranked.push({
      item,
      score: round(score * 10),
      parts: { relevance: round(relevance), importance: round(importance), strength: round(strength), usage: round(usage) },
    })
  }
  ranked.sort((left, right) => right.score - left.score || String(left.item.id).localeCompare(String(right.item.id)))
  return ranked
}

/**
 * Choose the working set for a turn.
 *
 * @param {import('./store.js').Store} store
 * @param {{ query: string, project?: string, maxChars: number, recallMaxItems: number, recallMinScore: number, maxProfileEntries: number, retrievalScore?: number, habituation?: Map<string, number>, include: object }} options
 * @returns {{ items: {item: object, score: number, part: string}[], text: string, citations: object[] }}
 */
export function workingSet(store, options) {
  const now = store.now()
  const tuning = store.tuning
  const query = String(options.query ?? '')
  const project = options.project ?? ''
  const wants = options.include ?? {}
  const picked = []
  const seen = new Set()
  const push = (item, score, part) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    picked.push({ item, score: round(score), part })
  }

  // 1. Standing preferences: the user's own words outrank everything inferred,
  //    because a stated instruction is what "learning about you" is for.
  if (wants.preferences !== false) {
    const preferences = store.items('semantic')
      .filter(item => !item.supersededBy && (item.pinned || (item.salience ?? 0) >= 0.5))
      .sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
        || retentionOf(right, now, tuning) * right.strength - retentionOf(left, now, tuning) * left.strength
        || right.hits - left.hits)
      .slice(0, Math.max(0, options.maxProfileEntries ?? 12))
    for (const item of preferences) push(item, 10, 'preference')
  }

  // 2. Explicit commands that resonate with this request.
  if (wants.commands !== false && query.trim() !== '') {
    const commandHits = rank(store.items('commands'), query, { now, tuning, project, habituation: options.habituation })
      .filter(hit => hit.parts.relevance >= 0.3)
      .slice(0, 1)
    for (const hit of commandHits) {
      if (!seen.has(hit.item.id)) push(hit.item, hit.score / 10, 'command')
    }
  }

  // 3. Memory that resonates with the current request.
  if (wants.memories !== false && query.trim() !== '') {
    const candidates = store.items('all', { includeForgotten: wants.forgottenMemories === true })
      .filter(item => item.store !== 'commands')
      .filter(item => !(item.store === 'semantic' && !item.supersededBy))
    const hits = rank(candidates, query, { now, tuning, project, habituation: options.habituation })
      .filter(hit => hit.score >= (options.recallMinScore ?? DEFAULT_RECALL_THRESHOLD))
      .slice(0, Math.max(0, options.recallMaxItems ?? 4))
    for (const hit of hits) if (!seen.has(hit.item.id)) push(hit.item, hit.score / 10, 'memory')
  }

  // 4. Recent conversation activity (short-term memory carries the thread).
  if (wants.recent !== false) {
    const recent = []
    for (const entry of [...store.data.journal].reverse()) {
      if (recent.some(pick => pick.entry.oneLine === entry.oneLine)) continue
      recent.push({ entry })
      if (recent.length >= 3) break
    }
    for (const { entry } of recent) {
      push({
        id: `recent-${entry.at}`,
        store: 'journal',
        title: entry.oneLine,
        content: entry.oneLine,
        salience: 0.3,
        strength: 0.3,
        createdAt: entry.at,
      }, 0, 'recent')
    }
  }

  const text = renderWorkingSet(picked, options.maxChars ?? 2200)
  return {
    items: picked,
    text,
    citations: picked.map(entry => ({
      id: entry.item.id,
      store: entry.item.store,
      title: entry.item.title,
      part: entry.part,
      score: Math.round(entry.score * 100) / 100,
    })),
  }
}

/** Section headers in the injected block. */
const HEADERS = {
  preference: '【长期偏好 · 用户明确设定，优先遵守】',
  command: '【曾经成功的命令 · 相似任务可先参考】',
  memory: '【相关记忆 · 可能相关，仅供参考】',
  recent: '【最近对话脉络】',
  profile: '【关于用户】',
}

/**
 * Render the working set as the injected text. Bounded by `maxChars`; items
 * carry their id so the agent can recall, reinforce or forget them by id.
 * @param {{item: object, score: number, part: string}[]} picked
 * @param {number} maxChars
 * @returns {string}
 */
export function renderWorkingSet(picked, maxChars) {
  if (picked.length === 0) return ''
  const lines = [
    '<mnemosyne-memory>',
    '以下是你对这个用户的长期记忆（由 Mnemosyne 自动维护）。它不是用户本次说的话；',
    '与当前任务无关时请忽略，不要向用户复述本段，也不要说"根据我的记忆"。',
    '若记忆与用户当前要求冲突，以当前要求为准，并可用 mnemosyne_remember 更新记忆。',
  ]
  let budget = maxChars - lines.join('\n').length
  let currentPart = ''
  for (const entry of picked) {
    if (entry.part !== currentPart) {
      currentPart = entry.part
      const header = `\n${HEADERS[entry.part] ?? ''}`
      if (budget - header.length < 40) break
      lines.push(header)
      budget -= header.length
    }
    const content = entry.item.content
    const line = `- [${entry.item.id}] ${oneLine(content, entry.part === 'recent' ? 80 : 180)}`
    if (budget - line.length < 20) break
    lines.push(line)
    budget -= line.length
  }
  lines.push('</mnemosyne-memory>')
  return lines.join('\n')
}

/**
 * Explicit recall: a deep search across all stores.
 * @param {import('./store.js').Store} store
 * @param {string} query
 * @param {{ store?: string, limit?: number, includeForgotten?: boolean, project?: string, minScore?: number }} options
 * @returns {{ item: object, score: number, parts: object, retention: number }[]}
 */
export function recall(store, query, options = {}) {
  const now = store.now()
  const tuning = store.tuning
  const candidates = store.items(options.store ?? 'all', {
    includeForgotten: options.includeForgotten === true,
    includeDiscarded: options.includeDiscarded === true,
  })
  const ranked = rank(candidates, query, { now, tuning, project: options.project })
  const minScore = options.minScore ?? DEFAULT_RETRIEVAL_SCORE
  return ranked
    .filter(hit => hit.score >= minScore)
    .slice(0, Math.max(1, options.limit ?? 8))
    .map(hit => ({ ...hit, retention: round(retentionOf(hit.item, now, tuning)) }))
}

/**
 * Cheap relevance between a user complaint and the injected text, used by the
 * feedback loop to decide whether an injection was useless.
 * @param {string} complaint
 * @param {string} injected
 * @param {number} threshold
 * @returns {boolean}
 */
export function overlaps(complaint, injected, threshold = 0.08) {
  return similarity(complaint, injected) >= threshold
}

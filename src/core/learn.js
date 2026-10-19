/**
 * Learning: turning raw conversation into memories.
 *
 * Three channels, mirroring how a person learns during a work session:
 *
 *  1. **Long-term memory** — instructions, facts, decisions and lesson-like
 *     statements the user states explicitly. They become episodic/semantic
 *     items that are recalled later.
 *  2. **Preference model** — statements about *how the user wants work done*
 *     ("always reply in Chinese", "以后都用 pnpm", "don't add comments").
 *     Stored under a subject key so a later statement on the same subject
 *     supersedes the earlier one instead of piling up contradictions.
 *  3. **Command patterns** — successful shell commands the agent ran during a
 *     turn are remembered keyed by the user's goal, so a similar request next
 *     time starts from a command that already worked.
 *
 * Finally the feedback loop: when the user says the agent got it wrong, the
 * most recently injected memories that overlap the complaint are penalised
 * ("negative reinforcement"), so the same wrong habit fades.
 */

import {
  ACTION_PATTERNS, EXPLICIT_MEMORY_PATTERNS, FAILURE_MARKERS, PREFERENCE_PATTERNS,
  extractCommandFromUserText, matchPattern, subjectOf,
} from './patterns.js'
import { MERGE_SIMILARITY, round } from './decay.js'
import { MAX_ENTRIES_PER_TURN, clip, oneLine, redactSecrets, salience, similarity, tokenSet } from './text.js'
import { COMMAND_MARKER } from './text.js'

/** Upper bound on the size of a single learned command. */
const MAX_COMMAND_CHARS = 300

/**
 * Split a user message into sentences/segments that can each become a memory.
 * Newlines, full stops, semicolons and "然后/并且" style conjunctions are all
 * boundaries a person would use when parsing their own request.
 * @param {string} text
 * @returns {string[]}
 */
export function segments(text) {
  return String(text ?? '')
    .split(/\n+/)
    .flatMap(line => line.split(/(?<=[。！？!?;；])\s*/))
    .map(segment => segment.trim())
    .filter(segment => segment.length >= 4)
}

/**
 * Extract learnable memories and preferences from one user message.
 *
 * The same text can yield both: "以后都用中文回答，另外我们项目是 Vue 3" is a
 * preference *and* a fact. Deduplication across the two channels happens by
 * content similarity in the caller.
 *
 * @param {string} text - normalised user text.
 * @param {{ privacyMode?: string, excerptChars?: number, redactSecrets?: boolean, maxEntries?: number }=} options
 * @returns {{ memories: object[], preferences: object[], command: string | null, hasStrongSignal: boolean }}
 */
export function extractLearning(text, options = {}) {
  const privacyMode = options.privacyMode ?? 'excerpt'
  const excerptChars = options.excerptChars ?? 160
  const doRedact = options.redactSecrets !== false
  const maxEntries = options.maxEntries ?? MAX_ENTRIES_PER_TURN
  const memories = []
  const preferences = []

  const command = extractCommandFromUserText(text)
  if (command !== null) return { memories, preferences, command, hasStrongSignal: true }

  const seen = new Set()
  for (const segment of segments(text)) {
    if (memories.length + preferences.length >= maxEntries) break
    const cleaned = segment.replace(/^[-*•\d.\s]+/, '').trim()
    if (cleaned.length < 6) continue

    const preferenceHit = matchPattern(cleaned, PREFERENCE_PATTERNS)
    const explicitHit = matchPattern(cleaned, EXPLICIT_MEMORY_PATTERNS)
    const actionHit = matchPattern(cleaned, ACTION_PATTERNS)
    if (preferenceHit === null && explicitHit === null && actionHit === null) continue

    // A correction is a sentence about the conversation ("不对，…"); what is
    // worth keeping is the rule inside it, so the conversational prefix goes.
    // Corrections are recognised by their lead-in, whether or not the rest of
    // the sentence also matched a preference family.
    const isCorrective = preferenceHit?.category === 'correction'
      || actionHit?.category === 'correction'
      || CORRECTION_PREFIX_RE.test(cleaned)
    const subject = isCorrective
      ? cleaned.replace(CORRECTION_PREFIX_RE, '').trim() || cleaned
      : cleaned

    const content = privacyMode === 'excerpt-free'
      ? clip(oneLine(subject, 200), 200)
      : privacyMode === 'full'
        ? clip(subject, 2000)
        : clip(subject, excerptChars)
    const safeContent = doRedact ? redactSecrets(content) : content
    const dedupKey = [...tokenSet(safeContent)].sort().join(' ').slice(0, 200)
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const hit = preferenceHit ?? explicitHit ?? actionHit
    const item = {
      content: safeContent,
      title: oneLine(safeContent, 72),
      tags: [hit.category, ...(explicitHit !== null && preferenceHit !== null ? ['fact'] : [])],
      salience: salience(safeContent, preferenceHit !== null ? 'preference' : 'memory'),
      corrective: isCorrective,
    }
    // The key is derived from the statement, not from the prefix that was
    // stripped, so a correction lands on the subject it actually corrects.
    if (preferenceHit !== null) preferences.push({ ...item, key: subjectOf(safeContent) })
    else memories.push(item)
  }

  return {
    memories,
    preferences,
    command: null,
    hasStrongSignal: memories.length > 0 || preferences.length > 0,
  }
}

/** Conversational lead-ins that precede a correction, not part of the rule. */
const CORRECTION_PREFIX_RE = /^\s*(?:不对|错了|不是这样|不是这个意思|搞错了|弄错了|说错了|改一下|改成|纠正一下|重新来|no[,，]?\s*|that'?s wrong[,，]?\s*|wrong[,，]?\s*)[,，、:：\s]*/i

/**
 * Detect that the user is telling the agent it got something wrong.
 * @param {string} text
 * @returns {boolean}
 */
export function isCorrection(text) {
  const hit = matchPattern(String(text ?? ''), PREFERENCE_PATTERNS.filter(pattern => pattern.category === 'correction'))
    ?? matchPattern(String(text ?? ''), ACTION_PATTERNS.filter(pattern => pattern.category === 'correction'))
  return hit !== null || FAILURE_MARKERS.some(marker => String(text ?? '').includes(marker))
}

/**
 * Learn from one completed turn.
 *
 * @param {import('./store.js').Store} store
 * @param {object} turn - the observed turn assembled by the host layer.
 * @param {object} config - normalised plugin config.
 * @returns {{ learned: string[], preference: object|null, conflict: object|null, correction: number }}
 */
export function learnFromTurn(store, turn, config) {
  const now = store.now()
  const learned = []
  let preference = null
  let conflict = null

  const userText = String(turn.user ?? '')
  if (userText === '' || (turn.command === true && config.captureCommandTurns !== true)) {
    return { learned, preference, conflict, correction: 0 }
  }
  const extraction = extractLearning(userText, {
    privacyMode: config.privacyMode,
    excerptChars: config.excerptChars,
    redactSecrets: config.redactSecrets,
  })
  const project = config.perProjectPreferences ? (turn.cwd ?? '') : ''

  for (const memory of extraction.memories) {
    const result = store.remember('episodic', {
      ...memory,
      source: 'user-turn',
      sessionId: turn.sessionId,
      project,
    })
    if (result.action === 'created' || result.action === 'merged') learned.push(result.item.title)
  }
  for (const pref of extraction.preferences) {
    const result = store.remember('semantic', {
      ...pref,
      key: pref.key,
      source: 'user-turn',
      sessionId: turn.sessionId,
      project,
    })
    if (result.action === 'created' || result.action === 'superseded') {
      preference = result.item
      learned.push(result.item.title)
    }
    if (result.action === 'superseded') conflict = result.item
  }

  // Commands that succeeded during the turn become patterns keyed by the goal.
  for (const call of turn.toolCalls ?? []) {
    if (call.name !== 'bash' && call.name !== 'pwsh') continue
    const outcome = turn.toolOutcomes?.get(call.name)
    if (outcome?.ok !== true) continue
    const command = oneLine(String(call.args?.command ?? call.args?.script ?? ''), MAX_COMMAND_CHARS)
    if (command === '' || command.length < 3) continue
    if (TOOL_NOISE.test(command)) continue
    store.remember('commands', {
      content: command,
      title: `命令：${oneLine(command, 60)}`,
      key: subjectOf(userText),
      tags: ['command', call.name],
      source: 'tool-success',
      sessionId: turn.sessionId,
      project: turn.cwd ?? '',
      salience: 0.45,
      strength: 0.5,
    })
  }

  // Negative reinforcement: a complaint inside a turn weakens whatever the
  // working set had just pushed, when the complaint overlaps its content. The
  // citation list is the overlap context captured at injection time.
  let correction = 0
  const cited = Array.isArray(turn.injected) ? turn.injected : []
  if (cited.length === 0) {
    const remembered = (store.data.lastInjection ?? [])
      .map(id => store.find(id, { includeForgotten: true }))
      .filter(Boolean)
    cited.push(...remembered)
  }
  if (isCorrection(userText) && cited.length > 0) {
    const complaint = oneLine(userText, 300)
    for (const item of cited) {
      const overlap = similarity(complaint, `${item.title} ${item.content}`)
      if (overlap < 0.05) continue
      const target = store.find(item.id, { includeForgotten: true })
      if (target === undefined) continue
      store.penalizeItem(target, 0.45, now, 'correction')
      correction += 1
    }
    if (correction > 0) store.data.stats.conflicts += 1
  } else if (FAILURE_MARKERS.some(marker => oneLine(userText, 400).includes(marker))) {
    correction = -1 // failure without any attributed memory: counted, not punished
  }

  if (turn.sessionId) store.data.lastSeenSession = turn.sessionId
  store.journalTurn({
    at: now,
    oneLine: redactSecrets(oneLine(userText, 120)),
    cwd: turn.cwd,
    sessionId: turn.sessionId,
    turn: turn.turn,
    models: turn.models ?? [],
    preference: preference !== null,
    // Only the host knows whether it is being called twice for one turn; a
    // direct caller (tests, scripts) is never deduplicated.
    dedupe: turn.dedupe === true,
  })
  store.touch()
  return { learned, preference, conflict, correction }
}

/** Commands that say more about the harness than about the problem at hand. */
const TOOL_NOISE = /^(cd |pwd$|echo |ls$|dir$|type |cat )/

/**
 * Predict which stored command patterns match a new request, best first.
 * @param {import('./store.js').Store} store
 * @param {string} goal
 * @param {number} limit
 * @returns {{ item: object, score: number }[]}
 */
export function predictCommands(store, goal, limit = 3) {
  const scored = []
  for (const item of store.items('commands')) {
    if (item.supersededBy) continue
    const score = similarity(goal, `${item.key} ${item.content}`)
    if (score >= 0.22) scored.push({ item, score: round(score) })
  }
  scored.sort((left, right) => right.score - left.score)
  return scored.slice(0, limit)
}

/**
 * Find memories that overlap a statement and are close enough to be the same
 * thing (used by tools to avoid creating duplicates).
 * @param {import('./store.js').Store} store
 * @param {string} content
 * @returns {object | null}
 */
export function nearDuplicate(store, content) {
  let best = null
  for (const item of store.items('all')) {
    if (item.supersededBy) continue
    const score = similarity(content, item.content)
    if (score >= MERGE_SIMILARITY && (best === null || score > best.score)) best = { item, score }
  }
  return best?.item ?? null
}

export { COMMAND_MARKER }

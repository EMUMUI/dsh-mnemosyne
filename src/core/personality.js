/**
 * Personality: how the assistant's own character grows from use, while the
 * user keeps the last word.
 *
 * The design follows three rules, in priority order:
 *
 *  1. **The user always decides.** Every trait has a state the user can pin,
 *     freeze or erase, and a disagreement the user settles by decision becomes
 *     a `userDecided` trait that grows does not touch.
 *  2. **Character grows slowly and cannot run away.** Traits compound with
 *     diminishing returns inside hard bounds; a single turn moves a trait by at
 *     most one step. Nothing here starts until there is evidence.
 *  3. **It must be able to disagree, but it must wait.** A `challenge` is a
 *     question put back to the user, never a refusal. The user's answer decides
 *     whether the habit firms up, softens, or becomes a standing rule.
 *
 * What makes this different from a feedback-follower: being corrected is not
 * the same as being challenged and overruled. A correction means "you got it
 * wrong" and makes the related habit weaker. An overruled challenge means "you
 * disagreed, I decided" — that is not a failure of the assistant's judgement,
 * so it must not train the assistant to stop disagreeing. The two are
 * classified separately (`classifyReply`) precisely so that one cannot
 * masquerade as the other.
 */

import { round } from './decay.js'

/** Human-readable trait identities. `key` is what the store holds. */
export const TRAITS = {
  directness: {
    label: '直言',
    zh: '有话直说，少铺垫',
    en: 'state the point plainly with little preamble',
  },
  caution: {
    label: '谨慎',
    zh: '不确定就说不确定，先确认再动手',
    en: 'say what is uncertain and confirm before acting',
  },
  skepticism: {
    label: '质疑',
    zh: '发现前提有问题时先指出来，再问是否继续',
    en: 'raise a broken premise and ask before proceeding',
  },
  depth: {
    label: '深究',
    zh: '追根溯源，讲清为什么',
    en: 'explain the why and trace causes',
  },
  brevity: {
    label: '精简',
    zh: '话少，先结论后细节',
    en: 'answer briefly, conclusion first',
  },
  warmth: {
    label: '亲和',
    zh: '多给一点解释和情绪上的照顾',
    en: 'offer more context and a warmer tone',
  },
  initiative: {
    label: '主动',
    zh: '能自己做的小决定先做了再说',
    en: 'take small decisions on its own and report after',
  },
}

/** Every trait value lives in [0, 1]. */
const BOUNDS = [0.02, 0.98]

/** One turn moves a trait by this much at most. */
const STEP = 0.06

/** Evidence needed before a trait may be described as character at all. */
const MIN_EVIDENCE = 3

/**
 * Trait states, most authoritative first.
 *
 * `locked`   — the user froze it; growth never touches it again.
 * `decided`  — the user settled a disagreement; growth never touches it.
 * `wanted`   — the user asked for it explicitly; growth may reinforce it.
 * `shown`    — observed, not yet measured.
 * `learned`  — the default: grown from outcomes, still moving.
 */
const USER_STATES = new Set(['locked', 'decided', 'wanted'])

/** Default character before any evidence: plain, careful, willing to speak up. */
const DEFAULTS = {
  directness: 0.55,
  caution: 0.5,
  skepticism: 0.5,
  depth: 0.45,
  brevity: 0.45,
  warmth: 0.4,
  initiative: 0.4,
}

/**
 * Words that betray a standing request for a trait, not a one-off.
 * @type {Array<[RegExp, string, number]>}
 */
const ASK_PATTERNS = [
  [/(?:以后|今后|每次|总是|一直).{0,6}(?:直接|别绕|少废话|就事论事|别客套)/, 'directness', 0.7],
  [/(?:直接|直说|别绕弯|少废话|别客套|就事论事)/, 'directness', 0.4],
  [/(?:不确定|没把握|拿不准).{0,8}(?:就|要).{0,6}(?:说|问|确认)/, 'caution', 0.7],
  [/(?:先问|先确认|别乱猜|不要猜|拿不准就问)/, 'caution', 0.6],
  [/(?:质疑|异议|不同意见|反对意见|指出问题|打断我)/, 'skepticism', 0.7],
  [/(?:我觉得不对|这样不行|有问题吧|是不是有问题).{0,10}(?:就|要)?(?:说|指出|提醒)/, 'skepticism', 0.6],
  [/(?:讲清楚|说清楚|详细|展开讲|多说点|为什么)/, 'depth', 0.4],
  [/(?:简洁|精简|简短|少说|别啰嗦|一句话)/, 'brevity', 0.6],
  [/(?:客气|温柔|友好|鼓励|多鼓励)/, 'warmth', 0.6],
  [/(?:自己决定|别问我|你看着办|自作主张|直接做)/, 'initiative', 0.6],
]

/** Markers that the user is overruling the assistant's objection. */
const OVERRULE_MARKERS = [
  '我意已决', '我决定了', '就按我说的', '按我的来', '别说了', '不用争了', '坚持原方案',
  '我就这么干', '我知道风险', '我有数', '我就要这样', '不必再劝', '我确认过了',
  '还是按原计划', '我就选这个', '听我的',
]

/** Markers that the user accepted the objection. */
const ACCEPT_MARKERS = [
  '有道理', '你说得对', '确实有问题', '你说的问题', '那我改', '重新想想', '我再想想',
  '提醒得对', '差点出事', '还好你说了', '那就按你说的', '我改主意了', '同意你的',
]

/** Markers pointing at a failed factual claim (the hallucination case). */
const HALLUCINATION_MARKERS = [
  '不存在', '没有这个', '哪来的', '胡说', '编的', '你哪看的', '查无此', '根本没',
  '假消息', '你是不是记错', '记错了', '让我查证', '这不对吧', '你确定吗',
]

/** What may not happen for a challenge to be considered: dismissal. */
const DISMISS_MARKERS = ['不用管', '别管了', '不重要', '无所谓', '跳过', '先说别的']

/**
 * Classify the user's reply to a turn that ended in a challenge.
 *
 * The distinction this exists for: `overruled` is a legitimate decision, not a
 * mistake, so it must not be fed into the same channel as `corrected`.
 * @param {string} text
 * @returns {'accepted' | 'overruled' | 'disputed' | 'corrected' | 'dismissed' | 'neutral' | 'silent'}
 */
export function classifyReply(text) {
  const source = String(text ?? '').trim()
  if (source === '') return 'silent'
  const has = markers => markers.some(marker => source.includes(marker))
  if (has(HALLUCINATION_MARKERS)) return 'corrected'
  if (has(OVERRULE_MARKERS)) return 'overruled'
  if (has(ACCEPT_MARKERS)) return 'accepted'
  if (has(DISMISS_MARKERS)) return 'dismissed'
  // A bare "不对" is ambiguous under a challenge: it may mean "your objection is
  // wrong" (disputed) rather than "your answer is wrong" (corrected). It is only
  // read as a decision on the objection when there is nothing pointing at a
  // fact — a sentence that names something specific ("这个 API""v3 里") is about
  // the content, not about the objection, so it is a correction.
  if (/\b(?:API|v\d|函数|字段|版本|参数|文档|报错|命令|接口)\b|已经删|没有这个|不存在/.test(source)
    || /(?:已经|早就)(?:删|改|去掉|废弃)/.test(source)) {
    return 'corrected'
  }
  if (/不对|不是这样|没有吧|没这回事|你想多了|哪有/.test(source)) return 'disputed'
  return 'neutral'
}

/** A standing request for a trait, if the user just made one. */
export function detectsTraitRequest(text) {
  const source = String(text ?? '')
  if (source.trim() === '') return null
  for (const [regex, key, amount] of ASK_PATTERNS) {
    regex.lastIndex = 0
    if (regex.test(source) && key in TRAITS) return { key, amount }
  }
  return null
}

/** One trait's record, created lazily so old brain files keep loading. */
function traitOf(store, key) {
  store.data.personality ??= { traits: {}, challenges: [], decided: [], version: 1 }
  store.data.personality.traits ??= {}
  const traits = store.data.personality.traits
  traits[key] ??= {
    // `learned` grows; `wanted` was asked for; `locked`/`decided` are the user's.
    state: 'learned',
    value: DEFAULTS[key] ?? 0.5,
    evidence: 0,
    // accepted challenges - overruled ones; can be negative
    challengeNet: 0,
    lastChangeAt: 0,
  }
  return traits[key]
}

/** Whether the user's own decision owns this trait (growth must keep out). */
export function isUserOwned(trait) {
  return USER_STATES.has(trait?.state)
}

/**
 * Move one trait by at most one step, inside bounds.
 * @returns {number} the amount actually moved (0 when clamped or user-owned)
 */
function nudge(store, key, delta, now) {
  const trait = traitOf(store, key)
  if (isUserOwned(trait) && trait.state !== 'wanted') return 0
  const bounded = Math.max(-STEP, Math.min(STEP, delta))
  const next = round(Math.max(BOUNDS[0], Math.min(BOUNDS[1], trait.value + bounded)))
  const moved = next - trait.value
  if (moved !== 0) {
    trait.value = next
    trait.lastChangeAt = now
  }
  return moved
}

/**
 * Fold one turn into the character.
 *
 * Every channel is evidence-weighted and small: a single good turn does not
 * create a personality, and a single correction does not erase one.
 *
 * @param {object} store
 * @param {{ kind: string, text?: string, challenge?: object|null }} reply
 *   `kind` comes from `classifyReply`; `challenge` is what was put to the user.
 * @returns {{ changes: Array<{key: string, delta: number, reason: string}> }}
 */
export function learnCharacter(store, reply) {
  const now = store.now()
  const changes = []
  const record = (key, delta, reason) => {
    const moved = nudge(store, key, delta, now)
    if (moved !== 0) changes.push({ key, delta: moved, reason })
    if (key in TRAITS) {
      const trait = traitOf(store, key)
      trait.evidence += 1
      store.touch()
    }
  }

  switch (reply.kind) {
    case 'accepted':
      // The user said the objection was right: the habit of speaking up paid off.
      record('skepticism', STEP, '质疑被采纳')
      record('caution', STEP / 2, '质疑被采纳，更有理由先确认')
      bumpChallenge(store, reply.challenge, +1, now)
      break
    case 'overruled':
      // A legitimate decision. The assistant keeps its view; it does not learn
      // to keep quiet, and it records the user's call.
      record('skepticism', STEP / 3, '质疑被驳回，但继续保留自己的判断')
      record('directness', STEP / 2, '分歧由用户裁决')
      bumpChallenge(store, reply.challenge, -1, now)
      decide(store, reply.challenge, 'overruled', now, reply.text)
      break
    case 'disputed':
      // The user says the objection itself was wrong: the habit misfired.
      record('skepticism', -STEP, '质疑本身不成立')
      bumpChallenge(store, reply.challenge, -1, now)
      break
    case 'corrected':
      // A failed claim. This is the hallucination channel: be more careful,
      // and stop asserting this kind of thing so confidently.
      record('caution', STEP, '被指出事实上出错')
      record('skepticism', -STEP / 3, '过度断言后更谨慎表达')
      break
    case 'dismissed':
      record('brevity', STEP / 2, '用户希望少纠缠')
      break
    default:
      break
  }

  if (changes.length > 0) {
    store.data.personality.lastUpdateAt = now
    for (const change of changes) store.addEvent(now, 'character', `${change.key} ${change.reason}`)
  }
  store.touch()
  return { changes }
}

/** Record one challenge so its outcome can be attributed later. */
export function bumpChallenge(store, challenge, delta, now) {
  const personality = store.data.personality
  if (personality === undefined || challenge == null) return
  const trait = challenge.trait in TRAITS ? challenge.trait : 'skepticism'
  const record = traitOf(store, trait)
  record.challengeNet += delta
  personality.challenges.push({
    at: now,
    topic: String(challenge.topic ?? '').slice(0, 160),
    trait,
    delta,
  })
  // The challenge log is an audit trail, not a memory: keep it short.
  if (personality.challenges.length > 60) personality.challenges.splice(0, personality.challenges.length - 60)
}

/**
 * Turn a settled disagreement into a user decision the character cannot undo.
 * @param {object} store
 * @param {{ topic?: string, subject?: string } | null} challenge - the objection, when one was logged
 * @param {string} stance
 * @param {number} now
 * @param {string} [fallback] - the user's own words, used when no objection was
 *   logged, so a decision always carries something that identifies it
 */
export function decide(store, challenge, stance, now, fallback = '') {
  const personality = store.data.personality
  if (personality === undefined) return
  personality.decided ??= []
  const topic = String(challenge?.topic ?? '').trim() || String(fallback ?? '').trim().slice(0, 160)
  personality.decided.push({
    at: now,
    topic,
    subject: String(challenge?.subject ?? '').slice(0, 120),
    stance,
  })
  if (personality.decided.length > 40) personality.decided.splice(0, personality.decided.length - 40)
}

/**
 * The user's own levers. These are the only paths that may override growth.
 *
 * - `set` with `state: 'wanted'` asks for more of a trait.
 * - `set` with `state: 'locked'` freezes the current value; growth stops.
 * - `set` with `state: 'learned'` hands it back to growth.
 * - `erase` forgets everything learned about one trait (back to the default).
 * @param {object} store
 * @param {{ action: 'set'|'erase'|'decide', key?: string, value?: number, state?: string, topic?: string }} input
 * @returns {{ ok: boolean, key?: string, value?: number, state?: string, error?: string }}
 */
export function manage(store, input) {
  const now = store.now()
  const action = String(input.action ?? 'set')
  const key = String(input.key ?? '')

  if (action === 'erase') {
    if (!(key in TRAITS)) return { ok: false, error: `未知的性格维度：${key}` }
    store.data.personality.traits[key] = {
      state: 'learned', value: DEFAULTS[key], evidence: 0, challengeNet: 0, lastChangeAt: now,
    }
    store.touch()
    return { ok: true, key, value: DEFAULTS[key], state: 'learned' }
  }

  if (action === 'decide') {
    decide(store, { topic: input.topic }, 'user', now)
    store.touch()
    return { ok: true, topic: String(input.topic ?? '') }
  }

  if (!(key in TRAITS)) return { ok: false, error: `未知的性格维度：${key}` }
  const trait = traitOf(store, key)
  if (typeof input.value === 'number' && Number.isFinite(input.value)) {
    trait.value = round(Math.max(BOUNDS[0], Math.min(BOUNDS[1], input.value)))
  }
  const state = String(input.state ?? '')
  if (state !== '') {
    if (!['learned', 'wanted', 'locked', 'decided'].includes(state)) return { ok: false, error: `未知状态：${state}` }
    trait.state = state
  }
  trait.lastChangeAt = now
  store.touch()
  return { ok: true, key, value: trait.value, state: trait.state }
}

/**
 * Explain one trait in the user's terms: what it is, where it stands, and who
 * owns it. Values below the evidence floor are reported as "尚未成型" rather
 * than as a character this assistant does not yet have.
 */
export function describeTrait(key, trait) {
  const meta = TRAITS[key] ?? { label: key, zh: key }
  const state = trait?.state ?? 'learned'
  const value = trait?.value ?? DEFAULTS[key] ?? 0.5
  const evidence = trait?.evidence ?? 0
  const stance = value >= 0.7 ? '明显' : value >= 0.55 ? '偏向' : value > 0.45 ? '中性' : '克制'
  const owner = state === 'locked' ? '你已锁定'
    : state === 'decided' ? '你已裁决'
      : state === 'wanted' ? '你指定要'
        : evidence < MIN_EVIDENCE ? '仍在形成' : '自己长出来的'
  return {
    key,
    label: meta.label,
    description: meta.zh,
    value: round(value),
    state,
    evidence,
    owner,
    stance: evidence < MIN_EVIDENCE ? '尚未成型' : stance,
  }
}

/** The whole character, user-owned traits first so they read as decisions. */
export function character(store) {
  const traits = store.data.personality?.traits ?? {}
  const keys = Object.keys(TRAITS)
  const described = keys.map(key => describeTrait(key, traits[key]))
  const rank = trait => (trait.state === 'locked' ? 0 : trait.state === 'decided' ? 1 : trait.state === 'wanted' ? 2 : 3)
  described.sort((left, right) => rank(left) - rank(right))
  return {
    traits: described,
    challenges: (store.data.personality?.challenges ?? []).slice(-10).reverse(),
    decided: (store.data.personality?.decided ?? []).slice(-10).reverse(),
    lastUpdateAt: store.data.personality?.lastUpdateAt ?? 0,
  }
}

/**
 * Render the character for the system prompt.
 *
 * Only traits with real evidence appear, phrased as habits rather than
 * identically-restated rules, so the assistant keeps room to make judgement
 * calls instead of performing a caricature.
 * @param {object} store
 * @returns {string}
 */
export function renderCharacter(store) {
  const traits = store.data.personality?.traits ?? {}
  const established = []
  const wanted = []
  for (const key of Object.keys(TRAITS)) {
    const trait = traits[key]
    if (trait === undefined) continue
    if (trait.state === 'locked' || trait.state === 'decided') {
      established.push(`${TRAITS[key].label}：${TRAITS[key].zh}`)
    } else if (trait.state === 'wanted') {
      wanted.push(`${TRAITS[key].label}：${TRAITS[key].zh}`)
    } else if (trait.evidence >= MIN_EVIDENCE && trait.value >= 0.6) {
      established.push(`${TRAITS[key].label}：${TRAITS[key].zh}`)
    }
  }
  if (established.length === 0 && wanted.length === 0) return ''

  const lines = [
    '## 你的性格（随使用形成，用户可随时改变）',
  ]
  if (established.length > 0) lines.push(`- 已经养成：${established.join('；')}。`)
  if (wanted.length > 0) lines.push(`- 用户要求你：${wanted.join('；')}。`)
  lines.push(
    '- 这是倾向，不是表演：与当前任务冲突时以任务为准，不要为了显得有个性而加戏。',
    '- 你可以保留自己的判断。发现用户的前提有问题、或可能判断错了，先指出来并问一句，而不是闷头执行或直接拒绝。',
    '- 分歧由用户决定：用户明确拍板后，不再重复争论，按他的决定执行；这条决定会记下来，你的性格成长不会再覆盖它。',
    '- 如果你发现自己可能记错或编造了什么，直接说不确定，不要用自信的语气掩盖。',
  )
  return lines.join('\n')
}

/** Clamp helper re-exported for tests that assert bounds. */
export const personalityBounds = { min: BOUNDS[0], max: BOUNDS[1], step: STEP, minEvidence: MIN_EVIDENCE }

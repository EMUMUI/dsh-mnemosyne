/**
 * Host-side wiring of Mnemosyne to one DSH agent.
 *
 * Responsibilities, one per concern:
 *
 *   session/event      observe turns — user text, assistant text, tool calls and
 *                      their outcomes — and learn from each completed turn.
 *   agent/pre-step     build the working set for the turn's first step and hand
 *                      it to the model as a logged, attributed user message.
 *   agent/session-start
 *                      absorb the first turn (session-start precedes it) and
 *                      flush anything pending into the brain.
 *   tools              register the ten model-facing verbs (tools.js).
 *   systemPrompt       a short standing section telling the model what the
 *                      memory is and when to use it.
 *
 * Hard rule: memory must never break a conversation. Every listener body is
 * wrapped so a failure is logged (debug only) and the decision passes through
 * unchanged.
 */

import { createHash } from 'node:crypto'

import { normalizeText } from '../src/core/text.js'
import { classifyFollowUp } from '../src/core/self.js'
import { classifyReply } from '../src/core/personality.js'
import { formatStatus, renderBlock, userTextOf } from './render.js'

/** The source kind every injected message carries (the GUI labels it by this). */
export const SOURCE_KIND = 'plugin:mnemosyne'

/** Turns injected per session, for the habituation map. */
const HABITUATION_WINDOW = 3

/**
 * Per-agent bookkeeping for one live session.
 */
class SessionState {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.turn = 0
    this.user = ''
    this.command = false
    this.models = new Set()
    this.toolCalls = []
    this.toolOutcomes = new Map()
    this.lastAssistant = ''
    this.injected = []
    this.injectionText = ''
    this.injectionSignature = ''
    this.habituation = new Map()
    this.pendingFollowUp = null
    /** The objection put to the user during this turn, if any. */
    this.pendingChallenge = null
    this.lastOutcome = ''
    this.turnStartAt = 0
    this.cwd = ''
    this.pendingSelfTune = false
  }
}

/**
 * Create the project's short, stable label (the working directory's basename).
 * @param {string|undefined} cwd
 * @returns {string}
 */
export function projectOf(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Everything DSH-specific about Mnemosyne for one loaded plugin instance.
 */
export class Host {
  /**
   * @param {object} options
   * @param {import('../src/brain.js').Brain} options.brain
   * @param {object} options.config - normalised config
   * @param {(message: string) => void} options.log
   * @param {(message: string) => void} options.warn
   */
  constructor(options) {
    this.brain = options.brain
    this.config = options.config
    this.log = options.log ?? (() => {})
    this.warn = options.warn ?? (() => {})
    this.sessions = new Map()
    this.turnsSinceFlush = 0
    this.pendingSelfTune = false
    this.timer = null
    this.closed = false
  }

  /** Attach the DSH listeners. Disposers are owned by the calling effect. */
  attach(ctx) {
    this.ctx = ctx
    ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
    this.startIdleFlush()
  }

  /** Stop timers and persist. */
  dispose() {
    this.closed = true
    this.stopIdleFlush()
    for (const state of this.sessions.values()) this.flushTurn(state, 'dispose')
    this.sessions.clear()
    try { this.brain.save() } catch (error) { this.warn(`final save failed: ${error?.message ?? error}`) }
  }

  /**
   * Session event observer: turn bookkeeping and per-turn learning.
   * @param {object} session
   * @param {object} event
   */
  onSessionEvent(session, event) {
    try {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || event === null || typeof event !== 'object') return
      switch (event.type) {
        case 'turn/start': {
          const state = this.stateOf(sessionId)
          if (state.turn > 0 && state.user !== '') this.finaliseTurn(state)
          const announced = Number(event.data?.turn)
          state.turn = Number.isFinite(announced) && announced > 0 ? announced : state.turn + 1
          state.user = ''
          state.command = false
          state.models = new Set()
          state.toolCalls = []
          state.toolOutcomes = new Map()
          state.lastAssistant = ''
          state.injected = []
          state.injectionText = ''
          state.turnStartAt = Date.now()
          state.cwd = session?.header?.cwd ?? state.cwd
          return
        }
        case 'user/message': {
          const state = this.stateOf(sessionId)
          const message = event.data
          if (message?.source?.kind !== 'user') return
          const text = normalizeText(userTextOf(message))
          if (text === '') return
          state.user = text
          state.command = isCommandTurn(message)
          return
        }
        case 'assistant/message': {
          const state = this.stateOf(sessionId)
          const message = event.data?.message
          state.models.add(String(message?.source?.model ?? ''))
          const body = assistantTextOf(message)
          if (body !== '') state.lastAssistant = body
          return
        }
        case 'tool/call': {
          const state = this.stateOf(sessionId)
          const name = String(event.data?.name ?? '')
          let args = {}
          try { args = JSON.parse(String(event.data?.arguments ?? '{}')) } catch { args = {} }
          state.toolCalls.push({ name, args, callId: String(event.data?.callId ?? '') })
          if (state.toolCalls.length > 80) state.toolCalls.shift()
          return
        }
        case 'tool/result': {
          const state = this.stateOf(sessionId)
          const callId = String(event.data?.message?.content?.[0]?.toolCallId ?? '')
          const isError = event.data?.message?.content?.[0]?.isError === true
          const call = state.toolCalls.find(entry => entry.callId === callId) ?? state.toolCalls.at(-1)
          if (call !== undefined) state.toolOutcomes.set(call.name, { ok: !isError })
          return
        }
        case 'turn/end': {
          const state = this.stateOf(sessionId)
          this.finaliseTurn(state)
          this.turnsSinceFlush += 1
          try { this.brain.save() } catch (error) { this.warn(`save failed: ${error?.message ?? error}`) }
          this.maybeConsolidate()
          return
        }
        default:
      }
    } catch (error) {
      this.debug(`session/event ${event?.type}: ${error?.message ?? error}`)
    }
  }

  /**
   * Learn from and close the current turn.
   * @param {SessionState} state
   */
  finaliseTurn(state) {
    // Idempotent by construction: folding the observations into the store
    // *resets* them, so a second sighting of the same turn has nothing left to
    // learn and cannot journal the turn twice.
    if (state.user === '' && state.toolCalls.length === 0) return
    try {
      this.finaliseTurnUnsafe(state)
    } catch (error) {
      this.warn(`turn ${state.turn} learning failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Learn from and close the current turn (throwing on internal errors).
   * @param {SessionState} state
   */
  finaliseTurnUnsafe(state) {
    const brain = this.brain
    const config = this.config
    const user = state.user
    const followUp = state.pendingFollowUp

    let result = { learned: [], preference: null, correction: 0 }
    if (config.autoLearn && (user.length >= config.minTurnChars || state.command)) {
      try {
        result = brain.learnTurn({
          user,
          command: state.command,
          assistant: config.learnAssistant ? state.lastAssistant : '',
          toolCalls: state.toolCalls,
          toolOutcomes: state.toolOutcomes,
          cwd: state.cwd,
          sessionId: state.sessionId,
          turn: state.turn,
          models: [...state.models].filter(Boolean),
          injected: state.injected.map(id => brain.store.find(id, { includeForgotten: true })).filter(Boolean),
          dedupe: true,
        })
      } catch (error) {
        this.warn(`learning skipped: ${error?.message ?? error}`)
      }
    }

    // Closed loop: the previous injected turn is judged by how the user reacted.
    if (followUp !== null) {
      try {
        const kind = classifyFollowUp(user)
        const feedback = brain.feedback({ kind, injected: followUp.injected })
        state.lastOutcome = kind
        if (config.debug) this.log(`feedback ${kind} (fit ${feedback.fit})`)
      } catch (error) {
        this.debug(`feedback: ${error?.message ?? error}`)
      }
    }

    // Character: kept on its own channel so that being corrected (a mistake)
    // and being overruled (a decision) never train the same habit. Runs on the
    // user's reply even when there was nothing to inject, because a standing
    // request like "以后直接说" must be heard on the first turn it appears.
    if (config.autoLearn && config.growPersonality && user.length >= config.minTurnChars) {
      try {
        const grown = brain.learnCharacter({
          kind: classifyReply(user),
          // A reply only counts against a challenge if one was actually put.
          challenge: state.pendingChallenge ?? null,
          text: user,
        })
        if (grown.changes.length > 0 && config.debug) {
          this.log(`character: ${grown.changes.map(c => `${c.key}${c.delta > 0 ? '+' : ''}${c.delta.toFixed(2)}`).join(' ')}`)
        }
        if (grown.asked !== null && grown.asked.ok) this.log(`personality: 记住了你的要求（${grown.asked.key}）`)
      } catch (error) {
        this.debug(`character: ${error?.message ?? error}`)
      }
    }
    if (config.autoLearn && config.consolidateEveryTurns > 0
      && this.turnsSinceFlush >= config.consolidateEveryTurns) {
      try {
        const journal = brain.store.data.journal.filter(entry => entry.consolidated !== true).length
        if (journal >= config.autoConsolidateMinNewTurns) {
          const report = brain.consolidate()
          this.log(`consolidated: ${report.digest === null ? 'no digest' : `digest ${report.digest}`}, ${report.forgotten.length} forgotten`)
          this.turnsSinceFlush = 0
        }
      } catch (error) {
        this.debug(`consolidation: ${error?.message ?? error}`)
      }
    }
    const tuneEvery = config.selfTuneEveryTurns
    if (config.autoLearn && tuneEvery > 0 && (brain.store.data.stats.turnsObserved % tuneEvery) === 0) {
      try {
        const tuning = brain.selfTune()
        if (tuning.changes.length > 0) this.log(`self-tuned: ${tuning.changes.join('; ')}`)
      } catch (error) {
        this.debug(`self-tune: ${error?.message ?? error}`)
      }
    }
    if (result.learned.length > 0 || result.preference !== null) {
      this.debug(`learned ${result.learned.length} item(s) from turn ${state.turn}`)
    }
    state.pendingFollowUp = state.injected.length === 0 ? null : { injected: state.injected.length, at: Date.now() }
    // Folded in: clear the per-turn observations so a repeated sighting of the
    // same turn finds nothing to learn and cannot journal it twice.
    state.user = ''
    state.command = false
    state.toolCalls = []
    state.toolOutcomes = new Map()
    state.lastAssistant = ''
    state.injected = []
    state.injectionText = ''
    state.injectionAt = 0
    // An objection only counts while its own turn is live; carrying it forward
    // would blame a later reply for an objection the user never answered.
    state.pendingChallenge = null
  }

  /**
   * Build and record the working set for the turn's first step.
   *
   * Returns the text to inject, or null when there is nothing useful to say
   * (query too short, nothing relevant, or the same block was just pushed).
   * @param {{ agent: object, messages: object[], turn: number, step: number }} payload
   * @returns {{ text: string, signature: string, ids: string[] } | null}
   */
  buildInjectionFor(payload) {
    const config = this.config
    const sessionId = payload.agent?.session?.id
    if (typeof sessionId !== 'string') return null
    const state = this.stateOf(sessionId)
    state.cwd = payload.agent?.session?.header?.cwd ?? state.cwd
    const query = queryOf(payload.messages, state.user)
    const chars = [...query.replace(/\s+/g, '')].length
    if (chars < config.recallMinQueryChars) {
      this.debug(`skip: query too short (${chars})`)
      return null
    }
    const project = config.perProjectPreferences ? state.cwd : ''
    const result = this.brain.workingSet({ query, project, habituation: state.habituation })
    if (result.text === '') return null
    if (!config.include.recent && result.items.every(item => item.part === 'recent')) return null
    const signature = createHash('sha1').update(result.text).digest('hex')
    if (state.injectionSignature === signature) {
      this.debug('skip: identical to last injection')
      return null
    }
    const ids = result.items.map(item => item.item.id).filter(id => !String(id).startsWith('recent-'))
    state.injectionSignature = signature
    state.injected = ids
    state.injectionText = result.items.map(item => `${item.item.title} ${item.item.content}`).join('\n')
    this.bumpHabituation(state, ids)
    const text = renderBlock(result.text, {
      turn: payload.turn,
      fit: this.brain.store.tuning.behaviorFit,
      project: projectOf(state.cwd),
      includeStatus: config.debug,
    })
    this.brain.store.data.stats.injections += 1
    this.brain.store.data.stats.recalls += 1
    this.brain.store.touch()
    return { text, signature, ids }
  }

  /** Record that an injected working set was actually delivered to the model. */
  noteInjected(sessionId) {
    const state = this.sessions.get(sessionId)
    if (state !== undefined && state.pendingFollowUp !== null) state.pendingFollowUp.injected = Math.max(1, state.injected.length)
  }

  /** Sliding window of how often each item was pushed to this session. */
  bumpHabituation(state, ids) {
    for (const [id, count] of state.habituation) {
      if (count <= 1) state.habituation.delete(id)
      else state.habituation.set(id, count - 1)
    }
    for (const id of ids) state.habituation.set(id, (state.habituation.get(id) ?? 0) + 1)
    if (state.habituation.size > 256) state.habituation.clear()
  }

  /** Persist the brain at a turn boundary. */
  maybeFlush() {
    try {
      if (this.brain.save()) this.debug('flushed (turn)')
    } catch (error) {
      this.warn(`save failed: ${error?.message ?? error}`)
    }
  }

  /** Run the slow loops on their cadence (consolidation is turn-counted). */
  maybeConsolidate() {
    const brain = this.brain
    const config = this.config
    if (!config.autoLearn) return
    if (config.consolidateEveryTurns > 0 && this.turnsSinceFlush >= config.consolidateEveryTurns) {
      try {
        const pending = brain.store.data.journal.filter(entry => entry.consolidated !== true).length
        if (pending >= config.autoConsolidateMinNewTurns) {
          const report = brain.consolidate()
          this.log(`consolidated (${report.forgotten.length} forgotten${report.digest === null ? '' : ', digest written'})`)
          this.turnsSinceFlush = 0
        }
      } catch (error) {
        this.debug(`consolidation: ${error?.message ?? error}`)
      }
    }
    const tuneEvery = config.selfTuneEveryTurns
    if (tuneEvery > 0 && brain.store.data.stats.turnsObserved % tuneEvery === 0) {
      try {
        const tuning = brain.selfTune()
        if (tuning.changes.length > 0) this.log(`self-tuned: ${tuning.changes.join('; ')}`)
      } catch (error) {
        this.debug(`self-tune: ${error?.message ?? error}`)
      }
    }
  }

  /** Persist the brain when dirty. */
  flushTurn(state, reason) {
    try {
      if (this.brain.save()) this.debug(`flushed (${reason})`)
    } catch (error) {
      this.warn(`save failed: ${error?.message ?? error}`)
    }
  }

  /** Start the idle flush timer (turn-boundary saves remain the fast path). */
  startIdleFlush() {
    if (this.config.idleFlushMs <= 0) return
    this.timer = setInterval(() => {
      if (this.closed) return
      try {
        if (this.brain.store.dirty) this.brain.save()
      } catch (error) {
        this.warn(`idle save failed: ${error?.message ?? error}`)
      }
    }, this.config.idleFlushMs)
    this.timer.unref?.()
  }

  /** Stop the idle flush timer. */
  stopIdleFlush() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Per-session state, created on first sight. */
  stateOf(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state === undefined) {
      state = new SessionState(sessionId)
      this.sessions.set(sessionId, state)
      if (this.sessions.size > 64) {
        // Bound the map: drop the oldest fully-inactive entry.
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined && oldest !== sessionId) this.sessions.delete(oldest)
      }
    }
    return state
  }

  /** Debug logging (stderr, never model-visible). */
  debug(message) {
    if (this.config.debug) this.log(message)
  }

  /** Human status line for CLI/diagnostics. */
  status() {
    return formatStatus(this.brain, this.config)
  }

  /** Current project for the tool layer. */
  contextOf(agent) {
    const cwd = agent?.session?.header?.cwd ?? ''
    return { project: projectOf(cwd), cwd, sessionId: agent?.session?.id ?? '' }
  }
}

/**
 * Whether a user message is a DSH command turn (hook-injected `/command` text).
 * @param {object} message
 * @returns {boolean}
 */
export function isCommandTurn(message) {
  const kind = String(message?.source?.kind ?? '')
  if (kind !== 'user') return false
  const text = normalizeText(userTextOf(message))
  return text.startsWith('The user sent a command:') || text.startsWith('<command-name>')
}

/**
 * Query text for the working set: the live user text when known, otherwise the
 * batch (minus injected context), bounded.
 * @param {object[]} messages
 * @param {string} fallback
 * @returns {string}
 */
export function queryOf(messages, fallback) {
  const batch = Array.isArray(messages) ? messages : []
  const own = batch
    .filter(message => message?.source?.kind === 'user')
    .map(message => normalizeText(userTextOf(message)))
    .filter(text => text !== '')
  const text = own.length > 0 ? own.join('\n') : fallback
  return text.slice(0, 600)
}

/**
 * Plain text of an assistant message (skips reasoning and tool blocks).
 * @param {object} message
 * @returns {string}
 */
export function assistantTextOf(message) {
  const parts = message?.content
  if (!Array.isArray(parts)) return ''
  return parts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
    .slice(0, 6000)
}

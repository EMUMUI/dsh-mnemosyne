/**
 * The Mnemosyne brain as a plain value. Host-agnostic: everything here could be
 * driven from a CLI, a test, or the DSH plugin.
 */

import { predictCommands, learnFromTurn } from './core/learn.js'
import {
  noteOutcome, selfTune as tuneBrain, health as healthOf,
} from './core/self.js'
import { recall as recallStored, workingSet as buildWorkingSet } from './core/recall.js'
import { loadStore, retentionOf, STORES } from './core/store.js'
import { clip, oneLine, redactSecrets, salience } from './core/text.js'
import { subjectOf } from './core/patterns.js'
import { normalizeConfig } from './config.js'

/** Valid store names, including the convenience alias `all`. */
const STORE_ALIASES = new Set([...STORES, 'all'])

/**
 * Create a brain bound to one memory file and configuration.
 * @param {{ config?: object, memoryFile: string, warn?: (message: string) => void, clock?: () => number }} options
 * @returns {Brain}
 */
export function createBrain(options) {
  const config = normalizeConfig(options.config ?? {})
  const store = loadStore(options.memoryFile, {
    clock: options.clock,
    warn: options.warn,
    label: config.profile ?? '',
  })
  // The config states the intended decay profile; the tuning block is what the
  // self-tuner owns. An explicit config value wins on every start, so editing
  // cordis.patch.yml behaves the way a reader expects.
  applyConfiguredTuning(store.tuning, options.config ?? {})
  return new Brain(store, config)
}

/**
 * Seed the self-tuning block from explicit configuration.
 *
 * Only keys the user actually set are applied: a self-tuned value must survive
 * a restart, so the persisted tuning is left alone when the config is silent.
 * @param {object} tuning - mutated in place.
 * @param {object} rawConfig - the raw (un-normalised) plugin config.
 */
function applyConfiguredTuning(tuning, rawConfig) {
  const { halfLifeDays, salienceFloor, recallMinScore, recallMaxItems } = rawConfig
  if (typeof halfLifeDays === 'number') tuning.halfLifeDays = halfLifeDays
  if (typeof salienceFloor === 'number') tuning.salienceFloor = salienceFloor
  if (typeof recallMinScore === 'number') tuning.recallThreshold = recallMinScore
  if (typeof recallMaxItems === 'number') tuning.recallMaxItems = recallMaxItems
}

/** High-level operations used by tools, hooks and tests. */
export class Brain {
  /**
   * @param {import('./core/store.js').Store} store
   * @param {object} config
   */
  constructor(store, config) {
    this.store = store
    this.config = config
    this.pendingTurns = []
    this.lastInjection = []
    this.writer = undefined
  }

  /** Current epoch milliseconds (the injected clock in tests). */
  now() {
    return this.store.now()
  }

  /** Persist if dirty (through the owning writer when one is attached). */
  save() {
    if (this.writer !== undefined) return this.writer.save()
    return this.store.save()
  }

  /**
   * Remember an explicit fact, preference or command.
   * @param {{ content: string, kind?: string, title?: string, tags?: string[], pinned?: boolean, salience?: number, store?: string }} input
   * @returns {object} the resolution: `{ id, action, store, title }`
   */
  remember(input) {
    const raw = String(input.content ?? '').trim()
    // Redact before anything is derived: titles, keys and tags are stored too,
    // and a derived title is just as replayable as the body.
    const content = redactSecretsIf(raw, this.config)
    if (content === '') throw new Error('content must be a non-empty string')
    const requested = input.store ?? (input.kind === 'preference' ? 'semantic' : 'episodic')
    if (!STORE_ALIASES.has(requested) || requested === 'all') {
      throw new Error(`store must be one of ${[...STORES].join(', ')}`)
    }
    const kind = input.kind ?? (requested === 'semantic' ? 'preference' : 'fact')
    const result = this.store.remember(requested, {
      content,
      title: input.title === undefined ? oneLine(content, 72) : redactSecretsIf(input.title, this.config),
      tags: [kind, ...(input.tags ?? [])],
      source: 'agent-tool',
      salience: input.salience ?? Math.max(0.35, salience(content, requested === 'semantic' ? 'preference' : 'memory')),
      strength: input.pinned === true ? 1 : undefined,
      pinned: input.pinned === true,
      force: true,
      key: requested === 'semantic' ? subjectOf(content) : '',
    })
    this.save()
    if (result.action === 'rejected') {
      return { id: '', action: 'rejected', store: requested, title: oneLine(content, 72) }
    }
    return { id: result.item.id, action: result.action, store: requested, title: result.item.title }
  }

  /**
   * Search every store.
   * @param {{ query: string, store?: string, limit?: number, includeForgotten?: boolean, project?: string, minScore?: number }} input
   * @returns {object[]}
   */
  recall(input) {
    const query = String(input.query ?? '').trim()
    if (query === '') throw new Error('query must be a non-empty string')
    const store = input.store ?? 'all'
    if (!STORE_ALIASES.has(store)) throw new Error(`store must be one of ${[...STORE_ALIASES].join(', ')}`)
    const hits = recallStored(this.store, query, {
      store,
      limit: input.limit ?? 8,
      includeForgotten: input.includeForgotten === true,
      project: this.config.perProjectPreferences ? (input.project ?? '') : '',
      minScore: input.minScore,
    })
    return hits.map(hit => ({
      id: hit.item.id,
      store: hit.item.store,
      title: hit.item.title,
      content: clip(hit.item.content, 600),
      score: hit.score,
      retention: hit.retention,
      strength: hit.item.strength,
      salience: hit.item.salience,
      hits: hit.item.hits,
      pinned: hit.item.pinned === true,
      forgotten: Boolean(hit.item.forgottenAt),
      superseded: Boolean(hit.item.supersededBy),
      created: iso(hit.item.createdAt),
      lastUsed: iso(hit.item.lastSeenAt),
    }))
  }

  /**
   * The working set for a turn.
   * @param {{ query: string, project?: string, habituation?: Map<string, number> }} input
   * @returns {{ text: string, items: object[], citations: object[] }}
   */
  workingSet(input) {
    const result = buildWorkingSet(this.store, {
      query: input.query ?? '',
      project: this.config.perProjectPreferences ? (input.project ?? '') : '',
      maxChars: this.config.workingSetMaxChars,
      recallMaxItems: this.config.recallMaxItems,
      recallMinScore: this.config.recallMinScore,
      maxProfileEntries: this.config.maxProfileEntries,
      include: this.config.include,
      habituation: input.habituation,
    })
    this.lastInjection = result.citations.map(citation => citation.id)
    return result
  }

  /**
   * Learn from one completed turn.
   * @param {object} turn - `{ user, assistant, toolCalls, toolOutcomes, cwd, sessionId, models, injected }`
   * @returns {object}
   */
  learnTurn(turn) {
    const result = learnFromTurn(this.store, turn, this.config)
    this.save()
    return result
  }

  /**
   * Record how the previous injection turned out and adapt.
   * @param {{ kind: 'accept'|'correct'|'neutral'|'silent', injected: number }} outcome
   * @returns {object}
   */
  feedback(outcome) {
    const result = noteOutcome(this.store, outcome)
    if (result.changed) this.save()
    return result
  }

  /**
   * Run consolidation (with optional dry run) and return a report.
   * @param {{ preview?: boolean }} input
   * @returns {object}
   */
  consolidate(input = {}) {
    const before = this.store.items('all').length
    if (input.preview === true) {
      const turns = this.store.data.journal.filter(entry => entry.consolidated !== true).length
      const weak = this.store.items('all').filter(item => retentionOf(item, this.store.now(), this.store.tuning) < 0.2).length
      return { preview: true, pendingTurns: turns, atRisk: weak, items: before, wouldDigest: turns >= 1 }
    }
    const result = this.store.consolidate({ minNewTurns: 1, maxEpisodic: this.config.maxEpisodic })
    this.save()
    return {
      digest: result.summary?.id ?? null,
      forgotten: result.forgotten.map(item => ({ id: item.id, title: item.title })),
      items: this.store.items('all').length,
    }
  }

  /**
   * Run the self-tuning pass now.
   * @returns {object}
   */
  selfTune() {
    const result = tuneBrain(this.store)
    this.save()
    return result
  }

  /**
   * Health report.
   * @returns {object}
   */
  health() {
    return healthOf(this.store)
  }

  /**
   * List, update or remove memories.
   * @param {{ action: string, ids?: string[], query?: string, store?: string, includeForgotten?: boolean, limit?: number, content?: string, pinned?: boolean, salience?: number, reason?: string }} input
   * @returns {object}
   */
  manage(input) {
    const action = String(input.action ?? '')
    switch (action) {
      case 'list':
        return this.list(input)
      case 'update': {
        const items = this.resolveMany(input.ids)
        if (items.length === 0) return { action, ok: false, error: 'no unique memory matched the given id(s)' }
        const wantsChange = typeof input.content === 'string' || typeof input.pinned === 'boolean' || typeof input.salience === 'number'
        if (!wantsChange) return { action, ok: false, error: 'update needs content, pinned or salience' }
        const changed = []
        for (const item of items) {
          if (typeof input.content === 'string' && input.content.trim() !== '') {
            item.content = redactSecretsIf(input.content.trim(), this.config)
            item.title = oneLine(item.content, 72)
            item.history.push({ at: this.store.now(), type: 'updated', source: 'agent-tool' })
          }
          if (typeof input.pinned === 'boolean') {
            item.pinned = input.pinned
            item.history.push({ at: this.store.now(), type: 'pinned', source: String(input.pinned) })
          }
          if (typeof input.salience === 'number') item.salience = Math.min(1, Math.max(0, input.salience))
          changed.push({ id: item.id, title: item.title, pinned: item.pinned })
        }
        this.store.touch()
        this.save()
        return { action, ok: true, id: items[0].id, title: items[0].title, pinned: items[0].pinned, updated: changed }
      }
      case 'pin':
      case 'unpin': {
        const items = this.resolveMany(input.ids)
        for (const item of items) item.pinned = action === 'pin'
        this.store.touch()
        this.save()
        return { action, ok: true, ids: items.map(item => item.id) }
      }
      case 'forget':
      case 'remove': {
        const items = this.resolveMany(input.ids)
        for (const item of items) this.store.forgetItem(item, input.reason ?? 'manual')
        this.save()
        return { action, ok: true, ids: items.map(item => item.id), note: 'soft-deleted; rebuild: mnemosyne_manage restore' }
      }
      case 'discard': {
        const items = this.resolveMany(input.ids)
        for (const item of items) this.store.discardItem(item, input.reason ?? 'manual')
        this.save()
        return { action, ok: true, ids: items.map(item => item.id) }
      }
      case 'restore': {
        const items = this.resolveMany(input.ids, { includeForgotten: true })
        for (const item of items) this.store.restoreItem(item)
        this.save()
        return { action, ok: true, ids: items.map(item => item.id) }
      }
      default:
        throw new Error(`unknown action "${action}"`)
    }
  }

  /**
   * List memories with retention and a compact preview.
   * @param {{ store?: string, query?: string, includeForgotten?: boolean, includeDiscarded?: boolean, limit?: number }} input
   * @returns {object}
   */
  list(input) {
    const store = input.store ?? 'all'
    const limit = Math.max(1, Math.min(200, input.limit ?? 20))
    let items = this.store.items(store, {
      includeForgotten: input.includeForgotten === true,
      includeDiscarded: input.includeDiscarded === true,
    })
    if (typeof input.query === 'string' && input.query.trim() !== '') {
      const q = input.query.trim().toLowerCase()
      items = items.filter(item => `${item.title} ${item.content} ${item.tags.join(' ')}`.toLowerCase().includes(q))
    }
    items = items.sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    const now = this.store.now()
    return {
      action: 'list',
      total: items.length,
      items: items.slice(0, limit).map(item => ({
        id: item.id,
        store: item.store,
        title: item.title,
        content: clip(item.content, 240),
        strength: item.strength,
        retention: retentionOf(item, now, this.store.tuning),
        hits: item.hits,
        pinned: item.pinned === true,
        forgotten: Boolean(item.forgottenAt),
        superseded: Boolean(item.supersededBy),
        created: iso(item.createdAt),
      })),
    }
  }

  /**
   * Command patterns matching a goal.
   * @param {{ goal: string, limit?: number }} input
   * @returns {object[]}
   */
  commands(input) {
    return predictCommands(this.store, String(input.goal ?? ''), input.limit ?? 3)
      .map(hit => ({ id: hit.item.id, goal: hit.item.key, command: hit.item.content, score: hit.score }))
  }

  /**
   * Resolve exactly one memory by id(s) — undefined when zero or several match.
   * @param {string[]|undefined} ids
   * @param {{ includeForgotten?: boolean }} options
   */
  resolveOne(ids, options = {}) {
    const items = this.resolveMany(ids, options)
    return items.length === 1 ? items[0] : undefined
  }

  /**
   * Resolve every memory matching any of `ids` (exact id or unique prefix).
   *
   * A model may send a single id as a bare string rather than an array, so both
   * shapes are accepted here rather than at every call site.
   * @param {string[]|string|undefined} ids
   * @param {{ includeForgotten?: boolean }} options
   * @returns {object[]}
   */
  resolveMany(ids, options = {}) {
    const list = Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : []
    const found = []
    const seen = new Set()
    const candidates = this.store.items('all', { includeForgotten: true, includeDiscarded: false })
      .filter(item => !item.discardedAt && (options.includeForgotten === true || !item.forgottenAt))
    for (const raw of list) {
      const needle = String(raw ?? '').trim()
      if (needle === '') continue
      for (const item of candidates) {
        if (seen.has(item.id)) continue
        if (item.id === needle || item.id.startsWith(needle)) {
          seen.add(item.id)
          found.push(item)
        }
      }
    }
    return found
  }
}

/** Import indirection so `remember` can apply the configured redaction. */
function redactSecretsIf(text, config) {
  return config.redactSecrets ? redactSecrets(text) : text
}

/** ISO string for an epoch-ms value ('' for falsy). */
export function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ''
}

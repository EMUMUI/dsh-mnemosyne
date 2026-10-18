/**
 * The persistent brain file.
 *
 * One JSON document per machine holds every store the agent owns: episodic
 * memories, semantic profile facts, preference statements, the learning
 * journal, the self-tuning parameters, and the statistics that drive them. The
 * file is written atomically (temp file + rename) so a crash mid-write can
 * never leave a truncated brain behind; corrupt files are moved aside and a
 * fresh brain starts instead of taking DSH down with it.
 *
 * Item lifecycle:
 *
 *   remember() ──> active ──(strength < floor)──> forgotten (with tombstone)
 *                    │  ▲
 *       reinforce ───┘  └─── restore() / recall includeForgotten
 *                    │
 *                 forget() ──> discarded (never returns; audit trail only)
 *
 * All writes go through `save()`; `dirty` lets the host defer disk writes to
 * turn boundaries and idle periods without losing anything.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_FLOOR, DEFAULT_HALF_LIFE_DAYS, MAX_STRENGTH, MERGE_SIMILARITY, clamp01, contradicts, decay,
  isForgotten, penalize, reinforce, retention as retentionCurve, round,
} from './decay.js'
import {
  hashText, normalizeText, oneLine, redactSecrets, salience, similarity, subjectKey,
} from './text.js'

/** On-disk format version; bump when a migration becomes necessary. */
export const STORE_VERSION = 1

/** Stores that hold memory items, in display order. */
export const STORES = ['episodic', 'semantic', 'commands']

/**
 * Default self-tuning parameters. These start at conservative values and are
 * moved by `self.js` from observed outcomes; users may edit any of them.
 * @returns {object}
 */
export function defaultTuning() {
  return {
    halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    salienceFloor: DEFAULT_FLOOR,
    recallThreshold: 2.6,
    recallMaxItems: 4,
    /** Strength gained per *used* recall (multiplier of the configured gain). */
    reinforceGainMul: 1,
    /** How readily learned preferences/commands are injected. */
    learnedInject: 1,
    /** Share of injected items the agent should act on (exponential moving average). */
    behaviorFit: 0.5,
    /** Observations folded into behaviorFit. */
    observations: 0,
    /** When self-tuning last ran. */
    lastSelfTuneAt: 0,
  }
}

/**
 * An empty brain.
 * @returns {object}
 */
export function emptyStore() {
  return {
    version: STORE_VERSION,
    kind: 'dsh-mnemosyne',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** Human or machine label written next to the brain (the profile name). */
    label: '',
    episodic: [],
    semantic: [],
    commands: [],
    journal: [],
    events: [],
    tuning: defaultTuning(),
    stats: freshStats(),
  }
}

/** Counters shown by `mnemosyne_stats` and `mnemosyne_health`. */
function freshStats() {
  return {
    turnsObserved: 0,
    memoriesLearned: 0,
    preferencesLearned: 0,
    commandsLearned: 0,
    recalls: 0,
    injections: 0,
    reinforced: 0,
    ignored: 0,
    forgotten: 0,
    discarded: 0,
    conflicts: 0,
    merged: 0,
    consolidations: 0,
    firstUseAt: 0,
    lastUseAt: 0,
  }
}

/**
 * Build a memory item with defaults filled in.
 * @param {'episodic'|'semantic'|'commands'} store
 * @param {object} fields
 * @param {number} now
 * @returns {object}
 */
function makeItem(store, fields, now) {
  const content = normalizeText(redactSecrets(String(fields.content ?? '')))
  return {
    id: `${store.slice(0, 4)}-${hashText(`${store}|${fields.key ?? content}`)}-${randomUUID().slice(0, 8)}`,
    store,
    kind: store === 'episodic' ? 'event' : store === 'semantic' ? 'fact' : 'command',
    title: oneLine(fields.title ?? content, 72),
    content,
    key: fields.key ?? '',
    tags: Array.isArray(fields.tags) ? fields.tags.slice(0, 8).map(String) : [],
    source: fields.source ?? 'agent',
    sessionId: fields.sessionId ?? '',
    project: fields.project ?? '',
    strength: round(fields.strength ?? 0.5),
    salience: round(clamp01(fields.salience ?? 0.4)),
    hits: 0,
    pinned: fields.pinned === true,
    conflicts: 0,
    corrective: fields.corrective === true,
    createdAt: now,
    refreshedAt: now,
    lastSeenAt: now,
    forgottenAt: 0,
    lastRecalled: [],
    history: [{ at: now, type: 'created', source: fields.source ?? 'agent' }],
  }
}

/**
 * A forgettability class per item, surfaced in listings.
 * @param {object} item
 * @param {number} now
 * @param {object} tuning
 * @returns {number} retention in [0, 1]
 */
export function retentionOf(item, now, tuning) {
  return round(retentionCurve(item, now, item.refreshedAt ?? item.createdAt ?? now,
    tuning?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS))
}

/**
 * The brain: an in-memory view of one store document with every mutation the
 * plugin needs. Construct with {@link loadStore}; call {@link save} to persist.
 */
export class Store {
  /**
   * @param {object} data - store document (will be mutated in place).
   * @param {{ filePath?: string, clock?: () => number }=} options
   */
  constructor(data, options = {}) {
    this.data = data
    this.filePath = options.filePath ?? ''
    this.clock = options.clock ?? Date.now
    this.dirty = false
    this.lastSavedAt = 0
  }

  /** Current epoch milliseconds. */
  now() {
    return this.clock()
  }

  /** The tuning parameters (mutable). */
  get tuning() {
    return this.data.tuning
  }

  /**
   * Queue the current data for persistence.
   * @returns {this}
   */
  touch() {
    this.dirty = true
    this.data.updatedAt = this.now()
    return this
  }

  /**
   * All items of one store.
   * @param {'episodic'|'semantic'|'commands'|'all'} store
   * @param {{ includeForgotten?: boolean, includeDiscarded?: boolean }=} options
   * @returns {object[]}
   */
  items(store = 'all', options = {}) {
    const list = store === 'all'
      ? STORES.flatMap(name => this.data[name] ?? [])
      : [...(this.data[store] ?? [])]
    return list.filter(item => {
      if (item.discardedAt && options.includeDiscarded !== true) return false
      if (item.forgottenAt && options.includeForgotten !== true) return false
      if (item.forgottenAt && options.includeForgotten === true && options.includeDiscarded !== true && item.discardedAt) {
        return false
      }
      return true
    })
  }

  /**
   * Find one item by id (or unique id prefix).
   * @param {string} idOrPrefix
   * @param {{ includeForgotten?: boolean, includeDiscarded?: boolean }=} options
   * @returns {object | undefined}
   */
  find(idOrPrefix, options = {}) {
    const needle = String(idOrPrefix ?? '').trim()
    if (needle === '') return undefined
    const all = this.items('all', { includeForgotten: true, includeDiscarded: true })
    const exact = all.find(item => item.id === needle)
    if (exact !== undefined) {
      if (exact.discardedAt && options.includeDiscarded !== true) return undefined
      if (exact.forgottenAt && options.includeForgotten !== true) return undefined
      return exact
    }
    const matches = all.filter(item => !item.discardedAt || options.includeDiscarded === true)
      .filter(item => options.includeForgotten === true || !item.forgottenAt)
      .filter(item => item.id.startsWith(needle))
    return matches.length === 1 ? matches[0] : undefined
  }

  /**
   * Remember something.
   *
   * Applies the same selection a human brain applies at encoding time:
   *  - semantic near-duplicates are consolidated (strength merged, not duplicated),
   *  - a conflicting preference about the same subject supersedes the old one
   *    (it is weakened, marked `supersededBy`, and no longer injected),
   *  - low-salience noise is rejected unless explicitly pinned.
   *
   * @param {'episodic'|'semantic'|'commands'} store
   * @param {object} fields - `{ content, title?, key?, tags?, source?, strength?, salience?, pinned?, project?, sessionId?, corrective? }`
   * @returns {{ item: object, action: 'created'|'merged'|'superseded'|'rejected', superseded?: object[] }}
   */
  remember(store, fields) {
    const now = this.now()
    const rawContent = String(fields.content ?? '')
    // Redaction is never optional at the storage boundary: a credential that
    // reaches this store would be replayed into every future prompt.
    const content = normalizeText(redactSecrets(rawContent))
    if (content === '') return { action: 'rejected', item: null }
    const list = this.data[store]
    if (!Array.isArray(list)) throw new Error(`unknown store ${store}`)
    const key = fields.key ?? ''
    const score = clamp01(fields.salience ?? salience(content, store === 'semantic' ? 'preference' : undefined))

    // Selection: filter noise unless the caller insists.
    if (score < 0.3 && fields.pinned !== true && fields.force !== true) {
      return { action: 'rejected', item: null }
    }

    const active = list.filter(item => !item.discardedAt && !item.forgottenAt)

    // Same subject key in semantic/commands: a revision, not a new memory.
    if (store === 'semantic' && key !== '') {
      const sameSubject = active.filter(item => item.key === key && !item.supersededBy
        && (!item.project || !fields.project || item.project === fields.project))
      if (sameSubject.length > 0) {
        const best = [...sameSubject].sort((a, b) => b.strength - a.strength)[0]
        if (similarity(best.content, content) >= MERGE_SIMILARITY) {
          this.reinforceItem(best, Math.max(0.25, score * 0.5), now, 'restated')
          this.data.stats.merged += 1
          this.touch()
          return { action: 'merged', item: best }
        }
        if (contradicts(best.content, content) || best.content !== content) {
          for (const old of sameSubject) {
            old.supersededBy = ''
            old.strength = round(old.strength * 0.25)
            old.history.push({ at: now, type: 'superseded', source: 'revision' })
            if (old.history.length > 20) old.history.splice(0, old.history.length - 20)
          }
          const created = makeItem(store, { ...fields, salience: score }, now)
          for (const old of sameSubject) old.supersededBy = created.id
          list.push(created)
          this.data.stats.preferencesLearned += 1
          this.data.stats.conflicts += 1
          this.addEvent(now, 'supersede', `${oneLine(best.title, 60)} → ${oneLine(created.title, 60)}`)
          this.touch()
          return { action: 'superseded', item: created, superseded: sameSubject }
        }
      }
    }

    // Semantic near-duplicate across subjects: reinforce the closest one. Two
    // statements about different subjects are never folded together, even when
    // they are worded similarly ("answer in Chinese" ≠ "answer briefly").
    if (store !== 'commands') {
      const similar = active
        .filter(item => item.key === '' || key === '' || item.key === key)
        .map(item => ({ item, score: similarity(item.content, content) }))
        .filter(entry => entry.score >= MERGE_SIMILARITY)
        .sort((left, right) => right.score - left.score)[0]
      if (similar !== undefined) {
        this.reinforceItem(similar.item, Math.max(0.2, score * 0.45), now, 'repeated')
        this.data.stats.merged += 1
        this.touch()
        return { action: 'merged', item: similar.item }
      }
    }

    const created = makeItem(store, { ...fields, salience: score, strength: fields.strength ?? 0.35 + score * 0.5 }, now)
    list.push(created)
    if (store === 'episodic') this.data.stats.memoriesLearned += 1
    if (store === 'semantic') this.data.stats.preferencesLearned += 1
    if (store === 'commands') this.data.stats.commandsLearned += 1
    this.addEvent(now, 'learn', `${store}: ${oneLine(created.title, 80)}`)
    this.touch()
    return { action: 'created', item: created }
  }

  /**
   * Strengthen an item in place.
   * @param {object} item
   * @param {number} amount
   * @param {number} now
   * @param {string} source
   * @returns {object}
   */
  reinforceItem(item, amount, now, source) {
    reinforce(item, amount, now, source)
    item.strength = Math.min(MAX_STRENGTH, round(item.strength))
    item.lastSeenAt = now
    this.touch()
    return item
  }

  /**
   * Weaken an item in place (a correction, an ignored recall).
   * @param {object} item
   * @param {number} amount
   * @param {number} now
   * @param {string} source
   * @returns {object}
   */
  penalizeItem(item, amount, now, source) {
    penalize(item, amount, now, source)
    this.touch()
    return item
  }

  /**
   * Forget an item now (soft delete, recoverable).
   * @param {object} item
   * @param {string} reason
   * @returns {object}
   */
  forgetItem(item, reason = 'manual') {
    const now = this.now()
    if (!item.forgottenAt) this.data.stats.forgotten += 1
    item.forgottenAt = now
    item.forgottenReason = reason
    item.history.push({ at: now, type: 'forgotten', source: reason })
    this.addEvent(now, 'forget', `${oneLine(item.title, 80)} (${reason})`)
    return this.touch()
  }

  /**
   * Bring a forgotten item back into the active store.
   * @param {object} item
   * @returns {object}
   */
  restoreItem(item) {
    const now = this.now()
    item.forgottenAt = 0
    delete item.forgottenReason
    item.strength = Math.max(0.3, round(Number(item.strength) || 0))
    item.refreshedAt = now
    item.history.push({ at: now, type: 'restored', source: 'manual' })
    this.addEvent(now, 'restore', oneLine(item.title, 80))
    return this.touch()
  }

  /**
   * Permanently discard an item. It is removed from the active store but a
   * tombstone keeps the audit trail; `includeDiscarded` listings show it.
   * @param {object} item
   * @param {string} reason
   * @returns {object}
   */
  discardItem(item, reason = 'manual') {
    const now = this.now()
    item.discardedAt = now
    item.discardedReason = reason
    item.pinned = false
    this.data.stats.discarded += 1
    this.addEvent(now, 'discard', `${oneLine(item.title, 80)} (${reason})`)
    return this.touch()
  }

  /**
   * Append a memory-activity event, keeping the log bounded.
   * @param {number} now
   * @param {string} type
   * @param {string} detail
   */
  addEvent(now, type, detail) {
    this.data.events.push({ at: now, type, detail: String(detail).slice(0, 200) })
    if (this.data.events.length > 200) this.data.events.splice(0, this.data.events.length - 200)
  }

  /**
   * Apply decay to every active item and forget those under the floor.
   * @returns {{ forgotten: object[], refreshed: number }}
   */
  decayAll() {
    const now = this.now()
    const tuning = this.data.tuning
    let refreshed = 0
    const forgotten = []
    for (const store of STORES) {
      for (const item of this.data[store] ?? []) {
        if (item.discardedAt) continue
        if (item.forgottenAt) {
          // Forgotten items keep decaying their stored value silently.
          item.strength = round(item.strength * 0.9)
          continue
        }
        decay(item, now, { halfLifeDays: tuning.halfLifeDays })
        if (isForgotten(item, now, { halfLifeDays: tuning.halfLifeDays, salienceFloor: tuning.salienceFloor })) {
          forgotten.push(item)
        } else {
          refreshed += 1
        }
      }
    }
    for (const item of forgotten) this.forgetItem(item, 'decay')
    return { forgotten, refreshed }
  }

  /**
   * Compress the backlog of turns observed since the last consolidation pass
   * into a single episodic summary, and decay everything.
   *
   * Sleep-like consolidation: the details of a conversation fade first, its
   * gist survives, and facts that were reinforced during consolidation get
   * strength back.
   * @param {{ minNewTurns?: number, maxEpisodic?: number, summaryChars?: number }=} options
   * @returns {{ summary: object | null, forgotten: object[], decayed: number }}
   */
  consolidate(options = {}) {
    const now = this.now()
    const minNewTurns = options.minNewTurns ?? 10
    const maxEpisodic = options.maxEpisodic ?? 500
    const turns = this.data.journal.filter(entry => entry.consolidated !== true)
    let summary = null
    if (turns.length > 0 && (minNewTurns <= 1 || turns.length >= minNewTurns)) {
      const projects = [...new Set(turns.map(entry => entry.cwd).filter(Boolean))]
      const lines = turns
        .map(entry => `- ${entry.oneLine}`)
        .slice(0, 40)
      const content = `Session digest (${turns.length} turns, ${new Date(turns[0].at).toISOString().slice(0, 10)}`
        + `${projects.length === 1 ? `, ${projects[0]}` : ''}):\n${lines.join('\n')}`
      summary = this.remember('episodic', {
        content,
        title: `Digest: ${oneLine(turns[turns.length - 1].oneLine, 50)}`,
        tags: ['digest'],
        source: 'consolidation',
        strength: 0.6 + Math.min(0.4, turns.length / 100),
        salience: 0.5,
        project: projects.length === 1 ? projects[0] : '',
      })
      for (const entry of turns) entry.consolidated = true
      this.data.stats.consolidations += 1
    }
    const decayed = this.decayAll()

    // Cap the episodic store: weakest (or oldest) memories are forgotten
    // first, exactly like the slow drift of old details.
    const episodic = this.data.episodic.filter(item => !item.discardedAt && !item.forgottenAt && !item.pinned)
    if (episodic.length > maxEpisodic) {
      const excess = episodic.length - maxEpisodic
      const victims = [...episodic].sort((a, b) => a.strength - b.strength || a.refreshedAt - b.refreshedAt).slice(0, excess)
      for (const victim of victims) this.forgetItem(victim, 'capacity')
    }
    // Bound the journal: consolidated entries older than the latest 200 leave.
    if (this.data.journal.length > 200) {
      const keep = this.data.journal.filter(entry => entry.consolidated !== true).slice(-200)
      this.data.journal = keep
    }
    return { summary: summary?.item ?? null, forgotten: decayed.forgotten, decayed: decayed.refreshed }
  }

  /**
   * Journal one observed turn (the raw material consolidation digests).
   * Journals are fact: this is called once per turn per session, from the one
   * host that observed it.
   * @param {{ at?: number, oneLine: string, cwd?: string, sessionId?: string, models?: string[], preference?: boolean, turn?: number }} entry
   */
  journalTurn(entry) {
    const now = this.now()
    // A re-opened turn (resumed or forked log) extends its own line instead of
    // adding a duplicate. The turn number alone is not enough: two sessions can
    // both have a "turn 1", so the session, the cwd and a recent timestamp all
    // have to agree before this counts as the same turn.
    const last = this.data.journal.at(-1)
    const sameTurn = last !== undefined
      && entry.dedupe === true
      && (last.turn ?? 0) === (entry.turn ?? 0)
      && last.oneLine === oneLine(entry.oneLine, 120)
      && last.sessionId === (entry.sessionId ?? '')
      && last.consolidated !== true
      && now - last.at < 3_000
    if (sameTurn) {
      last.at = now
      this.touch()
      return
    }
    this.data.journal.push({
      at: entry.at ?? now,
      oneLine: oneLine(entry.oneLine, 120),
      cwd: entry.cwd ?? '',
      sessionId: entry.sessionId ?? '',
      turn: entry.turn ?? 0,
      models: entry.models ?? [],
      preference: entry.preference === true,
      consolidated: false,
    })
    this.data.stats.turnsObserved += 1
    this.data.stats.lastUseAt = now
    if (!this.data.stats.firstUseAt) this.data.stats.firstUseAt = now
    this.touch()
  }

  /**
   * Write the brain to disk atomically.
   * @param {{ filePath?: string }=} options
   * @returns {boolean} whether anything was written.
   */
  save(options = {}) {
    const filePath = options.filePath ?? this.filePath
    if (!filePath) return false
    if (!this.dirty && fs.existsSync(filePath)) return false
    const directory = path.dirname(filePath)
    fs.mkdirSync(directory, { recursive: true })
    const temp = `${filePath}.${process.pid}.tmp`
    const payload = `${JSON.stringify(this.data)}\n`
    fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, filePath)
    this.dirty = false
    this.lastSavedAt = this.now()
    return true
  }
}

/**
 * Load a brain from disk, creating an empty one when the file is absent.
 * A corrupt file is preserved as `<file>.corrupt-<timestamp>` and replaced, so
 * the agent keeps working and the damaged data stays available for inspection.
 * @param {string} filePath
 * @param {{ clock?: () => number, label?: string, warn?: (message: string) => void }=} options
 * @returns {Store}
 */
export function loadStore(filePath, options = {}) {
  const clock = options.clock ?? Date.now
  const warn = options.warn ?? (() => {})
  let data
  if (filePath && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      data = migrate(parsed, warn)
    } catch (error) {
      const backup = `${filePath}.corrupt-${clock()}`
      try { fs.renameSync(filePath, backup) } catch { /* best effort */ }
      warn(`memory file unreadable (${error?.message ?? error}); moved to ${backup} and started fresh`)
      data = emptyStore()
    }
  } else {
    data = emptyStore()
    if (filePath) {
      // Touch the store so the first save actually writes a file.
      const store = new Store(data, { filePath, clock })
      store.dirty = true
      return store
    }
  }
  if (options.label !== undefined) data.label = options.label
  return new Store(data, { filePath, clock })
}

/**
 * Bring an older document up to {@link STORE_VERSION}, filling missing fields.
 * Never throws on missing optional data.
 * @param {any} parsed
 * @param {(message: string) => void} warn
 * @returns {object}
 */
export function migrate(parsed, warn = () => {}) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('memory file is not an object')
  }
  const fresh = emptyStore()
  const data = { ...fresh, ...parsed }
  data.stats = { ...fresh.stats, ...(parsed.stats ?? {}) }
  data.tuning = { ...defaultTuning(), ...(parsed.tuning ?? {}) }
  data.events = Array.isArray(parsed.events) ? parsed.events : []
  data.journal = Array.isArray(parsed.journal) ? parsed.journal : []
  for (const store of STORES) {
    if (!Array.isArray(data[store])) data[store] = []
    data[store] = repairItems(store, data[store], warn)
  }
  if (Number(data.version) > STORE_VERSION) {
    warn(`memory file version ${data.version} is newer than this plugin (${STORE_VERSION}); reading what it understands`)
  }
  data.version = STORE_VERSION
  return data
}

/**
 * Repair individual items: fill missing fields, coerce numeric bounds, drop
 * entries without usable content.
 * @param {string} store
 * @param {any[]} items
 * @param {(message: string) => void} warn
 * @returns {object[]}
 */
function repairItems(store, items, warn) {
  const repaired = []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    if (typeof raw.content !== 'string' || raw.content.trim() === '') {
      warn(`dropped one ${store} item without content`)
      continue
    }
    const now = Number(raw.createdAt) || Date.now()
    repaired.push({
      id: typeof raw.id === 'string' ? raw.id : `${store.slice(0, 4)}-${hashText(raw.content)}-${randomUUID().slice(0, 8)}`,
      store,
      kind: typeof raw.kind === 'string' ? raw.kind : 'fact',
      title: typeof raw.title === 'string' ? raw.title : oneLine(raw.content, 72),
      content: raw.content,
      key: typeof raw.key === 'string' ? raw.key : '',
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      source: typeof raw.source === 'string' ? raw.source : 'unknown',
      sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : '',
      project: typeof raw.project === 'string' ? raw.project : '',
      strength: Number.isFinite(raw.strength) ? round(Math.max(0, Math.min(MAX_STRENGTH, raw.strength))) : 0.5,
      salience: Number.isFinite(raw.salience) ? round(clamp01(raw.salience)) : 0.4,
      hits: Number.isFinite(raw.hits) ? Math.max(0, Math.floor(raw.hits)) : 0,
      pinned: raw.pinned === true,
      conflicts: Number.isFinite(raw.conflicts) ? raw.conflicts : 0,
      corrective: raw.corrective === true,
      createdAt: now,
      refreshedAt: Number(raw.refreshedAt) || now,
      lastSeenAt: Number(raw.lastSeenAt) || now,
      forgottenAt: Number(raw.forgottenAt) || 0,
      discardedAt: Number(raw.discardedAt) || 0,
      lastRecalled: Array.isArray(raw.lastRecalled) ? raw.lastRecalled.slice(-10) : [],
      history: Array.isArray(raw.history) ? raw.history.slice(-20) : [],
      ...(typeof raw.supersededBy === 'string' && raw.supersededBy !== '' ? { supersededBy: raw.supersededBy } : {}),
    })
  }
  return repaired
}

/** Exported for tests and the self-tuner. */
export { subjectKey }

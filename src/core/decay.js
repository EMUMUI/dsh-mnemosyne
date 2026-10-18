/**
 * The forgetting model.
 *
 * Memory strength is a positive number. Like human memory it grows with each
 * meaningful encounter and, when nobody touches it, decays exponentially with
 * a half-life that is longer for important memories and for memories that have
 * been rehearsed many times before (the "spacing effect"). A memory whose
 * strength falls below a floor is *forgotten*: it leaves the active store but
 * an event records its last visible form, so `mnemosyne_recall` with
 * `includeForgotten: true` can still surface it — the realistic middle ground
 * between "gone forever" and "everything is remembered equally".
 *
 * Constants are exposed so the model's self-tuning can adapt them per machine
 * (see `self.js`); nothing here reads global state.
 */

/** Default half-life for an untouched memory, in days. */
export const DEFAULT_HALF_LIFE_DAYS = 21

/**
 * The forgetting floor: a memory whose decayed strength falls below this is no
 * longer active. Expressed in absolute strength (not as a fraction) because
 * there is no single "original strength" to compare against — strength grows
 * with every rehearsal.
 */
export const DEFAULT_FLOOR = 0.05

/** Strength cap, so repetition cannot make one memory dominate forever. */
export const MAX_STRENGTH = 8

/** Default recall threshold on the 0–10 ranking scale (see recall.js). */
export const DEFAULT_RECALL_THRESHOLD = 2.6

/** Default recall threshold used by the explicit `mnemosyne_recall` tool. */
export const DEFAULT_RETRIEVAL_SCORE = 2.2

/** Days between the `createdAt` of full consolidation passes. */
export const CONSOLIDATION_INTERVAL_DAYS = 2

/** How strongly half-life scales with salience: +salience*CAP extra days per extra salience unit. */
export const SALIENCE_HALF_LIFE_CAP = 60

/**
 * Effective half-life of a memory in days.
 * @param {{ strength: number, salience: number, kind: string }} item
 * @param {number} halfLifeDays - the base half-life for ordinary memories.
 * @returns {number}
 */
export function halfLifeOf(item, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  if (!(halfLifeDays > 0)) return Number.POSITIVE_INFINITY
  const salience = clamp01(item?.salience ?? 0.3)
  // Important memories decay slower; a strongly rehearsed memory also decays
  // slower (1.55^log2(strength+1) ≈ 1 → 3.1 over the interesting range).
  const rehearsal = Math.pow(1.55, Math.log2(Math.max(0, Number(item?.strength) || 0) + 1))
  return halfLifeDays * (1 + 2 * salience) * rehearsal
}

/**
 * Retention in (0, 1]: the share of an item a human would still recall after
 * `elapsedDays`, following Ebbinghaus' exponential curve.
 * @param {{ strength: number, salience: number }} item
 * @param {number} now
 * @param {number} refreshedAt - epoch ms of the last touch.
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function retention(item, now, refreshedAt, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const halfLife = halfLifeOf(item, halfLifeDays)
  if (!Number.isFinite(halfLife)) return 1
  const elapsedDays = Math.max(0, now - refreshedAt) / 86_400_000
  return Math.pow(0.5, elapsedDays / halfLife)
}

/**
 * Decayed strength (what the item is worth right now).
 * @param {{ strength: number, salience: number }} item
 * @param {number} now
 * @param {number} refreshedAt
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function effectiveStrength(item, now, refreshedAt, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  return (Number(item?.strength) || 0) * retention(item, now, refreshedAt, halfLifeDays)
}

/**
 * Whether an item has fallen under the forgetting floor.
 * @param {object} item
 * @param {number} now
 * @param {{ halfLifeDays?: number, salienceFloor?: number }} options
 * @returns {boolean}
 */
export function isForgotten(item, now, options = {}) {
  if (item?.pinned === true) return false
  const floor = options.salienceFloor ?? DEFAULT_FLOOR
  const strength = effectiveStrength(item, now, item.refreshedAt ?? item.createdAt ?? now,
    options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS)
  return strength < floor
}

/**
 * Reinforcement from one meaningful encounter: raise strength by a diminishing
 * amount (the first learning of something is loud, the tenth recurrence barely
 * registers) and record the encounter time.
 *
 * @param {{ strength: number, hits: number }} item - mutated in place.
 * @param {number} amount - base increment (≤ 0.5 realistically).
 * @param {number} now
 * @param {string=} source - where the encounter came from, for the history.
 * @returns {number} the new strength.
 */
export function reinforce(item, amount, now, source) {
  const current = Math.max(0, Number(item.strength) || 0)
  const gain = Math.max(0, Number(amount) || 0) / (1 + 0.6 * (Number(item.hits) || 0))
  item.strength = Math.min(MAX_STRENGTH, round(current + gain))
  item.hits = (Number(item.hits) || 0) + 1
  item.refreshedAt = now
  if (source !== undefined) {
    item.history = Array.isArray(item.history) ? item.history : []
    item.history.push({ at: now, type: 'reinforce', source: String(source).slice(0, 40), amount: round(gain) })
    if (item.history.length > 20) item.history.splice(0, item.history.length - 20)
  }
  return item.strength
}

/**
 * Penalise an item: a negative encounter (ignored recall, an explicit
 * correction) weakens it without deleting it immediately — forgetting takes
 * time and is checked by the regular decay pass.
 * @param {object} item - mutated in place.
 * @param {number} amount - positive magnitude to subtract.
 * @param {number} now
 * @param {string} source
 * @returns {number} the remaining strength.
 */
export function penalize(item, amount, now, source) {
  item.strength = Math.max(0, round((Number(item.strength) || 0) - Math.max(0, Number(amount) || 0)))
  item.history = Array.isArray(item.history) ? item.history : []
  item.history.push({ at: now, type: 'penalize', source: String(source).slice(0, 40), amount: round(amount) })
  if (item.history.length > 20) item.history.splice(0, item.history.length - 20)
  return item.strength
}

/**
 * Fold an item's current decayed strength into its stored strength. Used by the
 * regular pass so that the stored value tracks reality; `refresh` resets the
 * decay clock when the model confirms the item is still true.
 * @param {object} item - mutated in place.
 * @param {number} now
 * @param {{ halfLifeDays?: number, refresh?: boolean }=} options
 * @returns {object} the item.
 */
export function decay(item, now, options = {}) {
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  if (halfLifeDays <= 0 || item?.pinned === true) {
    if (options.refresh === true) item.refreshedAt = now
    return item
  }
  item.strength = round(effectiveStrength(item, now, item.refreshedAt ?? item.createdAt ?? now, halfLifeDays))
  if (options.refresh === true) item.refreshedAt = now
  return item
}

/**
 * How similar two memory titles/contents must be to be considered the same
 * memory (semantic consolidation).
 */
export const MERGE_SIMILARITY = 0.72

/**
 * Whether a preference statement contradicts an existing one about the same
 * subject. Contradiction is detected by opposing polarity markers rather than
 * by language understanding: "always answer in Chinese" vs "never answer in
 * Chinese" share the subject (Chinese) but carry opposite markers.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function contradicts(a, b) {
  const negative = /不要|别|禁止|never|don'?t|stop|avoid|dislike|no longer|取消|关闭|禁用/i
  const aNeg = negative.test(a)
  const bNeg = negative.test(b)
  return aNeg !== bNeg
}

/**
 * Round to four decimals, keeping stored JSON compact and diffs readable.
 * @param {number} value
 * @returns {number}
 */
export function round(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 10_000) / 10_000
}

/** Clamp a number into [0, 1]. */
export function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

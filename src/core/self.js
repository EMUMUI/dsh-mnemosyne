/**
 * Self-evolution.
 *
 * The brain is not fixed at install time. Two slow loops move its parameters
 * from observed outcomes, the way a person's habits adjust to what actually
 * works:
 *
 *  - **Behaviour fitting** (`noteOutcome`) — after every turn that received an
 *    injected working set, classify the user's next message as *accept*,
 *    *correct*, or *neutral*, and fold it into a moving average. A correction
 *    immediately hardens the threshold; sustained acceptance relaxes it.
 *
 *  - **Diagnosis and tuning** (`selfTune`) — on a cadence, look at the whole
 *    brain: injections that were never cited, preferences that conflict, the
 *    forgotten ratio, how often memories are really reused. Then nudge the
 *    threshold, half-life, reinforcement gain and injection policy within hard
 *    bounds. Every change is written to the events log with its reason, so the
 *    tuning is inspectable and reversible.
 *
 * Nothing here can explode: each parameter is clamped to a safe range, and a
 * single outlier turn cannot move a parameter by more than its step.
 */

import { DEFAULT_FLOOR, clamp01, round } from './decay.js'
import { FAILURE_MARKERS } from './patterns.js'

/** Hard bounds for every tunable. */
export const BOUNDS = {
  recallThreshold: [1.6, 4.5],
  halfLifeDays: [3, 120],
  salienceFloor: [0.01, 0.2],
  reinforceGainMul: [0.6, 2],
  learnedInject: [0.3, 1],
}

/** Minimum observations before behaviour fitting may move thresholds. */
const MIN_OBSERVATIONS = 8

/** Step sizes, small enough that one pass cannot overshoot. */
const STEPS = {
  recallThreshold: 0.1,
  halfLifeDaysMul: 1.04,
  reinforceGainMul: 0.05,
}

/**
 * Classify a user's follow-up message relative to the turn that just ended.
 * @param {string} text - the next user text (normalised), or '' when none arrived.
 * @returns {'accept' | 'correct' | 'neutral' | 'silent'}
 */
export function classifyFollowUp(text) {
  const source = String(text ?? '').trim()
  if (source === '') return 'silent'
  if (FAILURE_MARKERS.some(marker => source.toLowerCase().includes(marker.toLowerCase()))) return 'correct'
  if (/不对|错了|不行|不是这个|我说过|不要这样|别再|wrong|no,|actually/i.test(source)) return 'correct'
  if (/^(?:好的|好|嗯|ok|okay|可以|继续|对的|没错|yes|great|thanks|谢谢|完美|很好|不错|行)/i.test(source)
    && source.length <= 16) {
    return 'accept'
  }
  if (source.length <= 120 && !/[?？]/.test(source)) return 'accept'
  return 'neutral'
}

/**
 * Fold one turn's outcome into the behaviour fit and adapt immediately when
 * the user corrected the agent.
 * @param {import('./store.js').Store} store
 * @param {{ kind: 'accept'|'correct'|'neutral'|'silent', injected: number }} outcome
 * @returns {{ changed: boolean, fit: number }}
 */
export function noteOutcome(store, outcome) {
  const tuning = store.tuning
  if (outcome.injected <= 0) return { changed: false, fit: tuning.behaviorFit }
  if (outcome.kind === 'silent') return { changed: false, fit: tuning.behaviorFit }

  const target = outcome.kind === 'accept' ? 1 : outcome.kind === 'correct' ? 0 : 0.5
  const alpha = 0.15
  tuning.behaviorFit = round((1 - alpha) * tuning.behaviorFit + alpha * target)
  tuning.observations = (tuning.observations ?? 0) + 1
  let changed = false

  // Fast reflex: a correction right after an injected working set hardens the
  // gate so the next turn recalls less (and more precisely).
  if (outcome.kind === 'correct') {
    const [min, max] = BOUNDS.recallThreshold
    const next = Math.min(max, tuning.recallThreshold + STEPS.recallThreshold * 2)
    if (next !== tuning.recallThreshold) {
      tuning.recallThreshold = round(next)
      changed = true
      store.addEvent(store.now(), 'tune', `recallThreshold ${round(next)} (user corrected an injection)`)
    }
    tuning.reinforceGainMul = round(Math.max(BOUNDS.reinforceGainMul[0], tuning.reinforceGainMul - 0.02))
  }

  // Evidence: a memory that is cited but never leads anywhere is noise.
  store.touch()
  return { changed, fit: tuning.behaviorFit }
}

/**
 * Count how often stored items were actually reused, and how much of the store
 * has been forgotten.
 * @param {import('./store.js').Store} store
 * @returns {{ items: number, reused: number, forgotten: number, reuseRate: number, forgottenRate: number }}
 */
export function usageSummary(store) {
  const active = store.items('all')
  const forgotten = store.items('all', { includeForgotten: true }).length - active.length
  const reused = active.filter(item => (item.hits ?? 0) >= 2).length
  const total = active.length + Math.max(0, forgotten)
  return {
    items: active.length,
    reused,
    forgotten: Math.max(0, forgotten),
    reuseRate: active.length === 0 ? 0 : round(reused / active.length),
    forgottenRate: total === 0 ? 0 : round(Math.max(0, forgotten) / total),
  }
}

/**
 * Diagnose the brain and nudge its parameters. Returns the list of applied
 * changes (also recorded in the events log).
 *
 * Rules, in plain words:
 *  - If injections are mostly useless (fit low) and there is enough evidence,
 *    recall less: raise the threshold, decay faster.
 *  - If the user accepts injections without re-asking (fit high), relax the
 *    gate so more context can help.
 *  - If many memories are forgotten and none are reused, the half-life is too
 *    short for this user: lengthen it, and let learned items inject more
 *    readily once reuse proves they matter.
 *  - If nothing is ever forgotten, the floor is too low: raise it.
 *
 * @param {import('./store.js').Store} store
 * @param {{ minItems?: number }=} options
 * @returns {{ changes: string[], advice: string[] }}
 */
export function selfTune(store, options = {}) {
  const now = store.now()
  const tuning = store.tuning
  const minItems = options.minItems ?? 20
  const summary = usageSummary(store)
  const changes = []
  const advice = []

  if (tuning.observations >= MIN_OBSERVATIONS) {
    const [min, max] = BOUNDS.recallThreshold
    if (tuning.behaviorFit < 0.35) {
      const next = Math.min(max, round(tuning.recallThreshold + STEPS.recallThreshold))
      if (next !== tuning.recallThreshold) {
        changes.push(`recallThreshold ${tuning.recallThreshold} → ${next} （契合度 ${tuning.behaviorFit} 偏低，收紧召回）`)
        tuning.recallThreshold = next
      }
    } else if (tuning.behaviorFit > 0.75) {
      const next = Math.max(min, round(tuning.recallThreshold - STEPS.recallThreshold))
      if (next !== tuning.recallThreshold) {
        changes.push(`recallThreshold ${tuning.recallThreshold} → ${next} （契合度 ${tuning.behaviorFit} 偏高，放宽召回）`)
        tuning.recallThreshold = next
      }
    }
  } else {
    advice.push(`行为证据还不足：${tuning.observations}/${MIN_OBSERVATIONS} 轮，阈值暂保持保守`)
  }

  if (summary.items >= minItems) {
    if (summary.forgottenRate > 0.4 && summary.reuseRate < 0.3) {
      const next = Math.min(BOUNDS.halfLifeDays[1], round(tuning.halfLifeDays * STEPS.halfLifeDaysMul))
      changes.push(`halfLifeDays ${tuning.halfLifeDays} → ${next} （遗忘率 ${Math.round(summary.forgottenRate * 100)}% 而复用率偏低，放慢遗忘）`)
      tuning.halfLifeDays = next
    } else if (summary.forgottenRate > 0.4 && summary.reuseRate >= 0.3) {
      const next = Math.min(BOUNDS.salienceFloor[1], round(tuning.salienceFloor + 0.01))
      if (next !== tuning.salienceFloor) {
        changes.push(`salienceFloor ${tuning.salienceFloor} → ${next} （记忆太满：让弱的更早淡出）`)
        tuning.salienceFloor = next
      }
    }
    if (summary.forgotten === 0 && summary.items > minItems * 2) {
      const next = Math.max(BOUNDS.salienceFloor[0], DEFAULT_FLOOR)
      const raised = Math.min(BOUNDS.salienceFloor[1], round(next * 1.5))
      if (raised !== tuning.salienceFloor) {
        changes.push(`salienceFloor ${tuning.salienceFloor} → ${raised} （至今什么都没忘，提高遗忘门槛）`)
        tuning.salienceFloor = raised
      }
    }
    if (summary.reuseRate > 0.4) {
      const next = Math.min(BOUNDS.reinforceGainMul[1], round(tuning.reinforceGainMul + STEPS.reinforceGainMul))
      if (next !== tuning.reinforceGainMul) {
        changes.push(`reinforceGainMul ${tuning.reinforceGainMul} → ${next} （记忆正在被复用，加固更有效）`)
        tuning.reinforceGainMul = next
      }
      const inject = Math.min(BOUNDS.learnedInject[1], round((tuning.learnedInject ?? 1) + 0.05))
      if (inject !== tuning.learnedInject) {
        changes.push(`learnedInject ${tuning.learnedInject} → ${inject} （学到的内容确实有用，多注入一些）`)
        tuning.learnedInject = inject
      }
    } else if (summary.reuseRate < 0.1 && summary.items > minItems) {
      const inject = Math.max(BOUNDS.learnedInject[0], round((tuning.learnedInject ?? 1) - 0.05))
      if (inject !== tuning.learnedInject) {
        changes.push(`learnedInject ${tuning.learnedInject} → ${inject} （学到的内容很少被复用，少注入一些）`)
        tuning.learnedInject = inject
      }
    }
  }

  const pinned = store.items('all').filter(item => item.pinned).length
  if (pinned > 200) advice.push(`已固定 ${pinned} 条：什么都固定就等于不会遗忘，把不再重要的取消固定`)

  tuning.behaviorFit = round(clamp01(tuning.behaviorFit))
  tuning.lastSelfTuneAt = now
  if (changes.length > 0) {
    for (const change of changes) store.addEvent(now, 'tune', change)
  }
  store.touch()
  return { changes, advice }
}

/**
 * A human-readable health report: what the brain holds, what it has forgotten,
 * how well it is fitting this user, and what to do about it.
 * @param {import('./store.js').Store} store
 * @returns {object} structured report
 */
export function health(store) {
  const now = store.now()
  const tuning = store.tuning
  const active = store.items('all')
  const forgotten = store.items('all', { includeForgotten: true }).filter(item => item.forgottenAt && !item.discardedAt)
  const summary = usageSummary(store)
  const byStore = {}
  for (const name of ['episodic', 'semantic', 'commands']) {
    const items = store.items(name)
    byStore[name] = {
      active: items.length,
      forgotten: (store.data[name] ?? []).filter(item => item.forgottenAt && !item.discardedAt).length,
      meanStrength: items.length === 0 ? 0 : round(items.reduce((sum, item) => sum + item.strength, 0) / items.length),
    }
  }
  const weakest = [...active].sort((left, right) => left.strength - right.strength).slice(0, 5)
    .map(item => ({ id: item.id, title: item.title, strength: item.strength }))
  const strongest = [...active].sort((left, right) => right.strength - left.strength).slice(0, 5)
    .map(item => ({ id: item.id, title: item.title, strength: item.strength }))
  const advice = []
  if (summary.items === 0) advice.push('记忆还是空的：继续用 DSH，或者说"记住…"，也可以调用 mnemosyne_remember 先存几条')
  if (summary.items > 0 && summary.reuseRate < 0.15) {
    advice.push('大多数记忆从没被复用：可能太具体了，多存一些通用的偏好和教训')
  }
  if (forgotten.length > summary.items) advice.push('被遗忘的比还活着的还多：如果不是你想要的，可以调大 halfLifeDays')
  if (tuning.behaviorFit < 0.4 && tuning.observations >= MIN_OBSERVATIONS) {
    advice.push('最近的注入不太贴合：先跑一次 mnemosyne_consolidate（preview 设为 true 看预览），再收紧偏好')
  }
  if (store.data.stats.conflicts > 0) {
    advice.push(`记录了 ${store.data.stats.conflicts} 次偏好修订：后来的说法会取代先前的`)
  }

  return {
    items: summary.items,
    forgotten: forgotten.length,
    reused: summary.reused,
    reuseRate: summary.reuseRate,
    forgottenRate: summary.forgottenRate,
    byStore,
    behaviorFit: store.tuning.behaviorFit,
    observations: store.tuning.observations,
    tuning: { ...store.tuning },
    strongest,
    weakest,
    advice,
    ageDays: round((now - (store.data.createdAt ?? now)) / 86_400_000),
  }
}

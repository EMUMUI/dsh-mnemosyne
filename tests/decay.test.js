import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_HALF_LIFE_DAYS, MAX_STRENGTH, contradicts, decay, effectiveStrength, halfLifeOf, isForgotten,
  penalize, reinforce, retention,
} from '../src/core/decay.js'
import { advanceDays, createBrainAt } from './helpers.js'

const DAY = 86_400_000

test('retention follows the Ebbinghaus curve', () => {
  const item = { strength: 1, salience: 0.3 }
  const halfLife = halfLifeOf(item, 21)
  assert.ok(retention(item, 0, 0, 21) === 1)
  const afterHalf = retention(item, halfLife * DAY, 0, 21)
  assert.ok(Math.abs(afterHalf - 0.5) < 1e-9, `expected 0.5, got ${afterHalf}`)
  assert.ok(retention(item, 2 * halfLife * DAY, 0, 21) < 0.26)
  // Monotonic in time.
  assert.ok(retention(item, 10 * DAY, 0, 21) > retention(item, 20 * DAY, 0, 21))
})

test('important and rehearsed memories decay slower', () => {
  const weak = { strength: 0.4, salience: 0.1 }
  const strong = { strength: 0.4, salience: 0.9 }
  assert.ok(halfLifeOf(strong) > halfLifeOf(weak))
  const rehearsed = { strength: 3, salience: 0.4 }
  const fresh = { strength: 0.4, salience: 0.4 }
  assert.ok(halfLifeOf(rehearsed) > halfLifeOf(fresh))
  assert.ok(retention(strong, 30 * DAY, 0) > retention(weak, 30 * DAY, 0))
})

test('rehearsed memories expire later: the spacing effect', () => {
  const clock = createBrainAt({ config: { halfLifeDays: 3 } })
  clock.brain.remember({ content: '只见过一次、容易淡忘的内容', kind: 'fact', force: true })
  const saved = clock.brain.remember({ content: '被反复遇到、记得更牢的内容', kind: 'fact', force: true })
  const rehearsed = clock.brain.store.find(saved.id)
  rehearsed.strength = 2.4
  rehearsed.hits = 20
  clock.advance(20 * DAY)
  for (const item of clock.brain.store.items('all')) decay(item, clock.now(), { halfLifeDays: 3 })
  const fresh = clock.brain.store.items('all').find(item => item.content.startsWith('只见过'))
  const strong = clock.brain.store.items('all').find(item => item.content.startsWith('被反复'))
  assert.ok(fresh.strength < 0.1, `fresh strength ${fresh.strength} should be near the floor`)
  assert.ok(strong.strength > 6 * fresh.strength, `rehearsed strength ${strong.strength} vs ${fresh.strength}`)
})

test('halfLifeDays = 0 means never forget', () => {
  const item = { strength: 0.2, salience: 0.1 }
  assert.equal(retention(item, 10_000 * DAY, 0, 0), 1)
  assert.equal(isForgotten({ ...item, refreshedAt: 0, createdAt: 0 }, 10_000 * DAY, { halfLifeDays: 0 }), false)
})

test('reinforcement is diminishing and capped', () => {
  const item = { strength: 0.2, hits: 0 }
  const first = reinforce(item, 1, 0)
  const second = reinforce(item, 1, 0)
  assert.ok(second - first < first - 0.2, 'the second encounter adds less than the first')
  item.hits = 0
  for (let index = 0; index < 200; index += 1) reinforce(item, 5, 0)
  assert.ok(item.strength <= MAX_STRENGTH)
})

test('penalties weaken but never go negative', () => {
  const item = { strength: 0.5, hits: 1, history: [] }
  penalize(item, 10, 0, 'test')
  assert.equal(item.strength, 0)
  assert.equal(item.history.at(-1).type, 'penalize')
})

test('decay folds elapsed time into stored strength', () => {
  const item = { strength: 1, salience: 0.3, refreshedAt: 0, createdAt: 0 }
  const before = item.strength
  decay(item, 21 * DAY, { halfLifeDays: 21 })
  assert.ok(item.strength < before)
  assert.ok(effectiveStrength(item, 21 * DAY, 0, 21) > 0)
})

test('contradiction detection is about polarity', () => {
  assert.equal(contradicts('always reply briefly', 'never reply briefly'), true)
  assert.equal(contradicts('以后都用中文', '以后不要用中文'), true)
  assert.equal(contradicts('以后都用中文', '以后都用英文'), false)
})

test('decay pass forgets weak memories and keeps pinned ones', () => {
  const clock = createBrainAt({ config: { halfLifeDays: 7 } })
  const rehearsal = clock.brain.remember({ content: '这是一条被反复遇到、记得很牢的记忆', kind: 'fact', force: true })
  const pinned = clock.brain.remember({ content: '这是一条被固定的记忆', kind: 'fact', pinned: true, force: true })
  const weak = clock.brain.remember({ content: '短期杂事，只出现了一次', kind: 'fact', force: true })
  // Ten prior encounters: the rehearsal effect, in numbers.
  const trained = clock.brain.store.find(rehearsal.id)
  trained.strength = 3
  trained.hits = 10
  advanceDays(clock, 30)
  const result = clock.brain.consolidate()
  assert.ok(result.forgotten.some(item => item.id === weak.id), 'an unrehearsed memory fades away')
  assert.ok(!result.forgotten.some(item => item.id === pinned.id), 'pinned memory never decays')
  assert.ok(clock.brain.store.find(rehearsal.id) !== undefined, 'a rehearsed memory survives the same month')
  assert.ok(clock.brain.store.find(weak.id, { includeForgotten: true }) !== undefined,
    'forgotten, not destroyed — the record remains for recall')
})

test('the forgetting floor is honoured and forgotten items keep decaying', () => {
  const clock = createBrainAt({ config: { halfLifeDays: 1 } })
  const saved = clock.brain.remember({ content: '很快就会被忘记的内容', kind: 'fact', force: true })
  clock.brain.store.find(saved.id).strength = 0.2
  advanceDays(clock, 10)
  clock.brain.consolidate()
  assert.equal(clock.brain.store.find(saved.id), undefined, 'past the floor: no longer active')
  assert.ok(clock.brain.store.find(saved.id, { includeForgotten: true }).forgottenAt > 0,
    'forgetting is a mark, not a deletion')
})

test('default half-life constant is exposed for the docs', () => {
  assert.equal(DEFAULT_HALF_LIFE_DAYS, 21)
})

/**
 * The character must grow, but the user must keep the last word, and the
 * assistant must stay able to disagree.
 *
 * The tests below pin the three rules the design rests on:
 *
 *  1. Being corrected and being overruled are opposite signals. A correction
 *     ("you were wrong") must not teach the assistant to stop speaking up;
 *     an overruled objection is a decision, not a mistake.
 *  2. Growth is slow, bounded and requires evidence — one turn cannot create or
 *     erase a personality.
 *  3. Anything the user decided is untouchable by growth, and always erasable.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createBrainAt } from './helpers.js'
import {
  TRAITS, character, classifyReply, detectsTraitRequest, learnCharacter, manage,
  personalityBounds, renderCharacter,
} from '../src/core/personality.js'

/** The value of one trait, creating nothing. */
const valueOf = (store, key) => store.data.personality.traits[key]?.value ?? 0.5

/** Evidence attached to one trait. */
const evidenceOf = (store, key) => store.data.personality.traits[key]?.evidence ?? 0

test('character: classification separates a mistake from a decision', () => {
  // Being corrected about a fact is a failure of the assistant.
  assert.equal(classifyReply('不对，这个 API 在 v3 里已经删了'), 'corrected')
  assert.equal(classifyReply('哪有这个函数，你是不是编的'), 'corrected')
  // Overruling an objection is the user deciding, not the assistant failing.
  assert.equal(classifyReply('我知道风险，就按我说的办'), 'overruled')
  assert.equal(classifyReply('有道理，是我疏忽了'), 'accepted')
  assert.equal(classifyReply(''), 'silent')
})

test('character: an accepted objection makes it speak up more', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  const before = valueOf(store, 'skepticism')
  for (let index = 0; index < 4; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism', topic: '数据来源不可靠' } })
  }
  assert.ok(valueOf(store, 'skepticism') > before, 'accepted objections should strengthen skepticism')
})

test('character: being corrected never suppresses the habit of disagreeing', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  // Baseline the habit with a few accepted objections.
  for (let index = 0; index < 6; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism', topic: 'x' } })
  }
  const established = valueOf(store, 'skepticism')
  // Then the user reports several hallucinations - the worst case for trust.
  for (let index = 0; index < 10; index += 1) {
    learnCharacter(store, { kind: 'corrected' })
  }
  const after = valueOf(store, 'skepticism')
  assert.ok(after > 0.4, `skepticism must stay workable, got ${after}`)
  assert.ok(after < established, 'it should recede somewhat, but only somewhat')
  // What a correction must fix is courage of assertion, not willingness to speak.
  assert.ok(valueOf(store, 'caution') > 0.5, 'corrections should raise caution')
})

test('character: being overruled records a decision and keeps the judgement', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  const before = valueOf(store, 'skepticism')
  learnCharacter(store, {
    kind: 'overruled',
    challenge: { trait: 'skepticism', topic: '这个迁移会丢数据', subject: 'mig' },
  })
  // Overruling must not teach silence: the habit holds or grows, never drops.
  assert.ok(valueOf(store, 'skepticism') >= before, 'an overruled objection must not weaken skepticism')
  const decided = store.data.personality.decided
  assert.equal(decided.length, 1)
  assert.ok(decided[0].topic.includes('迁移'))
})

test('character: growth is one step per turn and cannot leave its bounds', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  const before = valueOf(store, 'skepticism')
  const { changes } = learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism' } })
  const moved = changes.find(change => change.key === 'skepticism')
  assert.ok(moved !== undefined)
  assert.ok(Math.abs(moved.delta) <= personalityBounds.step + 1e-9, 'one turn moves at most one step')

  for (let index = 0; index < 200; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism' } })
  }
  assert.ok(valueOf(store, 'skepticism') <= personalityBounds.max, 'must stay inside the upper bound')
  assert.ok(before < personalityBounds.max)
})

test('character: nothing is described before there is evidence', () => {
  const { brain } = createBrainAt()
  const born = character(brain.store)
  for (const trait of born.traits) {
    assert.equal(trait.stance, '尚未成型', `${trait.key} should not be asserted yet`)
  }
  assert.equal(renderCharacter(brain.store), '', 'an evidence-free character contributes no prompt text')
})

test('character: a trait with evidence reaches the system prompt', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  for (let index = 0; index < 5; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism' } })
  }
  const rendered = renderCharacter(store)
  assert.ok(rendered.includes('质疑'), 'the established trait should be named')
  assert.ok(rendered.includes('分歧由用户决定'), 'the user must always keep the last word')
  assert.ok(rendered.includes('先指出来'), 'it must stay able to disagree')
})

test('character: a user request is applied at once and marked as theirs', () => {
  const asked = detectsTraitRequest('以后直接说，别绕弯')
  assert.equal(asked?.key, 'directness')
  const { brain } = createBrainAt()
  const store = brain.store
  const result = manage(store, { action: 'set', key: 'directness', state: 'wanted', value: 0.8 })
  assert.equal(result.ok, true)
  assert.equal(valueOf(store, 'directness'), 0.8)
  assert.equal(store.data.personality.traits.directness.state, 'wanted')
})

test('character: a locked trait ignores growth entirely', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  manage(store, { action: 'set', key: 'skepticism', value: 0.3, state: 'locked' })
  for (let index = 0; index < 20; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism' } })
  }
  assert.equal(valueOf(store, 'skepticism'), 0.3, 'growth must not move a locked trait')
})

test('character: erase forgets what was learned and restores the default', () => {
  const { brain } = createBrainAt()
  const store = brain.store
  for (let index = 0; index < 8; index += 1) {
    learnCharacter(store, { kind: 'accepted', challenge: { trait: 'skepticism' } })
  }
  assert.ok(evidenceOf(store, 'skepticism') > 0)
  const result = manage(store, { action: 'erase', key: 'skepticism' })
  assert.equal(result.ok, true)
  assert.equal(evidenceOf(store, 'skepticism'), 0, 'erase must drop the evidence too')
  assert.equal(valueOf(store, 'skepticism'), 0.5)
})

test('character: an unknown trait is refused with a Chinese message', () => {
  const { brain } = createBrainAt()
  const result = manage(brain.store, { action: 'set', key: 'chrisma', value: 0.9 })
  assert.equal(result.ok, false)
  assert.match(String(result.error), /未知的性格维度/)
})

test('character: every trait has a Chinese label and description', () => {
  for (const [key, meta] of Object.entries(TRAITS)) {
    assert.match(key, /^[a-z]+$/)
    assert.match(meta.label, /[\u4e00-\u9fff]/, `${key} needs a Chinese label`)
    assert.match(meta.zh, /[\u4e00-\u9fff]/, `${key} needs a Chinese description`)
  }
})

test('character: a legacy brain file without a personality still loads', () => {
  const { brain } = createBrainAt()
  // Simulate the pre-personality schema, then reach for it as a fresh turn would.
  delete brain.store.data.personality
  const grown = learnCharacter(brain.store, { kind: 'accepted', challenge: { trait: 'caution' } })
  assert.ok(grown.changes.length > 0, 'a missing personality block must be created, not throw')
  assert.ok(character(brain.store).traits.length === Object.keys(TRAITS).length)
})

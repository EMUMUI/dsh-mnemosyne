import assert from 'node:assert/strict'
import { test } from 'node:test'

import { rank, recall, relevanceOf, renderWorkingSet, workingSet } from '../src/core/recall.js'
import { termWeights } from '../src/core/text.js'
import { classifyFollowUp, health, noteOutcome, selfTune, usageSummary } from '../src/core/self.js'
import { createBrainAt } from './helpers.js'

test('rank prefers relevant, important, strong memories', () => {
  const { brain } = createBrainAt()
  const relevant = brain.remember({ content: '部署脚本在 scripts/deploy.ps1，用 pnpm build', kind: 'fact', salience: 0.8 })
  brain.remember({ content: '用户喜欢简洁的回答', kind: 'fact', salience: 0.4 })
  brain.remember({ content: '上个月的销售数据在这里', kind: 'fact', salience: 0.4 })
  const hits = rank(brain.store.items('all'), '部署脚本在哪', {
    now: brain.now(), tuning: brain.store.tuning,
  })
  assert.equal(hits[0].item.id, relevant.id)
  assert.ok(hits[0].parts.relevance > 0.3)
})

test('relevance is query-normalised', () => {
  const profile = termWeights('部署脚本')
  assert.equal(relevanceOf(profile, '部署脚本', '部署脚本在 scripts'), 1)
  const diluted = termWeights('部署脚本 deploy.sh')
  assert.ok(relevanceOf(diluted, '部署脚本 deploy.sh', '部署脚本') <= 1)
  assert.equal(relevanceOf(new Map(), '任何', '任何'), 0)
  // Coverage, not raw counts: knowing half the query is half as relevant.
  const covered = relevanceOf(diluted, '部署脚本 完全无关的词', '部署脚本')
  assert.ok(covered > 0 && covered <= 1, `expected partial coverage, got ${covered}`)
})

test('working set always carries standing preferences, bounded by chars', () => {
  const { brain } = createBrainAt({ config: { workingSetMaxChars: 600 } })
  brain.remember({ content: '以后所有回复都用中文，并且先给结论再给理由', kind: 'preference', pinned: true })
  for (let index = 0; index < 30; index += 1) {
    brain.remember({ content: `无关的旧记忆第 ${index} 条，内容比较长一些用来占位测试预算限制`, kind: 'fact', force: true })
  }
  const set = workingSet(brain.store, {
    query: '帮我写个函数', maxChars: 600, recallMaxItems: 3, recallMinScore: 2.6, maxProfileEntries: 12, include: {},
  })
  assert.ok(set.text.includes('以后所有回复都用中文'))
  assert.ok(set.text.length <= 700, `working set too large: ${set.text.length}`)
  assert.ok(set.text.includes('长期偏好'))
})

test('habituation damps repeated injection of the same item', () => {
  const { brain } = createBrainAt()
  const saved = brain.remember({ content: '数据库是 SQLite，文件在 data/app.db', kind: 'fact', salience: 0.7 })
  const base = rank(brain.store.items('all'), '数据库在哪', { now: brain.now(), tuning: brain.store.tuning })
  const habituated = rank(brain.store.items('all'), '数据库在哪', {
    now: brain.now(), tuning: brain.store.tuning, habituation: new Map([[saved.id, 3]]),
  })
  assert.ok(habituated[0].score < base[0].score)
})

test('recall includes forgotten items only on request, and reports retention', () => {
  const clock = createBrainAt({ config: { halfLifeDays: 2 } })
  const { brain } = clock
  const saved = brain.remember({ content: '很久以前的项目代号是 Phoenix', kind: 'fact', force: true })
  brain.store.find(saved.id).strength = 0.5
  // Just past the floor: the memory is no longer active, but the record is
  // still there and an explicit recall can dig it up.
  clock.advance(8 * 86_400_000)
  brain.consolidate()
  assert.ok(brain.store.find(saved.id) === undefined, 'past the floor: no longer active')
  assert.equal(brain.store.find(saved.id, { includeForgotten: true }).forgottenAt > 0, true)
  assert.equal(recall(brain.store, '项目代号', { minScore: 1.5 }).length, 0, 'default recall does not resurrect it')
  const recovered = recall(brain.store, '项目代号', { minScore: 1.5, includeForgotten: true })
  assert.equal(recovered.length, 1, 'prompting can recover a forgotten memory')
  assert.ok(recovered[0].retention < 0.5, `retention ${recovered[0].retention} should read as faded`)
})

test('renderWorkingSet labels sections and renders nothing when empty', () => {
  assert.equal(renderWorkingSet([], 500), '')
  const text = renderWorkingSet([{ item: { id: 'x-1', content: '偏好内容' }, score: 1, part: 'preference' }], 500)
  assert.ok(text.includes('长期偏好'))
  assert.ok(text.includes('[x-1]'))
})

test('classifyFollowUp reads acceptance, correction and silence', () => {
  assert.equal(classifyFollowUp(''), 'silent')
  assert.equal(classifyFollowUp('好的'), 'accept')
  assert.equal(classifyFollowUp('嗯，继续'), 'accept')
  assert.equal(classifyFollowUp('不对，我说过用英文'), 'correct')
  assert.equal(classifyFollowUp('that\'s wrong'), 'correct')
  assert.equal(classifyFollowUp('数据库迁移脚本在哪？'), 'neutral', 'a question is not evidence of fit')
  assert.equal(classifyFollowUp('这是一段很长很长的中性陈述。'.repeat(8)), 'accept')
})

test('behaviour fit adapts to corrections and acceptance', () => {
  const { brain } = createBrainAt()
  const start = brain.store.tuning.behaviorFit
  noteOutcome(brain.store, { kind: 'correct', injected: 2 })
  noteOutcome(brain.store, { kind: 'correct', injected: 2 })
  assert.ok(brain.store.tuning.behaviorFit < start)
  assert.ok(brain.store.tuning.recallThreshold > 2.6, 'a correction hardens the recall gate')
  const hardened = brain.store.tuning.recallThreshold
  for (let index = 0; index < 10; index += 1) noteOutcome(brain.store, { kind: 'accept', injected: 1 })
  assert.ok(brain.store.tuning.behaviorFit > 0.5)
  assert.equal(brain.store.tuning.recallThreshold, hardened)
})

test('silent turns and turns without injection never move the fit', () => {
  const { brain } = createBrainAt()
  const before = { ...brain.store.tuning }
  noteOutcome(brain.store, { kind: 'silent', injected: 3 })
  noteOutcome(brain.store, { kind: 'correct', injected: 0 })
  assert.deepEqual(brain.store.tuning, before)
})

test('selfTune stays inside its bounds and records why it moved', () => {
  const { brain } = createBrainAt()
  for (let index = 0; index < 40; index += 1) {
    brain.remember({ content: `长期记忆条目 ${index}，关于项目 ${index % 7} 的细节`, kind: 'fact', force: true })
  }
  brain.store.tuning.observations = 40
  brain.store.tuning.behaviorFit = 0.1
  const result = selfTune(brain.store)
  assert.ok(result.changes.length >= 1)
  assert.ok(brain.store.tuning.recallThreshold >= 1.6 && brain.store.tuning.recallThreshold <= 4.5)
  const events = brain.store.data.events.filter(event => event.type === 'tune')
  assert.ok(events.length >= 1, 'each change is logged with its reason')
  // Repeated passes never escape the bounds.
  for (let index = 0; index < 200; index += 1) selfTune(brain.store)
  assert.ok(brain.store.tuning.recallThreshold <= 4.5)
  assert.ok(brain.store.tuning.halfLifeDays <= 120 && brain.store.tuning.halfLifeDays >= 3)
})

test('health reports an empty brain honestly', () => {
  const { brain } = createBrainAt()
  const report = health(brain.store)
  assert.equal(report.items, 0)
  assert.equal(report.forgotten, 0)
  assert.ok(report.advice.some(line => line.includes('记忆还是空的')))
  brain.remember({ content: '有内容的记忆', kind: 'fact', force: true })
  const second = health(brain.store)
  assert.equal(second.items, 1)
  assert.equal(usageSummary(brain.store).items, 1)
})

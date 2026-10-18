import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createBrain, iso } from '../src/brain.js'
import { normalizeConfig } from '../src/config.js'
import { createBrainAt } from './helpers.js'

test('config: defaults, validation and path resolution', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.autoLearn, true)
  assert.equal(cfg.privacyMode, 'excerpt')
  assert.equal(cfg.workingSetMaxChars, 2200)
  assert.throws(() => normalizeConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => normalizeConfig({ autoLearn: 'yes' }), /must be a boolean/)
  assert.throws(() => normalizeConfig({ halfLifeDays: -1 }), /halfLifeDays/)
  assert.throws(() => normalizeConfig({ privacyMode: 'raw' }), /privacyMode/)
})

test('store: remember, near-duplicate merge, subject-keyed supersession', () => {
  const { brain } = createBrainAt()
  const first = brain.remember({ content: '以后回复都用中文', kind: 'preference' })
  assert.equal(first.action, 'created')
  assert.equal(first.store, 'semantic')

  const restated = brain.remember({ content: '以后回复都用中文。', kind: 'preference' })
  assert.equal(restated.action, 'merged', 'a restatement reinforces instead of duplicating')

  const revised = brain.remember({ content: '以后回复都用英文', kind: 'preference' })
  // Same family subject, nearly identical wording: a revision, not a new note.
  assert.ok(['superseded', 'merged'].includes(revised.action))
  const active = brain.store.items('semantic')
  assert.ok(active.every(item => item.content.includes('中文') || item.content.includes('英文')))
  const superseded = brain.store.items('semantic', { includeForgotten: true }).filter(item => item.supersededBy)
  if (revised.action === 'superseded') assert.equal(superseded.length, 1)
})

test('store: different subjects never swallow each other', () => {
  const { brain } = createBrainAt()
  const a = brain.remember({ content: '以后回复都用中文', kind: 'preference' })
  const b = brain.remember({ content: '以后回复要简洁一点', kind: 'preference' })
  assert.equal(b.action, 'created')
  const active = brain.store.items('semantic')
  assert.equal(active.length, 2)
  assert.notEqual(active[0].key, active[1].key)
  assert.ok(active.some(item => item.id === a.id))
})

test('store: disk round trip is atomic and lossless', () => {
  const { brain, dir } = createBrainAt()
  const saved = brain.remember({ content: '项目使用 pnpm 管理依赖', kind: 'fact', tags: ['tooling'] })
  brain.save()
  const file = path.join(dir, 'brain.json')
  assert.ok(fs.existsSync(file))
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.kind, 'dsh-mnemosyne')
  assert.equal(raw.episodic.length, 1)
  assert.equal(raw.episodic[0].id, saved.id)
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), [])

  const reloaded = createBrain({ memoryFile: file, config: {} })
  assert.equal(reloaded.recall({ query: 'pnpm 依赖' })[0].id, saved.id)
})

test('store: a corrupt file is preserved, not fatal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-corrupt-'))
  const file = path.join(dir, 'brain.json')
  fs.writeFileSync(file, '{"episodic": [ this is not json')
  const warnings = []
  const brain = createBrain({ memoryFile: file, warn: message => warnings.push(message) })
  assert.equal(brain.store.items('all').length, 0)
  assert.ok(warnings.some(message => message.includes('moved')))
  assert.ok(fs.readdirSync(dir).some(name => name.includes('.corrupt-')))
  // It keeps working and writes a fresh file.
  brain.remember({ content: '新的记忆仍在工作', kind: 'fact' })
  brain.save()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).episodic.length, 1)
})

test('store: forgotten memories are recoverable, discarded ones are gone', () => {
  const { brain } = createBrainAt()
  const saved = brain.remember({ content: '这是一条会被忘记的记忆', kind: 'fact', force: true })
  brain.manage({ action: 'forget', ids: [saved.id] })
  assert.equal(brain.store.items('episodic').length, 0)
  assert.equal(brain.recall({ query: '会被忘记' }).length, 0)
  assert.equal(brain.recall({ query: '会被忘记', includeForgotten: true }).length, 1)
  brain.manage({ action: 'restore', ids: [saved.id] })
  assert.equal(brain.store.items('episodic').length, 1)

  brain.manage({ action: 'discard', ids: [saved.id] })
  assert.equal(brain.store.items('episodic', { includeForgotten: true }).length, 0)
  assert.equal(brain.recall({ query: '会被忘记', includeForgotten: true }).length, 0)
})

test('store: secrets never reach disk', () => {
  const { brain, dir } = createBrainAt()
  brain.remember({ content: '我的 GitHub token 是 ghp_abcdefghijklmnopqrstuvwxyz0123456789', kind: 'fact', force: true })
  brain.save()
  const text = fs.readFileSync(path.join(dir, 'brain.json'), 'utf8')
  assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'))
  assert.ok(text.includes('[redacted]'))
})

test('store: iso() formats timestamps', () => {
  assert.equal(iso(0), '')
  assert.equal(iso(Date.parse('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z')
})

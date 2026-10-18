import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractLearning, isCorrection, learnFromTurn, predictCommands } from '../src/core/learn.js'
import { extractCommandFromUserText, subjectOf } from '../src/core/patterns.js'
import { normalizeText, redactSecrets, salience, similarity, tokenize } from '../src/core/text.js'
import { createBrainAt } from './helpers.js'

test('tokenize handles mixed Chinese and identifiers', () => {
  const tokens = tokenize('用 pnpm 安装依赖，然后运行 dsh-mnemosyne')
  assert.ok(tokens.includes('pnpm'))
  assert.ok(tokens.includes('dsh-mnemosyne'))
  assert.ok(tokens.some(token => token.length === 2 && /^[\u4e00-\u9fff]{2}$/.test(token)))
  assert.ok(!tokens.includes('的'), 'stop words are dropped')
})

test('normalizeText strips injected context', () => {
  const text = normalizeText('帮我看看<system-reminder>hidden</system-reminder>这个问题\n\n\n下一行')
  assert.ok(!text.includes('hidden'))
  assert.ok(text.includes('帮我看看'))
  assert.ok(!text.includes('\n\n\n'))
})

test('redaction removes credentials', () => {
  assert.ok(!redactSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('ghp_abc'))
  assert.ok(redactSecrets('api_key: sk-abcdefghijklmnop1234').includes('[redacted]'))
  assert.ok(redactSecrets('普通文本不受影响').includes('普通文本'))
})

test('salience ranks instructions above chatter', () => {
  assert.ok(salience('以后所有回复都必须先给结论再给理由') > salience('今天天气不错'))
  assert.ok(salience('这是第 42 号端口，路径是 D:/x/y') > salience('嗯'))
})

test('similarity is symmetric and bounded', () => {
  assert.equal(similarity('用 pnpm 安装依赖', '用 pnpm 安装依赖'), 1)
  assert.ok(similarity('用 pnpm 安装依赖', '今天天气不错') < 0.2)
  const a = similarity('用户喜欢简洁', '简洁的回答')
  const b = similarity('简洁的回答', '用户喜欢简洁')
  assert.equal(a, b)
})

test('preferences are extracted from natural language', () => {
  const result = extractLearning('以后回答都用中文，简洁一点。我们的项目叫 AI知识图谱，用 pnpm 管理依赖。')
  assert.ok(result.preferences.length >= 1, 'language preference found')
  assert.ok(result.preferences.some(pref => /中文/.test(pref.content)))
  assert.ok(result.memories.some(memory => /AI知识图谱/.test(memory.content)), 'project fact kept')
})

test('explicit remember requests always make it into memory', () => {
  const result = extractLearning('记住：部署脚本在 scripts/deploy.ps1')
  assert.equal(result.memories.length, 1)
  assert.ok(result.memories[0].content.includes('deploy.ps1'))
})

test('corrections are recognised', () => {
  assert.equal(isCorrection('不对，应该用 pnpm 而不是 npm'), true)
  assert.equal(isCorrection('that\'s wrong, use pnpm'), true)
  assert.equal(isCorrection('好的，继续'), false)
})

test('commands are recognised instead of learned as prose', () => {
  assert.equal(extractCommandFromUserText('The user sent a command: run tests'), 'run tests')
  assert.equal(extractCommandFromUserText('/plan 重构记忆模块'), 'plan 重构记忆模块')
  assert.equal(extractCommandFromUserText('帮我把记忆模块重构一下'), null)
})

test('subject keys separate distinct families', () => {
  assert.equal(subjectOf('以后回复都用中文'), subjectOf('以后回答都要用中文'))
  assert.notEqual(subjectOf('以后回复都用中文'), subjectOf('以后都用 pnpm 管理依赖'))
  // Two directives about different things must not supersede each other.
  const language = subjectOf('以后所有回复都用中文，简洁一点。')
  const commit = subjectOf('不对，提交信息要用英文，不是中文。')
  assert.notEqual(language, commit)
})

test('a correction does not wipe an unrelated preference', () => {
  const { brain } = createBrainAt()
  brain.remember({ content: '以后所有回复都用中文，简洁一点。', kind: 'preference' })
  brain.remember({ content: '不对，提交信息要用英文，不是中文。', kind: 'preference' })
  const active = brain.store.items('semantic')
  assert.equal(active.length, 2, 'the commit-message rule replaces nothing')
})

test('technology facts are learned as facts', () => {
  const result = extractLearning('数据库用 SQLite，文件在 data/app.db。')
  assert.ok(result.memories.some(memory => /SQLite/.test(memory.content)), JSON.stringify(result.memories))
})

test('a full turn produces preferences, facts and command patterns', () => {
  const { brain } = createBrainAt()
  const result = learnFromTurn(brain.store, {
    user: '记住：部署用 pnpm build，告诉我用中文。我们的服务器是 Windows。',
    cwd: 'D:/proj',
    sessionId: 's1',
    toolCalls: [{ name: 'bash', args: { command: 'pnpm build' } }],
    toolOutcomes: new Map([['bash', { ok: true }]]),
    injected: [],
  }, brain.config)
  assert.ok(result.learned.length >= 1)
  assert.equal(brain.store.items('commands').length, 1)
  assert.equal(brain.store.items('commands')[0].content, 'pnpm build')
  assert.ok(brain.store.data.stats.turnsObserved >= 1)
})

test('failed commands are not remembered as patterns', () => {
  const { brain } = createBrainAt()
  learnFromTurn(brain.store, {
    user: '帮我构建一下项目',
    cwd: 'D:/proj',
    sessionId: 's1',
    toolCalls: [{ name: 'bash', args: { command: 'pnpm build --broken' } }],
    toolOutcomes: new Map([['bash', { ok: false }]]),
    injected: [],
  }, brain.config)
  assert.equal(brain.store.items('commands').length, 0)
})

test('predicted commands match a similar goal', () => {
  const { brain } = createBrainAt()
  learnFromTurn(brain.store, {
    user: '安装前端依赖',
    cwd: 'D:/proj',
    sessionId: 's1',
    toolCalls: [{ name: 'bash', args: { command: 'pnpm install --frozen-lockfile' } }],
    toolOutcomes: new Map([['bash', { ok: true }]]),
    injected: [],
  }, brain.config)
  const matches = predictCommands(brain.store, '安装前端依赖')
  assert.equal(matches.length, 1)
  assert.ok(matches[0].item.content.includes('pnpm install'))
})

test('a correction weakens the memory it contradicts', () => {
  const { brain } = createBrainAt()
  const saved = brain.remember({ content: '提交信息用中文', kind: 'preference' })
  const item = brain.store.find(saved.id)
  item.hits = 0
  item.strength = 1
  learnFromTurn(brain.store, {
    user: '不对，提交信息要用英文，不是中文',
    cwd: 'D:/proj',
    sessionId: 's1',
    toolCalls: [],
    toolOutcomes: new Map(),
    injected: [item],
  }, brain.config)
  assert.ok(brain.store.find(saved.id).strength < 1, 'the corrected memory lost strength')
})

test('one turn is journaled once even when a session is re-opened', () => {
  const { brain } = createBrainAt()
  const turn = { user: '记住：这个项目用 pnpm', cwd: 'D:/proj', sessionId: 's1', turn: 1, toolCalls: [], toolOutcomes: new Map(), injected: [] }
  learnFromTurn(brain.store, { ...turn, dedupe: true }, brain.config)
  learnFromTurn(brain.store, { ...turn, dedupe: true }, brain.config)
  assert.equal(brain.store.data.journal.length, 1, 'the repeated observation extends the same entry')
  assert.equal(brain.store.data.stats.turnsObserved, 1)
  // A genuinely new turn is always journaled, even with identical wording.
  learnFromTurn(brain.store, { ...turn, turn: 2, dedupe: true }, brain.config)
  assert.equal(brain.store.data.journal.length, 2)
})

test('privacy mode excerpt-free keeps no verbatim text', () => {
  const { brain } = createBrainAt({ config: { privacyMode: 'excerpt-free' } })
  const result = learnFromTurn(brain.store, {
    user: '记住：这个客户非常在意隐私，邮件里不要出现任何内部代号。',
    cwd: '',
    sessionId: 's1',
    toolCalls: [],
    toolOutcomes: new Map(),
    injected: [],
  }, brain.config)
  assert.ok(result.learned.length >= 1)
  const stored = brain.store.items('all')
  assert.ok(stored.length > 0)
  assert.ok(stored.every(item => item.content.length <= 200))
})

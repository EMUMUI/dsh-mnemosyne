import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildTools } from '../src/tools.js'
import { createBrainAt } from './helpers.js'

const tools = brain => new Map(buildTools(brain, { context: () => ({ project: 'proj' }) }).map(tool => [tool.name, tool]))

const run = (definition, args) => definition.execute(args, { agent: undefined, signal: new AbortController().signal })

test('tools: every tool is a valid ToolDefinition', () => {
  const { brain } = createBrainAt()
  const all = [...tools(brain).values()]
  assert.equal(all.length, 12)
  for (const tool of all) {
    assert.match(tool.name, /^mnemosyne_[a-z]+$/)
    assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.output.schema !== undefined)
  }
  assert.equal(new Set(all.map(tool => tool.name)).size, 12, 'names are unique')
})

test('tools: remember defaults to a fact and derives the store from the kind', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  const fact = await run(map.get('mnemosyne_remember'), { content: '仓库在 D:/work/shop' })
  assert.equal(fact.store, 'episodic')
  const preference = await run(map.get('mnemosyne_remember'), { content: '以后都用 pnpm', kind: 'preference' })
  assert.equal(preference.store, 'semantic')
  const command = await run(map.get('mnemosyne_remember'), { content: 'pnpm build', kind: 'command' })
  assert.equal(command.store, 'commands')
})

test('tools: remember attaches the calling project', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  const result = await run(map.get('mnemosyne_remember'), { content: '这个项目的测试用 vitest', kind: 'fact' })
  assert.equal(brain.store.find(result.id).project, 'proj')
})

test('tools: recall, profile and stats reflect what was stored', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  await run(map.get('mnemosyne_remember'), { content: '部署脚本在 scripts/deploy.ps1', kind: 'fact' })
  const recalled = await run(map.get('mnemosyne_recall'), { query: '部署脚本' })
  assert.equal(recalled.count, 1)
  assert.ok(recalled.memories[0].retention > 0.9)

  const profile = await run(map.get('mnemosyne_profile'), {})
  assert.ok(Array.isArray(profile.preferences))
  const stats = await run(map.get('mnemosyne_stats'), {})
  assert.equal(stats.stats.memoriesLearned + stats.stats.preferencesLearned, 1)
})

test('tools: update, pin, forget, restore and discard by id', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  const saved = await run(map.get('mnemosyne_remember'), { content: '旧的说法', kind: 'fact' })

  const updated = await run(map.get('mnemosyne_update'), { action: 'update', ids: [saved.id], content: '新的说法' })
  assert.equal(updated.results[0].ok, true)
  assert.equal(brain.store.find(saved.id).content, '新的说法')

  const pinned = await run(map.get('mnemosyne_update'), { ids: saved.id, pinned: true })
  assert.equal(pinned.results[0].ok, true)
  assert.equal(brain.store.find(saved.id).pinned, true)

  await run(map.get('mnemosyne_forget'), { mode: 'soft', ids: [saved.id] })
  assert.equal(brain.store.find(saved.id), undefined)
  await run(map.get('mnemosyne_forget'), { restore: true, ids: [saved.id] })
  assert.ok(brain.store.find(saved.id) !== undefined)
  await run(map.get('mnemosyne_forget'), { mode: 'hard', ids: [saved.id] })
  assert.equal(brain.store.find(saved.id, { includeForgotten: true }), undefined)
})

test('tools: forget by query', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  await run(map.get('mnemosyne_remember'), { content: '这个临时细节不要留着了', kind: 'fact' })
  const result = await run(map.get('mnemosyne_forget'), { mode: 'soft', query: '临时细节' })
  assert.equal(result.forgotten.length, 1)
  assert.equal(brain.store.items('all').length, 0)
})

test('tools: consolidate preview does not mutate', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  await run(map.get('mnemosyne_remember'), { content: '会被整合的内容', kind: 'fact' })
  const before = JSON.stringify(brain.store.items('all', { includeForgotten: true }))
  const preview = await run(map.get('mnemosyne_consolidate'), { preview: true })
  assert.equal(preview.result.preview, true)
  assert.equal(JSON.stringify(brain.store.items('all', { includeForgotten: true })), before)
})

test('tools: commands tool matches a learned goal', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  brain.learnTurn({
    user: '安装前端依赖',
    cwd: '',
    sessionId: 's',
    toolCalls: [{ name: 'bash', args: { command: 'pnpm install' } }],
    toolOutcomes: new Map([['bash', { ok: true }]]),
    injected: [],
  })
  const result = await run(map.get('mnemosyne_commands'), { goal: '安装前端依赖' })
  assert.equal(result.matches.length, 1)
  assert.match(result.matches[0].command, /pnpm install/)
})

test('tools: invalid arguments fail loudly', async () => {
  const { brain } = createBrainAt()
  const map = tools(brain)
  await assert.rejects(() => run(map.get('mnemosyne_remember'), { content: '   ' }), /不能为空/)
  await assert.rejects(() => run(map.get('mnemosyne_recall'), { query: '' }), /不能为空/)
  await assert.rejects(() => run(map.get('mnemosyne_remember'), { content: 'x', store: 'nope' }), /store 必须是/)
})

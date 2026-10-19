/**
 * The plugin ships for a Chinese-speaking user, so every string a model or a
 * person can read must be Chinese: tool descriptions, parameter descriptions,
 * self-tuning log lines, health advice, injected text and error messages.
 *
 * This test walks the tool definitions and the core modules and rejects prose
 * that is predominantly English. Identifiers, enum values, ids and technical
 * tokens (JSON schema keywords, `mnemosyne_*`, `halfLifeDays`) are allowed;
 * what it catches is a sentence written in English.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildTools } from '../src/tools.js'
import { createBrainAt } from './helpers.js'

/** Words that are technical tokens rather than English prose. */
const ALLOWED = new Set([
  'id', 'ids', 'json', 'preview', 'pinned', 'salience', 'store', 'kind', 'tags',
  'title', 'content', 'query', 'limit', 'goal', 'mode', 'soft', 'hard', 'restore',
  'reason', 'episodic', 'semantic', 'commands', 'all', 'true', 'false', 'null',
  'preference', 'fact', 'decision', 'lesson', 'command', 'includeForgotten',
  'mnemosyne', 'pnpm', 'sqlite', 'windows', 'bash', 'pwsh',
])

/** Latin words in a string, lower-cased, longest first. */
function latinWords(text) {
  return (String(text).match(/[A-Za-z][A-Za-z_]{2,}/g) ?? []).map(word => word.toLowerCase())
}

/** Whether a chunk of text is mostly English prose. */
function looksEnglish(text) {
  const words = latinWords(text).filter(word =>
    !ALLOWED.has(word)
    && !word.startsWith('mnemosyne')
    // camelCase setting names are configuration, not prose
    && !/^[a-z]+[A-Z]/.test(word),
  )
  const han = (String(text).match(/[\u4e00-\u9fff]/g) ?? []).length
  return words.length >= 3 && han === 0
}

test('i18n: every tool description is Chinese', () => {
  const { brain } = createBrainAt()
  const failures = []
  for (const tool of buildTools(brain)) {
    if (looksEnglish(tool.description)) failures.push(`${tool.name} 的描述是英文`)
    for (const [param, schema] of Object.entries(tool.parameters ?? {})) {
      if (schema?.description !== undefined && looksEnglish(schema.description)) {
        failures.push(`${tool.name}.${param} 的说明是英文`)
      }
    }
  }
  assert.deepEqual(failures, [], `英文文案需要改成中文：\n${failures.join('\n')}`)
})

test('i18n: user-facing error messages are Chinese', async () => {
  const { brain } = createBrainAt()
  const map = new Map(buildTools(brain).map(tool => [tool.name, tool]))
  const run = (name, args) => map.get(name).execute(args, { signal: new AbortController().signal })

  const errors = []
  for (const [name, args] of [
    ['mnemosyne_remember', { content: '   ' }],
    ['mnemosyne_recall', { query: '' }],
    ['mnemosyne_recall', { query: 'x', store: 'nope' }],
    ['mnemosyne_update', { ids: ['does-not-exist'], content: 'x' }],
    ['mnemosyne_forget', { ids: ['does-not-exist'] }],
  ]) {
    try {
      await run(name, args)
    } catch (error) {
      errors.push(String(error.message))
    }
  }
  // The tools that report instead of throwing still must not answer in English.
  for (const name of ['mnemosyne_update', 'mnemosyne_forget']) {
    const value = await run(name, { ids: ['does-not-exist'], content: 'x' })
    errors.push(...JSON.stringify(value).match(/"error":"([^"]*)"/g)?.map(raw => JSON.parse(`{${raw}}`).error) ?? [])
  }
  assert.ok(errors.length > 0, 'expected some error messages to inspect')
  const english = errors.filter(message => looksEnglish(message))
  assert.deepEqual(english, [], `英文错误信息：\n${english.join('\n')}`)
})

test('i18n: consolidation digests are Chinese', async () => {
  const { brain, advance } = createBrainAt()
  for (let index = 0; index < 4; index += 1) {
    brain.learnTurn({
      user: `第 ${index} 轮，聊的是构建流程`,
      cwd: 'D:/work/shop',
      sessionId: 's',
      toolCalls: [],
      toolOutcomes: new Map(),
      injected: [],
    })
    advance(60_000)
  }
  const report = brain.consolidate()
  const digest = brain.store.find(report.digest, { includeForgotten: true })
  assert.ok(digest !== undefined, 'consolidation should write a digest')
  assert.ok(digest.content.includes('会话摘要'), `摘要正文应为中文：${digest.content.slice(0, 60)}`)
  assert.ok(digest.title.includes('摘要'), `摘要标题应为中文：${digest.title}`)
  assert.ok(!looksEnglish(digest.content), `摘要正文含英文：${digest.content.slice(0, 80)}`)
})

test('i18n: self-tuning changes and health advice are Chinese', async () => {
  const { brain, now, advance } = createBrainAt()
  for (let index = 0; index < 12; index += 1) {
    brain.learnTurn({
      user: `第 ${index} 轮，随便聊聊`,
      cwd: '',
      sessionId: 's',
      toolCalls: [],
      toolOutcomes: new Map(),
      injected: [],
    })
    advance(60_000)
  }
  const report = brain.health()
  assert.ok(Array.isArray(report.advice))
  for (const line of report.advice) {
    assert.ok(!looksEnglish(line), `英文建议：${line}`)
  }
  const tuned = brain.selfTune()
  for (const line of [...(tuned.changes ?? []), ...(tuned.advice ?? [])]) {
    assert.ok(!looksEnglish(line), `英文调参记录：${line}`)
  }
  // The character reaches the prompt, so its wording is user-facing too.
  for (const entry of brain.character().traits) {
    assert.ok(!looksEnglish(entry.stance), `英文性格描述：${entry.stance}`)
    assert.ok(!looksEnglish(entry.owner), `英文归属：${entry.owner}`)
  }
  void now
})

#!/usr/bin/env node
/**
 * A narrated run of the memory model: no DSH, no model, just the brain.
 *
 *   node scripts/demo.mjs
 *
 * Simulates roughly three months of use over a handful of conversations and
 * prints what the agent would be handed at each turn, which memories fade, and
 * why. Useful both as documentation and as a sanity check after changes.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createBrain } from '../src/brain.js'

const DAY = 86_400_000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosyne-demo-'))
let now = Date.UTC(2026, 0, 1)
const brain = createBrain({
  memoryFile: path.join(dir, 'brain.json'),
  config: { halfLifeDays: 14, workingSetMaxChars: 900 },
  clock: () => now,
})

const line = (char = '─') => console.log(char.repeat(72))
const day = () => `day ${Math.round((now - Date.UTC(2026, 0, 1)) / DAY) + 1}`
const heading = text => { console.log(); line(); console.log(text); line() }
const advance = days => { now += days * DAY }

/** One turn of conversation: learn from it, then show what the next turn gets. */
function turn(user, { assistant = '', toolCalls = [], ok = true } = {}) {
  const before = brain.store.items('all').length
  const learned = brain.learnTurn({
    user,
    assistant,
    cwd: 'D:/work/shop',
    sessionId: 'demo',
    models: ['deepseek-v4'],
    toolCalls,
    toolOutcomes: new Map(toolCalls.map(call => [call.name, { ok }])),
    injected: [],
  })
  const after = brain.store.items('all').length
  console.log(`\n[${day()}] user: ${user}`)
  if (learned.learned.length > 0 || learned.preference !== null) {
    console.log(`  → learned ${learned.learned.length + (learned.preference ? 1 : 0)} item(s), store ${before} → ${after}`)
  } else {
    console.log('  → nothing worth remembering (selection filtered it out)')
  }
}

function showWorkingSet(query) {
  const set = brain.workingSet({ query, project: '' })
  if (set.text === '') return console.log('  (nothing injected: no relevant memory yet)')
  console.log('  injected for the next turn:')
  for (const entry of set.citations) console.log(`    · ${entry.store.padEnd(8)} ${entry.title}`)
}

// ── Act 1: the agent learns who it is working with ──────────────────────────
heading('Act 1 — learning (turn 1–5)')
showWorkingSet('帮我看看这个项目的结构')
turn('以后所有回复都用中文，简洁一点。我们的项目叫 shop，用 pnpm 管理依赖。')
turn('记住：部署脚本在 scripts/deploy.ps1，服务器是 Windows。')
turn('数据库用 SQLite，文件在 data/app.db。')
turn('不对，提交信息要用英文，不是中文。', { assistant: '明白，以后用英文提交信息。' })
turn('安装依赖，然后跑一下构建。', { toolCalls: [{ name: 'bash', args: { command: 'pnpm install' } }] })
showWorkingSet('帮我安装依赖并构建')

// ── Act 2: time passes, unimportant things fade ─────────────────────────────
heading('Act 2 — forgetting (day 6 → day 40)')
advance(34)
const report = brain.consolidate()
console.log(`  consolidation: ${report.forgotten.length} forgotten, digest ${report.digest ?? 'none'}`)
for (const item of brain.store.items('all')) {
  const health = brain.recall({ query: item.title, limit: 1 })[0]
  console.log(`    · ${item.store.padEnd(8)} ${item.title.slice(0, 40).padEnd(42)} strength ${item.strength.toFixed(3)}${health ? '' : '  (faded)'}`)
}
showWorkingSet('部署脚本在哪')

// ── Act 3: reinforcement and the closed loop ────────────────────────────────
heading('Act 3 — reinforcement and self-tuning (day 41 → day 90)')
for (let index = 0; index < 12; index += 1) {
  advance(3)
  const query = index % 3 === 0 ? '部署脚本在哪' : index % 3 === 1 ? '数据库文件在哪' : '安装依赖'
  brain.workingSet({ query, project: '' })
  brain.feedback({ kind: index % 5 === 0 ? 'correct' : 'accept', injected: 2 })
}
brain.selfTune()
const health = brain.health()
console.log(`  behaviour fit: ${health.behaviorFit} over ${health.observations} observations`)
console.log(`  self-tuned: half-life ${health.tuning.halfLifeDays}d, recall gate ${health.tuning.recallThreshold}`)
for (const advice of health.advice) console.log(`  · ${advice}`)

// ── Act 4: what survives ────────────────────────────────────────────────────
heading('Act 4 — the profile that survives')
const profile = brain.workingSet({ query: '帮我继续这个项目', project: '' })
console.log(profile.text || '  (empty)')
line()
console.log(`Store: ${brain.store.filePath}`)
console.log(`Items: ${brain.store.items('all').length} active, ${brain.store.items('all', { includeForgotten: true }).length} on record`)
fs.rmSync(dir, { recursive: true, force: true })

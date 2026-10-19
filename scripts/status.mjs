#!/usr/bin/env node
/**
 * `mnemosyne-status` — print what the memory is actually doing, from the
 * memory file on disk.
 *
 * Reading the file is the honest check: it exists only because the plugin
 * mounted, observed turns and saved. Nothing here needs DSH to be running.
 *
 *   node scripts/status.mjs                 # the active profile's brain
 *   node scripts/status.mjs desktop         # a named profile's brain
 *   DSH_HOME=/some/home node scripts/status.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where DSH keeps its home. */
function dshHome() {
  return process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir()
}

/** The profile name to report on: argv, $DSH_PROFILE, else the desktop app's. */
function profileName() {
  return process.argv[2] || process.env.DSH_PROFILE || 'desktop'
}

/** Candidate memory paths, most specific first. */
function candidates(profile) {
  const home = dshHome()
  const base = path.join(home, '.dsh', 'mnemosyne')
  return [path.join(base, `${profile}.json`), path.join(base, 'default.json')]
}

const profile = profileName()
const found = candidates(profile).find(file => fs.existsSync(file))

if (found === undefined) {
  console.log(`没有找到记忆文件（profile: ${profile}）`)
  console.log(`  查找过: ${candidates(profile).join('\n          ')}`)
  console.log('')
  console.log('这说明插件还没有真正跑起来过。可能原因：')
  console.log('  1. 桌面应用还没重启；')
  console.log('  2. 插件加载时报错，看 crash 日志：')
  console.log(`     ${path.join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'logs')}`)
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync(found, 'utf8'))
const all = [...(data.episodic ?? []), ...(data.semantic ?? []), ...(data.commands ?? [])]
const active = all.filter(item => !item.forgottenAt && !item.discardedAt && !item.supersededBy)
const pinned = active.filter(item => item.pinned)
const stats = data.stats ?? {}
const tuning = data.tuning ?? {}

const ageMinutes = Math.round((Date.now() - (data.updatedAt ?? data.createdAt ?? Date.now())) / 60_000)
const ago = ageMinutes < 1 ? '刚刚'
  : ageMinutes < 60 ? `${ageMinutes} 分钟前`
    : ageMinutes < 1440 ? `${Math.round(ageMinutes / 60)} 小时前`
      : `${Math.round(ageMinutes / 1440)} 天前`
const observed = stats.turnsObserved ?? 0

console.log(`记忆文件: ${found}`)
console.log(`创建于: ${ago}，此时 ${observed} 轮对话被观察到`)
console.log('')
console.log(`记忆: 活跃 ${active.length} 条，全部留档 ${all.length} 条，已固定 ${pinned.length} 条`)
console.log(`学习: 观察 ${stats.turnsObserved ?? 0} 轮，学到 ${(stats.memoriesLearned ?? 0) + (stats.preferencesLearned ?? 0)} 条`)
console.log(`使用: 召回 ${stats.recalls ?? 0} 次，注入 ${stats.injections ?? 0} 次`)
console.log(`契合度: ${tuning.behaviorFit ?? '—'}（基于 ${tuning.observations ?? 0} 次观测）`)
console.log(`自调参: 半衰期 ${tuning.halfLifeDays ?? '—'} 天，召回门槛 ${tuning.recallThreshold ?? '—'}`)

if (pinned.length > 0) {
  console.log('')
  console.log('长期偏好（每轮都会注入）:')
  for (const item of pinned.slice(0, 10)) console.log(`  · ${item.title}`)
}

if (active.length > 0) {
  console.log('')
  console.log('最近记住的:')
  const recent = [...active].sort((a, b) => (b.lastSeenAt ?? b.createdAt ?? 0) - (a.lastSeenAt ?? a.createdAt ?? 0))
  for (const item of recent.slice(0, 8)) {
    const when = new Date(item.createdAt ?? 0).toISOString().slice(0, 10)
    console.log(`  · [${item.store}] ${item.title}  (${when})`)
  }
}

const journal = data.journal ?? []
if (journal.length > 0) {
  console.log('')
  console.log('最近观察到的对话:')
  for (const entry of journal.slice(-5).reverse()) {
    const when = new Date(entry.at).toISOString().slice(5, 16).replace('T', ' ')
    console.log(`  · ${when}  ${entry.oneLine}`)
  }
}

if (observed === 0) {
  console.log('')
  console.log('⚠ 还没有任何一轮对话被观察到 —— 插件虽然能挂载，但还没在会话里跑过。')
  console.log('  重新打开桌面应用，随便聊一句，再运行本命令应该就能看到轮次增加。')
  process.exit(2)
}

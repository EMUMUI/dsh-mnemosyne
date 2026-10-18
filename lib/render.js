/**
 * Model-facing rendering helpers for the host half: the injected working-set
 * block, the system-prompt section, and the status line.
 */

import { userText } from './text.js'

/**
 * Plain text of the user message a hook/observer received.
 * @param {object} message
 * @returns {string}
 */
export function userTextOf(message) {
  return userText(message)
}

/** The standing instruction appended to the injected block, once per session. */
const FIRST_BLOCK_TAGS = '[M]'

/**
 * Wrap the working set for injection.
 *
 * The block is a single logged user message with `source.kind =
 * 'plugin:mnemosyne'`, so it is replayable, auditable, and never mistaken for
 * something the user said. The header states exactly what the model must do
 * with it — including that the current request wins over memory — because a
 * memory that overrides the user is worse than no memory.
 *
 * @param {string} body - `renderWorkingSet` output.
 * @param {{ turn?: number, fit?: number, project?: string, includeStatus?: boolean }} meta
 * @returns {string}
 */
export function renderBlock(body, meta = {}) {
  const taken = body.replace(/^<mnemosyne-memory>\n?/, '').replace(/\n?<\/mnemosyne-memory>\s*$/, '')
  const header = [
    FIRST_BLOCK_TAGS,
    '【Mnemosyne 长期记忆 · plugin:mnemosyne】',
  ]
  if (meta.includeStatus) {
    header.push(`(诊断: turn=${meta.turn ?? '?'} fit=${meta.fit ?? '?'} project=${meta.project ?? ''})`)
  }
  return `${header.join('\n')}\n${taken}`
}

/** The system-prompt section: short, actionable, and honest about limits. */
export function systemSectionText() {
  return [
    '## 长期记忆（Mnemosyne）',
    '你拥有跨会话的长期记忆，由插件 mnemosyne 维护。每轮开始时，与你当前请求相关的偏好、记忆与最近脉络会以',
    '`<mnemosyne-memory>` 消息附加在用户消息之后（来源 plugin:mnemosyne，不是你本次用户说的话）。用法：',
    '',
    '- 相关时自然地运用它，不要复述、不要引用这些标签、不要说"根据我的记忆"。用户当前要求与记忆冲突时，以当前要求为准。',
    '- 用户说出持久的偏好、事实、决定或教训（"以后都用…"、"记住…"、"我们项目是…"）时，主动调用 `mnemosyne_remember` 保存；',
    '  用户纠正你时，先修正，再用 `mnemosyne_update` 改掉旧记忆，而不是新建一条矛盾的记忆。',
    '- 用户提到过去的事情、某个决定或"上次/之前/那个"时，先 `mnemosyne_recall` 检索，再回答。',
    '- 用户明确说"忘记/删掉"时，用 `mnemosyne_forget`；想全面了解用户时用 `mnemosyne_profile`。',
    '- 记忆会自然衰减并被遗忘：重要的核心事实用 pinned 固定，其余交给衰减。不要把密钥、口令、一次性信息写进记忆。',
  ].join('\n')
}

/**
 * One-line status for the CLI and diagnostics.
 * @param {import('../src/brain.js').Brain} brain
 * @param {object} config
 * @returns {string}
 */
export function formatStatus(brain, config) {
  const report = brain.health()
  return [
    `mnemosyne  memory=${brain.store.filePath || '(memory-only)'}`,
    `  items=${report.items} forgotten=${report.forgotten} reused=${report.reused} fit=${report.behaviorFit} observations=${report.observations}`,
    `  episodic=${report.byStore.episodic.active} semantic=${report.byStore.semantic.active} commands=${report.byStore.commands.active}`,
    `  halfLifeDays=${report.tuning.halfLifeDays} recallThreshold=${report.tuning.recallThreshold} floor=${report.tuning.salienceFloor}`,
    `  autoLearn=${config.autoLearn} privacy=${config.privacyMode} chars=${config.workingSetMaxChars}`,
  ].join('\n')
}

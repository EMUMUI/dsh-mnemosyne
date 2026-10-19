/**
 * The model-facing tools. Ten small, orthogonal verbs — the agent reaches for
 * them the way a person reaches for a notebook:
 *
 *   remember · recall · update · forget · profile · consolidate · health ·
 *   sessions · commands · stats
 *
 * Every tool is a thin projection of {@link Brain}; validation of arguments is
 * done by the harness (`defineTool`), everything else answers with structured
 * JSON so the agent can chain calls (ids from `recall` feed `update`/`forget`,
 * ids from the injected working set feed everything).
 */

import { defineTool } from './deepseek-ai-dsh-tools.js'

/** Render a JSON value as one text block for the model. */
const json = value => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

/** Render a short human sentence. */
const text = value => [{ type: 'text', text: String(value) }]

/**
 * Forget/restore argument list: ids, or a query when the model did not keep the
 * id. A single string is accepted so a one-id call cannot fail on shape.
 */
const idsParam = {
  type: 'array',
  items: { type: 'string' },
  description: '一个或多个记忆 id（可在注入的工作集或 mnemosyne_recall 结果里找到），也接受唯一的 id 前缀。',
}

/** Normalise an id list that the model may have sent as a bare string. */
const idList = value => (Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : [])

/**
 * Build every tool definition bound to one brain.
 * @param {import('./brain.js').Brain} brain
 * @param {{ context?: (agent: object) => { project?: string, cwd?: string, sessionId?: string } }} options
 *   `context` receives the calling agent (`undefined` outside a turn) and
 *   reports the project the call belongs to.
 * @returns {object[]} tool definitions
 */
export function buildTools(brain, options = {}) {
  const context = options.context ?? (() => ({}))
  return [
    rememberTool(brain, context),
    recallTool(brain, context),
    updateTool(brain),
    forgetTool(brain),
    profileTool(brain),
    consolidateTool(brain),
    healthTool(brain),
    sessionsTool(brain),
    commandsTool(brain),
    statsTool(brain),
    challengeTool(brain),
    personalityTool(brain),
  ]
}

/** Project of the calling agent, '' when unknown. */
const projectOfAgent = (context, exec) => (context(exec?.agent)?.project ?? '')

/** @param {import('./brain.js').Brain} brain */
function rememberTool(brain, context) {
  return defineTool({
    name: 'mnemosyne_remember',
    description: [
      '把关于用户或这个项目的事写入长期记忆，让下次会话一开始就知道。',
      '适用：持久偏好（"以后都用中文回答"、"别加注释"）、用户或项目的事实（技术栈、路径、成员、约定）、',
      '决定（"我们选了 SQLite"）、踩过的坑（"不加 X 构建就会失败"）。',
      '不要存：密钥或令牌、一次性的任务状态、用户要求忘记的内容、整段原始对话。',
      '同一主题的新偏好会自动取代旧的那条；近似重复只加固已有记忆，不会越堆越多。',
    ].join(''),
    parameters: {
      content: { type: 'string', required: true, description: '要记住的内容，用一两句能独立看懂的话说清楚。' },
      kind: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'lesson', 'command'],
        description: 'preference＝做事方式（每轮都会注入）；fact/decision/lesson＝相关时才召回；command＝可用的命令（存入 commands 库）。',
      },
      title: { type: 'string', description: '记忆的小标题，显示在工作集里（默认取内容本身）。' },
      tags: { type: 'array', items: { type: 'string' }, description: '可选的检索标签，例如 ["前端","部署"]。' },
      pinned: { type: 'boolean', description: '固定后不再衰减、每轮都注入。只用于核心身份类事实。' },
      store: { type: 'string', enum: ['episodic', 'semantic', 'commands'], description: '手动指定记忆库；通常由 kind 自动决定，无需填写。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          store: { type: 'string' },
          title: { type: 'string' },
        },
      },
      render: (_args, value) => json(value),
      presentationMeta: (_args, value) => ({ memory: 'remember', action: value.action }),
    },
    async execute(args, exec) {
      const store = args.store ?? (args.kind === 'command' ? 'commands' : args.kind === 'preference' ? 'semantic' : 'episodic')
      const project = projectOfAgent(context, exec)
      const result = brain.remember({
        content: args.content,
        kind: args.kind,
        title: args.title,
        tags: args.tags,
        pinned: args.pinned,
        store,
      })
      if (result.action !== 'rejected' && project !== '') {
        const item = brain.store.find(result.id, { includeForgotten: true })
        if (item !== undefined) {
          item.project = project
          brain.store.touch()
          brain.save()
        }
      }
      return result
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function recallTool(brain, context) {
  return defineTool({
    name: 'mnemosyne_recall',
    description: [
      '在长期记忆（过去所有会话学到的东西）里检索与查询相关的内容。',
      '当用户提到以前的事（"我们之前说的"、"上次那个"、"那个脚本"）、需要重新推导一个旧决定，',
      '或任何回忆起来的细节会改变你的回答时，先调用它。',
      '返回按相关度排序的记忆，含 id、内容、当前保持度（还记得多牢，0–1）以及是否已被遗忘。',
      '把 includeForgotten 设为 true 可以挖出已经淡忘的记忆——人被提醒时，往往还记得半忘的事。',
    ].join(''),
    parameters: {
      query: { type: 'string', required: true, description: '要搜索的内容，用自然语言描述即可。' },
      store: { type: 'string', enum: ['all', 'episodic', 'semantic', 'commands'], description: '只在其中某个库中检索（默认全部）。' },
      limit: { type: 'number', description: '最多返回几条（1–20，默认 8）。' },
      includeForgotten: { type: 'boolean', description: '同时检索已被遗忘的记忆（衰减到阈值以下或被明确忘记的）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          count: { type: 'number' },
          memories: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const project = projectOfAgent(context, exec)
      const memories = brain.recall({
        query: args.query,
        store: args.store,
        limit: args.limit,
        includeForgotten: args.includeForgotten,
        project,
      })
      return { query: args.query, count: memories.length, memories }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function updateTool(brain) {
  return defineTool({
    name: 'mnemosyne_update',
    description: '按 id 修改记忆：改写内容、固定/取消固定、调整重要度。id 可以是完整 id、唯一前缀，或一个列表。用户纠正某个事实或偏好，或要求你"以后都要/不要再"做某事时使用。给多个 id 时，同一处改动会应用到每一条。',
    parameters: {
      ids: {
        ...idsParam,
        required: true,
        description: '记忆 id 或唯一的 id 前缀，例如 ["sema-0688e679"]。',
      },
      content: { type: 'string', description: '新的记忆内容。' },
      pinned: { type: 'boolean', description: 'true＝固定（不衰减、每轮注入）；false＝取消固定。' },
      salience: { type: 'number', description: '重要度 0–1。越重要衰减越慢，召回时也越优先。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const items = brain.resolveMany(idList(args.ids))
      if (items.length === 0) return { results: [{ ok: false, error: '没有匹配到可修改的记忆' }] }
      const results = []
      for (const item of items) {
        const result = brain.manage({
          action: 'update',
          ids: [item.id],
          content: args.content,
          pinned: args.pinned,
          salience: args.salience,
        })
        results.push(result)
      }
      return { results }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function forgetTool(brain) {
  return defineTool({
    name: 'mnemosyne_forget',
    description: [
      '忘记或恢复某条记忆，可以按 id，也可以按它说过的内容。',
      'mode 为 soft（默认）：让它从召回中淡出，但仍可恢复——用户说"记错了"或"忘掉这个"时用。',
      'mode 为 hard：彻底丢弃，只留一条审计记录——用户说"删掉"或内容涉及隐私时用。',
      '把 restore 设为 true 可以把已遗忘的记忆找回来。',
    ].join(''),
    parameters: {
      ids: {
        ...idsParam,
        description: '要处理的记忆 id。如果已经想不起 id，改用 `query` 传入它的内容。',
      },
      query: { type: 'string', description: '与 ids 二选一：忘记/恢复与此文本匹配的记忆。' },
      mode: { type: 'string', enum: ['soft', 'hard', 'restore'], description: 'soft＝遗忘但可恢复；hard＝彻底丢弃；restore＝找回。' },
      restore: { type: 'boolean', description: '把已遗忘的记忆找回来，而不是忘记它。' },
      reason: { type: 'string', description: '原因（会记入这条记忆的历史）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          forgotten: { type: 'array', items: { type: 'json' } },
          discarded: { type: 'array', items: { type: 'json' } },
          restored: { type: 'array', items: { type: 'json' } },
          errors: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const action = args.restore === true || args.mode === 'restore'
        ? 'restore'
        : args.mode === 'hard' ? 'discard' : 'forget'
      const errors = []
      const ids = []
      // Ids first; when the model only knows what the memory said, resolve the
      // query to the memories it matches. Restoring looks among forgotten
      // memories, so it resolves by id instead of by recall.
      for (const item of brain.resolveMany(idList(args.ids), { includeForgotten: action === 'restore' })) ids.push(item.id)
      if (ids.length === 0 && action !== 'restore' && typeof args.query === 'string' && args.query.trim() !== '') {
        const hits = brain.recall({ query: args.query, limit: 10 })
        if (hits.length === 0) errors.push({ query: args.query, error: '没有匹配到任何记忆' })
        for (const hit of hits) ids.push(hit.id)
      }
      if (ids.length === 0) {
        if (errors.length === 0) errors.push({ query: args.ids, error: '没有匹配到任何记忆' })
        return { forgotten: [], discarded: [], restored: [], errors }
      }
      const result = brain.manage({ action, ids, reason: args.reason })
      const changed = (result.ids ?? []).map(id => ({ id, title: brain.store.find(id, { includeForgotten: true })?.title ?? '' }))
      return {
        forgotten: action === 'forget' ? changed : [],
        discarded: action === 'discard' ? changed : [],
        restored: action === 'restore' ? changed : [],
        errors,
      }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function profileTool(brain) {
  return defineTool({
    name: 'mnemosyne_profile',
    description: '读取学习形成的用户画像：长期偏好、被固定住的身份事实，以及最近有多贴合用户。接手一类新任务、或需要调整语气与做事方式时，可以在会话早期调用它。',
    parameters: {
      limit: { type: 'number', description: '每部分最多返回几条（默认 20）。' },
      includeForgotten: { type: 'boolean', description: '是否包含已经淡忘的偏好。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preferences: { type: 'array', items: { type: 'json' } },
          identity: { type: 'array', items: { type: 'json' } },
          fit: { type: 'json' },
          stats: { type: 'json' },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(100, args.limit ?? 20))
      const preferences = brain.store.items('semantic', { includeForgotten: args.includeForgotten === true })
        .filter(item => !item.supersededBy)
        .sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0) || right.strength - left.strength)
        .slice(0, limit)
        .map(item => ({ id: item.id, text: item.content, pinned: item.pinned, strength: item.strength, hits: item.hits }))
      const identity = brain.store.items('all')
        .filter(item => item.pinned && item.store !== 'semantic')
        .slice(0, limit)
        .map(item => ({ id: item.id, text: item.content, store: item.store }))
      return {
        preferences,
        identity,
        fit: { behaviorFit: brain.store.tuning.behaviorFit, observations: brain.store.tuning.observations },
        stats: { ...brain.store.data.stats },
      }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function consolidateTool(brain) {
  return defineTool({
    name: 'mnemosyne_consolidate',
    description: [
      '像睡眠一样对记忆做一次整理：把最近几轮对话压缩成一段摘要，弱的记忆衰减后淡出，强的记忆保持不变。',
      '适合在一次长会话结束时，或记忆显得杂乱时调用。preview 设为 true 则只报告会发生什么，不做任何改动。',
    ].join(''),
    parameters: {
      preview: { type: 'boolean', description: '只报告，不做改动。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'json' } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      return { result: brain.consolidate({ preview: args.preview === true }) }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function healthTool(brain) {
  return defineTool({
    name: 'mnemosyne_health',
    description: '记忆健康报告：存了多少、遗忘了多少、被复用多少，行为契合度分数，自我调参后的参数，以及具体建议。用户问"记忆用得怎么样"、或问为什么有些事记不住时使用。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { report: { type: 'json' } } },
      render: (_args, value) => json(value),
    },
    async execute() {
      return { report: brain.health() }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function sessionsTool(brain) {
  return defineTool({
    name: 'mnemosyne_sessions',
    description: '学习日志里记录的近期对话活动：每个观察到的轮次一行摘要，附带项目与时间。上下文被压缩后、或新开会话想快速找回状态时很有用。',
    parameters: {
      limit: { type: 'number', description: '返回最近几轮（1–50，默认 10）。' },
      project: { type: 'string', description: '只看在这个工作目录里观察到的轮次。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { turns: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, args.limit ?? 10))
      const turns = [...brain.store.data.journal]
        .filter(entry => args.project === undefined || entry.cwd === args.project)
        .slice(-limit)
        .reverse()
        .map(entry => ({ at: entry.at, line: entry.oneLine, cwd: entry.cwd, consolidated: entry.consolidated === true }))
      return { turns }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function commandsTool(brain) {
  return defineTool({
    name: 'mnemosyne_commands',
    description: '查一查以前为类似目标成功执行过的命令。如果用户交代的事以前做过，先查一下，别从头再拼一遍命令。',
    parameters: {
      goal: { type: 'string', required: true, description: '你想达成的目标，用自然语言描述。' },
      limit: { type: 'number', description: '最多返回几条（默认 3）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { matches: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const matches = brain.commands({ goal: args.goal, limit: args.limit })
      return { matches }
    },
  })
}

/**
 * Put an objection to the user instead of acting on it.
 * @param {import('./brain.js').Brain} brain
 */
function challengeTool(brain) {
  return defineTool({
    name: 'mnemosyne_challenge',
    description: [
      '在动手之前，把你的异议摆到用户面前，请他裁决。',
      '适用：用户的前提可能有问题（数据来源、事实判断、方案假设）、你觉得他会事后后悔、',
      '或者你怀疑自己关于上文某处记错或编造了什么。',
      '不要用：纯粹的风格偏好、用户明确要求不要争论的事、以及你其实没有具体理由的时候。',
      '用法：先说清你担心什么，再问一句是否继续。用户回答后，他的决定会被记下来，',
      '你的性格成长不会再覆盖它——所以不要反复劝同一件事。',
    ].join(''),
    parameters: {
      topic: { type: 'string', required: true, description: '你担心什么，一句话说清（会记下来供以后参考）。' },
      subject: { type: 'string', description: '涉及的记忆 id 或主题（可选），用于把这次异议关联到具体记忆。' },
      evidence: { type: 'string', description: '你的依据是什么（可选）。不要编造依据。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recorded: { type: 'boolean' },
          topic: { type: 'string' },
          asked: { type: 'string' },
          pastDecisions: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => json(value),
    },
    async execute(args, exec) {
      const topic = String(args.topic ?? '').trim()
      if (topic === '') throw new Error('topic 不能为空')
      const challenge = { topic, subject: String(args.subject ?? ''), evidence: String(args.evidence ?? ''), trait: 'skepticism' }
      // The host reads this when the turn ends, so the user's answer can be
      // attributed to this objection instead of to a generic correction.
      const state = exec?.state
      if (state !== undefined && state !== null) state.pendingChallenge = challenge
      const past = brain.character().decided.filter(entry => entry.topic !== '').slice(-3)
      return {
        recorded: true,
        topic,
        asked: '把异议告诉用户，问一句是否继续；不要自行替他决定。',
        pastDecisions: past,
      }
    },
  })
}

/**
 * The user's controls over the grown character.
 * @param {import('./brain.js').Brain} brain
 */
function personalityTool(brain) {
  return defineTool({
    name: 'mnemosyne_personality',
    description: [
      '查看和管理这个助手的性格：它从长期使用中养成了哪些倾向、每个维度由谁决定。',
      'action 为 show（默认，只读）：列出各维度当前的强度、证据数与归属。',
      'action 为 set：把某一维度调到指定强度，或锁定/交给成长（state 取 learned、wanted、locked）。',
      'action 为 erase：把某一维度恢复为出厂状态，忘掉所有学习结果。',
      'action 为 decide：把用户的最终裁决记下来，性格成长永远不会覆盖它。',
      '维度：directness 直言、caution 谨慎、skepticism 质疑、depth 深究、brevity 精简、warmth 亲和、initiative 主动。',
    ].join(''),
    parameters: {
      action: { type: 'string', enum: ['show', 'set', 'erase', 'decide'], description: '要做什么，默认 show。' },
      key: { type: 'string', description: '性格维度名，如 skepticism。set 和 erase 必填。' },
      value: { type: 'number', description: '0 到 1 之间的强度，set 时可选。' },
      state: { type: 'string', enum: ['learned', 'wanted', 'locked', 'decided'], description: '归属：learned 随成长（默认）、wanted 你要求、locked 锁定、decided 已裁决。' },
      topic: { type: 'string', description: 'decide 时记录的决定内容。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'json' } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const action = String(args.action ?? 'show')
      if (action === 'show') return { result: brain.character() }
      const result = brain.manageCharacter({
        action,
        key: args.key,
        value: typeof args.value === 'number' ? args.value : undefined,
        state: args.state,
        topic: args.topic,
      })
      return { result: result.ok ? { ...result, character: brain.character() } : result }
    },
  })
}

/** @param {import('./brain.js').Brain} brain */
function statsTool(brain) {
  return defineTool({
    name: 'mnemosyne_stats',
    description: '记忆系统的计数：观察到的轮次、学到的记忆、召回与注入次数、被加固与被忽略的记忆、遗忘与丢弃的总数、修订冲突，以及记忆文件位置。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { stats: { type: 'json' }, file: { type: 'string' }, tuning: { type: 'json' } } },
      render: (_args, value) => json(value),
    },
    async execute() {
      return {
        stats: { ...brain.store.data.stats },
        file: brain.store.filePath,
        tuning: { ...brain.store.tuning },
      }
    },
  })
}

export { text }

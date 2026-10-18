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
  description: 'One or more memory ids (from the injected working set or mnemosyne_recall); unique id prefixes are accepted.',
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
  ]
}

/** Project of the calling agent, '' when unknown. */
const projectOfAgent = (context, exec) => (context(exec?.agent)?.project ?? '')

/** @param {import('./brain.js').Brain} brain */
function rememberTool(brain, context) {
  return defineTool({
    name: 'mnemosyne_remember',
    description: [
      'Save something to your long-term memory about the user or this project, so the next session starts knowing it.',
      'Use it for: durable preferences ("always answer in Chinese", "never add comments"), facts about the user or project (stack, paths, people, conventions), decisions ("we chose SQLite"), and lessons learned ("the build fails unless X").',
      'Do NOT store: secrets or tokens, transient task state, anything the user asked to be forgotten, or raw conversation.',
      'A later preference about the same subject automatically supersedes the earlier one. Near-duplicates strengthen the existing memory instead of piling up.',
    ].join(' '),
    parameters: {
      content: { type: 'string', required: true, description: 'The memory, stated in one self-contained sentence or two.' },
      kind: {
        type: 'string',
        enum: ['preference', 'fact', 'decision', 'lesson', 'command'],
        description: 'preference → how the user wants things done (injected every turn); fact/decision/lesson → recalled when relevant; command → a working command (store "commands").',
      },
      title: { type: 'string', description: 'Short title shown in the working set (defaults to the content).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional retrieval tags, e.g. ["frontend","deploy"].' },
      pinned: { type: 'boolean', description: 'Pinned memories never decay and are always injected. Use for core identity facts only.' },
      store: { type: 'string', enum: ['episodic', 'semantic', 'commands'], description: 'Override the store; normally derived from kind.' },
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
      'Search long-term memory (everything learned in past sessions) for items relevant to a query.',
      'Call this when the user refers to something from before ("as we discussed", "the same as last time", "那个脚本"), before re-deriving a decision, or whenever a remembered detail would change your answer.',
      'Returns ranked memories with ids, text, current retention (how well it is remembered, 0–1) and whether it was forgotten.',
      'Use includeForgotten: true to dig up something that faded — a human can often still remember a half-forgotten thing when prompted.',
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'What to search for, in natural language.' },
      store: { type: 'string', enum: ['all', 'episodic', 'semantic', 'commands'], description: 'Restrict the search to one store (default all).' },
      limit: { type: 'number', description: 'Maximum results (1–20, default 8).' },
      includeForgotten: { type: 'boolean', description: 'Also search memories that have been forgotten (faded below threshold or explicitly forgotten).' },
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
    description: 'Revise, pin/unpin or re-rate memories identified by id (an id, a unique id prefix, or a list). Use it when the user corrects a fact or preference, or asks you to always/never do something. With several ids the same change is applied to each.',
    parameters: {
      ids: {
        ...idsParam,
        required: true,
        description: 'Memory ids, or unique id prefixes, e.g. ["sema-0688e679"].',
      },
      content: { type: 'string', description: 'Replacement text for the memory.' },
      pinned: { type: 'boolean', description: 'true pins (never decays, always injected); false unpins.' },
      salience: { type: 'number', description: 'Importance 0–1. Higher importance decays more slowly and is preferred in recall.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { results: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => json(value),
    },
    async execute(args) {
      const items = brain.resolveMany(idList(args.ids))
      if (items.length === 0) return { results: [{ ok: false, error: 'no active memory matched those ids' }] }
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
      'Forget or restore a memory, by id or by what it said.',
      'mode "soft" (default): the memory fades out of recall but can be restored — use when the user says "wrong" or "forget that".',
      'mode "hard": permanently discard it and keep only an audit tombstone — use when the user says "delete this" or something is private.',
      'Set restore: true to bring a forgotten memory back.',
    ].join(' '),
    parameters: {
      ids: {
        ...idsParam,
        description: 'Memory ids to act on. When you no longer have the id, pass the text instead with `query`.',
      },
      query: { type: 'string', description: 'Alternative to ids: forget/restore the memories that match this text.' },
      mode: { type: 'string', enum: ['soft', 'hard', 'restore'], description: 'soft = forget but recoverable; hard = discard; restore = bring back.' },
      restore: { type: 'boolean', description: 'Bring forgotten memories back instead of forgetting them.' },
      reason: { type: 'string', description: 'Why (recorded in the memory history).' },
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
        if (hits.length === 0) errors.push({ query: args.query, error: 'no memory matched' })
        for (const hit of hits) ids.push(hit.id)
      }
      if (ids.length === 0) {
        if (errors.length === 0) errors.push({ query: args.ids, error: 'no memory matched' })
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
    description: 'Read the user profile built by learning: standing preferences, pinned identity facts and how well the agent has been fitting the user lately. Call it early in a session for a new kind of task, or when personalising tone and workflow.',
    parameters: {
      limit: { type: 'number', description: 'Maximum entries per section (default 20).' },
      includeForgotten: { type: 'boolean', description: 'Include preferences that have faded.' },
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
      'Run a consolidation pass over memory, like sleep: recent turns are compressed into one digest, weak memories decay and are forgotten, strong ones keep their strength.',
      'Run it at the end of a long session, or when memory feels noisy. preview: true only reports what would happen.',
    ].join(' '),
    parameters: {
      preview: { type: 'boolean', description: 'Report without changing anything.' },
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
    description: 'Memory health report: how much is stored, how much has been forgotten or reused, the behaviour-fit score, the self-tuned parameters, and concrete recommendations. Use it when the user asks how the memory is doing or why the agent forgets things.',
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
    description: 'Recent conversation activity recorded in the learning journal: one short line per observed turn, with project and time. Useful to re-orient after compaction or a new session.',
    parameters: {
      limit: { type: 'number', description: 'How many recent turns (1–50, default 10).' },
      project: { type: 'string', description: 'Only turns observed in this working directory.' },
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
    description: 'Look up shell commands that worked in the past for a similar goal. Call it before writing a command from scratch for something the user has asked you to do before.',
    parameters: {
      goal: { type: 'string', required: true, description: 'What you are trying to accomplish, in natural language.' },
      limit: { type: 'number', description: 'Maximum matches (default 3).' },
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

/** @param {import('./brain.js').Brain} brain */
function statsTool(brain) {
  return defineTool({
    name: 'mnemosyne_stats',
    description: 'Counters for the memory system: turns observed, memories learned, recalls and injections, reinforced vs ignored memories, forgotten and discarded totals, revision conflicts, and file location.',
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

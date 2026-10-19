/**
 * Mnemosyne — biological-style long-term memory for DeepSeek Harness.
 *
 * A DSH bundle plugin (host half). It gives every agent four interlocking
 * abilities that a human brain has and a context window does not:
 *
 *  1. **Memory** — write-ahead learning from each completed turn, plus an
 *     explicit `mnemosyne_remember`/`mnemosyne_recall` surface, persisted in
 *     one atomic JSON file per machine and reloaded on every start.
 *  2. **Learning & fitting** — preferences stated by the user become a subject-
 *     keyed profile; later statements supersede earlier ones, and the working
 *     set injected before each turn narrows towards what this particular user
 *     actually acts on.
 *  3. **Forgetting** — Ebbinghaus decay, reinforcement on every meaningful
 *     return, consolidation into session digests, and a floor under which
 *     memories are forgotten (recoverable, not destroyed).
 *  4. **Evolution** — a closed feedback loop judges whether each injection was
 *     accepted or corrected and slowly re-tunes thresholds and half-life
 *     within hard bounds. The longer it runs, the better it fits.
 *
 * Every DSH registration goes through `ctx.effect`/`ctx.on`, so hot reload
 * swaps the instance cleanly and the brain file is always the source of truth.
 */

import { readFileSync } from 'node:fs'

import { normalizeConfig, resolveMemoryFile } from './src/config.js'
import { createBrain } from './src/brain.js'
import { buildTools } from './src/tools.js'
import { Host, SOURCE_KIND } from './lib/host.js'
import { systemSectionText } from './lib/render.js'
import { BrainWriter } from './lib/writer.js'

export { SOURCE_KIND }

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** Cordis plugin name (also the Loader row id in cordis.patch.yml). */
export const name = 'mnemosyne'

/** Loader diagnostics only; optional services are reached through `ctx.inject`. */
export const inject = []

/** Process-wide map from brain file to its live host (survives HMR swaps). */
const REGISTRY = Symbol.for('dsh-mnemosyne.hosts')

/** The most recently mounted host, so a fresh module instance during hot reload
 * can take over the brain instead of starting from an empty one. */
let instance = null

/** Re-export for tests and embedders. */
export { buildTools, BrainWriter, createBrain, Host, normalizeConfig, resolveMemoryFile, pkg }

/**
 * Resolve the booted profile's name from the Loader's base URL, so the default
 * memory file is per profile (`~/.dsh/mnemosyne/<profile>.json`).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string}
 */
export function profileOf(ctx) {
  const url = String(ctx?.baseUrl ?? '')
  const match = /[\\/]profiles[\\/]([^\\/]+)/.exec(url)
  if (match !== null) return decodeURIComponent(match[1])
  const fromEnv = process.env.DSH_PROFILE
  return typeof fromEnv === 'string' ? fromEnv : ''
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the Loader fiber context.
 * @param {object} [rawConfig] - the row's config from cordis.patch.yml.
 */
export function apply(ctx, rawConfig) {
  // The Loader passes `null` (not `undefined`) for a row whose patch config is
  // absent, so a default parameter would not protect this call.
  const given = rawConfig ?? {}
  const profile = profileOf(ctx)
  // One host per brain file per process: a second mount (profile listed twice,
  // hot reload before the old fiber finishes) resumes from the live brain
  // instead of an empty one and takes over its writer.
  const registry = (globalThis[REGISTRY] ??= new Map())
  const config = normalizeConfig({ ...given, profile: given.profile || profile })
  const memoryFile = resolveMemoryFile(config, { profile })
  const log = message => console.error(`[mnemosyne] ${message}`)
  const warn = message => console.error(`[mnemosyne] ${message}`)
  const debug = config.debug

  let brain
  let writer
  const inherited = memoryFile === '' ? instance : registry.get(memoryFile)
  if (inherited !== undefined && inherited !== null) {
    brain = inherited.brain
    writer = new BrainWriter(brain)
    brain.writer = writer
    brain.config = config
    writer.brain = brain
    if (debug) log(`attached to live brain for ${memoryFile}`)
  } else {
    brain = createBrain({ config, memoryFile, warn: message => warn(message) })
    brain.store.filePath = memoryFile
    writer = new BrainWriter(brain)
    brain.writer = writer
    // Persist the (empty) brain on first load so the file path is real and
    // `mnemosyne_stats` can report it.
    try { writer.save() } catch (error) { warn(`initial save failed: ${error?.message ?? error}`) }
  }

  const host = new Host({
    brain,
    config,
    log: debug ? log : () => {},
    warn,
  })
  instance = host
  if (memoryFile !== '') registry.set(memoryFile, host)

  if (debug) log(`loaded ${pkg.version}: file=${memoryFile || '(memory only)'} profile=${profile || '(none)'}`)

  // Session observation and turn-level bookkeeping (also learns and flushes).
  ctx.effect(() => {
    host.attach(ctx)
    return () => {
      host.dispose()
      writer.release()
      if (memoryFile !== '' && registry.get(memoryFile) === host) registry.delete(memoryFile)
    }
  }, 'mnemosyne: session observation')

  // Working-set injection: once per turn, at its first step, as a logged
  // user-role message attributed to this plugin.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind === 'reject' || payload?.signal?.aborted === true) return decision
      if (payload.step !== 1) return decision
      const injection = host.buildInjectionFor(payload)
      if (injection === null) return decision
      const message = Object.freeze({
        id: `${SOURCE_KIND}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        content: Object.freeze([Object.freeze({ type: 'text', text: injection.text })]),
        source: Object.freeze({ kind: SOURCE_KIND, form: 'recall' }),
      })
      host.noteInjected(payload.agent?.session?.id)
      if (debug) log(`injected ${injection.ids.length} memories (${injection.text.length} chars)`)
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      warn(`injection skipped: ${error?.message ?? error}`)
      return decision
    }
  }, { prepend: true })

  // The model-facing tools. The context provider resolves the calling agent's
  // project at execute time, so tools never guess which session they belong to.
  ctx.inject(['tools'], toolsCtx => {
    toolsCtx.effect(() => {
      const disposers = []
      const definitions = buildTools(brain, {
        context: (agent) => host.contextOf(agent),
      })
      for (const definition of definitions) disposers.push(toolsCtx.tools.register(definition))
      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* already gone */ }
        }
      }
    }, 'mnemosyne: tools')
  })

  // A short standing section so the model knows the memory exists and how to
  // use it without being told every turn.
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(() => promptCtx.systemPrompt.section({
      name: 'mnemosyne:memory',
      order: 2900,
      text: systemSectionText(),
    }), 'mnemosyne: prompt section')

    // The character is its own section and is read lazily every turn: it is
    // empty until there is evidence, then grows without a restart.
    if (config.growPersonality) {
      promptCtx.effect(() => promptCtx.systemPrompt.section({
        name: 'mnemosyne:character',
        order: 2910,
        text: () => {
          try {
            return brain.characterPrompt()
          } catch {
            return ''
          }
        },
      }), 'mnemosyne: character section')
    }
  })

  // Expose diagnostics to the loader log only when asked.
  if (debug) {
    ctx.effect(() => {
      const timer = setInterval(() => log(host.status()), 600_000)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'mnemosyne: status timer')
  }
}

/** Peer helper for embedders: the plugin's config defaults. */
export { DEFAULTS } from './src/config.js'

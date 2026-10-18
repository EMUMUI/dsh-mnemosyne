/**
 * Plugin configuration: one place for every deployment-dependent value.
 *
 * `cordis.patch.yml` passes an optional subset; this module owns the defaults,
 * normalises the plugin's own `baseDir`/`profile` placeholders, and fails
 * loudly on anything structurally wrong so a bad override surfaces at load
 * time rather than as silent misbehaviour later.
 */

import path from 'node:path'

/** The defaults, documented in cordis.patch.yml and README. */
export const DEFAULTS = Object.freeze({
  memoryFile: '',
  baseDir: '',
  profile: '',
  autoLearn: true,
  learnAssistant: false,
  minTurnChars: 4,
  captureCommandTurns: false,
  consolidateEveryTurns: 1,
  autoConsolidateMinNewTurns: 10,
  idleFlushMs: 20_000,
  selfTuneEveryTurns: 25,
  workingSetMaxChars: 2200,
  recallMaxItems: 4,
  recallMinScore: 2.6,
  recallMinQueryChars: 4,
  maxProfileEntries: 12,
  injectRecentActivity: true,
  include: Object.freeze({ preferences: true, memories: true, commands: true, recent: true }),
  halfLifeDays: 21,
  salienceFloor: 0.05,
  privacyMode: 'excerpt',
  excerptChars: 160,
  redactSecrets: true,
  perProjectPreferences: false,
  maxEpisodic: 500,
  keepForgottenDays: 180,
  debug: false,
})

/** Numeric fields with their accepted range: `[min, max]`. */
const NUMERIC_RANGES = {
  minTurnChars: [1, 200],
  autoConsolidateMinNewTurns: [1, 10_000],
  idleFlushMs: [0, 3_600_000],
  selfTuneEveryTurns: [0, 10_000],
  workingSetMaxChars: [200, 20_000],
  recallMaxItems: [0, 20],
  recallMinScore: [0, 10],
  recallMinQueryChars: [0, 500],
  maxProfileEntries: [0, 50],
  halfLifeDays: [0, 3650],
  excerptChars: [20, 4000],
  maxEpisodic: [10, 100_000],
  keepForgottenDays: [1, 3650],
}

const BOOLEAN_FIELDS = [
  'autoLearn', 'learnAssistant', 'captureCommandTurns', 'injectRecentActivity', 'redactSecrets',
  'perProjectPreferences', 'debug',
]

const PRIVACY_MODES = new Set(['excerpt', 'excerpt-free', 'full'])

/**
 * Validate a raw config object and fill defaults.
 * @param {object} raw - the Loader row's `config`.
 * @returns {object} the normalised config.
 * @throws {TypeError} on an unknown key, wrong type, or out-of-range value.
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('mnemosyne: config must be an object')
  }
  const known = new Set([...Object.keys(DEFAULTS), 'include'])
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw new TypeError(`mnemosyne: unknown config key "${key}"`)
  }
  const cfg = { ...DEFAULTS, ...raw }
  cfg.include = { ...DEFAULTS.include, ...(typeof raw.include === 'object' && raw.include !== null ? raw.include : {}) }

  for (const key of BOOLEAN_FIELDS) {
    if (typeof cfg[key] !== 'boolean') throw new TypeError(`mnemosyne: config.${key} must be a boolean`)
  }
  for (const key of ['memoryFile', 'baseDir', 'profile']) {
    if (typeof cfg[key] !== 'string') throw new TypeError(`mnemosyne: config.${key} must be a string`)
  }
  for (const key of Object.keys(cfg.include)) {
    if (typeof cfg.include[key] !== 'boolean') throw new TypeError(`mnemosyne: config.include.${key} must be a boolean`)
  }
  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const value = cfg[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new TypeError(`mnemosyne: config.${key} must be a number in [${min}, ${max}]`)
    }
  }
  if (typeof cfg.recallMaxItems !== 'number' || !Number.isSafeInteger(cfg.recallMaxItems)) {
    throw new TypeError('mnemosyne: config.recallMaxItems must be an integer')
  }
  if (!PRIVACY_MODES.has(cfg.privacyMode)) {
    throw new TypeError(`mnemosyne: config.privacyMode must be one of ${[...PRIVACY_MODES].join(', ')}`)
  }
  return cfg
}

/**
 * Resolve the brain file path for this deployment.
 *
 * Precedence: explicit `memoryFile` → `<baseDir>/<profile>.json` →
 * `~/.dsh/mnemosyne/<profile>.json`. An empty profile falls back to `default`.
 * @param {object} cfg - normalised config.
 * @param {{ home?: string, profile?: string }=} environment
 * @returns {string} absolute path (may be '' when disabled by an empty baseDir and no home).
 */
export function resolveMemoryFile(cfg, environment = {}) {
  if (cfg.memoryFile !== '') return path.resolve(cfg.memoryFile)
  const profile = String(cfg.profile || environment.profile || 'default').replace(/[^\w.-]+/g, '_') || 'default'
  if (cfg.baseDir !== '') return path.resolve(cfg.baseDir, `${profile}.json`)
  const home = environment.home ?? process.env.DSH_HOME ?? (process.env.HOME || process.env.USERPROFILE || '')
  if (!home) return ''
  return path.resolve(home, '.dsh', 'mnemosyne', `${profile}.json`)
}

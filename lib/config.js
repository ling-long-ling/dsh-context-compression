/**
 * Configuration resolution for the DSH context-compression plugin.
 *
 * The WorkBuddy/CodeBuddy era read `WB_OPS_*` environment variables. A DSH
 * plugin is configured through its row in `cordis.patch.yml`, so this module
 * turns the raw plugin config into one immutable, validated object and never
 * reads the environment.
 *
 * @module dsh-context-compression/config
 */

import os from 'node:os'
import path from 'node:path'

/** Byte budget per DSH tool class. Anything else uses `default`. */
export const DEFAULT_BUDGETS = Object.freeze({
  bash: 4000,
  grep: 8000,
  glob: 8000,
  webFetch: 8000,
  read: 8000,
  default: 8000,
})

/**
 * Trigger threshold per DSH tool class; `0` disables the threshold branch.
 *
 * v2.1: every default now equals its budget. The old table had `bash: 3000 < 4000`,
 * a self-contradictory "dead config": inputs in (3000, 4000] triggered a trim whose
 * target was the budget they already fit in, so the pass threw away information
 * without saving context (report P1-3).
 *
 * The engine no longer reads this table: a trim happens iff `tbytes > budgetBytes`
 * (plus the caller-level `readTrim` switch for Read). `minBytes` is kept for config
 * compatibility, and {@link resolveConfig} still raises every entry to at least its
 * tool budget so an old patch that set `bash: 3000` cannot look like it changes
 * anything it does not.
 */
export const DEFAULT_MIN_BYTES = Object.freeze({
  bash: 4000,
  grep: 8000,
  glob: 8000,
  webFetch: 8000,
  read: 8000,
  default: 8000,
})

/** Allowed budget range (bytes); outside it the engine would starve or no-op. */
export const BUDGET_MIN = 2000
export const BUDGET_CAP = 131_072
/** Allowed trigger range (bytes). */
export const MIN_BYTES_FLOOR = 500
export const MIN_BYTES_CAP = 131_072
/** Upper bounds for `focusPatterns`. */
export const FOCUS_MAX_COUNT = 32
export const FOCUS_MAX_LENGTH = 128

/** Keys accepted inside `budgets` / `minBytes`. */
const TOOL_KEYS = ['bash', 'grep', 'glob', 'webFetch', 'read', 'default']
const TOP_KEYS = new Set([
  'enabled',
  'budgets',
  'minBytes',
  'readTrim',
  'spill',
  'shadow',
  'minSaveBytes',
  'minSavePercent',
  'statsDir',
  'focusPatterns',
  'debug',
])

/**
 * Default spill root: a stable per-user directory.
 *
 * v2.1: `os.tmpdir()` moves between launches on Windows (DSH restarts get a fresh
 * %TEMP%), so spilled originals and the stats trail silently vanished — this is
 * one reason the 2.0 install had "no evidence it ever trimmed".
 * @returns {string} absolute directory path.
 */
export function defaultSpillDir() {
  return path.join(os.homedir(), '.dsh', 'context-compression', 'spill')
}

/**
 * Default stats root: a stable per-user directory (see {@link defaultSpillDir}).
 * @returns {string} absolute directory path.
 */
export function defaultStatsDir() {
  return path.join(os.homedir(), '.dsh', 'context-compression', 'data')
}

/**
 * Clamp an integer into an inclusive range.
 * @param {number} value - candidate value.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} the clamped value.
 */
function clamp(value, min, max) {
  const rounded = Math.trunc(value)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * Reject unknown keys so a typo in the patch does not silently no-op.
 * @param {object} raw - caller object.
 * @param {Iterable<string>} allowed - permitted keys.
 * @param {string} where - label used in the error message.
 */
function assertKnownKeys(raw, allowed, where) {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(raw)) {
    if (!allowedSet.has(key)) {
      throw new Error(
        `dsh-context-compression: unknown config key "${key}" in ${where} (allowed: ${[...allowedSet].join(', ')})`,
      )
    }
  }
}

/**
 * Resolve one `{tool: bytes}` table over its defaults.
 * @param {object} raw - caller table, possibly partial.
 * @param {Record<string, number>} defaults - default table.
 * @param {string} where - label used in error messages.
 * @param {number} min - inclusive lower bound after clamping.
 * @param {number} max - inclusive upper bound after clamping.
 * @returns {Readonly<Record<string, number>>} resolved table.
 */
function resolveTable(raw, defaults, where, min, max) {
  if (raw === undefined) return Object.freeze({ ...defaults })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`dsh-context-compression: ${where} must be an object`)
  }
  assertKnownKeys(raw, TOOL_KEYS, where)
  const resolved = { ...defaults }
  for (const key of Object.keys(raw)) {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`dsh-context-compression: ${where}.${key} must be a finite number`)
    }
    resolved[key] = clamp(value, min, max)
  }
  return Object.freeze(resolved)
}

/**
 * Read one boolean knob and reject non-boolean values (report P2-3).
 *
 * A quoted `"true"` used to flow through `??` into the engine, where
 * `opts.readTrim === true` silently evaluated to `false` — a typo that disabled
 * the feature with no diagnostic at all. Now it throws at resolve time.
 *
 * @param {unknown} value - raw value.
 * @param {boolean} fallback - default when the key is absent.
 * @param {string} where - label used in the error message.
 * @returns {boolean} resolved boolean.
 */
function resolveBoolean(value, fallback, where) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-context-compression: ${where} must be a boolean`)
  }
  return value
}

/**
 * Resolve `focusPatterns`: a short list of literal substrings that are always
 * kept as key lines (report R6). Rejects non-strings, empty strings, and
 * oversized lists so a typo cannot turn the classifier into "keep everything".
 *
 * @param {unknown} raw - raw value.
 * @returns {ReadonlyArray<string>} frozen list (empty when absent).
 */
function resolveFocusPatterns(raw) {
  if (raw === undefined) return Object.freeze([])
  if (!Array.isArray(raw)) {
    throw new Error('dsh-context-compression: focusPatterns must be an array of strings')
  }
  if (raw.length > FOCUS_MAX_COUNT) {
    throw new Error(
      `dsh-context-compression: focusPatterns accepts at most ${FOCUS_MAX_COUNT} entries`,
    )
  }
  const out = []
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('dsh-context-compression: focusPatterns entries must be non-empty strings')
    }
    if (value.length > FOCUS_MAX_LENGTH) {
      throw new Error(
        `dsh-context-compression: focusPatterns entries must be at most ${FOCUS_MAX_LENGTH} characters`,
      )
    }
    out.push(value)
  }
  return Object.freeze(out)
}

/**
 * Resolve plugin configuration into the shape the engine expects.
 *
 * Unknown keys throw, non-finite numbers throw, non-boolean booleans throw, and
 * every bound is clamped: a mis-sized budget degrades to "less compression",
 * never to a crash inside the compaction path.
 *
 * @param {object} [raw] - raw plugin config from `cordis.patch.yml`.
 * @returns {Readonly<{
 *   enabled: boolean,
 *   budgets: Readonly<Record<string, number>>,
 *   minBytes: Readonly<Record<string, number>>,
 *   readTrim: boolean,
 *   spill: Readonly<{ enabled: boolean, dir: string, days: number }>,
 *   shadow: boolean,
 *   minSaveBytes: number,
 *   minSavePercent: number,
 *   statsDir: string,
 *   focusPatterns: ReadonlyArray<string>,
 *   debug: boolean,
 * }>} immutable resolved config.
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-context-compression: config must be an object')
  }
  assertKnownKeys(raw, TOP_KEYS, 'config')

  const spillRaw = raw.spill
  if (
    spillRaw !== undefined &&
    (spillRaw === null || typeof spillRaw !== 'object' || Array.isArray(spillRaw))
  ) {
    throw new Error('dsh-context-compression: spill must be an object')
  }
  const spillKeys = ['enabled', 'dir', 'days']
  if (spillRaw !== undefined) assertKnownKeys(spillRaw, spillKeys, 'spill')

  const spillDir = spillRaw?.dir ?? defaultSpillDir()
  if (typeof spillDir !== 'string' || spillDir.length === 0) {
    throw new Error('dsh-context-compression: spill.dir must be a non-empty string')
  }
  const statsDir = raw.statsDir ?? defaultStatsDir()
  if (typeof statsDir !== 'string' || statsDir.length === 0) {
    throw new Error('dsh-context-compression: statsDir must be a non-empty string')
  }

  const minSaveBytes = raw.minSaveBytes ?? 300
  const minSavePercent = raw.minSavePercent ?? 4
  for (const [name, value] of [
    ['minSaveBytes', minSaveBytes],
    ['minSavePercent', minSavePercent],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`dsh-context-compression: ${name} must be a non-negative number`)
    }
  }

  const budgets = resolveTable(raw.budgets, DEFAULT_BUDGETS, 'budgets', BUDGET_MIN, BUDGET_CAP)
  const minBytes = resolveTable(raw.minBytes, DEFAULT_MIN_BYTES, 'minBytes', 0, MIN_BYTES_CAP)
  // A threshold below its budget is dead config: the engine already refuses to
  // trim anything that fits in the budget. Raising it keeps the knob meaningful.
  const thresholds = {}
  for (const key of TOOL_KEYS) {
    thresholds[key] = Math.max(minBytes[key], budgets[key])
  }

  const spill = Object.freeze({
    enabled: resolveBoolean(spillRaw?.enabled, true, 'spill.enabled'),
    dir: spillDir,
    days: clamp(spillRaw?.days ?? 7, 1, 365),
  })

  return Object.freeze({
    enabled: resolveBoolean(raw.enabled, true, 'enabled'),
    budgets,
    minBytes: Object.freeze(thresholds),
    readTrim: resolveBoolean(raw.readTrim, true, 'readTrim'),
    spill,
    shadow: resolveBoolean(raw.shadow, false, 'shadow'),
    minSaveBytes,
    minSavePercent,
    statsDir,
    focusPatterns: resolveFocusPatterns(raw.focusPatterns),
    debug: resolveBoolean(raw.debug, false, 'debug'),
  })
}

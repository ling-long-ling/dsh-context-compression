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

/** Trigger threshold per DSH tool class; `0` disables the threshold branch. */
export const DEFAULT_MIN_BYTES = Object.freeze({
  bash: 3000,
  grep: 6000,
  glob: 6000,
  webFetch: 6000,
  read: 8000,
  default: 4000,
})

/** Allowed budget range (bytes); outside it the engine would starve or no-op. */
export const BUDGET_MIN = 2000
export const BUDGET_CAP = 131_072
/** Allowed trigger range (bytes). */
export const MIN_BYTES_FLOOR = 500
export const MIN_BYTES_CAP = 131_072

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
  'debug',
])

/**
 * Default spill root: the OS temp directory, one level below it.
 * @returns {string} absolute directory path.
 */
export function defaultSpillDir() {
  return path.join(os.tmpdir(), 'dsh-context-compression', 'spill')
}

/**
 * Default stats root: the OS temp directory, one level below it.
 * @returns {string} absolute directory path.
 */
export function defaultStatsDir() {
  return path.join(os.tmpdir(), 'dsh-context-compression', 'data')
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
 * Resolve plugin configuration into the shape the engine expects.
 *
 * Unknown keys throw, non-finite numbers throw, and every bound is clamped:
 * a mis-sized budget degrades to "less compression", never to a crash inside
 * the compaction path.
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

  const spill = Object.freeze({
    enabled: spillRaw?.enabled ?? true,
    dir: spillDir,
    days: clamp(spillRaw?.days ?? 7, 1, 365),
  })

  return Object.freeze({
    enabled: raw.enabled ?? true,
    budgets: resolveTable(raw.budgets, DEFAULT_BUDGETS, 'budgets', BUDGET_MIN, BUDGET_CAP),
    minBytes: resolveTable(raw.minBytes, DEFAULT_MIN_BYTES, 'minBytes', 0, MIN_BYTES_CAP),
    readTrim: raw.readTrim ?? false,
    spill,
    shadow: raw.shadow ?? false,
    minSaveBytes,
    minSavePercent,
    statsDir,
    debug: raw.debug ?? false,
  })
}

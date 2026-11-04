/**
 * Config resolution and DSH<->engine mapping tests.
 *
 * These cover the plugin's own glue: defaults, clamping, rejection of typos,
 * and the translation between DSH tool identifiers and canonical tool classes.
 * v2.1: thresholds default to their budget, readTrim defaults on, spill/stats
 * live under ~/.dsh, and boolean / focusPatterns knobs are strictly validated.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

import {
  BUDGET_CAP,
  BUDGET_MIN,
  DEFAULT_BUDGETS,
  DEFAULT_MIN_BYTES,
  FOCUS_MAX_COUNT,
  FOCUS_MAX_LENGTH,
  MIN_BYTES_CAP,
  defaultSpillDir,
  defaultStatsDir,
  resolveConfig,
} from '../lib/config.js'
import {
  CONFIG_KEYS,
  TOOL_ALIASES,
  canonicalTool,
  configKey,
  engineOptions,
  extractText,
  rebuildContent,
  rebuildContentWithBlocks,
  textBlocks,
  valueForTool,
} from '../lib/mapping.js'

test('defaults match the documented tables (v2.1)', () => {
  const config = resolveConfig()
  assert.equal(config.enabled, true)
  assert.deepEqual({ ...config.budgets }, { ...DEFAULT_BUDGETS })
  assert.deepEqual({ ...config.minBytes }, { ...DEFAULT_MIN_BYTES })
  assert.equal(config.budgets.bash, 4000)
  assert.equal(config.budgets.default, 8000)
  // v2.1: 默认门槛等于预算（旧表 bash 3000 < 4000 是自相矛盾的死配置）
  assert.equal(config.minBytes.bash, 4000)
  assert.equal(config.minBytes.read, 8000)
  for (const key of Object.keys(DEFAULT_BUDGETS)) {
    assert.equal(DEFAULT_MIN_BYTES[key], DEFAULT_BUDGETS[key], key)
  }
  // v2.1: Read 默认纳入裁剪
  assert.equal(config.readTrim, true)
  assert.equal(config.shadow, false)
  assert.equal(config.minSaveBytes, 300)
  assert.equal(config.minSavePercent, 4)
  assert.equal(config.spill.enabled, true)
  assert.equal(config.spill.days, 7)
  assert.equal(config.statsDir, defaultStatsDir())
  assert.equal(config.spill.dir, defaultSpillDir())
  assert.deepEqual([...config.focusPatterns], [])
})

test('default spill/stats dirs live under ~/.dsh (stable across restarts)', () => {
  const config = resolveConfig()
  const root = path.join(os.homedir(), '.dsh', 'context-compression')
  assert.equal(config.statsDir, path.join(root, 'data'))
  assert.equal(config.spill.dir, path.join(root, 'spill'))
  assert.ok(path.isAbsolute(config.spill.dir))
  assert.ok(path.isAbsolute(config.statsDir))
  // v2.1: 不再落在 os.tmpdir()——Windows 上 DSH 每次启动都会换 %TEMP%
  assert.equal(config.spill.dir.startsWith(os.tmpdir()), false)
})

test('resolved config is deeply frozen', () => {
  const config = resolveConfig({ focusPatterns: ['ORD-'] })
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.budgets))
  assert.ok(Object.isFrozen(config.minBytes))
  assert.ok(Object.isFrozen(config.spill))
  assert.ok(Object.isFrozen(config.focusPatterns))
})

test('budgets and thresholds are clamped into their legal ranges', () => {
  const config = resolveConfig({
    budgets: { bash: 1, default: 999_999 },
    minBytes: { bash: 0, default: 999_999 },
  })
  assert.equal(config.budgets.bash, BUDGET_MIN)
  assert.equal(config.budgets.default, BUDGET_CAP)
  assert.equal(config.minBytes.bash, BUDGET_MIN, '门槛被抬到 >= 预算')
  assert.equal(config.minBytes.default, MIN_BYTES_CAP)
})

test('v2.1: minBytes 低于预算时被抬升到预算（否则触发必然白裁）', () => {
  const config = resolveConfig({
    budgets: { bash: 6000, read: 12000 },
    minBytes: { bash: 1000, read: 2000, default: 0 },
  })
  assert.equal(config.minBytes.bash, 6000)
  assert.equal(config.minBytes.read, 12000)
  for (const key of Object.keys(DEFAULT_BUDGETS)) {
    assert.ok(config.minBytes[key] >= config.budgets[key], key)
  }
})

test('unknown or malformed config keys are rejected', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
  assert.throws(() => resolveConfig({ budgets: { nope: 1 } }), /unknown config key "nope"/)
  assert.throws(() => resolveConfig({ budgets: { bash: 'x' } }), /must be a finite number/)
  assert.throws(() => resolveConfig({ spill: 'x' }), /spill must be an object/)
  assert.throws(() => resolveConfig({ spill: { dir: '' } }), /spill\.dir/)
  assert.throws(() => resolveConfig({ statsDir: 42 }), /statsDir must be a non-empty string/)
  assert.throws(() => resolveConfig({ minSavePercent: -1 }), /minSavePercent/)
  assert.throws(() => resolveConfig(null), /config must be an object/)
})

test('v2.1: boolean knobs reject non-boolean values instead of silently no-oping', () => {
  assert.throws(() => resolveConfig({ readTrim: 'true' }), /readTrim must be a boolean/)
  assert.throws(() => resolveConfig({ enabled: 1 }), /enabled must be a boolean/)
  assert.throws(() => resolveConfig({ shadow: 'yes' }), /shadow must be a boolean/)
  assert.throws(() => resolveConfig({ debug: '0' }), /debug must be a boolean/)
  assert.throws(() => resolveConfig({ spill: { enabled: 'true' } }), /spill\.enabled must be a boolean/)
  assert.doesNotThrow(() => resolveConfig({ readTrim: false, shadow: true, debug: false }))
})

test('v2.1: focusPatterns validation (array / non-empty / ≤32 / ≤128 chars)', () => {
  const config = resolveConfig({ focusPatterns: ['ORD-', 'trace-'] })
  assert.deepEqual([...config.focusPatterns], ['ORD-', 'trace-'])
  assert.throws(
    () => resolveConfig({ focusPatterns: 'ORD-' }),
    /focusPatterns must be an array of strings/,
  )
  assert.throws(() => resolveConfig({ focusPatterns: [''] }), /non-empty strings/)
  assert.throws(() => resolveConfig({ focusPatterns: ['ok', 7] }), /non-empty strings/)
  assert.throws(
    () => resolveConfig({ focusPatterns: Array.from({ length: FOCUS_MAX_COUNT + 1 }, () => 'x') }),
    new RegExp(`at most ${FOCUS_MAX_COUNT} entries`),
  )
  assert.throws(
    () => resolveConfig({ focusPatterns: ['x'.repeat(FOCUS_MAX_LENGTH + 1)] }),
    new RegExp(`at most ${FOCUS_MAX_LENGTH} characters`),
  )
  assert.doesNotThrow(() => resolveConfig({ focusPatterns: ['x'.repeat(FOCUS_MAX_LENGTH)] }))
})

test('spill can be disabled and its window bounded', () => {
  const config = resolveConfig({ spill: { enabled: false, days: 0 } })
  assert.equal(config.spill.enabled, false)
  assert.equal(config.spill.days, 1)
})

test('DSH tool aliases map onto the engine vocabulary', () => {
  assert.equal(canonicalTool('bash'), 'Bash')
  assert.equal(canonicalTool('pwsh'), 'Bash')
  assert.equal(canonicalTool('read'), 'Read')
  assert.equal(canonicalTool('grep'), 'Grep')
  assert.equal(canonicalTool('glob'), 'Glob')
  assert.equal(canonicalTool('web_fetch'), 'WebFetch')
  assert.equal(canonicalTool('web_search'), 'WebFetch')
  assert.equal(canonicalTool('jobs'), null)
  assert.equal(canonicalTool(undefined), null)
  assert.equal(canonicalTool(7), null)
  assert.equal(configKey('Bash'), 'bash')
  assert.equal(configKey('WebFetch'), 'webFetch')
  assert.equal(configKey('Nope'), 'default')
  for (const value of Object.values(TOOL_ALIASES)) {
    assert.ok(value in CONFIG_KEYS || value === 'Bash')
  }
})

test('per-tool values fall back to default', () => {
  const table = Object.freeze({ bash: 4000, default: 8000 })
  assert.equal(valueForTool(table, 'Bash'), 4000)
  assert.equal(valueForTool(table, 'Read'), 8000)
})

test('extractText joins text blocks and ignores rich blocks', () => {
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(extractText([{ type: 'image', data: 'x' }]), null)
  assert.equal(extractText([]), null)
  assert.equal(extractText(undefined), null)
})

test('rebuildContent keeps rich blocks after the single text block', () => {
  const blocks = [
    { type: 'text', text: 'one' },
    { type: 'image', data: 'i' },
    { type: 'text', text: 'two' },
  ]
  const rebuilt = rebuildContent(blocks, 'compressed')
  assert.deepEqual(rebuilt, [{ type: 'text', text: 'compressed' }, { type: 'image', data: 'i' }])
  assert.notEqual(rebuilt, blocks)
})

test('v2.1: textBlocks + rebuildContentWithBlocks keep block boundaries', () => {
  const content = [
    { type: 'text', text: 'stdout' },
    { type: 'image', data: 'i' },
    { type: 'text', text: 'stderr' },
  ]
  assert.deepEqual(textBlocks(content), [
    { index: 0, text: 'stdout' },
    { index: 2, text: 'stderr' },
  ])
  const rebuilt = rebuildContentWithBlocks(content, new Map([[0, 'A'], [2, 'B']]))
  assert.deepEqual(rebuilt, [
    { type: 'text', text: 'A' },
    { type: 'image', data: 'i' },
    { type: 'text', text: 'B' },
  ])
  assert.equal(rebuilt.length, content.length)
  assert.notEqual(rebuilt, content)
})

test('engineOptions derives every engine knob from config', () => {
  const config = resolveConfig({
    readTrim: true,
    budgets: { read: 20_000 },
    spill: { days: 3 },
    focusPatterns: ['ORD-', 'trace-'],
  })
  const options = engineOptions(config, 'Read', 'sess-9')
  assert.equal(options.budgetBytes, 20_000)
  // v2.1: 阈值被抬到 >= 预算
  assert.equal(options.minBytes, 20_000)
  assert.equal(options.readMode, true)
  assert.equal(options.readTrim, true)
  assert.equal(options.spillDays, 3)
  assert.equal(options.sessionId, 'sess-9')
  assert.equal(options.spillEnabled, true)
  assert.equal(options.minSaveBytes, 300)
  assert.equal(options.minSavePercent, 4)
  assert.deepEqual([...options.focusPatterns], ['ORD-', 'trace-'])
})

test('engineOptions keeps v2.1 defaults for Bash', () => {
  const options = engineOptions(resolveConfig(), 'Bash', 'sess-1')
  assert.equal(options.budgetBytes, 4000)
  assert.equal(options.minBytes, 4000)
  assert.equal(options.readMode, false)
  assert.equal(options.readTrim, true)
  assert.deepEqual([...options.focusPatterns], [])
})

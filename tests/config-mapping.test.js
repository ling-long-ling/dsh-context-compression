/**
 * Config resolution and DSH<->engine mapping tests.
 *
 * These cover the plugin's own glue: defaults, clamping, rejection of typos,
 * and the translation between DSH tool identifiers and canonical tool classes.
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
  valueForTool,
} from '../lib/mapping.js'

test('defaults match the documented tables', () => {
  const config = resolveConfig()
  assert.equal(config.enabled, true)
  assert.deepEqual({ ...config.budgets }, { ...DEFAULT_BUDGETS })
  assert.deepEqual({ ...config.minBytes }, { ...DEFAULT_MIN_BYTES })
  assert.equal(config.budgets.bash, 4000)
  assert.equal(config.budgets.default, 8000)
  assert.equal(config.minBytes.bash, 3000)
  assert.equal(config.readTrim, false)
  assert.equal(config.shadow, false)
  assert.equal(config.minSaveBytes, 300)
  assert.equal(config.minSavePercent, 4)
  assert.equal(config.spill.enabled, true)
  assert.equal(config.spill.days, 7)
  assert.equal(config.statsDir, defaultStatsDir())
  assert.equal(config.spill.dir, defaultSpillDir())
  assert.ok(path.isAbsolute(config.spill.dir))
  assert.ok(config.spill.dir.startsWith(os.tmpdir()))
})

test('resolved config is deeply frozen', () => {
  const config = resolveConfig()
  assert.ok(Object.isFrozen(config))
  assert.ok(Object.isFrozen(config.budgets))
  assert.ok(Object.isFrozen(config.minBytes))
  assert.ok(Object.isFrozen(config.spill))
})

test('budgets and thresholds are clamped into their legal ranges', () => {
  const config = resolveConfig({
    budgets: { bash: 1, default: 999_999 },
    minBytes: { bash: 0, default: 999_999 },
  })
  assert.equal(config.budgets.bash, BUDGET_MIN)
  assert.equal(config.budgets.default, BUDGET_CAP)
  assert.equal(config.minBytes.bash, 0)
  assert.equal(config.minBytes.default, MIN_BYTES_CAP)
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

test('engineOptions derives every engine knob from config', () => {
  const config = resolveConfig({ readTrim: true, budgets: { read: 20_000 }, spill: { days: 3 } })
  const options = engineOptions(config, 'Read', 'sess-9')
  assert.equal(options.budgetBytes, 20_000)
  assert.equal(options.minBytes, 8000)
  assert.equal(options.readMode, true)
  assert.equal(options.readTrim, true)
  assert.equal(options.spillDays, 3)
  assert.equal(options.sessionId, 'sess-9')
  assert.equal(options.spillEnabled, true)
  assert.equal(options.minSaveBytes, 300)
  assert.equal(options.minSavePercent, 4)
})

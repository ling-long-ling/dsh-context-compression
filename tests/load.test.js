/**
 * Real-Cordis load test.
 *
 * The unit tests drive the service through a fake context. This test mounts the
 * actual plugin into a real `@deepseek-ai/cordis` Context to prove the Cordis
 * wiring works: `inject: ['tokenMeter']` resolves, `ctx.provide()` registers the
 * service under the name the compaction engine looks up, and disposal removes
 * it again.
 *
 * Cordis lives inside the installed DSH app, which is not a dependency of this
 * repository, so the test skips when it cannot be located. Set `DSH_APP_DIR` to
 * point at `.../DSH Desktop/resources/app` on a non-standard install.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import plugin, { apply, inject, name } from '../lib/index.js'

/**
 * Locate the installed DSH app directory.
 * @returns {string|null} absolute app directory, or `null` when unknown.
 */
function locateAppDir() {
  const candidates = []
  if (process.env.DSH_APP_DIR) candidates.push(process.env.DSH_APP_DIR)
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app'))
  }
  candidates.push(path.join(process.env.ProgramFiles ?? '', 'DSH Desktop', 'resources', 'app'))
  for (const candidate of candidates) {
    if (!candidate) continue
    if (fs.existsSync(path.join(candidate, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'))) {
      return candidate
    }
  }
  return null
}

const appDir = locateAppDir()

/**
 * Poll until `predicate` is truthy or the budget runs out.
 * @param {() => boolean} predicate - condition to wait for.
 * @param {number} [timeoutMs] - budget in milliseconds.
 * @returns {Promise<boolean>} whether the condition held before the timeout.
 */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

test('plugin module exposes the cordis plugin shape', () => {
  assert.equal(name, 'dsh-context-compression')
  assert.deepEqual(inject, ['tokenMeter'])
  assert.equal(typeof apply, 'function')
  assert.equal(plugin.name, 'dsh-context-compression')
  assert.equal(plugin.apply, apply)
})

test('loads inside a real Cordis context', { skip: appDir === null }, async () => {
  const { Context } = await import(
    pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  )

  const ctx = new Context()
  ctx.provide('tokenMeter', { estimateMessage: () => 7 })
  const fiber = ctx.plugin(plugin, { spill: { enabled: false } })

  const active = await waitFor(() => ctx.get('toolResultPruner') !== undefined)
  assert.ok(active, 'toolResultPruner service did not register inside the real context')
  const service = ctx.get('toolResultPruner')
  assert.equal(service.name, 'toolResultPruner')
  assert.equal(typeof service.pruneSession, 'function')
  assert.equal(service.version, '2.0.0')

  // Disposal must unregister the service; the compaction engine then falls back
  // to "no pruner" rather than holding a dead reference.
  await fiber.dispose()
  const gone = await waitFor(() => ctx.get('toolResultPruner') === undefined)
  assert.ok(gone, 'service survived plugin disposal')
})

test('the pruner service is isolated per compaction realm', { skip: appDir === null }, async () => {
  const { Context } = await import(
    pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  )
  const root = new Context()
  root.provide('tokenMeter', { estimateMessage: () => 7 })

  // Each agent preset mounts the row inside its own `compaction` group, whose
  // isolate map contains `toolResultPruner`; the three realms must not collide.
  const realms = ['standard', 'ptc', 'cordis'].map((tag) => {
    const realm = root.isolate('toolResultPruner')
    realm.plugin(plugin, { spill: { enabled: false } })
    return { tag, realm }
  })
  const ready = await waitFor(() => realms.every(({ realm }) => realm.get('toolResultPruner', false) !== undefined))
  assert.ok(ready, 'isolated realms did not each register their own pruner')
  for (const { realm } of realms) {
    assert.equal(realm.get('toolResultPruner').version, '2.0.0')
  }
  assert.equal(root.get('toolResultPruner', false), undefined, 'isolated service leaked to the root')
})

test('a plugin without the token meter stays pending', { skip: appDir === null }, async () => {
  const { Context } = await import(
    pathToFileURL(path.join(appDir, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  )
  const ctx = new Context()
  ctx.plugin(plugin, { spill: { enabled: false } })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(ctx.get('toolResultPruner'), undefined)
})

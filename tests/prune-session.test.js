/**
 * `toolResultPruner` service contract tests.
 *
 * The service is the seam `@deepseek-ai/dsh-compaction-basic` calls before it
 * summarises a region. These tests drive it against an in-memory session that
 * records appends, so they pin the replay-safe write protocol:
 *
 *   compaction/prune (shadow price)  ->  tool/result (surfaceOp: replace)
 *
 * and the safety rules: failed tool results, untracked tools, and shadow mode
 * must never rewrite the surface.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../lib/index.js'
import { resolveConfig } from '../lib/config.js'

/**
 * Build a throwaway stats directory for one test.
 * @returns {string} absolute directory path.
 */
function tempStatsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ctx-test-'))
}

/**
 * Minimal cordis-like context: logger, token meter, and a service registry.
 * @returns {object} fake context.
 */
function makeCtx() {
  const services = new Map()
  return {
    logger: {
      info() {},
      warn() {},
      debug() {},
      error() {},
    },
    tokenMeter: {
      estimateMessage: () => 42,
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
    services,
  }
}

/**
 * Mount the plugin into a fake context.
 * @param {object} [config] - plugin config.
 * @returns {{ctx: object, service: object}} fake context and registered service.
 */
function mountPlugin(config = {}) {
  const ctx = makeCtx()
  apply(ctx, { statsDir: tempStatsDir(), ...config })
  return { ctx, service: ctx.services.get('toolResultPruner') }
}

/**
 * In-memory session that mimics the pieces `pruneSession` touches.
 * @param {Array<object>} events - seed log (seq assigned by position).
 * @returns {object} fake session.
 */
function makeSession(events) {
  const log = events.map((event, index) => ({ ...event, seq: index + 1 }))
  const surface = new Set(log.map((event) => event.seq))
  return {
    id: 'session-under-test',
    log,
    surface: { nodes: surface },
    eventAt(seq) {
      return log[seq - 1] ?? null
    },
    deriveEventMessage(event) {
      return event.data?.message ?? null
    },
    append(type, data, options) {
      const seq = log.length + 1
      const event = { type, seq, data }
      if (options?.surfaceOp !== undefined) event.surfaceOp = options.surfaceOp
      if (options?.sourceEventSeqs !== undefined) event.sourceEventSeqs = options.sourceEventSeqs
      log.push(event)
      if (type === 'tool/result') {
        const op = options?.surfaceOp
        if (op?.op === 'replace') surface.delete(op.startSeq)
        surface.add(seq)
      }
      return event
    },
  }
}

/**
 * One tool call plus its result.
 * @param {{callId: string, tool: string, text: string, isError?: boolean}} input - call description.
 * @returns {Array<object>} the two events.
 */
function callPair(input) {
  return [
    { type: 'tool/call', data: { callId: input.callId, name: input.tool, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: input.callId },
          toolCallId: input.callId,
          content: [{ type: 'text', text: input.text }],
          isError: input.isError ?? false,
          id: `msg-${input.callId}`,
        },
      },
    },
  ]
}

/**
 * Build a log-ish output long enough to cross the Bash budget.
 * @param {number} lineCount - number of lines.
 * @returns {string} text.
 */
function noisyLog(lineCount = 400) {
  const lines = []
  for (let i = 0; i < lineCount; i += 1) {
    if (i % 37 === 5) lines.push(`2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z ERROR step=${i} connect failed: ECONNREFUSED 127.0.0.1:6379`)
    else lines.push(`2026-11-01T00:00:${String(i % 60).padStart(2, '0')}Z INFO  step=${i} status=running heap=${i % 64}MB`)
  }
  return lines.join('\n')
}

test('registers the toolResultPruner service', () => {
  const { service } = mountPlugin()
  assert.ok(service)
  assert.equal(service.name, 'toolResultPruner')
  assert.equal(typeof service.pruneSession, 'function')
  assert.equal(typeof service.diagnostics, 'function')
})

test('disabled config registers nothing', () => {
  const { service } = mountPlugin({ enabled: false })
  assert.equal(service, undefined)
})

test('compresses an over-budget Bash result replay-safely', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-1', tool: 'bash', text: noisyLog() }))
  const result = service.pruneSession(session)

  assert.equal(result.pruned.length, 1)
  assert.ok(result.bytesRemoved > 0)
  const entry = result.pruned[0]
  assert.equal(entry.originalSeq, 2)
  assert.equal(entry.tool, 'Bash')
  assert.ok(entry.bytesAfter < entry.bytesBefore)

  // The write protocol: shadow price first, then the replacing tool result.
  const appended = session.log.slice(2)
  assert.equal(appended.length, 2)
  assert.equal(appended[0].type, 'compaction/prune')
  assert.deepEqual(appended[0].data.shadowedSeqs, [2])
  assert.deepEqual(appended[0].data.shadowedRange, { start: 2, end: 2 })
  assert.equal(appended[0].data.shadowedTokenCount, 42)

  assert.equal(appended[1].type, 'tool/result')
  assert.deepEqual(appended[1].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
  assert.deepEqual(appended[1].sourceEventSeqs, [2])
  const replacementText = appended[1].data.message.content[0].text
  assert.notEqual(replacementText, noisyLog())
  assert.match(replacementText, /… \[dsh-ctx 省略 \d+ 行（第 \d+–\d+ 行）/)
  // Identity and call wiring survive the rewrite.
  assert.equal(appended[1].data.message.id, 'msg-call-1')
  assert.equal(appended[1].data.message.source.callId, 'call-1')
  assert.equal(appended[1].data.message.isError, false)
  // The original event is untouched: replay must recover the replacement input.
  assert.equal(session.log[1].data.message.content[0].text, noisyLog())
})

test('the replacement is a frozen, detached message', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-f', tool: 'bash', text: noisyLog() }))
  service.pruneSession(session)
  const message = session.log.at(-1).data.message
  assert.ok(Object.isFrozen(message))
  assert.ok(Object.isFrozen(message.content))
  assert.notEqual(message, session.log[1].data.message)
})

test('a second pass is idempotent', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-2', tool: 'bash', text: noisyLog() }))
  assert.equal(service.pruneSession(session).pruned.length, 1)
  const lengthAfterFirst = session.log.length
  assert.equal(service.pruneSession(session).pruned.length, 0)
  assert.equal(session.log.length, lengthAfterFirst)
})

test('failed tool results are never compressed', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-3', tool: 'bash', text: noisyLog(), isError: true }))
  const result = service.pruneSession(session)
  assert.equal(result.pruned.length, 0)
  assert.equal(session.log.length, 2)
})

test('untracked tools are ignored', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-4', tool: 'jobs', text: noisyLog() }))
  assert.equal(service.pruneSession(session).pruned.length, 0)
  assert.equal(session.log.length, 2)
})

test('Read output stays intact unless readTrim is enabled', () => {
  const text = Array.from({ length: 1600 }, (_, i) => `line ${i} export function fn${i}() {}`).join('\n')
  const off = mountPlugin({ spill: { enabled: false } })
  const offSession = makeSession(callPair({ callId: 'call-5', tool: 'read', text }))
  assert.equal(off.service.pruneSession(offSession).pruned.length, 0)

  const on = mountPlugin({ spill: { enabled: false }, readTrim: true })
  const onSession = makeSession(callPair({ callId: 'call-6', tool: 'read', text }))
  assert.equal(on.service.pruneSession(onSession).pruned.length, 1)
})

test('shadow mode measures without rewriting the surface', () => {
  const statsDir = tempStatsDir()
  const { service } = mountPlugin({ statsDir, shadow: true, spill: { enabled: false } })
  const session = makeSession(callPair({ callId: 'call-7', tool: 'bash', text: noisyLog() }))
  const result = service.pruneSession(session)
  assert.equal(result.pruned.length, 0)
  assert.equal(session.log.length, 2)
  const last = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-trim.json'), 'utf8'))
  assert.equal(last.reason, 'shadow')
  assert.equal(last.shadow, true)
  assert.ok(last.saved > 0)
})

test('diagnostics record why a candidate was skipped', () => {
  const statsDir = tempStatsDir()
  const { service } = mountPlugin({ statsDir, spill: { enabled: false } })
  const session = makeSession([
    ...callPair({ callId: 'call-8', tool: 'bash', text: 'short output' }),
    ...callPair({ callId: 'call-9', tool: 'grep', text: 'x' }),
  ])
  service.pruneSession(session)
  const diagnostics = service.diagnostics()
  assert.equal(diagnostics.candidates, 2)
  assert.equal(diagnostics.trimmed, 0)
  assert.ok(diagnostics.recent.length >= 1)
  const last = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-trim.json'), 'utf8'))
  assert.equal(typeof last.reason, 'string')
})

test('a broken session does not escape pruneSession', () => {
  const { service } = mountPlugin()
  const broken = {
    get surface() {
      throw new Error('boom')
    },
  }
  const result = service.pruneSession(broken)
  assert.deepEqual(result, { pruned: [], bytesRemoved: 0 })
  assert.equal(service.diagnostics().errors, 1)
})

test('resolveConfig rejects a bogus plugin row early', () => {
  assert.throws(() => mountPlugin({ nope: true }), /unknown config key/)
  assert.doesNotThrow(() => apply(makeCtx(), undefined))
})

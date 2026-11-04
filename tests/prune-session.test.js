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
 * One tool call plus a result with an explicit content-block array
 * (v2.1 R7: stdout/stderr 多 text block 场景).
 * @param {{callId: string, tool: string, content: Array<object>}} input - call description.
 * @returns {Array<object>} the two events.
 */
function callPairBlocks(input) {
  return [
    { type: 'tool/call', data: { callId: input.callId, name: input.tool, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: input.callId },
          toolCallId: input.callId,
          content: input.content,
          isError: false,
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
  assert.match(replacementText, /… \[dsh-ctx 省略 \d+ 行（第 \d+–\d+ 行/)
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

test('v2.1 R2：Read output 默认被裁；readTrim=false 才保持原样', () => {
  const text = Array.from({ length: 1600 }, (_, i) => `line ${i} export function fn${i}() {}`).join('\n')

  const on = mountPlugin({ spill: { enabled: false } })
  const onSession = makeSession(callPair({ callId: 'call-5', tool: 'read', text }))
  assert.equal(on.service.pruneSession(onSession).pruned.length, 1)

  const off = mountPlugin({ spill: { enabled: false }, readTrim: false })
  const offSession = makeSession(callPair({ callId: 'call-6', tool: 'read', text }))
  assert.equal(off.service.pruneSession(offSession).pruned.length, 0)
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
  assert.deepEqual(result, { pruned: [], bytesRemoved: 0, charsRemoved: 0 })
  assert.equal(service.diagnostics().errors, 1)
})

test('resolveConfig rejects a bogus plugin row early', () => {
  assert.throws(() => mountPlugin({ nope: true }), /unknown config key/)
  assert.doesNotThrow(() => apply(makeCtx(), undefined))
})

// ---- v2.1 新增：契约 / 可观测性 / 多 block ----

test('v2.1：服务版本为 2.1.0', () => {
  const { service } = mountPlugin()
  assert.equal(service.version, '2.1.0')
})

test('v2.1 R7：pruneSession 返回 charsRemoved，条目带 charsBefore/charsAfter', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const text = noisyLog()
  const session = makeSession(callPair({ callId: 'call-chars', tool: 'bash', text }))
  const result = service.pruneSession(session)

  assert.deepEqual(Object.keys(result).sort(), ['bytesRemoved', 'charsRemoved', 'pruned'])
  assert.equal(result.pruned.length, 1)
  const entry = result.pruned[0]
  assert.equal(entry.charsBefore, text.length)
  assert.ok(entry.charsAfter < entry.charsBefore)
  assert.equal(result.charsRemoved, entry.charsBefore - entry.charsAfter)
  assert.equal(result.bytesRemoved, entry.bytesBefore - entry.bytesAfter)
  assert.ok(result.charsRemoved > 0)
})

test('v2.1 R8：决策记录每趟批量 flush 到 saves-*.jsonl', () => {
  const statsDir = tempStatsDir()
  const { service } = mountPlugin({ statsDir, spill: { enabled: false } })
  const session = makeSession([
    ...callPair({ callId: 'c-trim', tool: 'bash', text: noisyLog() }),
    ...callPair({ callId: 'c-short', tool: 'grep', text: 'tiny output' }),
    ...callPair({ callId: 'c-fail', tool: 'bash', text: noisyLog(), isError: true }),
  ])
  service.pruneSession(session)

  const savesFile = fs
    .readdirSync(statsDir)
    .find((name) => /^saves-\d{4}-\d{2}\.jsonl$/.test(name))
  assert.ok(savesFile, fs.readdirSync(statsDir).join(','))
  const entries = fs
    .readFileSync(path.join(statsDir, savesFile), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(entries.length, 3, '一趟三条决策一次写入')
  assert.deepEqual(entries.map((entry) => entry.seq), [2, 4, 6])
  assert.deepEqual(entries.map((entry) => entry.reason), ['trim', 'short', 'tool_failed'])
  assert.equal(entries[0].tool, 'Bash')
  assert.ok(entries[0].bytesBefore > entries[0].bytesAfter)
  assert.ok(entries[0].charsBefore > entries[0].charsAfter)
  // 同一趟 flush 里 last-trim.json 也被更新（最后一条决策为准）
  const last = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-trim.json'), 'utf8'))
  assert.equal(last.reason, 'tool_failed')
})

test('v2.1 R8：apply 写 last-boot.json（证明插件真的加载过）', () => {
  const statsDir = tempStatsDir()
  mountPlugin({ statsDir })
  const boot = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-boot.json'), 'utf8'))
  assert.equal(boot.version, '2.1.0')
  assert.equal(boot.enabled, true)
  assert.equal(boot.readTrim, true)
  assert.equal(boot.budgets.bash, 4000)
  assert.equal(boot.minBytes.bash, 4000, 'v2.1 门槛被抬到 >= 预算')
  assert.equal(boot.statsDir, statsDir)
  assert.ok(typeof boot.at === 'string' && !Number.isNaN(Date.parse(boot.at)))
})

test('v2.1 R8：每趟 pruneSession 都写 last-pass.json（0 裁剪也写）', () => {
  const statsDir = tempStatsDir()
  const { service } = mountPlugin({ statsDir, spill: { enabled: false } })

  // 空会话：0 候选也留痕，回答「它到底跑没跑过」
  const zero = service.pruneSession(makeSession([]))
  assert.equal(zero.pruned.length, 0)
  const pass = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-pass.json'), 'utf8'))
  assert.equal(pass.version, '2.1.0')
  assert.equal(pass.trimmed, 0)
  assert.equal(pass.candidates, 0)
  assert.equal(pass.aborted, false)
  assert.equal(pass.bytesRemoved, 0)
  assert.equal(pass.charsRemoved, 0)
  assert.equal(pass.session, 'session-under-test')

  // 下一趟真的裁剪，同一个文件被覆盖成最新一趟
  service.pruneSession(makeSession(callPair({ callId: 'c-pass', tool: 'bash', text: noisyLog() })))
  const second = JSON.parse(fs.readFileSync(path.join(statsDir, 'last-pass.json'), 'utf8'))
  assert.equal(second.trimmed, 1)
  assert.equal(second.candidates, 1)
  assert.ok(second.bytesRemoved > 0)
  assert.ok(second.charsRemoved > 0)
})

test('v2.1 R7：多 text block 逐块裁剪，块数与富块位置不变', () => {
  const { service } = mountPlugin({ spill: { enabled: false } })
  const stdout = Array.from({ length: 120 }, (_, i) => `stdout line ${i} ${'a'.repeat(40)}`).join('\n')
  const stderr = Array.from({ length: 120 }, (_, i) => `stderr line ${i} ${'b'.repeat(40)}`).join('\n')
  const content = [
    { type: 'text', text: stdout },
    { type: 'image', data: 'img' },
    { type: 'text', text: stderr },
  ]
  const session = makeSession(callPairBlocks({ callId: 'call-blocks', tool: 'bash', content }))
  const result = service.pruneSession(session)

  assert.equal(result.pruned.length, 1)
  const entry = result.pruned[0]
  assert.equal(entry.charsBefore, stdout.length + stderr.length)
  assert.ok(entry.charsAfter < entry.charsBefore)

  const replacement = session.log.at(-1)
  assert.equal(replacement.type, 'tool/result')
  const blocks = replacement.data.message.content
  assert.equal(blocks.length, 3, '块数不变')
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('… [dsh-ctx 省略 '), 'stdout 被裁')
  assert.ok(Buffer.byteLength(blocks[0].text) < Buffer.byteLength(stdout))
  assert.deepEqual(blocks[1], { type: 'image', data: 'img' }, '富块位置与内容不变')
  assert.equal(blocks[2].type, 'text')
  assert.ok(blocks[2].text.includes('… [dsh-ctx 省略 '), 'stderr 被裁')
  assert.ok(Buffer.byteLength(blocks[2].text) < Buffer.byteLength(stderr))
  assert.deepEqual(replacement.surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 })
})


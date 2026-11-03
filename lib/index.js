/**
 * dsh-context-compression — a DSH Cordis plugin that compresses tool results
 * with the layered STRONG / SKELETON / WEAK algorithm.
 *
 * The plugin registers the `toolResultPruner` service, the same seam the
 * official `@deepseek-ai/dsh-compaction-tool-result-pruner` provides, so the
 * compaction engine (`@deepseek-ai/dsh-compaction-basic`) calls this
 * implementation before it summarises a region. Two properties matter:
 *
 * 1. **Replay-safe writes.** A replacement never mutates an existing event: it
 *    appends a fresh `tool/result` with `surfaceOp: replace`, preceded by a
 *    `compaction/prune` shadow-price event, exactly like the official pruner.
 *    Replay therefore recovers the replacement input from the log.
 * 2. **Never break compaction.** Every candidate is isolated in its own
 *    try/catch: a compression bug degrades to "leave the output alone", never
 *    to a failed turn.
 *
 * The plugin is dependency-free on purpose: it imports only Node builtins and
 * its own modules, so a `link:` install resolves without pulling peer packages
 * into the profile.
 *
 * @module dsh-context-compression
 */

import fs from 'node:fs'
import path from 'node:path'

import { resolveConfig } from './config.js'
import { trimToolText } from './engine/index.js'
import {
  canonicalTool,
  engineOptions,
  extractText,
  rebuildContent,
} from './mapping.js'

/** Cordis plugin name (matches the package name). */
export const name = 'dsh-context-compression'

/** Services the plugin waits for before activating. */
export const inject = ['tokenMeter']

/** Service name registered on the context; official pruner uses the same. */
const SERVICE_NAME = 'toolResultPruner'

/** Version reported in diagnostics; keep in sync with package.json. */
const PLUGIN_VERSION = '2.0.0'

/** How many entries of the in-memory ring buffer diagnostics keep. */
const RECENT_LIMIT = 40

/**
 * Deep-freeze a value in place, mirroring `deepFreeze` from the DSH value
 * utilities without importing them.
 * @template T
 * @param {T} value - value to freeze.
 * @returns {T} the same value.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/**
 * Detach and deep-freeze a message that already has a stable identity.
 * @param {object} message - complete message including its id.
 * @returns {object} immutable detached copy.
 */
function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

/**
 * Collect the DSH tool identifier behind each call id in one surface snapshot.
 * @param {Iterable<number>} nodes - surface sequence numbers.
 * @param {{ eventAt: (seq: number) => any }} session - session being pruned.
 * @returns {Map<string, string>} call id -> tool identifier.
 */
function collectToolNames(nodes, session) {
  const names = new Map()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/call') continue
    const callId = event.data?.callId
    const toolName = event.data?.name
    if (typeof callId === 'string' && typeof toolName === 'string') {
      names.set(callId, toolName)
    }
  }
  return names
}

/**
 * Create the `toolResultPruner` service implementation.
 *
 * @param {import('./config.js').resolveConfig extends (...args: any[]) => infer R ? R : never} config - resolved plugin config.
 * @param {{ tokenMeter: { estimateMessage: (message: any) => number }, logger?: any }} ctx - owning cordis context.
 * @returns {{
 *   name: string,
 *   version: string,
 *   pruneSession: (session: any) => { pruned: Array<object>, bytesRemoved: number },
 *   diagnostics: () => object,
 * }} the service object.
 */
function createService(config, ctx) {
  /** @type {Array<object>} recent decisions, newest last. */
  const recent = []
  /** @type {Record<string, number>} lifetime counters. */
  const totals = {
    candidates: 0,
    trimmed: 0,
    skippedFailed: 0,
    skippedUntrackedTool: 0,
    skippedNoText: 0,
    skippedNoGain: 0,
    bytesRemoved: 0,
    errors: 0,
  }

  /**
   * Append one decision to the in-memory ring buffer and the on-disk stats.
   * Recording is best-effort: a read-only home directory must not break a turn.
   * @param {object} entry - decision record.
   */
  function record(entry) {
    recent.push(entry)
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT)
    try {
      fs.mkdirSync(config.statsDir, { recursive: true })
      const now = new Date(entry.at)
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      fs.appendFileSync(
        path.join(config.statsDir, `saves-${month}.jsonl`),
        `${JSON.stringify(entry)}\n`,
        'utf8',
      )
      fs.writeFileSync(
        path.join(config.statsDir, 'last-trim.json'),
        `${JSON.stringify(
          {
            version: PLUGIN_VERSION,
            at: entry.at,
            session: entry.session,
            tool: entry.tool,
            reason: entry.reason,
            bytesBefore: entry.bytesBefore,
            bytesAfter: entry.bytesAfter,
            saved: entry.bytesBefore - entry.bytesAfter,
            shadow: entry.shadow,
            totals,
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch {
      /* stats are diagnostics, never a correctness dependency */
    }
    if (config.debug) {
      try {
        ctx.logger?.info?.(
          `dsh-context-compression: ${entry.tool} seq=${entry.seq} ${entry.reason} ` +
            `${entry.bytesBefore}->${entry.bytesAfter} bytes`,
        )
      } catch {
        /* logging must not throw either */
      }
    }
  }

  /**
   * Estimate the shadow price of one message, tolerating meter failures.
   * @param {object} message - message being replaced.
   * @returns {number} token estimate, or `0` when the meter cannot price it.
   */
  function estimateTokens(message) {
    try {
      const estimate = ctx.tokenMeter?.estimateMessage?.(message)
      return typeof estimate === 'number' && Number.isFinite(estimate) ? estimate : 0
    } catch {
      return 0
    }
  }

  /**
   * Resolve the session identifier used for spill folders and stats.
   * @param {any} session - session being pruned.
   * @returns {string} identifier, or `''` when the session exposes none.
   */
  function sessionIdOf(session) {
    for (const key of ['id', 'sessionId']) {
      const value = session?.[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }

  /**
   * Compress every over-budget tool result from one stable surface snapshot.
   *
   * @param {any} session - session whose current surface is rewritten.
   * @returns {{pruned: Array<object>, bytesRemoved: number}} landed
   *   replacements and aggregate UTF-8 byte savings.
   */
  function pruneSession(session) {
    const pruned = []
    let bytesRemoved = 0
    try {
      const nodes = [...session.surface.nodes]
      const toolNames = collectToolNames(nodes, session)
      const sessionId = sessionIdOf(session)
      for (const seq of nodes) {
        try {
          const event = session.eventAt(seq)
          if (event?.type !== 'tool/result') continue
          totals.candidates += 1
          const data = event.data ?? {}
          const original = session.deriveEventMessage(event)

          // A failed tool call is the failure scene: never compress it away.
          if (data.message?.isError === true || original?.isError === true) {
            totals.skippedFailed += 1
            record({
              at: Date.now(),
              session: sessionId,
              seq,
              tool: null,
              reason: 'tool_failed',
              bytesBefore: 0,
              bytesAfter: 0,
              shadow: config.shadow,
            })
            continue
          }

          const callId = original?.source?.callId ?? data.message?.source?.callId
          const canonical = canonicalTool(toolNames.get(callId))
          if (canonical === null) {
            totals.skippedUntrackedTool += 1
            continue
          }

          const text = extractText(original?.content)
          if (text === null) {
            totals.skippedNoText += 1
            continue
          }

          const options = engineOptions(config, canonical, sessionId)
          const decision = trimToolText({ text, tool: canonical }, options)
          const bytesBefore = Buffer.byteLength(text, 'utf8')

          if (decision?.text === null || decision?.text === undefined) {
            record({
              at: Date.now(),
              session: sessionId,
              seq,
              tool: canonical,
              reason: decision?.reason ?? 'short',
              bytesBefore,
              bytesAfter: bytesBefore,
              shadow: config.shadow,
            })
            continue
          }

          const bytesAfter = Buffer.byteLength(decision.text, 'utf8')
          if (bytesAfter >= bytesBefore) {
            totals.skippedNoGain += 1
            record({
              at: Date.now(),
              session: sessionId,
              seq,
              tool: canonical,
              reason: 'no_gain',
              bytesBefore,
              bytesAfter,
              shadow: config.shadow,
            })
            continue
          }

          if (config.shadow) {
            record({
              at: Date.now(),
              session: sessionId,
              seq,
              tool: canonical,
              reason: 'shadow',
              bytesBefore,
              bytesAfter,
              shadow: true,
            })
            continue
          }

          const content = rebuildContent(original.content, decision.text)
          const message = freezeMessage({ ...original, content })
          session.append('compaction/prune', {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: estimateTokens(original),
          })
          const replacement = session.append(
            'tool/result',
            { ...event.data, message },
            {
              surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
              sourceEventSeqs: [seq],
            },
          )
          totals.trimmed += 1
          totals.bytesRemoved += bytesBefore - bytesAfter
          bytesRemoved += bytesBefore - bytesAfter
          pruned.push({
            originalSeq: seq,
            replacementSeq: replacement.seq,
            callId,
            tool: canonical,
            bytesBefore,
            bytesAfter,
            meta: decision.meta,
          })
          record({
            at: Date.now(),
            session: sessionId,
            seq,
            tool: canonical,
            reason: decision.reason ?? 'trim',
            bytesBefore,
            bytesAfter,
            shadow: false,
          })
        } catch (error) {
          totals.errors += 1
          try {
            ctx.logger?.warn?.(
              `dsh-context-compression: skipping tool result seq=${seq}: ${error?.message ?? error}`,
            )
          } catch {
            /* swallow logging failures */
          }
        }
      }
    } catch (error) {
      totals.errors += 1
      try {
        ctx.logger?.warn?.(`dsh-context-compression: prune pass aborted: ${error?.message ?? error}`)
      } catch {
        /* swallow logging failures */
      }
    }
    return { pruned, bytesRemoved }
  }

  return {
    name: SERVICE_NAME,
    version: PLUGIN_VERSION,
    pruneSession,
    diagnostics: () => Object.freeze({ ...totals, recent: [...recent] }),
  }
}

/**
 * Cordis plugin entry point.
 *
 * @param {any} ctx - owning cordis context (inside the compaction group's
 *   isolate scope).
 * @param {object} [config] - plugin config from `cordis.patch.yml`.
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config ?? {})
  if (!resolved.enabled) {
    try {
      ctx.logger?.info?.('dsh-context-compression: disabled by config')
    } catch {
      /* ignore */
    }
    return
  }
  const service = createService(resolved, ctx)
  ctx.provide(SERVICE_NAME, service)
  try {
    ctx.logger?.info?.(
      `dsh-context-compression ${PLUGIN_VERSION} active ` +
        `(budgets: bash=${resolved.budgets.bash}B other=${resolved.budgets.default}B, ` +
        `shadow=${resolved.shadow}, spill=${resolved.spill.enabled})`,
    )
  } catch {
    /* ignore */
  }
}

export default { name, inject, apply }

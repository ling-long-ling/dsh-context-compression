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
 * v2.1 additions (report R7/R8 + P2-3):
 *   - `pruneSession` also returns `charsRemoved` and per-entry char counts,
 *     matching the official pruner's return shape;
 *   - multi text-block results are trimmed per block, so stdout/stderr block
 *     boundaries survive;
 *   - `statsDir/last-boot.json` + `last-pass.json` record that the plugin
 *     loaded and what each compaction pass did (even when it trimmed nothing);
 *   - decision records are buffered and flushed once per pass instead of one
 *     `fs` write per candidate.
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
  rebuildContent,
  rebuildContentWithBlocks,
  textBlocks,
} from './mapping.js'

/** Cordis plugin name (matches the package name). */
export const name = 'dsh-context-compression'

/** Services the plugin waits for before activating. */
export const inject = ['tokenMeter']

/** Service name registered on the context; official pruner uses the same. */
const SERVICE_NAME = 'toolResultPruner'

/** Version reported in diagnostics; keep in sync with package.json. */
const PLUGIN_VERSION = '2.1.0'

/** How many entries of the in-memory ring buffer diagnostics keep. */
const RECENT_LIMIT = 40

/** Flush buffered decision records after this many entries. */
const FLUSH_EVERY = 512

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
 * Write the startup snapshot (report R8).
 *
 * The 2.0 install had a real mystery: the log said "active" three times but
 * `statsDir` was empty, because nothing was recorded without a compaction.
 * This file proves the plugin loaded and pins the resolved configuration.
 *
 * @param {object} config - resolved plugin config.
 */
function writeBootSnapshot(config) {
  try {
    fs.mkdirSync(config.statsDir, { recursive: true })
    fs.writeFileSync(
      path.join(config.statsDir, 'last-boot.json'),
      `${JSON.stringify(
        {
          version: PLUGIN_VERSION,
          at: new Date().toISOString(),
          node: process.version,
          enabled: config.enabled,
          budgets: config.budgets,
          minBytes: config.minBytes,
          readTrim: config.readTrim,
          shadow: config.shadow,
          spill: config.spill,
          minSaveBytes: config.minSaveBytes,
          minSavePercent: config.minSavePercent,
          focusPatterns: config.focusPatterns,
          statsDir: config.statsDir,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch {
    /* diagnostics never break activation */
  }
}

/**
 * Create the `toolResultPruner` service implementation.
 *
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} config - resolved plugin config.
 * @param {{ tokenMeter: { estimateMessage: (message: any) => number }, logger?: any }} ctx - owning cordis context.
 * @returns {{
 *   name: string,
 *   version: string,
 *   pruneSession: (session: any) => { pruned: Array<object>, bytesRemoved: number, charsRemoved: number },
 *   diagnostics: () => object,
 * }} the service object.
 */
function createService(config, ctx) {
  /** @type {Array<object>} recent decisions, newest last. */
  const recent = []
  /** @type {Array<object>} decisions waiting to be flushed to disk. */
  let pending = []
  /** @type {Record<string, number>} lifetime counters. */
  const totals = {
    candidates: 0,
    trimmed: 0,
    skippedFailed: 0,
    skippedUntrackedTool: 0,
    skippedNoText: 0,
    skippedNoGain: 0,
    bytesRemoved: 0,
    charsRemoved: 0,
    errors: 0,
    prunedPasses: 0,
    abortedPasses: 0,
  }

  /**
   * Append the buffered decision records to the on-disk stats.
   * One write per pass instead of one write per candidate.
   */
  function flush() {
    if (pending.length === 0) return
    const batch = pending
    pending = []
    try {
      fs.mkdirSync(config.statsDir, { recursive: true })
      const lastEntry = batch[batch.length - 1]
      const now = new Date(lastEntry.at)
      const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
      fs.appendFileSync(
        path.join(config.statsDir, `saves-${month}.jsonl`),
        batch.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        'utf8',
      )
      fs.writeFileSync(
        path.join(config.statsDir, 'last-trim.json'),
        `${JSON.stringify(
          {
            version: PLUGIN_VERSION,
            at: lastEntry.at,
            session: lastEntry.session,
            tool: lastEntry.tool,
            reason: lastEntry.reason,
            bytesBefore: lastEntry.bytesBefore,
            bytesAfter: lastEntry.bytesAfter,
            saved: lastEntry.bytesBefore - lastEntry.bytesAfter,
            shadow: lastEntry.shadow,
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
  }

  /**
   * Record one decision (in memory now, on disk at the next flush).
   * @param {object} entry - decision record.
   */
  function record(entry) {
    recent.push(entry)
    if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT)
    pending.push(entry)
    if (pending.length >= FLUSH_EVERY) flush()
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
   * Persist one compaction-pass summary — even when nothing was trimmed (R8).
   * @param {object} summary - pass summary.
   */
  function writePassSummary(summary) {
    try {
      fs.mkdirSync(config.statsDir, { recursive: true })
      fs.writeFileSync(
        path.join(config.statsDir, 'last-pass.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      )
    } catch {
      /* diagnostics only */
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
   * `charsRemoved` mirrors the official pruner's extra return field; it counts
   * UTF-16 code units (`String#length`), so for CJK/emoji-heavy output it can
   * differ from the code-point count the official implementation reports.
   *
   * @param {any} session - session whose current surface is rewritten.
   * @returns {{pruned: Array<object>, bytesRemoved: number, charsRemoved: number}} landed
   *   replacements and aggregate savings.
   */
  function pruneSession(session) {
    const pruned = []
    let bytesRemoved = 0
    let charsRemoved = 0
    let candidates = 0
    let aborted = false
    let sessionId = ''
    try {
      const nodes = [...session.surface.nodes]
      const toolNames = collectToolNames(nodes, session)
      sessionId = sessionIdOf(session)
      for (const seq of nodes) {
        try {
          const event = session.eventAt(seq)
          if (event?.type !== 'tool/result') continue
          totals.candidates += 1
          candidates += 1
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

          const blocks = textBlocks(original?.content)
          if (blocks.length === 0) {
            totals.skippedNoText += 1
            continue
          }

          const options = engineOptions(config, canonical, sessionId)
          const bytesBefore = blocks.reduce(
            (sum, block) => sum + Buffer.byteLength(block.text, 'utf8'),
            0,
          )
          const charsBefore = blocks.reduce((sum, block) => sum + block.text.length, 0)

          // R7: one text block is the common case; several (stdout + stderr) are
          // trimmed block by block so the block boundaries survive.
          /** @type {Map<number, string>} */
          const replacements = new Map()
          let bytesAfter = 0
          let charsAfter = 0
          const meta = { k: 0, g: 0, w: 0, p: 0 }
          let lastReason = 'short'
          for (const block of blocks) {
            const blockBytes = Buffer.byteLength(block.text, 'utf8')
            let blockOptions = options
            if (blocks.length > 1) {
              const share = Math.max(
                2000,
                Math.floor((options.budgetBytes * blockBytes) / Math.max(1, bytesBefore)),
              )
              blockOptions = { ...options, budgetBytes: share, minBytes: share }
            }
            const decision = trimToolText({ text: block.text, tool: canonical }, blockOptions)
            if (decision?.text === null || decision?.text === undefined) {
              lastReason = decision?.reason ?? 'short'
              bytesAfter += blockBytes
              charsAfter += block.text.length
              continue
            }
            const afterBytes = Buffer.byteLength(decision.text, 'utf8')
            if (afterBytes >= blockBytes) {
              lastReason = 'no_gain'
              bytesAfter += blockBytes
              charsAfter += block.text.length
              continue
            }
            replacements.set(block.index, decision.text)
            meta.k += decision.meta.k
            meta.g += decision.meta.g
            if (decision.meta.w >= 0 && meta.w >= 0) meta.w += decision.meta.w
            else meta.w = -1
            meta.p = Math.max(meta.p, decision.meta.p)
            bytesAfter += afterBytes
            charsAfter += decision.text.length
          }

          if (replacements.size === 0) {
            record({
              at: Date.now(),
              session: sessionId,
              seq,
              tool: canonical,
              reason: lastReason,
              bytesBefore,
              bytesAfter: bytesBefore,
              charsBefore,
              charsAfter: charsBefore,
              shadow: config.shadow,
            })
            continue
          }

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
              charsBefore,
              charsAfter,
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
              charsBefore,
              charsAfter,
              shadow: true,
            })
            continue
          }

          const content =
            blocks.length === 1
              ? rebuildContent(original.content, replacements.get(blocks[0].index))
              : rebuildContentWithBlocks(original.content, replacements)
          const message = freezeMessage({ ...original, content })
          session.append('compaction/prune', {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: estimateTokens(original),
          })
          let replacement
          try {
            replacement = session.append(
              'tool/result',
              { ...event.data, message },
              {
                surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
                sourceEventSeqs: [seq],
              },
            )
          } catch (appendError) {
            // The shadow-price event is already in the log; without the
            // replacing tool/result it would keep pricing a node nobody can see.
            // Stop the pass instead of piling up more dangling shadows.
            aborted = true
            totals.abortedPasses += 1
            try {
              ctx.logger?.warn?.(
                `dsh-context-compression: aborted prune pass after seq=${seq}: ${appendError?.message ?? appendError}`,
              )
            } catch {
              /* swallow logging failures */
            }
            break
          }
          totals.trimmed += 1
          totals.bytesRemoved += bytesBefore - bytesAfter
          totals.charsRemoved += charsBefore - charsAfter
          bytesRemoved += bytesBefore - bytesAfter
          charsRemoved += charsBefore - charsAfter
          pruned.push({
            originalSeq: seq,
            replacementSeq: replacement.seq,
            callId,
            tool: canonical,
            bytesBefore,
            bytesAfter,
            charsBefore,
            charsAfter,
            meta: { ...meta },
          })
          record({
            at: Date.now(),
            session: sessionId,
            seq,
            tool: canonical,
            reason: 'trim',
            bytesBefore,
            bytesAfter,
            charsBefore,
            charsAfter,
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
    if (pruned.length > 0) totals.prunedPasses += 1
    // R8: even a 0-trim pass leaves a trace, so "did it ever run?" is answerable.
    writePassSummary({
      version: PLUGIN_VERSION,
      at: new Date().toISOString(),
      session: sessionId,
      shadow: config.shadow,
      aborted,
      candidates,
      trimmed: pruned.length,
      bytesRemoved,
      charsRemoved,
      skippedFailed: totals.skippedFailed,
      skippedNoGain: totals.skippedNoGain,
      totals: { ...totals },
    })
    flush()
    return { pruned, bytesRemoved, charsRemoved }
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
  writeBootSnapshot(resolved)
  try {
    ctx.logger?.info?.(
      `dsh-context-compression ${PLUGIN_VERSION} active ` +
        `(budgets: bash=${resolved.budgets.bash}B read=${resolved.budgets.read}B ` +
        `other=${resolved.budgets.default}B, readTrim=${resolved.readTrim}, ` +
        `shadow=${resolved.shadow}, spill=${resolved.spill.enabled}, ` +
        `stats=${resolved.statsDir})`,
    )
  } catch {
    /* ignore */
  }
}

export default { name, inject, apply }

/**
 * Mapping between DSH tool names / message content blocks and the engine's
 * WorkBuddy-era vocabulary.
 *
 * The trimming engine predates DSH and speaks in canonical tool classes
 * (`Bash`, `Grep`, `Glob`, `WebFetch`, `Read`). DSH tool calls arrive as
 * snake_case identifiers (`bash`, `pwsh`, `read`, `web_fetch`, ...), so this
 * module is the only place that knows both dialects.
 *
 * @module dsh-context-compression/mapping
 */

/** DSH tool identifier -> canonical engine tool class. */
export const TOOL_ALIASES = Object.freeze({
  bash: 'Bash',
  pwsh: 'Bash',
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  web_fetch: 'WebFetch',
  web_search: 'WebFetch',
})

/** Canonical tool class -> config table key (`budgets`, `minBytes`). */
export const CONFIG_KEYS = Object.freeze({
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  WebFetch: 'webFetch',
  Read: 'read',
})

/**
 * Resolve a DSH tool identifier to the engine's canonical class.
 * @param {unknown} dshToolName - `tool/call` event `data.name`.
 * @returns {'Bash'|'Grep'|'Glob'|'WebFetch'|'Read'|null} canonical class, or
 *   `null` when this plugin must not touch the tool's output.
 */
export function canonicalTool(dshToolName) {
  if (typeof dshToolName !== 'string') return null
  return TOOL_ALIASES[dshToolName] ?? null
}

/**
 * Resolve the config table key for a canonical tool class.
 * @param {string} canonical - canonical engine tool class.
 * @returns {string} key into the `budgets` / `minBytes` tables.
 */
export function configKey(canonical) {
  return CONFIG_KEYS[canonical] ?? 'default'
}

/**
 * Pick a per-tool number from a resolved `{key: number}` config table.
 * @param {Readonly<Record<string, number>>} table - resolved config table.
 * @param {string} canonical - canonical engine tool class.
 * @returns {number} the tool's value, falling back to `default`.
 */
export function valueForTool(table, canonical) {
  const key = configKey(canonical)
  return table[key] ?? table.default
}

/**
 * Concatenate the text blocks of a message content array.
 *
 * Tool results produced by DSH tools are normally a single text block; when a
 * tool emits several (for example stdout plus stderr), they are joined with a
 * newline because the engine treats its input as one flat text buffer.
 *
 * @param {unknown} content - message content (array of blocks).
 * @returns {string|null} joined text, or `null` when there is no text block.
 */
export function extractText(content) {
  if (!Array.isArray(content)) return null
  const texts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  if (texts.length === 0) return null
  return texts.join('\n')
}

/**
 * Rebuild message content around one compressed text buffer.
 *
 * Every text block is replaced by a single block placed where the first text
 * block stood; rich blocks (images, files) keep their relative order after it.
 * Text order is preserved because {@link extractText} joined the blocks in
 * order.
 *
 * @param {ReadonlyArray<object>} content - original message content blocks.
 * @param {string} text - compressed text.
 * @returns {Array<object>} new content blocks (never the same array).
 */
export function rebuildContent(content, text) {
  if (!Array.isArray(content)) return [{ type: 'text', text }]
  const rebuilt = []
  let textPlaced = false
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text') {
      if (!textPlaced) {
        rebuilt.push({ type: 'text', text })
        textPlaced = true
      }
      continue
    }
    rebuilt.push(block)
  }
  if (!textPlaced) rebuilt.unshift({ type: 'text', text })
  return rebuilt
}

/**
 * Build the engine options for one tool result.
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} config - resolved plugin config.
 * @param {string} canonical - canonical engine tool class.
 * @param {string} sessionId - session identifier used for spill folder names.
 * @returns {object} options accepted by `trimToolText`.
 */
export function engineOptions(config, canonical, sessionId) {
  return {
    budgetBytes: valueForTool(config.budgets, canonical),
    minBytes: valueForTool(config.minBytes, canonical),
    readMode: canonical === 'Read',
    readTrim: config.readTrim,
    spillEnabled: config.spill.enabled,
    spillDir: config.spill.dir,
    spillDays: config.spill.days,
    sessionId,
    minSaveBytes: config.minSaveBytes,
    minSavePercent: config.minSavePercent,
  }
}

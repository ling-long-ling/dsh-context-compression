#!/usr/bin/env node
/**
 * Install (or uninstall) this plugin into a local DSH profile.
 *
 * The plugin is a drop-in replacement for the official deterministic tool-result
 * pruner: it registers the same `toolResultPruner` service, so the install has
 * two moving parts.
 *
 * 1. `package.json` gains a `link:` dependency on this checkout.
 * 2. `cordis.patch.yml` has the official `tool-result-pruner` row inside every
 *    agent preset's `compaction` group replaced by this package's row.
 *
 * The script is idempotent: running it twice is a no-op, and `--uninstall`
 * restores the official row. `--dry-run` prints the plan without touching disk.
 *
 * Usage:
 *   node scripts/install-profile.mjs [--profile <dir>] [--repo <dir>]
 *                                    [--dry-run] [--uninstall]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = path.resolve(HERE, '..')
const DEFAULT_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const PACKAGE_ALIAS = 'dsh-context-compression'
const OFFICIAL_PRUNER = '@deepseek-ai/dsh-compaction-tool-result-pruner'
const ROW_ID = 'context-compression'

/** The exact official row block, matched textually so generated comments survive. */
const OFFICIAL_BLOCK = `          - id: tool-result-pruner
            name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
            config:
              thresholdChars: 8192
              headChars: 4096
              tailChars: 1024
`

/** Our replacement row block, at the same indentation as the official one. */
const OUR_BLOCK = `          - id: ${ROW_ID}
            name: ${PACKAGE_ALIAS}
            config:
              budgets:
                bash: 4000
`

/**
 * Parse `--key value` flags.
 * @param {string[]} argv - process arguments after the script path.
 * @returns {{profile: string, repo: string, dryRun: boolean, uninstall: boolean}} parsed flags.
 */
function parseArgs(argv) {
  const options = { profile: DEFAULT_PROFILE, repo: DEFAULT_REPO, dryRun: false, uninstall: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--uninstall') options.uninstall = true
    else if (flag === '--profile') options.profile = path.resolve(argv[++i])
    else if (flag === '--repo') options.repo = path.resolve(argv[++i])
    else throw new Error(`install-profile: unknown argument "${flag}"`)
  }
  return options
}

/**
 * Read a UTF-8 text file.
 * @param {string} file - absolute path.
 * @returns {string} contents.
 */
function read(file) {
  return fs.readFileSync(file, 'utf8')
}

/**
 * Write a UTF-8 text file, creating parent directories when needed.
 * @param {string} file - absolute path.
 * @param {string} content - contents to write.
 */
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

/**
 * Print one line of progress.
 * @param {string} message - line to print.
 */
function say(message) {
  process.stdout.write(`${message}\n`)
}

/**
 * Align the profile `package.json` dependency entry.
 * @param {string} profile - profile directory.
 * @param {string} repo - repository checkout directory.
 * @param {{dryRun: boolean, uninstall: boolean}} options - flags.
 * @returns {boolean} whether the file would change.
 */
function syncProfilePackage(profile, repo, options) {
  const file = path.join(profile, 'package.json')
  const manifest = JSON.parse(read(file))
  const target = `link:${repo.replaceAll('\\', '/')}`
  const current = manifest.dependencies?.[PACKAGE_ALIAS]
  const wanted = options.uninstall ? undefined : target
  if (current === wanted) {
    say(`  package.json: ${options.uninstall ? 'no dependency to remove' : 'dependency already linked'}`)
    return false
  }
  if (options.uninstall) delete manifest.dependencies?.[PACKAGE_ALIAS]
  else manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_ALIAS]: target }
  say(`  package.json: ${options.uninstall ? 'remove' : 'add'} "${PACKAGE_ALIAS}": "${target}"`)
  if (!options.dryRun) write(file, `${JSON.stringify(manifest, null, 2)}\n`)
  return true
}

/**
 * Replace (or restore) the official pruner row in every preset compaction group.
 * @param {string} profile - profile directory.
 * @param {{dryRun: boolean, uninstall: boolean}} options - flags.
 * @returns {boolean} whether the patch file would change.
 */
function syncCordisPatch(profile, options) {
  const file = path.join(profile, 'cordis.patch.yml')
  const before = read(file)
  let after = before
  if (options.uninstall) {
    after = before
      .split(OUR_BLOCK)
      .join(OFFICIAL_BLOCK)
      .replace(
        new RegExp(
          String.raw`^ {10}- id: ${ROW_ID}\n {12}name: ${PACKAGE_ALIAS}\n(?: {12}.*\n| {14}.*\n)*`,
          'gm',
        ),
        '',
      )
  } else {
    if (after.includes(`- id: ${ROW_ID}`) && !after.includes(`id: tool-result-pruner`)) {
      say('  cordis.patch.yml: context-compression row already installed')
      return false
    }
    after = before.split(OFFICIAL_BLOCK).join(OUR_BLOCK)
    if (after === before) {
      say('  cordis.patch.yml: no official tool-result-pruner row found — nothing to replace')
      say('    (check that this profile still mounts the official pruner in its presets)')
      return false
    }
  }
  if (after === before) {
    say('  cordis.patch.yml: nothing to do')
    return false
  }
  const stamps = after === before ? 0 : (before.split(OFFICIAL_BLOCK).length - 1)
  say(
    `  cordis.patch.yml: ${options.uninstall ? 'restore official row in' : 'replace official row in'} ` +
      `${stamps || 'preset'} place(s)`,
  )
  if (!options.dryRun) {
    const backup = `${file}.bak-dsh-ctx-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`
    if (!options.uninstall) write(backup, before)
    write(file, after)
    say(`  backup written: ${backup}`)
  }
  return true
}

/**
 * Link the checkout into the profile's node_modules, replacing any stale entry.
 * @param {string} profile - profile directory.
 * @param {string} repo - repository checkout directory.
 * @param {{dryRun: boolean, uninstall: boolean}} options - flags.
 */
function syncNodeModules(profile, repo, options) {
  const linkPath = path.join(profile, 'node_modules', PACKAGE_ALIAS)
  const exists = fs.existsSync(linkPath) || isLink(linkPath)
  if (options.uninstall) {
    if (!exists) {
      say('  node_modules: no link to remove')
      return
    }
    say(`  node_modules: remove link ${linkPath}`)
    if (!options.dryRun) fs.rmSync(linkPath, { recursive: true, force: true })
    return
  }
  if (exists) {
    say('  node_modules: link already present')
    return
  }
  say(`  node_modules: link ${linkPath} -> ${repo}`)
  if (options.dryRun) return
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  try {
    fs.symlinkSync(repo, linkPath, 'junction')
  } catch (error) {
    throw new Error(
      `could not create junction ${linkPath}: ${error.message}\n` +
        '  Fallback: run `pnpm install` in the profile after editing package.json.',
    )
  }
}

/**
 * Detect an existing symlink/junction even when the target is missing.
 * @param {string} target - path to inspect.
 * @returns {boolean} whether the path is a link.
 */
function isLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Entry point.
 */
function main() {
  const options = parseArgs(process.argv.slice(2))
  const profile = options.profile
  if (!fs.existsSync(path.join(profile, 'package.json'))) {
    throw new Error(`install-profile: ${profile} does not look like a DSH profile (no package.json)`)
  }
  if (!fs.existsSync(path.join(options.repo, 'package.json'))) {
    throw new Error(`install-profile: ${options.repo} does not look like this plugin's checkout`)
  }
  say(`dsh-context-compression ${options.uninstall ? 'uninstall' : 'install'}`)
  say(`  profile: ${profile}`)
  say(`  repo   : ${options.repo}`)
  if (options.dryRun) say('  mode   : dry-run (no files are written)')

  syncProfilePackage(profile, options.repo, options)
  syncCordisPatch(profile, options)
  syncNodeModules(profile, options.repo, options)

  say('')
  if (options.uninstall) {
    say('Done. Restart DSH (or let the profile patch reloader pick it up) to drop the plugin.')
  } else {
    say('Done. Restart DSH to load the plugin, then verify:')
    say('  1. DSH logs contain "dsh-context-compression 2.0.0 active"')
    say('  2. a long tool output is replaced by a "… [dsh-ctx 省略 N 行 …] …" marker')
    say('  3. diagnostics: %TEMP%\\dsh-context-compression\\data\\last-trim.json')
  }
}

main()

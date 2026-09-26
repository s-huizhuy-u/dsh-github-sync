#!/usr/bin/env node
/**
 * Install dsh-github-sync into a local DSH profile.
 *
 * The plugin is three things on disk: the package itself, a declaration in the
 * profile manifest, and a loader row in the profile's patch layer. This script
 * writes all three, which is what the marketplace would otherwise do for a
 * published package.
 *
 * A DSH desktop install has more than one plausible home — the launcher exports
 * `DSH_HOME`, while a CLI install defaults to `~/.dsh` — so the home is probed
 * and reported rather than assumed.
 *
 * Usage:
 *   node scripts/install.mjs [--home <dir>] [--profile web] [--dry-run]
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PROFILE, resolveDshHome } from '../lib/dsh-home.js'

const PACKAGE_NAME = 'dsh-github-sync'
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse the small flag set this script accepts.
 * @returns {{ home?: string, profile: string, dryRun: boolean }} parsed options.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const options = { profile: DEFAULT_PROFILE, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--home') options.home = argv[++index]
    else if (flag === '--profile') options.profile = argv[++index]
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node scripts/install.mjs [--home <dir>] [--profile web] [--dry-run]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${flag}`)
      process.exit(2)
    }
  }
  return options
}

/**
 * Recursively copy a directory, replacing the destination.
 * @param {string} from - source directory.
 * @param {string} to - destination directory.
 * @returns {Promise<void>} resolves once the copy is complete.
 */
async function replaceDirectory(from, to) {
  await rm(to, { recursive: true, force: true })
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules`) && !source.includes(`${path.sep}.git${path.sep}`),
  })
}

/**
 * Add the plugin to the profile manifest.
 * @param {string} manifestPath - path to the profile `package.json`.
 * @returns {Promise<{ changed: boolean, manifest: object }>} what happened.
 */
async function declarePlugin(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []
  manifest.dependencies ??= {}
  let changed = false
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
    manifest.dsh.profile.bundles.push(PACKAGE_NAME)
    changed = true
  }
  /* A `file:` spec is installable offline, unlike a registry version for a
     package that was never published. */
  const spec = `file:.local-plugins/${PACKAGE_NAME}`
  if (manifest.dependencies[PACKAGE_NAME] !== spec) {
    manifest.dependencies[PACKAGE_NAME] = spec
    changed = true
  }
  return { changed, manifest }
}

/** The loader row this package contributes, as profile-patch YAML. */
const LOADER_ROW = `- insert:\n    - id: ${PACKAGE_NAME}\n      name: ${PACKAGE_NAME}\n`

/**
 * Ensure the profile's patch layer loads this package.
 *
 * The file is a top-level YAML list, so appending one more list item is valid
 * whether it currently holds `[]`, other rows, or only comments.
 * @param {string} patchPath - path to `cordis.patch.yml`.
 * @returns {Promise<{ changed: boolean, created: boolean }>} what happened.
 */
async function declareLoaderRow(patchPath) {
  const created = !existsSync(patchPath)
  const text = created ? '' : await readFile(patchPath, 'utf8')
  if (new RegExp(`^\\s*name:\\s*${PACKAGE_NAME}\\s*$`, 'm').test(text)) {
    return { changed: false, created: false }
  }
  /* Comments and whitespace do not make the document non-empty, so strip them
     before deciding whether an empty-list placeholder is still present. */
  const body = text.replace(/^\s*#.*$/gm, '').trim()
  let next
  if (body === '' || body === '[]') {
    const withoutPlaceholder = text.replace(/^\s*\[\s*\]\s*$/m, '').trimEnd()
    next = `${withoutPlaceholder}${withoutPlaceholder ? '\n' : ''}${LOADER_ROW}`
  } else {
    next = `${text.trimEnd()}\n${LOADER_ROW}`
  }
  await writeFile(patchPath, next, 'utf8')
  return { changed: true, created }
}

const options = parseArgs()
const resolved = resolveDshHome({ requested: options.home ?? process.env.DSH_HOME, profile: options.profile })
if (!resolved) {
  console.error(`Refusing to install: no DSH home was found.`)
  console.error('Pass --home <dir> to point at the DSH home that holds profiles/.')
  process.exit(1)
}
const home = resolved.home
const profileDir = path.join(home, 'profiles', options.profile)
const manifestPath = path.join(profileDir, 'package.json')
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const localCopy = path.join(profileDir, '.local-plugins', PACKAGE_NAME)
const modulesCopy = path.join(profileDir, 'node_modules', PACKAGE_NAME)

console.log(`${PACKAGE_NAME} installer`)
console.log(`  source   ${PACKAGE_ROOT}`)
console.log(`  DSH home ${home}  (${resolved.reason})`)
console.log(`  profile  ${profileDir}`)
console.log('')

if (!existsSync(manifestPath)) {
  console.error(`Refusing to install: no profile manifest at ${manifestPath}`)
  console.error('Pass --home <dir> to point at the right DSH home.')
  process.exit(1)
}

if (options.dryRun) {
  console.log('dry run: nothing written')
  process.exit(0)
}

await replaceDirectory(PACKAGE_ROOT, localCopy)
await replaceDirectory(PACKAGE_ROOT, modulesCopy)
console.log(`  wrote    ${localCopy}`)
console.log(`  wrote    ${modulesCopy}`)

const declared = await declarePlugin(manifestPath)
if (declared.changed) {
  await writeFile(manifestPath, `${JSON.stringify(declared.manifest, null, 2)}\n`, 'utf8')
  console.log(`  updated  ${manifestPath}`)
} else {
  console.log(`  unchanged ${manifestPath}`)
}

const loaded = await declareLoaderRow(patchPath)
if (loaded.changed) {
  console.log(`  ${loaded.created ? 'created ' : 'updated '} ${patchPath}`)
} else {
  console.log(`  unchanged ${patchPath}`)
}

console.log('')
console.log('Installed. Restart DSH to load the plugin, then ask the assistant to sync a project.')
console.log('Set GITHUB_TOKEN (a personal access token with the "repo" scope) before launching DSH,')
console.log('or have the assistant store one with the github_configure tool.')

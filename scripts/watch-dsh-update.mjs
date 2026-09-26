/**
 * Detect a DeepSeek Harness core upgrade and leave a notice the assistant can
 * read.
 *
 * A plugin is written against one harness API surface. When the app updates, a
 * plugin may reference a package version, export, or service that no longer
 * exists, and the failure mode is a plugin tree that will not load. Recording
 * the core version and reporting a change turns that into a visible,
 * actionable reminder.
 *
 * The version tracked is the harness core itself
 * (`@deepseek-ai/dsh-base`), not the desktop shell: the core is what plugins
 * compile against, and it is resolvable from the profile on every platform.
 *
 * Usage:
 *   node scripts/watch-dsh-update.mjs            # check, write or clear the notice
 *   node scripts/watch-dsh-update.mjs --quiet    # same, but silent when unchanged
 *   node scripts/watch-dsh-update.mjs --home <dir>
 *
 * Register it as a login task so it runs whenever the machine starts.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_PROFILE, homeFilePath, resolveDshHome } from '../lib/dsh-home.js'

const PACKAGE_NAME = 'dsh-github-sync'
/** Packages probed for the core version, most specific first. */
const CORE_PACKAGES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh', '@deepseek-ai/dsh-tools']

/**
 * Parse the supported flags.
 * @returns {{ home?: string, profile: string, quiet: boolean }} parsed options.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const options = { profile: DEFAULT_PROFILE, quiet: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--home') options.home = argv[++index]
    else if (flag === '--profile') options.profile = argv[++index]
    else if (flag === '--quiet') options.quiet = true
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node scripts/watch-dsh-update.mjs [--home <dir>] [--profile web] [--quiet]')
      process.exit(0)
    }
  }
  return options
}

/**
 * Read the installed core version.
 * @param {string} home - DSH home.
 * @param {string} profile - profile name.
 * @returns {Promise<{ package: string, version: string }|undefined>} the resolved version.
 */
async function readCoreVersion(home, profile) {
  const roots = [
    path.join(home, 'profiles', profile, 'node_modules'),
    path.join(home, 'profiles', 'node_modules'),
  ]
  for (const root of roots) {
    for (const packageName of CORE_PACKAGES) {
      const manifest = path.join(root, packageName, 'package.json')
      if (!existsSync(manifest)) continue
      try {
        const parsed = JSON.parse(await readFile(manifest, 'utf8'))
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
          return { package: packageName, version: parsed.version }
        }
      } catch {
        /* A half-written manifest is not a version fact; try the next source. */
      }
    }
  }
  return undefined
}

const options = parseArgs()
const resolved = resolveDshHome({ requested: options.home, profile: options.profile })
if (!resolved) {
  if (!options.quiet) console.log(`${PACKAGE_NAME}: no DSH home found; nothing to watch.`)
  process.exit(0)
}
const home = resolved.home

const statePath = homeFilePath(home, 'version.json')
const noticePath = homeFilePath(home, 'update-notice.json')
const current = await readCoreVersion(home, options.profile)

if (!current) {
  if (!options.quiet) console.log(`${PACKAGE_NAME}: could not determine the harness core version.`)
  process.exit(0)
}

let previous
if (existsSync(statePath)) {
  try {
    previous = JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    previous = undefined
  }
}

await mkdir(path.dirname(statePath), { recursive: true })
await writeFile(statePath, `${JSON.stringify({ ...current, checkedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')

if (previous?.version === undefined || previous.version === current.version) {
  await rm(noticePath, { force: true })
  if (!options.quiet) console.log(`${PACKAGE_NAME}: harness core ${current.version} unchanged.`)
  process.exit(0)
}

const notice = {
  from: previous.version,
  to: current.version,
  package: current.package,
  detectedAt: new Date().toISOString(),
  message: `The DeepSeek Harness core moved from ${previous.version} to ${current.version}. Installed plugins were built against the previous surface and may no longer load.`,
  request: `DSH was updated from ${previous.version} to ${current.version}. Check every installed plugin for compatibility and update the ones that need it.`,
}
await writeFile(noticePath, `${JSON.stringify(notice, null, 2)}\n`, 'utf8')

console.log('')
console.log('========================================')
console.log('  DSH updated - plugins may need updating')
console.log('========================================')
console.log('')
console.log(`  ${notice.message}`)
console.log('')
console.log('  Send this to the assistant in DSH:')
console.log('')
console.log(`  "${notice.request}"`)
console.log('')
console.log(`  Notice written to: ${noticePath}`)
console.log('')
process.exit(0)

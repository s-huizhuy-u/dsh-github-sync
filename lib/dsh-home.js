/**
 * Locate the DSH home directory.
 *
 * A desktop install and a CLI install keep their state in different places, and
 * the desktop launcher exports `DSH_HOME` for whichever one is running. Probing
 * in priority order is what lets the installer and the update watcher agree on
 * one directory instead of writing to a home the application never reads.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default profile name a DSH desktop install uses. */
export const DEFAULT_PROFILE = 'web'

/**
 * Every DSH home this machine might be using, most specific first.
 * @returns {string[]} candidate directories, de-duplicated.
 */
export function candidateDshHomes() {
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME)
  const { APPDATA, XDG_CONFIG_HOME } = process.env
  if (process.platform === 'win32' && APPDATA) {
    candidates.push(path.join(APPDATA, 'dsh-desktop', 'harness'))
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'))
  }
  if (XDG_CONFIG_HOME) candidates.push(path.join(XDG_CONFIG_HOME, 'dsh-desktop', 'harness'))
  candidates.push(path.join(homedir(), '.config', 'dsh-desktop', 'harness'))
  candidates.push(path.join(homedir(), '.dsh'))
  return [...new Set(candidates.filter((entry) => typeof entry === 'string' && entry.length > 0))]
}

/**
 * Resolve the DSH home to operate on.
 * @param {object} [options] - resolution options.
 * @param {string} [options.requested] - an explicit home, from `--home` or `DSH_HOME`.
 * @param {string} [options.profile] - profile name that should exist.
 * @param {boolean} [options.requireProfile] - when true, only a home holding that profile qualifies.
 * @returns {{ home: string, reason: string }|undefined} the chosen home, or `undefined` when none qualifies.
 */
export function resolveDshHome(options = {}) {
  const profile = options.profile ?? DEFAULT_PROFILE
  const candidates = options.requested ? [path.resolve(options.requested)] : candidateDshHomes()

  const withProfile = candidates.filter((candidate) =>
    existsSync(path.join(candidate, 'profiles', profile, 'package.json')))
  if (withProfile.length > 0) return { home: withProfile[0], reason: `holds profiles/${profile}/package.json` }

  if (options.requireProfile !== false) {
    const existing = candidates.find((candidate) => existsSync(candidate))
    if (existing) return { home: existing, reason: 'exists but has no profile manifest yet' }
  }
  const existing = candidates.find((candidate) => existsSync(candidate))
  return existing ? { home: existing, reason: 'exists but has no profile manifest yet' } : undefined
}

/**
 * The path of a plugin-owned state file inside the DSH home.
 * @param {string} home - DSH home.
 * @param {string} fileName - file name.
 * @returns {string} absolute path.
 */
export function homeFilePath(home, fileName) {
  return path.join(home, `dsh-github-sync-${fileName}`)
}

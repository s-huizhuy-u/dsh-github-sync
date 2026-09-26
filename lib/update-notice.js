/**
 * Surface a pending harness-upgrade notice to the assistant.
 *
 * `scripts/watch-dsh-update.mjs` records the harness core version and, when it
 * changes, writes a notice into the DSH home. Reading it here is what turns a
 * file on disk into something the model can act on: a plugin built against an
 * older core surface is the usual reason a plugin tree stops loading after an
 * app update.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homeFilePath, resolveDshHome } from './dsh-home.js'

/**
 * Read the pending upgrade notice, when one exists.
 * @returns {Promise<{ from: string, to: string, request: string }|undefined>} the notice, or `undefined`.
 */
export async function readUpdateNotice() {
  const resolved = resolveDshHome({ requested: process.env.DSH_HOME })
  if (!resolved) return undefined
  const noticePath = homeFilePath(resolved.home, 'update-notice.json')
  if (!existsSync(noticePath)) return undefined
  try {
    const parsed = JSON.parse(await readFile(noticePath, 'utf8'))
    if (typeof parsed?.from !== 'string' || typeof parsed?.to !== 'string') return undefined
    return {
      from: parsed.from,
      to: parsed.to,
      request: typeof parsed.request === 'string'
        ? parsed.request
        : `DSH was updated from ${parsed.from} to ${parsed.to}. Check the installed plugins for compatibility.`,
    }
  } catch {
    /* A corrupt notice is not worth failing a status call over. */
    return undefined
  }
}

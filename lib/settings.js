/**
 * Configuration for GitHub sync: non-secret defaults in the settings
 * namespace, the personal access token in the credential store.
 *
 * The split follows the harness seam's own rule — *settings carry references to
 * secrets, providers own the values*. A PAT pasted into a settings field would
 * be written verbatim into `settings.yaml`, so the token lives in
 * `ctx.credentials` instead, which persists under file mode `0600` behind a
 * write lock. An environment variable still wins over both, which is the best
 * option for CI and for users who would rather not store the token at all.
 */
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Settings namespace owned by this plugin. */
export const NAMESPACE = 'github-sync'

/** Credential record holding the personal access token. */
export const TOKEN_RECORD = credentialKey('dsh-github-sync', 'configuration')

/** Environment variables consulted before the stored token, in priority order. */
export const TOKEN_ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN']

/**
 * Non-secret defaults, all optional.
 *
 * `autoInit` defaults to `false` on purpose: a repository created with an
 * initial commit already contains a commit the workspace does not have, which
 * makes the very first push a non-fast-forward rejection.
 */
export const Config = z.object({
  owner: z.string().default('')
    .description('GitHub account that owns new repositories. Empty means the token\'s own user.'),
  visibility: z.union([z.const('private'), z.const('public'), z.const('internal')])
    .default('private')
    .description('Visibility for newly created repositories.'),
  autoInit: z.boolean().default(false)
    .description('Let GitHub create an initial commit. Keep this off so the first push is accepted.'),
  commitMessage: z.string().default('')
    .description('Commit message used when the workspace has no repository yet.'),
})

/** The empty credential payload, used before anything is stored. */
function emptyRecord() {
  return { revision: 0, token: '', login: '', scopes: [] }
}

/**
 * Read and write the stored personal access token.
 * @param {object} ctx - Cordis context providing `credentials`.
 * @returns {object} token store with `read`, `write`, `clear`, `describe`.
 */
export function createTokenStore(ctx) {
  /**
   * Read the stored token record.
   * @returns {Promise<{ revision: number, token: string, login: string, scopes: string[] }>} the payload, or the empty record.
   */
  async function read() {
    const record = await ctx.credentials.readRecord(TOKEN_RECORD)
    if (!record) return emptyRecord()
    if (record.kind !== 'grant' || typeof record.payload?.token !== 'string') return emptyRecord()
    return {
      revision: Number.isSafeInteger(record.payload.revision) ? record.payload.revision : 0,
      token: record.payload.token,
      login: typeof record.payload.login === 'string' ? record.payload.login : '',
      scopes: Array.isArray(record.payload.scopes) ? record.payload.scopes : [],
    }
  }

  /**
   * Store a token, preserving the rest of the record.
   * @param {object} input - values to store.
   * @param {string} input.token - the personal access token.
   * @param {string} [input.login] - the login the token authenticated as.
   * @param {string[]} [input.scopes] - scopes the token reported.
   * @returns {Promise<object>} the stored payload.
   */
  async function write(input) {
    let stored = emptyRecord()
    await ctx.credentials.modifyRecord(TOKEN_RECORD, (record) => {
      const before = record?.kind === 'grant' && record.payload && typeof record.payload.token === 'string'
        ? {
            revision: Number.isSafeInteger(record.payload.revision) ? record.payload.revision : 0,
            token: record.payload.token,
            login: typeof record.payload.login === 'string' ? record.payload.login : '',
            scopes: Array.isArray(record.payload.scopes) ? record.payload.scopes : [],
          }
        : emptyRecord()
      stored = {
        revision: before.revision + 1,
        token: input.token,
        login: input.login ?? before.login,
        scopes: input.scopes ?? before.scopes,
      }
      return { kind: 'grant', payload: stored }
    })
    return stored
  }

  /**
   * Delete the stored token by replacing the payload with an empty one.
   * @returns {Promise<void>} resolves once the record is blanked.
   */
  async function clear() {
    await ctx.credentials.modifyRecord(TOKEN_RECORD, () => ({ kind: 'grant', payload: emptyRecord() }))
  }

  /**
   * Describe the record for a configuration surface.
   * @returns {Promise<{ configured: boolean, writable: boolean, login: string }>} record facts.
   */
  async function describe() {
    let stored = emptyRecord()
    try {
      stored = await read()
    } catch {
      return { configured: false, writable: false, login: '' }
    }
    let writable = true
    try {
      writable = (await ctx.credentials.describeRecord(TOKEN_RECORD)).writable
    } catch {
      writable = false
    }
    return { configured: stored.token.length > 0, writable, login: stored.login }
  }

  return { read, write, clear, describe }
}

/**
 * Read the first non-empty environment token.
 * @returns {{ token: string, source: string }|undefined} the environment token, when present.
 */
export function environmentToken() {
  for (const name of TOKEN_ENV_VARS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return { token: value.trim(), source: name }
  }
  return undefined
}

/**
 * Resolve the token this plugin should authenticate with.
 * @param {object} store - token store from {@link createTokenStore}.
 * @returns {Promise<{ token: string, source: string }|undefined>} the resolved token, or `undefined` when unconfigured.
 */
export async function resolveToken(store) {
  const fromEnvironment = environmentToken()
  if (fromEnvironment) return fromEnvironment
  const stored = await store.read()
  if (stored.token.length > 0) return { token: stored.token, source: 'credentials' }
  return undefined
}

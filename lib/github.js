/**
 * GitHub REST calls.
 *
 * These talk to `api.github.com` over the process's global `fetch`. The harness
 * `connection` service is deliberately NOT used here: `ctx.connection.fetch` is
 * the Fetch *route registry* the plugin mounts its own `/api/...` handlers on,
 * not an outbound HTTP client, so calling it as one would fail.
 */
import { GitHubSyncError } from './errors.js'
import { redact } from './exec.js'

const API_ORIGIN = 'https://api.github.com'
const USER_AGENT = 'dsh-github-sync'
const API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Build the header set for one authenticated call.
 * @param {string} token - GitHub PAT.
 * @param {Record<string,string>} [extra] - additional or overriding headers.
 * @returns {Record<string,string>} request headers.
 */
function headersFor(token, extra) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': USER_AGENT,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

/**
 * Perform one GitHub API call and decode its JSON body.
 * @param {string} token - GitHub PAT.
 * @param {string} path - API path beginning with `/`.
 * @param {object} [init] - fetch options (`method`, `body`, `headers`).
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<{ status: number, body: any, headers: Headers }>} decoded response.
 * @throws {GitHubSyncError} on transport failure, or on any non-2xx status.
 */
async function call(token, path, init = {}, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers: headersFor(token, init.headers),
      signal: combined,
    })
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted()
    const reason = error?.name === 'TimeoutError' ? 'the request timed out' : (error?.message ?? 'unknown error')
    throw new GitHubSyncError(
      'NETWORK',
      `Could not reach api.github.com: ${reason}`,
      { nextStep: 'Check the network connection or proxy, then retry.' },
    )
  }

  const text = await response.text()
  let body
  let parsed = true
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = false
    body = undefined
  }

  if (!response.ok) {
    const detail = parsed && body && typeof body.message === 'string'
      ? body.message
      : redact(text).slice(0, 300)
    const scopeHint = response.headers.get('x-accepted-oauth-scopes')
    throw new GitHubSyncError(
      response.status === 401 ? 'AUTH_FAILED' : response.status === 403 ? 'FORBIDDEN' : 'API_ERROR',
      `GitHub rejected the request (HTTP ${response.status}): ${detail}`,
      {
        status: response.status,
        nextStep: response.status === 401
          ? 'Save a new personal access token with the "repo" scope.'
          : scopeHint
            ? `The token needs these scopes: ${scopeHint}.`
            : 'Check the repository name, the token scopes, and your permissions.',
      },
    )
  }

  return { status: response.status, body, headers: response.headers }
}

/**
 * Read the authenticated user behind a token.
 * @param {string} token - GitHub PAT.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<{ login: string, name: string, id: number }>} the viewer.
 */
export async function getViewer(token, signal) {
  const { body } = await call(token, '/user', {}, signal)
  return { login: body.login, name: body.name ?? '', id: body.id }
}

/**
 * Read the OAuth scopes a classic token carries.
 *
 * Fine-grained tokens report no `x-oauth-scopes` header, so an empty list means
 * "not a classic token", not "no permissions".
 * @param {string} token - GitHub PAT.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<{ scopes: string[], classic: boolean }>} scope facts.
 */
export async function getTokenScopes(token, signal) {
  const { headers } = await call(token, '/user', {}, signal)
  const raw = headers.get('x-oauth-scopes')
  if (raw === null) return { scopes: [], classic: false }
  return { scopes: raw.split(',').map((entry) => entry.trim()).filter(Boolean), classic: true }
}

/**
 * Look up one repository.
 * @param {string} token - GitHub PAT.
 * @param {string} owner - repository owner login.
 * @param {string} repo - repository name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<{ exists: boolean, repository?: object }>} lookup result.
 */
export async function findRepository(token, owner, repo, signal) {
  try {
    const { body } = await call(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {}, signal)
    return { exists: true, repository: body }
  } catch (error) {
    if (error instanceof GitHubSyncError && error.status === 404) return { exists: false }
    throw error
  }
}

/**
 * Create a repository for the authenticated user.
 * @param {string} token - GitHub PAT.
 * @param {object} spec - repository specification.
 * @param {string} spec.name - repository name.
 * @param {string} [spec.description] - optional description.
 * @param {'private'|'public'|'internal'} spec.visibility - repository visibility.
 * @param {boolean} spec.autoInit - whether GitHub should create an initial commit.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<object>} the created repository.
 * @throws {GitHubSyncError} when GitHub refuses creation.
 */
export async function createRepository(token, spec, signal) {
  const payload = {
    name: spec.name,
    /* `private` is the field a personal account honours; `visibility` is sent
       as well so an organization can be given `internal`. */
    private: spec.visibility !== 'public',
    auto_init: spec.autoInit === true,
  }
  if (spec.visibility === 'internal') payload.visibility = 'internal'
  if (spec.description) payload.description = spec.description
  const { body } = await call(token, '/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, signal)
  return body
}

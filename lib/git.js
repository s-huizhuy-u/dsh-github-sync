/**
 * Git operations for one workspace.
 *
 * Two rules shape this module:
 *
 * 1. **The token never lands on disk.** `origin` is always stored as the clean
 *    `https://github.com/<owner>/<repo>.git` URL, and the authenticated URL is
 *    passed as one command's argument instead. The token therefore never enters
 *    `.git/config`, and every message that could echo it is scrubbed by
 *    {@link redact}.
 * 2. **Git never prompts.** `GIT_TERMINAL_PROMPT=0` is set in {@link run}, so a
 *    credential failure surfaces as a git error instead of a hang.
 */
import { GitHubSyncError } from './errors.js'
import { redact, run } from './exec.js'

/** Git's own default timeout for local work. */
const LOCAL_TIMEOUT_MS = 60_000
/** Network-bound git operations (fetch, push) get a longer deadline. */
const NETWORK_TIMEOUT_MS = 180_000

/**
 * Run a git subcommand and fail loudly on a non-zero exit.
 * @param {string[]} args - git arguments.
 * @param {object} options - execution options.
 * @param {string} options.cwd - repository working directory.
 * @param {number} [options.timeoutMs] - deadline.
 * @param {AbortSignal} [options.signal] - cancels the call.
 * @param {string} [options.code] - error code for a non-zero exit.
 * @param {string} [options.nextStep] - guidance attached to that error.
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 * @throws {GitHubSyncError} when git is missing, times out, or exits non-zero.
 */
async function git(args, options) {
  const { cwd, timeoutMs = LOCAL_TIMEOUT_MS, signal, code = 'GIT_FAILED', nextStep } = options
  const result = await run('git', args, { cwd, timeoutMs, signal })

  if (result.missingCwd) {
    throw new GitHubSyncError(
      'NO_WORKSPACE',
      `The working directory no longer exists: ${cwd}`,
      { nextStep: 'Reopen the workspace folder, then retry.' },
    )
  }
  if (result.missing) {
    throw new GitHubSyncError(
      'GIT_MISSING',
      'The git executable was not found on PATH.',
      { nextStep: 'Install Git and restart DSH so the new PATH is picked up.' },
    )
  }
  if (result.timedOut) {
    throw new GitHubSyncError(
      'GIT_TIMEOUT',
      `git ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
      { nextStep: nextStep ?? 'Retry, or run the command manually in the workspace.' },
    )
  }
  if (!result.ok) {
    const detail = redact(result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n')
    throw new GitHubSyncError(code, `git ${args[0]} failed: ${detail || `exit ${result.code}`}`, { nextStep })
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run a git subcommand, reporting failure as a value instead of throwing.
 * @param {string[]} args - git arguments.
 * @param {object} options - execution options; see {@link git}.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>} result.
 */
async function gitTry(args, options) {
  try {
    const { stdout, stderr } = await git(args, options)
    return { ok: true, stdout, stderr }
  } catch (error) {
    const described = error instanceof GitHubSyncError ? error : undefined
    return { ok: false, stdout: '', stderr: described?.message ?? String(error) }
  }
}

/**
 * The clean, token-free clone URL for a repository.
 * @param {string} owner - repository owner login.
 * @param {string} repo - repository name.
 * @returns {string} HTTPS clone URL.
 */
export function buildRemoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * The one-shot clone URL that authenticates as the token's user.
 *
 * This value is passed straight to a single `git` invocation and is never
 * persisted or logged.
 * @param {string} owner - repository owner login.
 * @param {string} repo - repository name.
 * @param {string} token - GitHub PAT.
 * @returns {string} HTTPS URL carrying the token.
 */
export function buildAuthenticatedUrl(owner, repo, token) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
}

/**
 * Whether git is available and which version is installed.
 * @returns {Promise<string>} the reported version line, or `''` when missing.
 */
export async function gitVersion() {
  const result = await run('git', ['--version'], { timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * Whether a directory is already inside a git work tree.
 * @param {string} cwd - candidate directory.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<boolean>} true when git resolves a work tree.
 */
export async function isGitRepo(cwd, signal) {
  const result = await gitTry(['rev-parse', '--is-inside-work-tree'], { cwd, signal: signal, timeoutMs: 10_000 })
  return result.ok && result.stdout.trim() === 'true'
}

/**
 * Create a repository in the workspace.
 * @param {string} cwd - workspace root.
 * @param {string} branch - initial branch name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once the repository exists.
 */
export async function initRepo(cwd, branch, signal) {
  const withBranch = await gitTry(['init', '--initial-branch', branch], { cwd, signal })
  if (withBranch.ok) return
  /* `--initial-branch` needs git 2.28+. Older git gets a plain init plus an
     explicit HEAD rewrite, which produces the same branch name. */
  await git(['init'], { cwd, signal, code: 'GIT_INIT_FAILED' })
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd, signal, code: 'GIT_INIT_FAILED' })
}

/**
 * Set the repository-local commit identity.
 * @param {string} cwd - workspace root.
 * @param {string} name - commit author name.
 * @param {string} email - commit author email.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once both keys are written.
 */
export async function configureIdentity(cwd, name, email, signal) {
  await git(['config', '--local', 'user.name', name], { cwd, signal, code: 'GIT_CONFIG_FAILED' })
  await git(['config', '--local', 'user.email', email], { cwd, signal, code: 'GIT_CONFIG_FAILED' })
}

/**
 * The current HEAD commit, or `''` before the first commit exists.
 * @param {string} cwd - workspace root.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<string>} full commit SHA, or `''`.
 */
export async function headCommit(cwd, signal) {
  const result = await gitTry(['rev-parse', 'HEAD'], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * The current branch name, or `''` on an unborn or detached HEAD.
 * @param {string} cwd - workspace root.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<string>} branch name.
 */
export async function currentBranch(cwd, signal) {
  const result = await gitTry(['branch', '--show-current'], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * List working-tree changes in porcelain form.
 * @param {string} cwd - workspace root.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<string[]>} one entry per changed path.
 */
export async function statusEntries(cwd, signal) {
  const result = await gitTry(['status', '--porcelain', '--untracked-files=all'], { cwd, signal })
  if (!result.ok) return []
  return result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0)
}

/**
 * Stage every change in the work tree.
 * @param {string} cwd - workspace root.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once staging completes.
 */
export async function stageAll(cwd, signal) {
  await git(['add', '--all'], { cwd, signal, timeoutMs: LOCAL_TIMEOUT_MS, code: 'GIT_ADD_FAILED' })
}

/**
 * Commit the staged tree.
 *
 * An empty repository still needs one commit before it can be pushed, so the
 * first commit is allowed to be empty; later no-op commits are skipped by the
 * caller instead.
 * @param {string} cwd - workspace root.
 * @param {string} message - commit message.
 * @param {boolean} allowEmpty - whether to create a commit with no changes.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<string>} the new commit SHA.
 */
export async function commit(cwd, message, allowEmpty, signal) {
  const args = ['commit', '--message', message]
  if (allowEmpty) args.push('--allow-empty')
  await git(args, { cwd, signal, code: 'GIT_COMMIT_FAILED' })
  return await headCommit(cwd, signal)
}

/**
 * Point a named remote at a URL, creating it when absent.
 * @param {string} cwd - workspace root.
 * @param {string} remote - remote name.
 * @param {string} url - token-free remote URL.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once the remote is set.
 */
export async function setRemote(cwd, remote, url, signal) {
  const existing = await gitTry(['remote', 'get-url', remote], { cwd, signal, timeoutMs: 10_000 })
  if (existing.ok) {
    await git(['remote', 'set-url', remote, url], { cwd, signal, code: 'GIT_REMOTE_FAILED' })
    return
  }
  await git(['remote', 'add', remote, url], { cwd, signal, code: 'GIT_REMOTE_FAILED' })
}

/**
 * Read a named remote's URL.
 * @param {string} cwd - workspace root.
 * @param {string} remote - remote name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<string>} remote URL, or `''` when unset.
 */
export async function getRemote(cwd, remote, signal) {
  const result = await gitTry(['remote', 'get-url', remote], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * Whether a branch already exists on the remote.
 * @param {string} cwd - workspace root.
 * @param {string} url - authenticated remote URL.
 * @param {string} branch - branch name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<boolean>} true when the remote already has commits there.
 */
export async function remoteBranchExists(cwd, url, branch, signal) {
  const result = await gitTry(['ls-remote', '--heads', url, branch], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS,
  })
  return result.ok && result.stdout.trim().length > 0
}

/**
 * Fetch one remote branch into `FETCH_HEAD`.
 * @param {string} cwd - workspace root.
 * @param {string} url - authenticated remote URL.
 * @param {string} branch - branch name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once the fetch completes.
 */
export async function fetchBranch(cwd, url, branch, signal) {
  await git(['fetch', '--no-tags', url, branch], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS, code: 'GIT_FETCH_FAILED',
  })
}

/**
 * Rebase the current branch onto the just-fetched `FETCH_HEAD`.
 *
 * A conflict is reported as its own error code, and the interrupted rebase is
 * always rolled back so the work tree is left exactly as it was found.
 * @param {string} cwd - workspace root.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once the branch sits on top of the remote.
 * @throws {GitHubSyncError} with code `REBASE_CONFLICT` when the histories clash.
 */
export async function rebaseOntoFetchHead(cwd, signal) {
  const result = await gitTry(['rebase', '--autostash', 'FETCH_HEAD'], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (result.ok) return
  await gitTry(['rebase', '--abort'], { cwd, signal, timeoutMs: 30_000 })
  throw new GitHubSyncError(
    'REBASE_CONFLICT',
    'The remote branch and this workspace have conflicting histories, so the local commits could not be placed on top of the remote.',
    {
      nextStep: 'Resolve the conflict by hand in the workspace, or call github_sync again with force enabled to replace the remote history.',
    },
  )
}

/**
 * Push the current commit to a branch on the remote.
 * @param {string} cwd - workspace root.
 * @param {string} url - authenticated remote URL.
 * @param {string} branch - destination branch name.
 * @param {object} [options] - push options.
 * @param {boolean} [options.force] - whether to replace the remote branch.
 * @param {AbortSignal} [options.signal] - cancels the call.
 * @returns {Promise<void>} resolves once the push is accepted.
 */
export async function pushBranch(cwd, url, branch, options = {}) {
  const args = ['push']
  /* `--force-with-lease` needs a remote-tracking ref to compare against, and a
     URL-based push has none. An explicitly requested force is therefore a plain
     `--force`: the caller has opted into replacing the remote branch. */
  if (options.force) args.push('--force')
  args.push(url, `HEAD:refs/heads/${branch}`)
  await git(args, {
    cwd,
    signal: options.signal,
    timeoutMs: NETWORK_TIMEOUT_MS,
    code: 'GIT_PUSH_REJECTED',
    nextStep: 'The remote branch moved or the token lacks write access to this repository.',
  })
}

/**
 * Record the branch's upstream so later manual `git push`/`git pull` agree with
 * the remote this plugin configured. Credentials for those later commands come
 * from the user's own git setup.
 * @param {string} cwd - workspace root.
 * @param {string} branch - local branch name.
 * @param {string} remote - remote name.
 * @param {AbortSignal} [signal] - cancels the call.
 * @returns {Promise<void>} resolves once both keys are written.
 */
export async function setUpstream(cwd, branch, remote, signal) {
  await gitTry(['config', `branch.${branch}.remote`, remote], { cwd, signal, timeoutMs: 10_000 })
  await gitTry(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd, signal, timeoutMs: 10_000 })
}

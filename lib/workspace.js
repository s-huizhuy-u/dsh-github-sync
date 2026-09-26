/**
 * Workspace resolution and GitHub name derivation.
 *
 * The Session's workspace root is the only trustworthy source for "which
 * project is this": it is the path the user chose and the path the sandbox
 * policy was resolved against. `@deepseek-ai/dsh-util-workspace-path` exports
 * display helpers (`workspaceTitleOf`, `relativizeToCwd`) but no path resolver,
 * so the root itself comes from the execution context.
 */
import { lstat, realpath } from 'node:fs/promises'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { GitHubSyncError } from './errors.js'

/** Longest repository name GitHub accepts. */
const MAX_REPO_NAME = 100
/** The placeholder GitHub uses when a project directory name yields no usable characters. */
const FALLBACK_REPO_NAME = 'project'

/**
 * Resolve the real path of the workspace this tool call runs in.
 * @param {object} exec - tool execution context supplied by the harness.
 * @returns {Promise<string>} canonical absolute workspace root.
 * @throws {GitHubSyncError} when the session or its directory is unusable.
 */
export async function workspaceRootFor(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new GitHubSyncError(
      'NO_WORKSPACE',
      'This session has no workspace directory, so there is no project to sync.',
      { nextStep: 'Open the project folder in DSH and run the sync again.' },
    )
  }
  exec.signal?.throwIfAborted()
  let root
  try {
    root = await realpath(cwd)
  } catch (error) {
    throw new GitHubSyncError(
      'NO_WORKSPACE',
      `The workspace directory is not reachable: ${cwd}`,
      { nextStep: `Reopen ${cwd}, or pick another workspace.` },
    )
  }
  const info = await lstat(root)
  if (!info.isDirectory()) {
    throw new GitHubSyncError('NO_WORKSPACE', `The workspace path is not a directory: ${root}`)
  }
  return root
}

/**
 * Turn any project name into a valid GitHub repository name.
 *
 * GitHub accepts letters, digits, `.`, `-` and `_`. Everything else — spaces,
 * non-ASCII directory names, path separators — collapses to a single hyphen so
 * that a project directory can always name its own repository.
 * @param {unknown} name - candidate name, usually a directory basename.
 * @returns {string} a name GitHub accepts, never empty.
 */
export function slugifyRepoName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-._]{2,}/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, MAX_REPO_NAME)
    .replace(/^[-._]+|[-._]+$/gu, '')
  return slug.length > 0 ? slug : FALLBACK_REPO_NAME
}

/**
 * Derive the default repository name from the workspace directory name.
 * @param {string} root - canonical workspace root.
 * @returns {string} slugified directory name.
 */
export function defaultRepoNameFor(root) {
  return slugifyRepoName(workspaceTitleOf(root))
}

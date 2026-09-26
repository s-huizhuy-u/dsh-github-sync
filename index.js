/**
 * dsh-github-sync — publish a DSH workspace to a GitHub repository.
 *
 * The plugin contributes two model-facing tools and a small settings surface:
 *
 * - `github_sync` creates the repository when needed, initialises git in the
 *   workspace, commits the tree, and pushes it.
 * - `github_status` reports what a sync would do without changing anything.
 * - `/api/github-sync.*` exposes the same defaults and token store to a
 *   configuration surface.
 *
 * @module dsh-github-sync
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GitHubSyncError, describeError } from './lib/errors.js'
import { redact } from './lib/exec.js'
import { createRepository, findRepository, getTokenScopes, getViewer } from './lib/github.js'
import * as git from './lib/git.js'
import {
  Config,
  NAMESPACE,
  TOKEN_ENV_VARS,
  createTokenStore,
  resolveToken,
} from './lib/settings.js'
import { defaultRepoNameFor, slugifyRepoName, workspaceRootFor } from './lib/workspace.js'
import { readUpdateNotice } from './lib/update-notice.js'

/** Cordis plugin name, also the settings namespace and credential scope. */
export const name = 'dsh-github-sync'

/**
 * Services required before this plugin can be applied.
 *
 * `connection` is deliberately absent: the `/api` routes are mounted only when
 * that service is present, so a headless harness still loads the tools.
 */
export const inject = ['settings', 'credentials', 'tools']

export { Config }

/** How long one `github_sync` call may take, including a large first push. */
const SYNC_TIMEOUT_MS = 300_000
/** How long a read-only status call may take. */
const STATUS_TIMEOUT_MS = 30_000

/** The complete result shape both tools return, so the output schema stays strict. */
const EMPTY_RESULT = {
  ok: false,
  code: 'FAILED',
  summary: '',
  owner: '',
  repo: '',
  html_url: '',
  branch: '',
  commit: '',
  changed_files: 0,
  pushed: false,
  token_source: '',
  next_step: '',
}

/**
 * Fill in every field of the tool result.
 * @param {Partial<typeof EMPTY_RESULT>} partial - the fields this outcome knows.
 * @returns {typeof EMPTY_RESULT} a complete result object.
 */
function result(partial) {
  return { ...EMPTY_RESULT, ...partial }
}

/** JSON Schema for the shared result shape. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the operation succeeded.' },
    code: { type: 'string', required: true, description: 'Machine-readable outcome code.' },
    summary: { type: 'string', required: true, description: 'One sentence describing what happened.' },
    owner: { type: 'string', required: true, description: 'Repository owner login.' },
    repo: { type: 'string', required: true, description: 'Repository name.' },
    html_url: { type: 'string', required: true, description: 'Browser URL of the repository.' },
    branch: { type: 'string', required: true, description: 'Branch that was pushed.' },
    commit: { type: 'string', required: true, description: 'Commit SHA at HEAD.' },
    changed_files: { type: 'integer', required: true, description: 'Working-tree entries seen before committing.' },
    pushed: { type: 'boolean', required: true, description: 'Whether commits reached the remote.' },
    token_source: { type: 'string', required: true, description: 'Where the credential came from.' },
    next_step: { type: 'string', required: true, description: 'What the user should do next, when anything remains.' },
  },
}

/**
 * Describe a result as the single text block the model reads.
 * @param {typeof EMPTY_RESULT} value - the result.
 * @returns {Array<{ type: string, text: string }>} rendered content.
 */
function renderResult(value) {
  const lines = [value.summary]
  if (value.html_url) lines.push(`Repository: ${value.html_url}`)
  if (value.next_step) lines.push(`Next: ${value.next_step}`)
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/**
 * Build the commit message for this sync.
 * @param {object} args - tool arguments.
 * @param {object} config - resolved settings.
 * @param {boolean} hasHead - whether the repository already has a commit.
 * @returns {string} the message to use.
 */
function commitMessageFor(args, config, hasHead) {
  const explicit = args.commit_message ?? config.commitMessage
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  return hasHead ? 'chore: sync workspace' : 'Initial commit'
}

/**
 * Resolve the credential and the account it belongs to.
 * @param {object} ctx - Cordis context.
 * @param {AbortSignal} signal - cancels the calls.
 * @returns {Promise<{ token: string, source: string, viewer: object, scopes: string[] }>} credential facts.
 * @throws {GitHubSyncError} when no token is configured or it is rejected.
 */
async function authenticate(ctx, signal) {
  const store = createTokenStore(ctx)
  const resolved = await resolveToken(store)
  if (!resolved) {
    throw new GitHubSyncError(
      'NOT_CONFIGURED',
      `No GitHub token is configured. Set ${TOKEN_ENV_VARS.join(' or ')} in the environment, or store one with the github_configure tool.`,
      { nextStep: `Set ${TOKEN_ENV_VARS[0]} to a personal access token with the "repo" scope, then restart DSH.` },
    )
  }
  const viewer = await getViewer(resolved.token, signal)
  let scopes = []
  try {
    scopes = (await getTokenScopes(resolved.token, signal)).scopes
  } catch {
    /* Scope reporting is advisory: a fine-grained token has no scope header, and
       a failure here must not turn a working token into a failed sync. */
    scopes = []
  }
  return { token: resolved.token, source: resolved.source, viewer, scopes }
}

/**
 * Build the `github_sync` tool.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - reads the current resolved settings.
 * @returns {object} a registry-ready tool definition.
 */
function syncTool(ctx, readConfig) {
  return defineTool({
    name: 'github_sync',
    description: 'Publish the current workspace to GitHub. Creates the repository when it does not exist, initializes git, commits every change, and pushes to the default branch. Use github_status first to preview. The repository name and visibility default to the project folder name and a private repository.',
    parameters: {
      repo: { type: 'string', description: 'Repository name. Defaults to a slug of the workspace folder name.' },
      owner: { type: 'string', description: 'Account that owns the repository. Defaults to the configured owner, then to the token\'s own user.' },
      description: { type: 'string', description: 'Repository description, applied only when the repository is created.' },
      visibility: { type: 'string', enum: ['private', 'public', 'internal'], description: 'Visibility for a newly created repository. Defaults to the configured value, then private.' },
      auto_init: { type: 'boolean', description: 'Let GitHub create an initial commit. Defaults to false so the first push is accepted.' },
      commit_message: { type: 'string', description: 'Commit message for this sync.' },
      push: { type: 'boolean', description: 'Push after committing. Defaults to true; set false to commit locally only.' },
      force: { type: 'boolean', description: 'Replace the remote branch when the histories conflict. Destroys remote commits.' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: SYNC_TIMEOUT_MS,
    /* Concurrent git runs in one workspace collide on the index lock, so a sync
       must never be scheduled alongside another. */
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', kind: 'execute', title: 'Sync to GitHub', rawInput: args }),
    async execute(args, exec) {
      const signal = exec.signal
      let tokenSource = ''
      try {
        const root = await workspaceRootFor(exec)
        const config = readConfig()
        const { token, source, viewer } = await authenticate(ctx, signal)
        tokenSource = source

        const owner = (args.owner ?? config.owner ?? viewer.login).trim() || viewer.login
        const repo = slugifyRepoName(args.repo ?? defaultRepoNameFor(root))
        const visibility = args.visibility ?? config.visibility ?? 'private'
        const autoInit = args.auto_init ?? config.autoInit ?? false
        const shouldPush = args.push !== false

        ctx.logger.info('github-sync: syncing %s to %s/%s; token=%s visibility=%s', root, owner, repo, source, visibility)

        /* 1. The repository must exist before anything is pushed to it. */
        const found = await findRepository(token, owner, repo, signal)
        let repository = found.repository
        if (!found.exists) {
          repository = await createRepository(token, {
            name: repo,
            description: args.description,
            visibility,
            autoInit,
          }, signal)
          ctx.logger.info('github-sync: created repository %s', repository.html_url)
        } else {
          ctx.logger.info('github-sync: reusing repository %s', repository.html_url)
        }

        /* 2. Prepare the local repository. A fresh init owns the branch name;
           an existing repository keeps whatever branch it is already on. */
        const alreadyRepo = await git.isGitRepo(root, signal)
        const branch = alreadyRepo ? ((await git.currentBranch(root, signal)) || 'main') : 'main'
        if (!alreadyRepo) await git.initRepo(root, branch, signal)
        await git.configureIdentity(root, viewer.login, `${viewer.id}+${viewer.login}@users.noreply.github.com`, signal)

        /* 3. Commit whatever the workspace holds. */
        const entries = await git.statusEntries(root, signal)
        await git.stageAll(root, signal)
        const head = await git.headCommit(root, signal)
        let commit = head
        if (entries.length > 0 || head === '') {
          commit = await git.commit(root, commitMessageFor(args, config, head !== ''), head === '', signal)
          ctx.logger.info('github-sync: committed %s', commit)
        }

        /* 4. `origin` always carries the token-free URL; the credential travels
           as an argument to a single push instead of landing in .git/config. */
        await git.setRemote(root, 'origin', git.buildRemoteUrl(owner, repo), signal)

        let pushed = false
        if (shouldPush) {
          const authenticated = git.buildAuthenticatedUrl(owner, repo, token)
          /* An existing remote branch means the histories must be reconciled
             before the push, otherwise git rejects it as non-fast-forward. */
          if (await git.remoteBranchExists(root, authenticated, branch, signal)) {
            await git.fetchBranch(root, authenticated, branch, signal)
            await git.rebaseOntoFetchHead(root, signal)
          }
          await git.pushBranch(root, authenticated, branch, { force: args.force === true, signal })
          await git.setUpstream(root, branch, 'origin', signal)
          pushed = true
          ctx.logger.info('github-sync: pushed %s to %s', branch, repository.html_url)
        }

        const summary = pushed
          ? `Synced ${entries.length} changed file(s) to ${owner}/${repo} on branch ${branch}.`
          : `Committed ${entries.length} changed file(s) in ${owner}/${repo}; the push was skipped.`
        return result({
          ok: true,
          code: 'OK',
          summary,
          owner,
          repo,
          html_url: repository?.html_url ?? '',
          branch,
          commit,
          changed_files: entries.length,
          pushed,
          token_source: source,
        })
      } catch (error) {
        const described = describeError(error)
        ctx.logger.warn('github-sync: sync failed; code=%s message=%s', described.code, redact(described.message))
        return result({
          ok: false,
          code: described.code,
          summary: described.message,
          token_source: tokenSource,
          next_step: described.nextStep,
        })
      }
    },
  })
}

/**
 * Build the `github_status` tool.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - reads the current resolved settings.
 * @returns {object} a registry-ready tool definition.
 */
function statusTool(ctx, readConfig) {
  return defineTool({
    name: 'github_status',
    description: 'Report how a GitHub sync would behave for the current workspace: the resolved repository name, the git state, the configured remote, and whether a token is available. Changes nothing.',
    parameters: {},
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: STATUS_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'execute', title: 'Check GitHub sync' }),
    async execute(_args, exec) {
      const signal = exec.signal
      try {
        const root = await workspaceRootFor(exec)
        const config = readConfig()
        const store = createTokenStore(ctx)
        const resolved = await resolveToken(store)

        let login = ''
        let tokenSource = resolved?.source ?? ''
        if (resolved) {
          try {
            login = (await getViewer(resolved.token, signal)).login
          } catch (error) {
            login = ''
            tokenSource = `${resolved.source} (rejected)`
          }
        }

        const owner = (config.owner || login || '').trim()
        const repo = slugifyRepoName(defaultRepoNameFor(root))
        const alreadyRepo = await git.isGitRepo(root, signal)
        const branch = alreadyRepo ? ((await git.currentBranch(root, signal)) || 'main') : 'main'
        const entries = alreadyRepo ? await git.statusEntries(root, signal) : []
        const head = alreadyRepo ? await git.headCommit(root, signal) : ''
        const remote = await git.getRemote(root, 'origin', signal)
        const version = await gitVersionCached()
        /* A harness upgrade is the usual cause of a plugin that stopped loading,
           so a pending notice is reported alongside the sync state. */
        const notice = await readUpdateNotice()

        const parts = [
          `${root} -> ${owner ? `${owner}/` : ''}${repo}`,
          alreadyRepo ? `git repository on branch ${branch}` : 'not a git repository yet',
          `${entries.length} changed file(s)`,
          head ? `HEAD ${head.slice(0, 7)}` : 'no commits yet',
          remote ? `origin ${remote}` : 'no origin remote',
          resolved ? `token from ${resolved.source}${login ? ` as @${login}` : ''}` : 'no token configured',
          version ? `git ${version}` : 'git NOT FOUND',
        ]
        if (notice) parts.push(`harness core upgraded ${notice.from} -> ${notice.to}`)

        const nextSteps = []
        if (!resolved) nextSteps.push(`Set ${TOKEN_ENV_VARS[0]} before running github_sync.`)
        if (notice) nextSteps.push(`Ask me to check the installed plugins for compatibility with ${notice.to}.`)

        return result({
          ok: true,
          code: 'OK',
          summary: parts.join('; '),
          owner,
          repo,
          html_url: owner ? `https://github.com/${owner}/${repo}` : '',
          branch,
          commit: head,
          changed_files: entries.length,
          pushed: false,
          token_source: tokenSource,
          next_step: nextSteps.join(' '),
        })
      } catch (error) {
        const described = describeError(error)
        ctx.logger.warn('github-sync: status failed; code=%s message=%s', described.code, redact(described.message))
        return result({ ok: false, code: described.code, summary: described.message, next_step: described.nextStep })
      }
    },
  })
}

/**
 * Build the `github_configure` tool.
 * @param {object} ctx - Cordis context.
 * @returns {object} a registry-ready tool definition.
 */
function configureTool(ctx) {
  return defineTool({
    name: 'github_configure',
    description: 'Validate a GitHub personal access token and store it in the DSH credential store (file mode 0600), so github_sync can use it. Only call this when the user has supplied a token; never invent one. Prefer the GITHUB_TOKEN environment variable when the user would rather not paste a token.',
    parameters: {
      token: { type: 'string', description: 'GitHub personal access token with the "repo" scope.' },
      clear: { type: 'boolean', description: 'Forget the stored token instead of saving one.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          code: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          login: { type: 'string', required: true },
          scopes: { type: 'string', required: true },
          next_step: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: STATUS_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    presentCall: args => ({
      card: 'generic',
      kind: 'execute',
      title: 'Configure GitHub token',
      /* The token itself must never enter the trajectory. */
      rawInput: { token: args.token ? '[REDACTED]' : undefined, clear: args.clear },
    }),
    async execute(args, exec) {
      const signal = exec.signal
      try {
        const store = createTokenStore(ctx)
        if (args.clear === true) {
          await store.clear()
          return {
            ok: true, code: 'OK', summary: 'The stored GitHub token was removed.', login: '', scopes: '', next_step: '',
          }
        }
        const token = typeof args.token === 'string' ? args.token.trim() : ''
        if (token.length === 0) {
          throw new GitHubSyncError('TOKEN_REQUIRED', 'No token was provided.', {
            nextStep: `Pass a token, or set ${TOKEN_ENV_VARS[0]} in the environment.`,
          })
        }
        if (/\s/u.test(token)) {
          throw new GitHubSyncError('TOKEN_INVALID', 'The token contains whitespace, so it was copied incorrectly.', {
            nextStep: 'Copy the token again without surrounding spaces or line breaks.',
          })
        }
        const viewer = await getViewer(token, signal)
        let scopes = []
        let classic = false
        try {
          const reported = await getTokenScopes(token, signal)
          scopes = reported.scopes
          classic = reported.classic
        } catch {
          scopes = []
        }
        if (classic && scopes.length > 0 && !scopes.includes('repo')) {
          throw new GitHubSyncError(
            'TOKEN_SCOPE',
            `The token authenticates as @${viewer.login} but only carries: ${scopes.join(', ')}. Creating and pushing repositories needs the "repo" scope.`,
            { nextStep: 'Issue a new classic token with the "repo" scope, or a fine-grained token with repository contents and administration write access.' },
          )
        }
        await store.write({ token, login: viewer.login, scopes })
        ctx.logger.info('github-sync: stored token for @%s; scopes=%s', viewer.login, scopes.join(',') || 'unreported')
        return {
          ok: true,
          code: 'OK',
          summary: `Stored a GitHub token for @${viewer.login}.`,
          login: viewer.login,
          scopes: scopes.join(', '),
          next_step: '',
        }
      } catch (error) {
        const described = describeError(error)
        ctx.logger.warn('github-sync: configure failed; code=%s message=%s', described.code, redact(described.message))
        return {
          ok: false, code: described.code, summary: described.message, login: '', scopes: '', next_step: described.nextStep,
        }
      }
    },
  })
}

/** Memoized `git --version`, since it cannot change while the plugin is loaded. */
let gitVersionPromise
/**
 * Read the git version once per process.
 * @returns {Promise<string>} the version line, or `''` when git is missing.
 */
function gitVersionCached() {
  gitVersionPromise ??= git.gitVersion()
  return gitVersionPromise
}

/**
 * Register the plugin's tools and, when the connection service exists, its
 * configuration routes.
 * @param {object} ctx - Cordis context.
 * @returns {Promise<void>} resolves once registration is complete.
 */
export async function apply(ctx) {
  /* One registration, one owner scope. Registering the namespace twice — once
     here and once inside a helper — is a hard failure in the settings service. */
  const scope = ctx.settings.register(NAMESPACE, Config, { applies: 'live' })
  const readConfig = () => scope.get() ?? {}

  ctx.tools.register(syncTool(ctx, readConfig))
  ctx.tools.register(statusTool(ctx, readConfig))
  ctx.tools.register(configureTool(ctx))

  /* The web surface is optional: a headless harness has no `connection`, and
     the tools above must still work there. */
  ctx.inject(['connection'], (connectionCtx) => {
    const json = async (produce) => {
      try {
        return Response.json(await produce(), { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        const described = describeError(error)
        return Response.json(
          { code: described.code, error: described.message, nextStep: described.nextStep },
          { status: 400, headers: { 'cache-control': 'no-store' } },
        )
      }
    }

    const route = (path, methods, handler) => {
      connectionCtx.effect(
        () => connectionCtx.connection.fetch.register({
          path,
          methods,
          requestBody: 'buffered',
          fetch: handler,
        }),
        `github-sync: ${path}`,
      )
    }

    const body = async (request) => {
      const text = await request.text()
      if (text.trim().length === 0) return {}
      try {
        return JSON.parse(text)
      } catch {
        throw new GitHubSyncError('BAD_REQUEST', 'The request body was not valid JSON.')
      }
    }

    route('/api/github-sync.settings', ['GET'], () => json(async () => {
      const store = createTokenStore(ctx)
      return {
        defaults: readConfig(),
        token: await store.describe(),
        environment: TOKEN_ENV_VARS.filter((entry) => (process.env[entry] ?? '').trim().length > 0),
        git: await gitVersionCached(),
      }
    }))

    route('/api/github-sync.token', ['POST'], (request) => json(async () => {
      const input = await body(request)
      const store = createTokenStore(ctx)
      if (input.clear === true) {
        await store.clear()
        return { cleared: true }
      }
      const token = typeof input.token === 'string' ? input.token.trim() : ''
      if (token.length === 0) throw new GitHubSyncError('TOKEN_REQUIRED', 'No token was provided.')
      const viewer = await getViewer(token)
      await store.write({ token, login: viewer.login })
      return { configured: true, login: viewer.login }
    }))

    route('/api/github-sync.verify', ['POST'], (request) => json(async () => {
      const input = await body(request)
      const token = typeof input.token === 'string' && input.token.trim().length > 0
        ? input.token.trim()
        : (await resolveToken(createTokenStore(ctx)))?.token
      if (!token) throw new GitHubSyncError('NOT_CONFIGURED', 'No token is available to verify.')
      const viewer = await getViewer(token)
      const reported = await getTokenScopes(token)
      return { login: viewer.login, scopes: reported.scopes, classic: reported.classic }
    }))
  })
}

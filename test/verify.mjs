/**
 * Offline verification for dsh-github-sync.
 *
 * Everything here runs without GitHub: the REST layer is served by a stub
 * `fetch`, and the git layer talks to a real bare repository on local disk. That
 * combination exercises the ordering that actually breaks in production — create
 * then init then commit then push — while staying hermetic.
 *
 * Run from an installed copy so `@deepseek-ai/*` resolves:
 *   node node_modules/dsh-github-sync/test/verify.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply, name } from '../index.js'
import { Config } from '../lib/settings.js'
import { redact, run } from '../lib/exec.js'
import * as git from '../lib/git.js'
import { readUpdateNotice } from '../lib/update-notice.js'
import { defaultRepoNameFor, slugifyRepoName } from '../lib/workspace.js'
import { describeError, GitHubSyncError } from '../lib/errors.js'

let passed = 0
let failed = 0
/**
 * Run one named check, reporting a failure without aborting the suite.
 * @param {string} label - what is being checked.
 * @param {() => any} body - the check.
 */
async function test(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

/** A scratch directory removed at the end of the run. */
const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-github-sync-'))
const cleanups = [scratch]

console.log(`\ndsh-github-sync verify  (plugin name: ${name})\n`)

// ---------------------------------------------------------------- unit checks
console.log('units')

await test('slugifyRepoName produces names GitHub accepts', () => {
  assert.equal(slugifyRepoName('My Project'), 'my-project')
  assert.equal(slugifyRepoName('DSH插件'), 'dsh')
  assert.equal(slugifyRepoName('  ..weird//name..  '), 'weird-name')
  assert.equal(slugifyRepoName(''), 'project')
  assert.equal(slugifyRepoName('a'.repeat(200)).length, 100)
  assert.match(slugifyRepoName('Fancy_Name.v2'), /^[a-z0-9._-]+$/)
})

await test('defaultRepoNameFor reads the last path segment', () => {
  assert.equal(defaultRepoNameFor(path.join('C:', 'work', 'My Project')), 'my-project')
})

await test('redact masks every token shape it may echo', () => {
  assert.equal(
    redact('fatal: could not read from https://x-access-token:ghp_abcdefghijklmnopqrst@github.com/o/r.git'),
    'fatal: could not read from https://x-access-token:[REDACTED]@github.com/o/r.git',
  )
  assert.equal(redact('token github_pat_11ABCDEFG0abcdefghijkl_rest'), 'token [REDACTED]')
  assert.ok(!redact('ghp_abcdefghijklmnopqrst').includes('ghp_'))
})

await test('the settings schema resolves every default', () => {
  const resolved = Schema.resolve({}, Config)[0]
  assert.equal(resolved.owner, '')
  assert.equal(resolved.visibility, 'private')
  assert.equal(resolved.autoInit, false)
  assert.equal(resolved.commitMessage, '')
})

await test('the settings schema rejects an unknown visibility', () => {
  assert.throws(() => Schema.resolve({ visibility: 'secret' }, Config))
})

await test('describeError normalizes both error kinds', () => {
  const known = describeError(new GitHubSyncError('NOT_CONFIGURED', 'nope', { nextStep: 'do it' }))
  assert.deepEqual(known, { code: 'NOT_CONFIGURED', message: 'nope', nextStep: 'do it' })
  assert.equal(describeError(new Error('boom')).code, 'FAILED')
})

// ------------------------------------------------------- git integration checks
console.log('\ngit (local bare remote)')

const workspace = path.join(scratch, 'project')
const bare = path.join(scratch, 'remote.git')
await mkdir(workspace, { recursive: true })
await mkdir(bare, { recursive: true })
await writeFile(path.join(workspace, 'README.md'), '# project\n')

await test('a bare repository serves as the offline remote', async () => {
  /* The plugin always initialises a working repository, so the stand-in remote
     is created directly: pushing into a non-bare checkout is refused by git. */
  const created = await run('git', ['init', '--bare', '--initial-branch=main', bare], { timeoutMs: 30_000 })
  assert.equal(created.ok, true, created.stderr)
  const bareConfig = await readFile(path.join(bare, 'config'), 'utf8')
  assert.match(bareConfig, /bare = true/)
})

await test('isGitRepo distinguishes a plain directory from a repository', async () => {
  assert.equal(await git.isGitRepo(workspace), false)
  await git.initRepo(workspace, 'main')
  assert.equal(await git.isGitRepo(workspace), true)
})

await test('a fresh init lands on the requested branch with no commits', async () => {
  assert.equal(await git.currentBranch(workspace), 'main')
  assert.equal(await git.headCommit(workspace), '')
})

await test('identity, staging, and a first commit produce a SHA', async () => {
  await git.configureIdentity(workspace, 'octocat', '583231+octocat@users.noreply.github.com')
  assert.deepEqual(await git.statusEntries(workspace), ['?? README.md'])
  await git.stageAll(workspace)
  const sha = await git.commit(workspace, 'Initial commit', true)
  assert.match(sha, /^[0-9a-f]{40}$/)
})

await test('an empty commit is allowed only when asked for', async () => {
  await assert.rejects(() => git.commit(workspace, 'nothing here', false))
})

await test('the clean remote URL is what gets persisted', async () => {
  const url = git.buildRemoteUrl('octocat', 'project')
  assert.equal(url, 'https://github.com/octocat/project.git')
  await git.setRemote(workspace, 'origin', url)
  assert.equal(await git.getRemote(workspace, 'origin'), url)
  const config = await readFile(path.join(workspace, '.git', 'config'), 'utf8')
  assert.ok(!config.includes('x-access-token'), 'the token must never reach .git/config')
})

await test('the authenticated URL carries the token and nothing else changes', () => {
  const url = git.buildAuthenticatedUrl('octocat', 'project', 'ghp_example')
  assert.match(url, /^https:\/\/x-access-token:ghp_example@github\.com\/octocat\/project\.git$/)
})

await test('push reaches the remote and the remote reports the branch', async () => {
  await git.pushBranch(workspace, bare, 'main', {})
  assert.equal(await git.remoteBranchExists(workspace, bare, 'main'), true)
})

await test('the newly pushed commit is visible on the remote', async () => {
  const head = await git.headCommit(workspace)
  const bareHead = await git.headCommit(bare, undefined)
  assert.equal(bareHead, head, 'the bare remote must hold exactly the pushed commit')
})

await test('a diverged remote forces a rebase before the next push', async () => {
  /* Simulate the auto_init case: the remote gains a commit the workspace lacks,
     which is exactly what makes a naive push non-fast-forward. */
  const other = path.join(scratch, 'other')
  await mkdir(other, { recursive: true })
  await git.initRepo(other, 'main')
  await git.configureIdentity(other, 'other', 'other@example.com')
  await writeFile(path.join(other, 'OTHER.md'), 'other\n')
  await git.stageAll(other)
  await git.commit(other, 'remote-side commit', true)
  await git.setRemote(other, 'origin', bare)
  await git.pushBranch(other, bare, 'main', { force: true })

  await writeFile(path.join(workspace, 'LOCAL.md'), 'local\n')
  await git.stageAll(workspace)
  await git.commit(workspace, 'local-side commit', true)

  await git.fetchBranch(workspace, bare, 'main')
  await git.rebaseOntoFetchHead(workspace)
  await git.pushBranch(workspace, bare, 'main', {})

  assert.equal(await git.remoteBranchExists(workspace, bare, 'main'), true)
  const listing = await git.statusEntries(bare)
  assert.equal(listing.length, 0)
})

await test('setUpstream records the branch tracking configuration', async () => {
  await git.setUpstream(workspace, 'main', 'origin')
  const config = await readFile(path.join(workspace, '.git', 'config'), 'utf8')
  assert.match(config, /\[branch "main"\]/)
})

await test('gitVersion reports an installed git', async () => {
  const version = await git.gitVersion()
  assert.match(version, /^git version \d+\./)
})

// ------------------------------------------------- tool end-to-end, stubbed API
console.log('\ntools (stubbed GitHub API)')

/**
 * Build a context that satisfies the plugin's service contract.
 * @returns {{ ctx: object, tools: Map<string, object>, settings: object }} the fake context.
 */
function fakeContext() {
  const registered = new Map()
  const scopes = new Map()
  let stored = { revision: 0, token: '', login: '', scopes: [] }
  const state = { defaults: { owner: '', visibility: 'private', autoInit: false, commitMessage: '' } }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    settings: {
      register(ns, schema, options) {
        if (scopes.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
        const scope = {
          get: () => Schema.resolve(state.defaults, schema)[0],
          update: async (patch) => { Object.assign(state.defaults, patch) },
          replace: async (next) => { state.defaults = next },
          watch: () => () => {},
        }
        scopes.set(ns, { schema, options, scope })
        return scope
      },
    },
    credentials: {
      readRecord: async () => (stored.token ? { kind: 'grant', payload: stored } : undefined),
      describeRecord: async () => ({ configured: stored.token.length > 0, writable: true }),
      modifyRecord: async (_key, mutate) => {
        const next = await mutate(stored.token ? { kind: 'grant', payload: stored } : undefined)
        if (next) stored = next.payload
        return next
      },
    },
    tools: { register: (definition) => registered.set(definition.name, definition) },
    /* Routes are skipped: this suite exercises the tools, not the web surface. */
    inject: () => {},
    effect: () => {},
  }
  return { ctx, tools: registered, settings: state }
}

/**
 * Install a stub GitHub API on `globalThis.fetch`.
 * @returns {{ calls: Array<{ method: string, path: string }>, restore: () => void }} stub handle.
 */
function stubGitHubApi() {
  const calls = []
  const original = globalThis.fetch
  const viewer = { login: 'octocat', id: 583231, name: 'The Octocat' }
  let created = false
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url))
    const method = init.method ?? 'GET'
    calls.push({ method, path: parsed.pathname })
    const json = (body, status = 200, headers = {}) => new Response(
      JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json', ...headers } },
    )
    if (parsed.pathname === '/user') {
      return json(viewer, 200, { 'x-oauth-scopes': 'repo, read:user' })
    }
    if (parsed.pathname === '/user/repos' && method === 'POST') {
      created = true
      const payload = JSON.parse(init.body)
      assert.equal(payload.private, true, 'the default visibility must be private')
      assert.equal(payload.auto_init, false, 'auto_init must default to false')
      return json({
        name: payload.name,
        html_url: `https://github.com/octocat/${payload.name}`,
        git_url: `git://github.com/octocat/${payload.name}.git`,
        private: payload.private,
      }, 201)
    }
    if (parsed.pathname.startsWith('/repos/')) {
      if (!created) return json({ message: 'Not Found' }, 404)
      const repoName = parsed.pathname.split('/').pop()
      return json({ name: repoName, html_url: `https://github.com/octocat/${repoName}` })
    }
    return json({ message: `unexpected ${method} ${parsed.pathname}` }, 500)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * Apply the plugin to a fresh context and store a usable token in it.
 *
 * Each test owns its context, so the token has to be established per test
 * rather than inherited from a previous one.
 * @returns {Promise<{ ctx: object, tools: Map<string, object>, settings: object }>} a ready context.
 */
async function readyContext() {
  const built = fakeContext()
  await apply(built.ctx)
  const saved = await built.tools.get('github_configure').execute({ token: 'ghp_example' }, {})
  assert.equal(saved.ok, true, `token setup failed: ${saved.summary}`)
  return built
}

await test('apply() registers one namespace and three tools', async () => {
  const { ctx, tools } = fakeContext()
  const { ctx: second, tools: secondTools } = fakeContext()
  await apply(ctx)
  assert.deepEqual([...tools.keys()].sort(), ['github_configure', 'github_status', 'github_sync'])
  for (const definition of tools.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.output.schema.type, 'object')
  }
  /* A second context must register cleanly: the previous version of this plugin
     registered the namespace twice in one context and threw on load. */
  await apply(second)
  assert.equal(secondTools.size, 3)
})

await test('github_sync reports NOT_CONFIGURED without touching the network', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const stub = stubGitHubApi()
  try {
    const out = await tools.get('github_sync').execute(
      { repo: 'no-token-here' },
      { agent: { session: { header: { cwd: workspace } } } },
    )
    assert.equal(out.ok, false)
    assert.equal(out.code, 'NOT_CONFIGURED')
    assert.equal(stub.calls.length, 0)
    assert.match(out.next_step, /GITHUB_TOKEN/)
  } finally {
    stub.restore()
  }
})

await test('github_configure rejects a token without the repo scope', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'octocat', id: 1 }), {
    status: 200, headers: { 'content-type': 'application/json', 'x-oauth-scopes': 'read:user' },
  })
  try {
    const out = await tools.get('github_configure').execute({ token: 'ghp_example' }, {})
    assert.equal(out.ok, false)
    assert.equal(out.code, 'TOKEN_SCOPE')
  } finally {
    globalThis.fetch = original
  }
})

await test('github_configure stores a valid token and then reports it', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const stub = stubGitHubApi()
  try {
    const saved = await tools.get('github_configure').execute({ token: 'ghp_example' }, {})
    assert.equal(saved.ok, true)
    assert.equal(saved.login, 'octocat')
    const status = await tools.get('github_status').execute(
      {},
      { agent: { session: { header: { cwd: workspace } } } },
    )
    assert.equal(status.ok, true)
    assert.match(status.token_source, /credentials/)
    assert.equal(status.owner, 'octocat')
  } finally {
    stub.restore()
  }
})

await test('github_configure never echoes the token in its presentation', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const stub = stubGitHubApi()
  try {
    const presented = tools.get('github_configure').presentCall({ token: 'ghp_supersecret' })
    assert.equal(presented.rawInput.token, '[REDACTED]')
  } finally {
    stub.restore()
  }
})

await test('github_sync creates the repository, commits, and reports the outcome', async () => {
  const stub = stubGitHubApi()
  const { tools } = await readyContext()
  const target = path.join(scratch, 'fresh')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'app.js'), 'console.log(1)\n')
  try {
    const out = await tools.get('github_sync').execute(
      { repo: 'My Fresh Project', push: false, commit_message: 'feat: first' },
      { agent: { session: { header: { cwd: target } } } },
    )
    assert.equal(out.ok, true, out.summary)
    assert.equal(out.owner, 'octocat')
    /* The name must be slugified before it reaches the API and git. */
    assert.equal(out.repo, 'my-fresh-project')
    assert.equal(out.branch, 'main')
    assert.match(out.commit, /^[0-9a-f]{40}$/)
    assert.equal(out.pushed, false)
    assert.equal(out.changed_files, 1)
    assert.ok(existsSync(path.join(target, '.git')), 'git must be initialized')
    assert.equal(await git.isGitRepo(target), true)
    assert.ok(
      stub.calls.some((entry) => entry.method === 'POST' && entry.path === '/user/repos'),
      'the repository must be created',
    )
    const config = await readFile(path.join(target, '.git', 'config'), 'utf8')
    assert.ok(!config.includes('ghp_'), 'no token may be persisted')
    assert.match(await git.headCommit(target), /^[0-9a-f]{40}$/)
  } finally {
    stub.restore()
  }
})

await test('github_sync reuses an existing repository instead of recreating it', async () => {
  const stub = stubGitHubApi()
  const { tools } = await readyContext()
  const target = path.join(scratch, 'reuse')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'a.txt'), 'a\n')
  try {
    const first = await tools.get('github_sync').execute(
      { repo: 'reused', push: false },
      { agent: { session: { header: { cwd: target } } } },
    )
    assert.equal(first.ok, true, first.summary)
    const creates = () => stub.calls.filter((entry) => entry.method === 'POST' && entry.path === '/user/repos').length
    assert.equal(creates(), 1)
    const second = await tools.get('github_sync').execute(
      { repo: 'reused', push: false },
      { agent: { session: { header: { cwd: target } } } },
    )
    assert.equal(second.ok, true, second.summary)
    assert.equal(creates(), 1, 'the second run must not create another repository')
  } finally {
    stub.restore()
  }
})

await test('a second sync with no changes reuses HEAD instead of failing', async () => {
  const stub = stubGitHubApi()
  const { tools } = await readyContext()
  const target = path.join(scratch, 'stable')
  await mkdir(target, { recursive: true })
  await writeFile(path.join(target, 'a.txt'), 'a\n')
  try {
    const exec = { agent: { session: { header: { cwd: target } } } }
    const first = await tools.get('github_sync').execute({ repo: 'stable', push: false }, exec)
    assert.equal(first.ok, true, first.summary)
    const second = await tools.get('github_sync').execute({ repo: 'stable', push: false }, exec)
    assert.equal(second.ok, true, second.summary)
    assert.equal(second.commit, first.commit, 'an unchanged tree keeps the same commit')
    assert.equal(second.changed_files, 0)
  } finally {
    stub.restore()
  }
})

await test('a missing workspace is reported, not thrown', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const out = await tools.get('github_sync').execute({}, { agent: { session: { header: {} } } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_WORKSPACE')
})

await test('the git-missing path produces an actionable code', async () => {
  const { ctx, tools } = fakeContext()
  await apply(ctx)
  const stub = stubGitHubApi()
  try {
    const saved = await tools.get('github_configure').execute({ token: 'ghp_example' }, {})
    assert.equal(saved.ok, true)
    const target = path.join(scratch, 'broken')
    await mkdir(target, { recursive: true })
    /* Point PATH at an empty directory so `git` cannot resolve. */
    const emptyBin = path.join(scratch, 'empty-bin')
    await mkdir(emptyBin, { recursive: true })
    const savedPath = process.env.PATH
    const savedPathExt = process.env.PATHEXT
    process.env.PATH = emptyBin
    process.env.PATHEXT = ''
    try {
      const out = await tools.get('github_sync').execute(
        { repo: 'broken', push: false },
        { agent: { session: { header: { cwd: target } } } },
      )
      assert.equal(out.ok, false)
      assert.equal(out.code, 'GIT_MISSING')
      assert.match(out.next_step, /Install Git/)
    } finally {
      process.env.PATH = savedPath
      /* Assigning `undefined` would store the literal string "undefined". */
      if (savedPathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = savedPathExt
    }
  } finally {
    stub.restore()
  }
})

await test('every tool result satisfies its own declared output schema', async () => {
  const stub = stubGitHubApi()
  const { tools } = await readyContext()
  const exec = { agent: { session: { header: { cwd: workspace } } } }
  try {
    const cases = [
      ['github_status', await tools.get('github_status').execute({}, exec)],
      ['github_sync', await tools.get('github_sync').execute({ repo: 'schema-check', push: false }, exec)],
      ['github_configure', await tools.get('github_configure').execute({ token: 'ghp_example' }, {})],
    ]
    for (const [toolName, value] of cases) {
      const declared = Object.keys(tools.get(toolName).output.schema.properties)
      for (const key of declared) {
        assert.ok(key in value, `${toolName} result is missing declared field "${key}"`)
      }
      for (const key of Object.keys(value)) {
        assert.ok(declared.includes(key), `${toolName} result has undeclared field "${key}"`)
      }
    }
  } finally {
    stub.restore()
  }
})

await test('no upgrade notice is reported when none is pending', async () => {
  const home = path.join(scratch, 'home-clean')
  await mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(path.join(home, 'profiles', 'web', 'package.json'), '{}\n')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(await readUpdateNotice(), undefined)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

await test('a pending harness upgrade reaches github_status', async () => {
  const home = path.join(scratch, 'home-upgraded')
  await mkdir(path.join(home, 'profiles', 'web'), { recursive: true })
  await writeFile(path.join(home, 'profiles', 'web', 'package.json'), '{}\n')
  await writeFile(
    path.join(home, 'dsh-github-sync-update-notice.json'),
    JSON.stringify({ from: '0.1.5-rc.1', to: '0.1.5-rc.9', request: 'check plugins' }),
  )
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const stub = stubGitHubApi()
  try {
    const notice = await readUpdateNotice()
    assert.equal(notice.to, '0.1.5-rc.9')
    const { tools } = await readyContext()
    const out = await tools.get('github_status').execute({}, { agent: { session: { header: { cwd: workspace } } } })
    assert.match(out.summary, /harness core upgraded 0\.1\.5-rc\.1 -> 0\.1\.5-rc\.9/)
    assert.match(out.next_step, /compatibility with 0\.1\.5-rc\.9/)
  } finally {
    stub.restore()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

for (const directory of cleanups) await rm(directory, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed === 0 ? 0 : 1

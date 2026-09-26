/**
 * Child-process execution for git, plus the redaction every log line needs.
 *
 * Git is a short-lived CLI, so `execFile` with a collected buffer is the right
 * primitive: it gives whole-output semantics with no stream bookkeeping. The
 * harness `subprocess` service deliberately exposes only `spawn`/`spawnTerminal`
 * (no `exec`), and its handles are read through offset-based readers that this
 * plugin has no use for.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Upper bound on one command's collected stdout+stderr, in bytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024

const TOKEN_IN_URL = /(x-access-token|oauth2|git):[^@\s/]+@/gi
const CLASSIC_PAT = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g
const FINE_GRAINED_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g

/**
 * Remove credential material from text that may reach a log or the transcript.
 *
 * Everything the plugin echoes — commands, git stderr, API bodies — passes
 * through here first, because git helpfully quotes the remote URL back at us in
 * its failure messages.
 * @param {unknown} value - text to scrub.
 * @returns {string} the same text with every known token shape masked.
 */
export function redact(value) {
  return String(value ?? '')
    .replace(TOKEN_IN_URL, '$1:[REDACTED]@')
    .replace(CLASSIC_PAT, '[REDACTED]')
    .replace(FINE_GRAINED_PAT, '[REDACTED]')
}

/**
 * Run one executable and collect its output.
 *
 * Git is forced non-interactive: without `GIT_TERMINAL_PROMPT=0` a failed
 * authentication makes git open a prompt on a console that does not exist, and
 * the call hangs until the timeout instead of reporting the failure.
 * @param {string} file - executable name or path.
 * @param {string[]} args - argument vector; never a shell string.
 * @param {object} [options] - execution options.
 * @param {string} [options.cwd] - working directory.
 * @param {Record<string, string>} [options.env] - extra environment entries.
 * @param {number} [options.timeoutMs] - deadline for the whole call.
 * @param {AbortSignal} [options.signal] - cancels the call.
 * @returns {Promise<{ ok: boolean, code: number|string, stdout: string, stderr: string, timedOut: boolean, missing: boolean, missingCwd: boolean }>} collected result.
 */
export function run(file, args, options = {}) {
  const { cwd, env, timeoutMs = 120_000, signal } = options
  /* A child cannot start in a directory that does not exist, and the OS reports
     that as the same ENOENT it uses for a missing executable. Resolving it here
     keeps "git is not installed" and "the workspace is gone" from being
     reported as each other. */
  if (typeof cwd === 'string' && !existsSync(cwd)) {
    return Promise.resolve({
      ok: false, code: 'ENOENT', stdout: '', stderr: '', timedOut: false, missing: false, missingCwd: true,
    })
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        ...(signal ? { signal } : {}),
        env: {
          ...process.env,
          ...env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          GCM_INTERACTIVE: 'never',
          GIT_CONFIG_NOSYSTEM: '0',
        },
      },
      (error, stdout, stderr) => {
        const out = stdout === undefined ? '' : String(stdout)
        const err = stderr === undefined ? '' : String(stderr)
        /* A missing executable and a non-zero exit are different problems: the
           first is an environment gap, the second is git refusing the request. */
        const missing = error?.code === 'ENOENT'
        resolve({
          ok: !error,
          code: missing ? 'ENOENT' : (error?.code ?? 0),
          stdout: out,
          stderr: err,
          timedOut: error?.killed === true || error?.signal === 'SIGTERM',
          missing,
          missingCwd: false,
        })
      },
    )
  })
}

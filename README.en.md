# dsh-github-sync

[English](README.en.md) | [简体中文](README.md)

Publish a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) workspace to GitHub from the conversation.

Ask the assistant to sync a project and it creates the repository, initializes git in the workspace, commits the tree, and pushes it. The repository name defaults to the project folder, the visibility defaults to private, and both can be overridden per call or in settings.

```
You:  put this project on GitHub

DSH:  Synced 12 changed file(s) to octocat/my-project on branch main.
      Repository: https://github.com/octocat/my-project
```

## What it does

| Capability | Detail |
|---|---|
| **Create the repository** | Creates it on GitHub when it does not exist, and reuses it when it does |
| **Initialize git** | `git init` on the branch the project is already on, or `main` for a new repository |
| **Commit** | Stages the whole tree and commits; an unchanged tree reuses the existing `HEAD` instead of failing |
| **Push** | Non-fast-forward histories are reconciled with a fetch + rebase before the push |
| **Self-configure** | Declares the account's commit identity and records the branch upstream |
| **Report** | `github_status` previews exactly what a sync would do, without changing anything |

## Requirements

- DeepSeek Harness `0.1.5-rc.2` or newer
- Node.js 20.12+ (for `AbortSignal.any`)
- Git on `PATH`

## Install

Copy the package into a DSH profile and declare it:

```bash
node scripts/install.mjs
```

The script finds the DSH home (honouring `DSH_HOME`, then the per-platform default and `~/.dsh`), copies the plugin to `<profile>/.local-plugins/` and `<profile>/node_modules/`, adds it to `dsh.profile.bundles`, and appends its loader row to `cordis.patch.yml`. It is idempotent and reports every path it writes.

```
dsh-github-sync installer
  source   /path/to/dsh-github-sync
  DSH home ~/.config/dsh-desktop/harness  (holds profiles/web/package.json)
  profile  ~/.config/dsh-desktop/harness/profiles/web

  wrote    .../profiles/web/.local-plugins/dsh-github-sync
  wrote    .../profiles/web/node_modules/dsh-github-sync
  updated  .../profiles/web/package.json
  updated  .../profiles/web/cordis.patch.yml
```

Restart DSH to load the plugin.

A DSH desktop install keeps more than one plausible home — the launcher exports `DSH_HOME`, while a CLI install defaults to `~/.dsh`. The script only accepts a directory that actually holds a profile manifest, and `--home <dir>` overrides the probe.

## Authentication

The token is a GitHub personal access token with the **`repo`** scope.

There are three ways to provide it, in priority order:

1. **Environment variable** — `GITHUB_TOKEN`, then `GH_TOKEN`. Nothing is stored on disk, so this is the best option for CI and shared machines.
2. **Ask the assistant** — "store my GitHub token" stores it with `github_configure`.
3. **HTTP** — `POST /api/github-sync.token` with `{"token": "..."}`.

```bash
# Option 1: export before launching DSH
export GITHUB_TOKEN=ghp_...
```

Stored tokens live in the DSH **credential store**, not in `settings.yaml`. That matters: the credential provider writes under file mode `0600` behind a write lock, whereas a settings field would persist the PAT as plain text in a YAML file the settings UI reads back.

Every token shape is masked before anything reaches a log or the transcript, including git's habit of quoting the remote URL back in its error messages.

## Tools

### `github_sync`

Publish the current workspace.

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `repo` | string | project folder name, slugified | Repository name |
| `owner` | string | configured owner, then the token's user | Repository owner |
| `description` | string | — | Applied only when the repository is created |
| `visibility` | `private` \| `public` \| `internal` | configured value, then `private` | Visibility for a new repository |
| `auto_init` | boolean | `false` | Let GitHub create an initial commit |
| `commit_message` | string | `Initial commit`, then `chore: sync workspace` | Commit message |
| `push` | boolean | `true` | Set `false` to commit locally only |
| `force` | boolean | `false` | Replace the remote branch when the histories conflict |

`auto_init` defaults to **false** deliberately. A repository created with an initial commit already holds a commit the workspace does not have, which makes the very first push a non-fast-forward rejection.

### `github_status`

Reports how a sync would behave — repository name, git state, remote, token source, git version — and changes nothing. Use it to preview. It also surfaces a pending harness-upgrade notice, if one exists (see [Staying current](#staying-current)).

### `github_configure`

Validates a personal access token against the GitHub API and stores it. It rejects a classic token that reports scopes without `repo`, and never echoes the token in its presentation. Call it only when the user has supplied a token; prefer `GITHUB_TOKEN` when they would rather not paste one.

## Settings

The `github-sync` namespace holds the non-secret defaults, editable in **Settings → Plugins**:

| Key | Default | Meaning |
|---|---|---|
| `owner` | empty | Account that owns new repositories; empty means the token's own user |
| `visibility` | `private` | Visibility for newly created repositories |
| `autoInit` | `false` | Let GitHub create an initial commit |
| `commitMessage` | empty | Commit message used when the workspace has no repository yet |

A settings surface or script can also use:

```
GET  /api/github-sync.settings   → defaults, token state, git version
POST /api/github-sync.token      → { "token": "..." } or { "clear": true }
POST /api/github-sync.verify     → validate the stored or supplied token
```

## Design notes

Three decisions are worth knowing, because each one prevents a specific failure.

**The token never lands on disk.** `origin` is always stored as the clean `https://github.com/<owner>/<repo>.git` URL, and the authenticated URL is passed as an argument to a single `git push`. The token therefore never enters `.git/config`, is never inherited by a later manual `git push`, and cannot be recovered from the repository.

**Git never prompts.** Every git call runs with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` and `GCM_INTERACTIVE=never`. Without that, a failed authentication makes git open a credential prompt on a console that does not exist in a hosted harness, and the call hangs until its timeout instead of reporting the failure.

**A diverged remote is reconciled, not clobbered.** When the remote branch already has commits, the plugin fetches and rebases before pushing; `force` stays opt-in. A conflicting rebase is rolled back with `git rebase --abort` so the work tree is left exactly as it was found.

Two smaller ones:

- **`origin` keeps the repository identity, not the credential** — so a later manual `git push` uses the user's own git credentials, as it should.
- **Git work is not concurrency-safe.** `github_sync` reports `isConcurrencySafe: false`, because two git runs in one workspace collide on the index lock.

## Staying current

A plugin is written against one harness API surface. When the app updates, a plugin may reference a package version, export, or service that no longer exists — and the failure mode is a plugin tree that will not load at all.

`scripts/watch-dsh-update.mjs` records the harness core version and, when it changes, writes a notice into the DSH home:

```bash
node scripts/watch-dsh-update.mjs
```

```
========================================
  DSH updated - plugins may need updating
========================================

  The DeepSeek Harness core moved from 0.1.5-rc.2 to 0.1.6. Installed
  plugins were built against the previous surface and may no longer load.

  Send this to the assistant in DSH:

  "DSH was updated from 0.1.5-rc.2 to 0.1.6. Check every installed plugin
   for compatibility and update the ones that need it."
```

`github_status` reads the notice and folds it into its own report, so the assistant can raise it without the user having to notice a console message.

Register it as a login task to have it run automatically. On Windows, a shortcut in the Startup folder is enough:

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$target  = '<profile>/node_modules/dsh-github-sync/scripts/watch-dsh-update.mjs'
$shell   = New-Object -ComObject WScript.Shell
$lnk     = $shell.CreateShortcut("$startup\DSH GitHub Sync Update Watch.lnk")
$lnk.TargetPath       = (Get-Command node).Source
$lnk.Arguments        = "`"$target`" --quiet"
$lnk.WindowStyle      = 7   # minimised
$lnk.Save()
```

Use `--quiet` to suppress output when nothing changed.

If DSH will not open at all, the failure is usually the plugin tree; start in Safe Mode and ask the assistant to re-enable plugins one at a time, or run the watcher by hand and send the assistant its message.

## Verification

`test/verify.mjs` runs 33 checks offline: the REST layer is served by a stub `fetch`, and the git layer talks to a real bare repository on local disk. That combination exercises the ordering that actually breaks in production — create, then init, then commit, then push — while staying hermetic.

```bash
node test/verify.mjs
```

```
units
  ok   slugifyRepoName produces names GitHub accepts
  ok   redact masks every token shape it may echo
  ok   the settings schema resolves every default
git (local bare remote)
  ok   a bare repository serves as the offline remote
  ok   a fresh init lands on the requested branch with no commits
  ok   the clean remote URL is what gets persisted
  ok   a diverged remote forces a rebase before the next push
tools (stubbed GitHub API)
  ok   apply() registers one namespace and three tools
  ok   github_sync reports NOT_CONFIGURED without touching the network
  ok   github_sync creates the repository, commits, and reports the outcome
  ok   a second sync with no changes reuses HEAD instead of failing
  ok   a TLS trust failure is reported as its own condition
  ok   a rejected call surfaces the permission GitHub asked for

33 passed, 0 failed
```

Run it from an installed copy so `@deepseek-ai/*` resolves:

```bash
node node_modules/dsh-github-sync/test/verify.mjs
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No GitHub token is configured` | Set `GITHUB_TOKEN`, or store one with `github_configure`, then restart DSH |
| `GitHub rejected the request (HTTP 401)` | The token is expired or wrong; issue a new one |
| `HTTP 403` with a permission hint | The next step names the exact permission GitHub wanted — for a fine-grained token, usually `administration=write` or `repository_creation=write` |
| `HTTP 404` on a repository you own | The token cannot see it — a fine-grained token needs this repository plus **Contents** and **Administration** write |
| `TLS_UNTRUSTED` | A TLS-inspecting proxy or GitHub accelerator is intercepting `api.github.com`. Windows trusts its root certificate, Node does not: point `NODE_EXTRA_CA_CERTS` at that root in PEM form and restart DSH — see [Behind a GitHub accelerator](#behind-a-github-accelerator) |
| `git push failed … non-fast-forward` | Retry, or pass `force` to replace the remote branch |
| `REBASE_CONFLICT` | Resolve it by hand in the workspace, or re-run with `force` |
| `The git executable was not found on PATH` | Install Git and restart DSH so the new `PATH` is picked up |
| The plugin never appears | Confirm the loader row is in `<profile>/cordis.patch.yml` and the package is under `<profile>/node_modules/`, then restart DSH |

### Behind a GitHub accelerator

A TLS-inspecting accelerator (Watt Toolkit / Steam++, FastGithub, dev-sidecar) serves GitHub through a local proxy and re-signs the connection with its own root certificate. Windows trusts that root; **Node does not**, because Node ships its own CA list instead of reading the OS store. Every plugin call then fails with `TLS_UNTRUSTED` even though the network is fine.

Export the accelerator's root and point Node at it:

```powershell
# 1. Export the accelerator's root certificate as PEM
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -match 'SteamTools' } | Select-Object -First 1
$b64  = [Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
$pem  = "-----BEGIN CERTIFICATE-----`n" +
        (($b64 -split '(.{1,64})' | Where-Object { $_ }) -join "`n") +
        "`n-----END CERTIFICATE-----`n"
$path = "$env:LOCALAPPDATA\dsh-github-sync\certs\accelerator-root.pem"
New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
[IO.File]::WriteAllText($path, $pem)

# 2. Let Node trust it. NODE_EXTRA_CA_CERTS is additive, so the built-in CAs survive.
setx NODE_EXTRA_CA_CERTS $path
```

Restart DSH afterwards so the host process inherits the variable.

**git usually needs nothing.** Git for Windows defaults to the `schannel` backend, which validates against the Windows certificate store — so once Windows trusts the accelerator root, git already works, and `http.sslCAInfo` is silently ignored:

```bash
git config --show-origin --get http.sslBackend
# schannel   -> the Windows store is in charge; no git-side CA configuration needed
```

Only if git reports an OpenSSL backend (the default on macOS and Linux, and on Windows builds configured that way) does it need its own bundle — and point it at the *combined* bundle, since replacing the default would break every host that is not intercepted:

```bash
cat "$(git config --get http.sslCABundle 2>/dev/null || echo /etc/ssl/certs/ca-certificates.crt)" \
    ~/.local/share/dsh-github-sync/certs/accelerator-root.pem > ~/.local/share/dsh-github-sync/certs/combined.crt
git config --global http.sslCAInfo ~/.local/share/dsh-github-sync/certs/combined.crt
```

## License

MIT — see [LICENSE](LICENSE).

# dsh-github-sync

[English](README.en.md) | 简体中文

在对话里把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工作区发布到 GitHub。

让助手同步项目，它会创建仓库、在工作区初始化 git、提交整棵工作树并推送。仓库名默认取项目文件夹名，可见性默认私有，两者都可以在单次调用时或在设置里覆盖。

```
你：   把这个项目传到 GitHub

DSH：  已同步 12 个变更文件到 octocat/my-project（分支 main）。
       仓库：https://github.com/octocat/my-project
```

## 功能

| 能力 | 说明 |
|---|---|
| **创建仓库** | GitHub 上不存在就创建，已存在则复用 |
| **初始化 git** | 沿用项目当前所在分支；新仓库用 `main` |
| **提交** | 暂存整棵工作树并提交；没有变更时复用现有 `HEAD`，而不是报错 |
| **推送** | 历史分叉时先 fetch + rebase 再推送 |
| **自动配置** | 写入账号的提交身份，并把分支上游记录下来 |
| **只读预览** | `github_status` 报告同步将要做什么，不改动任何东西 |

## 环境要求

- DeepSeek Harness `0.1.5-rc.2` 或更高
- Node.js 20.12+（需要 `AbortSignal.any`）
- `PATH` 中有 git

## 安装

把包复制进 DSH profile 并完成声明：

```bash
node scripts/install.mjs
```

脚本会先定位 DSH home（依次检查 `DSH_HOME`、各平台默认路径、`~/.dsh`），把插件复制到 `<profile>/.local-plugins/` 和 `<profile>/node_modules/`，加入 `dsh.profile.bundles`，并把加载行追加到 `cordis.patch.yml`。脚本可重复执行，并会打印每一个写入路径。

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

重启 DSH 以加载插件。

DSH 桌面版存在不止一个可能的 home —— 启动器会导出 `DSH_HOME`，而 CLI 版默认用 `~/.dsh`。脚本只接受真正含有 profile 清单的目录，`--home <dir>` 可覆盖探测结果。

## 认证

需要一个 GitHub personal access token。

按优先级有三种提供方式：

1. **环境变量** —— `GITHUB_TOKEN`，其次 `GH_TOKEN`。不在磁盘上留下任何东西，是 CI 和共享机器上的最佳选择。
2. **让助手存** —— 说「存一下我的 GitHub token」，它会用 `github_configure` 存储。
3. **HTTP** —— `POST /api/github-sync.token`，body 为 `{"token": "..."}`。

```bash
# 方式 1：启动 DSH 前导出
export GITHUB_TOKEN=ghp_...
```

**权限要求：**

| token 类型 | 需要的权限 |
|---|---|
| classic | `repo`（只发公开仓库可用 `public_repo`） |
| fine-grained | **Contents: Read and write**；若要让插件自己创建仓库，另需 **Administration: Read and write**（或账户级 **Repository creation**） |

> ⚠️ 注意一个容易误判的坑：仓库 API 返回的 `permissions.push=true` 反映的是**你账号在该仓库的角色**，不是这个 token 被授予的权限。判断 token 能否写入，要看 403 响应里的 `x-accepted-github-permissions` 头。

存储的 token 保存在 DSH **凭据库**里，不在 `settings.yaml`。这一点很重要：凭据库以文件权限 `0600` 写在写锁之后，而设置字段会把 PAT 以明文留在设置界面会读回的 YAML 文件里。

所有 token 形态在进入日志或对话记录之前都会被遮蔽 —— 包括 git 报错时习惯性回显 remote URL 这种行为。

## 工具

### `github_sync`

发布当前工作区。

| 参数 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `repo` | string | 项目文件夹名，经 slug 化 | 仓库名 |
| `owner` | string | 配置的 owner，其次 token 所属用户 | 仓库所有者 |
| `description` | string | — | 仅在创建仓库时生效 |
| `visibility` | `private` \| `public` \| `internal` | 配置值，其次 `private` | 新仓库的可见性 |
| `auto_init` | boolean | `false` | 是否让 GitHub 创建首个提交 |
| `commit_message` | string | `Initial commit`，其次 `chore: sync workspace` | 提交信息 |
| `push` | boolean | `true` | 设为 `false` 则只在本地提交 |
| `force` | boolean | `false` | 历史冲突时覆盖远端分支 |

`auto_init` 默认是 **false**，这是刻意的。用初始提交创建的仓库，本身已含有一个工作区没有的提交，会让第一次推送就被 non-fast-forward 拒绝。

### `github_status`

报告一次同步会如何执行 —— 仓库名、git 状态、远端、token 来源、git 版本 —— 不改动任何东西。用于预览。它也会带出待处理的 harness 升级提醒（见 [保持更新](#staying-current)）。

### `github_configure`

向 GitHub API 校验一个 personal access token 并存储。若 classic token 报告的 scope 不含 `repo` 会被拒绝；它的调用展示中永不回显 token。仅在用户主动提供了 token 时调用；如果用户不愿粘贴，优先用 `GITHUB_TOKEN`。

## 设置

`github-sync` 命名空间保存非敏感默认值，可在 **设置 → 插件** 中编辑：

| 键 | 默认值 | 含义 |
|---|---|---|
| `owner` | 空 | 新仓库的所属账号；空表示 token 自己的用户 |
| `visibility` | `private` | 新建仓库的可见性 |
| `autoInit` | `false` | 是否让 GitHub 创建首个提交 |
| `commitMessage` | 空 | 工作区尚无仓库时使用的提交信息 |

配置界面或脚本也可以直接用：

```
GET  /api/github-sync.settings   → 默认值、token 状态、git 版本
POST /api/github-sync.token      → { "token": "..." } 或 { "clear": true }
POST /api/github-sync.verify     → 校验已存储或传入的 token
```

## 设计取舍

有三个决定值得了解，因为每一个都对应一种具体的失败。

**token 永不落盘。** `origin` 始终保存为干净的 `https://github.com/<owner>/<repo>.git`，而带认证信息的 URL 只作为单次 `git push` 的参数传入。因此 token 不会进入 `.git/config`，不会被之后手动执行的 `git push` 继承，也无法从仓库里被翻出来。

**git 永不弹出提示。** 每次 git 调用都带 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=` 和 `GCM_INTERACTIVE=never`。没有这些，一次认证失败会让 git 在一个托管 harness 里根本不存在的控制台上等待输入密码，调用会一直挂到超时，而不是把失败报出来。

**远端分叉是协调，不是覆盖。** 当远端分支已有提交时，插件先 fetch 再 rebase，之后才推送；`force` 始终需要显式开启。rebase 冲突时会用 `git rebase --abort` 回滚，工作树被留在原样。

另外两个较小的点：

- **`origin` 保存的是仓库身份，不是凭据** —— 因此之后手动 `git push` 会用用户自己的 git 凭据，这才是应有的行为。
- **git 操作不是并发安全的。** `github_sync` 声明 `isConcurrencySafe: false`，因为同一工作区里两次 git 会在索引锁上相撞。

<a id="staying-current"></a>
## 保持更新

插件是针对某一个 harness API 面写的。应用更新后，插件引用的包版本、导出或服务可能已不存在 —— 而它的失败形态是整棵插件树完全无法加载。

`scripts/watch-dsh-update.mjs` 记录 harness 核心版本，一旦变化就往 DSH home 写一条提醒：

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

`github_status` 会读取这条提醒并并入自己的报告，因此助手可以主动提出，不必等用户自己注意到控制台输出。

把它注册成登录任务即可自动运行。在 Windows 上，放进「启动」文件夹的快捷方式就够了：

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$target  = '<profile>/node_modules/dsh-github-sync/scripts/watch-dsh-update.mjs'
$shell   = New-Object -ComObject WScript.Shell
$lnk     = $shell.CreateShortcut("$startup\DSH GitHub Sync Update Watch.lnk")
$lnk.TargetPath       = (Get-Command node).Source
$lnk.Arguments        = "`"$target`" --quiet"
$lnk.WindowStyle      = 7   # 最小化
$lnk.Save()
```

加 `--quiet` 可在没有变化时不输出。

如果 DSH 完全打不开，问题通常出在插件树上：先用安全模式启动，让助手逐个重新启用插件；或者手动跑一次这个 watcher，把它给出的那段话发给助手。

## 验证

`test/verify.mjs` 离线运行 33 项检查：REST 层由 stub `fetch` 提供，git 层跑在磁盘上真实的 bare 仓库上。这个组合恰好覆盖了生产上真正会出问题的顺序 —— 创建、初始化、提交、推送 —— 同时又完全不依赖外网。

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

要从已安装的副本运行，这样 `@deepseek-ai/*` 才能解析：

```bash
node node_modules/dsh-github-sync/test/verify.mjs
```

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `No GitHub token is configured` | 设置 `GITHUB_TOKEN`，或用 `github_configure` 存一个，然后重启 DSH |
| `GitHub rejected the request (HTTP 401)` | token 过期或错误，重新签发 |
| `HTTP 403` 且带权限提示 | 提示里会给出 GitHub 要求的准确权限 —— fine-grained token 通常是 `administration=write` 或 `repository_creation=write` |
| 自己拥有的仓库却 `HTTP 404` | token 看不见它 —— fine-grained token 需要勾选该仓库，并授予 **Contents** 与 **Administration** 写权限 |
| `TLS_UNTRUSTED` | 有 TLS 中间人代理或 GitHub 加速器在接管 `api.github.com`。Windows 信任它的根证书，Node 不信任：把该根证书以 PEM 形式指给 `NODE_EXTRA_CA_CERTS` 后重启 DSH —— 见 [GitHub 加速器环境](#accelerator) |
| `git push failed … non-fast-forward` | 重试，或传 `force` 覆盖远端分支 |
| `REBASE_CONFLICT` | 在工作区手动解决冲突，或带 `force` 重跑 |
| `The git executable was not found on PATH` | 安装 Git 并重启 DSH，让新的 `PATH` 生效 |
| 插件始终不出现 | 确认加载行在 `<profile>/cordis.patch.yml`、包在 `<profile>/node_modules/` 下，然后重启 DSH |

<a id="accelerator"></a>
### GitHub 加速器环境

TLS 中间人型加速器（Watt Toolkit / Steam++、FastGithub、dev-sidecar）通过本地代理转发 GitHub，并用它自己的根证书重新签名连接。Windows 信任这个根证书；**Node 不信任**，因为 Node 自带一份 CA 列表，不读系统证书库。于是每次插件调用都失败在 `TLS_UNTRUSTED`，尽管网络本身完全正常。

导出加速器根证书并指给 Node：

```powershell
# 1. 把加速器根证书导出为 PEM
$cert = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -match 'SteamTools' } | Select-Object -First 1
$b64  = [Convert]::ToBase64String($cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
$pem  = "-----BEGIN CERTIFICATE-----`n" +
        (($b64 -split '(.{1,64})' | Where-Object { $_ }) -join "`n") +
        "`n-----END CERTIFICATE-----`n"
$path = "$env:LOCALAPPDATA\dsh-github-sync\certs\accelerator-root.pem"
New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
[IO.File]::WriteAllText($path, $pem)

# 2. 让 Node 信任它。NODE_EXTRA_CA_CERTS 是追加式的，内置 CA 不受影响。
setx NODE_EXTRA_CA_CERTS $path
```

之后重启 DSH，让宿主进程继承这个变量。

**git 通常什么都不用配。** Windows 版 git 默认使用 `schannel` 后端，它走 Windows 证书库校验 —— 所以只要 Windows 信任加速器根证书，git 本来就能用，而 `http.sslCAInfo` 会被静默忽略：

```bash
git config --show-origin --get http.sslBackend
# schannel   -> 由 Windows 证书库负责，git 侧不需要任何 CA 配置
```

只有当 git 报告的是 OpenSSL 后端时（macOS、Linux 的默认情况，以及部分这样配置的 Windows 构建）才需要给它单独的 bundle —— 而且要指向**合并后**的 bundle，因为直接替换默认值会破坏所有未被中间人的正常域名：

```bash
cat "$(git config --get http.sslCABundle 2>/dev/null || echo /etc/ssl/certs/ca-certificates.crt)" \
    ~/.local/share/dsh-github-sync/certs/accelerator-root.pem > ~/.local/share/dsh-github-sync/certs/combined.crt
git config --global http.sslCAInfo ~/.local/share/dsh-github-sync/certs/combined.crt
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

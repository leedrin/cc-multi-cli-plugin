# Usage-Correctness 分支安装与部署

可以在 **Claude Code** 中安装本仓库的 `Usage-Correctness` 分支。
本指南补充 [原安装文档](installation.md)，不替换原文档。
适用于 Windows / PowerShell；代码块会分别标明“终端命令”和“Claude Code 会话命令”。

## 1. 先确定要安装哪一份代码

| 安装来源 | 得到的代码 | 使用条件 |
| --- | --- | --- |
| `greenpolo/cc-multi-cli-plugin` | 上游默认分支 | 上游通常发布方式 |
| `leedrin/cc-multi-cli-plugin` | 本 fork 的默认分支 | 不会自动选择 Usage 分支 |
| `leedrin/cc-multi-cli-plugin#Usage-Correctness` | fork 的 Usage 分支 | 必须先把分支推送到 GitHub |
| `F:/cc-multi-cli-plugin` | 该目录的工作树内容 | 现在即可本地安装，包括尚未提交的文件 |

Claude Code 官方支持用 `#ref` 指定 GitHub 或 Git 仓库的分支或标签。
完整 URL 写法为：

```text
https://github.com/leedrin/cc-multi-cli-plugin.git#Usage-Correctness
```

参见 [官方安装来源说明](https://code.claude.com/docs/en/discover-plugins#add-a-marketplace)。

### 首次检查记录：2026-10-31

- 本地 `Usage-Correctness` 的已提交代码为 `785a850`，已合入上游 `e959b96`。
- 当前仓库版本为 `0.4.0`；`origin` 尚无 `Usage-Correctness` 分支。
- 本机已有的 marketplace 来源仍是 `greenpolo/cc-multi-cli-plugin`，没有分支引用。
- 本机已安装 `multi-core` 和 `multi-openai`，版本均为 `0.3.0`，scope 均为 `user`。
- 本次只检查已有安装，并在临时配置中做安装测试；没有替换本机已有插件。

以上是迁移前的历史状态。后续本机已改用 `F:/cc-multi-cli-plugin` 本地来源，
安装了 `user` scope 的 `multi-core` / `multi-openai` 0.4.0；
2026-11-01 用户确认 PowerShell 启动、`claude-multi` 启动和插件加载正常。
本地安装使用第 3 节；需要从 GitHub 分发时，再执行第 4 节。

## 2. 安装前准备

在 PowerShell 中检查环境：

```powershell
Set-Location 'F:/cc-multi-cli-plugin'
git branch --show-current
git log -1 --oneline
node --version
claude.exe --version
npm.cmd ci
```

确认当前分支为 `Usage-Correctness`。Node 需要 `24.12.0` 或更新版本。
上游文档声明 Claude Code 最低版本为 `2.1.272`；本分支本次实际测试版本为
`2.1.316`，最低 / pinned / 最新三个版本的完整宿主矩阵仍未完成。

本项目运行 TypeScript 源码，不需要另行打包 VSIX、MSI 或执行通用 build 命令。
PowerShell 若阻止 `npm.ps1`，使用上面的 `npm.cmd`，无需为安装修改系统执行策略。

先查看已有来源和插件：

```powershell
claude.exe plugin marketplace list --json
claude.exe plugin list --json
```

### 已安装上游或旧 fork：先修改同名 marketplace 的来源

上游、本 fork 和 Usage 分支的 marketplace 都叫 `cc-multi-cli-plugin`。
Claude Code 对同名 marketplace 只注册一个来源；不能靠重复安装得到三个独立副本。
项目的安装发现代码也使用这个名称，因此不要只修改 marketplace 名称来隔离分支。
见 [官方 marketplace 名称规则](https://code.claude.com/docs/en/plugins/marketplace-reference#marketplace-file)
和 [项目安装发现实现](../plugins/multi-core/src/install/plugins.ts)。

本机现有来源由用户设置声明。先备份该设置文件：

```powershell
$usageClaudeConfig = if ($env:CLAUDE_CONFIG_DIR) {
    $env:CLAUDE_CONFIG_DIR
} else {
    Join-Path $env:USERPROFILE '.claude'
}
$usageSettingsPath = Join-Path $usageClaudeConfig 'settings.json'
$usageSettingsBackup = "$usageSettingsPath.before-usage-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
if (Test-Path -LiteralPath $usageSettingsPath) {
    Copy-Item -LiteralPath $usageSettingsPath -Destination $usageSettingsBackup
}
```

在该文件已有的 `extraKnownMarketplaces` 中，仅修改
`cc-multi-cli-plugin.source`，保留其他设置和插件启用项。
下文 JSON 是需要合并的片段，不是让你覆盖整个设置文件。
如果同一 marketplace 还在项目、本地或受管设置中声明，也需核对实际生效的来源。

修改后退出已有 Claude Code 会话，重新启动一个交互会话，等待来源协调完成。
官方加载规则说明，新会话会重新获取来源声明发生变化的 marketplace。
再用 `claude.exe plugin marketplace list --json` 确认结果。
见 [来源设置格式](https://code.claude.com/docs/en/plugins/marketplace-reference#source-objects-in-settings)
和 [启动时来源协调](https://code.claude.com/docs/en/plugins/loading#plugins-and-marketplaces-that-arent-on-disk-at-session-start)。

不要把 `marketplace remove` 当作常规换源步骤：删除最后一份声明可能同时卸载插件，
并清理插件保存的数据和选项。不要删除 Codex / Cursor 等 provider 的登录文件。
见 [官方移除行为](https://code.claude.com/docs/en/plugins/cli-reference#plugin-marketplace-remove)。

## 3. 本机安装当前分支：现在可用

### 3.1 选择本地来源

对于本机已有的上游安装，把第 2 节所述设置片段改为：

```json
{
  "extraKnownMarketplaces": {
    "cc-multi-cli-plugin": {
      "source": {
        "source": "directory",
        "path": "F:/cc-multi-cli-plugin"
      }
    }
  }
}
```

重新启动 Claude Code 后，确认 marketplace 的来源为此目录。

如果是从未注册过此 marketplace 的新环境，可以直接在 PowerShell 执行：

```powershell
claude.exe plugin marketplace add 'F:/cc-multi-cli-plugin' --scope user
```

### 3.2 安装 core 和需要的 provider

以下为 **PowerShell 命令**，以 OpenAI 为例：

```powershell
claude.exe plugin install multi-core@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-openai@cc-multi-cli-plugin --scope user
```

provider 会自动依赖 `multi-core`。这里显式安装 core，便于核对安装 scope。
项目要求启动器使用的 core 来自 `user` scope，仅安装到 project/local 不满足这一要求。

如果这些插件已安装，换源后使用更新命令：

```powershell
claude.exe plugin marketplace update cc-multi-cli-plugin
claude.exe plugin update multi-core@cc-multi-cli-plugin --scope user
claude.exe plugin update multi-openai@cc-multi-cli-plugin --scope user
```

其他 provider 按需选择对应的一行；无需全部安装：

```powershell
claude.exe plugin install multi-cursor@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-zen@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-antigravity@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-grok@cc-multi-cli-plugin --scope user
```

本机原来是 `0.3.0`，本地分支是 `0.4.0`，因此可以通过版本变化更新。
若提示已是最新版，先看第 5 节，不要直接清空整个插件缓存。

### 3.3 重载、setup 和账号连接

先在准备使用的 **Windows PowerShell 终端** 中执行，再从该终端进入 Claude Code：

```powershell
$env:PROFILE = $PROFILE
claude.exe
```

当前 setup 通过环境变量 `PROFILE` 获取目标 profile；PowerShell 的 `$PROFILE`
本身不是环境变量，因此需显式传给子进程。每次需要运行 setup 时都应先做这一步。
不要从此前已经打开、未继承此变量的 Claude Code 会话执行 setup。
这是当前安装器的兼容性绕行方法，代码尚未修复；详细排障见第 3.4 节。

在 **Claude Code 交互会话内**执行：

```text
/reload-plugins
/multi-core:setup --command claude-multi
```

setup 会写入 Multi 的启动脚本和 PowerShell profile 中带标记的 PATH 配置。
保留默认 `claude-multi` 名称即可；不需要把普通 `claude` 命令改成 Multi。

根据所安装的 provider 连接账号。已有原生登录可先复用，缺失或失效时按提示重新登录：

| Provider | Claude Code 会话命令 |
| --- | --- |
| OpenAI | `/multi-openai:login` |
| Cursor | `/multi-cursor:login` |
| Zen | `/multi-zen:connect` |
| Antigravity | `/multi-antigravity:connect` |
| Grok | `/multi-grok:login` |

浏览器登录和密钥输入由本人完成；Zen 密钥在独立终端输入。
账号仍由对应 provider 管理，不需要为了换插件分支删除或搬运凭据。

打开新终端后运行：

```powershell
multi.cmd status
claude-multi.cmd
```

如果 PowerShell profile 没有加载，先用 setup 实际生成的绝对路径运行：

```powershell
& "$env:USERPROFILE/.local/share/multi-cli/bin/multi.cmd" status
& "$env:USERPROFILE/.local/share/multi-cli/bin/claude-multi.cmd"
```

### 3.4 Windows PowerShell 实际遇到的问题与修复

#### setup 成功，但新终端找不到 `claude-multi` / `multi`

本机遇到过两个独立原因：profile 写错位置，以及正确的 profile 被执行策略阻止。
先在实际使用的 PowerShell 中检查：

```powershell
$PSVersionTable.PSVersion
$PROFILE
Get-ExecutionPolicy
Get-ExecutionPolicy -List
Get-Command multi, claude-multi -ErrorAction SilentlyContinue
Get-Content -LiteralPath "$env:USERPROFILE/.local/share/multi-cli/state.json"
```

`state.json` 的 `shellFile` 应与当前 `$PROFILE` 对应，启动命令应为 `claude-multi`。
profile 的实际路径以 `$PROFILE` 为准；通常 Windows PowerShell 5.1 使用
`Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`，PowerShell 7 使用
`Documents/PowerShell/Microsoft.PowerShell_profile.ps1`。

当前 [安装器的 `shellFile()`](../plugins/multi-core/src/install/installation.ts)
在没有 `env.PROFILE` 时固定回退到 PowerShell 7 路径。
本机没有安装 `pwsh`，首次 setup 却写入了该位置，因此即使提示成功，
Windows PowerShell 也不会加载那份文件。

如果检查确认已有安装写错 profile，先备份相关 profile 和 `state.json`，
再用下面的绝对路径命令移除旧的 shell 集成：

```powershell
& "$env:USERPROFILE/.local/share/multi-cli/bin/multi.cmd" uninstall
$env:PROFILE = $PROFILE
claude.exe
```

在刚打开的 Claude Code 会话中重新执行第 3.3 节的 setup。
`multi uninstall` 保留插件和 provider 登录；这里仅用于修复已确认的错误 shell 路径，
不是日常更新步骤。直接改 `PROFILE` 后重跑 setup，可能会收到
`Uninstall the existing shell integration before changing shells.`。
首次错误安装留下的 PowerShell 7 profile 若为空，可保留，无需为此删除目录。

#### 每次启动都报 `running scripts is disabled on this system`

典型报错包含 `Microsoft.PowerShell_profile.ps1 cannot be loaded`、
`PSSecurityException` 或 `UnauthorizedAccess`。
本机当时各 scope 均为 `Undefined`，最终生效策略为 `Restricted`：
它禁止运行 profile，所以其中添加 Multi PATH 的配置也无法执行。
即使临时补上 PATH，裸命令仍可能优先解析到同名 `.ps1`，继续被策略阻止。

希望正常加载本地 profile 和启动脚本时，在普通 PowerShell 中执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

出现确认提示时输入 `Y`。该设置持久保存到当前用户注册表，无需管理员权限；
允许本地脚本运行，对标记为互联网来源的脚本仍有签名要求。
若 `MachinePolicy` / `UserPolicy` 已由组织设置，先核对其要求，
`CurrentUser` 不能覆盖组策略。策略语义和优先级见
[微软执行策略说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1)。

关闭并重新打开 Windows PowerShell，验证启动无上述报错，再执行：

```powershell
Get-ExecutionPolicy
Get-Command multi, claude-multi, claude.exe
multi status
claude-multi
```

本机验证结果为 `RemoteSigned`，Multi 命令解析到安装目录，`multi status` 返回 0，
普通 `claude.exe` 仍指向真实 Claude 可执行文件。用户随后确认启动和加载正常。
这不代表已验证 OpenAI 登录有效性或真实推理计量。

若不希望修改持久执行策略，可使用第 3.3 节的**绝对路径 `.cmd` 命令**运行 Multi；
这不依赖 profile 加载，但不会消除默认启动 PowerShell 时的 profile 报错。
仅临时测试 profile 时，可从终端启动一个会话：

```powershell
powershell.exe -NoLogo -ExecutionPolicy RemoteSigned
```

此方式只影响该会话及子进程，不会持久修改执行策略。
如需撤销前面的 `CurrentUser` 修改，恢复修改前记录的值；本机修改前为 `Undefined`。
恢复 `Undefined` 后，若其他 scope 仍未设置，默认 `Restricted` 及其 profile 报错会恢复。

#### 不同终端与 Claude 配置目录

本次 PATH 集成仅写入所选的 Windows PowerShell profile，没有修改用户级 PATH。
因此不能以此推断 cmd、Git Bash 或 PowerShell 7 也能找到命令。
`claude-multi` 是终端启动命令；`claude multi` 不会启动 Multi gateway。

如果由 Orca 等工具设置了 `CLAUDE_CONFIG_DIR`，插件可能安装在它管理的配置目录内。
缓存路径包含 Orca 并不能证明装错分支，应按第 6 节比较来源和实际源码。
本地工作树的后续修改需要按第 5 节更新缓存，并重新启动 `claude-multi` 才会生效。

## 4. GitHub 分支安装：发布后可用

### 4.1 维护者先发布分支和可辨识的版本

仅在本地创建分支不够。远程安装要求 GitHub 已存在目标分支和提交。
先检查：

```powershell
Set-Location 'F:/cc-multi-cli-plugin'
git branch --show-current
git status --short
git ls-remote --heads origin Usage-Correctness
```

如果最后一条没有返回，远端分支尚不存在。

正式分发建议生成独立的预发布版本，例如 `0.4.1-usage.1`。
此版本只是发布示例；不要为阅读本指南就执行版本发布。
准备发布时，使用仓库已有脚本，不要只手改一处 manifest：

```powershell
npm.cmd run release -- 0.4.1-usage.1 --summary 'Usage correctness and observability preview'
npm.cmd run check
npm.cmd run test:mod
```

脚本会同步 package、lockfile、marketplace、各插件版本、core 依赖约束、
Codex 客户端声明版本和 CHANGELOG。以后每次正式分发都使用新的版本。
示例后续版本为 `0.4.1-usage.2`；最终选择还应高于当时的仓库版本。
见 [版本脚本](../scripts/release.ts) 和 [一致性实现](../scripts/versioning.ts)。

审阅脚本打印的文件列表，再只提交本次发布相关文件：

```powershell
git diff --stat
git add -- package.json package-lock.json CHANGELOG.md .claude-plugin/marketplace.json .claude-plugin/plugin.json 'plugins/*/.claude-plugin/plugin.json' plugins/multi-openai/src/usage.ts docs/installation-usage-correctness.md
git diff --cached --stat
git commit -m 'release: Usage correctness preview'
git push -u origin Usage-Correctness
git ls-remote --heads origin Usage-Correctness
```

确认暂存区没有混入其他 OpenSpec、技能或工作中的修改。不要使用 `git add -A`
把本机所有未提交内容一起发布，也无需 force push。

本仓库的自动 GitHub Release 工作流由 `main` 分支触发。
把 Usage 分支推送到 GitHub，已经足够用于按分支安装；不要求合入 main 或创建 Release。
见 [发布工作流](../.github/workflows/release.yml)。

### 4.2 新用户从 GitHub 安装

分支发布成功后，在 **Claude Code 会话内**执行：

```text
/plugin marketplace add leedrin/cc-multi-cli-plugin#Usage-Correctness
/plugin install multi-openai@cc-multi-cli-plugin
/reload-plugins
/multi-core:setup --command claude-multi
```

Windows PowerShell 用户在执行 setup 前，先按第 3.3 节传入 `$env:PROFILE`，
并从该终端重新进入 Claude Code；远程安装同样需要此绕行方法。

在插件安装界面选择 `User` scope。其他 provider 与第 3 节相同，按需安装。

也可以全部从 **PowerShell** 安装，并明确指定 scope：

```powershell
claude.exe plugin marketplace add 'https://github.com/leedrin/cc-multi-cli-plugin.git#Usage-Correctness' --scope user
claude.exe plugin install multi-core@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-openai@cc-multi-cli-plugin --scope user
```

已有同名 marketplace 的用户先按第 2 节换源，不能假设重复 add 会替换来源。
远程来源片段为：

```json
{
  "extraKnownMarketplaces": {
    "cc-multi-cli-plugin": {
      "source": {
        "source": "github",
        "repo": "leedrin/cc-multi-cli-plugin",
        "ref": "Usage-Correctness"
      }
    }
  }
}
```

不要在此场景填写 `greenpolo/cc-multi-cli-plugin`，也不要漏掉 `ref`。
安装来源已经由仓库和分支决定，插件清单内的 author 字段不决定下载来源。

## 5. 后续更新与缓存

### 本地分支修改后更新

本机当前来源是 `F:/cc-multi-cli-plugin`，因此无需推送 GitHub。
先退出旧 `claude-multi` 会话，确认目录仍在 `Usage-Correctness` 分支，
按第 4.1 节用版本脚本生成新的可辨识版本并运行检查，再执行下方三条更新命令。
用 `claude.exe plugin list --json` 核对新版本后，运行 `multi status` 和 `claude-multi`。
不要重复使用同一个版本号来判断缓存是否已经刷新。

### 远程分支更新

维护者先生成新版本并推送 Usage 分支。用户在 **PowerShell** 执行：

```powershell
claude.exe plugin marketplace update cc-multi-cli-plugin
claude.exe plugin update multi-core@cc-multi-cli-plugin --scope user
claude.exe plugin update multi-openai@cc-multi-cli-plugin --scope user
```

对其他已安装 provider 也执行对应的 `plugin update`。
更新后退出旧 `claude-multi` 会话并重新启动，让 gateway 和 hooks 使用同一份新代码。
普通业务代码更新无需重跑 setup 或重新登录。
只有安装器、复制到 Multi 安装目录的启动脚本或启动配置需要更新时，才重跑 setup；
Windows PowerShell 仍需先按第 3.3 节传入 `$env:PROFILE`。

`marketplace update` 更新的是已经登记的来源及 ref，不负责把上游来源改为 fork。
插件更新使用上述终端 CLI，不依赖未核实的 `/plugin update` 会话写法。
见 [官方 CLI 更新说明](https://code.claude.com/docs/en/plugins/cli-reference#plugin-update)。

### 为什么换分支后仍可能是旧代码

远程插件优先以插件 manifest 中的版本识别更新，其次是 marketplace 条目的版本，
缺少这些声明时才使用源码标识。两个分支都标为 `0.4.0` 时，
不能以“已经切换来源”来判断插件缓存已替换。独立版本和安装路径核对都需要做。
见 [官方版本与更新规则](https://code.claude.com/docs/en/plugins/loading#versions-and-updates)。

本地路径的加载行为也需看实际 Claude Code 版本。
当前官方文档描述了本地相对插件的原地加载；本机 `2.1.316` 的隔离安装测试则验证了
复制到缓存后仍可独立运行的路径。不要把“编辑本地源码”直接当成“已更新安装版本”。
以 `claude.exe plugin list --json` 返回的 `installPath` 和实际文件为准。
若使用缓存且版本没有变化，先生成可区分的新版本，再更新。
见 [官方原地与复制加载说明](https://code.claude.com/docs/en/plugins/loading#in-place-and-copied-plugins)。

## 6. 核对确实安装了 Usage 分支

### 6.1 检查来源、scope 和版本

```powershell
claude.exe plugin marketplace list --json
claude.exe plugin list --json
```

远程安装应显示 `leedrin/cc-multi-cli-plugin`，且 `ref` 为 `Usage-Correctness`。
本地安装应显示本地目录。确认 core 和选中的 provider 已启用，core 为 `user` scope，
版本是本地当前版本或本次发布版本，而非本机旧的 `0.3.0`。

只查看本 marketplace 的安装项，可以执行：

```powershell
$usageInstalled = claude.exe plugin list --json | ConvertFrom-Json
$usageInstalled |
    Where-Object { $_.id -like '*@cc-multi-cli-plugin' } |
    Select-Object id, version, scope, enabled, installPath
```

### 6.2 查看已安装 core 的实际文件

```powershell
$usageCore = $usageInstalled |
    Where-Object { $_.id -eq 'multi-core@cc-multi-cli-plugin' -and $_.scope -eq 'user' }
Test-Path -LiteralPath (Join-Path $usageCore.installPath 'plugins/multi-core/src/gateway/usage-accounting.ts')
Test-Path -LiteralPath (Join-Path $usageCore.installPath 'plugins/multi-core/hooks/usage-pane.ts')
```

在当前分支的本地安装中，下面还能直接核对关键源码是否一致：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'F:/cc-multi-cli-plugin/plugins/multi-core/src/gateway/responses.ts'
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $usageCore.installPath 'plugins/multi-core/src/gateway/responses.ts')
```

比较两项哈希应相同；远程发布安装则应与对应的已发布提交比较。
插件缓存不一定包含可供 `git log` 查询的 `.git`，不要只依赖缓存目录里的 Git 命令。

### 6.3 启动和功能验收

在新启动的 `claude-multi` 会话中执行：

```text
/model
/multi-usage --text
/multi-usage
```

确认模型列表符合已连接 provider，文本模式可读，Pane 的 provider 切换、滚动、
Refresh、Receipts 和 Close 可操作。先完成这些不需要模型推理的检查。
真实计量对账需要再进行一次有界 provider 请求，按项目 live probe 单独验证。

`multi status` 只说明安装和启用状态；它不验证登录有效性、模型推理或真实计费。

## 7. 本指南的验证记录与边界

- 已读取上游安装文档和 Claude Code 官方插件安装、来源、加载及更新规则。
- 已核对本机 `claude.exe 2.1.316` 的 marketplace add、plugin install/update/list 帮助。
- 本次 `npm.cmd run test:live:install` 已通过：在临时 home/config 中安装
  `multi-zen` 和自动依赖的 `multi-core`，核对缓存独立运行、gateway picker、
  provider 启用、setup 和 uninstall；没有 provider 推理请求。
- 此烟测代表本地安装链路通过，不代表已经完成 GitHub 分支发布和远程安装。
- 首次文档编写和隔离烟测没有改动真实用户安装；后续已完成本地来源迁移及安装，
  并记录第 3.4 节的 PowerShell 路径和执行策略问题。
- 2026-11-01 用户确认 PowerShell 启动、Multi 启动和插件加载正常；
  仓库安装器的 profile 路径回退缺陷仍未修复，运行 setup 时继续使用文档中的绕行方法。
- 真实终端与三版本交互验收继续使用 [宿主检查清单](usage-host-checklist.md)。

上游原文：[greenpolo 安装文档](https://github.com/greenpolo/cc-multi-cli-plugin/blob/main/docs/installation.md)。

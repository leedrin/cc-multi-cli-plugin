# Multi-Provider v2 分支安装与部署

本指南说明如何在 **Claude Code** 中安装 `feature/multi-provider-v2` 分支，
并启用该分支新增的 DeepSeek、GLM、Strata provider。
它是 [原安装文档](installation.md) 和 [Usage 分支安装文档](installation-usage-correctness.md) 的补充，
不替代这两份文档。marketplace 换源、PowerShell profile 与执行策略问题，
仍按 Usage 文档的第 2 节和第 3.4 节处理，这里不再重复。
本指南面向 Windows / PowerShell。每个代码块都会注明是“终端命令”还是“Claude Code 会话命令”。

## 1. 本分支新增的内容

| 功能 | 说明 |
| --- | --- |
| `multi-pi` 插件 | 一个插件提供 4 个 provider：`deepseek`、`zai`、`zai-coding-cn`、`strata`。后端使用 Pi AI 库（`@earendil-works/pi-ai`），不运行 Pi CLI。 |
| Provider 注册表 | 各 provider 统一用描述符注册。启动器把已安装插件展开成 provider ID 列表；如果插件没有启用，请求会报错并写明是哪个插件。 |
| 路由格式 | `multi/<provider>/<model>`，例如 `multi/deepseek/deepseek-flash`。未知 provider 返回 HTTP 400，不会再默认发给 OpenAI。 |
| 凭据来源与隔离 | 密钥优先从启动终端的环境变量读取；环境变量没设置时，从 Pi 配置（`~/.pi/agent/auth.json`、`models.json`）读取，`MULTI_PI_CONFIG=0` 可关闭。读取后密钥只在内存中传递，不会传给子进程。 |
| 审查策略 | 由各 provider 的描述符决定。Pi provider 没有审查器：Auto 模式会直接执行动作，并提示 `no auto mode: actions run unreviewed`；Plan 模式会拒绝需要审查的动作。 |
| Strata 模型名解析 | 对外的模型名固定为 `qwen3.8-flash-next`。每次请求时先查询 `/models`，再决定实际发给服务器的模型名。 |

各 provider 的完整模型说明见 [DeepSeek、GLM 和 Strata via Pi](pi.md)。

## 2. 先确定要安装哪一份代码

| 安装来源 | 得到的代码 | 使用条件 |
| --- | --- | --- |
| `F:/cc-multi-cli-plugin` | 该目录的工作树内容 | 现在就能在本机安装 |
| `leedrin/cc-multi-cli-plugin#feature/multi-provider-v2` | fork 的 v2 分支 | 要先把分支推送到 GitHub |
| `leedrin/cc-multi-cli-plugin` | fork 的默认分支 | 不包含 v2，除非 v2 已经合入 |

### 检查记录（2026-11-07）

- 本地 `feature/multi-provider-v2` 的最新提交是 `7d804db`，比 `main` 多 78 个提交。
- 仓库版本仍是 `0.4.0`，与 Usage 分支相同。
- `origin` 上还没有 `feature/multi-provider-v2` 分支。
- 本机已安装 `multi-core` 和 `multi-openai`，版本 `0.4.0`，scope `user`。安装位置在 Orca 管理的配置目录下。
- 这份已安装的 core 缓存来自旧快照：既没有 `plugins/multi-pi/src`，也没有 `node_modules/@earendil-works/pi-ai`。如果直接运行，会缺少 Pi provider。
- `openspec/` 下的归档改动和根目录的 `{}` 还没有提交。本地目录安装时，缓存会复制整个工作树，这些文件也会被复制进去，但不影响运行。

## 3. 安装前准备

在 **PowerShell** 中执行：

```powershell
Set-Location 'F:/cc-multi-cli-plugin'
git branch --show-current
git log -1 --oneline
node --version
claude.exe --version
npm.cmd ci
Test-Path -LiteralPath 'node_modules/@earendil-works/pi-ai/package.json'
```

检查以下几点：

- 当前分支是 `feature/multi-provider-v2`。
- Node 是 `24.12.0` 或更新版本。
- 最后一条命令返回 `True`。

`multi-core` 的插件来源是整个仓库根目录。安装时，Claude Code 会把根目录下的 `node_modules`
一起复制进缓存，Pi provider 运行时就从这里加载 `pi-ai`。
因此，必须先在仓库里运行 `npm.cmd ci`，再安装或更新插件。

不需要单独执行 build 命令，也不需要打包。
如果 PowerShell 阻止运行 `npm.ps1`，像上面一样改用 `npm.cmd`。

## 4. 本机安装或升级到 v2

### 4.1 生成一个能区分的版本

当前分支和本机已安装的插件版本都是 `0.4.0`。
Claude Code 用版本号判断插件是否需要更新。版本号不变时，`plugin update` 可能保留旧缓存。
所以第一次安装 v2 前，先用仓库自带的脚本生成一个预发布版本：

```powershell
npm.cmd run release -- 0.4.1-pi.1 --summary 'Multi-provider v2 preview: DeepSeek, GLM and Strata via Pi'
npm.cmd run check
npm.cmd run test:mod
```

`0.4.1-pi.1` 只是示例，选择时必须比当时的仓库版本高。
脚本会同步 package、lockfile、marketplace、各插件 manifest、core 依赖约束和 CHANGELOG，
不要手动修改任何一处版本号。以后每次重新安装，都换一个新版本，例如 `0.4.1-pi.2`。

Windows 上的 `npm.cmd run check` 已知有 1 个失败用例：
`test/unit/native-cursor-settings.test.ts:213`（EUNSAFEARG）。
这是 Windows 平台的已知例外，与 v2 无关。
其余用例应该全部通过，并且输出中不应出现 `DEP0190`。

### 4.2 指向本地来源

如果 marketplace 已经指向 `F:/cc-multi-cli-plugin`，跳过这一步。
如果它还指向上游或其他来源，按 [Usage 文档第 2 节](installation-usage-correctness.md#2-安装前准备)
备份设置文件，然后把 `cc-multi-cli-plugin.source` 改为：

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

如果是从没注册过这个 marketplace 的新环境，可以直接执行：

```powershell
claude.exe plugin marketplace add 'F:/cc-multi-cli-plugin' --scope user
```

### 4.3 安装或更新插件

以下为 **PowerShell 命令**：

```powershell
claude.exe plugin marketplace update cc-multi-cli-plugin
claude.exe plugin update multi-core@cc-multi-cli-plugin --scope user
claude.exe plugin update multi-openai@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-pi@cc-multi-cli-plugin --scope user
```

如果是第一次安装 core，把第二行换成
`claude.exe plugin install multi-core@cc-multi-cli-plugin --scope user`。
启动器只使用 `user` scope 的 core，所以不要把 core 只装在 project 或 local scope。
其他 provider（Cursor、Zen、Antigravity、Grok）按需安装，参见 Usage 文档第 3.2 节。

### 4.4 重载和 setup

先在准备使用的 **Windows PowerShell 终端** 里传入 profile 路径，再从这个终端启动 Claude Code：

```powershell
$env:PROFILE = $PROFILE
claude.exe
```

然后在 **Claude Code 会话内**执行：

```text
/reload-plugins
/multi-core:setup --command claude-multi
```

**从 0.4.0（包括 Usage 分支）升级时，必须重跑 setup。**
setup 会把安装器文件复制到 `~/.local/share/multi-cli/`，启动 `claude-multi` 时用的就是这些副本。
v2 修改了其中的 `plugins.ts` 和 `installation.ts`：旧副本不认识 `pi` 插件，也不会在探测插件列表时隔离密钥。
不重跑 setup，即使插件已经更新，启动器也不会启用 Pi provider。

也可以不进 Claude Code，直接在 PowerShell 中运行新缓存里的 setup，效果相同：

```powershell
$env:PROFILE = $PROFILE
$v2CoreRoot = (claude.exe plugin list --json | ConvertFrom-Json |
    Where-Object { $_.id -eq 'multi-core@cc-multi-cli-plugin' -and $_.scope -eq 'user' }).installPath
node "$v2CoreRoot/plugins/multi-core/src/setup.ts"
multi.cmd status
```

不带参数重跑 setup 会沿用之前的命令名和模型选择。
`multi status` 的输出中，`core` 应指向新版本缓存，`providers` 应包含 `pi`。
传入 `$env:PROFILE` 是绕开当前安装器 profile 路径缺陷的临时办法，原因见 Usage 文档第 3.4 节。

## 5. 配置凭据

Pi provider 没有 `/multi-pi:connect` 这类交互式命令。
凭据有两个来源，只在启动 `claude-multi` 时读取一次，之后修改需要重新启动：

1. **启动终端里的环境变量**（优先）。
2. **Pi 配置**：环境变量没设置或为空时使用，见第 5.1 节。已经在 Pi 里配好密钥的话，可以什么都不设置。

| Provider | 必需变量 | 可选变量 | 上游 |
| --- | --- | --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` | — | DeepSeek 官方 API |
| `zai` | `ZAI_API_KEY` | — | `https://api.z.ai` 国际版 coding-plan 端点 |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | — | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `strata` | `MULTI_STRATA_BASE_URL` | `STRATA_API_KEY` | 自己部署的 OpenAI 兼容服务 |
| 所有 Pi provider | — | `MULTI_PI_MODELS` | 只能缩小内置模型列表，不能新增 |

每个变量只启用对应的那一个 provider，用哪个就设置哪个。
两个 Z.AI 端点都是 coding-plan 端点，不是按量付费的 API。

推荐在当前终端中用不回显的方式输入密钥（PowerShell 5.1 可用）：

```powershell
$deepseekKey = Read-Host 'DeepSeek API key' -AsSecureString
$env:DEEPSEEK_API_KEY = [System.Net.NetworkCredential]::new('', $deepseekKey).Password
Remove-Variable deepseekKey

$glmKey = Read-Host 'GLM Coding CN API key' -AsSecureString
$env:ZAI_CODING_CN_API_KEY = [System.Net.NetworkCredential]::new('', $glmKey).Password
Remove-Variable glmKey

claude-multi
```

这些变量只在当前终端和它启动的子进程中有效。
如果想在每个新终端都自动生效，可以把变量写入用户环境变量
（`[Environment]::SetEnvironmentVariable(<名称>, <值>, 'User')`）。
注意这样会把密钥以明文存进当前用户的注册表，是否采用请自己权衡。
不要把密钥写进 PowerShell profile、仓库文件、工单或聊天内容中。

Multi 在启动时读取这些变量，然后立即从自己的进程环境中删除。
它们不会传给 provider 子进程、harness 子进程，也不会传给 Claude 的 plugin-list 探测。

### 5.1 从 Pi 配置读取

默认开启。目录是 `PI_CODING_AGENT_DIR`（设置了的话），否则是 `~/.pi/agent`。
只读其中的 `auth.json` 和 `models.json`，不读当前目录下的 `auth.json`。

| Provider | 从哪里取 |
| --- | --- |
| `deepseek` | `auth.json` 中 `deepseek` 条目（`"type": "api_key"`）的 `key`；或 `models.json` 中 `baseUrl` 为 `https://api.deepseek.com` 的条目的 `apiKey` |
| `zai` | `auth.json` 的 `zai` 条目；或 `baseUrl` 为 `https://api.z.ai/api/coding/paas/v4` 的条目 |
| `zai-coding-cn` | `auth.json` 的 `zai-coding-cn` 条目；或 `baseUrl` 为 `https://open.bigmodel.cn/api/coding/paas/v4` 的条目（条目名字随意，例如 `glm-coding`） |
| `strata` | `models.json` 中名为 `strata` 的条目：`apiKey` 作为密钥，`baseUrl` 作为地址 |

规则：

- 环境变量优先。`MULTI_STRATA_BASE_URL` 同样优先于 `strata.baseUrl`。
- `key`、`apiKey` 可以直接写密钥，也可以写一个环境变量名（和 Pi 一样）；被引用的变量会从进程环境中删除。
- `!命令` 写法不支持，启动会报错，命令不会被执行。
- 同一个 provider 找到两个不同的密钥时启动报错；设置对应的环境变量即可指定用哪个。
- 其他条目（例如 `minimax`）和 OAuth 条目会被忽略。
- 启动时会在终端打印一行 `Multi: credentials from Pi config (...): <provider 列表>.`，只列出来源，不显示密钥。
- 不想让 Multi 读取 Pi 配置：在启动终端设置 `$env:MULTI_PI_CONFIG = '0'`。

注意：如果 `models.json` 里 `strata.baseUrl` 的端口和实际服务不一致（例如配置写的是 8080，服务实际在 47831），
请在启动终端设置 `$env:MULTI_STRATA_BASE_URL = 'http://127.0.0.1:47831/v1'` 覆盖，或者改正 `models.json`。

## 6. 模型、路由与 effort

| Provider | Worker | 路由示例 | 精选模型 |
| --- | --- | --- | --- |
| `deepseek` | `multi-deepseek` | `multi/deepseek/deepseek-flash` | `deepseek-v4-pro`、`deepseek-flash` |
| `zai` | `multi-zai` | `multi/zai/glm-5.3` | `glm-5.3`、`glm-5.2` |
| `zai-coding-cn` | `multi-zai-coding-cn` | `multi/zai-coding-cn/glm-5.3-flash` | `glm-5.3`、`glm-5.3-flash` |
| `strata` | `multi-strata` | `multi/strata/qwen3.8-flash-next` | `qwen3.8-flash-next` |

只要对应 provider 已启用，`/model` 默认会列出两个 DeepSeek 模型和四个 GLM 模型。
设置了 `MULTI_STRATA_BASE_URL` 后，还会列出 Strata。
需要调整列表时，用 `/multi-core:setup --models ...`，或在单次启动时设置 `MULTI_MODELS`。
例如 `MULTI_MODELS=all` 会列出所有已连接 provider 的全部模型。

在 Agent 工具中，用 worker 类型（例如 `multi-zai-coding-cn`）加上 `model` 参数选模型。
`model` 可以写短 ID（`glm-5.3`），也可以写完整路由。
不在当前模型列表里的模型会被拒绝。

### effort 规则

- 可接受的取值是 `low`、`medium`、`high`、`xhigh`、`max`。
- 模型不支持请求的级别时，改用最接近的受支持级别；距离相同时取较高的一级。
- 级别被改动时，每个响应只提示一次。
- GLM 四个模型的对应关系：`medium` 变成 `high`，`xhigh` 变成 `max`。`zai/glm-5.2` 的 `low` 也会变成 `high`。
- DeepSeek 默认使用 `high`。
- Strata 不支持 effort。请求中带有 effort 时会被丢弃，并提示一次。
- `off` 不是可接受的取值。要关闭推理，用 `thinking: disabled`。

## 7. 部署 Strata 本地服务

Strata 适合连接自己部署的 OpenAI 兼容推理服务，例如本机的 llama.cpp 或 vLLM。

1. 启动服务，确认 `/models` 能返回数据：

   ```powershell
   Invoke-RestMethod -Uri 'http://127.0.0.1:47831/v1/models' | ConvertTo-Json -Depth 4
   ```

   如果服务要求密钥，加上 `-Headers @{ Authorization = "Bearer $env:STRATA_API_KEY" }`。
   端口 `47831` 只是本机示例，请换成实际端口。

2. 在启动 `claude-multi` 的终端中设置：

   ```powershell
   $env:MULTI_STRATA_BASE_URL = 'http://127.0.0.1:47831/v1'
   claude-multi
   ```

URL 规则：

- 必须是 HTTPS。只有 loopback 地址（`localhost`、`127.0.0.0/8`、`[::1]`）可以使用 HTTP。
- URL 中不能带用户名或密码。
- URL 非法时，启动直接失败。错误信息不会显示 URL、查询参数或密钥。

密钥规则：

- 非 loopback 地址必须设置 `STRATA_API_KEY`。
- loopback 地址可以不设置。不设置时，请求使用一个占位凭据。
- 只要设置了有效的 `STRATA_API_KEY`，即使是 loopback 地址，也会使用这个真实密钥。

模型名解析：

- 每次请求前，Multi 用和聊天请求相同的凭据调用 `GET <base>/models`，超时 5 秒，结果不缓存。
- 如果列表里有 `qwen3.8-flash-next`，就用它。
- 否则，如果列表里只有一个模型，就用那一个。例如本机服务只加载了 `unsloth-ud-iq4_xs`。
- 列表为空、有多个模型、响应格式错误或超时，请求都会明确报错。
- 实际模型名只用于发给服务器的请求。界面、用量记录和报告里一律显示 `qwen3.8-flash-next`。

## 8. 验证安装

### 8.1 核对来源、版本和缓存内容

```powershell
$v2Installed = claude.exe plugin list --json | ConvertFrom-Json
$v2Installed |
    Where-Object { $_.id -like '*@cc-multi-cli-plugin' } |
    Select-Object id, version, scope, enabled, installPath

$v2Core = $v2Installed |
    Where-Object { $_.id -eq 'multi-core@cc-multi-cli-plugin' -and $_.scope -eq 'user' }
Test-Path -LiteralPath (Join-Path $v2Core.installPath 'plugins/multi-pi/src/backend.ts')
Test-Path -LiteralPath (Join-Path $v2Core.installPath 'plugins/multi-core/src/gateway/provider-registry.ts')
Test-Path -LiteralPath (Join-Path $v2Core.installPath 'node_modules/@earendil-works/pi-ai/package.json')
```

检查以下几点：

- `multi-core` 和 `multi-pi` 都已启用，scope 为 `user`，版本是第 4.1 节生成的新版本。
- 三条 `Test-Path` 都返回 `True`。

还可以比较关键源码的哈希，两者应该相同：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'F:/cc-multi-cli-plugin/plugins/multi-pi/src/backend.ts'
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $v2Core.installPath 'plugins/multi-pi/src/backend.ts')
```

### 8.2 会话内检查（不调用模型）

先设置好第 5 节的变量，在同一个终端中启动 `claude-multi`，然后执行：

```text
/model
```

检查以下几点：

- 已设置密钥的 provider 都出现在列表中。
- 没有设置变量的 provider 不出现。
- 只设置了 `STRATA_API_KEY`、没有设置 `MULTI_STRATA_BASE_URL` 时，Strata 不出现。

`multi status` 只显示安装和启用状态，不验证密钥是否有效，也不会调用模型。

### 8.3 离线检查

在仓库中运行 `npm.cmd run check` 和 `npm.cmd run test:mod`，结果判断见第 4.1 节。
这两项检查不需要任何密钥，也不会联网调用 provider。

### 8.4 联网检查（可选，会产生费用）

这些检查会真实调用上游，可能产生费用，因此不包含在 `npm run check` 中。
每个脚本最多发 10 次上游请求。
运行前在当前终端设置好对应的变量：

| 命令 | 覆盖内容 | 需要的变量 |
| --- | --- | --- |
| `npm.cmd run test:live:pi` | DeepSeek 工具调用、thinking、用量 | `DEEPSEEK_API_KEY` |
| `npm.cmd run test:live:pi:glm` | GLM Coding CN 工具调用、thinking、用量（effort `high`） | `ZAI_CODING_CN_API_KEY` |
| `npm.cmd run test:live:pi:strata` | Strata 工具调用和用量（不测 thinking） | `MULTI_STRATA_BASE_URL`；loopback 下 `STRATA_API_KEY` 可选 |
| `npm.cmd run test:live:install` | 在临时目录中走一遍插件安装 | 无 |

脚本会打印报告的路径。报告中 `status` 为 `passed`，且 `upstreamRequests` 不超过 10，就表示通过。
国际版 `zai` 端点目前只有离线测试覆盖，没有对应的联网脚本。

## 9. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `The multi-pi plugin (provider deepseek) is not enabled for this session.` | 没有安装或启用 `multi-pi`，但请求了它的模型 | 按第 4.3 节安装，然后重启 `claude-multi` |
| `Unknown provider "xxx".`（HTTP 400） | 路由中的 provider 写错了 | 改用第 6 节表格中的 provider ID |
| `/model` 里没有 DeepSeek 或 GLM | 变量没有设置在启动 `claude-multi` 的终端里，或设置后没有重启 | 在同一个终端设置后重新启动；可以用 `Test-Path Env:DEEPSEEK_API_KEY` 检查，不要打印变量的值 |
| 启动失败：`MULTI_PI_MODELS contains unknown model IDs: ...` | 填写了内置列表之外的模型 | 只填写报错中列出的 Allowed IDs |
| `Strata base URL is invalid.` / `must not contain credentials.` / `must use HTTPS or HTTP on loopback.` | URL 不符合第 7 节的规则 | 改为 HTTPS 或 loopback HTTP，并去掉 URL 中的用户名和密码 |
| `Strata requires STRATA_API_KEY for a non-loopback base URL.` | 远程地址没有设置密钥 | 设置 `STRATA_API_KEY` |
| `Strata /models returned N models; expected exactly one or qwen3.8-flash-next.` | 服务器同时加载了多个模型 | 只加载一个模型，或者让服务器以 `qwen3.8-flash-next` 的名字提供模型 |
| `Strata /models returned HTTP ...` / `request failed` / `invalid JSON` | 服务没有启动、端口错误、鉴权失败或超时 | 先用第 7 节的 `Invoke-RestMethod` 单独测试 |
| Auto 模式提示 `no auto mode: actions run unreviewed` | Pi provider 没有审查器，这是设计如此 | 需要审查时改用 Plan 模式，或者选择 OpenAI 模型 |
| 更新后仍然没有 Pi provider | 版本号没有变化，缓存还是旧快照；或者没有先运行 `npm.cmd ci`；或者没有重跑 setup，`multi status` 的 `providers` 中没有 `pi` | 按第 4.1 节生成新版本，再按第 4.3 节更新、按第 4.4 节重跑 setup，然后按第 8.1 节核对 |
| 启动失败：`Pi config: <provider> has more than one different credential (...)` | Pi 配置里同一个 provider 有两个不同的密钥 | 设置该 provider 的环境变量指定用哪个，或删掉 Pi 配置中多余的条目 |
| 启动失败：`Pi config: models.json: cannot be parsed as JSON.` / `has an unexpected structure.` / `command values (!command) are not supported.` | Pi 配置文件损坏、结构不对，或用了 `!命令` 写法 | 修正该文件；暂时不想处理时设置 `$env:MULTI_PI_CONFIG = '0'` |
| 用的不是想要的密钥 | 环境变量没设置，Multi 用了 Pi 配置中的密钥 | 看启动时打印的 `credentials from Pi config` 行；设置环境变量即可覆盖 |
| HTTP 403 认证失败 | 密钥无效，或账户没有开通对应套餐 | 按报错中的凭据提示检查；GLM 需要 coding-plan 账户 |

## 10. 分发到其他设备（可选）

只有在需要让其他设备安装 v2 时，才需要这一节。
v2 只在 fork 的 `feature/multi-provider-v2` 分支上，不合并到 `main`。
本地 `main` 只用来跟踪上游 `greenpolo/cc-multi-cli-plugin`。

### 10.1 在本机推送分支

以下为**本机终端命令**：

```powershell
git status --short
git push -u origin feature/multi-provider-v2
git ls-remote --heads origin feature/multi-provider-v2
```

推送前先确认以下几点：
- 提交里没有密钥。
- 提交里没有根目录的 `{}`、`test/test.html`、`_tickets/`、`.claude/agents/` 或本机临时文件。
- 推送后，提交的作者邮箱会公开。

### 10.2 方法 A：克隆后从本地目录安装（推荐）

这和本机的安装方式一致，已经验证可用。
以下为**另一台设备上的 PowerShell 命令**，目录 `D:/cc-multi-cli-plugin` 可以换成任意路径：

```powershell
git clone -b feature/multi-provider-v2 https://github.com/leedrin/cc-multi-cli-plugin.git D:/cc-multi-cli-plugin
Set-Location D:/cc-multi-cli-plugin
npm.cmd ci
Test-Path -LiteralPath 'node_modules/@earendil-works/pi-ai/package.json'   # 必须返回 True
claude.exe plugin marketplace add 'D:/cc-multi-cli-plugin' --scope user
claude.exe plugin install multi-pi@cc-multi-cli-plugin --scope user
claude.exe plugin install multi-openai@cc-multi-cli-plugin --scope user   # 按需安装
```

必须先运行 `npm.cmd ci`，再安装插件。原因见第 3 节：安装时 Claude Code 会把仓库里的
`node_modules` 一起复制进插件缓存，Pi provider 运行时从缓存加载 `pi-ai`。

然后按第 4.4 节传入 `$env:PROFILE`，启动 Claude Code，在会话内执行：

```text
/reload-plugins
/multi-core:setup --command claude-multi
```

### 10.3 方法 B：直接从 GitHub 安装

在另一台设备的 **Claude Code 会话内**执行：

```text
/plugin marketplace add leedrin/cc-multi-cli-plugin#feature/multi-provider-v2
/plugin install multi-pi@cc-multi-cli-plugin
/reload-plugins
/multi-core:setup --command claude-multi
```

如果那台设备上已经有同名 marketplace，先按 Usage 文档第 2 节换源，
并在来源设置中写上 `"ref": "feature/multi-provider-v2"`。

**这种方式还没有验证过。** `node_modules` 不在 git 里。
如果 Claude Code 从 GitHub 安装时没有安装依赖，缓存里就没有 `pi-ai`，Pi provider 无法使用。
所以装完后一定要按第 8.1 节运行三条 `Test-Path`。
`node_modules/@earendil-works/pi-ai/package.json` 返回 `False` 时，先卸载，再改用方法 A。

### 10.4 每台设备都要单独准备

- **Node**：24.12 或更新版本。
- **凭据**：在那台设备上准备 `~/.pi/agent/auth.json` 和 `models.json`（见第 5.1 节），或者设置第 5 节的环境变量。不要把密钥提交进仓库，也不要通过 git 传过去。
- **Strata**：那台设备要自己按第 7 节运行 Strata 服务。
  - 先启动 Strata，再启动 `claude-multi`。否则 Strata 请求会返回 502 `Strata /models request failed`。
  - 端口和 `models.json` 里 `strata.baseUrl` 不一致时，用 `MULTI_STRATA_BASE_URL` 覆盖。
- **其他 provider**：Codex、Cursor 等需要在那台设备上各自登录。
- **验证**：按第 8 节检查。

### 10.5 以后更新

1. 在本机按第 4.1 节生成新版本，例如 `npm.cmd run release -- 0.4.1-pi.3`，然后提交并推送分支。
2. 在其他设备上更新：
   - 方法 A：先在克隆目录里运行 `git pull` 和 `npm.cmd ci`，然后运行 `claude.exe plugin marketplace update cc-multi-cli-plugin`，再对每个已安装的插件运行 `claude.exe plugin update <插件>@cc-multi-cli-plugin --scope user`。
   - 方法 B：直接运行上面两条 `marketplace update` 和 `plugin update` 命令。
3. 两种方法最后都要按第 4.4 节重跑 setup。

## 11. 回滚与卸载

- **只停用 Pi provider**：清除对应的环境变量后重启 `claude-multi`。
  或者执行 `claude.exe plugin disable multi-pi@cc-multi-cli-plugin --scope user`。
- **回到 Usage 分支**：切回 `Usage-Correctness` 分支，运行 `npm.cmd ci`，
  用发布脚本生成一个比当前已安装版本更高的版本，然后按第 4.3 节更新 core 和 provider。
  不要用 `marketplace remove` 换源，原因见 Usage 文档第 2 节。
- **完全卸载**：先执行 `multi uninstall`，再通过 `/plugin` 删除各个插件。
  provider 的登录信息会保留。环境变量中的密钥需要自己清除。

## 12. 本指南的验证记录与边界

- 2026-11-07，在本机分支 `7d804db` 上：
  - `npm run check`：1026 个用例通过，1 个失败（第 4.1 节所述的 Windows 已知例外），没有 `DEP0190` 警告。
  - `npm run test:mod`：125 个用例通过。
- 离线隔离测试：删除所有密钥变量，并阻止访问非 loopback 地址，Pi 相关的 129 个用例全部通过。
- 联网验收（2026-11-07）：DeepSeek（`deepseek-flash`，2 次上游请求）、GLM `zai-coding-cn` 和本机 Strata 都通过。
  结果记录在详细设计文档第 17.1 节。
- 2026-11-07 本机按第 4 节完成了升级（Claude Code `2.1.319`，Node `24.22.1`）：
  - 依赖与 lockfile 一致，`pi-ai@1.4.0` 已在 `node_modules` 中，因此没有重跑 `npm.cmd ci`。
  - 发布脚本把版本改为 `0.4.1-pi.1`。之后 `npm run check` 为 1026 通过、1 个已知例外失败，`DEP0190` 为 0；`npm run test:mod` 为 125 通过。
  - `multi-core`、`multi-openai` 从 `0.4.0` 更新到 `0.4.1-pi.1`，新装 `multi-pi`，三者都是 `user` scope。
  - 新缓存位于 `~/.claude/plugins/cache/cc-multi-cli-plugin/`，不再使用 Orca profile 下的旧缓存。
  - 第 8.1 节的三条 `Test-Path` 都为 `True`，源码哈希一致。
  - 第一次升级时发现 setup 复制的安装器文件是旧版本，因此补写了第 4.4 节的“必须重跑 setup”。重跑后四个安装器文件与仓库一致，`multi status` 显示 `providers: openai, pi`。
  - 版本号改动尚未提交。
- 第 8.2 节的 `/model` 检查需要在新终端中输入密钥，留给用户执行。
- 分支还没有推送到 GitHub，第 10 节的远程安装尚未验证。

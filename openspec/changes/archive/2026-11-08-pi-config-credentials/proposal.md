# Proposal

## Why

使用 Pi 的用户已经在 `~/.pi/agent/auth.json` 和 `models.json` 里存了 DeepSeek、GLM、Strata 的密钥。按现行规定，Multi 只从环境变量读取这些密钥，用户只能把同一份密钥再设置一遍，或者自己写脚本转成环境变量。维护者决定放宽这条规定：让 Multi 直接读取 Pi 配置，作为环境变量之外的第二个凭据来源。

## What Changes

- **BREAKING（规定变更）**：provider-credentials 中“Multi MUST NOT 读取 `~/.pi/agent/auth.json`、`models.json`”一条改为：环境变量优先；环境变量没有提供时，从 Pi 配置读取。
- 默认开启。`MULTI_PI_CONFIG=0` 关闭，关闭后的行为与现在完全一致。
- 配置目录默认为 `~/.pi/agent`，设置了 `PI_CODING_AGENT_DIR` 时用它指向的目录。
- 来源与映射：
  - `auth.json` 中以 Pi provider ID（`deepseek`、`zai`、`zai-coding-cn`）为键、`type` 为 `api_key` 的条目，取 `key` 字段。
  - `models.json` 的 `providers` 按 `baseUrl` 对应：与某个内置 provider 的上游地址一致的条目，归属于该 provider。名为 `strata` 的条目对应 Strata，其 `apiKey` 和 `baseUrl` 都会读取，但 `MULTI_STRATA_BASE_URL` 仍然优先。
  - 同一个 provider 匹配到多个取值不同的候选时，启动报错，并指出是哪个 provider 有歧义。
- `apiKey`、`key` 的写法：
  - 支持直接写的密钥，也支持写环境变量名（引用的变量存在时取它的值）。
  - 被引用的变量与密钥变量一样，会从进程环境中删除。
  - `!命令` 写法明确报错，不执行。
- Pi 配置文件不存在时静默跳过。文件格式错误时报错，错误信息不包含密钥或 URL 的敏感部分。
- `multi-pi` 未启用、或开关关闭时，不读取 Pi 文件，也不加载 `pi-ai`。
- 同步更新 AGENTS.md、docs/pi.md、docs/installation-multi-provider-v2.md、CHANGELOG，以及原先断言“不读 Pi 文件”的测试。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `provider-credentials`：凭据来源从“只读环境变量”改为“环境变量优先，其次 Pi 配置”。新增以下要求：Pi 配置的开关和目录、provider 映射与歧义处理、`apiKey` 写法、引用变量的清除、文件错误的处理。

## Impact

- 代码：
  - 在 `plugins/multi-pi/src/` 新增 Pi 配置读取模块，只用 Node 内置 `fs` 读 JSON，不引入依赖。
  - `plugins/multi-core/src/launcher.ts` 在 `takeProviderCredentials` 之后合并 Pi 配置得到的凭据，并把解析出的 Strata 地址传给 discovery 和运行时。不写回 `process.env`。
- 测试：
  - 新增 Pi 配置读取的单元测试，覆盖映射、优先级、开关、目录覆盖、歧义、`!命令`、引用变量、文件缺失和格式错误，并用金丝雀密钥检查泄漏。
  - 调整 `test/unit/native-pi-backend.test.ts` 等原有测试：`pi-ai` 后端本身仍然不读 Pi 文件；改为断言“只有 launcher 在开关打开时读取”。
- 文档：AGENTS.md 中的执行契约、docs/pi.md、安装文档第 5 节、CHANGELOG `## Unreleased`。
- 安全：读取 Pi 文件不会执行其中的命令；密钥仍然只在内存中传递，不进入子进程、日志或错误信息。

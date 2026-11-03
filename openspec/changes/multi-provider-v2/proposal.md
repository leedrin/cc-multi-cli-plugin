## Why

维护者的目标是“v2 落地后接入 Pi，再通过 Pi 接入 GLM 和 DeepSeek”。现在 provider 名单写死在十几个文件里（`provider.ts`、`provider-workers.ts`、`worker-catalog.ts`、`server.ts`、`launcher.ts`、install 列表、hooks 等），新增一个 provider 就要改 gateway 核心，未知的 `multi/<p>/...` 还会被静默发给 OpenAI。不先把这些收成一处，就分不清接 Pi 时出的问题来自 Pi 还是来自重构。

完整的已批准设计见 `docs/cc-multi-cli-plugin_multi-provider-v2_detailed-design.md`（v1.1，2026-11-03 批准，下称“详细设计”）。

## What Changes

- 新增分层模型路由 `multi/<provider>/<encoded-id>[/<cursor-params>][[1m]]`，所有路由解析改用同一个编解码。现有 `multi/openai|zen|cursor/...` 路由和已保存的选择保持不变。
- 新增 provider 事实表和 Registry，作为 provider 名单的唯一来源。picker、worker、usage reader、review 策略、签名前缀和插件启用都从这里派生。
- Direct 执行契约改为 `prepare` 加 `PreparedRequest.open`，后端可以是 HTTP，也可以是事件流。gateway 核心不再 import 任何 provider 模块，收尾和终止事件仍只由 `server.ts` 发出。
- 新增 `multi-pi` 插件，经 `@earendil-works/pi-ai@1.4.0`（精确 pin）以 Direct 方式接入 `deepseek`、`zai`、`zai-coding-cn`，并用 `createProvider` 接入维护者本地的 Strata 服务。tool loop 仍由 Claude Code 执行。
- Pi provider 的凭据只从环境变量读取，读出后从 `process.env` 删除。Multi 不读写 `~/.pi/agent/*`。
- Pi 的 usage 从原始 chunk 构建 canonical usage，缺失的数据记为 `unavailable`，不记为 0。
- 新增 `MULTI_PI_MODELS`。Pi provider 使用严格白名单，`MULTI_MODELS` 不能扩大这个范围。
- 新增 `npm run test:live:pi`，只在用户批准后运行，按上游调用次数设预算。
- **BREAKING**：`multi/<unknown>/...` 以前被静默路由到 OpenAI，现在返回 BadRequest。
- **BREAKING**（仅内部类型）：`GatewayEvent.route` 和 `PreparedRequest.route` 从联合类型放宽为 `string`。

## Capabilities

### New Capabilities

- `model-routing`：模型路由语法、编码与解码、旧路由兼容、未知或未启用 provider 的报错。
- `provider-registry`：provider 事实表和 Registry、注册校验，以及从 Registry 派生的 picker、worker、启用和 review 策略。
- `direct-provider-execution`：Direct provider 的打开、失败映射、流式转换契约，以及只由 server 收尾的规则。
- `provider-credentials`：Direct provider 凭据的来源、读取后从环境中删除、子进程隔离、不读 Pi 文件、环境回退的处理。
- `pi-provider-catalog`：Pi provider 的启用、严格白名单、`MULTI_PI_MODELS`、effort 规则，以及 Strata 的地址、密钥和模型。
- `pi-message-translation`：Anthropic Messages 与 Pi 之间的请求和流转换，包括工具名别名、thinking 签名往返、块重排、`argumentsError`、停止原因、错误和中止。
- `pi-provider-usage`：从 Pi 的原始 chunk 构建 canonical usage，以及 Dashboard 中 Pi provider 的配额行。
- `multi-provider-verification`：v2 基线快照、先行验证、离线 fixture 要求，以及 live 探测预算与“未完成”的判定。

### Modified Capabilities

- `usage-compatibility`：“补丁层边界”要求原本禁止引入 Registry、ModelIdentity、Pi AI 等。v2 按该要求中“Multi-Provider v2 可吸收它”的条款修改：这些禁止项只约束已归档的 usage 补丁层，v2 可以引入，但不得让 usage 的既有要求回退，也不得反向让 usage-accounting 依赖 Registry。

## Impact

- **gateway**：新增 `gw/model-identity.ts`、`gw/provider-facts.ts`、`gw/provider-registry.ts`；修改 `gw/provider.ts`、`provider-workers.ts`、`provider-request.ts`、`provider-usage.ts`、`worker-catalog.ts`、`server.ts`（`handleHosted` 改为 `handleDirect`，删除按名字段）。
- **launcher / install**：`core/launcher.ts`（发现、worker、picker、环境）、`core/install/plugins.ts`、`bootstrap.ts`、`core/account.ts`、`.claude-plugin/marketplace.json`、`scripts/versioning.ts`。
- **现有 provider**：Zen 和 OpenAI 的请求包进 `httpUpstream`；Cursor 和 Zen 的路由解析改用统一的解码。断言不变。
- **hooks**：`hooks/provider.ts`、`workers.ts`、`worker-rows.ts` 改用事实表和统一的解码，通过 Claude Mods function hooks 修改，不增加 `/multi/mod/*` 路由。
- **新插件**：`plugins/multi-pi/`。
- **依赖**：根 `package.json` 增加 `"@earendil-works/pi-ai": "1.4.0"` 及其传递依赖，所有用户的磁盘占用都会增加。
- **文档**：`AGENTS.md`、`ARCHITECTURE.md`、`README.md`、新增 `docs/pi.md`，以及 `docs/platform-support.md`、`permissions.md`、`installation.md`、`CHANGELOG.md`。PRD 按详细设计 §23 修订。
- **测试**：新增离线 fixture 与单测；`npm run test:mod`；新增 `test:live:pi`（需用户批准）。

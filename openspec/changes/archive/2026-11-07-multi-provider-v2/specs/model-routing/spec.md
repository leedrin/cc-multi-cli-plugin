## Purpose

规定 Multi 模型路由字符串的语法、编码与解码规则，以及 gateway 遇到未知或未启用的 provider 时的行为，让所有组件对同一个路由得出同一个结果。

## ADDED Requirements

### Requirement: 分层路由语法
Multi 模型路由 SHALL 采用 `multi/<provider>/<encoded-id>[/<cursor-params>][[1m]]`。`<provider>` SHALL 匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，并且 MUST NOT 是保留 ID `core`。`<encoded-id>` SHALL 是 `encodeURIComponent(modelId)`。`<cursor-params>` 只属于 Cursor 预设。`[1m]` SHALL 位于编码之外。

#### Scenario: 连字符 provider 和嵌套模型 ID
- **WHEN** 对 provider `zai-coding-cn`、模型 `org/model@v1` 编码
- **THEN** 路由 SHALL 为 `multi/zai-coding-cn/org%2Fmodel%40v1`

#### Scenario: 非法路由被拒绝
- **WHEN** 解码 `multi//x`、`multi/core/x`、含大写字母的 provider，或长度超过 64 的 provider
- **THEN** 解码 SHALL 返回无结果

#### Scenario: 1M 标签保留在编码之外
- **WHEN** 解码 `multi/openai/gpt-x[1m]`
- **THEN** 结果 SHALL 标记一百万上下文，模型 ID SHALL 为 `gpt-x`，`[1m]` 不属于模型 ID

### Requirement: 编码往返恒等
对任意合法 provider 和模型 ID，先编码再解码 SHALL 得到原来的 provider 和模型 ID。先解码再编码不要求恒等，因为 Cursor 预设段可能含原始字符。

#### Scenario: 往返
- **WHEN** 对 `deepseek` 与 `deepseek-v4-pro`、带 `/` 和 `@` 的模型 ID 分别编码再解码
- **THEN** 结果 SHALL 与输入一致

### Requirement: 旧路由兼容
已存在的 `multi/openai/...`、`multi/zen/...`、`multi/cursor/...`（含 Cursor 预设）路由和已保存的模型选择，解析结果 SHALL 与变更前一致。所有解析模型路由的组件（gateway、launcher、worker catalog、Cursor、Zen、hooks）SHALL 使用同一套解码规则。

#### Scenario: Cursor 预设仍被识别
- **WHEN** 解析带预设段的 Cursor 路由
- **THEN** 结果 SHALL 带预设，worker 目录 SHALL 按变更前的方式排除它

#### Scenario: 嵌套模型 ID 不被当成预设
- **WHEN** worker 目录处理模型 ID 为 `anthropic%2Fclaude` 的路由
- **THEN** 它 SHALL 被视为普通模型，不得因解码后含 `/` 而被丢弃

### Requirement: 未知 provider 返回 BadRequest
gateway 收到 `multi/<p>/...`，而 `<p>` 不是已注册的 provider 时，SHALL 返回 BadRequest，MUST NOT 把请求发给任何上游。非 `multi/` 模型仍 SHALL 路由到 Anthropic。

#### Scenario: 未知 provider
- **WHEN** 请求的模型为 `multi/unknown/x`
- **THEN** gateway SHALL 返回 BadRequest，且没有任何上游请求

#### Scenario: 前缀相同的 provider 不混淆
- **WHEN** 请求 `multi/zai/glm-5.3`
- **THEN** 它 SHALL 路由到 `zai`，不得路由到 `zai-coding-cn`

### Requirement: 未启用 provider 明确报错
provider 已注册但其所属插件未启用时，gateway SHALL 返回明确的错误，指出该插件未启用，MUST NOT 回落到其他 provider。是否启用 SHALL 按 provider 所属的插件判断。

#### Scenario: 插件未启用
- **WHEN** 没有启用 `multi-pi`，请求 `multi/deepseek/deepseek-v4-pro`
- **THEN** gateway SHALL 返回指明 `pi` 插件未启用的错误

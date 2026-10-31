# openai-response-usage Specification

## Purpose
TBD - created by archiving change usage-correctness-observability. Update Purpose after archive.

## Requirements

### Requirement: 独立的 OpenAI 响应级 usage 模块
系统 SHALL 在 `plugins/multi-openai/src/response-usage.ts` 中实现 OpenAI Responses 响应级 token usage 的解析与映射,MUST NOT 复用或修改 `plugins/multi-openai/src/usage.ts`(后者职责是 Codex 账户配额 / rate-limit 窗口)。该模块 SHALL 导出 `OpenAIResponsesUsage` 类型、`parseOpenAIResponseUsage`、`openAIProtocolUsage`、`openAIAccountingMetadata`,且不负责 Codex 账户配额、Responses 内容翻译或收据持久化。

#### Scenario: 文件命名不冲突
- **WHEN** 新增响应级 usage 解析
- **THEN** 代码 SHALL 位于 `response-usage.ts`,既有 `usage.ts` 的配额读取行为 SHALL 保持不变

### Requirement: 解析完整的 Responses usage schema
`OpenAIResponsesUsage` SHALL 覆盖 `input_tokens`、`input_tokens_details.cached_tokens`、`input_tokens_details.cache_write_tokens`、`output_tokens`、`output_tokens_details.reasoning_tokens`、`total_tokens`,并接受 `input_tokens_details` 与 `output_tokens_details` 为 `null` 或缺失。`responses.ts` 中的 `ResponsesUsage` SHALL 同步扩展以保留 `output_tokens_details` 与 `total_tokens`。

#### Scenario: 完整 usage
- **WHEN** usage 为 `input_tokens=1000, cached_tokens=800, cache_write_tokens=50, output_tokens=200, reasoning_tokens=120, total_tokens=1200`
- **THEN** canonical 结果 SHALL 为 `source=provider, inputTokens=150, cacheReadTokens=800, cacheWriteTokens=50, outputTokens=200, reasoningTokens=120, totalTokens=1200, cacheReadRatio=0.8`

#### Scenario: details 为 null
- **WHEN** `input_tokens_details` 与 `output_tokens_details` 均为 `null`
- **THEN** 解析 SHALL 接受该输入,cache 与 reasoning 字段保持未知

#### Scenario: reasoning 缺失
- **WHEN** `output_tokens_details.reasoning_tokens` 缺失
- **THEN** `reasoningTokens` SHALL 为 `undefined` 而非 0

### Requirement: Uncached input 与 total 的推导
解析器 SHALL 按 `inputTokens = max(0, input_tokens - cached_tokens - cache_write_tokens)` 推导 uncached input。`totalTokens` SHALL 优先取 provider 的 `total_tokens`;缺失且 raw `input_tokens` 与 `output_tokens` 均已知时取二者之和;否则为未知。

#### Scenario: provider total 优先
- **WHEN** usage 同时含 `total_tokens` 与 input/output
- **THEN** `totalTokens` SHALL 等于 provider 的 `total_tokens`

#### Scenario: 推导 total
- **WHEN** `total_tokens` 缺失,`input_tokens=100`,`output_tokens=40`
- **THEN** `totalTokens` SHALL 为 `140`

#### Scenario: 无法推导 total
- **WHEN** `total_tokens` 缺失且 `output_tokens` 缺失
- **THEN** `totalTokens` SHALL 为 `undefined`

#### Scenario: cached 超过 input 时下限为 0
- **WHEN** `cached_tokens + cache_write_tokens` 大于 `input_tokens`
- **THEN** uncached `inputTokens` SHALL 为 `0` 而非负数

### Requirement: Unavailable 与 malformed 必须区分
当 `usage` 为 `null` 或字段缺失时,解析器 SHALL 返回 `source = "unavailable"`,成功的模型回答 SHALL 照常返回。当 provider 给出非法数值(负数、小数、非有限数、超过安全整数)时,解析器 SHALL 抛出 malformed stream event 错误并使翻译失败。

#### Scenario: usage 为 null
- **WHEN** terminal response 的 `usage` 为 `null`
- **THEN** 结果 SHALL 为 `unavailable`,回答成功返回

#### Scenario: 负数被拒绝
- **WHEN** usage 含 `input_tokens: -2`
- **THEN** 解析 SHALL 抛出 malformed 错误

#### Scenario: 小数被拒绝
- **WHEN** usage 含非整数的 token 计数
- **THEN** 解析 SHALL 抛出 malformed 错误

#### Scenario: 超出安全整数被拒绝
- **WHEN** usage 含超过 `Number.MAX_SAFE_INTEGER` 的计数
- **THEN** 解析 SHALL 抛出 malformed 错误

### Requirement: 部分 usage 标记为 mixed
当 provider 只返回部分核心 telemetry 时,解析器 SHALL 返回 `source = "mixed"` 并保留已知字段。协议 usage SHALL 用占位值满足 schema,但 accounting 中缺失字段 SHALL 保持未知。

#### Scenario: 只有 input 与 cache read
- **WHEN** usage 为 `{ input_tokens: 100, input_tokens_details: { cached_tokens: 40 } }`
- **THEN** canonical SHALL 为 `source=mixed, inputTokens=60, cacheReadTokens=40`,`outputTokens` 未知;协议 usage SHALL 为 `{ input_tokens: 60, output_tokens: 0, cache_read_input_tokens: 40 }`

#### Scenario: 只有 output
- **WHEN** usage 只含 `output_tokens`
- **THEN** `source` SHALL 为 `mixed`,`inputTokens` 未知

### Requirement: ResponseStream 终态输出 accounting
`ResponseStream.finish()` SHALL 调用 `parseOpenAIResponseUsage`,将结果映射为协议 `message.usage`,并写入 `message.multi_usage`:包含 `source`、`accounting`、`model`,以及在已知时同时保留 flat 的 `reasoning_tokens` 与 `total_tokens`(过渡兼容)。`validResponse()` SHALL 校验新增字段(`output_tokens_details`、`reasoning_tokens`、`total_tokens`)的类型与非负安全整数约束。

#### Scenario: 终态写入 accounting
- **WHEN** `response.completed` 携带完整 usage
- **THEN** `result.multi_usage.accounting` SHALL 含 output、cache read/write、reasoning、total,且 `source = "provider"`

#### Scenario: message_delta 携带最终协议 usage
- **WHEN** 流结束
- **THEN** `message_delta.usage` SHALL 为 provider 最终 output 与 cache read/write,而 `message_start` 仍为 provisional 估计

### Requirement: OpenAI 不启用 requireUsage
OpenAI 路径 SHALL 保持 `requireUsage: false`;Zen Responses SHALL 保持 `requireUsage: true` 且行为不意外改变。成功完成但 telemetry 缺失的响应 MUST 返回成功回答并标记 `source = "unavailable"`,MUST NOT 抛出可重试的 provider 错误,MUST NOT 重跑已付费请求。

#### Scenario: OpenAI 缺失 usage 仍成功
- **WHEN** OpenAI terminal event 成功完成但不含 usage
- **THEN** 网关 SHALL 返回完整回答,`multi_usage.source = "unavailable"`,且不发起第二次上游请求

#### Scenario: Zen 保持 requireUsage
- **WHEN** Zen Responses terminal event 缺少 `input_tokens` 或 `output_tokens`
- **THEN** 行为 SHALL 与变更前一致(抛出 "Provider completed without token usage")

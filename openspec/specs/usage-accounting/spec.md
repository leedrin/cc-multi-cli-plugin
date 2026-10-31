# usage-accounting Specification

## Purpose
TBD - created by archiving change usage-correctness-observability. Update Purpose after archive.

## Requirements

### Requirement: Canonical token usage model
网关 SHALL 提供统一的 canonical usage 模型 `CanonicalTokenUsage`,包含 `source`(`provider` | `estimate` | `mixed` | `unavailable`)以及可选的 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`、`cacheReadRatio`。该模型 SHALL 位于 `plugins/multi-core/src/gateway/usage-accounting.ts`,只负责类型、source 合并、累加、cache ratio 与序列化,不负责 provider 专属 JSON 解析、UI 渲染或网络请求。

#### Scenario: 模型只承载 accounting 语义
- **WHEN** 任一 provider 适配层产出 accounting usage
- **THEN** 结果 SHALL 使用 `CanonicalTokenUsage` 字段名,且 `usage-accounting.ts` 不导入任何 provider 专属模块

#### Scenario: 不引入 provider 架构
- **WHEN** 实现 `usage-accounting.ts`
- **THEN** 该模块 SHALL NOT 引入 ProviderRegistry、ProviderDescriptor、DirectProviderAdapter 或任何 provider 分发抽象

### Requirement: Unknown 与 zero 语义固定
`CanonicalTokenUsage` 中字段值 `undefined` SHALL 表示"未知",数值 `0` SHALL 仅表示 provider 明确报告了 0。accounting 层的任何 helper MUST NOT 使用 `value ?? 0` 之类的无条件回退把未知值伪装成 0;仅允许在明确标注的协议兼容边界(`toProtocolUsage`)使用占位 0。

#### Scenario: provider 明确报告 0 保持为已知 0
- **WHEN** provider 返回 `{ "input_tokens": 100, "output_tokens": 0 }`
- **THEN** canonical usage SHALL 为 `source = "provider"`、`inputTokens = 100`、`outputTokens = 0`,且 `outputTokens` 被视为已知值

#### Scenario: 缺失字段不写成 0
- **WHEN** provider 返回的 usage 缺少 `output_tokens`
- **THEN** canonical usage 的 `outputTokens` SHALL 为 `undefined`,序列化后该字段 SHALL 被省略

### Requirement: Usage source 判定规则
系统 SHALL 按以下规则确定 `source`:核心 usage(input 与 output)均由 provider terminal response 明确提供时为 `provider`;provider completion 完全没有 usage 时为 `unavailable`(所有未知计数字段省略);provider 只提供部分核心 telemetry 时为 `mixed`(保留已知字段,缺失字段保持未知);本地或 native harness 估计值为 `estimate`。既有 harness 的 source 语义 SHALL 保持不变。

#### Scenario: 完整核心 usage
- **WHEN** provider 同时报告 input 与 output token
- **THEN** `source` SHALL 为 `provider`

#### Scenario: usage 整体缺失
- **WHEN** provider completion 不含 usage(字段缺失或为 `null`)
- **THEN** `source` SHALL 为 `unavailable`,且 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 均 SHALL 为 `undefined`

#### Scenario: 部分核心 usage
- **WHEN** provider 只报告 `input_tokens` 而缺少 `output_tokens`
- **THEN** `source` SHALL 为 `mixed`,`inputTokens` 保留已知值,`outputTokens` SHALL 为 `undefined`

#### Scenario: harness 估计
- **WHEN** Cursor、Antigravity 或 Grok 只有本地估计
- **THEN** `source` SHALL 为 `estimate`

### Requirement: Source 合并规则
`mergeUsageSource(a, b)` SHALL 实现:相同 source 合并结果不变(`provider+provider=provider`、`estimate+estimate=estimate`、`unavailable+unavailable=unavailable`);不同 source 合并结果为 `mixed`(`provider+estimate`、`provider+unavailable`、`estimate+unavailable`);任一侧为 `mixed` 时结果为 `mixed`。

#### Scenario: 相同 source
- **WHEN** 合并 `provider` 与 `provider`
- **THEN** 结果 SHALL 为 `provider`

#### Scenario: provider 与 unavailable 混合
- **WHEN** 合并 `provider` 与 `unavailable`
- **THEN** 结果 SHALL 为 `mixed`

#### Scenario: mixed 吸收其它 source
- **WHEN** 合并 `mixed` 与任意 source
- **THEN** 结果 SHALL 为 `mixed`

### Requirement: Token-weighted prompt cache read ratio
系统 SHALL 以 `cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)` 计算 token-weighted prompt cache read ratio,其中 `inputTokens` 为 uncached input。当分母为 0、相关字段未知、核心输入 telemetry 不完整或 `source = unavailable` 时,ratio SHALL 为 `undefined`。系统 SHALL 将其称为"Prompt cache read ratio",MUST NOT 称为 request-level cache hit rate。

#### Scenario: 正常计算
- **WHEN** uncached input 为 1,000、cache read 为 8,000、cache write 为 1,000
- **THEN** ratio SHALL 为 `0.8`,显示为 `80.0%`

#### Scenario: 分母为 0
- **WHEN** uncached input、cache read、cache write 均为 0
- **THEN** ratio SHALL 为 `undefined`

#### Scenario: 无缓存
- **WHEN** cache read 与 cache write 均为已知 0 且 uncached input 大于 0
- **THEN** ratio SHALL 为 `0`

#### Scenario: 100% 命中
- **WHEN** uncached input 为 0、cache write 为 0、cache read 大于 0
- **THEN** ratio SHALL 为 `1`

#### Scenario: 输入 telemetry 不完整
- **WHEN** `inputTokens` 未知
- **THEN** ratio SHALL 为 `undefined`

### Requirement: 协议 usage 与 accounting truth 分离
`MessagesResponse.usage` SHALL 继续满足 Anthropic 兼容的数值 schema(`input_tokens`、`output_tokens`、可选 cache 字段);accounting truth SHALL 放在 `MessagesResponse.multi_usage`(含 `source` 与可选 `accounting` 块),下游 UI 与收据 MUST 优先读取 `source`,MUST NOT 把协议兼容占位 0 当作真实统计。`toProtocolUsage(usage)` SHALL 在 provider/mixed 且有已知数据时输出已知值,在 `unavailable` 时仅为满足 schema 输出 `input_tokens: 0`、`output_tokens: 0`,且这两个 0 MUST NOT 进入 accounting truth。

#### Scenario: unavailable 的协议占位
- **WHEN** `source = "unavailable"`
- **THEN** `toProtocolUsage` SHALL 返回 `{ input_tokens: 0, output_tokens: 0 }` 且不含 cache 字段,同时 `multi_usage.accounting` 不得包含这两个 0

#### Scenario: 已知 cache 字段透传
- **WHEN** `cacheReadTokens` 与 `cacheWriteTokens` 均已知
- **THEN** 协议 usage SHALL 含 `cache_read_input_tokens` 与 `cache_creation_input_tokens`

#### Scenario: 未知 cache 字段不输出
- **WHEN** `cacheReadTokens` 未知
- **THEN** 协议 usage SHALL NOT 包含 `cache_read_input_tokens`

### Requirement: Provisional 与 final usage 的生命周期
流式响应 SHALL 显式区分 provisional 与 final usage:`message_start` 携带的 usage 是 provisional 估计值,`message_delta.usage` 才是 final。provisional usage MUST NOT 进入收据或 dashboard 统计。只有 `completionEvent` 携带的 final usage 可进入 ReceiptLedger。

#### Scenario: message_start 是 provisional
- **WHEN** OpenAI 流发出 `message_start`
- **THEN** 其 usage SHALL 为本地估计输入与 `output_tokens = 0`,且不进入 ReceiptLedger

#### Scenario: 只统计 completionEvent
- **WHEN** 一次响应完成并产生 `completionEvent`
- **THEN** 收据统计 SHALL 只使用该事件携带的 final usage

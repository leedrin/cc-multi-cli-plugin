# pi-provider-usage Specification

## Purpose
规定 Pi provider 的 token usage 如何从上游原始数据得出，确保缺失的数据显示为 unavailable 而不是 0，并且 Pi 的目录价不被当成账单。

## Requirements

### Requirement: usage 来自上游原始 chunk
Pi provider 的 canonical usage SHALL 从上游原始 chunk 的 usage 字段构建，以最后一个快照为准，MUST NOT 使用 Pi 自己汇总的 usage（它会把缺失记为 0）。字段对应：输入为 prompt 减去缓存读取，输出为 completion，缓存读取依次取 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cached_tokens`，另有缓存写入、reasoning 和 total。每个请求的模型调用数 SHALL 为 1。

#### Scenario: DeepSeek 缓存命中
- **WHEN** 上游 chunk 的 usage 带 `prompt_cache_hit_tokens`
- **THEN** canonical usage 的缓存读取 SHALL 等于该值，输入 SHALL 为 prompt 减去该值

#### Scenario: usage 在 choice 中
- **WHEN** 上游把 usage 放在 `choices[0].usage`
- **THEN** 系统 SHALL 同样读取它

### Requirement: 缺失的 usage 不记为 0
整个流都没有 usage 时，usage 的 source SHALL 为 `unavailable`，各字段为空，请求 SHALL 照常成功且不重试。上游明确报告 0 时 SHALL 记为 0。部分字段缺失时，source 和取值 SHALL 遵循 `usage-accounting` 的既有规则。

#### Scenario: 没有 usage
- **WHEN** 一次成功的流中没有任何 usage
- **THEN** 收据和 `/multi-usage` SHALL 显示 unavailable，而不是 0

#### Scenario: 明确为 0
- **WHEN** 上游报告 `completion_tokens: 0`
- **THEN** 输出 tokens SHALL 记为 0

### Requirement: 目录价不进入计费
Pi 的 `usage` 汇总和 `cost` MUST NOT 进入 usage 统计、收据或 Dashboard。canonical usage 不增加 cost 字段。

#### Scenario: 目录价为 0 的模型
- **WHEN** 使用一个 Pi 目录价为 0 的模型
- **THEN** 收据中 SHALL 没有来自 Pi 的价格数据

### Requirement: Dashboard 中的 Pi provider
`/multi-usage` SHALL 显示 Pi provider 的会话 tokens。Pi provider 没有配额查询，配额行 SHALL 显示 unavailable 并说明原因。收据与 Dashboard 中的数据 SHALL 一致。

#### Scenario: 打开 Dashboard
- **WHEN** 会话中使用过 DeepSeek 后打开 `/multi-usage`
- **THEN** DeepSeek 一行 SHALL 显示会话 tokens，配额显示 unavailable 和原因

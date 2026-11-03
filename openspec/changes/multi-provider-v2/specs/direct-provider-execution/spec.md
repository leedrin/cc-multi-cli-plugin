## Purpose

规定 Direct provider（由 Claude Code 执行工具的 provider）与 gateway 之间的执行契约：provider 负责打开上游并转换内容，gateway 负责事件、失败映射和唯一的收尾。

## ADDED Requirements

### Requirement: 打开上游的结果
Direct provider 打开上游时 SHALL 返回两种结果之一：失败（带上游状态码和 retry-after），或成功（带一个转换函数）。上游返回非 2xx 状态时 SHALL 返回失败结果，gateway 把它映射为既有的上游失败；401 和 403 SHALL 附带该 provider 的认证帮助。HTTP 后端和事件流后端 SHALL 使用同一契约。

#### Scenario: 上游 401
- **WHEN** 上游对首个请求返回 401
- **THEN** 客户端 SHALL 收到上游失败和该 provider 的认证帮助，且不开始流

#### Scenario: 上游 429
- **WHEN** 上游返回 429 并带 `retry-after`
- **THEN** 失败 SHALL 保留该 `retry-after`

### Requirement: 只有 server 收尾
provider 的转换 SHALL 只发出内容块事件，并返回完整的响应（内容、停止原因和 usage）。`message_delta` 和 `message_stop` SHALL 只由 gateway 的收尾逻辑根据该响应发出，每条流恰好一次。provider 模块 MUST NOT 写 HTTP 回复，也 MUST NOT 发出终止事件。

#### Scenario: 终止事件只出现一次
- **WHEN** 一次 Direct provider 的流式请求成功结束
- **THEN** 整条 SSE 流中 `message_stop` SHALL 只出现一次，且其停止原因和 usage 与 provider 返回的响应一致

#### Scenario: provider 输出不含终止事件
- **WHEN** 单独运行 provider 的转换
- **THEN** 它发出的事件中 SHALL 不含 `message_delta` 和 `message_stop`

### Requirement: 请求准备失败映射为 BadRequest
provider 准备请求时抛出的错误 SHALL 映射为 BadRequest，且不发出上游请求。

#### Scenario: 不支持的字段
- **WHEN** 请求含 provider 不支持的内容（例如 `document` 块）
- **THEN** 客户端 SHALL 收到 BadRequest，且没有上游请求

### Requirement: gateway 核心不依赖 provider 模块
gateway 的 server 模块 MUST NOT import 任何 `plugins/multi-*` 下的 provider 模块。它 SHALL 只通过 Registry 和运行时访问 provider。

#### Scenario: import 检查
- **WHEN** 检查 gateway server 模块的 import
- **THEN** SHALL 不出现 `plugins/multi-*` 下的路径

### Requirement: 既有 Direct provider 行为不变
Zen 和 OpenAI 迁移到新契约后，它们的请求、流输出、错误映射和 usage SHALL 与变更前一致，既有测试的断言 SHALL 不变。

#### Scenario: Zen 与 OpenAI 回归
- **WHEN** 迁移后运行 Zen 和 OpenAI 的既有单测
- **THEN** 全部 SHALL 通过，且断言没有修改

### Requirement: 中止传到上游
客户端断开或请求被中止时，中止信号 SHALL 传到 provider 的上游调用，且每个 `/v1/messages` 请求最多只发出一次上游调用。

#### Scenario: 客户端断开
- **WHEN** 流进行中客户端断开
- **THEN** 上游调用 SHALL 收到中止信号，且不会重发

# pi-message-translation Specification

## Purpose
规定 Anthropic Messages 请求和 Pi 之间的双向转换，让 Claude Code 的工具循环、thinking 往返和流式输出在 Pi provider 上和在其他 Direct provider 上表现一致，并在无法安全转换时明确失败。

## Requirements

### Requirement: 请求内容转换
系统 SHALL 把 `system`、用户文本、base64 图片、`tool_result`、助手的 text、thinking 和 `tool_use` 转成 Pi 的对应内容。`tool_result` SHALL 排在同一轮用户文本之前。模型不支持图片时，含图片的请求 SHALL 返回 BadRequest。`document` 块和非空 `stop_sequences` SHALL 返回 BadRequest。`cache_control` SHALL 被丢弃。相同输入 SHALL 产生字节完全相同的请求。

#### Scenario: document 块
- **WHEN** 请求含 `document` 块
- **THEN** 系统 SHALL 返回 BadRequest，且没有上游请求

#### Scenario: 字节稳定
- **WHEN** 对同一请求转换两次
- **THEN** 两次的上游请求体 SHALL 完全一致

### Requirement: max_tokens 范围
`max_tokens` SHALL 在 1 到模型的最大输出之间，否则返回 BadRequest。未提供时 SHALL 使用 32000 与模型最大输出中较小的值。

#### Scenario: 超出模型上限
- **WHEN** `max_tokens` 大于模型的最大输出
- **THEN** 系统 SHALL 返回 BadRequest

### Requirement: tool_choice 转换
`tool_choice` 的 `auto`、`none`、`any` SHALL 分别转换为 `auto`、`none`、`required`。指定工具时 SHALL 转换为该工具的上游名称，且该工具 SHALL 在本次请求声明的工具中，否则返回 BadRequest。

#### Scenario: 指定未声明的工具
- **WHEN** `tool_choice` 指定的工具不在 `tools` 中
- **THEN** 系统 SHALL 返回 BadRequest

### Requirement: 工具名别名往返
工具名不符合上游的函数名规则（`^[a-zA-Z0-9_-]{1,64}$`）时，系统 SHALL 使用 gateway 已有的确定性别名规则，与其他 Direct provider 一致。别名 SHALL 用于工具声明、历史中的工具调用和工具结果、指定的 `tool_choice` 和 `tool_reference` 文本。响应中的工具名 SHALL 还原为原名。两个原名映射到同一别名时，或响应中出现未知名称时，SHALL 显式失败。

#### Scenario: 长 MCP 工具名
- **WHEN** 一个超过 64 字符的 MCP 工具名依次经历声明、模型调用、历史回放和指定 `tool_choice`
- **THEN** 上游每次都 SHALL 看到同一个合法别名，Claude Code 每次都 SHALL 看到原名

#### Scenario: 响应中出现未知工具名
- **WHEN** 上游返回的工具调用名称不对应任何已声明工具
- **THEN** 请求 SHALL 失败，且不发出该 tool_use

### Requirement: thinking 签名往返
响应中的 thinking 块 SHALL 带有 `multipi:v1:` 前缀的签名，其中记录路由 ID、thinking 文本和 Pi 写回 reasoning 所需的字段名。请求中 SHALL 只还原路由 ID 与当前模型相同的签名，其他模型的 thinking 块 SHALL 被丢弃。回放时，同一模型相邻的 thinking 块 SHALL 合并为一个。

#### Scenario: 同模型往返
- **WHEN** DeepSeek 的 thinking 块在下一轮发回同一模型
- **THEN** 上游请求的助手消息 SHALL 带有原 reasoning 内容

#### Scenario: 换模型
- **WHEN** DeepSeek 的 thinking 块在下一轮发给 `zai` 的模型
- **THEN** 这些 thinking 块 SHALL 被丢弃

### Requirement: 按 delta 生成内容块
流式输出 SHALL 由 thinking 和 text 的 delta 驱动，不依赖 Pi 的块开始和结束事件。同一时刻 SHALL 只开一个内容块，一段连续的同类 delta 组成一个块，类型改变时关闭当前块再开新块，块索引连续。thinking 块的签名 SHALL 在块关闭时发出。

#### Scenario: Pi 的真实事件顺序
- **WHEN** Pi 依次发出 thinking 开始、thinking delta、text 开始、text delta、thinking delta、text delta、thinking 结束、text 结束
- **THEN** 输出 SHALL 依次为 thinking 块、text 块、thinking 块、text 块，每个块都在下一个开始前关闭，索引从 0 连续

#### Scenario: thinking 签名在结束时被改写
- **WHEN** Pi 在 thinking 结束时给出与已发出签名不同的签名字段
- **THEN** 流 SHALL 显式失败

### Requirement: 工具调用完整后才发出
工具调用 SHALL 在 Pi 给出完整调用之后才作为一个整体发出（块开始、完整参数、块结束），worker 模型参数 SHALL 在发出前规范化。

#### Scenario: 并行工具调用
- **WHEN** 上游在一次响应中返回两个工具调用
- **THEN** 输出 SHALL 含两个完整的 tool_use 块，各自参数完整

### Requirement: 工具参数无法解析时失败
上游返回的工具参数无法解析时，系统 SHALL 显式失败，MUST NOT 发出该 tool_use，即使该工具允许空参数。错误消息、trace 和事件 MUST NOT 包含原始参数或解析错误的详情。

#### Scenario: 参数不是合法 JSON
- **WHEN** 上游返回的工具参数不是合法 JSON
- **THEN** 请求 SHALL 失败，Claude Code 不会执行该工具，错误中不含原始参数文本

### Requirement: 停止原因映射
Pi 的停止原因 `stop`、`length`、`toolUse` SHALL 分别映射为 `end_turn`、`max_tokens`、`tool_use`。`error` 和 `aborted` SHALL 走失败或中止路径。`pending` 和 `deferred` SHALL 显式失败。

#### Scenario: 输出被截断
- **WHEN** 上游因长度上限停止
- **THEN** 响应的停止原因 SHALL 为 `max_tokens`

### Requirement: 错误不泄漏上游内容
首个事件之前的网络错误 SHALL 报告为该 provider 的请求失败，流中错误 SHALL 报告为流失败。上游返回的错误文本和响应体 MUST NOT 被转发或记录，诊断只含状态码和错误类别。Pi 内部 SHALL 不重试。

#### Scenario: 流中错误
- **WHEN** 上游在流中途返回错误，错误文本含响应内容
- **THEN** 客户端 SHALL 收到不含该文本的流失败，日志中也没有该文本

### Requirement: 不支持的签名字段显式失败
首批 provider 的响应中若出现工具调用签名或文本签名，系统 SHALL 显式失败并记录类别，MUST NOT 静默丢弃。

#### Scenario: 出现文本签名
- **WHEN** 上游响应中出现文本签名
- **THEN** 请求 SHALL 失败

### Requirement: count_tokens 只做本地估算
`/v1/messages/count_tokens` 对 Pi provider SHALL 返回本地估算值（含 thinking 文本），并标记为估算，MUST NOT 加载或调用 Pi。

#### Scenario: count_tokens
- **WHEN** 对 Pi 模型调用 count_tokens
- **THEN** 响应 SHALL 带估算标记，且没有上游请求

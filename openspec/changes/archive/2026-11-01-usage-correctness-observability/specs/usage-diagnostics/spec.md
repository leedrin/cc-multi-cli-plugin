## ADDED Requirements

### Requirement: MULTI_USAGE_TRACE 元数据追踪
当环境变量 `MULTI_USAGE_TRACE=1` 时,gateway 进程 SHALL 通过轻量 helper `usageTrace(...)` 输出 usage 元数据,字段限于 `provider`、`event`、`usagePresent`(或 `source`)、`inputTokens`、`cachedTokens`(cache read)、`cacheWriteTokens`、`outputTokens`、`reasoningTokens`、`totalTokens`。未设置该变量时 SHALL NOT 输出任何 trace。

#### Scenario: 开启后输出元数据
- **WHEN** `MULTI_USAGE_TRACE=1` 且 OpenAI 触发 `response.completed`
- **THEN** 系统 SHALL 输出仅含上述元数据字段的一行 JSON

#### Scenario: 默认关闭
- **WHEN** 未设置 `MULTI_USAGE_TRACE`
- **THEN** 系统 SHALL NOT 输出 usage trace

#### Scenario: usage 缺失也可追踪
- **WHEN** terminal event 不含 usage 且 trace 已开启
- **THEN** trace SHALL 输出 `usagePresent: false`,且不含伪造的数值 0

### Requirement: MULTI_UI_TRACE Pane 追踪
当环境变量 `MULTI_UI_TRACE=1` 时,hook SHALL 输出 Usage UI 元数据:`surface`、pane placement(`requested`、`placed`、`reason`)、`ui.focus` 转移(`requestId`、被聚焦元素 key)、`ui.press` action、`ui.scroll` delta、`ui.close`。session id SHALL 不输出真实值(仅 `requestId` / action,或已脱敏/哈希)。未设置时 SHALL NOT 输出。

#### Scenario: 记录 placement 结果
- **WHEN** `MULTI_UI_TRACE=1` 且 `$.ui.open()` 返回 `{ isPlaced: false, reason }`
- **THEN** trace SHALL 记录 `pane.requested = true`、`pane.placed = false` 与 `reason`

#### Scenario: 记录 focus 转移
- **WHEN** `ui.focus` 落到 `provider:openai`
- **THEN** trace SHALL 记录 `event = "ui.focus"`、`requestId = "multi-usage"` 与元素 key

#### Scenario: 不输出真实 session id
- **WHEN** trace 写出任意 UI 事件
- **THEN** 输出 SHALL NOT 包含真实 session id

### Requirement: Trace 禁止内容
无论 Usage Trace 还是 UI Trace,输出 MUST NOT 包含:prompt、assistant 文本、reasoning 密文或 encrypted reasoning state、tool 输入或输出、API key、Authorization header、gateway token、Codex auth、session transcript、model output、credentials。

#### Scenario: 敏感字段不出现
- **WHEN** 开启两类 trace 并运行包含 prompt 与 tool 调用的会话
- **THEN** trace 输出 SHALL NOT 含上述任一类内容

#### Scenario: gateway 请求 helper 不泄露 token
- **WHEN** hook 通过 `$.http.fetch` 携带 `x-multi-gateway-token` 请求网关且 UI trace 开启
- **THEN** trace SHALL NOT 记录该 token 或请求头

### Requirement: 分层定位路径
系统 SHALL 支持用 `MULTI_RECEIPTS_FILE=<path>` 判断问题所在层:收据 output > 0 且 cache_read > 0 而 Claude UI output = 0 → Claude UI / SSE 聚合路径问题;收据 output = 0、cache_read = 0 且 `source = unavailable` → gateway 未获取 terminal usage(Responses parser 或上游事件形状问题);raw terminal usage output > 0 而收据 output = 0 → gateway normalization / completionEvent / receipt 问题。此判定表 SHALL 记录在 `docs/usage.md`。

#### Scenario: 文档包含定位表
- **WHEN** 阅读 `docs/usage.md`
- **THEN** 其中 SHALL 含 Case A/B/C 三种定位场景及结论

#### Scenario: 收据文件不含敏感内容
- **WHEN** 开启 `MULTI_RECEIPTS_FILE` 追加收据
- **THEN** 文件内容 SHALL 仍不含 prompt、response、tool 参数或凭据

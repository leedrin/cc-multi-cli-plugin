## ADDED Requirements

### Requirement: 结构化会话 usage
`ProviderUsageDashboard` SHALL 先计算结构化的 `ProviderSessionUsage`(`requests`、可选 `modelCalls`、`source`、可选 `context`、`consumed`,均使用 `UsageTotalsV2`),再由它格式化 `details` 文本行。`/multi/mod/usage` 的 provider 行 SHALL 以增量可选字段 `session` 暴露该结构,并继续保留 `id`、`name`、`status`、`summary`、`details`、可选 `url`,使旧 UI 与既有测试不受影响。

#### Scenario: 增量 schema
- **WHEN** 请求 `GET /multi/mod/usage?view=providers`
- **THEN** 每个有会话 usage 的 provider 行 SHALL 同时含 `details` 与可选 `session`

#### Scenario: UI 不从字符串反解析数字
- **WHEN** 新 UI 需要会话数值
- **THEN** 它 SHALL 读取 `session` 结构化字段,而不是解析 `details` 字符串

### Requirement: 会话 usage 显示内容
provider 会话 usage SHALL 显示 Context(input、cache read、cache write、prompt cache read ratio)与 Consumed(input、cache read、cache write、output、reasoning、total)以及 `Source`。harness provider SHALL 额外显示 `modelCalls`,并继续区分 live context 与 consumed。

#### Scenario: 完整 telemetry
- **WHEN** provider 会话 usage 完整且 `source = "provider"`
- **THEN** 输出 SHALL 含 `Context:`(含 `prompt cache read ratio`)、`Consumed:`(含 input、cache read、cache write、output、reasoning、total)与 `Source: provider`

#### Scenario: harness 显示 model calls
- **WHEN** harness 会话有 `model_calls`
- **THEN** 摘要行 SHALL 显示如 `2 completed requests · 7 model calls`

### Requirement: Unavailable 与 mixed 的明确措辞
当 `source = "unavailable"` 时,dashboard SHALL 显示 `usage unavailable` 与 `Source: unavailable`,MUST NOT 显示 `Output: 0` 或 `Cache: 0`。当 `source = "mixed"` 时,SHALL 显示 known 计数、`Source: mixed` 以及说明"部分请求未提供完整 token telemetry"的提示。

#### Scenario: unavailable 会话
- **WHEN** 会话内唯一请求 `source = "unavailable"`
- **THEN** 输出 SHALL 为 `Consumed:` 下的 `usage unavailable` 与 `Source: unavailable`,不含数值 0

#### Scenario: mixed 会话
- **WHEN** 会话聚合 source 为 `mixed`
- **THEN** 输出 SHALL 含 `known input`/`known output` 行、`Source: mixed` 与 telemetry 不完整提示

### Requirement: Cache ratio 显示规则
仅当分母已知、分母大于 0 且 `source != unavailable` 时才显示 ratio。`source = "provider"` 时显示为如 `82.4%`;`source = "estimate"` 时显示为 `~82.4% (estimated)`;`source = "mixed"` 时默认 SHALL NOT 显示聚合 ratio。

#### Scenario: provider ratio
- **WHEN** `source = "provider"`,ratio 为 `0.8231`
- **THEN** 显示 SHALL 为 `82.3%`

#### Scenario: estimate ratio
- **WHEN** `source = "estimate"`,ratio 为 `0.824`
- **THEN** 显示 SHALL 为 `~82.4% (estimated)`

#### Scenario: mixed 不显示 ratio
- **WHEN** 聚合 `source = "mixed"`
- **THEN** 输出 SHALL NOT 含 cache ratio 行

### Requirement: 保持既有 dashboard 约束
`GET /multi/mod/usage` SHALL 继续要求 gateway token 认证、会话范围隔离与只读语义,并保持账户数据 30 秒缓存、pending 合并、最多 32 个并发查询与 `refresh=true` 强制刷新。dashboard MUST NOT 触发模型调用、阻塞 provider 推理或轮询账户 usage。URL 不变。

#### Scenario: 未认证被拒绝
- **WHEN** 请求缺少有效 `x-multi-gateway-token`
- **THEN** 路由 SHALL 拒绝该请求

#### Scenario: 30 秒缓存与刷新
- **WHEN** 30 秒内重复请求且未带 `refresh=true`
- **THEN** 账户数据 SHALL 来自缓存;带 `refresh=true` 时 SHALL 重新查询

### Requirement: 配额查询失败不隐藏本地会话 usage
账户 quota 刷新失败时,provider 行 `status` SHALL 为 error,但 SHALL 保留本地会话 accounting;Receipts 加载失败时 SHALL 保持旧数据并显示 `Could not load receipts.`,MUST NOT 清空 provider 行。

#### Scenario: quota 失败
- **WHEN** 某 provider 的账户配额查询失败
- **THEN** 该行 SHALL `status = "error"` 且仍显示会话 token usage,其它 provider 正常显示

#### Scenario: receipts 加载失败
- **WHEN** 请求 `/multi/mod/receipts` 失败
- **THEN** Pane SHALL 显示 `Could not load receipts.` 并保留 provider 行与既有数据

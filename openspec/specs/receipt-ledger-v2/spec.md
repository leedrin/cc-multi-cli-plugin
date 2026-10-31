# receipt-ledger-v2 Specification

## Purpose
TBD - created by archiving change usage-correctness-observability. Update Purpose after archive.

## Requirements

### Requirement: 收据 schema v2 与 totals 结构
`ReceiptLedger` 写出的 `WorkerUsageReceipt` SHALL 使用 `schemaVersion = 2`。收据及快照中的 totals SHALL 使用 `UsageTotalsV2`:包含 `source`,以及可选的 `input_tokens`、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`reasoning_tokens`、`total_tokens`、`model_calls`、`cache_read_ratio`。从未被观测到的字段 SHALL 被省略,已观测的字段 SHALL 输出累加值。

#### Scenario: schemaVersion 升级
- **WHEN** 一次调用完成并写出收据
- **THEN** 收据 JSON 的 `schemaVersion` SHALL 为 `2`,`usage.source` SHALL 存在

#### Scenario: 未知字段被省略
- **WHEN** 调用期间没有任何事件报告 `reasoning_tokens`
- **THEN** 收据 totals SHALL NOT 含 `reasoning_tokens` 字段

### Requirement: 内部累加器保留未知语义
`ReceiptLedger` 内部 SHALL 使用带 `known` 标记的 `UsageAccumulator`,而不是直接累加序列化 totals。累加时,已知值 SHALL 加入 sum 并标记 known;未知值 SHALL NOT 加入 sum。序列化时 never-known 字段省略,known 字段输出 sum。

#### Scenario: 已知 0 保持
- **WHEN** provider 明确报告 `output_tokens = 0` 并被累加
- **THEN** totals 的 `output_tokens` SHALL 输出 `0`(而非省略)

#### Scenario: unavailable 不变成 0
- **WHEN** 只有一次 `source = "unavailable"` 的事件被累加
- **THEN** totals SHALL 为 `{ source: "unavailable" }` 且不含任何 token 计数字段

### Requirement: 聚合 source 合并
收据、会话快照及 breakdown 的聚合 `source` SHALL 使用 `mergeUsageSource` 规则合并。聚合 source 为 `mixed` 时,下游 UI SHALL 以"已知/mixed telemetry"表述,MUST NOT 呈现为完整精确账单。

#### Scenario: provider 加 estimate
- **WHEN** 同一调用内先后有 `provider` 与 `estimate` 事件
- **THEN** 聚合 `source` SHALL 为 `mixed`

#### Scenario: provider 加 unavailable
- **WHEN** 同一调用内先后有 `provider` 与 `unavailable` 事件
- **THEN** 聚合 `source` SHALL 为 `mixed`,已知部分的 sum 保留

### Requirement: spend 计算顺序
`spend(event)` SHALL 按以下顺序取值:(1) `multi_usage.accounting`;(2) harness `consumed_*` 覆盖;(3) legacy 标准 usage fallback;(4) 当 `source = "unavailable"` 时,协议占位 0 MUST NOT 进入 accounting。`multi_usage.accounting` 缺失时(尚未迁移的 provider)SHALL 回落到 legacy 标准 usage 加 `source`,因此不要求一次性修改 Cursor、Zen、Antigravity、Grok。

#### Scenario: accounting 优先
- **WHEN** 事件含 `multi_usage.accounting`
- **THEN** 收据 SHALL 使用 accounting 中的值,而不是协议 `usage`

#### Scenario: harness consumed 覆盖
- **WHEN** 事件含 `consumed_input_tokens` 等字段
- **THEN** 这些字段 SHALL 覆盖对应 spend 值,行为与变更前一致

#### Scenario: legacy provider 回落
- **WHEN** Zen 事件无 `multi_usage.accounting` 且 `source = "provider"`
- **THEN** 收据 SHALL 使用标准 usage,保持既有数值

#### Scenario: unavailable 忽略协议 0
- **WHEN** 事件 `source = "unavailable"` 且协议 usage 为 `{ input_tokens: 0, output_tokens: 0 }`
- **THEN** 收据 SHALL 视为 `{ source: "unavailable" }`,MUST NOT 累加这两个 0

### Requirement: Live context 与 consumption 分离
`snapshot.contexts[provider]` SHALL 继续代表该 provider 最近一次响应的 live context,而聚合 totals 代表跨请求的消耗;二者 MUST 保持分离。`ContextUsageV2` SHALL 携带可选的 `source`、`input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`cache_read_ratio`;`source = "unavailable"` 时 context SHALL 表示为 unavailable 而非 0。

#### Scenario: harness 标准 usage 不被 turn sums 污染
- **WHEN** Cursor、Antigravity 或 Grok 的一次 turn 产生 `consumed_*` 与标准 usage
- **THEN** context SHALL 来自标准 usage(最后一次调用),totals SHALL 来自 `consumed_*`

#### Scenario: context unavailable
- **WHEN** 最近响应 `source = "unavailable"`
- **THEN** context SHALL 标记为 unavailable,MUST NOT 显示为 0

### Requirement: Failed 与 cancelled 收据的 usage 语义
没有任何 provider completion 的 failed 或 cancelled 调用,其收据 usage SHALL 为 `{ "source": "unavailable" }`,MUST NOT 为全 0。若调用在取消前已有部分 provider completion,收据 SHALL 保留已观测 usage,`outcome` 为 `cancelled`,`incomplete` 为 `true`,`source` 由累计数据决定。

#### Scenario: 无 completion 的取消
- **WHEN** 调用在任何 completion 事件之前被取消
- **THEN** 收据 `usage` SHALL 为 `{ "source": "unavailable" }`,`incomplete` SHALL 为 `true`

#### Scenario: 有 completion 后取消
- **WHEN** 调用已完成一次 provider completion 后被取消
- **THEN** 收据 SHALL 保留该次已知 usage,`outcome = "cancelled"`,`incomplete = true`

### Requirement: 聚合 reasoning、total 与 cache ratio
收据 SHALL 聚合 `reasoning_tokens` 与 `total_tokens`(仅累加已知值),并在 source 为 `provider` 且分母已知时序列化 `cache_read_ratio`。reasoning tokens 是信息性数据,MUST NOT 再次加到 output 上。

#### Scenario: reasoning 与 total 求和
- **WHEN** 两次已知 reasoning 分别为 100 与 50,total 分别为 1,200 与 300
- **THEN** 聚合 `reasoning_tokens` SHALL 为 `150`,`total_tokens` SHALL 为 `1500`

#### Scenario: 序列化 ratio
- **WHEN** 聚合 source 为 `provider` 且 cache read 与分母均已知
- **THEN** 收据 totals SHALL 含 `cache_read_ratio`

#### Scenario: mixed 不序列化 ratio
- **WHEN** 聚合 source 为 `mixed`
- **THEN** 收据 totals SHALL NOT 含聚合 `cache_read_ratio`

### Requirement: 去重与 replay 不回退
`ReceiptLedger.observe()` SHALL 继续忽略 `usageMetadata.replayed` 的事件,并继续按 `requestId` 去重;保存的 response 重放 MUST NOT 增加另一次请求的 usage。既有的容量上限(最多 256 个 entry、128 个 session、512 个 pending invocation、8192 去重键、128 条 recent)SHALL 保持。

#### Scenario: replay 被忽略
- **WHEN** 事件 `usageMetadata.replayed = true`
- **THEN** ledger SHALL NOT 累加其 usage,且不增加 `requests`

#### Scenario: requestId 去重
- **WHEN** 相同 `requestId` 的事件被观察两次
- **THEN** 第二次 SHALL 被忽略

### Requirement: v1 收据兼容
`ReceiptLedger` SHALL 继续只写 JSONL、不从 JSONL 恢复状态,因此进程内 MUST NOT 实现 v1→v2 loader 迁移。历史 v1 JSONL SHALL 仍是合法历史记录,外部读取者通过 `schemaVersion` 区分。收据 SHALL 继续不含 prompt、response、tool 参数或凭据,文件以 `0600` 追加,文件错误只报 stderr 而不使推理失败。

#### Scenario: 进程重启后不读取旧文件
- **WHEN** 网关重启且 `MULTI_RECEIPTS_FILE` 指向含 v1 记录的文件
- **THEN** ledger 内存视图 SHALL 从空开始,旧文件内容 SHALL 保持不变

#### Scenario: 收据不含敏感内容
- **WHEN** 检查任一 v2 收据
- **THEN** 它 SHALL NOT 含 prompt、assistant 文本、tool 输入输出或凭据

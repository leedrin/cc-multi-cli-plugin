# cc-multi-cli-plugin Usage Correctness & Observability 详细功能设计方案

> 对应 PRD：`cc-multi-cli-plugin Usage Correctness & Observability Patchset PRD`  
> 建议分支：`fix/usage-observability`  
> 文档类型：Detailed Functional Design / Technical Design  
> 状态：Draft v1.0  
> 设计基线：`leedrin/cc-multi-cli-plugin@b1fa3b53c9ba5b60f877db920a056c62a5085d1c`  
> 基线日期：2026-09-30  
> 目标读者：Codex、Claude Code、项目维护者、Reviewer

---

# 1. 设计目标

本设计将 Usage Patchset PRD 落成可实现的函数级方案，解决两组问题：

1. **Usage 数据正确性**
   - OpenAI/Codex `output_tokens`、cache read/write、reasoning tokens、total tokens 的完整采集。
   - 明确区分“Provider 报告 0”与“Provider 没有提供数据”。
   - Receipt、Dashboard、`/multi-usage` 使用同一套 accounting truth。
   - 保持 0.3.0 已建立的 harness “live context vs turn consumption”语义。

2. **Usage UI 可观测性**
   - `/multi-usage` 在普通 Terminal、Orca、WSL、SSH、tmux 等宿主中可用。
   - Interactive Pane 失败时 Usage 仍可通过文本模式查看。
   - 核心键盘交互不再依赖 `Client.surface.onKey()` 自己解释终端按键。
   - UI 继续完全建立在 Claude Mods/function hooks 上，不创建第二套终端 UI。

最终关系：

```text
Provider terminal usage
        │
        ▼
Canonical accounting
        │
        ├──────────────► Anthropic-compatible protocol usage
        │                         │
        │                         ▼
        │                    Claude Code
        │
        ▼
ReceiptLedger
        │
        ▼
ProviderUsageDashboard
        │
        ▼
/multi/mod/usage
        │
        ├──────────────► Engine-native Usage Pane
        └──────────────► /multi-usage --text
```

---

# 2. 调研基线与参考来源

本设计基于以下当前资料和源码：

## 2.1 Multi Claude Mods 设计文档

- `greenpolo/cc-multi-cli-plugin/docs/claude-mods.md`
- https://github.com/greenpolo/cc-multi-cli-plugin/blob/main/docs/claude-mods.md

该文档明确：

- Claude Mods/function hooks 是 Multi 唯一的 Claude Code 内部 UI/扩展机制。
- Gateway 提供经过认证、受限的数据接口。
- Hook 层负责 `command.run`、`ui.render`、`ui.message`、生命周期和 Usage UI。
- Provider harness 不创建 competing terminal UI。
- 交互 Surface 应复用 Claude Code 的 `ui.open` / `ui.render` / `ui.focus` / `ui.press` 等能力。

## 2.2 当前 fork CHANGELOG

- `leedrin/cc-multi-cli-plugin/CHANGELOG.md`
- https://github.com/leedrin/cc-multi-cli-plugin/blob/main/CHANGELOG.md

当前 `main` 的 Unreleased 变更中，最重要的是：

```text
Stop the gateway from altering native Claude Code behavior
```

其约束包括：

- Claude 原生 Messages 请求尽量原样到 Anthropic。
- Anthropic stream 原样返回 Claude Code。
- Anthropic 连接失败使用断连让 Claude Code 自己 retry。
- 不再覆盖 Claude Code 原生 API timeout。
- 非 Messages `/v1/*` 原始转发。
- Provider tool attribution 移入 Claude Mods，不再为每个 Claude tool call 启 Node command hook。
- 原生 Claude subagent 避免额外 gateway lookup。

因此本 Patchset **不得为了 Usage 统计重新解析、重写或拦截原生 Claude 数据流**。

## 2.3 当前源码基线

设计冻结在：

```text
leedrin/cc-multi-cli-plugin
commit b1fa3b53c9ba5b60f877db920a056c62a5085d1c
```

关键文件：

```text
plugins/multi-openai/src/responses.ts
plugins/multi-openai/src/usage.ts
plugins/multi-core/src/gateway/messages.ts
plugins/multi-core/src/gateway/server.ts
plugins/multi-core/src/gateway/receipts.ts
plugins/multi-core/src/gateway/provider-usage.ts
plugins/multi-core/src/gateway/mod-usage.ts
plugins/multi-core/hooks/usage.ts
plugins/multi-core/hooks/usage-view.ts

test/unit/native-openai-stream.test.ts
test/unit/native-openai-usage.test.ts
test/unit/native-provider-usage.test.ts
test/unit/native-receipts.test.ts
test/unit/native-usage-menu.test.ts
test/live/native-openai-cache.ts
```

## 2.4 Claude Mods 官方实现参考

Anthropic 当前内置 `/diff` Mod 已使用：

```text
$.ui.open()
ui.render(Pane)
Button.autoFocus
ui.focus
ui.scroll
ui.close
```

并检查：

```text
opened.isPlaced
```

参考：

- https://github.com/anthropics/claude-code/tree/main/mods/diff
- https://github.com/anthropics/claude-code/blob/main/mods/diff/hooks/register.ts
- https://github.com/anthropics/claude-code/blob/main/mods/diff/README.md

这比让一个 Client 模块自己解释方向键更接近当前 Claude Mods 的原生交互模型。

## 2.5 OpenAI Codex 当前 usage schema

OpenAI Codex 当前 Responses completion usage 明确包含：

```text
input_tokens
input_tokens_details.cached_tokens
input_tokens_details.cache_write_tokens
output_tokens
output_tokens_details.reasoning_tokens
total_tokens
```

参考：

- https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs

本项目当前 `ResponsesUsage` 尚未完整保留其中的 `output_tokens_details` 和 `total_tokens`。

---

# 3. 当前系统结构

当前 Usage 数据路径：

```text
OpenAI / Zen / Cursor / Antigravity / Grok
                  │
                  ▼
          MessagesResponse
          ├─ usage
          └─ multi_usage
                  │
                  ▼
       server.completionEvent()
                  │
                  ▼
          GatewayEvent
          ├─ usage
          └─ usageMetadata
                  │
                  ▼
          ReceiptLedger.observe()
                  │
        ┌─────────┴──────────┐
        ▼                    ▼
session snapshot         receipt file
        │
        ▼
ProviderUsageDashboard
        │
        ▼
/multi/mod/usage
        │
        ▼
hooks/usage.ts
        │
        ▼
Client(usage-view.ts)
```

当前 Mods UI 路径：

```text
/multi-usage
    │
    ▼
command.run
    │
    ├─ GET /multi/mod/usage
    │
    ▼
$.ui.open({ focus:true })
    │
    ▼
ui.render(Pane)
    │
    ▼
Client('./usage-view.ts')
    │
    ▼
surface.onKey()
```

---

# 4. 当前源码问题清单

## 4.1 OpenAI terminal usage schema 不完整

当前：

```ts
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
}
```

缺少：

```ts
output_tokens_details?: {
  reasoning_tokens?: number;
} | null;

total_tokens?: number;
```

结果：

```text
reasoning tokens 丢失
provider total_tokens 丢失
```

---

## 4.2 `ResponseStream.finish()` 将 unavailable 压成 0

当前逻辑：

```ts
const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
const written = usage?.input_tokens_details?.cache_write_tokens ?? 0;

message.usage = {
  input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cached - written),
  output_tokens: usage?.output_tokens ?? 0,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: written,
};
```

如果 Provider 没返回 usage：

```text
unknown input  -> 0
unknown output -> 0
unknown cache  -> 0
```

虽然 `multi_usage.source = unavailable` 已存在，但下游如果只看数值就会误判。

---

## 4.3 Protocol Usage 与 Accounting Truth 混在一个对象

Claude Code 需要：

```ts
MessagesResponse.usage
```

保持 Anthropic-compatible numeric shape。

Accounting 则需要表达：

```text
known
unknown
estimated
mixed
provider-reported zero
```

这两种需求不同。

因此：

```text
MessagesResponse.usage
```

不能成为唯一 accounting truth。

---

## 4.4 Receipt schema v1 使用零初始化

当前：

```ts
const emptyTotals = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});
```

因此：

```text
没有 telemetry
```

和：

```text
Provider 明确报告 0
```

在 aggregate 后无法单靠数值区分。

当前 receipt entry 已有：

```ts
source:
  | 'provider'
  | 'estimate'
  | 'mixed'
  | 'unavailable';
```

但 totals 本身没有 source，也没有 unknown semantics。

---

## 4.5 Dashboard 没有 Cache Ratio

当前 `sessionLines()` 只输出：

```text
consumed N input
cached N read
output N
cache written N
```

缺少：

```text
cache read ratio
reasoning tokens
total tokens
aggregate source
```

---

## 4.6 `/multi-usage` 依赖 Client `surface.onKey()`

当前 `usage-view.ts`：

```ts
surface.onKey((event) => {
  r
  up/down
  left/right
});
```

在 Orca 中已经观察到：

```text
Pane 正常显示
但焦点仍留在 Composer
方向键/r/Esc 不进入 Client
```

这是一个典型的：

```text
render succeeded
interaction ownership failed
```

问题。

---

## 4.7 `$.ui.open()` 结果被忽略

当前：

```ts
await $.ui.open(...)
```

没有检查：

```text
isPlaced
reason
```

因此：

```text
Pane placement 被拒绝
```

无法自动降级。

---

## 4.8 原 PRD 中的 `multi-openai/src/usage.ts` 文件名需要修正

当前源码已经存在：

```text
plugins/multi-openai/src/usage.ts
```

职责是：

```text
Codex account quota / rate-limit windows
```

因此 token response normalization 不应继续使用同名文件。

本设计改为：

```text
plugins/multi-openai/src/response-usage.ts
```

避免把：

```text
Account quota usage
```

和：

```text
Per-response token usage
```

混为一个模块。

---

# 5. 不可破坏约束

本 Patchset 实现过程中必须始终满足以下约束。

## 5.1 Claude passthrough 零侵入

禁止为了 Usage：

```text
解析 Anthropic 原生 stream
重写 Anthropic SSE
注入 Claude usage
改变 Claude retry
改变 Claude timeout
改变 Anthropic headers
改变 non-Messages raw forwarding
```

Usage Patchset 只统计：

```text
Multi provider completion
```

原生 Claude route：

```text
route = anthropic
```

没有 provider completion usage 时继续被 ReceiptLedger 忽略。

---

## 5.2 Harness context/consumption 语义不能回退

0.3.0 已明确区分：

```text
standard MessagesResponse.usage
    =
last model call / live context

multi_usage.consumed_*
    =
whole harness turn consumption
```

该设计必须保留。

尤其：

```text
Cursor / Antigravity / Grok
```

不得因为 Receipt v2 改造重新把 turn sums 塞回 standard usage。

---

## 5.3 Usage UI 必须继续使用 Claude Mods

允许：

```text
command.run
ui.open
ui.render
ui.focus
ui.press
ui.scroll
ui.close
$.http.fetch
```

禁止：

```text
alternate terminal renderer
Ink app outside Claude
tmux overlay
Orca-specific IPC
synthetic model tool
prompt-driven usage UI
```

---

## 5.4 Provider request 不因 telemetry 缺失重新执行

如果：

```text
response completed successfully
usage missing
```

必须：

```text
return successful model output
source = unavailable
```

不得：

```text
throw retryable provider error
rerun paid request
```

---

# 6. 目标架构

```text
                  Provider Stream
                        │
                        ▼
             ┌────────────────────┐
             │ Response Translator│
             └─────────┬──────────┘
                       │
               raw terminal usage
                       │
                       ▼
          ┌───────────────────────────┐
          │ Canonical Usage Adapter   │
          │ usage-accounting.ts       │
          └───────┬───────────┬───────┘
                  │           │
                  │           │
                  ▼           ▼
          protocol usage   accounting metadata
                  │           │
                  └─────┬─────┘
                        ▼
                MessagesResponse
                        │
                        ▼
                completionEvent
                        │
                        ▼
                 ReceiptLedger v2
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
       Usage Snapshot          Receipt JSONL
             │
             ▼
    ProviderUsageDashboard
             │
             ▼
       /multi/mod/usage
             │
        ┌────┴───────────┐
        ▼                ▼
Engine-native Pane    Text Renderer
```

---

# 7. 模块拆分

新增两个小模块，不引入 ProviderRegistry。

## 7.1 Shared accounting

新增：

```text
plugins/multi-core/src/gateway/usage-accounting.ts
```

职责：

```text
CanonicalTokenUsage
UsageSource
UsageTotalsV2
source merge
metric accumulation
cache read ratio
format helpers used by gateway
```

不负责：

```text
Provider-specific JSON parsing
UI rendering
network requests
```

---

## 7.2 OpenAI response usage

新增：

```text
plugins/multi-openai/src/response-usage.ts
```

职责：

```text
parse OpenAI Responses usage
validate token counters
derive uncached input
preserve reasoning/total
map canonical -> Anthropic protocol usage
```

不负责：

```text
Codex account quota
Responses content translation
Receipt persistence
```

---

# 8. CanonicalTokenUsage 设计

建议：

```ts
export type UsageSource =
  | 'provider'
  | 'estimate'
  | 'mixed'
  | 'unavailable';

export interface CanonicalTokenUsage {
  source: UsageSource;

  /**
   * Provider/accounting semantics.
   * Undefined means unknown, not zero.
   */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;

  /**
   * Optional calculated value, 0..1.
   * Undefined when a trustworthy denominator is unavailable.
   */
  cacheReadRatio?: number;
}
```

语义必须固定：

```text
undefined = unknown
0         = known zero
```

任何 accounting helper 禁止无条件：

```ts
value ?? 0
```

除非是在明确的 protocol compatibility boundary。

---

# 9. Usage Source 规则

## 9.1 Provider

满足：

```text
核心 usage 由 Provider terminal response 明确提供
```

例如：

```text
input_tokens present
output_tokens present
```

则：

```ts
source = 'provider'
```

---

## 9.2 Unavailable

Provider completion 没有 usage：

```ts
source = 'unavailable'
```

所有未知计数字段省略。

---

## 9.3 Mixed

Provider 返回 partial core telemetry，例如：

```text
input_tokens present
output_tokens missing
```

则：

```ts
source = 'mixed'
```

保留已知字段：

```ts
inputTokens: ...
outputTokens: undefined
```

不能把缺失字段写成 0。

---

## 9.4 Estimate

本地估计或 native harness estimate：

```ts
source = 'estimate'
```

现有 harness source 语义保持。

---

# 10. OpenAI Responses Usage 输入结构

`response-usage.ts`：

```ts
export interface OpenAIResponsesUsage {
  input_tokens?: number;

  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  } | null;

  output_tokens?: number;

  output_tokens_details?: {
    reasoning_tokens?: number;
  } | null;

  total_tokens?: number;
}
```

解析器：

```ts
export function parseOpenAIResponseUsage(
  value: unknown
): CanonicalTokenUsage;
```

要求：

```text
undefined/null usage       -> unavailable
malformed numeric value    -> throw malformed stream event
partial valid usage        -> mixed
full core usage            -> provider
detail objects null        -> accepted
reasoning absent           -> unknown
total absent               -> derive only when input+output known
```

---

# 11. OpenAI Token 计算规则

假设 Provider：

```text
input_tokens = raw prompt total
cached_tokens = cache read subset
cache_write_tokens = cache write subset
```

则：

```text
uncached input =
max(
  0,
  input_tokens
  - cached_tokens
  - cache_write_tokens
)
```

Canonical：

```ts
inputTokens = uncachedInput;
cacheReadTokens = cached;
cacheWriteTokens = written;
outputTokens = usage.output_tokens;
reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
```

`totalTokens`：

```text
优先 provider total_tokens
否则在 raw input_tokens 和 output_tokens 都已知时：
raw input_tokens + output_tokens
否则 unknown
```

---

# 12. Cache Read Ratio

定义继续采用 PRD 的 token-weighted ratio：

```text
cacheReadRatio =
cacheReadTokens
/
(
  inputTokens
  + cacheReadTokens
  + cacheWriteTokens
)
```

规则：

```text
denominator > 0 且相关字段已知 -> ratio
denominator = 0               -> undefined
核心输入 telemetry 不完整      -> undefined
source = unavailable          -> undefined
```

显示时：

```text
0.8231 -> 82.3%
```

不要称为：

```text
request cache hit rate
```

统一名称：

```text
Prompt cache read ratio
```

---

# 13. Protocol Usage Adapter

Claude Code 的协议对象继续使用：

```ts
interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
```

新增：

```ts
export function toProtocolUsage(
  usage: CanonicalTokenUsage
): MessagesResponse['usage'];
```

规则：

### Provider/mixed 有已知数据

```ts
{
  input_tokens: usage.inputTokens ?? 0,
  output_tokens: usage.outputTokens ?? 0,
  ...(usage.cacheReadTokens === undefined
    ? {}
    : { cache_read_input_tokens: usage.cacheReadTokens }),
  ...(usage.cacheWriteTokens === undefined
    ? {}
    : { cache_creation_input_tokens: usage.cacheWriteTokens }),
}
```

### unavailable

仅为了 Anthropic-compatible schema：

```ts
{
  input_tokens: 0,
  output_tokens: 0
}
```

但这两个 0：

```text
不得进入 accounting truth
```

Receipt 必须依赖：

```text
multi_usage.source
```

判断是否可信。

---

# 14. `MessagesResponse.multi_usage` 扩展

当前字段继续保留：

```text
source
reasoning_tokens
total_tokens
consumed_*
model_calls
replayed
model
effort
```

建议新增一个可选 accounting block：

```ts
multi_usage?: {
  source: UsageSource;

  accounting?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_tokens?: number;
    total_tokens?: number;
    cache_read_ratio?: number;
  };

  // existing harness semantics
  consumed_input_tokens?: number;
  consumed_output_tokens?: number;
  consumed_cache_read_tokens?: number;
  consumed_cache_creation_tokens?: number;
  model_calls?: number;

  replayed?: boolean;
  model?: string;
  effort?: string;
}
```

为什么新增 `accounting` 而不是继续只看 standard `usage`：

```text
standard usage
    =
protocol compatibility

multi_usage.accounting
    =
truth with unknown semantics
```

---

# 15. 向后兼容策略

在所有 Provider 全部迁移到 `accounting` 前：

ReceiptLedger 采用：

```text
if multi_usage.accounting exists:
    use accounting
else:
    use legacy standard usage + source
```

因此该 patch：

```text
不要求一次性修改 Cursor/Zen/Antigravity/Grok
```

OpenAI 先成为第一个显式 accounting Provider。

---

# 16. `responses.ts` 修改设计

## 16.1 扩展 stream validation

`validResponse()` 增加检查：

```text
output_tokens_details
reasoning_tokens
total_tokens
null detail objects
```

所有 token count：

```text
safe integer
>= 0
```

---

## 16.2 `ResponseStream.start()`

保持：

```ts
usage: {
  input_tokens: estimatedInput,
  output_tokens: 0
}
```

这是：

```text
provisional protocol usage
```

不得进入 receipt。

测试必须继续锁定：

```text
message_start = provisional
message_delta = final
```

---

## 16.3 `ResponseStream.finish()`

由：

```ts
finish(stopReason, rawUsage)
```

改为：

```ts
const accounting =
  parseOpenAIResponseUsage(rawUsage);

message.usage =
  toProtocolUsage(accounting);

message.multi_usage = {
  source: accounting.source,
  accounting: toAccountingMetadata(accounting),
  model: this.model,
  ...(accounting.reasoningTokens === undefined
    ? {}
    : { reasoning_tokens: accounting.reasoningTokens }),
  ...(accounting.totalTokens === undefined
    ? {}
    : { total_tokens: accounting.totalTokens }),
};
```

注意：

```text
reasoning_tokens / total_tokens
```

可暂时同时保留 flat legacy 字段和 `accounting` block，方便现有 Receipt 过渡。

---

## 16.4 `requireUsage`

保持：

```text
Zen Responses: true
OpenAI: false
```

不要将 OpenAI 改成 `requireUsage:true`。

理由：

```text
成功 response + telemetry absent
```

不等于：

```text
model response invalid
```

---

# 17. OpenAI 事件生命周期

目标：

```text
response.created
    │
    ▼
message_start
usage = provisional estimate
    │
    ▼
content deltas
    │
    ▼
response.completed / done / incomplete
    │
    ▼
parseOpenAIResponseUsage()
    │
    ├─ protocol usage
    └─ accounting usage
    │
    ▼
message_delta(final usage)
    │
    ▼
message_stop
    │
    ▼
completionEvent()
```

只有：

```text
completionEvent
```

进入 ReceiptLedger。

---

# 18. `completionEvent()` 设计

当前：

```ts
usage: result.usage,
usageMetadata:
  result.multi_usage ?? { source: 'unavailable' }
```

结构本身可保留。

不需要改变 provider routing。

ReceiptLedger 自己负责：

```text
prefer multi_usage.accounting
fallback legacy
```

这是为了避免扩大 `server.ts` 改动面。

`server.ts` 的目标是：

> 最多做 type-compatible additive change，不碰 dispatch / passthrough。

---

# 19. Receipt v2 目标

当前 schema：

```text
RECEIPT_SCHEMA_VERSION = 1
```

升级：

```text
2
```

新的 totals：

```ts
export interface UsageTotalsV2 {
  source: UsageSource;

  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;

  reasoning_tokens?: number;
  total_tokens?: number;
  model_calls?: number;

  cache_read_ratio?: number;
}
```

---

# 20. Receipt Accumulator 内部模型

为了避免 unknown 被自动变 0，内部不要直接使用 serialized totals。

建议：

```ts
interface UsageAccumulator {
  source: UsageSource;

  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;

  known: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
    reasoning: boolean;
    total: boolean;
    modelCalls: boolean;
  };
}
```

累加时：

```text
已知值 -> 加到 sum，并 mark known
未知值 -> 不加
```

序列化时：

```text
never-known -> omit
known       -> output sum
```

---

# 21. Aggregate Source 合并规则

新增：

```ts
function mergeUsageSource(
  left: UsageSource,
  right: UsageSource
): UsageSource;
```

规则：

```text
provider + provider       = provider
estimate + estimate       = estimate
unavailable + unavailable = unavailable

provider + estimate       = mixed
provider + unavailable    = mixed
estimate + unavailable    = mixed
mixed + anything          = mixed
```

对于 aggregate source 为 `mixed`：

UI 必须写：

```text
Known / mixed telemetry
```

不能把当前 sum 表述成完整精确账单。

---

# 22. `spend(event)` v2

当前 harness 语义：

```text
consumed_* 优先
```

继续保持。

新顺序：

```text
1. multi_usage.accounting
2. harness consumed_* override
3. legacy standard usage fallback
4. source=unavailable 时禁止 protocol zero 进入 accounting
```

伪代码：

```ts
function accountingOf(event): CanonicalTokenUsage {
  const meta = event.usageMetadata;

  if (meta?.accounting) {
    return fromAccountingMetadata(meta);
  }

  if (meta?.source === 'unavailable') {
    return { source: 'unavailable' };
  }

  return legacyAccounting(event);
}
```

然后 harness consumption：

```ts
function spend(event) {
  const base = accountingOf(event);

  return {
    ...base,
    inputTokens:
      meta?.consumed_input_tokens
      ?? base.inputTokens,

    outputTokens:
      meta?.consumed_output_tokens
      ?? base.outputTokens,

    ...
  };
}
```

---

# 23. Context 与 Spend 继续分离

当前：

```text
snapshot.contexts[provider]
```

代表：

```text
last response live context
```

而：

```text
snapshot totals
```

代表：

```text
consumed across requests
```

保持。

Context 建议升级为 optional：

```ts
interface ContextUsageV2 {
  source: UsageSource;
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_ratio?: number;
}
```

如果 source unavailable：

```text
context = unavailable
```

而不是：

```text
context 0
```

---

# 24. Failed / Cancelled Receipt 语义

当前测试要求：

```text
failed/cancelled invocation
usage = all zero
```

v2 改为：

```json
{
  "source": "unavailable"
}
```

即：

```text
没有任何 provider completion
!=
provider consumed 0 tokens
```

如果 invocation 已经有一部分 provider completion，然后后来 cancelled：

```text
保留已观测到的 usage
outcome = cancelled
incomplete = true
source 根据累计数据决定
```

---

# 25. Receipt v1 兼容

当前 ReceiptLedger：

```text
只写 JSONL
不从 JSONL 恢复 ledger state
```

因此项目内部不需要实现复杂的 v1->v2 loader migration。

兼容要求是：

```text
历史 JSONL 仍是合法历史记录
外部阅读工具通过 schemaVersion 区分
```

如果 Usage UI 当前只展示：

```text
ledger.recent()
```

那么运行时只会看到本进程生成的 v2 receipt。

---

# 26. Provider Dashboard v2

当前 `sessionLines()` 改造成结构化 formatter。

建议新增：

```ts
function sessionUsage(
  snapshot: UsageSnapshot,
  provider: UsageProvider
): ProviderSessionUsage;
```

内部先算结构化值，再格式化 `details`。

---

# 27. Dashboard 显示格式

Provider telemetry 完整：

```text
This session: 4 completed requests

Context:
  input 12,420
  cache read 10,240
  cache write 0
  prompt cache read ratio 82.4%

Consumed:
  input 18,210
  cache read 42,600
  cache write 1,024
  output 3,812
  reasoning 2,406
  total 65,646

Source: provider
```

Harness：

```text
This session: 2 completed requests · 7 model calls

Context:
  ...

Consumed:
  ...

Source: provider
```

Unavailable：

```text
This session: 1 completed request

Consumed:
  usage unavailable

Source: unavailable
```

Mixed：

```text
Consumed:
  known input 12,400
  known output 1,200

Source: mixed
Some requests did not provide complete token telemetry.
```

---

# 28. Cache Ratio 显示规则

仅当：

```text
denominator known
denominator > 0
source != unavailable
```

显示。

对于：

```text
source = provider
```

显示：

```text
82.4%
```

对于：

```text
source = estimate
```

显示：

```text
~82.4% (estimated)
```

对于：

```text
source = mixed
```

默认不显示 aggregate ratio，避免把 partial sum 当完整 ratio。

---

# 29. `/multi/mod/usage` API

URL 不变：

```text
GET /multi/mod/usage
```

Provider view：

```text
GET /multi/mod/usage
  ?sessionId=<id>
  &view=providers
```

保持：

```text
authentication
session scope
read-only
30s account-data cache
refresh=true
```

不新增外部网络动作。

---

# 30. Provider View Additive Schema

为兼容现有 Client/测试，可继续保留：

```ts
{
  id
  name
  status
  summary
  details
  url?
}
```

建议增加可选：

```ts
session?: {
  requests: number;
  modelCalls?: number;
  source: UsageSource;
  context?: UsageTotalsV2;
  consumed: UsageTotalsV2;
}
```

这样：

```text
旧 UI -> 仍读 details
新 UI -> 可读结构化 session
```

第一版如果希望降低改动面，可以先只改 `details`，但建议尽早提供 `session`，避免 UI 将来从字符串反解析数字。

---

# 31. `/multi-usage --text`

命令行为：

```text
/multi-usage
    -> interactive pane

/multi-usage --text
    -> plain text

/multi-usage text
    -> optional alias
```

其他参数：

```text
Use /multi-usage or /multi-usage --text.
```

---

# 32. Text Renderer

新增纯函数：

```ts
export function renderUsageText(
  props: UsagePaneProps
): string;
```

建议放：

```text
plugins/multi-core/hooks/usage-format.ts
```

或与 pane renderer 同文件。

要求：

```text
无 Client
无 focus
无 ui.open
无 terminal keyboard
无 model call
```

示例：

```text
Multi usage · 2026-09-30T...

OpenAI / Codex
  Account: ...
  This session: ...
  Context: ...
  Consumed: ...
  Source: provider

Cursor
  ...
```

---

# 33. Interactive Pane 改造原则

当前：

```text
Client module owns interaction
```

目标：

```text
Claude Mods engine owns interaction
```

从：

```text
Client
  └─ surface.onKey()
```

迁移到：

```text
ui.render(Pane)
  ├─ Button
  ├─ autoFocus
  ├─ ui.focus
  ├─ ui.scroll
  ├─ ui.close
  └─ Button onPress
```

---

# 34. 为什么不继续增强 `surface.onKey()`

即使为 Orca 增加更多键值兼容：

```text
ESC[D
CSI-u
Kitty
xterm
```

仍然会形成：

```text
Multi 自己维护 terminal keyboard decoder
```

这与 Claude Mods 的目标相反。

正确层次：

```text
terminal host
    ↓
Claude Code
    ↓
focus system
    ↓
Mod action
```

而不是：

```text
terminal host
    ↓
Client raw key
    ↓
Multi decoder
```

---

# 35. Engine-native Pane State

当前：

```ts
surface.state
```

迁移到 hook-owned state：

```ts
interface UsagePaneState {
  props: UsagePaneProps;

  selected:
    | 'all'
    | 'receipts'
    | UsageProvider;

  offset: number;

  open: boolean;
  loading: boolean;

  receiptLoaded: boolean;
}
```

Map：

```ts
const panes =
  new Map<string, UsagePaneState>();
```

仍保持现有：

```text
最多 16 个 session state
```

---

# 36. Pane Render

`ui.render(Pane)`：

```ts
const { Box, Text, Button } =
  await $.ui.resolve(event);
```

直接返回元素树，不再返回：

```ts
Client({
  module: './usage-view.ts'
})
```

Provider tab：

```ts
Button({
  key: `provider:${id}`,
  label: selected ? `[${name}]` : name,
  ...(selected
    ? { autoFocus: true as const }
    : {}),
  onPress: () => selectProvider(...)
})
```

Receipts：

```ts
key = 'tab:receipts'
```

Refresh：

```ts
key = 'action:refresh'
```

Close：

```ts
key = 'action:close'
```

Quota advice：

```ts
key = 'action:quota-advice'
```

---

# 37. `ui.focus`

增加：

```ts
on(
  'ui.focus',
  {
    component: 'Pane',
    requestId: 'multi-usage'
  },
  ...
)
```

当 focus ring 落到：

```text
provider:<id>
tab:all
tab:receipts
```

更新：

```text
selected
offset = 0
```

并：

```ts
$.ui.invalidate('ui.render')
```

这样 provider navigation 使用 Claude Code 自己的 focus ring。

---

# 38. Receipts Lazy Load

当：

```text
selected = receipts
```

且：

```text
receiptLoaded = false
```

才请求：

```text
/multi/mod/receipts
```

避免 focus ring 反复经过时重复请求。

Refresh receipts：

```text
显式 Refresh
```

才重新请求。

---

# 39. `ui.scroll`

增加：

```ts
on(
  'ui.scroll',
  { requestId: 'multi-usage' },
  ...
)
```

更新：

```text
offset
```

使用：

```text
event.by
```

并保持 bounded：

```text
0 <= offset <= maxOffset
```

---

# 40. Refresh

Refresh 必须至少有一个显式 Button。

Provider page：

```text
GET /multi/mod/usage?...&refresh=true
```

Receipts page：

```text
GET /multi/mod/receipts
```

`r` hotkey：

```text
不再是核心能力
```

如果 Claude Mods 后续提供稳定 action/hotkey API，可作为 enhancement 再加。

---

# 41. Close

保留：

```ts
closeOnEscape: true
```

同时增加：

```text
[Close]
```

显式 Button。

这样：

```text
Esc encoding/focus 问题
```

不会让 Pane 成为不可退出 UI。

---

# 42. `$.ui.open()` 结果处理

由：

```ts
await $.ui.open(...)
```

改为：

```ts
const opened =
  await $.ui.open(...);
```

判断：

```ts
if (
  opened &&
  typeof opened === 'object' &&
  opened.isPlaced === false
) {
  await $.ui.close({ id: 'multi-usage' })
    .catch(() => undefined);

  return {
    text: renderUsageText(response)
  };
}
```

如果旧 Claude build：

```text
open() returns void
```

则：

```text
按 placed 处理
```

与 Anthropic 官方 Mod 的兼容策略一致。

---

# 43. Focus Failure 的现实边界

当前 Mods API 可以可靠观察：

```text
placement
ui.focus events
```

但没有一个稳定的同步 API 能在 `ui.open()` 返回时直接询问：

```text
Pane 是否已经真正拿到 keyboard focus
```

因此第一版：

```text
placement failure -> automatic text fallback
focus problem      -> engine-native interaction + explicit --text fallback
```

不要通过：

```text
100ms timeout
没有收到 key
猜测 Orca
```

来自动判断 focus failure。

这种 host heuristic 不可靠。

---

# 44. Orca 兼容策略

禁止：

```ts
if (terminal === 'orca') ...
```

不依赖：

```text
TERM_PROGRAM=orca
Orca IPC
Orca xterm internals
```

兼容依靠：

```text
Claude Code focus system
explicit Buttons
ui.focus
ui.scroll
text fallback
```

因此同样有利于：

```text
tmux
SSH
remote runtime
future terminal host
```

---

# 45. `usage-view.ts` 迁移策略

分两阶段。

## Phase A

先实现：

```text
--text
placement fallback
accounting correctness
```

保留 Client UI。

目的：

```text
先让数据正确
```

## Phase B

迁移到 engine-native pane。

迁移完成且测试通过后：

```text
usage-view.ts 不再被 ui.render 引用
```

建议先保留一个版本作为：

```text
legacy source / easy revert
```

最后独立 commit 删除。

这样未来 upstream cherry-pick 更容易处理。

---

# 46. `usage.ts` 内部职责拆分

当前 `usage.ts` 同时包含：

```text
tool attribution
quota advice
command
pane
ui.message
receipt formatting
gateway request
```

为减少未来冲突，建议只做小规模 extraction：

```text
usage.ts
  ├─ register hooks
  ├─ tool attribution
  └─ controller wiring

usage-format.ts
  ├─ dashboard validation
  ├─ receipt formatting
  └─ text rendering

usage-pane.ts
  ├─ pane state helpers
  ├─ direct renderer
  ├─ selection
  └─ scrolling
```

不要创建复杂 framework。

---

# 47. Quota Advice 保持不变

现有：

```text
classic.PreToolUse
```

逻辑是当前 Unreleased passthrough 修复的一部分。

本 Patchset 不改变：

```text
attributeToolCall()
quotaAdvice(snapshot)
advisorySessions
Agent/Task boundary
```

UI 只改变：

```text
Quota-aware model selection
```

按钮的展示和事件 ownership。

---

# 48. Gateway Request Helper

继续使用：

```ts
$.http.fetch
```

认证：

```text
MULTI_MOD_GATEWAY_URL
MULTI_GATEWAY_TOKEN
x-multi-gateway-token
```

保持：

```text
8.5s usage timeout
```

除非测试证明必须调整。

任何 UI trace：

```text
不得记录 token
```

---

# 49. Usage Trace

新增环境变量：

```text
MULTI_USAGE_TRACE=1
```

建议在 Gateway process 内实现轻量 helper：

```ts
usageTrace({
  provider,
  event,
  source,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
  totalTokens,
});
```

只输出 metadata。

---

# 50. UI Trace

新增：

```text
MULTI_UI_TRACE=1
```

输出：

```json
{
  "event": "usage-pane-open",
  "session": "<redacted/hash or omitted>",
  "placed": true
}
```

以及：

```text
ui.focus key
ui.scroll delta
ui.press action
ui.close
```

建议不输出真实 session ID；可以：

```text
只输出 requestId / action
```

---

# 51. Trace 禁止内容

无论 Usage Trace 还是 UI Trace，禁止：

```text
prompt
assistant text
reasoning ciphertext
tool input
tool output
API key
Authorization
gateway token
Codex auth
session transcript
```

---

# 52. 文件级修改清单

## 新增

```text
plugins/multi-core/src/gateway/usage-accounting.ts
plugins/multi-openai/src/response-usage.ts

plugins/multi-core/hooks/usage-format.ts
plugins/multi-core/hooks/usage-pane.ts   # Phase B
```

## 修改

```text
plugins/multi-openai/src/responses.ts
plugins/multi-core/src/gateway/messages.ts
plugins/multi-core/src/gateway/receipts.ts
plugins/multi-core/src/gateway/provider-usage.ts
plugins/multi-core/hooks/usage.ts
plugins/multi-core/hooks/usage-view.ts   # Phase A，之后淘汰
```

## 尽量不改

```text
plugins/multi-core/src/gateway/server.ts
plugins/multi-core/src/gateway/mod-routes.ts
plugins/multi-core/src/gateway/mod-usage.ts
```

如果需要改：

```text
只能 additive / type wiring
不得改 dispatch
不得改 Anthropic passthrough
```

---

# 53. `usage-accounting.ts` 建议 API

```ts
export type UsageSource =
  | 'provider'
  | 'estimate'
  | 'mixed'
  | 'unavailable';

export interface CanonicalTokenUsage {
  source: UsageSource;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cacheReadRatio?: number;
}

export function cacheReadRatio(
  usage: Pick<
    CanonicalTokenUsage,
    'inputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
  >
): number | undefined;

export function mergeUsageSource(
  a: UsageSource,
  b: UsageSource
): UsageSource;

export function addCanonicalUsage(
  accumulator: UsageAccumulator,
  usage: CanonicalTokenUsage
): void;

export function serializeUsageTotals(
  accumulator: UsageAccumulator
): UsageTotalsV2;
```

---

# 54. `response-usage.ts` 建议 API

```ts
export interface OpenAIResponsesUsage {
  ...
}

export function parseOpenAIResponseUsage(
  usage: unknown
): CanonicalTokenUsage;

export function openAIProtocolUsage(
  usage: CanonicalTokenUsage
): MessagesResponse['usage'];

export function openAIAccountingMetadata(
  usage: CanonicalTokenUsage
): NonNullable<
  MessagesResponse['multi_usage']
>['accounting'];
```

---

# 55. malformed vs unavailable

必须区分：

### unavailable

```json
"usage": null
```

或者：

```text
usage field absent
```

处理：

```text
successful answer
source=unavailable
```

### malformed

例如：

```json
{
  "usage": {
    "input_tokens": -2
  }
}
```

处理：

```text
malformed provider stream
fail translation
```

原因：

```text
Provider 明确给了不合法 telemetry
```

不能默默信任。

---

# 56. Partial Usage 示例

输入：

```json
{
  "input_tokens": 100,
  "input_tokens_details": {
    "cached_tokens": 40
  }
}
```

输出 canonical：

```json
{
  "source": "mixed",
  "inputTokens": 60,
  "cacheReadTokens": 40
}
```

Protocol：

```json
{
  "input_tokens": 60,
  "output_tokens": 0,
  "cache_read_input_tokens": 40
}
```

Accounting：

```text
output unknown
```

不是：

```text
output = 0
```

---

# 57. Provider Explicit Zero 示例

输入：

```json
{
  "input_tokens": 100,
  "output_tokens": 0
}
```

Canonical：

```json
{
  "source": "provider",
  "inputTokens": 100,
  "outputTokens": 0
}
```

这里：

```text
output=0
```

必须保留为 known zero。

---

# 58. Reasoning / Total 示例

输入：

```json
{
  "input_tokens": 1000,
  "input_tokens_details": {
    "cached_tokens": 800,
    "cache_write_tokens": 50
  },
  "output_tokens": 200,
  "output_tokens_details": {
    "reasoning_tokens": 120
  },
  "total_tokens": 1200
}
```

Canonical：

```json
{
  "source": "provider",
  "inputTokens": 150,
  "cacheReadTokens": 800,
  "cacheWriteTokens": 50,
  "outputTokens": 200,
  "reasoningTokens": 120,
  "totalTokens": 1200,
  "cacheReadRatio": 0.8
}
```

---

# 59. Unit Test 设计：OpenAI parser

新增：

```text
test/unit/native-openai-response-usage.test.ts
```

测试矩阵：

```text
full usage
usage absent
usage null
partial input only
partial output only
null input_tokens_details
null output_tokens_details
cache read
cache write
reasoning tokens
provider total
derived total
explicit zero
negative count rejected
fraction rejected
unsafe integer rejected
```

---

# 60. Unit Test：OpenAI stream

扩展：

```text
test/unit/native-openai-stream.test.ts
```

必须继续断言：

```text
message_start:
  estimated input
  output = 0
```

最终：

```text
message_delta:
  provider output
  cache read/write
```

并新增：

```text
result.multi_usage.accounting
reasoning_tokens
total_tokens
source
```

---

# 61. Unit Test：Receipt v2

扩展：

```text
test/unit/native-receipts.test.ts
```

新增场景：

```text
provider explicit zero remains zero
unavailable does not become zero
provider + unavailable -> mixed
provider + estimate -> mixed
reasoning sums
total sums
cache ratio serialized
cancelled without completion -> unavailable
cancelled after one completion -> preserves known usage
harness consumed_* still wins
context remains separate
replayed usage ignored
requestId dedup unchanged
```

---

# 62. Unit Test：Provider Dashboard

扩展：

```text
test/unit/native-provider-usage.test.ts
```

断言：

```text
cache ratio
reasoning
source
unavailable wording
mixed wording
context vs consumed
model calls
```

当前已有：

```text
account data cache
coalescing
refresh
session freshness
authentication
```

这些不得回归。

---

# 63. Unit Test：Usage Menu

当前：

```text
test/unit/native-usage-menu.test.ts
```

Phase A 新增：

```text
--text
invalid args
open isPlaced=false -> text fallback
open throw -> text fallback
```

Phase B 替换 Client key 测试：

```text
ui.render returns direct buttons
selected provider autoFocus
ui.focus changes selected
ui.scroll changes offset
Refresh button refreshes
Close button closes
Receipts lazy load
quota advice toggle remains session scoped
foreign pane ignored
```

---

# 64. Claude Mod Test

除 Node unit test 外，应运行：

```bash
npm run test:mod
```

并增加至少一个 function-hooks 层测试覆盖：

```text
command.run
ui.open
ui.render
ui.focus
ui.close
```

测试重点不是终端字节，而是：

```text
Claude engine event contract
```

---

# 65. Live OpenAI Probe 改造

扩展：

```text
test/live/native-openai-cache.ts
```

当前已经验证：

```text
raw response.completed
Claude final result.usage
cache reuse >= 90%
```

新增四层对账：

```text
raw provider usage
      │
      ▼
MessagesResponse final accounting
      │
      ▼
ReceiptLedger snapshot
      │
      ▼
ProviderUsageDashboard
```

---

# 66. Live Probe Sample

扩展：

```ts
interface Sample {
  ...
  input: number;
  cached: number;
  cacheWrite?: number;
  output: number;
  reasoning?: number;
  total?: number;
}
```

捕获：

```text
output_tokens_details.reasoning_tokens
total_tokens
```

---

# 67. Live Probe Receipt

测试 Gateway 时显式注入：

```ts
const ledger = new ReceiptLedger();
```

运行后：

```ts
const snapshot =
  ledger.snapshot(session);
```

断言：

```text
raw output == snapshot output
raw cached == snapshot cache read
reasoning == snapshot reasoning
source == provider
```

---

# 68. Live Probe Dashboard

传入 deterministic：

```ts
new ProviderUsageDashboard({
  enabled: ['openai'],
  openai: async () => ({
    summary: 'test quota',
    details: []
  })
})
```

然后通过 authenticated route 获取：

```text
/multi/mod/usage?view=providers
```

断言：

```text
cache ratio line
output line
reasoning line
source line
```

避免 Live Probe 因 account quota reader 再启动额外 Codex process。

---

# 69. Orca 手工 E2E

环境记录：

```text
Orca version
Claude Code version
OS
shell/PTY
cc-multi commit
```

步骤：

```text
1. 在有修改文件的 repo 启动 claude-multi
2. 执行官方 /diff
3. 验证 focus/navigation
4. 执行 /multi-usage
5. 验证 provider focus ring
6. 验证 Refresh
7. 验证 Receipts
8. 验证 scroll
9. 验证 Esc
10. 验证 Close button
11. 执行 /multi-usage --text
```

---

# 70. Orca 判定表

### `/diff` 可交互，`/multi-usage` 不可交互

优先判断：

```text
Multi Usage Pane implementation problem
```

### `/diff` 和 `/multi-usage` 都不可交互

优先判断：

```text
Claude Code / Orca terminal integration problem
```

### Interactive 失败但 `--text` 正常

说明：

```text
Usage data plane healthy
UI/focus problem isolated
```

---

# 71. Terminal Matrix

至少验证：

| Host | Interactive | Text | Refresh | Close | Notes |
|---|---|---|---|---|---|
| Windows Terminal | 必须 | 必须 | 必须 | 必须 | native baseline |
| Orca Windows | 目标必须 | 必须 | 必须 | 必须 | reported issue |
| Orca WSL | 验证 | 必须 | 验证 | 验证 | KKP path |
| WSL terminal | 验证 | 必须 | 验证 | 验证 | |
| SSH | 验证 | 必须 | 验证 | 验证 | |
| tmux | 验证 | 必须 | 验证 | 验证 | |
| narrow terminal | 可降级 | 必须 | N/A | N/A | |

---

# 72. 性能约束

Usage UI 不得：

```text
触发模型调用
阻塞 provider inference
轮询 account usage
```

Provider account data 保持：

```text
30s cache
pending coalescing
max 32 simultaneous queries
```

Receipt：

```text
bounded entries
bounded sessions
bounded completed history
```

保持现有容量策略。

---

# 73. 安全约束

`/multi/mod/usage`：

```text
继续 gateway token auth
继续 session scope
继续 read-only
```

Receipt JSONL：

```text
0600 append
不含 prompt
不含 tool input
不含 credentials
```

Trace 同样遵守。

---

# 74. Error Handling

## Account quota refresh 失败

```text
Provider row status = error
保留 session accounting
```

不要让：

```text
quota endpoint failure
```

隐藏：

```text
local session token usage
```

---

## Receipt UI 加载失败

保持旧数据：

```text
Could not load receipts.
```

不能清空 provider rows。

---

## Interactive Pane 打不开

直接：

```text
text fallback
```

---

# 75. 分阶段实施顺序

## Stage 0 — Characterization

```text
MP-0001
MP-0002
MP-0003
MP-0050
MP-0060
```

只加测试，不改行为。

---

## Stage 1 — OpenAI Usage Truth

```text
usage-accounting.ts
response-usage.ts
responses.ts integration
messages.ts additive metadata
```

对应：

```text
MP-0051
MP-0052
MP-0053
```

---

## Stage 2 — Receipt / Dashboard

```text
Receipt schema v2
aggregate source
unknown semantics
cache ratio
reasoning/total
```

对应：

```text
MP-0054
MP-0055
```

---

## Stage 3 — Text Fallback

```text
/multi-usage --text
open result diagnostics
placement fallback
```

对应：

```text
MP-0061
MP-0062
MP-0064
```

此阶段完成后：

> 即使 Orca interactive 问题尚未完全解决，Usage 已不会不可访问。

---

## Stage 4 — Engine-native Pane

```text
hook-owned state
direct ui.render
ui.focus
ui.scroll
Refresh/Close Buttons
Client onKey removal
```

对应：

```text
MP-0063
```

---

## Stage 5 — Verification

```text
MP-0056
MP-0057
MP-0065
MP-0066
MP-0067
```

---

# 76. 推荐 Commit 序列

建议保持可 cherry-pick：

```text
test(usage): characterize OpenAI terminal usage variants

usage: add canonical accounting helpers

openai: preserve full Responses token usage

usage: keep unavailable distinct from zero

receipts: add source-aware schema v2

usage: show cache ratio reasoning and source

usage-ui: add text mode and placement fallback

usage-ui: add explicit refresh and close actions

usage-ui: migrate pane state to Claude Mods focus and scroll

test(usage): extend live OpenAI accounting probe

test(usage-ui): add terminal-host compatibility coverage

docs: document usage accounting and pane fallback
```

---

# 77. Upstream Rebase 策略

每次 upstream 更新：

```text
git fetch upstream
git rebase upstream/main
```

冲突优先级：

## 最容易独立保留

```text
usage-accounting.ts
response-usage.ts
tests
```

## 中等冲突

```text
responses.ts
receipts.ts
provider-usage.ts
```

## 最容易被 upstream UI 改动影响

```text
hooks/usage.ts
hooks/usage-view.ts
```

因此 UI migration 尽量通过：

```text
新 helper + 小 wiring
```

减少 `usage.ts` 大段重写。

---

# 78. Upstream 已修复部分功能时

如果 upstream 已修：

```text
reasoning tokens
```

则跳过对应 commit。

如果 upstream 已修：

```text
Usage Pane focus
```

但没有：

```text
unknown vs zero
```

只保留 accounting commits。

Patchset 不要求所有 commit 永远存在。

---

# 79. 与 Multi-Provider v2 的边界

Multi-Provider v2 可以复用：

```text
CanonicalTokenUsage
Receipt v2
ProviderUsageDashboard
Usage Pane
```

但本分支不得引入：

```text
ProviderRegistry
ProviderDescriptor
DirectProviderAdapter
Pi
Generic API Provider
```

未来 v2 迁移时：

```text
usage accounting
```

作为独立基础模块被 port，而不是让 Patchset 依赖 v2。

---

# 80. Acceptance Criteria — Data

```text
[ ] Full OpenAI usage 保留 output tokens
[ ] Full OpenAI usage 保留 reasoning tokens
[ ] Full OpenAI usage 保留 provider total tokens
[ ] cache read/write 完整
[ ] cache ratio 计算正确
[ ] usage absent 不变成 accounting zero
[ ] explicit zero 保持 known zero
[ ] partial usage 明确 source=mixed
[ ] provisional message_start 不进入 receipt
[ ] harness consumed_* 语义不回退
[ ] live context 与 consumed 保持分离
```

---

# 81. Acceptance Criteria — Receipt

```text
[ ] schemaVersion=2
[ ] totals 有 source
[ ] unknown 字段可省略
[ ] cancelled no-usage 不伪装成 zero
[ ] replay 不重复计费
[ ] requestId dedup 不回退
[ ] reasoning/total 可聚合
[ ] mixed source 可辨识
```

---

# 82. Acceptance Criteria — UI

```text
[ ] /multi-usage --text 永远不依赖 Pane
[ ] placement failure 自动回 text
[ ] Provider 页面可通过 engine focus system 操作
[ ] Receipts 可访问
[ ] Refresh 不依赖 r
[ ] Close 不只依赖 Esc
[ ] ui.scroll 有界
[ ] quota advice 行为不变
[ ] foreign pane/message 不被处理
```

---

# 83. Acceptance Criteria — Compatibility

```text
[ ] 原生 Claude request passthrough 不变化
[ ] 原生 Claude retry/timeout 不变化
[ ] non-Messages raw forwarding 不变化
[ ] OpenAI successful response 不因 usage absent 被 rerun
[ ] Zen requireUsage 行为不意外改变
[ ] npm run check 通过
[ ] npm run test:mod 通过
[ ] native-openai-cache live probe 通过
```

---

# 84. Definition of Done

本 Patchset 完成时应达到：

```text
OpenAI provider telemetry
        │
        ▼
canonical usage
        │
        ├─ Claude protocol view
        └─ accounting truth
              │
              ▼
         Receipt v2
              │
              ▼
       Provider Dashboard
              │
              ▼
       /multi-usage
        ├─ Pane
        └─ Text
```

并保证：

> Usage 数据的正确性不依赖 UI；Usage UI 的可用性不依赖某一种终端宿主；Usage Patchset 的维护不依赖 Multi-Provider v2。

---

# 85. Codex / Claude Code 实施提示

实施时建议严格按以下顺序：

```text
1. 先新增测试锁住现状
2. 新增 usage-accounting.ts
3. 新增 response-usage.ts
4. 修改 responses.ts
5. 修改 messages.ts metadata
6. 修改 receipts.ts
7. 修改 provider-usage.ts
8. 先加 --text 和 placement fallback
9. 再迁移 engine-native Pane
10. 最后做 Live/Orca 验证
```

任何一步如果需要修改：

```text
server provider routing
launcher
worker catalog
provider install architecture
```

应停止并重新评估，因为这已经越过 Usage Patchset 的维护边界。

---

# 86. 源码参考索引

## Multi

- Claude Mods architecture  
  https://github.com/greenpolo/cc-multi-cli-plugin/blob/main/docs/claude-mods.md

- Fork changelog  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/CHANGELOG.md

- Usage hook  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/hooks/usage.ts

- Usage Client  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/hooks/usage-view.ts

- Provider dashboard  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/src/gateway/provider-usage.ts

- Receipt ledger  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/src/gateway/receipts.ts

- Mod usage route  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/src/gateway/mod-usage.ts

- Gateway  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-core/src/gateway/server.ts

- OpenAI Responses translator  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-openai/src/responses.ts

- Existing OpenAI account quota reader  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/plugins/multi-openai/src/usage.ts

## Tests

- OpenAI stream  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/unit/native-openai-stream.test.ts

- OpenAI account usage  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/unit/native-openai-usage.test.ts

- Provider dashboard  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/unit/native-provider-usage.test.ts

- Receipts  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/unit/native-receipts.test.ts

- Usage menu  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/unit/native-usage-menu.test.ts

- Live OpenAI cache probe  
  https://github.com/leedrin/cc-multi-cli-plugin/blob/main/test/live/native-openai-cache.ts

## Claude Mods reference

- Anthropic Mods  
  https://github.com/anthropics/claude-code/tree/main/mods

- Built-in diff Mod  
  https://github.com/anthropics/claude-code/tree/main/mods/diff

## OpenAI token usage reference

- Codex Responses SSE usage implementation  
  https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/sse/responses.rs

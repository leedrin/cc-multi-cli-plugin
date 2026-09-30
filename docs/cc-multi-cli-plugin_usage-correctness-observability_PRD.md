# cc-multi-cli-plugin Usage Correctness & Observability Patchset PRD

> 项目：`greenpolo/cc-multi-cli-plugin` Fork  
> 文档类型：Maintenance PRD + Technical Design  
> 建议分支：`fix/usage-observability`  
> 状态：Draft v1.0  
> 日期：2026-09-30  
> 目标读者：Codex、Claude Code、项目维护者、Reviewer

---

# 0. 文档定位

本 PRD 是一个**可长期跟随 upstream 的低侵入补丁层**，只解决 Usage / Cache / Receipt / `/multi-usage` 的正确性、可观测性和终端宿主兼容问题。

长期目标不是形成新的 Provider 架构，而是始终保有：

```text
latest upstream
    +
stable usage patchset
```

即使 Multi-Provider v2 未来与 upstream 产生较大架构分歧，本分支仍应能够单独 rebase、重建或 cherry-pick 到最新版 upstream。

---

# 1. 分支策略

建议长期维护：

```text
fix/usage-observability
```

直接基于：

```text
upstream/main
```

upstream 更新时优先：

```bash
git fetch upstream
git checkout fix/usage-observability
git rebase upstream/main
```

如果 upstream 已吸收部分修复，则按小提交粒度跳过对应 patch，而不是保留重复实现。

依赖方向必须保持单向：

```text
Usage Patchset  ───────►  可独立存在
      │
      └───────────────►  Multi-Provider v2 可吸收它

Multi-Provider v2  ─X─►  Usage Patchset 不得反向依赖
```

---

# 2. Scope

本 PRD 包含：

```text
OpenAI output token accounting
Prompt cache read/write accounting
Reasoning / total tokens
Unknown vs zero semantics
Canonical usage normalization
Receipt accounting
/multi-usage correctness
Cache read ratio
Text fallback
Pane placement/focus diagnostics
Orca host compatibility
Terminal host regression coverage
Usage/UI tracing
```

---

# 3. Non-goals

本分支明确不做：

```text
ProviderRegistry
ModelIdentity routing redesign
ModelDescriptor provider architecture
DirectProviderAdapter architecture
ProviderRuntime
Generic API Provider
Pi AI
Pi NativeHarness
Dynamic provider plugin loading
Launcher architecture rewrite
Worker catalog architecture rewrite
Gateway provider dispatch redesign
```

如果某个 Usage 修复只有通过上述架构重构才能完成，应优先重新设计为局部 patch；确实无法避免时，将该工作移入 Multi-Provider v2 PRD。

---

# 4. Upstream Compatibility Budget

优先允许修改：

```text
plugins/multi-openai/src/responses.ts
plugins/multi-openai/src/usage.ts
plugins/multi-core/hooks/usage.ts
plugins/multi-core/hooks/usage-view.ts
plugins/multi-core/src/gateway/provider-usage.ts
plugins/multi-core/src/gateway/receipts.ts
Usage-related tests
Usage-related docs
```

尽量避免修改：

```text
plugins/multi-core/src/launcher.ts
plugins/multi-core/src/gateway/server.ts 的 provider routing
plugins/multi-core/src/gateway/worker-catalog.ts 的 provider architecture
plugins/multi-core/src/install/plugins.ts
provider discovery architecture
```

原则：

> PRD A 是 patchset，不是 architecture fork。

---

# 5. Commit Policy

必须保持小提交、单一责任，例如：

```text
usage: preserve unavailable instead of zero
usage: parse OpenAI reasoning and total tokens
usage: add cache read ratio
usage: add text fallback
usage-ui: inspect pane placement result
usage-ui: add explicit refresh and close controls
usage-ui: migrate navigation to ui.focus
test: add terminal-host usage pane regressions
```

禁止将整个 Usage / UI 修复压成一个大型 commit。这样 upstream 如果已经修复其中一项，可以单独跳过对应 patch。

---

# 6. Baseline / Characterization

在修改 accounting 和 UI 之前，先锁定当前行为，避免把已有行为变化误判成修复结果。

### MP-0001 — Existing Provider Matrix Fixture

建立现有 Provider matrix fixture：

```text
openai
zen
cursor
antigravity
grok
```

Acceptance：

```text
npm run check
existing tests unchanged
```

### MP-0002 — Provider Routing Characterization

补齐 provider routing characterization test，确保每个：

```text
multi/<provider>/<model>
```

只路由一次。

### MP-0003 — Public Behavior Snapshot

记录当前 public behavior snapshot：

```text
/model rows
worker type
usage
permission
error
/multi-usage rendering
```

该 snapshot 仅用于确认 Usage patch 没有意外改变 Provider/Worker 行为；不得借此开始 Provider architecture refactor。

---

# 7. OpenAI Usage / Cache Accounting 修复（新增，优先级 P0）

## 79.1 问题与初步根因

实际使用中观察到：

```text
OpenAI output_tokens = 0
缓存命中率不可见
```

结合当前代码，存在四个关键点：

1. `ResponseStream.start()` 在 `message_start` 中故意发送 provisional usage：

```ts
usage: {
  input_tokens: estimatedInputTokens,
  output_tokens: 0
}
```

真实 Provider usage 只有在 terminal event 后的 `message_delta.usage` 中补齐。因此只读取 `message_start` 的 UI/统计路径会一直看到 `output_tokens = 0`。

2. OpenAI 路径调用 `fromResponses()` 时没有像 Zen 那样启用 `requireUsage: true`。terminal usage 缺失时，当前实现会静默落成：

```text
output_tokens = 0
cache_read_input_tokens = 0
cache_creation_input_tokens = 0
multi_usage.source = unavailable
```

这会让“usage 未提供”和“真实值为 0”混在一起。

3. 当前 `ResponsesUsage` 没有完整保存当前 OpenAI/Codex usage schema 中的：

```text
output_tokens_details.reasoning_tokens
total_tokens
```

4. `ProviderUsageDashboard` 当前显示 cache read/write 的绝对 token 数，但没有计算 token-weighted cache hit ratio。

因此该问题应在 Provider Registry 重构前修复，作为基线正确性工作。

---

---

# 8. 修复原则

不能简单把 OpenAI 改成：

```ts
requireUsage: true
```

然后 usage 缺失就让整个回答失败。

更稳妥的语义是：

```text
Provider usage present
    ↓
validate + preserve precisely

Provider usage absent
    ↓
complete answer normally
    ↓
mark source = unavailable
    ↓
UI displays unavailable, not fake zero
```

核心原则：

```text
0 tokens != unavailable tokens
```

---

---

# 9. Canonical Usage 类型

新增统一 usage model：

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

  /**
   * Token-weighted prompt cache read ratio.
   */
  cacheReadRatio?: number;
}
```

规则：

- `undefined` = unknown
- `0` = Provider 明确报告 0
- accounting 层禁止通过 `?? 0` 把未知值伪装成真实 0

---

---

# 10. OpenAI Responses Usage Parser

新增：

```text
plugins/multi-openai/src/usage.ts
```

接口建议：

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

export function parseOpenAIUsage(
  usage: unknown
): CanonicalTokenUsage;
```

必须兼容：

```text
usage absent
input_tokens_details absent/null
cached_tokens absent
cache_write_tokens absent
output_tokens_details absent/null
reasoning_tokens absent
total_tokens absent
```

Telemetry shape 不完整时不得重新执行已经成功完成的模型请求。

---

---

# 11. Streaming Usage 生命周期

明确：

```text
message_start
  ↓
provisional usage
  ↓
content streaming
  ↓
response.completed / done / incomplete
  ↓
final provider usage
  ↓
message_delta
  ↓
message_stop
```

内部应显式区分：

```ts
type UsageState =
  | {
      phase: 'provisional';
      estimatedInputTokens?: number;
    }
  | {
      phase: 'final';
      usage: CanonicalTokenUsage;
    };
```

Receipt / Dashboard 不能把 provisional usage 当成最终统计。

---

---

# 12. Anthropic Protocol Compatibility 与真实 Accounting 分离

`MessagesResponse.usage` 需要继续满足 Claude Code / Anthropic-compatible schema。

但 accounting truth 应放在：

```ts
MessagesResponse.multi_usage
```

并明确包含：

```text
source
reasoning_tokens
total_tokens
cache read/write provenance
```

当 Provider usage 缺失时：

```ts
multi_usage.source = 'unavailable'
```

UI / receipt 必须优先读取 `source`，不能把协议兼容占位值 0 当成真实统计。

---

---

# 13. Cache Hit Rate 定义

显示：

> token-weighted cache read ratio

定义：

```text
cache_read_ratio =
cache_read_tokens
/
(
  uncached_input_tokens
  + cache_read_tokens
  + cache_write_tokens
)
```

例如：

```text
uncached input:  1,000
cache read:      8,000
cache write:     1,000
total prompt:   10,000

cache hit ratio = 80.0%
```

不要将其表述为 request-level cache hit rate。

---

---

# 14. `/multi-usage` 改进

建议显示：

```text
Input: 10,000 total
  uncached: 1,000
  cached read: 8,000 (80.0%)
  cache written: 1,000

Output: 1,240
Reasoning: 860
Source: provider
```

当 usage 缺失：

```text
Output: unavailable
Cache: unavailable
Source: unavailable
```

而不是：

```text
Output: 0
Cache: 0
```

---

---

# 15. Receipt Schema v2

建议：

```ts
interface UsageTotalsV2 {
  source: UsageSource;

  input_tokens?: number;
  output_tokens?: number;

  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;

  reasoning_tokens?: number;
  total_tokens?: number;

  cache_read_ratio?: number;
}
```

要求：

- v1 receipt 继续可读
- unknown 不自动转 0
- mixed provider/estimate 明确标记 `mixed`
- receipt 能保留 reasoning / total / cache ratio

---

---

# 16. 安全诊断模式

新增：

```text
MULTI_USAGE_TRACE=1
```

只允许打印 usage metadata，例如：

```json
{
  "provider": "openai",
  "event": "response.completed",
  "usagePresent": true,
  "inputTokens": 12345,
  "cachedTokens": 10000,
  "cacheWriteTokens": 500,
  "outputTokens": 1200,
  "reasoningTokens": 900,
  "totalTokens": 13545
}
```

禁止打印：

```text
prompt
response content
tool arguments
API key
Authorization header
encrypted reasoning state
```

---

---

# 17. 快速定位路径

使用：

```text
MULTI_RECEIPTS_FILE=<path>
```

判断问题在哪一层。

### Case A

```text
receipt:
output > 0
cache_read > 0

Claude UI:
output = 0
```

说明：

```text
Gateway accounting 正常
→ Claude UI / SSE aggregation path 问题
```

### Case B

```text
receipt:
output = 0
cache_read = 0
source = unavailable
```

说明：

```text
terminal usage 未被 gateway 正确获取
→ Responses parser / upstream event shape 问题
```

### Case C

```text
raw terminal usage:
output > 0

receipt:
output = 0
```

说明：

```text
gateway normalization / completionEvent / receipt bug
```

---

---

# 18. Usage 修复任务拆分

## MP-0050 — Characterize OpenAI Usage

增加 fixture：

```text
message_start provisional usage
terminal full usage
terminal usage absent
terminal partial usage
terminal null details
```

Acceptance：

```text
unavailable usage 不得被断言为 provider-reported zero
```

## MP-0051 — Preserve Full OpenAI Usage

扩展：

```text
output_tokens_details.reasoning_tokens
total_tokens
```

确保进入：

```text
multi_usage
receipt
dashboard
```

## MP-0052 — Remove Silent Zero Accounting

清理 accounting 层中的：

```ts
usage?.output_tokens ?? 0
```

这类未知→0 逻辑。

协议层若必须输出数值，可使用兼容占位值；accounting 层必须保留 `source = unavailable`。

## MP-0053 — Cache Ratio

实现：

```ts
cacheReadRatio()
```

测试：

```text
0 input
no cache
100% cache
cache write
mixed read/write
```

## MP-0054 — Usage Dashboard

显示：

```text
total input
uncached input
cache read
cache write
cache read ratio
output
reasoning
source
```

## MP-0055 — Receipt v2

保留：

```text
source
reasoning
total
cache ratio
unknown
```

## MP-0056 — OpenAI Live Probe

扩展：

```text
test/live/native-openai-cache.ts
```

对账：

```text
raw response.completed usage
        ↓
gateway final message_delta usage
        ↓
ReceiptLedger
        ↓
/multi-usage snapshot
```

四层数值必须一致。

## MP-0057 — UI Regression

E2E：

```text
OpenAI streamed response
→ final output_tokens > 0
→ cached tokens visible
→ cache ratio visible
```

如果 Claude Code 原生 usage UI 不支持自定义 cache ratio：

```text
/multi-usage 必须准确显示
```

并记录 native UI limitation。

---

---

# 19. `/multi-usage` 在 Orca 中的交互兼容性问题（新增，优先级 P1）

## 93.1 现象

在 Orca（`https://github.com/stablyai/orca`）内启动 `claude-multi` 后执行：

```text
/multi-usage
```

Usage Pane 能正常渲染，包括：

```text
[All]
[OpenAI / Codex]
[Cursor]
[OpenCode Zen]
[Antigravity]
[Grok Build]

1–1 of 15
←/→ providers
↑/↓ scroll
r refresh
Esc close

[Refresh]
```

但实际交互失效：

```text
方向键不能切换 Provider
上下键不能滚动
r 不能刷新
Esc 不能关闭
Refresh Button 无法通过键盘操作
```

同时可以观察到：

> 键盘光标仍然停留在 Claude Code 的底部 Composer / 输入框中。

这说明：

```text
Gateway usage request       正常
ui.render(Pane)              正常
Client module                正常
Usage data                   正常
Pane visual rendering        正常

Pane focus / keyboard input  异常
```

因此该问题不应归类为 Gateway 或 Usage API 故障，而应归类为：

```text
Claude Mods Pane focus / terminal-host compatibility
```

---

---

# 20. 当前 `/multi-usage` UI 架构

当前链路：

```text
/multi-usage
    ↓
command.run
    ↓
$.ui.open({
  id: 'multi-usage',
  focus: true,
  closeOnEscape: true,
  rows: 20
})
    ↓
ui.render(Pane)
    ↓
Client({
  module: './usage-view.ts'
})
    ↓
surface.onKey(...)
```

`usage-view.ts` 当前依赖：

```ts
surface.onKey((event) => {
  if (event.key === 'r') {
    surface.post({ action: refreshAction });
  }

  if (event.key === 'up' || event.key === 'down') {
    // scroll
  }

  if (event.key === 'left' || event.key === 'right') {
    // provider selection
  }
});
```

这意味着：

> Client Pane 必须真正取得 Claude Code 内部键盘焦点，否则整个交互层全部失效。

UI 本身仍然可以正常渲染，因此会形成：

```text
UI 看起来正常
但是完全不能操作
```

---

---

# 21. 焦点模型

需要明确区分两个不同层级的 focus：

```text
Orca / xterm DOM focus
        │
        │
        ▼
Claude Code terminal process
        │
        ├── Composer
        │
        └── Mod Pane
```

当前 Orca 场景中：

```text
Orca → Claude Code
```

这一层大概率正常，因为：

```text
Composer 仍然可以输入
```

失败更可能发生在：

```text
Claude Code internal focus
Composer
    ↓
Pane
```

即：

```text
$.ui.open({ focus: true })
```

提出了 focus request，但 Pane 没真正获得焦点。

---

---

# 22. `focus: true` 不是强制焦点

Claude Mods 的：

```ts
$.ui.open({
  focus: true
})
```

应视为：

```text
focus request
```

而不是：

```text
force focus
```

某些状态下：

```text
Pane placed successfully
    ↓
Pane rendered successfully
    ↓
focus request not granted
    ↓
keyboard remains in Composer
```

当前 `multi-usage` 的问题之一是：

```ts
await $.ui.open(...)
```

之后没有检查 open result。

建议至少保存：

```ts
const opened = await $.ui.open(...);
```

并检查：

```text
opened?.isPlaced
opened?.reason
```

但需要注意：

```text
isPlaced = true
```

不必然意味着：

```text
keyboard focus granted
```

因此 placement diagnostics 只是第一层改进。

---

---

# 23. Orca 作为触发环境

Orca 不是 dumb terminal。

Orca terminal 基于：

```text
xterm.js
```

并额外处理：

```text
Kitty Keyboard Protocol
CSI-u
IME
Ctrl+C
clipboard
terminal focus
custom key event routing
ConPTY compatibility
```

因此：

```text
physical keyboard
      ↓
Orca/xterm encoding
      ↓
PTY
      ↓
Claude Code
      ↓
Claude Mod Pane
```

比普通 terminal 多一层复杂 keyboard protocol。

目前没有足够证据说明 Orca 直接吞掉了：

```text
r
ArrowLeft
ArrowRight
ArrowUp
ArrowDown
Escape
```

因此不要将问题简单归因为：

```text
Orca keyboard bug
```

更合理的分类：

> `multi-usage` 的 UI 对 Client keyboard focus 依赖过强，而 Orca 的终端/键盘环境稳定暴露了这个假设。

---

---

# 24. 设计目标

新的 Usage UI 必须满足：

```text
1. Usage 数据获取与 UI 交互能力解耦
2. Pane 无法获得焦点时，Usage 仍然可查看
3. 核心交互不依赖 Client 自己解释底层键盘序列
4. 不为 Orca 写 provider/host-specific hardcode
5. 普通 Terminal / Orca / tmux / SSH / ConPTY 都能降级工作
```

核心原则：

```text
Interactive UI = progressive enhancement
Usage data     = always available
```

---

---

# 25. Text Fallback

增加：

```text
/multi-usage --text
```

或者：

```text
/multi-usage text
```

输出示例：

```text
Multi Usage

OpenAI / Codex

  Status:
    available

  Context:
    input             42,861
    uncached input    11,117
    cache read        31,744
    cache write            0
    cache ratio        74.1%

  Output:
    output             4,827
    reasoning          3,116

Cursor
  ...

OpenCode Zen
  ...
```

Text mode 不应依赖：

```text
Pane
Client
focus
surface.onKey
Button
ui.focus
```

仅依赖：

```text
/multi/mod/usage
```

因此它应成为所有 terminal host 的可靠 fallback。

---

---

# 26. 自动降级策略

建议：

```text
/multi-usage
     ↓
fetch usage
     ↓
attempt interactive pane
     │
     ├── usable
     │     ↓
     │ interactive mode
     │
     └── unavailable / placement refused
           ↓
       text fallback
```

第一阶段可以处理：

```ts
const opened = await $.ui.open(...);

if (
  opened &&
  opened.isPlaced === false
) {
  return {
    text: renderUsageText(
      response,
      opened.reason
    )
  };
}
```

但这还不能覆盖：

```text
Pane rendered
focus not granted
```

因此第二阶段应减少对 Pane-exclusive interaction 的依赖。

---

---

# 27. Engine-Native Usage Pane

当前：

```text
Client
  ↓
surface.onKey()
```

建议逐步改成 Claude Code engine-native interaction：

```text
Pane
  │
  ├── Button: All
  ├── Button: OpenAI
  ├── Button: Cursor
  ├── Button: Zen
  ├── Button: Antigravity
  ├── Button: Grok
  ├── Button: Receipts
  └── Button: Refresh

Claude Code
  │
  ├── autoFocus
  ├── ui.focus
  ├── ui.press
  └── ui.scroll
```

即：

```text
physical key
     ↓
terminal host
     ↓
Claude Code
     ↓
Claude Code focus/navigation system
     ↓
ui.focus / ui.press / ui.scroll
     ↓
Multi state
```

而不是：

```text
physical key
     ↓
terminal host
     ↓
Client surface.onKey()
     ↓
Multi manually decodes keys
```

---

---

# 28. Usage Pane State 重构

当前 state：

```ts
type State = {
  selected: string;
  offset: number;
};
```

保存在：

```text
Client surface.state
```

建议迁移到 Mod-owned state：

```ts
export interface UsagePaneUiState {
  selectedProviderId: string;
  offset: number;
  mode: 'providers' | 'receipts';
}

export interface UsagePaneSessionState {
  data: UsagePaneProps;
  ui: UsagePaneUiState;
}
```

例如：

```ts
const panes =
  new Map<string, UsagePaneSessionState>();
```

行为：

```text
ui.focus
    ↓
update selected provider

ui.scroll
    ↓
update offset

ui.press Refresh
    ↓
fetch new usage

ui.press Receipts
    ↓
load receipt data

state changed
    ↓
$.ui.invalidate('ui.render')
```

这样：

```text
Client local state
```

不再是 Usage UI 的唯一状态来源。

---

---

# 29. Provider Tabs 交互

建议 provider tabs 保留 Button：

```text
[All]
[OpenAI / Codex]
[Cursor]
[OpenCode Zen]
[Antigravity]
[Grok Build]
[Receipts]
```

使用：

```ts
Button({
  key: provider.id,
  autoFocus: selected,
  onPress: () => selectProvider(provider.id)
});
```

并监听：

```ts
on('ui.focus', ...)
```

让 Claude Code 的 focus ring 成为 provider navigation 的主要机制。

---

---

# 30. Scroll 行为

当前：

```text
↑ / ↓
```

由：

```ts
surface.onKey()
```

自己处理。

建议：

```ts
on('ui.scroll', { requestId: 'multi-usage' }, ...)
```

负责：

```text
wheel
trackpad
Page Up
Page Down
```

对于逐项 provider 导航使用 focus ring。

如果 Claude Code Pane 无法直接提供预期的逐行 keyboard scroll，则保留：

```text
Page Up
Page Down
Previous
Next
```

按钮作为 fallback。

---

---

# 31. Refresh 行为

Refresh 不应依赖：

```text
r hotkey
```

`r` 可以保留为 enhancement，但必须提供：

```text
[ Refresh ]
```

并保证：

```text
ui.press
```

即可刷新。

最终：

```text
Mouse/keyboard focus ring
    ↓
Refresh Button
    ↓
ui.press
    ↓
gateway
```

因此即使：

```text
surface.onKey
```

不工作，主要功能仍可操作。

---

---

# 32. Esc / Close

`closeOnEscape: true`

继续保留。

同时增加显式：

```text
[ Close ]
```

Button。

目的：

```text
Esc compatibility issue
```

不能导致用户进入一个无法退出的 Pane。

---

---

# 33. Interaction Capability / Host Diagnostics

建议增加：

```text
MULTI_UI_TRACE=1
```

记录：

```json
{
  "command": "multi-usage",
  "surface": "terminal",
  "pane": {
    "requested": true,
    "placed": true,
    "reason": null
  }
}
```

如果能够通过当前 Claude Mods API 观察：

```text
ui.focus
```

则记录：

```json
{
  "event": "ui.focus",
  "requestId": "multi-usage",
  "element": "openai"
}
```

禁止记录：

```text
prompt
model output
API keys
credentials
tool arguments
```

---

---

# 34. Host Capability Model

不要写：

```ts
if (host === 'orca') {
  ...
}
```

建议未来定义：

```ts
export interface UiCapabilities {
  pane: boolean;
  client: boolean;
  focus: boolean;
  keyboardNavigation: boolean;
  scroll: boolean;
}
```

当前不一定有足够 API 自动检测所有 capability，因此第一版可采用：

```text
optimistic interactive
       ↓
diagnostics
       ↓
text fallback
```

以后 Claude Mods 暴露更多 capability 后再升级。

---

---

# 35. Orca Compatibility Test Matrix

至少覆盖：

```text
Host                         Expected
----------------------------------------------------
Windows Terminal             interactive
PowerShell terminal          interactive
Orca Windows ConPTY          interactive or text fallback
Orca WSL                     interactive
Orca remote runtime          interactive
tmux                         interactive
SSH                          interactive
narrow terminal              text fallback / clear warning
non-interactive              text output
```

重点测试：

```text
Pane render
initial focus
provider switch
scroll
refresh
receipts
close
reopen
```

---

---

# 36. Claude Code Version Matrix

Claude Mods 属于快速变化 API。

Usage UI 回归测试至少记录：

```text
Claude Code version
terminal host
OS
interactive result
```

建议测试：

```text
minimum supported Claude Code
current pinned Claude Code
latest supported Claude Code
```

避免：

```text
开发机最新版可用
=
所有用户都可用
```

这一错误假设。

---

---

# 37. 诊断 A/B 测试

加入开发验证流程：

## Test A — Official `/diff`

在同一 Orca Claude Code 会话运行：

```text
/diff
```

如果：

```text
/diff focus/navigation works
/multi-usage does not
```

则重点定位：

```text
multi-usage Client/onKey architecture
```

而不是：

```text
Orca global terminal input
```

## Test B — Native Terminal

同一：

```text
claude-multi
Claude Code version
repository
```

分别在：

```text
Windows Terminal
Orca
```

执行：

```text
/multi-usage
```

如果：

```text
native terminal works
Orca fails
```

则说明存在：

```text
host-triggered focus/protocol compatibility
```

## Test C — Text Mode

所有 host：

```text
/multi-usage --text
```

必须得到一致 Usage 数据。

---

---

# 38. Usage Pane 任务拆分

## MP-0060 — Characterize Pane Focus

目标：

确认以下状态：

```text
pane requested
pane placed
pane rendered
ui.focus emitted
surface.onKey received
```

加入诊断 fixture。

Acceptance：

```text
能够明确区分：
render failure
placement failure
focus failure
key delivery failure
```

---

## MP-0061 — Text Usage Fallback

实现：

```text
/multi-usage --text
```

Acceptance：

```text
不依赖 Pane
不依赖 Client
不依赖 focus
所有 Provider 可读
Usage v2 字段完整
```

---

## MP-0062 — Pane Open Diagnostics

修改：

```ts
await $.ui.open(...)
```

为：

```ts
const opened = await $.ui.open(...)
```

检查：

```text
isPlaced
reason
```

并在 placement failure 时返回 text view。

---

## MP-0063 — Engine-Native Usage Pane

减少核心功能对：

```text
surface.onKey()
```

的依赖。

Provider selection 改为：

```text
Button
autoFocus
ui.focus
ui.press
```

滚动优先使用：

```text
ui.scroll
```

Acceptance：

```text
方向键导航由 Claude Code focus system 负责
主要操作无需 Client key parser
```

---

## MP-0064 — Explicit Refresh / Close Controls

增加：

```text
Refresh
Close
Receipts
```

显式 Button。

Acceptance：

```text
即使 r / Esc shortcut 不工作，UI 仍然可完整操作。
```

---

## MP-0065 — Orca Compatibility E2E

加入 Orca compatibility checklist：

```text
launch claude-multi
/multi-usage
pane visible
focus usable OR fallback visible
provider navigation
refresh
receipts
close
```

如果 CI 难以直接运行 Orca GUI：

```text
保留 reproducible manual integration suite
+
xterm/PTY protocol fixture
```

---

## MP-0066 — Terminal Host Regression Matrix

测试：

```text
Windows ConPTY
WSL
SSH
tmux
xterm/kitty-enabled
standard ANSI
```

确保：

```text
interactive failure never makes usage inaccessible
```

---

## MP-0067 — UI Trace

实现：

```text
MULTI_UI_TRACE=1
```

只记录：

```text
surface
placement
focus transitions
ui.press
ui.scroll
```

不得记录敏感内容。

---

---

# 39. Phase 0B Definition of Done

```text
[ ] `/multi-usage --text` 在无 UI 环境正常工作
[ ] Pane placement failure 自动给出 text fallback
[ ] Usage 数据不因 Pane/focus failure 丢失
[ ] Provider tabs 可通过 Claude engine focus system 导航
[ ] Refresh 不依赖 r hotkey
[ ] Close 不只依赖 Esc
[ ] Receipts 不依赖 Client keyboard parser
[ ] Orca 可正常交互，或明确自动降级
[ ] Windows Terminal 行为不回归
[ ] WSL/tmux/SSH 至少完成 compatibility verification
[ ] UI trace 不泄露 prompt / response / credentials
```

---

---

# 40. 架构结论

`multi-usage` 不应再被设计为：

```text
Client focus available
        =
Usage feature available
```

而应该是：

```text
                    Usage Data
                        │
              ┌─────────┴─────────┐
              │                   │
       Interactive UI         Text UI
              │                   │
       progressive             baseline
       enhancement             capability
```

因此最终契约是：

> Usage accounting 是核心能力；Interactive Pane 只是其中一个 presentation adapter。

这也与 Multi-Provider 架构方向一致：

```text
Provider
   ↓
Canonical Usage
   ↓
Usage Service
   ↓
┌─────────────────────────────┐
│ Claude Pane                 │
│ Text                        │
│ Receipt                     │
│ Future Desktop/Web Surface  │
└─────────────────────────────┘
```

这样未来增加：

```text
Pi AI
OpenRouter
DeepSeek
Google
Kimi
MiniMax
ZAI
```

时，Provider usage 不需要知道当前使用：

```text
Orca
Windows Terminal
tmux
Claude Desktop surface
```

Presentation 与 Provider accounting 完全解耦。

---

# 41. 独立实施顺序

本 PRD 自身只包含三个阶段：

```text
Phase U0
Baseline / Characterization
    ↓
Phase U1
Usage + Cache Accounting Correctness
    ↓
Phase U2
Usage Pane Host Compatibility
```

建议第一批：

```text
MP-0001
MP-0002
MP-0003

MP-0050
MP-0051
MP-0052
MP-0053
MP-0054
MP-0056

MP-0060
MP-0061
MP-0062
MP-0064
MP-0067
```

第二批：

```text
MP-0055
MP-0057
MP-0063
MP-0065
MP-0066
```

不得在本分支顺手启动 `MP-01xx` 以后与 ProviderRegistry 相关的架构任务。

---

# 42. Patchset Definition of Done

```text
[ ] OpenAI final output token 可追踪
[ ] cache read/write 可追踪
[ ] reasoning token 可追踪
[ ] total token 可追踪
[ ] unavailable 不伪装成 0
[ ] /multi-usage 显示 token-weighted cache ratio
[ ] upstream → gateway → receipt → dashboard 可对账
[ ] /multi-usage --text 在无 UI 环境正常工作
[ ] Pane placement failure 自动给出 text fallback
[ ] Usage 数据不因 Pane/focus failure 丢失
[ ] Provider tabs 可通过 Claude engine focus system 导航
[ ] Refresh 不依赖 r hotkey
[ ] Close 不只依赖 Esc
[ ] Receipts 不依赖 Client keyboard parser
[ ] Orca 可正常交互，或明确可靠降级
[ ] Windows Terminal 行为不回归
[ ] WSL/tmux/SSH 完成 compatibility verification
[ ] UI trace 不泄露 prompt / response / credentials
[ ] 分支可以从最新 upstream 重新 rebase 或重建
```

---

# 43. 与 Multi-Provider v2 的接口

Multi-Provider v2 可以吸收本 patchset，但应通过稳定的领域接口消费 Usage，而不是依赖本 PRD 的 Pane 实现细节。

推荐逻辑关系：

```text
Provider / Harness
      ↓
Canonical Usage
      ↓
Usage Service
      ↓
Receipt / Text / Claude Pane
```

Multi-Provider v2 若引入新的 Provider，只需生产 Canonical Usage；不应重新定义 `/multi-usage` 的终端宿主逻辑。

本 PRD 的任务编号 `MP-000x / MP-005x / MP-006x` 保持不变，便于从原 v1.2 和后续提交历史中追踪。

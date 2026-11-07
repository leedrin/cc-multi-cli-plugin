# usage-compatibility Specification

## Purpose
TBD - created by archiving change usage-correctness-observability. Update Purpose after archive.

## Requirements

### Requirement: 原生 Claude passthrough 零侵入
为统计 usage,系统 MUST NOT 解析 Anthropic 原生 stream、重写 Anthropic SSE、注入 Claude usage、改变 Claude retry、改变 Claude 原生 API timeout、改变 Anthropic headers,或改变非 Messages `/v1/*` 的原样转发。Usage 统计 SHALL 只针对 Multi provider completion;`route = anthropic` 且没有 provider completion usage 的事件 SHALL 继续被 `ReceiptLedger` 忽略。

#### Scenario: Anthropic 请求原样转发
- **WHEN** Claude 原生 Messages 请求经过网关
- **THEN** 请求与响应流 SHALL 与变更前逐字节一致

#### Scenario: anthropic 路由不入账
- **WHEN** `route = anthropic` 的事件没有 provider completion usage
- **THEN** `ReceiptLedger.observe()` SHALL 忽略它

#### Scenario: 非 Messages 请求原样转发
- **WHEN** 非 Messages 的 `/v1/*` 请求经过网关
- **THEN** 它 SHALL 被原样转发,不受本变更影响

### Requirement: Harness context 与 consumption 语义不回退
Cursor、Antigravity、Grok 的标准 `MessagesResponse.usage` SHALL 继续表示最近一次模型调用 / live context;`multi_usage.consumed_*` SHALL 继续表示整个 harness turn 的消耗。Receipt v2 改造 MUST NOT 把 turn sums 重新写回标准 usage。

#### Scenario: harness 标准 usage 保持
- **WHEN** Grok 一次 turn 的 terminal 事件带 sums
- **THEN** 标准 usage SHALL 仍为最后一次调用,sums SHALL 仍在 `consumed_*`

#### Scenario: Cursor 只报告 run sums
- **WHEN** Cursor SDK 只报告每次 run 的合计
- **THEN** 标准 usage 字段 SHALL 携带 run sums,且 `model_calls` 保持未报告

### Requirement: Usage UI 只使用 Claude Mods
Usage UI SHALL 只使用 Claude Mods function hooks(`command.run`、`ui.open`、`ui.render`、`ui.focus`、`ui.press`、`ui.scroll`、`ui.close`、`$.http.fetch`)与既有的认证 `/multi/mod/*` 控制面。系统 MUST NOT 引入替代终端渲染器、Claude 之外的 Ink 应用、tmux overlay、Orca 专用 IPC、合成的 model tool 或 prompt 驱动的 usage UI。gateway 请求 SHALL 继续使用 `MULTI_MOD_GATEWAY_URL`、`MULTI_GATEWAY_TOKEN`、`x-multi-gateway-token`,usage 请求超时保持 8.5 秒。

#### Scenario: 无替代渲染器
- **WHEN** 审查本变更引入的 UI 代码
- **THEN** SHALL NOT 出现替代终端渲染器或宿主专用通道

#### Scenario: 请求认证保持
- **WHEN** hook 请求 `/multi/mod/usage`
- **THEN** 它 SHALL 携带 `x-multi-gateway-token`,并保持 8.5 秒超时

### Requirement: 成功响应不因 usage 缺失而重跑
provider 响应已成功完成但 usage 缺失时,系统 SHALL 返回成功模型输出并标记 `source = "unavailable"`,MUST NOT 抛出可重试的 provider 错误,MUST NOT 重跑付费请求。telemetry 形状不完整 MUST NOT 使已成功的模型请求重新执行。

#### Scenario: 缺失 usage 不重试
- **WHEN** OpenAI 成功完成但缺失 usage
- **THEN** 网关 SHALL NOT 再次调用上游

### Requirement: 补丁层边界
已归档的 usage-correctness-observability 变更是可长期跟随 upstream 的低侵入补丁层，它对 ProviderRegistry、ModelIdentity、ModelDescriptor、DirectProviderAdapter、ProviderRuntime、Pi AI 以及 launcher、worker catalog、gateway dispatch 的禁止只约束该补丁层本身。Multi-Provider v2 按“可吸收”条款吸收补丁层，可以引入上述结构，但 MUST NOT 让本能力和 usage 相关能力的其他要求回退。依赖方向 SHALL 单向：usage-accounting MUST NOT import Registry 或任何 provider 模块，provider 一侧依赖 usage-accounting。Generic API Provider、Pi NativeHarness 和动态 provider 插件加载仍不在 v2 首批范围内。

#### Scenario: 不触碰受限文件
- **WHEN** 审查 usage 补丁层（已归档的 usage-correctness-observability）的 diff
- **THEN** `plugins/multi-core/src/launcher.ts`、`server.ts` 的 provider routing、`worker-catalog.ts`、`install/plugins.ts` SHALL 无修改（除 `server.ts` 的 type-compatible 增量）；该约束不适用于 Multi-Provider v2

#### Scenario: 需要越界时停止
- **WHEN** 某个 usage 修复只能通过 provider 架构重构完成
- **THEN** 该工作 SHALL 移出 usage 补丁层，并进入 Multi-Provider v2

#### Scenario: v2 不让 usage 回退
- **WHEN** Multi-Provider v2 完成后运行 usage 相关的既有测试
- **THEN** 它们 SHALL 全部通过，且断言没有修改

#### Scenario: 依赖方向
- **WHEN** 检查 usage-accounting 模块的 import
- **THEN** SHALL 不出现 Registry 或 `plugins/multi-*` 下的模块

#### Scenario: 首批范围之外的结构
- **WHEN** 审查 Multi-Provider v2 首批的 diff
- **THEN** SHALL 不包含 Generic API Provider、Pi NativeHarness 或动态 provider 插件加载

### Requirement: 可 rebase 的小提交
变更 SHALL 拆成单一责任的小提交,使 upstream 已吸收某项修复时可单独跳过对应 patch,例如 `usage: preserve unavailable instead of zero`、`usage: parse OpenAI reasoning and total tokens`、`usage: add cache read ratio`、`usage: add text fallback`、`usage-ui: inspect pane placement result`、`usage-ui: add explicit refresh and close controls`、`usage-ui: migrate navigation to ui.focus`、`test: add terminal-host usage pane regressions`。MUST NOT 将整个 Usage / UI 修复压成一个大型 commit。新逻辑 SHALL 优先落在新增 helper 模块与小段 wiring,减少 `usage.ts` 大段重写。

#### Scenario: 提交粒度
- **WHEN** 审查提交历史
- **THEN** 每个提交 SHALL 只承担一个可独立 cherry-pick 或跳过的责任

#### Scenario: upstream 已修复部分
- **WHEN** upstream 已修复 reasoning tokens
- **THEN** SHALL 可跳过对应 commit 而不影响其余 accounting commits

### Requirement: 性能与安全约束
Usage UI MUST NOT 触发模型调用、阻塞 provider 推理或轮询账户 usage。Provider 账户数据 SHALL 保持 30 秒缓存、pending 合并与最多 32 个并发查询;收据 SHALL 保持 bounded entries、sessions 与 completed history。`/multi/mod/usage` SHALL 继续 gateway token 认证、session 范围与只读。

#### Scenario: 打开 Pane 不推理
- **WHEN** 用户打开或刷新 Pane
- **THEN** 系统 SHALL 只执行只读账户查询,不进行模型推理

#### Scenario: 容量策略保持
- **WHEN** 收据条目超过既有上限
- **THEN** 既有截断与淘汰行为 SHALL 保持不变

## Why

实际使用中 OpenAI/Codex 路径出现 `output_tokens = 0` 且缓存命中率不可见,原因是 provider 未报告的 usage 被静默压成 0("未知"与"真实为 0"混淆),`reasoning_tokens` / `total_tokens` 没有完整保留,`/multi-usage` 也不计算 token-weighted cache read ratio。同时 `/multi-usage` 在 Orca 等终端宿主中 Pane 能渲染但键盘焦点仍停在 Composer,方向键 / `r` / `Esc` 全部失效,而当前实现既没有检查 `$.ui.open()` 结果,也没有文本降级路径,导致 Usage 数据在宿主兼容性问题下"看得见、用不了"。这两类问题都属于基线正确性,应在任何 Provider 架构重构之前,以可长期 rebase 到 upstream 的低侵入补丁层修复。

## What Changes

- 新增统一的 canonical usage 模型(`CanonicalTokenUsage` / `UsageSource`),固定语义:`undefined` = 未知,`0` = provider 明确报告 0;accounting 层禁止用 `?? 0` 把未知值伪装成 0。
- 新增 OpenAI Responses 响应级 usage 解析(`plugins/multi-openai/src/response-usage.ts`,**不**复用已被 Codex 账户配额占用的 `plugins/multi-openai/src/usage.ts`):保留 `reasoning_tokens`、`total_tokens`、cache read/write;区分 `unavailable`(usage 缺失,成功回答照常返回)与 `malformed`(非法数值,失败)。OpenAI 保持 `requireUsage: false`,不因 telemetry 缺失重跑已成功的付费请求。
- 协议层 `MessagesResponse.usage` 继续满足 Anthropic 兼容 schema;accounting truth 放入新增的 `MessagesResponse.multi_usage.accounting`,协议占位 0 不得进入 accounting。
- `ReceiptLedger` 升级到 schema v2:totals 带 `source`,未知字段可省略,聚合 source 合并规则(`mixed`),`reasoning_tokens` / `total_tokens` / `cache_read_ratio` 可聚合;无任何 provider completion 的 failed/cancelled 收据记为 `unavailable` 而非全 0。保持既有 `consumed_*` 优先、live context 与 consumption 分离、`requestId` 去重、replay 不重复计费。
- `ProviderUsageDashboard` 结构化输出 session usage,显示 total input / uncached / cache read / cache write / prompt cache read ratio / output / reasoning / total / source,并对 `unavailable`、`mixed`、`estimate` 使用明确措辞;`/multi/mod/usage` 以增量可选字段 `session` 扩展。
- `/multi-usage --text`(及别名 `text`)纯文本模式,只依赖 `/multi/mod/usage`;`$.ui.open()` 返回 `isPlaced === false` 或抛错时自动降级为文本。
- Usage Pane 从 `Client` + `surface.onKey()` 迁移为 Claude Mods engine-native 交互:直接 `ui.render` 元素树、Provider tab 用 `Button` + `autoFocus` + `ui.focus`、滚动用 `ui.scroll`、显式 Refresh / Close / Receipts 按钮;`r` 与 `Esc` 仅作增强。Pane 状态迁到 hook 持有的 `UsagePaneState`。
- 新增两个仅含元数据的诊断开关:`MULTI_USAGE_TRACE=1`(gateway 侧 usage 元数据)与 `MULTI_UI_TRACE=1`(pane placement / focus / press / scroll),严禁记录 prompt、response、tool 参数、密钥、Authorization、gateway token、加密 reasoning。
- 新增验证要求:先做 characterization(Provider matrix、routing、public behavior snapshot、OpenAI usage 变体 fixture、Pane 焦点状态),再扩展 live probe 做 raw usage → gateway final usage → ReceiptLedger → `/multi-usage` 四层对账,并建立终端宿主回归矩阵与 Orca 手工 E2E。
- 同步文档:`docs/usage.md`、`CHANGELOG.md`(用户可见变化)、`docs/claude-mods.md` 中的 Usage UI 描述。
- **BREAKING**(仅对 receipt 外部读取者):收据 `schemaVersion` 由 1 升到 2,totals 的未知字段变为省略而非 0,失败/取消且无 completion 的收据 usage 由全 0 变为 `{ "source": "unavailable" }`。历史 v1 JSONL 仍是合法历史记录;ledger 不从 JSONL 恢复状态,故进程内无迁移器。

## Capabilities

### New Capabilities

- `usage-accounting`: canonical usage 模型、unknown vs zero 语义、source 判定与合并、token-weighted cache read ratio、协议 usage 与 accounting truth 分离、provisional 与 final usage 的生命周期。
- `openai-response-usage`: OpenAI Responses terminal usage 的解析与校验、uncached input 推导、reasoning/total 保留、unavailable 与 malformed 区分、telemetry 缺失不重跑请求。
- `receipt-ledger-v2`: 收据 schema v2、未知字段省略、source 聚合、failed/cancelled 语义、`consumed_*` 与 live context 分离、去重与 replay 规则、v1 兼容。
- `provider-usage-dashboard`: 会话 usage 结构化字段与显示格式、cache ratio 显示规则、unavailable/mixed/estimate 措辞、`/multi/mod/usage` 增量 schema 与既有缓存/认证约束。
- `usage-text-fallback`: `/multi-usage --text` 命令行为、文本渲染要求、`$.ui.open()` 结果检查与自动降级、参数校验。
- `usage-pane-interaction`: engine-native Pane 的状态归属、Provider 导航、滚动、Refresh、Close、Receipts 懒加载、Quota advice 按钮、foreign pane 忽略、`usage-view.ts` 的迁移与淘汰。
- `usage-diagnostics`: `MULTI_USAGE_TRACE` 与 `MULTI_UI_TRACE` 的输出范围与禁止内容,以及 `MULTI_RECEIPTS_FILE` 分层定位路径。
- `usage-compatibility`: 补丁层边界与不可破坏约束(Claude passthrough 零侵入、harness context/consumption 语义、只走 Claude Mods、不越界做 Provider 架构、可 rebase、小提交)。
- `usage-verification`: characterization 基线、单元与 Claude Mod 测试覆盖、OpenAI live probe 四层对账、终端宿主矩阵、Orca A/B 判定与手工 E2E 记录。

### Modified Capabilities

<!-- `openspec/specs/` 目前为空,没有既有 spec 需要修改。 -->

## Impact

- **OpenAI / 网关代码**:`plugins/multi-openai/src/responses.ts`(`ResponsesUsage`、`finish()`、`validResponse()`、`complete()`)、新增 `plugins/multi-openai/src/response-usage.ts`、新增 `plugins/multi-core/src/gateway/usage-accounting.ts`、`plugins/multi-core/src/gateway/messages.ts`(增量 `multi_usage.accounting`)、`plugins/multi-core/src/gateway/receipts.ts`、`plugins/multi-core/src/gateway/provider-usage.ts`。`server.ts` 只允许 type-compatible 的增量改动,不碰 dispatch 与 Anthropic passthrough。
- **Claude Mods hooks**:`plugins/multi-core/hooks/usage.ts`、新增 `usage-format.ts` 与 `usage-pane.ts`,`usage-view.ts` 先保留后淘汰。
- **不触碰**:`launcher.ts`、`server.ts` provider routing、`worker-catalog.ts`、`install/plugins.ts`、provider discovery、ProviderRegistry / ModelIdentity / DirectProviderAdapter / Pi 等 Multi-Provider v2 架构工作。
- **其他 provider**:Zen 的 `requireUsage: true` 行为、Cursor / Antigravity / Grok 的 `consumed_*` 语义保持不变;它们经 legacy fallback 继续被 ReceiptLedger 消费。
- **测试**:新增 `test/unit/native-openai-response-usage.test.ts`;扩展 `native-openai-stream`、`native-receipts`、`native-provider-usage`、`native-usage-menu`、`plugins/multi-core/hooks/tests/usage.test.ts`、`test/live/native-openai-cache.ts`;需通过 `npm run check` 与 `npm run test:mod`。
- **文档**:`docs/usage.md`、`docs/claude-mods.md`、`CHANGELOG.md`。
- **维护策略**:分支 `fix/usage-observability` 基于 `upstream/main`,保持小提交、单一责任,便于 upstream 已修复时跳过对应 patch;依赖方向单向(Usage Patchset 不依赖 Multi-Provider v2)。

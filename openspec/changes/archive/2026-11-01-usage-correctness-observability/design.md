## Context

设计基线:`leedrin/cc-multi-cli-plugin@b1fa3b53`(本仓库当前分支 `Usage-Correctness`,HEAD `350a291`)。完整来源见 `docs/cc-multi-cli-plugin_usage-correctness-observability_PRD.md` 与 `..._detailed-design.md`;本文只保留决策与理由,行为要求见 `specs/`。

当前 usage 数据链路:

```text
Provider terminal usage
  → MessagesResponse { usage, multi_usage }
  → server.completionEvent() → GatewayEvent { usage, usageMetadata }
  → ReceiptLedger.observe() → session snapshot / receipt JSONL
  → ProviderUsageDashboard → /multi/mod/usage
  → hooks/usage.ts → Client(usage-view.ts) → surface.onKey()
```

已在源码中核实的现状问题:

1. `responses.ts` 的 `ResponsesUsage` 缺少 `output_tokens_details`、`total_tokens`;`ResponseStream.finish()` 用 `?? 0` 把缺失 usage 压成 0,并自行用 `input_tokens + output_tokens` 计算 `total_tokens`,`reasoning_tokens` 丢失。
2. `receipts.ts` 的 `emptyTotals()` 以 0 初始化,`addUsage()` 对 cache 用 `?? 0`,totals 无 `source`,failed/cancelled 收据是全 0。
3. `provider-usage.ts::sessionLines()` 只输出 consumed input / cached read / output / cache written,没有 ratio、reasoning、total、聚合 source。
4. `hooks/usage.ts` 的 `await $.ui.open(...)` 结果被丢弃,仅在抛错时降级为 provider 摘要行;`hooks/usage-view.ts` 依赖 `surface.onKey()` 处理 `r` / 方向键。Orca 中 Pane 渲染成功但焦点留在 Composer,整个交互层失效。
5. `plugins/multi-openai/src/usage.ts` 已被 Codex 账户配额读取占用,PRD 中的同名新文件必须改名。

约束(来自 `AGENTS.md` / `docs/claude-mods.md` 与 PRD):UI 只能走 Claude Mods function hooks 与既有 `/multi/mod/*` 控制面;不改 Claude 原生 passthrough;不做 Provider 架构重构;Biome 复杂度 ≤ 15、无 `any`、无非空断言;`npm run check` 与 `npm run test:mod` 为完成门槛。

## Goals / Non-Goals

**Goals:**

- OpenAI/Codex 的 output、cache read/write、reasoning、total 完整、可对账,且"未知"永不伪装成 0。
- Receipt、Dashboard、`/multi-usage` 共享同一 accounting truth,并保留 harness 的 live context 与 consumption 分离。
- `/multi-usage` 在 Windows Terminal、Orca、WSL、SSH、tmux 下至少能通过文本模式完整读取;交互 Pane 尽可能由 Claude Code 自己的 focus 系统驱动。
- 提供仅元数据的 trace 与分层定位手段。
- 保持补丁层可独立 rebase 到最新 upstream。

**Non-Goals:**

- ProviderRegistry、ModelIdentity、ModelDescriptor、DirectProviderAdapter、ProviderRuntime、Generic API Provider、Pi、动态 provider 插件加载、launcher / worker catalog / gateway dispatch 重写。
- 为 Orca 写宿主特化代码,或维护自己的终端键盘解码器。
- 修改 Claude 原生 Messages 流、retry、timeout、headers 与非 Messages `/v1/*` 转发。
- 一次性迁移 Cursor / Zen / Antigravity / Grok 到新 accounting 块(它们经 legacy fallback 继续工作)。
- 修改 Zen 的 `requireUsage: true` 或 Cursor/Antigravity/Grok 的 `consumed_*` 语义。

## Decisions

### D1:新增 `usage-accounting.ts` 与 `response-usage.ts` 两个小模块,不引入 registry

- `plugins/multi-core/src/gateway/usage-accounting.ts`:`UsageSource`、`CanonicalTokenUsage`、`UsageAccumulator`、`cacheReadRatio`、`mergeUsageSource`、`addCanonicalUsage`、`serializeUsageTotals`。
- `plugins/multi-openai/src/response-usage.ts`:`OpenAIResponsesUsage`、`parseOpenAIResponseUsage`、`openAIProtocolUsage`、`openAIAccountingMetadata`。
- 理由:与 `AGENTS.md` 的"provider 认证与 catalog 留在 provider 目录,共享协议类型留在 `gateway/`"一致;两个文件都是新增文件,rebase 时几乎不冲突。
- 备选:复用 `multi-openai/src/usage.ts`(PRD 原文)——拒绝,该文件是账户配额 reader,混用会把"账户配额"与"单次响应 token"耦合;把 accounting 放进 `messages.ts`——拒绝,会扩大高冲突文件的改动面。

### D2:协议 usage 与 accounting truth 分离,新增 `multi_usage.accounting`

- `MessagesResponse.usage` 仍是 Anthropic 兼容数值;`multi_usage.accounting` 携带带未知语义的 truth;flat 的 `reasoning_tokens` / `total_tokens` 暂时保留,给 Receipt 做过渡。
- `toProtocolUsage()` 是唯一允许写占位 0 的边界,`unavailable` 时输出 `input_tokens: 0, output_tokens: 0`。
- 理由:Claude Code 读取标准 usage 计算 live context,不能改 schema;而 accounting 需要表达 known/unknown/estimated/mixed/explicit-zero。
- 备选:把 `usage` 字段改成可选——拒绝,破坏 Claude Code 兼容;只靠 `source` 字段不加 `accounting`——拒绝,partial(`mixed`)时无法区分哪个字段未知。

### D3:OpenAI 保持 `requireUsage: false`;unavailable ≠ malformed

- terminal usage 缺失 → 成功回答 + `source = unavailable`;非法数值(负数/小数/非有限/不安全整数)→ 抛 malformed。
- 理由:"成功 response + telemetry absent"不等于"response 无效";让整条回答失败等同于重跑付费请求。Provider 明确给出不合法 telemetry 则不能默默信任。
- 备选:OpenAI 也开 `requireUsage`——拒绝(与 Zen 不同,Zen 的计费需要 usage);一律容忍 malformed——拒绝。

### D4:`source` 判定与合并规则集中在一处

- provider / unavailable / mixed / estimate 判定规则与 `mergeUsageSource` 全部放 `usage-accounting.ts`,Receipt、Dashboard 与 parser 共用。
- 聚合 `mixed` 时 UI 不显示聚合 ratio(避免把 partial sum 当完整 ratio);`estimate` 显示 `~x% (estimated)`。
- 备选:各层各自判定——拒绝,会重演"数值看似一致、语义不同"的问题。

### D5:ReceiptLedger 使用带 `known` 标记的内部累加器,schema 升为 v2

- 内部 `UsageAccumulator`(sum + `known` flags),序列化时 never-known 省略;`spend()` 顺序:`accounting` → `consumed_*` → legacy → `unavailable` 不吸收协议 0。
- `RECEIPT_SCHEMA_VERSION = 2`;不实现 v1 loader,因为 ledger 只写 JSONL、不从 JSONL 恢复状态。
- failed/cancelled 且无 completion → `{ source: 'unavailable' }`。有部分 completion → 保留。
- 理由:`emptyTotals()` + `addUsage` 的 `?? 0` 是"未知→0"的根源之一,无法靠调用方补救;`ReceiptLedger` 已支持从 legacy 回落,因此不必要求所有 provider 同步迁移。
- 备选:保留 v1 数值 totals 再在旁边加 `unknownFields` 列表——拒绝,外部读取者易误读 0;在 `server.ts` 里做 normalization——拒绝,扩大 server 改动面,违反补丁边界。

### D6:Dashboard 先产出结构化 `session`,再格式化 `details`

- `sessionUsage(snapshot, provider)` 返回 `ProviderSessionUsage`,`details` 由它格式化;`/multi/mod/usage` 增加可选 `session`。
- 理由:避免 UI 将来从字符串反解析数字;旧 UI 继续读 `details`,测试不破。
- 备选:只改 `details` 文本——可作为第一版降级方案,但 Pane 迁移(D8)需要结构化数据,因此建议一并做。

### D7:文本模式作为一等基线能力,`$.ui.open()` 结果必须检查

- `/multi-usage --text`(别名 `text`)由纯函数 `renderUsageText` 渲染,放 `hooks/usage-format.ts`,只依赖 `/multi/mod/usage` 数据。
- 交互路径 `const opened = await $.ui.open(...)`:`isPlaced === false` → 关闭 pane 并返回文本(带 `reason`);抛错 → 文本;`void` → 视为 placed(与 Anthropic 官方 `mods/diff` 的兼容策略一致)。
- 不通过超时/"没收到按键"/宿主名猜测焦点失败。
- 理由:当前 Mods API 能可靠观察 placement 与 `ui.focus`,但没有同步 API 询问"是否真正拿到键盘焦点";host 启发式不可靠且引入宿主特化。
- 备选:检测 `TERM_PROGRAM=orca`——拒绝(宿主特化);定时器判定——拒绝(误判)。

### D8:Pane 迁移为 engine-native 交互,分两阶段

- 阶段 A:accounting + `--text` + placement fallback,保留 `usage-view.ts` Client UI。目的是先让数据正确,并保证即使 Orca 交互仍未解也不会不可访问。
- 阶段 B:hook 持有 `UsagePaneState`,`ui.render` 直接返回 `Box/Text/Button`,Provider tab 用 `Button + autoFocus`,`ui.focus` 更新选中,`ui.scroll` 更新有界 offset,显式 `[Refresh]` / `[Close]` / `[Receipts]`。`r` 与 `closeOnEscape` 仅作增强。`usage-view.ts` 先保留一版再单独 commit 删除。
- 新增 `usage-format.ts`(dashboard 校验、收据格式化、文本渲染)与 `usage-pane.ts`(状态 helper、直接 renderer、selection、scroll);`usage.ts` 只做小规模 extraction 与 wiring。
- 理由:继续为 Orca 增强 `surface.onKey()`(ESC[D、CSI-u、Kitty、xterm)会让 Multi 自己维护终端键盘解码器,与 Claude Mods 的层次相反。Anthropic 官方 `/diff` Mod 已使用 `Button.autoFocus`、`ui.focus`、`ui.scroll`、`ui.close` 与 `isPlaced` 检查。
- 备选:保留 Client 并补更多键值——拒绝;把状态留在 Client `surface.state`——拒绝(Client 不再是唯一状态来源,才能被 `ui.focus`/`ui.press` 驱动)。

### D9:诊断仅输出元数据,并以 `MULTI_RECEIPTS_FILE` 做分层定位

- `MULTI_USAGE_TRACE=1` 在 gateway 内轻量 helper;`MULTI_UI_TRACE=1` 在 hook 内记录 surface、placement、focus 转移、press、scroll、close。均禁止 prompt/response/tool 参数/密钥/token/加密 reasoning,UI trace 不输出真实 session id。
- 分层定位表(Case A/B/C)写入 `docs/usage.md`。
- 理由:此前无法区分"Claude UI 聚合问题"、"gateway 未获取 terminal usage"、"gateway normalization bug"。

### D10:验证顺序先 characterization 再修复,live probe 做四层对账

- Stage 0(只加测试)→ Stage 1 OpenAI usage truth → Stage 2 Receipt/Dashboard → Stage 3 Text fallback → Stage 4 engine-native Pane → Stage 5 verification(live probe、宿主矩阵、Orca 手工 E2E、UI trace)。
- live probe:raw terminal usage → gateway final `message_delta` → `ReceiptLedger` → dashboard,注入确定性 openai reader,避免额外启动 Codex 进程;保持付费探测有界。
- 理由:先锁现状,避免把已有行为变化误判为修复结果。

### D11:小提交序列(可 cherry-pick / 可跳过)

`test(usage): characterize OpenAI terminal usage variants` → `usage: add canonical accounting helpers` → `openai: preserve full Responses token usage` → `usage: keep unavailable distinct from zero` → `receipts: add source-aware schema v2` → `usage: show cache ratio reasoning and source` → `usage-ui: add text mode and placement fallback` → `usage-ui: add explicit refresh and close actions` → `usage-ui: migrate pane state to Claude Mods focus and scroll` → `test(usage): extend live OpenAI accounting probe` → `test(usage-ui): add terminal-host compatibility coverage` → `docs: document usage accounting and pane fallback`。

## Risks / Trade-offs

- [Claude Mods API 处于 early access,`ui.focus` / `ui.scroll` 事件形状可能变化] → 用 `/plugin-types` 生成当前声明并 `npm run test:mod`;在最低支持 / pinned / 最新三个 Claude Code 版本上记录矩阵;`usage-view.ts` 保留一版便于 revert。
- [placement 成功但焦点未获取无法自动检测] → 文本模式 + 显式 Button + 文档化 `--text`;不做超时/宿主启发式。
- [Receipt v2 对外部读取者是 **BREAKING**(unknown 变省略,failed 收据由 0 变 unavailable)] → `schemaVersion` 升到 2,文档与 CHANGELOG 说明;历史 v1 JSONL 保持合法。
- [`multi_usage` 新增 `accounting` 与 flat `reasoning_tokens/total_tokens` 并存造成重复] → 明确为过渡;所有 provider 迁移后再删除 flat 字段(不在本变更范围)。
- [`server.ts` / `messages.ts` 高冲突文件] → `server.ts` 仅 type wiring;ReceiptLedger 自己负责"优先 accounting、回落 legacy",避免扩大 server 改动。
- [聚合 `mixed` 隐藏 ratio 可能让用户以为缺功能] → UI 明确写"部分请求未提供完整 token telemetry"。
- [OpenAI 缺失 usage 时 Claude 原生 UI 仍显示 0] → 已知的 native UI limitation;`/multi-usage` 以 `unavailable` 为准,并记录在文档。
- [手工 Orca E2E 无法进 CI] → 保留可复现手工套件 + xterm/PTY protocol fixture,并在文档中记录环境。
- [upstream 已修复部分 patch 造成重复实现] → 小提交,按 patch 跳过,不保留重复实现。

## Migration Plan

1. 在 `fix/usage-observability`(基于 `upstream/main`)上按 D11 的顺序逐个提交。
2. Stage 0 仅加测试,`npm run check` 通过后再进入 Stage 1。
3. Stage 1–2 完成后 OpenAI 已可对账;Stage 3 完成后 usage 即使在 Orca 交互失败时也可访问(可在此处先发布)。
4. Stage 4 迁移 Pane;`usage-view.ts` 保留一版,稳定后单独 commit 删除。
5. Stage 5 做 live 对账、宿主矩阵与手工 E2E;更新 `docs/usage.md`、`docs/claude-mods.md`、`CHANGELOG.md`。
6. 回滚:任一阶段可整段 revert;阶段 B 的回滚是恢复 `ui.render` 返回 `Client('./usage-view.ts')`。Receipt v2 无进程内迁移,回滚只影响新写出的 JSONL 行。
7. upstream 更新时 `git fetch upstream && git rebase upstream/main`,冲突优先级:`usage-accounting.ts`、`response-usage.ts`、tests 最易保留;`responses.ts`、`receipts.ts`、`provider-usage.ts` 中等;`hooks/usage.ts`、`hooks/usage-view.ts` 最易受 upstream UI 改动影响。

## Open Questions

- 聚合 `mixed` 时是否要在 UI 里提供"仅已知部分"的 ratio 开关?当前决定默认不显示,待用户反馈。
- flat `reasoning_tokens` / `total_tokens` 何时移除,取决于其它 provider 迁移到 `accounting` 的时间,不属于本变更。
- Claude Mods 是否会暴露"焦点是否已授予"的稳定 API 或 capability 检测?一旦有,`UiCapabilities`(pane / client / focus / keyboardNavigation / scroll)可替代第一版的"乐观交互 + 诊断 + 文本降级"。
- 最低支持的 Claude Code 版本号(README/installation 当前写 2.1.272+)是否需要因 `ui.focus`/`ui.scroll` 事件而抬高,待 `npm run test:mod` 在三版本上的结果。

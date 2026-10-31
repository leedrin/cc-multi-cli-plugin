## 1. 分支与基线准备

- [x] 1.1 确认当前工作分支(`Usage-Correctness`,非 main;分支名与 PRD 建议的 `fix/usage-observability` 不同时以当前分支为准),记录设计基线 commit `b1fa3b53` 与当前 HEAD,确认 `upstream` remote 存在
- [x] 1.2 运行 `npm run check` 记录基线结果;尝试生成 `.claude/types`(gitignored,由 `/plugin-types` 写入),确认 `npm run typecheck:mod` / `npm run test:mod` 在基线上是否可运行。生成不了则把这两条记为外部阻塞并写明原因,hook 层改动改用 `test/unit` 中可离线运行的测试验收,不因此停下
- [x] 1.3 提交约定:每个下列任务组按 design D11 拆成单一责任小提交,不合并为大 commit(`usage-compatibility`)

## 2. Stage 0 — Characterization(只加测试,不改行为)

- [x] 2.1 MP-0001:建立 openai / zen / cursor / antigravity / grok 的 provider matrix fixture,`npm run check` 通过且既有测试不变
- [x] 2.2 MP-0002:补 provider routing characterization,断言每个 `multi/<provider>/<model>` 只路由一次
- [x] 2.3 MP-0003:记录 public behavior snapshot(`/model` 行、worker 类型、usage、permission、error、`/multi-usage` 渲染),明确仅用于确认 usage patch 未改变 provider/worker 行为
- [x] 2.4 MP-0050:在 `test/unit/native-openai-stream.test.ts` 增加 fixture:`message_start` provisional、terminal 完整、terminal 缺失、terminal 部分、terminal null details;断言缺失不被当成 provider-reported zero
- [x] 2.5 MP-0060:增加 Pane 焦点 characterization fixture,能区分 render / placement / focus / key delivery 四类失败(`usage-verification`)
- [x] 2.6 运行 `npm run check`,确认 Stage 0 提交前后行为无变化

## 3. Stage 1 — OpenAI usage truth(`usage-accounting`、`openai-response-usage`)

- [x] 3.1 新增 `plugins/multi-core/src/gateway/usage-accounting.ts`:`UsageSource`、`CanonicalTokenUsage`、`UsageAccumulator`、`cacheReadRatio`、`mergeUsageSource`、`addCanonicalUsage`、`serializeUsageTotals`;不导入任何 provider 模块
- [x] 3.2 MP-0053:为 `cacheReadRatio()` 与 `mergeUsageSource()` 写单元测试(0 input、no cache、100% cache、cache write、mixed read/write、source 合并全组合)
- [x] 3.3 新增 `plugins/multi-openai/src/response-usage.ts`:`OpenAIResponsesUsage`、`parseOpenAIResponseUsage`、`openAIProtocolUsage`、`openAIAccountingMetadata`;不改 `plugins/multi-openai/src/usage.ts`
- [x] 3.4 实现 uncached input 推导、`totalTokens` 优先 provider 否则推导、unavailable / mixed / provider 判定、null details 接受、malformed(负数/小数/非有限/不安全整数)抛错
- [x] 3.5 新增 `test/unit/native-openai-response-usage.test.ts`:full、absent、null、partial input only、partial output only、null details、cache read/write、reasoning、provider total、derived total、explicit zero、负数/小数/不安全整数被拒绝
- [x] 3.6 `plugins/multi-core/src/gateway/messages.ts`:为 `multi_usage` 增加可选 `accounting` 块与 `toProtocolUsage()`(仅 additive,类型兼容)
- [x] 3.7 `plugins/multi-openai/src/responses.ts`:扩展 `ResponsesUsage`(`output_tokens_details`、`total_tokens`),`validResponse()` 校验新字段,`finish()` 改用 `parseOpenAIResponseUsage` 写协议 usage 与 `multi_usage`(含 `accounting`,过渡期同时保留 flat `reasoning_tokens` / `total_tokens`)
- [x] 3.8 MP-0051 / MP-0052:清除 accounting 路径中的 `usage?.output_tokens ?? 0` 等未知→0 逻辑,协议占位 0 仅存在于 `toProtocolUsage`
- [x] 3.9 保持 OpenAI `requireUsage: false`、Zen `requireUsage: true` 不变;补测试:OpenAI 缺失 usage 成功返回且不二次调用上游;Zen 缺失 usage 仍抛 "Provider completed without token usage"
- [x] 3.10 扩展 `native-openai-stream.test.ts`:继续断言 `message_start` provisional(估计 input、output = 0),`message_delta` 为 final,并新增 `multi_usage.accounting`、reasoning、total、source 断言
- [x] 3.11 运行 `npm run check`;确认 `server.ts` 无 dispatch/passthrough 改动(仅允许 type-compatible 增量)

## 4. Stage 2 — Receipt v2 与 Dashboard(`receipt-ledger-v2`、`provider-usage-dashboard`)

- [x] 4.1 `plugins/multi-core/src/gateway/receipts.ts`:`RECEIPT_SCHEMA_VERSION = 2`,`UsageTotalsV2`(含 `source`)、`ContextUsageV2`,内部 `UsageAccumulator`(sum + `known`),序列化省略 never-known 字段
- [x] 4.2 实现 `spend(event)` 顺序:`multi_usage.accounting` → harness `consumed_*` → legacy 标准 usage → `unavailable` 不吸收协议 0;`accountingOf` / `fromAccountingMetadata` / `legacyAccounting`
- [x] 4.3 聚合 source 用 `mergeUsageSource`;`entries`、`byModel`/`byEffort`/`byEndpoint` totals 同步使用 V2 totals;`cache_read_ratio` 仅在 provider source 且分母已知时序列化,`mixed` 不序列化
- [x] 4.4 failed/cancelled 收据:无 completion → `{ source: 'unavailable' }` 且 `incomplete: true`;有 completion 后取消 → 保留已知 usage
- [x] 4.5 保持 `contexts`(最近一次响应 live context)与 totals 分离,`source = unavailable` 时 context 标记 unavailable;保持 replay 忽略、`requestId` 去重与既有容量上限(256/128/512/8192/128)
- [x] 4.6 MP-0055:扩展 `test/unit/native-receipts.test.ts`:explicit zero 保持、unavailable 不变 0、provider+unavailable→mixed、provider+estimate→mixed、reasoning/total 求和、cache ratio 序列化、取消无 completion→unavailable、取消有 completion 保留、harness `consumed_*` 仍优先、context 分离、replay 忽略、requestId 去重不回退
- [x] 4.7 更新既有断言(failed/cancelled 收据由全 0 改为 `unavailable`),确认 Cursor / Zen / Antigravity / Grok 经 legacy fallback 数值不变(含 `native-harness-usage`、`native-cursor-usage`、`native-grok-usage`、`native-zen-usage` 与 `test/e2e/usage-receipts.test.ts`)
- [x] 4.8 `plugins/multi-core/src/gateway/provider-usage.ts`:新增 `sessionUsage(snapshot, provider)` 返回 `ProviderSessionUsage`,`sessionLines()` 由其格式化;显示 Context / Consumed(input、cache read、cache write、ratio、output、reasoning、total)与 `Source`
- [x] 4.9 MP-0054:实现 unavailable(`usage unavailable`,不显示 0)、mixed(known 计数 + 不完整提示,无聚合 ratio)、estimate(`~x% (estimated)`)措辞与 ratio 显示规则
- [x] 4.10 `/multi/mod/usage` provider 行新增可选 `session` 字段;保持 URL、gateway token 认证、session scope、只读、30 秒缓存、pending 合并、32 并发、`refresh=true`
- [x] 4.11 扩展 `test/unit/native-provider-usage.test.ts`:cache ratio、reasoning、source、unavailable/mixed 措辞、context vs consumed、model calls;既有 account data cache、coalescing、refresh、session freshness、authentication 断言不回归
- [x] 4.12 验证 quota 查询失败时 provider 行 `status = 'error'` 且仍显示会话 usage;Receipts 加载失败保持旧数据并显示 `Could not load receipts.`
- [x] 4.13 运行 `npm run check`

## 5. Stage 3 — 文本降级与 placement 诊断(`usage-text-fallback`)

- [x] 5.1 新增 `plugins/multi-core/hooks/usage-format.ts`:迁移 dashboard 校验与收据格式化 helper,新增纯函数 `renderUsageText(props)`(无 Client/focus/ui.open 依赖)
- [x] 5.2 MP-0061:`command.run` 支持 `--text` 与 `text`,其它参数返回 `Use /multi-usage or /multi-usage --text.` 且不请求网关
- [x] 5.3 MP-0062:`const opened = await $.ui.open(...)`;`opened.isPlaced === false` → `$.ui.close({ id: 'multi-usage' })`(忽略失败)并返回带 `reason` 的文本;`open` 抛错 → 文本;返回 void → 视为 placed
- [x] 5.4 确认无宿主特化代码(不出现 `orca`/`TERM_PROGRAM` 分支)且无超时/"无按键"启发式
- [x] 5.5 扩展 `test/unit/native-usage-menu.test.ts` 与 `plugins/multi-core/hooks/tests/usage.test.ts`:`--text`、`text`、非法参数、`isPlaced=false` 降级、open 抛错降级、void 视为 placed、文本含五个 provider 与 usage v2 字段、unavailable 不显示 0
- [x] 5.6 MP-0064(第一步):在阶段 A 的 Client UI 中保证 `[Refresh]` 按钮可用,并新增显式 `[Close]`;`r` 与 `Esc` 保留为增强
- [x] 5.7 运行 `npm run check` 与 `npm run test:mod`

## 6. Stage 4 — Engine-native Pane(`usage-pane-interaction`)

- [x] 6.1 新增 `plugins/multi-core/hooks/usage-pane.ts`:`UsagePaneState`(`props`、`selected`、`offset`、`open`、`loading`、`receiptLoaded`)、`Map<string, UsagePaneState>`(≤ 16 session)、selection 与 scrolling helper、直接 renderer
- [x] 6.2 `ui.render`(`Pane`,`multi-usage`,`terminal`)改为 `await $.ui.resolve(event)` 后返回 `Box/Text/Button` 元素树,不再返回 `Client('./usage-view.ts')`;外来 `requestId`/`surface` 直接 `next(event)`
- [x] 6.3 Provider tab 用带稳定 `key`(`provider:<id>`、`tab:all`、`tab:receipts`)的 `Button`,选中项 `autoFocus: true`(不传 `autoFocus: false`);监听 `ui.focus` 更新 `selected`、`offset = 0` 并 `$.ui.invalidate('ui.render')`
- [x] 6.4 监听 `ui.scroll`(`requestId: 'multi-usage'`),按 `event.by` 有界更新 `offset`(`0 <= offset <= maxOffset`);必要时提供 Page Up / Page Down / Previous / Next 按钮 fallback
- [x] 6.5 MP-0064:显式 `[Refresh]`(`action:refresh`)、`[Close]`(`action:close`)、`[Receipts]` 按钮;Provider 页 Refresh 请求 `refresh=true`,Receipts 页 Refresh 请求 `/multi/mod/receipts`;`closeOnEscape: true` 保留
- [x] 6.6 Receipts 懒加载:仅 `selected = receipts && !receiptLoaded` 时请求,显式 Refresh 才重新请求;保留 `Quota-aware model selection` 按钮(`action:quota-advice`)与 session 隔离,`attributeToolCall` / `quotaAdvice` / `advisorySessions` 不变
- [x] 6.7 `forgetUsageSession` 清除 pane 状态与 advisory;`usage-view.ts` 保留一版(不再被 `ui.render` 引用),单独 commit 删除
- [x] 6.8 MP-0063:替换 Client 键盘测试为:`ui.render` 直接返回 Button、选中项 autoFocus、`ui.focus` 改变 selected、`ui.scroll` 改变 offset 且有界、Refresh 刷新、Close 关闭、Receipts 懒加载、quota advice 按 session、外来 pane 与未知 action 被忽略
- [x] 6.9 增加 function-hooks 层测试覆盖 `command.run`、`ui.open`、`ui.render`、`ui.focus`、`ui.close` 的事件契约;运行 `npm run check` 与 `npm run test:mod`

## 7. Stage 5 — 诊断、live 对账与宿主验证(`usage-diagnostics`、`usage-verification`)

- [x] 7.1 实现 `MULTI_USAGE_TRACE=1` 的 `usageTrace()`(gateway 内,只输出 provider/event/source/各 token 计数元数据,usage 缺失时 `usagePresent: false`),默认关闭
- [x] 7.2 MP-0067:实现 `MULTI_UI_TRACE=1`(surface、placement `requested/placed/reason`、`ui.focus`、`ui.press`、`ui.scroll`、`ui.close`),不输出真实 session id
- [x] 7.3 增加 trace 安全测试:开启两类 trace 后输出不含 prompt、assistant 文本、reasoning 密文、tool 输入输出、API key、Authorization、gateway token、Codex auth、transcript
- [x] 7.4 MP-0056:扩展 `test/live/native-openai-cache.ts`:Sample 捕获 `input/cached/cacheWrite/output/reasoning/total`,显式注入 `new ReceiptLedger()`,用确定性 `ProviderUsageDashboard` openai reader 经 authenticated `/multi/mod/usage?view=providers` 断言 raw → gateway final → ledger → dashboard 四层一致(付费探测有界,不使用 Cursor Fast)
- [x] 7.5 MP-0057:UI 回归/E2E:OpenAI 流式响应 → 最终 `output_tokens > 0` → cached tokens 可见 → cache ratio 可见;若原生 usage UI 不支持自定义 ratio,记录 native UI limitation
- [x] 7.6 MP-0066:建立终端宿主回归矩阵与 xterm/PTY protocol fixture(Windows ConPTY、WSL、SSH、tmux、xterm/kitty、标准 ANSI),断言交互失败不使 usage 不可访问
- [x] 7.7 MP-0065:编写 Orca 兼容性手工 E2E 清单(记录 Orca version、Claude Code version、OS、shell/PTY、cc-multi commit;Test A `/diff` → `/multi-usage`;Test B Windows Terminal vs Orca;Test C 全宿主 `--text`;逐步验证 provider focus ring、Refresh、Receipts、scroll、Esc、Close、`--text`)
- [ ] 7.8 在最低支持 / 当前 pinned / 最新支持三个 Claude Code 版本上记录 Usage UI 结果(版本、宿主、OS、interactive 结果)

## 8. 文档与收尾

- [x] 8.1 更新 `docs/usage.md`:token-weighted cache read ratio 定义、unknown vs zero、source 含义、`--text` 与降级、显式 Refresh/Close、`MULTI_USAGE_TRACE` / `MULTI_UI_TRACE`、`MULTI_RECEIPTS_FILE` 分层定位 Case A/B/C、native UI limitation、Receipt v2 说明
- [x] 8.2 更新 `docs/claude-mods.md` 中 Usage UI 章节:由 `Client('./usage-view.ts')` 改为 engine-native Pane(`ui.focus`/`ui.scroll`/`Button`),并保持"UI 走 Claude Mods、不建替代渲染器"的规则
- [x] 8.3 更新 `CHANGELOG.md`(用户可见变化与 Receipt schema v2 的 **BREAKING** 说明)
- [x] 8.4 运行完整 `npm run check` 与 `npm run test:mod`,确认无 `DEP0190` 警告;可用时运行 `test:live:*` 相关 live probe
- [x] 8.5 逐条对照 PRD 第 42 节 Patchset Definition of Done 与 detailed-design 第 80–83 节验收清单,确认全部满足
- [x] 8.6 确认分支可从最新 `upstream/main` rebase 或重建(`git fetch upstream && git rebase upstream/main` 演练),并核对提交历史粒度

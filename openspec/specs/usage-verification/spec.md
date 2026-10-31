# usage-verification Specification

## Purpose
TBD - created by archiving change usage-correctness-observability. Update Purpose after archive.

## Requirements

### Requirement: 修改前先做 characterization
在修改 accounting 与 UI 之前,项目 SHALL 先用测试锁定当前行为:(MP-0001)建立覆盖 openai、zen、cursor、antigravity、grok 的 provider matrix fixture,且 `npm run check` 通过、既有测试不变;(MP-0002)补齐 provider routing characterization,确保每个 `multi/<provider>/<model>` 只路由一次;(MP-0003)记录 public behavior snapshot(`/model` 行、worker 类型、usage、permission、error、`/multi-usage` 渲染);(MP-0050)增加 OpenAI usage fixture:`message_start` provisional、terminal 完整、terminal 缺失、terminal 部分、terminal null details;(MP-0060)增加 Pane 焦点 characterization fixture。Characterization 阶段 SHALL 只加测试,不改行为,且 snapshot MUST NOT 借机启动 provider 架构重构。

#### Scenario: unavailable 不被断言为 zero
- **WHEN** MP-0050 fixture 中 terminal usage 缺失
- **THEN** 测试 SHALL 断言其为 unavailable,MUST NOT 断言为 provider-reported zero

#### Scenario: provider 只路由一次
- **WHEN** 对每个 `multi/<provider>/<model>` 发起请求
- **THEN** routing 测试 SHALL 断言其只被路由一次

#### Scenario: Pane 状态可区分
- **WHEN** 运行 Pane characterization fixture
- **THEN** SHALL 能区分 render failure、placement failure、focus failure、key delivery failure

### Requirement: 单元测试覆盖
项目 SHALL 提供并通过下列离线测试:新增 `test/unit/native-openai-response-usage.test.ts`(full、absent、null、partial input only、partial output only、null details、cache read/write、reasoning、provider total、derived total、explicit zero、负数/小数/不安全整数被拒绝);扩展 `native-openai-stream.test.ts`(message_start provisional、message_delta final、`multi_usage.accounting`、reasoning、total、source);扩展 `native-receipts.test.ts`(explicit zero、unavailable、provider+unavailable→mixed、provider+estimate→mixed、reasoning/total 求和、cache ratio 序列化、取消无 completion→unavailable、取消有 completion 保留、harness `consumed_*` 优先、context 分离、replay 忽略、requestId 去重);扩展 `native-provider-usage.test.ts`(cache ratio、reasoning、source、unavailable 与 mixed 措辞、context vs consumed、model calls,并保持既有 account data cache、coalescing、refresh、session freshness、authentication);扩展 `native-usage-menu.test.ts` 与 hook 测试(阶段 A:`--text`、非法参数、`isPlaced=false` 与 open 抛错的降级;阶段 B:直接 Button 渲染、autoFocus、`ui.focus`、`ui.scroll`、Refresh、Close、Receipts 懒加载、quota advice 按 session、外来 pane 忽略)。

#### Scenario: 解析器矩阵完整
- **WHEN** 运行 `native-openai-response-usage.test.ts`
- **THEN** 上述所有输入变体 SHALL 都有断言且通过

#### Scenario: 既有 dashboard 行为不回归
- **WHEN** 运行扩展后的 `native-provider-usage.test.ts`
- **THEN** account data cache、coalescing、refresh、session freshness 与 authentication 的既有断言 SHALL 仍通过

### Requirement: Claude Mod 与全仓检查
项目 SHALL 通过 `npm run check`(banner、Biome lint、Knip、strict typecheck、离线测试),且无 `DEP0190` 警告;涉及 hook 或 surface 变化时 SHALL 额外通过 `npm run test:mod`,并增加至少一个 function-hooks 层测试覆盖 `command.run`、`ui.open`、`ui.render`、`ui.focus`、`ui.close` 的 Claude engine 事件契约(不测终端字节)。用户可见变化 SHALL 更新 `CHANGELOG.md`。代码 MUST 遵守 Biome 规则(大括号、单变量声明、无嵌套三元、无参数重赋值、无 `any`、无非空断言、认知复杂度 ≤ 15),不得禁用规则或提高限制。

#### Scenario: check 通过
- **WHEN** 运行 `npm run check`
- **THEN** SHALL 全部通过且无 `DEP0190` 警告

#### Scenario: mod 测试通过
- **WHEN** 运行 `npm run test:mod`
- **THEN** SHALL 通过 typecheck 并成功执行 `claude plugin test`

#### Scenario: CHANGELOG 更新
- **WHEN** 变更包含用户可见行为
- **THEN** `CHANGELOG.md` SHALL 含对应条目

### Requirement: OpenAI live probe 四层对账
`test/live/native-openai-cache.ts` SHALL 扩展为四层对账:raw `response.completed` usage → gateway final `message_delta` usage → `ReceiptLedger` snapshot → `/multi-usage` dashboard(通过注入确定性 `ProviderUsageDashboard` 的 openai reader,经 authenticated `/multi/mod/usage?view=providers` 获取,避免额外启动 Codex 进程)。Sample SHALL 捕获 `input`、`cached`、可选 `cacheWrite`、`output`、可选 `reasoning`、可选 `total`。四层数值 SHALL 一致,并显式注入 `new ReceiptLedger()` 以断言 raw output、cached、reasoning 与 `source = "provider"`。付费探测 SHALL 保持有界,并复用既有 usage 记录。

#### Scenario: 四层数值一致
- **WHEN** live probe 完成一次 OpenAI 请求
- **THEN** raw、gateway、ledger、dashboard 的 output、cache read、reasoning SHALL 一致

#### Scenario: dashboard 含 ratio 与 source
- **WHEN** 通过 authenticated route 获取 provider view
- **THEN** SHALL 含 cache ratio 行、output 行、reasoning 行、source 行

### Requirement: 端到端 UI 回归
E2E SHALL 覆盖:OpenAI 流式响应 → 最终 `output_tokens > 0` → cached tokens 可见 → cache ratio 可见。若 Claude Code 原生 usage UI 不支持自定义 cache ratio,`/multi-usage` SHALL 准确显示,并记录 native UI limitation。

#### Scenario: 最终 output 大于 0
- **WHEN** OpenAI 流式响应完成且 provider 报告 output > 0
- **THEN** 最终 `output_tokens` SHALL 大于 0

#### Scenario: 原生 UI 限制被记录
- **WHEN** 原生 usage UI 不显示 cache ratio
- **THEN** 该限制 SHALL 被记录在文档中,且 `/multi-usage` 显示正确 ratio

### Requirement: 终端宿主回归矩阵
项目 SHALL 建立宿主矩阵并记录 Claude Code version、terminal host、OS 与 interactive 结果:Windows Terminal(interactive、text、Refresh、Close 必须)、PowerShell terminal、Orca Windows ConPTY(interactive 或 text fallback)、Orca WSL、Orca remote runtime、WSL terminal、SSH、tmux、narrow terminal(可降级为 text 或清晰警告)、非交互(text 输出)。SHALL 在最低支持、当前 pinned、最新支持三个 Claude Code 版本上验证,重点测试 Pane render、initial focus、provider switch、scroll、refresh、receipts、close、reopen。所有 host 上 `--text` SHALL 得到一致的 usage 数据。CI 难以运行 Orca GUI 时,SHALL 保留可复现的手工集成套件 + xterm/PTY protocol fixture。

#### Scenario: 交互失败不使 usage 不可访问
- **WHEN** 任一矩阵 host 的交互失败
- **THEN** `--text` SHALL 仍能提供完整 usage 数据

#### Scenario: 记录版本与宿主
- **WHEN** 执行一次兼容性验证
- **THEN** 结果 SHALL 记录 Claude Code version、terminal host、OS 与 interactive 结果

#### Scenario: Windows Terminal 不回归
- **WHEN** 在 Windows Terminal 中运行 `/multi-usage`
- **THEN** interactive、text、Refresh、Close SHALL 全部可用

### Requirement: Orca A/B 判定
验证流程 SHALL 包含:Test A——同一 Orca 会话先运行官方 `/diff` 再运行 `/multi-usage`;Test B——同一 `claude-multi`、Claude Code 版本与仓库分别在 Windows Terminal 与 Orca 运行 `/multi-usage`;Test C——所有 host 运行 `/multi-usage --text`。判定:`/diff` 可交互而 `/multi-usage` 不可 → 优先归因 Multi Usage Pane 实现;二者都不可 → 优先归因 Claude Code / Orca 终端集成;交互失败而 `--text` 正常 → usage 数据面健康,UI/focus 问题被隔离;原生终端可用而 Orca 失败 → host-triggered focus/protocol 兼容问题。手工 E2E SHALL 记录 Orca version、Claude Code version、OS、shell/PTY、cc-multi commit,并逐步验证:`/diff` 焦点、`/multi-usage` provider focus ring、Refresh、Receipts、scroll、Esc、Close 按钮、`--text`。

#### Scenario: 判定为 Pane 实现问题
- **WHEN** `/diff` 在 Orca 可交互而 `/multi-usage` 不可
- **THEN** 结论 SHALL 优先指向 Multi Usage Pane 实现

#### Scenario: 数据面健康
- **WHEN** Pane 交互失败但 `--text` 正常
- **THEN** 结论 SHALL 为 usage 数据面健康、UI/focus 问题被隔离

#### Scenario: 手工 E2E 环境记录
- **WHEN** 执行 Orca 手工 E2E
- **THEN** 记录 SHALL 含 Orca version、Claude Code version、OS、shell/PTY 与 cc-multi commit

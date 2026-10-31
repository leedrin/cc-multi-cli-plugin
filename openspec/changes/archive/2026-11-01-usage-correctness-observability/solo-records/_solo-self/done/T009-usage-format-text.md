# T009：usage-format.ts 与 --text（任务 5.1、5.2）

> 补写说明（2026-10-01）：原工单被缩水成「见 _receipts/T009.md」。本文按 PLAN.md、tasks.md 5.1、5.2、回执和提交 f9fc5a8 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 5.1、5.2
- 类型：代码
- 被谁阻塞：T008

## 目标
`/multi-usage --text`（或 `text`）直接返回纯文本，不依赖 Client、焦点或 `ui.open`；dashboard 校验、收据格式化等纯函数从 `usage.ts` 抽到 `usage-format.ts`，收据行改用 v2 语义（unavailable 显示 unavailable，未上报计数省略，mixed 标 known）。

## 动手前先读
- specs/usage-text-fallback（`--text` 与参数校验）、specs/receipt-ledger-v2（收据行语义）
- design.md D8；tasks.md 5.1、5.2
- plugins/multi-core/hooks/usage.ts、usage-view.ts、quota-advice.ts 中引用 dashboard 类型和格式化函数的位置
- docs/claude-mods.md 中关于 hook 编译器的限制（只允许同文件函数传给 `$`）
- test/unit/native-usage-menu.test.ts 现有结构

## 边界
- 只动：plugins/multi-core/hooks/usage-format.ts（新）、plugins/multi-core/hooks/usage.ts、plugins/multi-core/hooks/usage-view.ts、plugins/multi-core/hooks/quota-advice.ts（仅 import 路径）、plugins/multi-core/hooks/tests/usage.test.ts、test/unit/native-usage-menu.test.ts
- 适用通用规则：未知与零；Claude Mods 函数 hook 规则（docs/claude-mods.md）
- 必须保持：
  - `renderUsageText` 是纯函数，不依赖 Client、focus、`ui.open`（tasks 5.1）
  - `--text` 与 `text` 之外的任何参数返回固定提示 `Use /multi-usage or /multi-usage --text.` 且不请求网关（tasks 5.2）
  - 无参数的 `/multi-usage` 行为不变（仍开 pane）
  - 配额建议（quota advice）逻辑与文案不变，只改引用位置
  - 文本里五个 provider 齐全，unavailable 不显示 0

## 验收
1. `node --test --test-timeout=120000 test/unit/native-usage-menu.test.ts` → 通过
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. `npm run typecheck:mod` → 无新增错误（基线 8 个，全在 hooks/workers.ts，属外部阻塞）
5. 全仓门禁（命令表）→ 通过

## 为什么这样验收
抽取文件是纯搬运加一个新入口，风险在于旧路径悄悄变样。hook 层用例锁住 `--text`、`text`、非法参数、全 provider 四种入口行为；单元用例直接测纯函数，确认收据行与文本里 unavailable 不显示 0。

## 记录
- 提交：f9fc5a8
- 验收：通过（原记录：重跑 6 条命令）
- 修正：无
- 存疑：无

# T011：Client UI 显式 Refresh / Close（任务 5.6、5.7）

> 补写说明（2026-10-01）：原工单被缩水成「见 _receipts/T011.md」。本文按 PLAN.md、tasks.md 5.6、5.7、回执和提交 476b76d 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 5.6、5.7
- 类型：代码
- 被谁阻塞：T010

## 目标
在阶段 A 的 Client UI（`usage-view.ts`）里，`[Refresh]` 按钮与新增的 `[Close]` 按钮并排可点，不再只靠 `r` 与 `Esc` 这两个快捷键；点 Close 会清掉 pane 状态并关闭 pane。

## 动手前先读
- specs/usage-pane-interaction（显式 Refresh 与 Close）
- design.md D9；tasks.md 5.6、5.7
- plugins/multi-core/hooks/usage-view.ts 的按钮与键盘处理、plugins/multi-core/hooks/usage.ts 里处理 Client 消息的位置
- T010 产出的 `openPane` 与降级文本

## 边界
- 只动：plugins/multi-core/hooks/usage-view.ts、plugins/multi-core/hooks/usage.ts、plugins/multi-core/hooks/tests/usage.test.ts
- 适用通用规则：Claude Mods 函数 hook 规则
- 必须保持：
  - `r` 与 `Esc` 仍然可用（增强，不是替代）（tasks 5.6）
  - 关闭 pane 失败时忽略错误，不影响状态清理
  - Refresh 仍按既有逻辑请求 `refresh=true`；provider 切换、Receipts、quota advice 行为不变
  - 本单不引入 engine-native Pane（那是 T012）

## 验收
1. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过，含 Refresh（refresh=true）与 Close 两个新用例
2. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
3. `npm run test:mod`（含 `typecheck:mod`）→ 无新增错误（基线 8 个，全在 hooks/workers.ts）
4. 全仓门禁（命令表）→ 通过
5. tasks 5.7 要求的 `npm run check` 与 `npm run test:mod` 在本单一并运行（原回执：5.7 并入本单）

## 为什么这样验收
这一步只补两个显式入口，风险小，但用户的可用性依赖它：快捷键失灵时按钮要能兜底。用 hook 层用例分别触发 Refresh 与 Close，确认请求参数与状态清理。

## 记录
- 提交：476b76d
- 验收：通过（原记录：重跑 5 条命令）
- 修正：无
- 存疑：无

# T012：usage-pane 状态与渲染 + Pane 迁移（任务 6.1–6.9，T013 并入）

> 补写说明（2026-10-01）：原工单被缩水成一行标题加「done 6444bf1」。本文按 PLAN.md、tasks.md 6.1–6.9、回执和提交 6444bf1 还原；当时的原文未保留，还原不了的标「当时未记录」。原计划的 T013（引擎原生 Pane 的迁移部分）在执行时并入了本单，所以没有 T013 工单；见 dropped/T013-merged-into-T012.md。

- openspec：usage-correctness-observability / 任务 6.1、6.2、6.3、6.4、6.5、6.6、6.7、6.8、6.9
- 类型：代码
- 被谁阻塞：T011

## 目标
`/multi-usage` 的 pane 由 hook 自己持有状态并直接返回 `Box / Text / Button` 元素树，不再返回 `Client('./usage-view.ts')`：焦点环走到哪个 provider 标签就显示哪一页，滚动有界，显式 Refresh、Close、Receipts 按钮可用。

## 动手前先读
- specs/usage-pane-interaction（焦点、滚动、Receipts 懒加载、会话隔离、外来 pane 忽略）
- design.md D9、D10；tasks.md 6.1–6.9
- docs/claude-mods.md 中 Pane、`ui.focus`、`ui.scroll`、`ui.press` 的事件契约与「只允许同文件函数传给 `$`」的限制
- plugins/multi-core/hooks/usage.ts、usage-view.ts、T009 产出的 usage-format.ts
- T003 的 usage-pane-layers 特征化测试与 test/unit/native-usage-menu.test.ts 里针对 Client 的键盘用例

## 边界
- 只动：plugins/multi-core/hooks/usage-pane.ts（新）、plugins/multi-core/hooks/usage.ts、plugins/multi-core/hooks/tests/usage.test.ts、plugins/multi-core/hooks/tests/usage-pane-layers.test.ts、test/unit/native-usage-menu.test.ts
- 适用通用规则：Claude Mods 函数 hook 规则；状态与容量（pane 状态上限与会话清理）
- 必须保持：
  - 选中的标签 `autoFocus: true`，其余不带该键（不传 `autoFocus: false`）（tasks 6.3）
  - 外来 `requestId` 或 `surface` 直接 `next(event)`，不处理别的 pane（tasks 6.2、6.8）
  - 状态按会话隔离，最多 16 个，`forgetUsageSession` 同时清 pane 状态与 advisory（tasks 6.1、6.7）
  - Receipts 只在首次选中且未加载时请求，显式 Refresh 才重新请求；失败保留 providers 并在下次再试（tasks 6.6）
  - `usage-view.ts` 保留一版、不再被引用，删除另起提交；本单不删（tasks 6.7）
  - quota advice 按会话的行为、`attributeToolCall`、`quotaAdvice`、`advisorySessions` 不变（tasks 6.6）
  - `closeOnEscape: true` 保留；`--text` 与降级路径（T009、T010）不变

## 验收
1. `node --test --test-timeout=120000 test/unit/native-usage-menu.test.ts` → 通过（含 8 个新的 pane 用例）
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. `npm run typecheck:mod` → 无新增错误（基线 8 个，全在 hooks/workers.ts）
5. 全仓门禁（命令表）→ 通过

## 为什么这样验收
这是整个补丁里改动最大的 UI 单：键盘交互从 Client 移到引擎事件。必须用单元用例逐条锁住：渲染的是 Button、只有选中项请求焦点、焦点改变会切页并重置滚动、滚动不越界、Receipts 懒加载与失败重试、外来 pane 被忽略、Close 与宿主关闭都清状态、状态有上限。测试 kit 无法人为触发 `ui.focus`，所以焦点路径放在单元测试里覆盖。

## 记录
- 提交：6444bf1
- 验收：通过（原记录：全仓门禁全绿，typecheck:mod 仅基线 8 个 workers.ts 错误）
- 修正：无
- 存疑：测试 kit 无法人为触发 ui.focus，焦点路径只在单元测试覆盖（原回执）；原 usage-pane-layers 里「焦点到了但按键没送达 Client」的按键层用例随 Client 一起移除，补写时留意到这一点，见回执「审查」

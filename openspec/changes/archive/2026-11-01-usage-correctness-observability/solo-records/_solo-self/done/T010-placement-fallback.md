# T010：placement 降级（任务 5.3–5.5）

> 补写说明（2026-10-01）：原工单被缩水成「见 _receipts/T010.md」。本文按 PLAN.md、tasks.md 5.3–5.5、回执和提交 fc1ae19 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 5.3、5.4、5.5
- 类型：代码
- 被谁阻塞：T009

## 目标
宿主放不下 pane 时 `/multi-usage` 不再沉默：`ui.open` 返回 `isPlaced === false` 就关闭等待中的 pane 并返回带原因的文本；`open` 抛错也降级为文本；老版本返回空值视为已放置。

## 动手前先读
- specs/usage-text-fallback（placement 降级场景）、specs/usage-verification（四类失败要能区分）
- design.md D8、D9；tasks.md 5.3–5.5
- plugins/multi-core/hooks/usage.ts 里 `$.ui.open` 调用处
- T003 的 usage-pane-layers 特征化测试：其中「放置被拒时命令保持沉默」那条是现状记录，这一单要把它改成降级断言
- T009 产出的 `renderUsageText`

## 边界
- 只动：plugins/multi-core/hooks/usage.ts、plugins/multi-core/hooks/tests/usage-pane-layers.test.ts、plugins/multi-core/hooks/tests/usage.test.ts、test/unit/native-usage-menu.test.ts
- 适用通用规则：Claude Mods 函数 hook 规则；未知与零
- 必须保持：
  - 不出现宿主特化代码（orca、TERM_PROGRAM 等）与「多久没按键」之类的定时启发式（tasks 5.4）
  - 关闭等待 pane 失败时忽略错误，仍返回文本（tasks 5.3）
  - `open` 返回 void 视为 placed，正常路径不变（tasks 5.3）
  - 降级文本与 `--text` 是同一份数据（`renderUsageText`），文字前加一句带 `reason` 的说明
  - 既有 pane 状态、Refresh、quota advice 行为不变

## 验收
1. `node --test --test-timeout=120000 test/unit/native-usage-menu.test.ts` → 通过（含源码扫描用例，确认无宿主分支与定时器启发式）
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过

## 为什么这样验收
放置失败是用户最先撞到的故障，必须每种退路都有用例：被拒、抛错、关闭失败、返回空值、正常放置。「无宿主特化」这类否定性约束用源码扫描用例来锁，防止以后有人为某个终端加分支。

## 记录
- 提交：fc1ae19
- 验收：通过（原记录：重跑 6 条命令）
- 修正：无
- 存疑：无

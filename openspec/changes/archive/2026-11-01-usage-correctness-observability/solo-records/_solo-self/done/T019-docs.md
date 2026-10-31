# T019：文档与 CHANGELOG（任务 8.1、8.2、8.3）

> 补写说明（2026-10-01）：原工单被缩水成一行「done c5e3764」。本文按 PLAN.md、tasks.md 8.1–8.3、回执和提交 c5e3764 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 8.1、8.2、8.3
- 类型：文档
- 被谁阻塞：T018

## 目标
用户读 `docs/usage.md` 就能弄懂新行为：token 加权的 cache ratio、未知与 0 的区别、source 含义、`--text` 与降级、显式 Refresh 与 Close、Receipt schema v2 的破坏性变更、两个 trace 开关与分层定位方法；`docs/claude-mods.md` 与 CHANGELOG 同步反映 UI 由 Client 迁到 engine-native Pane。

## 动手前先读
- specs/usage-diagnostics、specs/receipt-ledger-v2、specs/usage-text-fallback、specs/usage-pane-interaction
- design.md；tasks.md 8.1–8.3
- docs/usage.md、docs/claude-mods.md、CHANGELOG.md、README.md、ARCHITECTURE.md 现状
- T006 到 T017 的回执（以实际实现为准写文档，不照设计稿想当然）
- AGENTS.md 的完成定义：用户可见变化要更新 CHANGELOG.md

## 边界
- 只动：docs/usage.md、docs/claude-mods.md、CHANGELOG.md、README.md、ARCHITECTURE.md
- 适用通用规则：无（纯文档）；文档说法必须与代码一致
- 必须保持：
  - ratio 定义写成 token 加权 `cache read / (uncached input + cache read + cache write)`（tasks 8.1）
  - 写明 unknown 不等于 0、source 的四种含义、Claude 原生 usage UI 没有 ratio 位这一限制（tasks 8.1）
  - Receipt schema v2 在 CHANGELOG 与 usage.md 都标明 BREAKING，说明读取方需要处理 source 和省略字段（tasks 8.3）
  - claude-mods.md 保持「UI 走 Claude Mods、不建替代渲染器」的规则，并写清 usage-view.ts 保留一版且无人引用（tasks 8.2）
  - 写明「`$` 只能传入同文件函数」的限制，因为它决定了 uiTrace 的位置

## 验收
1. `npx biome check --error-on-warnings docs *.md` → 无报错
2. 文档里出现的环境变量、命令、文件路径、参数都能在代码中找到（`MULTI_USAGE_TRACE`、`MULTI_UI_TRACE`、`MULTI_RECEIPTS_FILE`、`--text`、`usage-host-checklist.md`）→ 人工逐项核对通过
3. 全仓门禁（命令表）→ 通过

## 为什么这样验收
文档单的失败形式是「写得与实现不一致」。所以核对每个被提到的开关与路径都真实存在，并且 Receipt v2 的破坏性变更必须出现在用户最先看到的两个地方。

## 记录
- 提交：c5e3764
- 验收：通过（原记录：lint 与全仓门禁）
- 修正：无
- 存疑：无

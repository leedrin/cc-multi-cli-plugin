# T018：Orca 手工 E2E 清单与版本矩阵模板（任务 7.7）

> 补写说明（2026-10-01）：原工单被缩水成一行「done 089462b」。本文按 PLAN.md、tasks.md 7.7（7.8 另见 blocked/T018b）、回执和提交 089462b 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 7.7（任务 7.8 无法无人值守完成，见 blocked/T018b-claude-version-matrix.md，tasks.md 不勾选）
- 类型：文档
- 被谁阻塞：T017

## 目标
给无法自动化的真机宿主验证提供一份可以直接照着做、照着填的手工清单：记录模板、三个测试（焦点、同版本两个宿主对比、`--text` 全宿主一致）和宿主矩阵表，使以后在 Orca、Windows Terminal 等真实终端上验证时有统一判定标准。

## 动手前先读
- specs/usage-verification（手工 E2E 清单要求）
- design.md D12；tasks.md 7.7、7.8
- PRD 中 Orca 兼容性相关章节（MP-0065）
- docs/usage.md 中 `--text` 与 `MULTI_UI_TRACE` 的描述（T019 会补全，这里先保持一致）
- T017 的宿主矩阵 fixture：清单只补字节层，不重复 fixture 已覆盖的事件层

## 边界
- 只动：docs/usage-host-checklist.md（新）
- 适用通用规则：无（纯文档）
- 必须保持：
  - 记录模板包含 Orca 或其他宿主及版本、Claude Code 版本、OS、shell 或 PTY、cc-multi commit（tasks 7.7）
  - Test A 判定宿主是否把焦点交给 pane（`/diff` 对照 `/multi-usage`）；Test B 同一构建在两个宿主上对比并逐步检查焦点环、选择、Receipts、滚动、Refresh、Esc、Close、重开、窄窗口；Test C 在所有宿主上 `--text` 一致
  - 写明 `MULTI_UI_TRACE=1` 的用法，用来区分放置、焦点、按键三层
  - 宿主矩阵表按「最低支持、当前 pinned、最新支持」三个 Claude Code 版本留行；没有真机结果的格子保持空白，不得预填结论
  - 不在文档里声称任何宿主已验证通过

## 验收
1. `npx biome check --error-on-warnings docs *.md` → 无报错
2. 清单里引用的命令与路径确实存在（`claude --version`、`git rev-parse --short HEAD`、`/diff`、`/multi-usage`、`/multi-usage --text`、环境变量 `MULTI_UI_TRACE`）→ 人工逐项核对通过
3. 全仓门禁（命令表）→ 通过

## 为什么这样验收
这是文档单，没有可执行行为；验收看格式合规与引用真实。更重要的是诚实：清单只提供方法与空表，真机结果留空，由 T018b 明确记为外部条件阻塞。

## 记录
- 提交：089462b
- 验收：通过（原记录：文档检查与全仓门禁）
- 修正：无
- 存疑：7.8 无外部环境，已挪 blocked/ 且 tasks.md 不勾选（原回执）

# T013：引擎原生 Pane 迁移（并入 T012，未单独执行）

> 补写说明（2026-10-01）：原来 PLAN.md 留了一行「T013 （并入 T012）」，状态写成「完成」，没有工单也没有回执，被 `records audit` 判为占位行。现在按「合并工单不留占位行」的规则挪到 dropped/，PLAN.md 状态改为「放弃」。

- openspec：usage-correctness-observability / 无（任务 6.1–6.9 全部由 T012 覆盖并勾选）
- 类型：代码
- 被谁阻塞：T012

## 目标
原拆解把 Stage 4 分成两张单：T012 负责 usage-pane 状态与渲染，T013 负责把 `ui.render` 从 `Client('./usage-view.ts')` 迁到直接返回元素树。执行 T012 时两部分不可分（没有迁移就无法验证渲染，没有渲染就无法验证迁移），所以 T013 没有独立执行。

## 动手前先读
- T012 工单与回执：_solo-self/done/T012-engine-native-pane.md、_solo-self/_receipts/T012.md
- tasks.md 6.1–6.9
- 提交 6444bf1（usage-ui: migrate pane state to Claude Mods focus and scroll）

## 边界
- 只动：无（本单不产生改动）
- 适用通用规则：无
- 必须保持：tasks.md 6.1–6.9 的每条都被 T012 覆盖；本单号不再使用

## 验收
1. 对照 T012 工单边界与回执，确认 tasks.md 6.1–6.9 全部在 T012 的提交 6444bf1 中落地 → 通过（见 T012 回执的审查与验收）
2. tasks.md 6.1–6.9 在 `openspec instructions apply --change usage-correctness-observability --json` 的统计里全部已勾选 → 通过

## 为什么这样验收
这张单本身不做事，只需证明它承担的任务没有漏：靠 T012 的验收覆盖和 tasks.md 的勾选状态。

原因：并入 T012，原因见「目标」；T012 的提交是 6444bf1。

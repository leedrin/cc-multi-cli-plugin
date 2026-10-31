# T018b：三个 Claude Code 版本上记录 Usage UI 结果（任务 7.8）⏸ 待外部条件

> 补写说明（2026-10-01）：原文件只有 3 行，没有按工单格式写，也没有在 PLAN.md 里登记。本文按原内容与 tasks.md 7.8 补全；原文的事实保持不变。

- openspec：usage-correctness-observability / 任务 7.8（tasks.md 未勾选，行末带「⏸ 待外部条件」标记的状态以 tasks.md 为准）
- 类型：外部
- 被谁阻塞：T018

## 目标
在最低支持、当前 pinned、最新支持三个 Claude Code 版本上，分别在真实终端宿主里交互运行 `/multi-usage`，把版本、宿主、OS 与交互结果填进 docs/usage-host-checklist.md 的宿主矩阵，证明 Usage pane 在这三个版本上都可用或可降级。

## 动手前先读
- tasks.md 7.8；specs/usage-verification（宿主与版本矩阵）
- docs/usage-host-checklist.md（记录模板、Test A、B、C 与宿主矩阵表，由 T018 交付）
- T017 的宿主矩阵 fixture（离线层已覆盖的引擎事件契约）
- PLAN.md「拆解假设」中关于 7.8 的说明

## 边界
- 只动：docs/usage-host-checklist.md 的「Host matrix」表（仅填入真实运行结果）
- 适用通用规则：不预填、不编造结果
- 必须保持：
  - 没有真机结果的格子保持空白，不得由代码或文档推断填写
  - tasks.md 7.8 在拿到真实结果之前不勾选
  - 不为了「全部完成」而降低 7.8 的要求

## 验收
1. 三个 Claude Code 版本（最低支持、当前 pinned、最新支持）各完成一次 Test A、Test B、Test C，并把结果写进宿主矩阵 → 需要真实终端与多版本环境
2. 矩阵每一行都有版本、宿主、OS、interactive 结果，且与 `MULTI_UI_TRACE=1` 的日志一致 → 同上
3. `npx biome check --error-on-warnings docs` → 无报错

## 为什么这样验收
这个任务的价值就在于真实宿主上的结果，离线 fixture 已经覆盖引擎事件层，剩下的字节层与宿主差异只能靠真机验证；因此宁可保持未完成并如实报告，也不能用推断填表。

原因：需要三个 Claude Code 版本和真实交互终端；本机只有 Claude Code 2.1.285 且无人值守，无法完成。模板与步骤已交付（T018）；离线层已覆盖引擎事件契约。

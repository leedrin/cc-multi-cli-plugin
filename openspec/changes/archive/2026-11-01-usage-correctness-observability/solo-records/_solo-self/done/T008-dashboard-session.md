# T008：Dashboard session usage（任务 4.8–4.13）

> 补写说明（2026-10-01）：原工单被缩水成「见 _receipts/T008.md」。本文按 PLAN.md、tasks.md 4.8–4.13、回执和提交 5e12070 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 4.8、4.9、4.10、4.11、4.12、4.13
- 类型：代码
- 被谁阻塞：T007

## 目标
`/multi/mod/usage` 的 provider 行带上结构化的会话用量（Context、Consumed 的 input、cache read、cache write、ratio、output、reasoning、total，以及 Source），文字行由同一份结构生成；unavailable、mixed、estimate 的措辞各自正确，不把未知显示成 0。

## 动手前先读
- specs/provider-usage-dashboard（session 字段、措辞与 ratio 规则、quota 失败时的行为）
- design.md D6、D7；tasks.md 4.8–4.13
- plugins/multi-core/src/gateway/provider-usage.ts 全文（30 秒缓存、pending 合并、32 并发、refresh、会话作用域）
- T007 产出：receipts 的 V2 totals、`ContextUsage`（本单要导出）
- test/unit/native-provider-usage.test.ts 现有断言

## 边界
- 只动：plugins/multi-core/src/gateway/provider-usage.ts、plugins/multi-core/src/gateway/receipts.ts（仅导出 `ContextUsage`）、test/unit/native-provider-usage.test.ts、plugins/multi-core/hooks/tests/usage.test.ts（receipts 加载失败用例）
- 适用通用规则：未知与零；状态与容量（缓存与并发）
- 必须保持：
  - URL、网关 token 认证、会话作用域、只读、30 秒缓存、pending 合并、32 并发上限、`refresh=true` 不变（tasks 4.10）
  - unavailable 显示 `usage unavailable`，不出现 0（tasks 4.9）
  - mixed 只显示已知计数并提示不完整，没有聚合 ratio；estimate 显示 `~x% (estimated)`（tasks 4.9）
  - provider 行新增的 `session` 是可选字段，旧读者不受影响（tasks 4.10）
  - quota 查询失败时行 status 为 `error`，仍显示会话用量；Receipts 加载失败保持旧数据并显示 `Could not load receipts.`（tasks 4.12）

## 验收
1. `node --test --test-timeout=120000 test/unit/native-provider-usage.test.ts` → 通过
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过（原记录：605 个单元测试、81 个 hook 测试）

## 为什么这样验收
这一单决定用户在 dashboard 里看到什么数字，最容易出错的是「没有数据却显示 0」和「mixed 被算出一个看似精确的 ratio」。所以用例按 source 分开逐个锁住措辞，并保留原有的缓存、合并、刷新、认证断言，确认没有回归。

## 记录
- 提交：5e12070
- 验收：通过（原记录：重跑 6 条命令）
- 修正：无
- 存疑：无

# T007：Receipt schema v2（任务 4.1–4.7）

> 补写说明（2026-10-01）：原工单被缩水成几行摘要（缺类型、目标、先读、边界、为什么这样验收）。本文按 PLAN.md、tasks.md 4.1–4.7、原工单摘要、回执和提交 d1067cb 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 4.1、4.2、4.3、4.4、4.5、4.6、4.7
- 类型：代码
- 被谁阻塞：T006

## 目标
收据账本从「缺失记 0」改为带来源的 v2：`schemaVersion: 2`，每个 totals 带 `source`，从未上报的计数不序列化，失败或取消且没有 completion 的调用是 `{ source: 'unavailable' }`，`cache_read_ratio` 只在 provider 来源且分母已知时输出。

## 动手前先读
- specs/receipt-ledger-v2、specs/usage-accounting（mergeUsageSource、unavailable 的协议占位）
- design.md D4–D6；tasks.md 4.1–4.7
- plugins/multi-core/src/gateway/receipts.ts 全文（现有 totals、context、容量上限、replay 与 requestId 去重）
- T004 的 `UsageAccumulator`、`mergeUsageSource`、`cacheReadRatio`；T005 的 accounting 协议块
- provider-usage.ts 对 receipts 类型的依赖（本单只做类型适配）

## 边界
- 只动：plugins/multi-core/src/gateway/receipts.ts、plugins/multi-core/src/gateway/provider-usage.ts（仅类型适配，T008 重写）、test/unit/native-receipts.test.ts、test/unit/native-harness-usage.test.ts、test/unit/native-provider-usage.test.ts
- 适用通用规则：未知与零；状态与容量（收据上限）
- 必须保持：
  - spend 顺序固定：accounting → harness 的 consumed_* → legacy 标准 usage；unavailable 不吸收协议占位 0（tasks 4.2）
  - 序列化省略从未知过的计数；明确的 0 要保留（tasks 4.6）
  - `cache_read_ratio` 仅 provider 来源输出，mixed 不输出（tasks 4.3）
  - failed、cancelled 无 completion → unavailable 且 `incomplete: true`；有 completion 后取消保留已知 usage（tasks 4.4）
  - 最近一次响应的 context 与 totals 分离；unavailable 时 context 不显示 0（tasks 4.5）
  - 容量上限 256 / 128 / 512 / 8192 / 128、replay 忽略、requestId 去重不变（tasks 4.5）
  - Cursor、Zen、Antigravity、Grok 经 legacy 回退的数值不变（tasks 4.7）

## 验收
1. `node --test --test-timeout=120000 test/unit/native-receipts.test.ts test/unit/native-harness-usage.test.ts test/unit/native-provider-usage.test.ts` → 通过
2. `node --test --test-timeout=120000 test/unit/native-cursor-usage.test.ts test/unit/native-grok-usage.test.ts test/unit/native-zen-usage.test.ts` → 通过（legacy 回退数值不变）
3. `npx biome check --error-on-warnings plugins/multi-core/src/gateway test/unit` → 无报错；`npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过
5. `test/e2e/usage-receipts.test.ts` → 当时因找不到 claude.exe 无法运行，记外部阻塞；后来确认该判断有误，已在 T020 的全量 e2e 里通过（见 T016、T017、T020 回执）

## 为什么这样验收
v2 改的是落盘与读取的数据语义，最怕静默把未知变成 0 或回退其它 provider 的数值，所以既有 provider 的 usage 测试必须原样保持通过，新增用例专门锁住 explicit zero、unavailable、mixed、取消、context 分离、replay 与去重。

## 记录
- 提交：d1067cb
- 验收：通过（原记录：重跑 6 条命令；e2e/usage-receipts 当时记外部阻塞，后在 T020 全量 e2e 通过）
- 修正：无
- 存疑：无 source 的事件按 unavailable 处理，只有测试夹具会出现（回执原记录）

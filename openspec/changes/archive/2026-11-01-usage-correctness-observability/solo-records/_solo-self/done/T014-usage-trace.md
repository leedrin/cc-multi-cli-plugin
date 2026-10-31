# T014：MULTI_USAGE_TRACE（任务 7.1）

> 补写说明（2026-10-01）：原工单被缩水成一行「done f671394」。本文按 PLAN.md、tasks.md 7.1、回执和提交 f671394 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 7.1
- 类型：代码
- 被谁阻塞：T012

## 目标
设置 `MULTI_USAGE_TRACE=1` 后，网关每收到一次 provider 的 terminal usage 就写一行只含元数据的 JSON（provider、event、source、各已知 token 计数，usage 缺失时 `usagePresent: false`），用来分层定位「provider 原始值 → 网关 → 账本 → 面板」哪一层出了问题；默认完全不输出。

## 动手前先读
- specs/usage-diagnostics（trace 内容与安全约束）
- design.md D10；tasks.md 7.1
- plugins/multi-openai/src/responses.ts 的 `finish()`（T006 之后的版本）
- T004 的 `CanonicalTokenUsage`、T005 的 unavailable 语义
- AGENTS.md 中密钥与日志的规矩

## 边界
- 只动：plugins/multi-core/src/gateway/usage-trace.ts（新）、plugins/multi-openai/src/responses.ts（在 `finish()` 调用一次）、test/unit/native-usage-trace.test.ts（新）
- 适用通用规则：密钥与敏感数据不进日志；未知与零
- 必须保持：
  - 默认关闭，只有 `MULTI_USAGE_TRACE` 恰为 `1` 才输出（tasks 7.1）
  - 输出字段是封闭集合，不含 prompt、assistant 文本、推理密文、工具参数、header、凭据
  - usage 缺失只输出 `usagePresent: false` 加 source，不伪造 0（specs/usage-diagnostics）
  - `server.ts` 不改；OpenAI 与 Zen 共用同一调用点，provider 取 `safeguardProvider`
  - 未上报的计数不出现在输出里

## 验收
1. `node --test --test-timeout=120000 test/unit/native-usage-trace.test.ts` → 通过
2. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
3. 全仓门禁（命令表）→ 通过

## 为什么这样验收
trace 是诊断开关，必须保证关着时无副作用、开着时不泄漏内容。用例分别锁住开关、字段集合、缺失 usage、OpenAI 集成调用一次、内容不入 trace 五件事。

## 记录
- 提交：f671394
- 验收：通过（原记录：gate 全绿）
- 修正：无
- 存疑：无

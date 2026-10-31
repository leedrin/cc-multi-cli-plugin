# T006：responses.ts 接入 usage 解析（任务 3.7–3.11）

> 补写说明（2026-10-01）：原工单被缩水成一行指针（「已完成，提交 77d5ed7。见 _receipts/T006.md」）。本文按 PLAN.md 的工单行、tasks.md 的 3.7–3.11、回执和提交 77d5ed7 的 diff 还原；当时写的原文未保留，凡还原不了的地方标「当时未记录」。

- openspec：usage-correctness-observability / 任务 3.7、3.8、3.9、3.10、3.11
- 类型：代码
- 被谁阻塞：T005

## 目标
OpenAI Responses 的 terminal usage 在 `responses.ts` 里不再被压成「缺失记 0」：`finish()` 用 T005 的解析结果写协议 usage 与 `multi_usage`（含 accounting、reasoning、total、source）；缺失 usage 的 OpenAI 响应成功返回且不二次调用上游，Zen 缺失 usage 仍然报错。

## 动手前先读
- specs/openai-response-usage（Unavailable 与 malformed 必须区分）、specs/usage-accounting（协议 usage 与 accounting truth 分离）
- design.md D1–D3；tasks.md 3.7–3.11
- plugins/multi-openai/src/responses.ts：`validResponse()`、`finish()`、`requireUsage` 的使用处
- T005 产出：response-usage.ts 的 `parseOpenAIResponseUsage`、`isOpenAIResponsesUsage`、`openAIProtocolUsage`、`responseUsageMetadata`
- T001 的存疑：null input details 当时被 `validResponse` 拒绝，这一单要翻转这条断言

## 边界
- 只动：plugins/multi-openai/src/responses.ts、plugins/multi-openai/src/response-usage.ts（补 `openAIProtocolUsage` 与 `responseUsageMetadata`）、test/unit/native-openai-stream.test.ts、test/unit/native-provider-matrix.test.ts
- 适用通用规则：未知与零（accounting 路径不得把未知写成 0）
- 必须保持：
  - OpenAI 的 `requireUsage` 仍为 false，Zen 仍为 true；Zen 缺 usage 仍抛「Provider completed without token usage」（tasks 3.9）
  - OpenAI 缺失 usage 成功返回，且上游只被调用一次、不重跑（tasks 3.9）
  - `message_start` 的 provisional usage 仍是估计 input、output 为 0，`message_delta` 为 final（tasks 3.10）
  - `server.ts` 无 dispatch / passthrough 改动，只允许类型兼容的增量（tasks 3.11）
  - 对外错误文案保持「malformed response.completed event」（T005 存疑）
  - 协议 usage 不再输出未上报的 `cache_creation_input_tokens: 0`（实施期假设补充，PLAN.md）

## 验收
1. `node --test --test-timeout=120000 test/unit/native-openai-stream.test.ts test/unit/native-provider-matrix.test.ts test/unit/native-zen-usage.test.ts` → 通过
2. `npx biome check --error-on-warnings plugins/multi-openai/src plugins/multi-core/src test/unit` → 无报错
3. `npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过（含 hook 测试，原回执记录 601 个单元测试、80 个 hook 测试）

## 为什么这样验收
这一单的风险在于改了既有行为：缺失 usage 不再记成 provider 的 0，协议 usage 少了一个键。所以既有断言必须同步更新并说明原因，而不是放宽；同时用网关级用例锁住「不二次调用上游」和「Zen 仍拒绝」两条不能动的行为。

## 记录
- 提交：77d5ed7
- 验收：通过（原记录：全仓门禁，601 个单元测试与 80 个 hook 测试通过）
- 修正：无（原记录）
- 存疑：无（原记录）

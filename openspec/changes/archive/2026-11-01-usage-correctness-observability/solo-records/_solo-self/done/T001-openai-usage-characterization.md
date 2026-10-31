# T001：OpenAI terminal usage 变体表征

- openspec：usage-correctness-observability / 任务 1.1、1.2、1.3、2.4
- 类型：表征
- 被谁阻塞：无

## 目标
锁定当前 OpenAI Responses 流对五种 usage 形态的行为（message_start provisional、terminal 完整、缺失、部分、null details），使后续 accounting 改动不会被误判成行为变化；缺失的 usage 不会被断言成 provider 上报的 0。

## 动手前先读
- specs/usage-verification「修改前先做 characterization」、specs/openai-response-usage
- plugins/multi-openai/src/responses.ts：`validResponse()`、`finish()`
- test/unit/native-openai-stream.test.ts 现有 `terminal()`、`stream()`、`capture()` 帮助函数

## 边界
- 只动：test/unit/native-openai-stream.test.ts
- 适用通用规则：未知与零、测试
- 必须保持：
  - 不改任何产品代码（Stage 0 只加测试，usage-verification）
  - 断言只写「改动前后都成立」的不变量：缺失 usage 的 `multi_usage.source === 'unavailable'`，不得写 `source === 'provider'`（usage-verification「unavailable 不被断言为 zero」）；部分 usage 只断言协议数值，不断言 source/total（T006 会把它们改成 mixed/unknown）
  - 当前对 null details 的行为是「拒绝为 malformed」，与目标 spec（接受）相反：这条按现状锁定，并在测试名/注释中写明 T006 会翻转它

## 验收
1. `node --test --test-timeout=120000 test/unit/native-openai-stream.test.ts` → 全部通过（含新增）
2. `npx biome check --error-on-warnings test/unit/native-openai-stream.test.ts` → 无报错
3. `npm run typecheck` → 无报错
4. 变异验证：临时把 `responses.ts` `finish()` 里 `source: usage ? 'provider' : 'unavailable'` 改成 `source: 'provider'`，预期「缺失 usage」测试变红；做完用编辑工具恢复。

## 为什么这样验收
这些测试要保住的是「缺失 usage ≠ provider 上报 0」这一语义在重构中不被悄悄改变（spec scenario「unavailable 不被断言为 zero」）。变异验证证明断言确实落在 `source` 上而不是只看返回值不抛错。

## 记录
- 提交：2091a78
- 验收：通过（重跑 4 条命令）
- 修正：无
- 存疑：null details 的 input 侧拒绝行为待 T006 翻转

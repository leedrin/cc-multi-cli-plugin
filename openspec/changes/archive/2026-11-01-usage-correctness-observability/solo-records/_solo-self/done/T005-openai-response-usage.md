# T005：OpenAI response-usage 解析与协议适配

- openspec：usage-correctness-observability / 任务 3.3、3.4、3.5、3.6
- 类型：代码
- 被谁阻塞：T004

## 目标
新增独立的 OpenAI Responses usage 解析：缺失/null → unavailable，部分 → mixed，完整 → provider；保留 reasoning、total、cache read/write；非法数值抛 malformed；协议 usage 与 accounting 块分离（占位 0 只出现在 `toProtocolUsage`）。

## 动手前先读
- specs/openai-response-usage、specs/usage-accounting「协议 usage 与 accounting truth 分离」
- design.md D1–D3；detailed-design §10、§11、§13、§14、§54–§58
- plugins/multi-openai/src/responses.ts `validResponse()`（本单不改它，T006 接入）
- plugins/multi-core/src/gateway/messages.ts 的 `Usage`、`multi_usage`

## 边界
- 只动：plugins/multi-openai/src/response-usage.ts（新）、plugins/multi-core/src/gateway/messages.ts、test/unit/native-openai-response-usage.test.ts（新）
- 适用通用规则：未知与零
- 必须保持：
  - 不修改 plugins/multi-openai/src/usage.ts（账户配额 reader）（openai-response-usage「文件命名不冲突」）
  - messages.ts 只做 additive：可选 `accounting` 块与 `toProtocolUsage()`，现有类型兼容（design D2）
  - uncached input = max(0, input − cached − cache_write)；cached/cache_write 缺失只在这处减法里按 0 参与，不写进 canonical
  - totalTokens：provider total 优先；缺失且 raw input/output 均已知才推导；否则未知
  - reasoning 缺失 → undefined；details 为 null/缺失 → 接受，对应字段未知
  - 负数/小数/非有限/超安全整数 → 抛错（openai-response-usage「Unavailable 与 malformed 必须区分」）
  - unavailable 的协议 usage 为 `{input_tokens:0, output_tokens:0}` 且无 cache 字段；其占位 0 不得出现在 accounting 块（usage-accounting「unavailable 的协议占位」）
  - mixed 示例：`{input_tokens:100, cached_tokens:40}` → canonical mixed, input 60, read 40, output 未知；协议 `{input_tokens:60, output_tokens:0, cache_read_input_tokens:40}`

## 验收
1. `node --test --test-timeout=120000 test/unit/native-openai-response-usage.test.ts` → 通过
2. `npx biome check --error-on-warnings plugins/multi-openai/src/response-usage.ts plugins/multi-core/src/gateway/messages.ts test/unit/native-openai-response-usage.test.ts` → 无报错
3. `npm run typecheck`、`npx knip` → 无报错
4. 先红：抛 `not implemented` 的桩跑测试，记录失败行。

## 为什么这样验收
覆盖 spec 列出的每个输入变体（full、absent、null、partial input only/output only、null details、cache read/write、reasoning、provider total、derived total、explicit zero、三类非法数值）；用断言落在 canonical 各字段与协议 usage 键是否存在上，确认 unknown 没被写成 0。

## 记录
- 提交：0fd9f4e
- 验收：通过（重跑 5 条命令）
- 修正：无
- 存疑：无

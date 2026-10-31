# T004：usage-accounting 共享模块

- openspec：usage-correctness-observability / 任务 3.1、3.2
- 类型：代码
- 被谁阻塞：T003

## 目标
网关有一个不依赖任何 provider 的 canonical usage 模型：`undefined` 表示未知、`0` 表示明确为 0；source 合并、token 加权 cache read ratio、带 known 标记的累加器与 v2 totals 序列化都集中在这一处。

## 动手前先读
- specs/usage-accounting（全部 requirement）、specs/receipt-ledger-v2「内部累加器」「聚合 source 合并」「聚合 reasoning、total 与 cache ratio」
- design.md D1、D4、D5；detailed-design §8、§12、§20、§21、§53

## 边界
- 只动：plugins/multi-core/src/gateway/usage-accounting.ts（新）、test/unit/native-usage-accounting.test.ts（新）
- 适用通用规则：未知与零、测试
- 必须保持：
  - 模块不导入任何 provider 模块、不引入 registry / adapter 抽象（usage-accounting「不引入 provider 架构」）
  - 任何 helper 不得 `?? 0` 把未知变 0（usage-accounting「Unknown 与 zero 语义固定」）
  - ratio = cacheRead / (uncached input + cacheRead + cacheWrite)；分母 0、input 或 cacheRead 未知、source=unavailable → undefined；cacheWrite 未知时分母只含已知项（拆解假设，见 PLAN）
  - 聚合序列化：`mixed` 不输出 ratio；仅 `provider` 且分母已知才输出 `cache_read_ratio`（receipt-ledger-v2「聚合 reasoning、total 与 cache ratio」）
  - mergeUsageSource：同 source 不变；不同为 mixed；任一侧 mixed 为 mixed（usage-accounting「Source 合并规则」）
  - 新导出都被测试引用（knip）

## 验收
1. `node --test --test-timeout=120000 test/unit/native-usage-accounting.test.ts` → 通过
2. `npx biome check --error-on-warnings plugins/multi-core/src/gateway/usage-accounting.ts test/unit/native-usage-accounting.test.ts` → 无报错
3. `npm run typecheck`、`npx knip` → 无报错
4. 先红：用抛 `not implemented` 的桩跑测试，记录失败行。

## 为什么这样验收
这是所有后续层（OpenAI parser、Receipt、Dashboard）共享的判定，测试逐条覆盖 spec 的 0 input / 无缓存 / 100% 缓存 / cache write / mixed / source 全组合 / 已知 0 与未知的区别。先红证明断言落在行为上。

## 记录
- 提交：8422074
- 验收：通过（重跑 4 条命令）
- 修正：无
- 存疑：无

# T002：provider matrix / routing / 公共行为表征

- openspec：usage-correctness-observability / 任务 2.1、2.2、2.3
- 类型：表征
- 被谁阻塞：T001

## 目标
用一个新测试文件锁定 openai / zen / cursor / antigravity / grok 五个 provider 的「模型行 → worker 类型 → 只路由一次 → 完成事件 usage/source → 未知模型报错 → /multi-usage 提供商行」的现状，使后续 usage 补丁若意外改了 provider/worker 行为会立刻变红。

## 动手前先读
- specs/usage-verification「修改前先做 characterization」（MP-0001/0002/0003）
- test/unit/native-gateway.test.ts 的 `provider routing sends each external model to one handler route`（已有路由测试，本单要补「恰好一次」和每 provider 的 usage/source）
- plugins/multi-core/src/gateway/worker-catalog.ts `buildWorkerCatalog`、provider-usage.ts 的 provider 列表

## 边界
- 只动：test/unit/native-provider-matrix.test.ts（新）
- 适用通用规则：未知与零、测试
- 必须保持：
  - 只加测试，不改产品代码（Stage 0）
  - 不启动 provider 架构重构、不新增 registry 抽象（usage-verification）
  - 断言只写改动前后都成立的不变量；dashboard 细节行和 accounting 块不在此锁定（后续单会改）

## 验收
1. `node --test --test-timeout=120000 test/unit/native-provider-matrix.test.ts` → 通过
2. `npx biome check --error-on-warnings test/unit/native-provider-matrix.test.ts` → 无报错
3. `npm run typecheck` → 无报错
4. 变异验证：临时把 server.ts 里某 provider 的一次路由改成触发两次（或把测试里期望的 route 改错），预期路由测试变红；用编辑工具恢复。

## 为什么这样验收
锁住「每个 provider 恰好路由一次」「完成事件的 route/endpoint/source」这些 usage 补丁不应碰的边界。变异验证确认断言真的落在 handler 计数/路由事件上。

## 记录
- 提交：64edb62
- 验收：通过（重跑 4 条命令）
- 修正：无
- 存疑：无

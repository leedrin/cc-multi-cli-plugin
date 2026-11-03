## MODIFIED Requirements

### Requirement: 补丁层边界
已归档的 usage-correctness-observability 变更是可长期跟随 upstream 的低侵入补丁层，它对 ProviderRegistry、ModelIdentity、ModelDescriptor、DirectProviderAdapter、ProviderRuntime、Pi AI 以及 launcher、worker catalog、gateway dispatch 的禁止只约束该补丁层本身。Multi-Provider v2 按“可吸收”条款吸收补丁层，可以引入上述结构，但 MUST NOT 让本能力和 usage 相关能力的其他要求回退。依赖方向 SHALL 单向：usage-accounting MUST NOT import Registry 或任何 provider 模块，provider 一侧依赖 usage-accounting。Generic API Provider、Pi NativeHarness 和动态 provider 插件加载仍不在 v2 首批范围内。

#### Scenario: 不触碰受限文件
- **WHEN** 审查 usage 补丁层（已归档的 usage-correctness-observability）的 diff
- **THEN** `plugins/multi-core/src/launcher.ts`、`server.ts` 的 provider routing、`worker-catalog.ts`、`install/plugins.ts` SHALL 无修改（除 `server.ts` 的 type-compatible 增量）；该约束不适用于 Multi-Provider v2

#### Scenario: 需要越界时停止
- **WHEN** 某个 usage 修复只能通过 provider 架构重构完成
- **THEN** 该工作 SHALL 移出 usage 补丁层，并进入 Multi-Provider v2

#### Scenario: v2 不让 usage 回退
- **WHEN** Multi-Provider v2 完成后运行 usage 相关的既有测试
- **THEN** 它们 SHALL 全部通过，且断言没有修改

#### Scenario: 依赖方向
- **WHEN** 检查 usage-accounting 模块的 import
- **THEN** SHALL 不出现 Registry 或 `plugins/multi-*` 下的模块

#### Scenario: 首批范围之外的结构
- **WHEN** 审查 Multi-Provider v2 首批的 diff
- **THEN** SHALL 不包含 Generic API Provider、Pi NativeHarness 或动态 provider 插件加载

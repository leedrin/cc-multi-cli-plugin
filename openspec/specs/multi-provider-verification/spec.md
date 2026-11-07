# multi-provider-verification Specification

## Purpose
规定 Multi-Provider v2 的验证要求：先固定现有行为，再离线验证 Pi 路径，最后在用户批准的预算内做 live 验收，并对“未完成”给出明确判定。

## Requirements

### Requirement: 改动前先固定现有行为
在修改路由、Registry 或 launcher 之前，SHALL 先建立特征快照，覆盖真实 picker 行、权限断言、`%2F` 编码、连字符 provider、Cursor 预设和 `[1m]`。快照 SHALL 在未修改的代码上通过。之后的阶段只允许改动明确列出的差异。

#### Scenario: 快照基线
- **WHEN** 在未修改的代码上运行快照测试
- **THEN** 测试 SHALL 通过

#### Scenario: 唯一允许修改的既有断言
- **WHEN** 路由阶段完成后检查既有测试
- **THEN** 唯一修改的既有断言 SHALL 是“未知 provider 回落 OpenAI”改为“返回 BadRequest”

### Requirement: 先行验证
实现 Pi 适配之前 SHALL 完成并记录以下一次性实验：用假密钥和录制的 SSE 离线跑通真实的 Pi `openai-completions` 路径并观察 usage；`[1m]` 与已保存选择的行为；Pi 依赖的磁盘增量和加载耗时；Claude Code 实际发送的请求字段和 effort 值。实验代码 MUST NOT 进入仓库，实验 MUST NOT 联网或使用真实密钥。

#### Scenario: 离线跑通失败
- **WHEN** 离线实验无法用真实 Pi 路径走通 start、内容和 done
- **THEN** SHALL 停止 Pi 适配并重新评估方案，不得继续实现

### Requirement: 离线 fixture 覆盖
Pi 适配的测试 SHALL 用注入的 fetch 和录制的 SSE 走真实的 Pi `openai-completions` 路径，全部离线、不需要密钥。fixture SHALL 使用 Pi 的真实事件顺序（块开始立即发出、所有结束事件在流末尾）。

#### Scenario: 无网络运行
- **WHEN** 在无网络、无密钥的环境运行单测
- **THEN** 全部 Pi 测试 SHALL 通过

### Requirement: 未启用时无启动开销
没有启用 `multi-pi`，或启用但没有任何 Pi 密钥时，启动 SHALL 不加载 Pi 依赖。Registry 构建 SHALL 在 100 ms 内完成。

#### Scenario: 无密钥启动
- **WHEN** 启用 `multi-pi` 但没有设置任何 Pi 密钥
- **THEN** 启动过程中 SHALL 没有加载 Pi 依赖

### Requirement: 每阶段的检查
每个实施阶段结束时 SHALL 通过 `npm run check`，且没有 `DEP0190` 警告。涉及 hooks 的阶段 SHALL 另外通过 `npm run test:mod`。用户可见的改动 SHALL 更新 `CHANGELOG.md`。

#### Scenario: 阶段结束
- **WHEN** 一个阶段的改动完成
- **THEN** `npm run check` SHALL 通过，hooks 阶段的 `npm run test:mod` SHALL 通过

### Requirement: live 验收需用户批准
`npm run test:live:pi` SHALL 只在用户明确批准后运行，并且只使用用户提供的环境变量中的密钥。DeepSeek 和 GLM（密钥所属端点）都 SHALL 通过 live 验收才算完成里程碑：多轮工具调用、thinking 往返和用量显示。Strata 单独验收，不阻塞里程碑。

#### Scenario: 未获批准
- **WHEN** 用户没有批准 live 验收
- **THEN** SHALL 不运行任何付费调用，里程碑记为未完成

### Requirement: live 预算按上游调用计数
live 预算 SHALL 按 gateway 记录的上游调用计数，每个 provider 最多 10 次。用完即停，结果记为“验收未完成”，追加调用须重新获得批准。SHALL 使用白名单中最便宜的模型和它支持的最低 effort，`max_tokens` 约 1024。

#### Scenario: 预算用完
- **WHEN** 某 provider 用完 10 次上游调用，仍有场景未完成
- **THEN** SHALL 停止该 provider 的调用，并在报告中记为验收未完成

### Requirement: 截断不算通过
live 场景中任一调用的停止原因为 `max_tokens`，或 thinking 被截断而没有产生文本或工具调用时，该场景 SHALL 记为“未完成”，不算通过。报告 SHALL 列出每个 provider 的实际调用次数、各场景结果和 usage。

#### Scenario: thinking 用完输出上限
- **WHEN** 一次 live 调用只产生了 thinking，停止原因为 `max_tokens`
- **THEN** 该场景 SHALL 记为未完成

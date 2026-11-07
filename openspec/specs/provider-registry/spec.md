# provider-registry Specification

## Purpose
让 provider 名单只有一个来源：picker、worker、插件启用、usage reader、review 策略和签名过滤都从同一份注册信息派生，新增 provider 不需要修改 gateway 核心。

## Requirements

### Requirement: 单一 provider 事实来源
系统 SHALL 有一张 host-free 的 provider 事实表，记录每个 provider 的 ID、所属插件、类型（direct 或 harness）、worker 名称和显示标签。gateway、launcher 和 hooks 判断 provider、harness 模型和 provider worker 时 SHALL 只用这张表，MUST NOT 用 `multi-*` 名称模式猜测。

#### Scenario: 用户自建的 multi- 开头的 agent
- **WHEN** 用户有一个名为 `multi-foo` 的自定义 agent
- **THEN** 系统 SHALL NOT 把它当成 provider worker

#### Scenario: hooks 与 gateway 判断一致
- **WHEN** hooks 和 gateway 判断同一个 worker 名称或模型路由
- **THEN** 两者 SHALL 得出相同的 provider 和类型

### Requirement: 注册校验
注册 provider 时，系统 SHALL 检查：ID 合法、不重复、不是保留 ID、在事实表中存在，且插件和类型与事实表一致、类型与提供的执行方式匹配。任何一项不通过 SHALL 抛错并终止启动，MUST NOT 静默跳过。

#### Scenario: 重复 ID
- **WHEN** 两个描述符使用同一个 provider ID
- **THEN** 启动 SHALL 失败并指出重复的 ID

#### Scenario: 类型不匹配
- **WHEN** 一个声明为 direct 的 provider 没有提供 direct 执行方式
- **THEN** 启动 SHALL 失败

### Requirement: 新增 provider 不改 gateway 核心
新增一个 provider SHALL 只需要一个描述符和事实表中的一行。该 provider SHALL 因此出现在 picker、worker 目录和 usage 中，不修改 gateway 的路由、dispatch 和收尾代码。

#### Scenario: fake provider 贯通
- **WHEN** 测试只注册一个 fake provider 的描述符和事实行
- **THEN** 它 SHALL 出现在 picker 行、worker 定义和 usage 中，并能被路由

### Requirement: 按可用性派生 picker 和 worker
picker 和 worker 目录 SHALL 只包含本次启动时插件已启用且可用（例如凭据存在）的 provider。direct provider 的 worker SHALL 使用 Claude 的 worker 工具集。未知 worker SHALL 继续显式失败。

#### Scenario: 没有凭据的 provider
- **WHEN** `multi-pi` 已启用，但没有设置 `DEEPSEEK_API_KEY`
- **THEN** picker 和 worker 中 SHALL 不出现 DeepSeek

#### Scenario: 每个 provider 一个 worker
- **WHEN** `zai-coding-cn` 可用
- **THEN** 系统 SHALL 提供 `multi-zai-coding-cn` worker，并能把它解析回 `zai-coding-cn`

### Requirement: Agent 定义大小不超限
全部 provider 都启用时，传给 Claude 的 agent 定义 SHALL 不超过现有的命令行长度限制，包括 Windows 的 8000 字符。超限时 SHALL 按现有行为报错，MUST NOT 静默裁剪。

#### Scenario: Windows 限制
- **WHEN** 全部 provider 启用，平台为 Windows
- **THEN** agent 定义参数 SHALL 不超过 8000 字符

### Requirement: Review 策略由描述符提供
每个 provider 的自动审查策略 SHALL 由它的描述符声明，MUST NOT 按 provider 名称判断。只有描述符声明使用 reviewer 且运行时确实持有 reviewer 时，才使用 reviewer。没有 reviewer 的 provider 在 auto 模式下 SHALL 不经审查运行并明确说明；plan 模式下 SHALL 拒绝执行动作。

#### Scenario: Pi provider 的 auto 模式
- **WHEN** 在 auto 模式下使用 Pi provider
- **THEN** 动作 SHALL 不经审查运行，并显示其不经审查的说明

#### Scenario: plan 模式
- **WHEN** 在 plan 模式下 Pi provider 请求执行动作
- **THEN** gateway SHALL 拒绝该动作

### Requirement: 外来 thinking 签名前缀由 Registry 汇总
所有 provider 的 thinking 签名前缀 SHALL 由 Registry 汇总。请求转给 Anthropic 时，带有这些前缀的 thinking 块 SHALL 被过滤掉。

#### Scenario: 从 Pi 模型切回 Claude
- **WHEN** 对话历史含 `multipi:v1:` 签名的 thinking 块，下一轮使用 Claude 模型
- **THEN** 发给 Anthropic 的请求 SHALL 不含这些块

### Requirement: 插件启用按插件 ID
`MULTI_ENABLED_PROVIDERS` SHALL 被解释为插件 ID 列表，格式不变。新增的插件 ID `pi` 一项就启用 `deepseek`、`zai`、`zai-coding-cn`、`strata` 这四个 route provider。

#### Scenario: 启用 pi
- **WHEN** `MULTI_ENABLED_PROVIDERS` 含 `pi`，且已设置 `DEEPSEEK_API_KEY`
- **THEN** `multi/deepseek/...` SHALL 可以使用

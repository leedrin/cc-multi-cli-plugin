## ADDED Requirements

### Requirement: 文本模式命令
`/multi-usage` SHALL 支持文本模式:`/multi-usage --text` 输出纯文本,`/multi-usage text` 作为可选别名;不带参数时进入交互 Pane。其它任何参数 SHALL 返回 `Use /multi-usage or /multi-usage --text.`,不发起网关请求。

#### Scenario: --text 输出文本
- **WHEN** 用户执行 `/multi-usage --text`
- **THEN** 命令 SHALL 返回 `{ text }` 且不调用 `$.ui.open`

#### Scenario: text 别名
- **WHEN** 用户执行 `/multi-usage text`
- **THEN** 行为 SHALL 与 `--text` 相同

#### Scenario: 无参数进入 Pane
- **WHEN** 用户执行不带参数的 `/multi-usage`
- **THEN** 命令 SHALL 尝试打开交互 Pane

#### Scenario: 非法参数
- **WHEN** 用户执行 `/multi-usage foo`
- **THEN** 命令 SHALL 返回 `Use /multi-usage or /multi-usage --text.` 且不请求网关

### Requirement: 文本渲染的独立性
文本渲染 SHALL 由纯函数 `renderUsageText(props: UsagePaneProps): string` 完成,放在 `plugins/multi-core/hooks/usage-format.ts`。文本模式 MUST NOT 依赖 Pane、Client、focus、`surface.onKey`、Button、`ui.focus`、`ui.open`、终端键盘或模型调用,只依赖 `/multi/mod/usage` 的数据。

#### Scenario: 无 UI 依赖
- **WHEN** 在没有任何 UI 能力的宿主里调用 `renderUsageText`
- **THEN** 它 SHALL 仅凭 `UsagePaneProps` 产出文本,不访问 `$.ui`

#### Scenario: 无模型调用
- **WHEN** 文本模式执行
- **THEN** 系统 SHALL NOT 发起任何模型推理请求

### Requirement: 文本内容与数据完整性
文本输出 SHALL 覆盖所有 provider(含 unavailable 与 disabled 行),每个 provider 至少包含账户摘要、会话 usage(context、consumed、cache read ratio)、output、reasoning 与 `Source`;unavailable 数据 SHALL 显示为 unavailable 而不是 0。所有 host 上 `--text` 对同一时刻的数据 SHALL 产出一致的 usage 数值。

#### Scenario: 全部 provider 可读
- **WHEN** 五个 provider 中有 ready、disabled、unavailable 混合状态
- **THEN** 文本 SHALL 列出全部五个 provider 及其状态

#### Scenario: usage v2 字段完整
- **WHEN** provider 会话有 provider-source usage
- **THEN** 文本 SHALL 含 input(含 uncached 与 cache read/write)、cache ratio、output、reasoning 与 source

#### Scenario: 不确定值不伪装成 0
- **WHEN** provider 会话 `source = "unavailable"`
- **THEN** 文本 SHALL 显示 `unavailable`,MUST NOT 显示 `Output: 0`

### Requirement: 检查 `$.ui.open()` 的结果并自动降级
交互路径 SHALL 保存 `const opened = await $.ui.open(...)` 的结果并检查。当 `opened` 为对象且 `opened.isPlaced === false` 时,命令 SHALL 关闭 pane(容忍关闭失败),并返回带 `opened.reason` 的文本渲染。当 `$.ui.open()` 抛错时 SHALL 同样降级为文本。当旧 Claude 构建的 `open()` 返回 void 时 SHALL 视为已 placed。

#### Scenario: placement 被拒绝
- **WHEN** `$.ui.open()` 返回 `{ isPlaced: false, reason }`
- **THEN** 命令 SHALL 返回 `renderUsageText` 的文本,并调用 `$.ui.close({ id: 'multi-usage' })`(失败被忽略)

#### Scenario: open 抛错
- **WHEN** `$.ui.open()` 抛出异常
- **THEN** 命令 SHALL 返回文本降级,且 usage 数据不丢失

#### Scenario: 旧构建返回 void
- **WHEN** `$.ui.open()` 返回 `undefined`
- **THEN** 命令 SHALL 按已 placed 处理并继续渲染 Pane

### Requirement: 不以 host 启发式判定焦点失败
系统 MUST NOT 使用定时器、"没有收到按键"或对 Orca 等宿主的猜测来自动判定 focus failure。focus 问题的兜底 SHALL 依赖 engine-native 交互与显式 `--text`。系统 MUST NOT 依据 `TERM_PROGRAM`、Orca IPC 或 xterm 内部实现分支行为。

#### Scenario: 无宿主特化代码
- **WHEN** 审查 Usage UI 代码
- **THEN** 其中 SHALL NOT 出现按终端宿主名称(如 `orca`)分支的逻辑

#### Scenario: 不因超时降级
- **WHEN** Pane 已 placed 但一段时间内无按键
- **THEN** 系统 SHALL NOT 自动切换到文本模式

### Requirement: Interactive UI 是渐进增强
Usage 数据的可访问性 SHALL 不依赖交互 Pane:即使 Pane 渲染成功但焦点未获取,用户 SHALL 仍能通过 `--text` 读取同等 usage 数据;终端宿主的交互失败 MUST NOT 使 usage 数据不可访问。

#### Scenario: 交互失败时文本可用
- **WHEN** 在某宿主 Pane 可见但无法键盘交互
- **THEN** 用户执行 `/multi-usage --text` SHALL 得到完整 usage 文本

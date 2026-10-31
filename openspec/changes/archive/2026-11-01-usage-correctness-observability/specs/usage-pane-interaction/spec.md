## ADDED Requirements

### Requirement: Engine-native 交互所有权
Usage Pane 的核心交互 SHALL 由 Claude Code 的 focus/navigation 系统承担(`ui.focus`、`ui.press`、`ui.scroll`、`ui.close`),而不是由 `Client` 模块通过 `surface.onKey()` 自行解释终端按键。`ui.render`(`component: 'Pane'`,`requestId: 'multi-usage'`)SHALL 直接返回 `Box`/`Text`/`Button` 元素树(通过 `await $.ui.resolve(event)`),不再返回 `Client({ module: './usage-view.ts' })`。

#### Scenario: 直接渲染元素树
- **WHEN** 引擎对 `multi-usage` Pane 触发 `ui.render`
- **THEN** hook SHALL 返回直接的元素树而不是 `Client`

#### Scenario: 核心操作无需 Client 键盘解析
- **WHEN** 用户在一个 `surface.onKey` 不工作的宿主里操作
- **THEN** Provider 切换、滚动、Refresh、Close、Receipts SHALL 仍可通过 Claude Code 的焦点系统完成

### Requirement: Hook 持有的 Pane 状态
Pane 状态 SHALL 迁移到 hook 持有的 `UsagePaneState`(`props`、`selected`(`all` | `receipts` | provider id)、`offset`、`open`、`loading`、`receiptLoaded`),以 `Map<string, UsagePaneState>` 按 session 存放,最多 16 个 session。Client 本地 state MUST NOT 再是 Usage UI 的唯一状态来源。状态变化后 SHALL 调用 `$.ui.invalidate('ui.render')`。

#### Scenario: 状态按 session 隔离
- **WHEN** 两个 session 各自打开 Pane
- **THEN** 各自的 `selected` 与 `offset` SHALL 互不影响

#### Scenario: 容量上限
- **WHEN** 已有 16 个 session 的 Pane 状态时第 17 个 session 打开 Pane
- **THEN** 系统 SHALL 按既有策略清理,状态数量不超过 16

#### Scenario: session 分离清理
- **WHEN** `session.detach` 触发 `forgetUsageSession`
- **THEN** 该 session 的 Pane 状态与 advisory 开关 SHALL 被清除

### Requirement: Provider tab 导航使用 focus ring
Provider tab(All、每个 provider、Receipts)SHALL 是带稳定 `key` 的 `Button`(如 `provider:<id>`、`tab:all`、`tab:receipts`),选中项 SHALL 带 `autoFocus: true`(未选中项 MUST NOT 传 `autoFocus: false`)。hook SHALL 监听 `ui.focus`(`component: 'Pane'`,`requestId: 'multi-usage'`),当焦点落到某 tab 时更新 `selected`、将 `offset` 重置为 0,并调用 `$.ui.invalidate('ui.render')`。

#### Scenario: 焦点切换 provider
- **WHEN** focus ring 落到 `provider:cursor`
- **THEN** `selected` SHALL 变为 `cursor`,`offset` SHALL 为 0,Pane SHALL 重新渲染

#### Scenario: 初始焦点
- **WHEN** Pane 首次渲染
- **THEN** 选中的 tab SHALL 带 `autoFocus: true`

#### Scenario: 忽略外来 pane
- **WHEN** `ui.focus` 事件的 `requestId` 不是 `multi-usage`
- **THEN** hook SHALL 调用 `next(event)` 并不改变任何状态

### Requirement: 有界滚动
hook SHALL 监听 `ui.scroll`(`requestId: 'multi-usage'`),按 `event.by` 更新 `offset`,并限制在 `0 <= offset <= maxOffset`。逐 provider 导航使用 focus ring;若 Pane 无法直接提供逐行键盘滚动,SHALL 提供 Page Up / Page Down / Previous / Next 按钮作为 fallback。

#### Scenario: 滚动下界
- **WHEN** `offset` 为 0 时收到向上滚动
- **THEN** `offset` SHALL 保持 0

#### Scenario: 滚动上界
- **WHEN** `offset` 已达 `maxOffset` 时收到向下滚动
- **THEN** `offset` SHALL 保持 `maxOffset`

### Requirement: 显式 Refresh 与 Close 按钮
Pane SHALL 提供显式 `[Refresh]`(`key: 'action:refresh'`)与 `[Close]`(`key: 'action:close'`)`Button`。Provider 页面的 Refresh SHALL 请求 `/multi/mod/usage?...&refresh=true`,Receipts 页面的 Refresh SHALL 请求 `/multi/mod/receipts`。`r` 快捷键与 `closeOnEscape: true` SHALL 作为增强保留,但 MUST NOT 是核心能力的唯一入口。

#### Scenario: Refresh 按钮刷新
- **WHEN** `ui.press` 命中 `action:refresh`,当前页为 Provider 页
- **THEN** hook SHALL 请求带 `refresh=true` 的 usage 路由并更新 props

#### Scenario: Receipts 页刷新
- **WHEN** `ui.press` 命中 `action:refresh`,当前页为 Receipts
- **THEN** hook SHALL 请求 `/multi/mod/receipts`

#### Scenario: Close 按钮关闭
- **WHEN** `ui.press` 命中 `action:close`
- **THEN** hook SHALL 关闭 `multi-usage` pane

#### Scenario: Esc 不再是唯一出口
- **WHEN** 宿主的 Esc 编码不能送达 Claude Code
- **THEN** 用户 SHALL 仍可通过 `[Close]` 按钮退出 Pane

### Requirement: Receipts 懒加载
仅当 `selected = 'receipts'` 且 `receiptLoaded = false` 时才请求 `/multi/mod/receipts`,避免焦点环反复经过时重复请求。显式 Refresh SHALL 才会重新请求。

#### Scenario: 首次进入 Receipts
- **WHEN** 焦点首次落到 `tab:receipts`
- **THEN** hook SHALL 请求一次 `/multi/mod/receipts` 并置 `receiptLoaded = true`

#### Scenario: 再次经过不重复请求
- **WHEN** 焦点离开后再次落到 `tab:receipts`
- **THEN** hook SHALL NOT 再次请求

### Requirement: Quota advice 行为保持
`Quota-aware model selection` 按钮(`key: 'action:quota-advice'`)SHALL 继续切换当前 session 的 advisory 开关,行为按 session 隔离;`classic.PreToolUse` 上的 `attributeToolCall()`、`quotaAdvice(snapshot)`、`advisorySessions` 与 Agent/Task 边界 SHALL 保持不变。

#### Scenario: 开关按 session 隔离
- **WHEN** session A 开启 advice
- **THEN** session B 的 advice 状态 SHALL 不变

#### Scenario: 非 Agent 工具不触发
- **WHEN** 普通工具调用触发 `classic.PreToolUse`
- **THEN** 不得注入 quota advice 上下文

### Requirement: 外来 pane 与消息不被处理
hook SHALL 只处理 `requestId = 'multi-usage'` 的 Pane 事件与消息;其它 requestId 的 `ui.render`、`ui.focus`、`ui.scroll`、`ui.press`、`ui.message` SHALL 直接 `next(event)`。对未知 action 的消息 SHALL 直接 `next(event)`。

#### Scenario: 外来 render
- **WHEN** `ui.render` 的 `requestId` 不是 `multi-usage` 或 `surface` 不是 `terminal`
- **THEN** hook SHALL `next(event)`

#### Scenario: 未知 action
- **WHEN** `ui.message` 携带未知 action
- **THEN** hook SHALL `next(event)`

### Requirement: 迁移与遗留淘汰
迁移 SHALL 分两阶段:阶段 A 保留 `usage-view.ts` Client UI 并先落地 accounting、`--text` 与 placement fallback;阶段 B 迁移到 engine-native Pane,新增 `usage-pane.ts` 承载 pane 状态 helper、直接 renderer、selection 与 scrolling。迁移完成且测试通过后,`usage-view.ts` SHALL 不再被 `ui.render` 引用,先保留一个版本作为 easy revert 来源,再以独立 commit 删除。`usage.ts` SHALL 只做小规模 extraction(`usage-format.ts`、`usage-pane.ts`),不创建复杂 framework。

#### Scenario: 阶段 A 不破坏现有 UI
- **WHEN** 只落地阶段 A
- **THEN** 现有 Client Pane SHALL 仍可用,且 `--text` 与 placement fallback 可用

#### Scenario: 阶段 B 后无引用
- **WHEN** 阶段 B 完成
- **THEN** 代码中 `ui.render` SHALL NOT 再引用 `./usage-view.ts`

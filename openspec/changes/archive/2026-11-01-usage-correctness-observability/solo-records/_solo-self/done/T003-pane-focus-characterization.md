# T003：Pane 焦点表征

- openspec：usage-correctness-observability / 任务 2.5、2.6（阶段门禁）
- 类型：表征
- 被谁阻塞：T002

## 目标
用一个 hook 层测试 fixture 把 `/multi-usage` Pane 的四个层次（render / placement / focus / key delivery）分别观测出来，并能判定「哪一层失败」；同时锁定现状：`$.ui.open()` 返回 `isPlaced:false` 时命令目前不降级（T010 会翻转这一条）。

## 动手前先读
- specs/usage-verification「Pane 状态可区分」；PRD MP-0060
- plugins/multi-core/hooks/usage.ts、usage-view.ts（现为 Client + surface.onKey）
- plugins/multi-core/hooks/tests/usage.test.ts（mount/press/key 用法）

## 边界
- 只动：plugins/multi-core/hooks/tests/usage-pane-layers.test.ts（新）
- 适用通用规则：测试
- 必须保持：
  - 只加测试，不改产品代码（Stage 0）
  - 不写宿主特化分支、不用超时/无按键判定（usage-text-fallback）
  - 测试只用 `claude-code/testing` 的公开工具（mount、press、key、`$.ui.focus`）

## 验收
1. `claude plugin test plugins/multi-core`（`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 全部通过，数量比基线 75 多
2. `npx biome check --error-on-warnings plugins/multi-core/hooks/tests/usage-pane-layers.test.ts` → 无报错
3. `npm run typecheck:mod` → 无新增错误（基线 8 个错误全在 hooks/workers.ts）
4. 阶段门禁：`npm run banner:check`、`npx biome check --error-on-warnings plugins test scripts docs`、`npx knip`、`npm test`
5. 变异验证：临时让 `usage-view.ts` 的 `surface.onKey` 不再注册（或把 `autoFocus` 去掉），预期 key / focus 层测试变红；用编辑工具恢复。

## 为什么这样验收
这个 fixture 是 Stage 4 迁移前后的对照：同一份四层观测，在迁到 engine-native Pane 后仍能表达 render/placement/focus/key 的各自状态。变异验证确认 key 层与 focus 层的断言不是空断言。

## 记录
- 提交：12395e8
- 验收：通过（重跑 6 条命令）
- 修正：无
- 存疑：placement 失败现状静默，T010 翻转

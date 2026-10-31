# T015：MULTI_UI_TRACE 与 trace 安全测试（任务 7.2、7.3）

> 补写说明（2026-10-01）：原工单被缩水成一行「done 1516abd」。本文按 PLAN.md、tasks.md 7.2、7.3、回执和提交 1516abd 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 7.2、7.3
- 类型：代码
- 被谁阻塞：T014

## 目标
设置 `MULTI_UI_TRACE=1` 后，Usage pane 在 debug 日志里留下元数据行（surface、placement 的 requested、placed、reason，以及 `ui.focus`、`ui.press`、`ui.scroll`、`ui.close`），用来区分「没放下」「没焦点」「按键没到」；同时用安全测试证明两类 trace 开启后都不泄漏内容。

## 动手前先读
- specs/usage-diagnostics（UI trace 字段与安全约束）、specs/usage-verification
- design.md D10；tasks.md 7.2、7.3
- docs/claude-mods.md 中「`$` 只能传入同文件函数」的限制（决定 trace 函数的放置位置）
- T014 的 `usageTrace`；T010 的 `openPane`；T012 的各事件处理
- AGENTS.md 中密钥与日志的规矩

## 边界
- 只动：plugins/multi-core/hooks/usage.ts、plugins/multi-core/hooks/tests/ui-trace.test.ts（新）、test/unit/native-usage-menu.test.ts、test/unit/native-usage-trace.test.ts
- 适用通用规则：密钥与敏感数据不进日志；Claude Mods 函数 hook 规则
- 必须保持：
  - 默认关闭，只有 `MULTI_UI_TRACE` 为 `1` 才输出（tasks 7.2）
  - 字段是封闭集合：event、surface、requestId、element、requested、placed、reason、by、columns；不含真实 session id、token、面板文本（tasks 7.2）
  - `reason` 长度有上限
  - 开启两类 trace 后，输出不含 prompt、assistant 文本、推理密文、工具输入输出、API key、Authorization、gateway token、Codex auth、transcript（tasks 7.3）
  - trace 函数留在 usage.ts 内：hook 编译器只允许 `$` 传入同文件函数，不能拆成独立文件

## 验收
1. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过，含 ui-trace 的 3 个用例
2. `node --test --test-timeout=120000 test/unit/native-usage-menu.test.ts test/unit/native-usage-trace.test.ts` → 通过（含 focus、scroll、close 的 trace 用例与内容安全用例）
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过

## 为什么这样验收
诊断开关最大的风险是泄漏。字段闭集靠类型保证，再用「带 prompt、推理密文、工具参数、凭据的会话」做黑盒用例，开启两类 trace 后逐一断言这些串不出现。

## 记录
- 提交：1516abd
- 验收：通过（原记录：gate 全绿）
- 修正：无
- 存疑：无

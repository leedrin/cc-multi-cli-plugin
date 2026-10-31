# T017：E2E 回归与终端宿主矩阵 fixture（任务 7.5、7.6）

> 补写说明（2026-10-01）：原工单被缩水成一行「done e5d3b93」。本文按 PLAN.md、tasks.md 7.5、7.6、回执和提交 e5d3b93 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 7.5、7.6
- 类型：代码
- 被谁阻塞：T016

## 目标
用真实 Claude Code 加假 OpenAI 流式响应验证用户能看到的结果：最终 `output_tokens > 0`、cache read 可见、cache ratio 经 `/multi-usage` 可读；`--text` 在 headless 宿主下输出五个 provider；再建一张终端宿主回归矩阵 fixture，证明无论宿主怎样放置或拒绝 pane，用量数据都能读到。

## 动手前先读
- specs/usage-verification（E2E 与宿主矩阵场景）、specs/usage-text-fallback
- design.md D11、D12；tasks.md 7.5、7.6
- test/e2e 里现有 usage-receipts、native 用例的夹具与 `MULTI_E2E_CLAUDE` 约定
- plugins/multi-core/hooks/tests/usage-pane-layers.test.ts 的 kit 用法
- T010 的降级行为、T016 的更正（本机其实有 claude.exe，需要 `MULTI_E2E_CLAUDE` 指向它）

## 边界
- 只动：test/e2e/openai-usage-visible.test.ts（新）、test/e2e/usage-text-headless.test.ts（新）、plugins/multi-core/hooks/tests/usage-host-matrix.test.ts（新）
- 适用通用规则：密钥与敏感数据不进日志；子进程清理
- 必须保持：
  - 不发起真实模型请求，e2e 用假上游；headless 的 `--text` 用例不应有模型请求或原生 CLI 推理（tasks 7.5）
  - 若原生 usage UI 没有 ratio 位，只记录 native UI limitation，不为此造替代渲染器（tasks 7.5）
  - 宿主矩阵覆盖 Windows ConPTY、WSL、SSH、tmux、xterm、kitty、标准 ANSI 与窄终端、headless；断言「交互失败不使 usage 不可访问」（tasks 7.6）
  - fixture 只验证事件与放置结果；字节层（真实终端渲染）由手工清单覆盖，不假装测过

## 验收
1. 先把环境变量 `MULTI_E2E_CLAUDE` 设为本机 claude.exe 的完整路径，再运行 `node --test --test-timeout=120000 test/e2e/openai-usage-visible.test.ts test/e2e/usage-text-headless.test.ts` → 通过
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过，含 usage-host-matrix
3. `npx biome check --error-on-warnings plugins test scripts docs *.md *.json`、`npm run typecheck`、`npx knip` → 无报错
4. 全仓门禁（命令表）→ 通过

## 为什么这样验收
单元测试证明数据对，e2e 证明用户真的能在 Claude Code 里读到；宿主矩阵证明 pane 放不下或被拒时仍有同样的数据可读。真机的终端字节层无法在无人值守下验证，由 T018 的手工清单承担，并在记录里明确写出。

## 记录
- 提交：e5d3b93
- 验收：通过（原记录：gate 全绿）
- 修正：无
- 存疑：首版 headless 用例因 codex 假进程清理时 EBUSY，改用 grok（无子进程）（原回执）；真机宿主层未验证；补写时发现一处注释偏差，见回执「审查」

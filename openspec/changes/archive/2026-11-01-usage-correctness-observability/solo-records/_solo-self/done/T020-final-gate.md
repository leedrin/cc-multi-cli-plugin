# T020：最终门禁与对账（任务 8.4、8.5、8.6）

> 补写说明（2026-10-01）：原工单只剩标题、任务号和「记录」块。本文按 PLAN.md、tasks.md 8.4–8.6、回执和提交 c5e3764 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 8.4、8.5、8.6
- 类型：门禁
- 被谁阻塞：T019

## 目标
证明整个补丁整体可交付：全量检查通过且无 `DEP0190` 警告；PRD 第 42 节 Patchset Definition of Done 与 detailed-design 第 80–83 节验收清单逐条对账；分支可以从最新 `upstream/main` 重放。

## 动手前先读
- tasks.md 8.4–8.6；PRD 第 42 节；detailed-design 第 80–83 节
- PLAN.md 的命令表（全仓门禁的实际写法和外部阻塞说明）
- 全部 T001 到 T019 回执的「验收」与存疑
- AGENTS.md 的完成定义与 live 测试规矩

## 边界
- 只动：无（只核对；发现问题则新建修复单，不改已提交单的记录）
- 适用通用规则：无
- 必须保持：
  - 外部阻塞要如实写出：`npm run check` 的 lint 步骤因被 gitignore 的 `.claude/settings.local.json` 失败、`typecheck:mod` 有 hooks/workers.ts 的 8 个生成类型错误，二者在改动前就存在
  - 未真机验证的宿主（Orca、Windows Terminal、WSL、tmux、SSH）不得写成已验证
  - 任务 7.8 仍阻塞，不勾选
  - rebase 演练只用临时 worktree 与临时分支，不动当前分支，结束后清理

## 验收
1. `npm test` → 通过（原记录：632 个测试，620 通过，0 失败，12 跳过），无 `DEP0190`
2. `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`）→ 通过（原记录 105 通过）
3. 全量 `npm run test:e2e` → 通过（原记录 101 通过 0 失败）；live 四层 OpenAI 用量探针 → 通过（4 次请求）
4. 在临时 worktree 里 `git rebase --onto upstream/main 350a291` → 无冲突重放（原记录 18 个提交），随后清理 worktree 与分支

## 为什么这样验收
这是收口单，验收即对账：把分散在各单里的结果再独立跑一遍，并逐条对照 PRD 的完成定义，保证没有哪一条只靠某张单的自述。

## 记录
- 提交：c5e3764
- 验收：通过（原记录：重跑 4 条命令）
- 修正：无
- 存疑：7.8 阻塞；真实宿主未验证

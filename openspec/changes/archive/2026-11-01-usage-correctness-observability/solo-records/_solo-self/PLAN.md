# 工单图：usage-correctness-observability

来源：openspec/changes/usage-correctness-observability/{proposal,design,tasks}.md、specs/
分支：Usage-Correctness（当前分支，非主干；设计基线 b1fa3b53，起始 HEAD 350a291）

## 命令表
| 用途 | 命令 | 备注 |
| --- | --- | --- |
| 单文件测试 | `node --test --test-timeout=120000 <文件>` | Node 24.15 |
| 按文件 lint | `npx biome check --error-on-warnings <文件...>` | |
| 类型检查 | `npm run typecheck` | `tsc --noEmit` |
| 死代码 | `npx knip` | hooks/** 被 knip.json 忽略 |
| 全仓门禁 | `npm run banner:check; npx biome check --error-on-warnings plugins test scripts docs *.md *.json; npx knip; npm test` | 原 `npm run check` 的 lint 步骤在基线上因被 gitignore 的 `.claude/settings.local.json`（CRLF，Biome 不读全局 ignore）失败，属外部阻塞；改为对仓库内容目录跑 lint，其余步骤等价 |
| hook 层测试 | `claude plugin test plugins/multi-core`（env `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`） | 基线 75 pass；已用 `claude -p "/plugin-types"` 生成 `.claude/types` |
| hook 类型检查 | `npm run typecheck:mod` | 基线已有 8 个错误，全在 `hooks/workers.ts`（生成的 Agent 工具类型缺失），属外部阻塞；验收只要求「无新增的、落在 workers.ts 以外的错误」 |
| e2e | `npm run test:e2e` | |

## 拆解假设
- 任务 1.1/1.2/1.3 属约定类，随 T001 勾选；基线结果：`npm run check` 仅 lint 因本机 settings.local.json 失败，knip/test 全过（567 tests，555 pass，12 skip）；`test:mod` 的 typecheck 有 workers.ts 既有错误，`claude plugin test` 75 pass。
- 任务 1.3 的小提交序列照 design D11，但每张单一个提交，提交信息取 D11 的措辞（小写前缀风格）。
- 门禁类任务（2.6、3.11、4.13、5.7、6.9 后半、8.4）并入各阶段最后一张单。
- 任务 7.4（付费 live 探测）先写可离线完成的部分（脚本与断言），实际运行只尝试一次；无 Codex 登录则 ⏸ 待外部条件。
- 任务 7.8（三个 Claude Code 版本上记录 Usage UI 结果）与 7.7 的实际手工执行需要真实终端/多版本，无法无人值守完成：7.7 只交付清单与记录模板（勾选），7.8 挪 blocked 不勾选。
- 任务 8.6 的 rebase 演练用临时 worktree/临时分支，不动当前分支；`git fetch upstream` 需要联网，只试一次。
- `toProtocolUsage()` 放在 messages.ts（任务 3.6 原文），类型 `CanonicalTokenUsage` 在 usage-accounting.ts。
- `usage-view.ts` 保留（任务 6.7 原文：保留一版，单独 commit 删除），knip 忽略 hooks，故不会因此报错。本次不做删除提交。

## 工单
| 编号 | 标题 | 类型 | openspec 任务 | 被谁阻塞 | 只动 | 关键验收 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T001 | OpenAI terminal usage 变体表征 | 表征 | 1.1 1.2 1.3 2.4 | 无 | test/unit/native-openai-stream.test.ts | 单文件测试 + 变异验证 | 完成 |
| T002 | provider matrix / routing / 公共行为表征 | 表征 | 2.1 2.2 2.3 | T001 | test/unit/native-usage-characterization.test.ts（新） | 单文件测试 + 变异验证 | 完成 |
| T003 | Pane 焦点表征 | 表征 | 2.5 2.6 | T002 | plugins/multi-core/hooks/tests/usage.test.ts 或新 hook 测试 | claude plugin test + 全仓门禁 | 完成 |
| T004 | usage-accounting 共享模块 | 代码 | 3.1 3.2 | T003 | gateway/usage-accounting.ts、test/unit/native-usage-accounting.test.ts | 单文件测试 | 完成 |
| T005 | OpenAI response-usage 解析 + 协议适配 | 代码 | 3.3 3.4 3.5 3.6 | T004 | multi-openai/src/response-usage.ts、gateway/messages.ts、test/unit/native-openai-response-usage.test.ts | 单文件测试 | 完成 |
| T006 | responses.ts 保留完整 usage | 代码 | 3.7 3.8 3.9 3.10 3.11 | T005 | multi-openai/src/responses.ts、相关测试 | stream/zen 测试 + 全仓门禁 | 完成 |
| T007 | Receipt schema v2 | 代码 | 4.1 4.2 4.3 4.4 4.5 4.6 4.7 | T006 | gateway/receipts.ts、native-receipts 等测试 | receipts/harness/e2e 测试 | 完成 |
| T008 | Dashboard session usage | 代码 | 4.8 4.9 4.10 4.11 4.12 4.13 | T007 | gateway/provider-usage.ts、native-provider-usage.test.ts | 测试 + 全仓门禁 | 完成 |
| T009 | usage-format 抽取 + --text | 代码 | 5.1 5.2 | T008 | hooks/usage-format.ts、hooks/usage.ts、测试 | hook 测试 | 完成 |
| T010 | placement 降级 | 代码 | 5.3 5.4 5.5 | T009 | hooks/usage.ts、测试 | hook 测试 | 完成 |
| T011 | Client UI 显式 Refresh / Close | 代码 | 5.6 5.7 | T010 | hooks/usage-view.ts、测试 | 测试 + test:mod + 全仓门禁 | 完成 |
| T012 | usage-pane 状态与渲染 + Pane 迁移（T013 并入） | 代码 | 6.1–6.9 | T011 | hooks/usage-pane.ts、usage.ts、测试 | hook 测试 + 全仓门禁 | 完成 |
| T013 | （并入 T012，见 dropped/T013-merged-into-T012.md） | 代码 | - | T012 | - | - | 放弃 |
| T014 | MULTI_USAGE_TRACE | 代码 | 7.1 | T013 | gateway 新 helper、responses/server wiring | 测试 | 完成 |
| T015 | MULTI_UI_TRACE + trace 安全测试 | 代码 | 7.2 7.3 | T014 | hooks、测试 | 测试 | 完成 |
| T016 | live 四层对账探测 | 外部 | 7.4 | T015 | test/live/native-openai-cache.ts | 类型检查 + 试跑一次 | 完成 |
| T017 | E2E 回归与终端宿主矩阵 fixture | 代码 | 7.5 7.6 | T016 | test/e2e、hooks 测试 | e2e/测试 | 完成 |
| T018 | Orca 手工 E2E 清单与版本矩阵模板 | 文档 | 7.7 (7.8 见下) | T017 | docs/ | 文档检查 | 完成 |
| T019 | 文档与 CHANGELOG | 文档 | 8.1 8.2 8.3 | T018 | docs/usage.md、docs/claude-mods.md、CHANGELOG.md | lint | 完成 |
| T020 | 最终门禁与对照清单 | 门禁 | 8.4 8.5 8.6 | T019 | 无（只核对；必要时修复单） | 全仓门禁 + test:mod | 完成 |
| T018b | 三个 Claude Code 版本上记录 Usage UI（7.8） | 外部 | 7.8 | T018 | docs/usage-host-checklist.md 的宿主矩阵表 | 真机运行 Test A/B/C | 阻塞 |

7.8（三个版本上记录 Usage UI）无外部环境，按「外部条件」处理：结束时挪 `blocked/` 不勾选。

## 实施期假设补充
- ratio：要求 inputTokens 与 cacheReadTokens 已知；cacheWriteTokens 未知时分母只含已知项（T004）。OpenAI 不上报 cache_write_tokens 时 cacheWriteTokens 保持未知，协议 usage 不再输出 cache_creation_input_tokens（T006 需更新依赖 0 的既有断言）。

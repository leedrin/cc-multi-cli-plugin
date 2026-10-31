# T016：live 四层对账探测（任务 7.4）

> 补写说明（2026-10-01）：原工单被缩水成一行「done e356d10」。本文按 PLAN.md、tasks.md 7.4、回执和提交 e356d10 还原；当时的原文未保留，还原不了的标「当时未记录」。

- openspec：usage-correctness-observability / 任务 7.4
- 类型：外部（付费 live 探测，需要 Codex 登录）
- 被谁阻塞：T015

## 目标
扩展 OpenAI 缓存 live 探针，让一次真实运行同时校验四层数字一致：provider 原始 usage → 网关最终事件 → 收据账本 → 经认证的 `/multi/mod/usage?view=providers` dashboard，其中包括 cache write、reasoning、total 与 cache read ratio。

## 动手前先读
- specs/usage-verification（四层对账场景）、specs/provider-usage-dashboard
- design.md D11；tasks.md 7.4
- test/live/native-openai-cache.ts 全文（现有 Sample、轮次循环、认证与端口处理）
- AGENTS.md 中 live 测试规矩：付费探测要有界；不使用 Cursor Fast；复用已有用量记录
- T008 的 `ProviderUsageDashboard` 注入方式、T007 的 `ReceiptLedger`

## 边界
- 只动：test/live/native-openai-cache.ts
- 适用通用规则：密钥与敏感数据不进日志；付费探测有界
- 必须保持：
  - Sample 的新字段（cacheWrite、reasoning、total）未上报时为 undefined，不写成 0（specs/usage-verification）
  - 显式注入 `new ReceiptLedger()` 与确定性的 openai reader，不依赖真实账户配额接口
  - 经认证的 `/multi/mod/usage?view=providers&refresh=true` 读取，不绕过 token 认证
  - 请求预算有界（原回执：4 个上游请求），不使用 Cursor Fast
  - 缺少登录等外部条件时只试一次，记外部阻塞，不重试

## 验收
1. `npm run typecheck`、`npx biome check --error-on-warnings test` → 无报错
2. 实跑一次 `node test/live/native-openai-cache.ts`（需 Codex 登录；`claude.exe` 所在目录要在 PATH，因为 `spawn('claude')` 不走 .ps1 垫片）→ PASS
3. 结果记录：真实终端事件里 cache_write_tokens 与 reasoning_tokens 是否显式上报（原回执：均为 0 且显式上报）

## 为什么这样验收
用量显示的错误可能出在任何一层，只有真实上游加四层同时对账才能证明没有哪层把未知变成 0。探针是付费且依赖登录的，所以限定一次、预算有界。

## 记录
- 提交：e356d10
- 验收：通过（原记录：本机有 Codex 登录，实跑一次 4 个上游请求 PASS）
- 修正：无
- 存疑：无；原回执更正了先前「本机没有原生 claude.exe」的误判，exe 在 npm 全局目录，T017 重试了 e2e

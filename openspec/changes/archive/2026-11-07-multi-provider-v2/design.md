# Design

完整的技术设计、代码行号证据和测试矩阵见已批准的详细设计 `docs/cc-multi-cli-plugin_multi-provider-v2_detailed-design.md`（下称 DD，v1.1）。本文件只列结构、关键决定和风险，细节以 DD 的对应章节为准。行为要求见 `specs/`。

## Context

动机见 proposal.md。约束：

- 基线为 `c2f15e3`，父提交是 `Usage-Correctness` 的尖端；`upstream/main` = `v0.4.0`。冲突面最大的是 `gw/server.ts`、`core/launcher.ts`、`gw/worker-catalog.ts`、`core/install/plugins.ts`（DD §21）。
- AGENTS.md：`server.ts` 独自负责收尾；hooks 改动只用 Claude Mods function hooks；Biome 认知复杂度 ≤15，不加抑制；平台相关代码接受显式 `platform`。
- 写死 provider 的位置远多于 PRD §3 列出的 4 处，完整清单见 DD §4，必须全部收口。
- Pi 行为来自 `@earendil-works/pi-ai@1.4.0` 的 `dist/` 源码核对（DD §12），其中关键几点：块生命周期、`argumentsError`、`process.env` 回退、usage 把缺失写成 0。

路径缩写：`gw/` = `plugins/multi-core/src/gateway/`，`core/` = `plugins/multi-core/src/`，`hooks/` = `plugins/multi-core/hooks/`。

## Goals / Non-Goals

**Goals:**

- 三层结构：host-free 事实表 `gw/provider-facts.ts`（hooks 可用）→ 描述符（各插件 `src/provider.ts`，不 import 重依赖）→ `gw/provider-registry.ts` 与 `ProviderRuntime`（DD §7）。
- `gw/model-identity.ts` 作为唯一的路由编解码（DD §6）。
- Direct 契约：`prepare` → `PreparedRequest.open(signal, fetch)` → `UpstreamOpen`；HTTP 后端由 `httpUpstream` 包装（DD §8）。
- `plugins/multi-pi/` 适配器：`provider.ts`、`catalog.ts`、`signature.ts`、`backend.ts`（懒加载）、`messages.ts`、`stream.ts`、`usage.ts`、`gateway-request.ts`（DD §12.1）。

**Non-Goals:**

- Pi NativeHarness、Generic OpenAI-compatible provider、外部插件 API 和动态加载、更多 Pi provider、共享 Pi 登录状态。重启条件见 DD §24。
- 不新建 PRD §42 的 `providers/` 目录，新模块留在 `gw/`。
- 不新增 `/multi/mod/*` 路由。

## Decisions

以下是 DD §3 的决定，用户未逐条参与，均为设计方的选择，已随设计一并批准。

| # | 决定 | 备选与取舍 |
| --- | --- | --- |
| D-A | Pi 先走 Direct（Pi AI），Claude 保留 tool loop | Harness 需要先解决无沙箱、无审批、无 plan 的问题 |
| D-B | 顺序：基线 → Identity → Registry → Direct 契约 → launcher/worker → Pi | 先接 Pi 会分不清是 Pi 的 bug 还是重构的 bug；Generic 不再是前置 |
| D-C | 不暴露 Pi 的 `openai`、`opencode`、`xai` | 与 Multi 的 `openai`、`zen`、`grok` 冲突 |
| D-D | 独立 `multi-pi` 插件作开关，依赖精确 pin 在根 `package.json` | 仓库没有 per-plugin `package.json`；代价是所有用户的磁盘占用都会增加 |
| D-E | 凭据只读环境变量 | `auth.json` 的 `!command` 在解析时执行，且需要 23.4 MB 的 `pi-coding-agent` |
| D-F | 每个 route provider 一个 worker | 由 `--agents` 预算测试把关 |
| D-H | 从现有 `PreparedRequest` 演进出 `open`，不另造 `prepare + execute` | 现有边界已把 keepalive、事件、失败映射留在 gateway |
| D-I | usage 用 `onProviderStreamEvent` 观察原始 chunk | Pi 的 `Usage` 把缺失写成 0，违反 usage-accounting |
| D-J | 先 DeepSeek，再 GLM，再 Strata | DeepSeek 只有一个端点 |
| D-K | 只放行 `openai-completions` API | 把核对范围收窄到一个 Pi 适配器 |
| D-L | Strata 用 `createProvider`，连接信息由 Multi 的环境变量提供 | 不需要等 Generic API；不读 `models.json` |

设计审查后的修订（DD R31），对应 spec 中的行为：

- **只由 server 收尾**：`translate` 在 Pi `done` 时只关闭内容块并返回 `MessagesResponse`，`emitTerminal` 发终止事件（DD §12.6）。
- **按 delta 生成块**：Pi 的 `*_start` 在块创建时立即发出，所有 `*_end` 都在流末尾才发出，所以不能按 start/end 一一映射。按 delta 类型切块，thinking 签名在关闭时发出；`thinking_end` 改写签名时显式失败；回放时合并同模型的相邻 thinking 块（DD §12.6）。
- **`argumentsError`**：在发出 tool_use 前检查，只记类别（DD §12.6）。
- **工具名别名**：复用 `gw/tools.ts` 的 `toolName`、`callId`、`originalToolNames`，与 Zen 的用法一致（DD §12.3.1）。
- **环境回退**：`env: {}` 不构成隔离，显式传 `cacheRetention: 'short'`；升级 Pi 时重新 grep `getProviderEnvValue`（DD §10 规则 3）。
- **严格白名单**与**按上游调用计数的 live 预算**（DD §11、§17）。

其他实现要点：

- 懒加载：`provider.ts` 不 import `pi-ai`；只有插件已启用且有密钥时，`discoverModels` 才 `await import('./backend.ts')`。这是 AGENTS.md “Prefer direct module imports” 的窄例外，在代码旁注明理由（DD §9）。
- 只 import 单个 provider 工厂（`providers/deepseek` 等），不 import `providers/all`。
- `open` 等待 Pi 的第一个事件：`start` 表示成功；`error` 且 `observedFetch` 记录到非 2xx 状态时返回 `{ok:false}`；没有状态时报网络错误。`maxRetries: 0`，`redirect: 'error'`（DD §12.7）。
- `takeProviderCredentials(env, descriptors)` 在创建任何子进程之前调用，删除 `process.env` 上的条目（DD §10）。

## Risks / Trade-offs

- [S1 失败：真实 Pi 路径无法离线跑通，或 `onProviderStreamEvent` 看不到 usage] → P0 先做 S1，失败就停下，重新评估改走 Zen 式的自写转换。
- [Claude Code 默认发送的 effort 是 `medium`，首批模型都不支持] → S4 先确认；如果是，就调整 DD §12.4 的映射，之后才实现 P5。
- [Pi 升级改变事件顺序、usage 字段或环境读取] → 精确 pin；升级必须重跑特征 fixture，并重新 grep `getProviderEnvValue`。
- [`thinking_end` 走 reasoning_details 路径] → 显式失败，不静默丢弃；出现时先补上支持。
- [依赖使所有用户的磁盘占用增加] → S3 实测，写入 `docs/pi.md`；无密钥时不加载。
- [`glm-5.3` 关闭 thinking 时上游可能拒绝] → 按普通上游错误显式失败，P6 用一次请求验证。
- [Strata 本地服务实际返回 reasoning 字段] → 按普通 thinking 块处理，签名往返照常。
- [启用后，会话内的 Bash 拿不到 Pi 密钥] → 与 Zen 删除 `OPENCODE_API_KEY` 相同，写入 `docs/pi.md`。
- [与 upstream 冲突] → P1–P4 每阶段单独提交并保持可运行，新逻辑尽量放新文件，上游更新先进 `Usage-Correctness`（DD §21）。

## Migration Plan

- 阶段 P0–P6 见 tasks.md（与 DD §17 一一对应），每阶段单独提交、可运行、通过 `npm run check`。
- 破坏性改动只有两处：未知 provider 改为 BadRequest（`test/unit/gateway-provider-bounded.test.ts:11` 是唯一允许修改的既有断言），以及 `route` 类型放宽。写进 CHANGELOG 的 `## Unreleased`。
- 回滚：`multi-pi` 是独立插件，停用后不加载 Pi、不动环境变量，picker 和 worker 与 v2 之前一致。P1–P4 的重构可以按提交回退。
- 版本只通过 `npm run release` 修改。

## Open Questions

- P6 的付费 live 验收：默认不跑，开始前需要用户批准（DD §25 第 3 项）。
- `Usage-Correctness` 和 v2 是否向上游提交：默认不推送、不开 PR（DD §25 第 4 项）。

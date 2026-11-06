# cc-multi-cli-plugin Multi-Provider v2 详细功能设计方案

> 对应 PRD：`docs/cc-multi-cli-plugin_multi-provider-v2_PRD.md`（Draft v1.0）  
> 分支：`feature/multi-provider-v2`  
> 文档类型：Detailed Functional Design / Technical Design  
> 状态：v1.1，维护者已批准（2026-11-03），含设计审查修订 R31
> 设计基线：`c2f15e3`（父提交 `6fcfead` 是 `Usage-Correctness` 尖端；`upstream/main` = `e959b96` = `v0.4.0`）  
> 基线日期：2026-11-01  
> Pi 版本基线：`@earendil-works/pi-ai@1.4.0`  
> 目标读者：实现者（人或 Agent）、项目维护者、Reviewer

路径缩写：`gw/` = `plugins/multi-core/src/gateway/`，`core/` = `plugins/multi-core/src/`，`hooks/` = `plugins/multi-core/hooks/`。  
Pi 行号来自 npm 包的 `dist/`，只读核对，**未运行**。标“未验证”的内容由 §18 的先行验证解决。

---

# 1. 意图与成功标准

维护者的目标（原话）：**“v2 落地后，最想新接入 pi，再通过 pi 接入 glm 或 deepseek 模型。”**

所以 v2 不是一次为重构而重构的架构升级。它要做到两件事：

1. 把写死在十几个文件里的 provider 名单收成一处，让新 provider 不必改 gateway 核心。
2. 用这个结果经 Pi AI 接入 DeepSeek 和 GLM。

**成功的样子：**

```text
export DEEPSEEK_API_KEY=...       # 或 ZAI_API_KEY / ZAI_CODING_CN_API_KEY
启用 multi-pi 插件，启动 Multi
/model 里出现 DeepSeek 和 GLM 模型，也能用 multi-deepseek、multi-zai worker
选中后，Claude Code 的工具循环、权限提示和子代理照常工作
/multi-usage 如实显示用量，缺失的数据显示 unavailable，不显示 0
现有 OpenAI、Zen、Cursor、Antigravity、Grok 的行为不变
```

---

# 2. 目标、非目标、反目标

**目标**

- 单一的 provider 事实来源：`ModelIdentity`、`ProviderRegistry`、表驱动的 launcher、worker、usage、review。
- `server.ts` 不再 import 任何 provider 模块。
- Pi AI 作为 Direct 后端（PRD §23 Mode A，Claude 保留 tool loop），首批接 `deepseek`、`zai`、`zai-coding-cn`，然后接维护者本地 Pi 配置中的自定义 provider Strata（§16.1）。

**非目标（本设计范围内不做，§24 写明重启条件）**

- Pi NativeHarness（MP-07xx）。
- Generic OpenAI-compatible provider（MP-05xx）。
- 外部 provider 插件 API、动态插件加载（MP-08xx）。
- OpenRouter、Google、Kimi、Groq 等更多 Pi provider。它们只需加一行白名单和一次验证，但不在首批。
- 共享 Pi 的登录状态（`~/.pi/agent/auth.json`）。

**反目标（即使功能跑通，出现这些也算失败）**

- 把 Multi 迁移到 Pi 宿主，或让 Pi 接管工具循环。
- 为了接 Pi，改动现有 provider 的用户可见行为（§20 列出的破坏性改动除外）。
- 把缺失的 usage 显示成 0，或把 Pi 目录价当账单。
- Multi 在运行时读取或执行 Pi 的 `auth.json`、`models.json`；provider 密钥进入 Claude child、Bash、其他 harness 子进程、receipt 或 trace。
- 启动时读取项目目录中的可执行内容（违反 `core/install/plugins.ts:80-81` 的信任规则）。

---

# 3. 决定一览

用户未参与这些选择，全部是我的决定，可以否决。

| # | 决定 | 理由 |
| --- | --- | --- |
| D-A | Pi 先走 Direct（Pi AI），Harness 后置 | 用户要的是 GLM/DeepSeek 模型，不是 Pi 的 agent。Harness 需要先解决无沙箱、无审批、无 plan（§24） |
| D-B | 顺序：基线 → Identity → Registry → Direct 契约 → launcher/worker → Pi AI。Generic 不再是 Pi 的前置 | Pi 是唯一被点名的目标。保留 PRD“Registry 稳定前不接 Pi”的纪律（§70/§80：否则分不清 Pi 的 bug 和重构的 bug） |
| D-C | `openai`、`opencode`、`xai` 不暴露 | 与 Multi 的 `openai`（Codex 登录）、`zen`（同一服务）、`grok`（语义不同）冲突 |
| D-D | 独立 `multi-pi` 插件，依赖精确 pin 在根 `package.json` | 仓库没有 per-plugin `package.json`；插件清单只是开关，代码随 core 一起发布（§9） |
| D-E | 凭据只读环境变量，不读 Pi 文件 | `auth.json` 的 key 可以是解析时会执行的 `!command`；解析它还要依赖 23.4 MB 的 `pi-coding-agent` |
| D-F | 每个 route provider 一个 worker | 与 PRD §38 一致；新增 4 个（含 Strata），由 §11 的 `--agents` 预算测试把关 |
| D-G | 新模块留在 `gw/`，不建 PRD §42 的 `providers/` 目录 | 遵守 AGENTS.md 的现有约定，减少 upstream 冲突面 |
| D-H | Direct 契约从现有 `PreparedRequest` 演进，不另造 `prepare + execute` | 现有边界已把 keepalive、事件、失败映射留在 gateway，只差事件流后端（§8） |
| D-I | Usage 从 `onProviderStreamEvent` 观察原始 chunk 构建，不读 Pi 的 `Usage` | Pi 把缺失写成 0（`openai-completions.js:1171-1199`），违反 usage-accounting 规格 |
| D-J | 先 DeepSeek，再 GLM | DeepSeek 只有一个端点；GLM 有 coding plan 和地区端点的选择（§25） |
| D-K | 首批只放行 `openai-completions` API 的模型 | 把验证面收窄到一个 Pi API 适配器；其他 API 的签名和 usage 字段未核对 |
| D-L | Strata 用 Pi 的 `createProvider()` 走同一条 Direct 路径，连接信息由 Multi 自己持有，运行时不读 Pi 的 `models.json` | 不需要等 Generic API。`models.json` 可能含明文 key，其 `!command` 在请求时执行（Pi `docs/models.md:65`），Multi 不能加载或执行它 |

---

# 4. 现状摘要

已存在、应复用：

- `gw/provider-request.ts` 的 `PreparedRequest`（`send` + `translate`），Zen 和 OpenAI 已在各自目录构建请求。
- `gw/server.ts:586-631` 的 `handleHosted` 拥有 keepalive、事件、失败映射和 `serveReply`。
- `gw/usage-accounting.ts` 的 `CanonicalTokenUsage`；`gw/response-usage.ts` 的 `parseOpenAIResponseUsage`、`openAIProtocolUsage`、`responseUsageMetadata`。
- `gw/direct-tools.ts` 的 deferred tool 规则；`gw/worker-models.ts` 的 `stripWorkerModel`。
- `plugins/multi-zen/src/chat.ts` 的 thinking 签名模式和内容块累加规则。

写死 provider 的位置（PRD §3 只列了 4 个，实际如下，必须全部收口）：

| 位置 | 内容 |
| --- | --- |
| `gw/provider.ts` | `HARNESS_PROVIDERS`、`ProviderName`、`PROVIDERS`、`PROVIDER_AUTO_REVIEW`，`providerRoute` 未知回落 `openai` |
| `gw/provider-workers.ts:2-8`、`hooks/provider.ts:2-8` | worker 类型、`isHarnessModel` |
| `gw/provider-request.ts` | `ProviderEvent.route`、`PreparedRequest.route` 联合类型 |
| `gw/provider-usage.ts:12,41-48` | `UsageProvider`、`providers`、`unavailable` |
| `gw/worker-catalog.ts` | `WORKER_PROVIDERS`、`PROVIDER_LABELS`、`parseProviderModel` 的 `[a-z]+`（`:68`）、`byProvider` 的 `includes('/')`（`:118`） |
| `gw/server.ts` | `GatewayEvent.route`（`:104-113`）、`usageReaders`、`zen`、`reviewers`、`displayTools`（`:139-164`）、`harnesses`（`:261`）、reviewer 判断（`:284`）、`prepareHosted`（`:632-653`）、`:828`、`FOREIGN_SIGNATURE_PREFIXES`（`:76`）、`assertProviderEnabled` 的 `split('/')`（`:1361`） |
| `core/launcher.ts` | 静态 import（`:10-61`）、发现（`:157-173`）、`WORKER_RUNS`（`:726`）、`direct`（`:741`）、`split('/')`（`:780`）、`pickerSettings`（`:1080-1132`）、`gatewayEnvironment`（`:1163-1167`） |
| `core/install/plugins.ts:8,19-30,86`、`core/install/bootstrap.ts:47-48`、`core/account.ts:66` | 安装列表和启用选择 |
| `.claude-plugin/marketplace.json`、`scripts/versioning.ts` | 市场条目和版本 pin |
| 其他路由解析 | `plugins/multi-cursor/src/models.ts:111`、`plugins/multi-zen/src/chat.ts:183`、`plugins/multi-zen/src/request.ts:36`、`hooks/worker-rows.ts:46` |

---

# 5. 总体结构

```text
                      gw/provider-facts.ts   纯数据，hooks 也能 import
                               │
core/launcher.ts ──► gw/provider-registry.ts ◄── plugins/multi-*/src/provider.ts
       │                       │                    （描述符，不 import 重依赖）
       │ ProviderRuntime       │
       ▼                       ▼
gw/server.ts ── handleDirect ── adapter.prepare() ── PreparedRequest.open()
       │                                                  │
   keepalive / 事件 / 失败映射 / serveReply                ├─ HTTP 后端（Zen、OpenAI）
                                                          └─ 事件后端（multi-pi → pi-ai）
```

一次 DeepSeek 请求：

```text
Claude Code → POST /v1/messages  model=multi/deepseek/deepseek-v4-pro
  server    decodeModelRoute → registry.resolve → 检查所属插件已启用
  adapter   Anthropic Messages → Pi Context + StreamOptions（纯函数）
  open      pi-ai stream(model, context, {apiKey, env:{}, fetch, signal, maxRetries:0, ...})
            等第一个事件：start → 成功；error → 映射为 UpstreamFailure
  translate Pi 事件 → Anthropic SSE；原始 chunk → Canonical Usage
  server    completionEvent → serveReply → receipt
Claude Code 执行 tool_use，把 tool_result 发回，循环继续
```

---

# 6. 路由与 ModelIdentity

新文件 `gw/model-identity.ts`。它必须 host-free（无 Node 专属依赖、无重 import），因为 hooks 也要用。

## 6.1 语法

```text
multi/<provider>/<encoded-id>[/<cursor-params>][[1m]]
```

| 段 | 规则 |
| --- | --- |
| `<provider>` | `^[a-z0-9][a-z0-9._-]{0,63}$`（PRD §5.1）。保留 `core`：`multi-core` 是插件名，不能作为 worker |
| `<encoded-id>` | `encodeURIComponent(modelId)`，可含 `%2F`、`%40` |
| `/<cursor-params>` | 只属于 Cursor 预设，形如 `k=v,k=v`，含原始 `/`、`=`、`,` |
| `[1m]` | 留在编码之外，Claude 从这个标签读上下文窗口（`core/launcher.ts:867,932,1061-1072`） |

```ts
export interface ModelIdentity {
  providerId: string;
  modelId: string;         // 解码后的原生 ID
  routeId: string;         // 不含 [1m] 的完整路由
  preset?: string;         // 原始 Cursor 预设段
  oneMillionContext: boolean;
}

export function encodeModelRoute(providerId: string, modelId: string): string;
export function decodeModelRoute(route: string): ModelIdentity | undefined;
```

## 6.2 规则

- `decode(encode(p, m))` 是恒等的。`encode(decode(x))` **不要求**恒等，因为 Cursor 预设有原始字符。
- 已存的 `multi/openai/...`、`multi/zen/...`、`multi/cursor/...` 解析结果必须与现在一致。
- `byProvider`（`gw/worker-catalog.ts:118`）判断预设时改用 `identity.preset !== undefined`，不再看解码后的 `includes('/')`。否则嵌套 ID（`anthropic%2Fclaude`）会被当成预设丢弃。
- `core/launcher.ts:780`、`gw/server.ts:1361`、`plugins/multi-cursor/src/models.ts:111`、`plugins/multi-zen/src/chat.ts:183`、`plugins/multi-zen/src/request.ts:36`、`hooks/worker-rows.ts:46` 全部改用 `decodeModelRoute`。MP-0102 的目标改为这些位置；它写的 `worker-catalog.ts` 里没有 `split`。

## 6.3 首批不需要 `%2F`

首批模型 ID（`deepseek-v4-pro`、`glm-5.3`）不含 `/`。所以 Claude Code 对 `%2F` 的端到端行为（U2）**不阻塞** Pi 里程碑。编码和解码照常实现并做单测；端到端验证推迟到第一个带 `/` 的 provider（比如 OpenRouter）接入时。

---

# 7. 事实表、描述符、Registry、Runtime

分三层，因为 hooks 必须 host-free，而描述符可能依赖 provider 代码。

## 7.1 `gw/provider-facts.ts`（纯数据）

```ts
export const PROVIDER_FACTS = [
  { id: 'openai', plugin: 'openai', kind: 'direct', worker: 'multi-openai', label: 'OpenAI' },
  { id: 'zen', plugin: 'zen', kind: 'direct', worker: 'multi-zen', label: 'OpenCode Zen' },
  { id: 'cursor', plugin: 'cursor', kind: 'harness', worker: 'multi-cursor', label: 'Cursor' },
  { id: 'antigravity', plugin: 'antigravity', kind: 'harness', worker: 'multi-antigravity', label: 'Antigravity' },
  { id: 'grok', plugin: 'grok', kind: 'harness', worker: 'multi-grok', label: 'Grok' },
  { id: 'deepseek', plugin: 'pi', kind: 'direct', worker: 'multi-deepseek', label: 'DeepSeek' },
  { id: 'zai', plugin: 'pi', kind: 'direct', worker: 'multi-zai', label: 'Z.AI' },
  { id: 'zai-coding-cn', plugin: 'pi', kind: 'direct', worker: 'multi-zai-coding-cn', label: 'Z.AI Coding (CN)' },
  { id: 'strata', plugin: 'pi', kind: 'direct', worker: 'multi-strata', label: 'Strata' },
] as const;
```

标签以现有 `PROVIDER_LABELS` 为准，上面只是示意。

`isProviderWorker`、`isHarnessModel`、`isHarnessProvider`、`providerOf` 都从这张表派生，文件 `gw/provider-workers.ts` 和 `hooks/provider.ts` 只做转发。

**不用正则匹配 `multi-*` 的原因：** 用户自己的 agent 可能叫 `multi-foo`，会被误判成 provider worker。外部 provider 插件到来时（MP-08xx），hooks 改为经 `/multi/mod/*` 取表，这不在本设计范围内。

## 7.2 描述符

以 PRD §8 为起点，调整如下：

```ts
export interface ProviderDescriptor {
  id: string;
  plugin: string;                         // 新增：启用选择按插件
  label: string;
  kind: 'direct' | 'harness';
  credentialEnv?: readonly string[];      // 新增：驱动 §10 的隔离
  autoReview: AutoReviewPolicy;           // 替代 PRD §46，见 §14
  availability(context: ProviderDiscoveryContext): Promise<ProviderAvailability>;
  discoverModels(context: ProviderDiscoveryContext): Promise<readonly ModelDescriptor[]>;
  usage?: ProviderUsageReader;
  direct?: DirectProviderAdapter;
  createHarness?: (context: NativeHarnessFactoryContext) => Promise<NativeHarness>;
  displayTools?: readonly string[];
  unavailableMessage: string;
}
```

`ModelDescriptor` 用 PRD §7。两处说明：`capabilities.tools` 对 Pi 模型由 curated 目录声明（Pi 的 `Model` 没有这个字段，PRD §22 的映射无来源）；`pricing` 只作目录信息，不进入 usage。

## 7.3 Registry（`gw/provider-registry.ts`）

接口用 PRD §9。注册时检查：ID 合法、不重复、不是保留 ID、在事实表中存在且 `kind`、`plugin` 一致、`kind` 与 adapter 匹配。任何一项不通过都抛错并终止启动，不静默跳过。

额外提供 `signaturePrefixes()`（替代 `FOREIGN_SIGNATURE_PREFIXES`）和 `resolveRoute`。

`providerRoute` 的新行为：

| 输入 | 现在 | 之后 |
| --- | --- | --- |
| 非 `multi/` 模型 | `anthropic` | 不变 |
| 已知 `multi/<p>/...` | `<p>` | 不变 |
| 未知 `multi/<p>/...` | **回落 `openai`，请求发给 OpenAI** | `BadRequest`（破坏性，§20） |
| 已知 provider 但插件未启用 | `assertProviderEnabled` 报错 | 不变，改按 `descriptor.plugin` 判断 |

## 7.4 Runtime

`registerBuiltinProviders()` 静态注册全部内置描述符。发现流程仍是 launcher 的 `Promise.all`，但改为遍历 `registry.list()`，过滤已启用的插件，把结果存进 `ProviderRuntime`。`GatewayOptions` 改为接收 `runtime`，删除 `zen`、`cursor`、`antigravity`、`grok`、`reviewers`、`displayTools`、`usageReaders` 这些按名字段。

`NativeHarness` 接口不增加 `close`，`ProviderRuntime.close()` 继续用 launcher 现有的 `Closable` 方式。

---

# 8. Direct 执行契约

**问题：** 现在的 `send()` 返回 HTTP `Response`，`translate()` 读字节流。`pi-ai` 的 `stream()` 产出事件流，两者都不适用。

**做法：** 把 `send` + `translate` 合成 `open`，让 HTTP 细节留在一个共用 helper 里。

```ts
export type UpstreamOpen =
  | { ok: false; status: number; retryAfter: string | null }
  | {
      ok: true;
      translate(emit: Emit | undefined, remember: RememberWorkerModel): Promise<MessagesResponse>;
    };

export interface PreparedRequest {
  label: string;
  authHelp: string;
  endpoint: string;
  route: string;                // Registry 校验，不再是联合类型
  inputTokens(): number;
  completion?: Partial<GatewayEvent>;
  requestEvent(agentId?: string): ProviderEvent;
  failureEvent(status: number, agentId?: string): ProviderEvent;
  open(signal: AbortSignal, fetchImpl: GatewayFetch): Promise<UpstreamOpen>;
}

export interface DirectProviderAdapter {
  prepare(input: ProviderRequestInput): PreparedRequest;
  signaturePrefixes: readonly string[];
}

/** Zen、OpenAI 用：非 2xx 取消 body 后返回失败，缺 body 时抛错。 */
export function httpUpstream(
  send: () => Promise<Response>,
  translate: (body: ReadableStream<Uint8Array>, emit, remember) => Promise<MessagesResponse>,
): Promise<UpstreamOpen>;
```

`handleHosted` 改名为 `handleDirect`，形状几乎不变：

```ts
const prepared = prepareDirect(exchange, descriptor);
if (url.pathname === '/v1/messages/count_tokens') { /* 不变 */ }
onEvent(prepared.requestEvent(agentId));
exchange.keepAlive();
const upstreamAbort = new AbortController();
const upstream = await prepared.open(AbortSignal.any([signal, upstreamAbort.signal]), fetchImpl);
if (!upstream.ok) {
  onEvent(prepared.failureEvent(upstream.status, agentId));
  throw new UpstreamFailure(upstream.status, upstream.retryAfter, prepared.label, prepared.authHelp);
}
exchange.startStream();
const result = await upstream.translate(body.stream ? emit : undefined, workerModels.remember(session));
if (result.stop_reason === 'stop_sequence') { upstreamAbort.abort(); }
onEvent({ ...completionEvent(exchange, result, prepared.route, prepared.endpoint), ...prepared.completion });
await serveReply(exchange, result);
```

**不变式：**

- provider 模块不写 HTTP 回复、不决定 terminal 事件。这条沿用 AGENTS.md：“`server.ts` alone finalises served replies and terminal events”。
- `prepare` 的异常映射成 `BadRequest`（现有 `prepareHosted:650` 的行为）。
- 验收：`gw/server.ts` 不 import `plugins/multi-*/`。PRD Milestone B 的旧验收（“server.ts 不存在 Zen/OpenAI request-building 逻辑”）今天字面上已经成立，失去了意义。

Zen 和 OpenAI 迁移只把 `send`/`translate` 包进 `httpUpstream`，现有测试的断言不应变化。

---

# 9. 启用、插件、依赖

**事实：** core 的 `source` 是 `./`，launcher 从 `root/plugins/multi-core/src/launcher.ts` 启动（`core/install/bootstrap.ts:51`），provider 代码按相对路径 import。所以 `plugins/multi-pi/` 的代码和依赖都随 core 分发，**`multi-pi` 插件清单只是开关**。

| 项 | 决定 |
| --- | --- |
| 插件 | `plugins/multi-pi/.claude-plugin/plugin.json`；市场条目形同 `multi-zen`；`scripts/versioning.ts` 加 `~<version>` pin |
| 启用 | `core/install/plugins.ts:8` 的 `PROVIDERS` 加 `pi`。`MULTI_ENABLED_PROVIDERS` 的语义明确为**插件 ID 列表**，不改名 |
| 依赖 | 根 `package.json` 精确 pin `"@earendil-works/pi-ai": "1.4.0"`，不带 `^` 或 `~` |
| 代价 | 所有 Multi 用户都增加磁盘占用（`pi-ai` 解包 4.3 MB，另有 `@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`openai`、`typebox` 等传递依赖）。S3 实测后写进 `docs/pi.md` |
| 加载 | 只 import 单 provider 工厂（`@earendil-works/pi-ai/providers/deepseek`、`providers/zai`、`providers/zai-coding-cn`），不 import `providers/all`。Strata 用 `createProvider` 和 `api/openai-completions.lazy` |
| 懒加载 | `plugins/multi-pi/src/provider.ts` 不 import `pi-ai`。只有在插件已启用**且**对应 key 存在时，`discoverModels` 才 `await import('./backend.ts')`。没有 key 的用户没有启动开销 |
| 信任规则 | 动态 import 的是 core 自身目录内的固定相对路径，不从 cwd 或项目解析，符合 `core/install/plugins.ts:80-81`。这是 AGENTS.md “Prefer direct module imports” 的一处窄例外，在代码旁注明理由 |
| 升级 | 只通过显式改 pin。升级必须重跑 §19 的特征测试，尤其是 usage 观察和 thinking 往返 |

Pi 包无 install script、ESM、MIT、`engines` ≥22.19，与仓库的 ≥24.12 不冲突。

---

# 10. 凭据

| Provider | 环境变量 | 不读 |
| --- | --- | --- |
| `deepseek` | `DEEPSEEK_API_KEY` | `~/.pi/agent/auth.json` |
| `zai` | `ZAI_API_KEY` | `~/.pi/agent/models.json` |
| `zai-coding-cn` | `ZAI_CODING_CN_API_KEY` | cwd 下的 `auth.json`（`npx pi-ai login` 写在那里） |
| `strata` | `STRATA_API_KEY`（回环地址可不设，见 §16.1） | 同上 |

```ts
/** 读出密钥后从 env 中删除，子进程就拿不到。返回值只在内存中传给 adapter。 */
export function takeProviderCredentials(
  env: NodeJS.ProcessEnv,
  descriptors: readonly ProviderDescriptor[],
): Map<string, string>;
```

规则：

1. Launcher 在创建任何子进程之前调用它，且只处理已启用插件的描述符。未启用 `multi-pi` 的用户，这些变量原样保留。
2. 删除 `process.env` 上的条目，而不只是从 `gatewayEnvironment` 过滤。`gw/harness-process.ts:61-65` 和各 harness 都会展开 `process.env`，只改 Claude child 拦不住 Cursor、Antigravity、Grok。
3. 调用 Pi 时显式传 `apiKey`，认证来源因此固定。**`env: {}` 不构成隔离：** Pi 的 `getProviderEnvValue` 在 `env` 没有该项时会回退到 `process.env`（`utils/provider-env.js:39-43`）。在首批调用路径上，`openai-completions` 唯一读取的环境变量是 `PI_CACHE_RETENTION`（`openai-completions.js:146`），所以 adapter 显式传 `cacheRetention`，让它不起作用。升级 Pi 时重新 grep `getProviderEnvValue`，凡是会影响行为的项都显式赋值。测试：设 `PI_CACHE_RETENTION=long` 后，请求不变。
4. 不触碰 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`：首批白名单不用它们。
5. 用户可见的代价：启用后，会话内的 Bash 拿不到这些变量。与 Zen 删除 `OPENCODE_API_KEY` 同理，写进 `docs/pi.md`。

可用性只看 key 是否非空，启动时不发网络请求。无效 key 在首次调用时返回 401，映射到 `authHelp`。

Multi 自管的配置文件不在首批，等有实际需要再加。

---

# 11. Worker、Picker、Hooks

**Worker。** `gw/worker-catalog.ts`：

- `WORKER_PROVIDERS`、`PROVIDER_LABELS`、`workerType` 改从事实表派生，只包含本次启动实际可用的 provider。
- `parseProviderModel` 改用 `decodeModelRoute`。
- `workerDefinitions`（`core/launcher.ts:738`）用 `kind === 'direct'` 判断工具集，Pi worker 得到 `CLAUDE_WORKER_TOOLS`。
- `resolveWorker` 的未知 worker 继续显式失败。

**`--agents` 预算。** 最多新增 4 个 worker，由现有 `checkLauncherArgumentLimit`（32000/8000）把关。新增一条测试：全部 provider 启用、用 Windows 限制 8000，断言不超限。超限时维持现有的报错行为，不静默裁剪。

**Picker。** `pickerSettings` 按 runtime 生成行：

- 只显示有 key 的 provider。
- Pi provider 的可用目录就是 §16 的白名单（§12.2），默认展示也是这份列表。`MULTI_MODELS` 的全目录路径对 Pi provider 只列白名单，不扩大范围；与 Zen 不同，这里不存在“白名单之外的完整目录”。`MULTI_PI_MODELS` 只能在白名单内缩小，写了白名单之外的 ID 就报错。
- 新增 `MULTI_PI_MODELS`，语义照抄 `MULTI_ZEN_MODELS`（`core/launcher.ts:1090`）。
- `retagSelection` 对首批路由无影响（都是新 ID），但要加测试确认旧选择不变。

**Hooks。** 改动走 Claude Mods function hooks。`hooks/workers.ts` 的 `isProviderWorker`、`isMultiModel` 和 `hooks/provider.ts`、`hooks/worker-rows.ts` 只改数据来源（事实表和 `decodeModelRoute`），不增加 `/multi/mod/*` 路由。验收跑 `npm run test:mod`。

---

# 12. Pi AI 适配器

## 12.1 模块

```text
plugins/multi-pi/
  .claude-plugin/plugin.json
  src/provider.ts          描述符；无 pi-ai import
  src/catalog.ts           curated 白名单（§16）
  src/signature.ts         签名前缀和编解码；无 pi-ai import
  src/backend.ts           懒加载：createModels + setProvider，模型 → ModelDescriptor
  src/messages.ts          Anthropic → Pi Context（纯函数）
  src/stream.ts            Pi 事件 → Anthropic SSE 和 MessagesResponse
  src/usage.ts             原始 chunk → CanonicalTokenUsage
  src/gateway-request.ts   preparePiRequest：组装 PreparedRequest
```

`usage-accounting` 规格禁止该模块 import registry，所以适配放在 provider 一侧，方向是 `multi-pi → usage-accounting`。

## 12.2 目录过滤

严格白名单：§16 的列表就是 Pi provider 能用的全部模型，`MULTI_MODELS` 和 `MULTI_PI_MODELS` 都只能在其中筛选，不能扩大（§11）。`backend.ts` 只暴露同时满足以下条件的模型：在 §16 白名单里；`type` 是聊天类；`api === 'openai-completions'`。白名单里的 ID 如果在锁定的 Pi 版本里不存在，单测失败；Strata 不在 Pi 目录内，不做这项检查。

## 12.3 请求映射

| Anthropic | Pi | 规则 |
| --- | --- | --- |
| `system` | `systemPrompt` | 拼接 text 块 |
| user text / image | user `content` | 模型 `input` 不含 image 时报错（对齐 Zen `validateMedia`）。只接受 base64 |
| `document` | — | `BadRequest`，首批不支持 |
| `tool_result` | `toolResult` 消息 | `toolCallId`、`toolName`（从前面的 tool_use 查）、`content`、`isError`，排在同一轮 user 文本之前 |
| assistant `text` | text | |
| assistant `thinking` | thinking + `thinkingSignature` | 见 §12.5；非本模型签名则丢弃 |
| assistant `tool_use` | toolCall | `name` 用 `toolName()`，`id` 用 `callId()`，见 §12.3.1 |
| `tools` | `context.tools` | `name` 用 `toolName()`；deferred tools 用 `isDirectToolAvailable` 过滤；`tool_reference` 处理与 `toResponses` / `toChat` 对齐。Fixture 断言请求里 `strict` 为 false |
| `tool_choice: auto/none` | `toolChoice: 'auto'/'none'` | |
| `tool_choice: any` | `toolChoice: 'required'` | `OpenAICompletionsOptions.toolChoice` 用 OpenAI 形状（`openai-completions.d.ts:6`），无需 `onPayload` |
| `tool_choice: tool` | `{type:'function', function:{name: toolName(name)}}` | 同上；名字不在已声明工具中时 BadRequest（同 `multi-zen/src/chat.ts:331`） |
| `max_tokens` | `maxTokens` | 必须在 `1..model.maxTokens`，否则报错；缺省 `min(32000, maxTokens)` |
| `stop_sequences` | — | 非空时 `BadRequest`。如果 S4 发现 Claude Code 真的发送，改用 Zen 的本地检测方式 |
| `cache_control` | — | 不进入 Pi Context；S4 实测 Claude Code 会在 system 与 message content 中发送 `{type: 'ephemeral'}`。首批 provider 仍按前缀自动缓存；两者是否具有完全相同的缓存语义未由本地假上游实验验证 |
| `temperature` 等采样参数 | | 与 `toChat` 相同的取舍 |

Pi 的 assistant 消息还要求 `api`、`provider`、`model`、`usage`、`stopReason`、`timestamp`。回放时从描述符填入，`usage` 用零值占位（只给 Pi 的类型，不进入计费），`timestamp` 用固定值，保证纯函数输出字节稳定。**同 provider+api+model 才保留 thinking**（Pi README:1581-1582），这三个字段必须与原响应一致。

## 12.3.1 工具名别名往返

Pi 的 `convertTools`（`openai-completions.js:1139-1166`）原样发送 `tool.name`，而上游要求函数名匹配 `^[a-zA-Z0-9_-]{1,64}$`。Claude Code 的 MCP 工具名（`mcp__<server>__<tool>`）可能超过 64 字符，或含其他字符。所以复用 `gw/tools.ts` 的别名，与 Zen（`multi-zen/src/chat.ts:264,296,315,331-334,446,972-975`）用法一致，不另写一套：

| 位置 | 处理 |
| --- | --- |
| 工具声明 `context.tools[].name` | `toolName(name)` |
| 历史 assistant toolCall | `name` 用 `toolName()`，`id` 用 `callId()` |
| 历史 toolResult | `toolCallId` 用 `callId()`，`toolName` 用 `toolName()` |
| `tool_choice: {type:'tool', name}` | `toolName(name)`，且该名必须在本次声明的工具里，否则 BadRequest |
| `tool_reference` 转成的文本 | 用别名，与声明一致 |
| 响应 `toolcall_end` | 用 `originalToolNames(body)` 还原原名；找不到就显式失败，不发送 |

`originalToolNames` 在两个不同的原名映射到同一个别名时报错，这项检查保留。测试：一个超过 64 字符的 MCP 工具名完成“声明 → 响应 → 历史回放 → 指定 `tool_choice`”的完整往返；别名冲突时报错；响应中出现未知名称时报错。

## 12.4 Effort

```text
模型未声明 effort（如 Strata）
  不传 reasoningEffort；请求带 output_config.effort 时丢弃，并在响应中提示一次已忽略 effort
模型声明了 effort 且 output_config.effort 存在
  thinkingLevelMap[effort] 是字符串 → reasoningEffort: effort
  否则 → 就近映射到 map 值为字符串的支持档位，并在响应中提示一次实际使用的档位
模型声明了 effort 且 effort 缺失
  body.thinking.type === 'disabled' → 不传 reasoningEffort
  否则 → curated defaultEffort（首批都是 'high'）
```

支持集合只包含 map 值为字符串的级别，`null` 和缺失的键都算不支持，但不因此拒绝请求。按 `low < medium < high < xhigh < max` 的序号距离选最近的支持档位，等距取较高档；仅发生映射时在该请求的响应中提示一次实际使用档位（流式与非流式一致，不按块重复）。未声明 effort 的模型收到 effort 时直接丢弃，同样提示一次。不得把不支持的级别原样透传：Pi 会把它原样发给上游，比如 `deepseek-v4-pro` 的 map 没有 `xhigh`（`openai-completions.js:680-681`），应映射为 `max`。`ModelDescriptor.reasoning.efforts` 仍只由字符串值派生，curated reasoning 模型必须有非空支持集合及受支持的 defaultEffort，由单测保证。

`pi-ai@1.4.0` 目录中的实际级别（已从 `dist/providers/data/*.json` 核对）：

| 模型 | 支持的 effort |
| --- | --- |
| `deepseek-v4-pro` | high、max |
| `deepseek-flash` | low、high、max |
| `glm-5.3`、`glm-5.3-flash` | low、high、max |
| `glm-5.2` | high、max |

上述目录模型均不支持 `medium`。若请求携带 `medium`，全部映射到 `high`（`low`/`high` 等距时取高），并在响应中提示一次实际档位。S4 的 Sonnet 默认场景发送 `medium`，但不能外推为所有 Pi 路由的默认值；2.1.318 的干净配置补验中，`multi/deepseek/deepseek-v4-pro` 和 `multi/strata/qwen3.8-flash-next` 实际发送 `high`。这仅限 §18.1 所列模型、参数和配置，不代表所有路由或 launcher/picker 元数据下的默认行为。

S4 还确认 `--effort low|medium|high|xhigh|max` 分别原样出现在请求中；对应模型目录不支持的级别由上述就近映射规则处理，未声明 effort 的模型则丢弃并提示一次。`thinking.type` 实测为 `adaptive`。`claude --help` 未提供关闭 thinking 的 CLI 开关；隔离 settings 中的 `alwaysThinkingEnabled: false` 和 `MAX_THINKING_TOKENS=0` 实测均未改变该字段，本轮没有确认可关闭 thinking 的设置方式。

**为什么要默认 effort：** Pi 在没有 `reasoningEffort` 时会主动关闭 thinking（`openai-completions.js:625-627,672-678`），不是“用 provider 默认值”。

**未验证：** `glm-5.3` 的 `off` 是 `null`，表示目录认为它不能关闭 thinking，但 Pi 的 zai 分支不看这个值，照样发送 `thinking: {type: "disabled"}`。上游是否接受只有 live 能确认。首批不特殊处理：被拒绝时按普通上游错误显式失败，P6 用一次请求验证。

## 12.5 Thinking 往返

格式（仿 `plugins/multi-zen/src/chat.ts:178-186`）：

```text
multipi:v1:<encodeURIComponent(routeId)>:<base64url(JSON{thinking, thinkingSignature?, redacted?})>
```

- 响应时写入 Anthropic `thinking` 块的 `signature`。
- 请求时只还原 `routeId` 与当前模型相同的签名，其余丢弃。这也符合 Pi 的跨模型规则。
- 必须保留 `thinkingSignature`：Pi 靠它决定写回哪个字段（`openai-completions.js:1011-1017`）。DeepSeek 还要求 assistant 消息带 `reasoning_content`（`:1055-1058`）。
- 前缀 `multipi:v1:` 注册进 `adapter.signaturePrefixes`。否则切回 Claude 模型时 `forAnthropic`（`gw/server.ts:657`）不会过滤它，Anthropic 会拒绝这条消息。
- `toolCall.thoughtSignature` 和 `textSignature`：在 `openai-completions` 首批 provider 中不应出现。fixture 断言不出现；若 live 中出现，显式失败并记录，而不是静默丢弃。

## 12.6 流映射

**Pi 的块生命周期与 Anthropic 不同，不能把 start/end 一一映射。** 在 `openai-completions.js` 里，`ensureThinkingBlock` 和 `ensureTextBlock`（:276-294）每类块只建一次，并且建时立刻发出 `*_start`；所有块的 `*_end` 都要等流结束后在循环里依次调用 `finishBlock`（:472-474）。所以真实顺序可能是 `thinking_start → thinking_delta → text_start → text_delta → thinking_delta → … → thinking_end → text_end`。thinking 的 `thinkingSignature` 在 start 时由 reasoning 字段名决定（:403-406），但 `finishBlock` 可能用 `applyStreamedReasoningDetails` 把它改写为 reasoning_details 的 JSON（:177）。

因此 `stream.ts` 按 **delta 驱动**，忽略 Pi 的 start/end 边界：

1. 同一时刻只开一个 Anthropic 块。一段连续的同类 delta（thinking 或 text）组成一个 Anthropic 块；类型一变，就关闭当前块，再开新块。索引自增。
2. thinking 块关闭时，用当时已知的 `thinkingSignature`（字段名）生成 §12.5 的签名，发 `signature_delta` 后再发 `content_block_stop`。
3. 收到 `thinking_end` 时，如果它的 `thinkingSignature` 与已发出的签名不同（reasoning_details 路径），就显式失败（`${label} stream failed.`）。首批 provider 不应走这条路径；若出现，必须先补上支持。
4. 回放时（§12.3），同一模型的相邻 thinking 块合并成一个 Pi thinking 块，因为 Pi 每条消息只有一个 reasoning 字段。
5. 工具调用在 `toolcall_end` 之前全部缓冲（见下表）。

| Pi 事件 | Anthropic |
| --- | --- |
| `start` | `message_start`，`id` 自生成 `msg_<uuid>`（Pi 此时还没有 responseId），`usage.input_tokens` 用本地估算 |
| `thinking_start`、`text_start` | 不发送，只记录状态 |
| `thinking_delta`、`text_delta` | 按上面的规则 1 开或换块，再发 `thinking_delta` 或 `text_delta` |
| `thinking_end`、`text_end` | 只做规则 3 的检查，不发送 |
| `toolcall_start/delta` | **缓冲，不发送** |
| `toolcall_end` | 有 `argumentsError` 就显式失败（见下）；否则关闭当前块，用 `originalToolNames` 还原名称（§12.3.1），`stripWorkerModel` 后一次性发送 start、完整 `input_json_delta`、stop |
| `done` | 关闭还开着的块，**不发** `message_delta` 和 `message_stop`；`translate` 结束并返回 `MessagesResponse`（content、`stop_reason`、usage），由 server 收尾 |
| `error` | 抛错，走 §12.7 |

工具调用要缓冲，因为 `stripWorkerModel` 要求在块进入流之前规范化（`gw/worker-models.ts:7`）。

**终止事件只由 server 发。** AGENTS.md 规定 `server.ts` 是唯一负责收尾的地方：`serveReply` / `emitTerminal`（`gw/server.ts:1093-1105`）根据 adapter 返回的 `MessagesResponse` 发送 `message_delta`（stop_reason、`safeguard_results`、usage）和 `message_stop`，Zen 也是这样（`multi-zen/src/chat.ts` 不发终止事件）。如果 adapter 自己发，就会绕过审查结论和 usage 收尾，流里还会出现两次终止事件。测试断言：adapter 的输出不含终止事件；整条流里 `message_stop` 只出现一次。

**参数解析失败（`argumentsError`）。** Pi 在 `finishBlock` 里解析工具参数（`parseToolCallArguments`）；解析失败时不抛错，而是给 `arguments: {}` 并带上 `argumentsError`，其中含原始参数文本（`utils/json-parse.js:88-104`）。只有 `utils/validation.js:281` 会抛，而流路径不调用它。如果照常发送，Claude Code 会用空参数执行工具；对允许空参数的工具，这是一次错误的真实执行。所以 adapter 在发送 tool_use 之前检查：`argumentsError` 存在就抛 `${label} returned a tool call with invalid arguments.`。错误信息和 trace 只记类别，**不含 `argumentsError` 也不含原始参数**，因为它们可能带有用户数据。

| Pi `stopReason` | Anthropic |
| --- | --- |
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `toolUse` | `tool_use` |
| `error`、`aborted` | 失败路径 |
| `pending`、`deferred` | 显式失败：首批 API 不应出现 |

## 12.7 打开、错误、中止

```ts
async open(signal, fetchImpl) {
  const wire = observedFetch(fetchImpl);   // 记录最后一次响应的 status、retry-after，不碰 body
  const usage = new ObservedUsage();
  const events = backend.stream(model, context, {
    apiKey, env: {}, cacheRetention: 'short',   // env: {} 不隔离 process.env，见 §10 规则 3
    fetch: wire.fetch, signal, maxRetries: 0,
    maxTokens, reasoningEffort, toolChoice,
    onProviderStreamEvent: usage.observe,
  });
  const iterator = events[Symbol.asyncIterator]();
  const first = await iterator.next();     // `start` 在响应到达后才推送（openai-completions.js:197-203）
  ...
}
```

| 情况 | 处理 |
| --- | --- |
| 第一个事件是 `start` | `{ok:true, translate}` |
| 第一个事件是 `error`，`wire` 有非 2xx 状态 | `{ok:false, status, retryAfter}`，gateway 走既有 `UpstreamFailure`，401/403 带 `authHelp` |
| 第一个事件是 `error`，没有状态 | 抛 `${label} request failed.`（网络错误） |
| 流中 `error` | 抛 `${label} stream failed.`，走 gateway 现有流后失败路径 |
| `aborted` | signal 已触发，按现有中止路径处理 |

- **`errorMessage` 不转发、不记录。** 它可能包含上游响应内容，延续 `server.ts:604` 的规则。代价是诊断只有状态码和类别。
- **`maxRetries: 0`。** 重试归 Claude Code。Pi 内部不重试，也不可能重放已开始的响应。
- `observedFetch` 对跳转用 `redirect: 'error'`，防止凭据被带到别的主机。
- 没有 `close`：每个请求一个迭代器，正常结束或由 signal 中止。

## 12.8 Count tokens

`inputTokens()` 用 `estimateInputTokens(toResponses(body, modelId, signaturePrefix))`，加上 thinking 文本的估算（同 `plugins/multi-zen/src/request.ts:57-70`）。不加载也不调用 Pi；gateway 继续写 `x-multi-token-count: estimate`。

---

# 13. Usage

**这里修正早期结论。** 之前认为只能启发式判断（`pi-ai` 的 `Usage` 把缺失写成 0，无法区分）。实际上 `StreamOptions.onProviderStreamEvent(chunk, model)` 能拿到 Pi 处理前的原始 chunk（`openai-completions.js:354`），所以**不需要启发式**。

```ts
class ObservedUsage {
  observe = (chunk: unknown) => { /* 读 chunk.usage ?? chunk.choices[0].usage，只保留数字字段；不抛错 */ };
  canonical(): CanonicalTokenUsage;
}
```

| 原始字段 | Canonical | 缺失时 |
| --- | --- | --- |
| `prompt_tokens` − 缓存 | `inputTokens` | undefined |
| `completion_tokens` | `outputTokens` | undefined |
| `prompt_tokens_details.cached_tokens` ?? `prompt_cache_hit_tokens` ?? `cached_tokens` | `cacheReadTokens` | undefined |
| `prompt_tokens_details.cache_write_tokens` | `cacheWriteTokens` | undefined |
| `completion_tokens_details.reasoning_tokens` | `reasoningTokens` | undefined |
| `total_tokens` | `totalTokens` | undefined |

- 最后一个快照为准（Zen 的注释：累计快照）。
- 整个流都没有 usage → `source: 'unavailable'`，字段全空，不算请求失败。
- `prompt_tokens` 已知但缓存字段缺失、部分字段缺失时的 `source` 和 `inputTokens` 取值，按 `openspec/specs/usage-accounting/spec.md:19-48` 和 `parseOpenAIResponseUsage` 的既有规则，不自造。
- `modelCalls: 1`。每次 `/v1/messages` 恰好一次上游调用（`maxRetries:0`，无 Pi agent 循环）。
- Wire 上的 `usage` 用 `openAIProtocolUsage`，元数据用 `responseUsageMetadata`（`gw/response-usage.ts:109,117`）。
- **Pi 的 `message.usage` 和 `cost` 不进入 accounting。** `*-highspeed` 目录价全为 0，证明它不是账单。Canonical 不加 `cost` 字段（PRD §45 对应修订）。

`gw/provider-usage.ts` 改为表驱动。Pi provider 没有配额 reader，Dashboard 显示会话 tokens，配额行显示 unavailable 和原因。

---

# 14. Review 与权限

沿用现有 `AutoReviewPolicy`，不引入 PRD §46 的 `NativeApprovalBridge`、`ProviderReviewCapability`。

```ts
autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' }
```

和 Zen 一样。`PROVIDER_AUTO_REVIEW` 改由描述符提供；`autoReviewPolicy` 和 `reviewStatement` 不再按名判断，reviewer 查找从 `provider === 'openai'` 改成“描述符声明 `review: 'reviewer'`，且 runtime 持有 reviewer”。

| 模式 | Pi Direct 行为 |
| --- | --- |
| normal / acceptEdits | Claude Code 自己的权限提示 |
| plan | `gw/verdicts.ts` 拒绝动作（没有 reviewer 的 plan 路径） |
| auto | 不经审查运行，用 `statement` 明说（AGENTS.md） |
| bypass | Claude Code 既有行为 |

工具都由 Claude Code 执行，Pi 在这条路径上不执行任何工具，所以不产生 PRD §31 的工作区边界问题。

---

# 15. 安全不变式

每条都有对应测试（§19）。

1. Multi 不读 `~/.pi/agent/*`，不依赖 `pi-coding-agent`。
2. 密钥不出现在：Claude child env、Bash、harness 子进程 env、`GatewayEvent`、receipt、trace、错误消息、`--agents`、`ModelDescriptor.metadata`。
3. 上游响应体不进入日志或错误消息。
4. 除 `baseUrl` 主机外，一次请求不访问其他主机（fixture 用 fetch 记录断言）。这也同时验证 Pi 没有遥测外发。
5. `redirect: 'error'`。
6. 启动不从 cwd 加载代码；Pi 目录来自锁定的包，不访问网络（不调用 `models.refresh()`）。
7. `onPayload` 不使用；如果将来使用，不得记录 payload。
8. 工具参数解析失败时不发送 tool_use，错误和 trace 不含 `argumentsError` 或原始参数（§12.6）。
9. Pi 会回退读取 `process.env`（§10 规则 3）；需要固定的配置显式赋值，环境变量不能改变请求。

---

# 16. 首批目录

ID 来自 `pi-ai@1.4.0`，实现时由单测校验。

| Provider | 端点 | Key | curated 模型 |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro`、`deepseek-flash` |
| `zai` | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` | `glm-5.3`、`glm-5.2` |
| `zai-coding-cn` | `https://open.bigmodel.cn/api/coding/paas/v4` | `ZAI_CODING_CN_API_KEY` | `glm-5.3`、`glm-5.3-flash` |

**注意：** Pi 的这两个 GLM provider 都是 **coding plan 端点**，不是通用的按量付费 API。维护者的 GLM key 是 coding plan（2026-11-01 确认），与这两个端点匹配。国际端点和 CN 端点各用各的环境变量，设哪个就启用哪个。

路由示例：`multi/deepseek/deepseek-v4-pro`、`multi/zai/glm-5.3`、`multi/zai-coding-cn/glm-5.3`。

## 16.1 Strata

Strata 是维护者写在本地 Pi 配置里的自定义 provider，不在 `pi-ai@1.4.0` 目录中。下表的模型事实由一次性脚本从 `models.json` 取得（2026-11-01，经维护者同意，只取非密钥字段）：

| 字段 | 值 |
| --- | --- |
| 地址 | `http://127.0.0.1:8080/v1` |
| API | `openai-completions` |
| 模型 ID | `qwen3.8-flash-next`（路由 `multi/strata/qwen3.8-flash-next`） |
| 输入 | 仅文本 |
| `contextWindow` / `maxTokens` | 196608 / 32768 |
| `compat` | `supportsDeveloperRole: false`、`supportsReasoningEffort: false`、`maxTokensField: "max_tokens"` |
| `reasoning`、`thinkingLevelMap` | 未声明（Pi 的 `reasoning` 默认 `false`，`docs/models-configuration.md:36`） |
| key | 占位值 `local`（维护者 2026-11-01 确认配置内容），不是真实密钥 |

| 项 | 决定 |
| --- | --- |
| 接入方式 | `createProvider({ id: 'strata', models, api: openAICompletionsApi(), auth })`，之后复用 §12 和 §13。每次请求的选项与 §12.7 相同（显式 `apiKey`、`cacheRetention`） |
| 地址 | `MULTI_STRATA_BASE_URL`，设置后才启用这个 provider。只接受 `https://` 或回环地址的 `http://`，其他形式启动时报错 |
| 密钥 | 可选的 `STRATA_API_KEY`，按 §10 读取后从环境中删除。回环地址未设时发送占位值 `local`；非回环地址必须设置，否则启动时报错 |
| 模型事实 | `catalog.ts` 手写一行，取值见上表。Multi 运行时不从 Pi 配置同步，配置改了要手动改这一行 |
| API 限制 | 是 `openai-completions`，符合决定 D-K，不增加额外的适配器核对 |

**effort：** 配置没有声明 `reasoning`，所以 Strata 模型不声明 effort，也没有 `defaultEffort`。请求带 `output_config.effort` 时直接丢弃，不向上游发送 reasoning effort，并在响应中提示一次已忽略 effort（§12.4）。S4 的 2.1.318 干净配置补验对 `multi/strata/qwen3.8-flash-next` 观察到 `high`，仅限 §18.1 所列启动条件，不外推所有非 reasoning 模型。

**未验证：** 这个本地服务是否真的不返回 reasoning 字段，只有 live 能确认。如果返回了，流映射按普通 thinking 块处理并用 §12.5 的签名往返。

---

# 17. 阶段与验收

每一阶段结束都跑 `npm run check`（Node ≥24.12，无 `DEP0190`）。涉及 hooks 的阶段另跑 `npm run test:mod`。用户可见的改动更新 `CHANGELOG.md`。

| 阶段 | PRD 任务 | 内容 | 验收 |
| --- | --- | --- | --- |
| **P0 基线** | MP-0003（重写） | v2 特征快照：真实 picker 行、权限断言、`%2F`、连字符 provider、Cursor 预设、`[1m]`。§18 的先行验证 | 快照在未改动的代码上通过。验证结果写入本文档 §18 |
| **P1 Identity** | MP-0101–0103 | §6 | PRD §54 的测试；现有测试全部不改；唯一例外见 §20 |
| **P2 Registry** | MP-0201–0203 | §7；openspec delta | fake provider 只加一个描述符和一行事实，就能出现在 picker、worker、usage，且不改 gateway 核心 |
| **P3 Direct** | MP-0301–0304 | §8 | `gw/server.ts` 不 import `plugins/multi-*`；Zen、OpenAI 现有测试断言不变 |
| **P4 Launcher** | MP-0401–0405 | §7.4、§11；`gw/provider-usage.ts` 表驱动 | `npm run test:mod` 通过；P0 快照除明确允许的差异外不变 |
| **P5a Pi + DeepSeek** | MP-0601–0604、0606 | §9、§10、§12、§13 | §19 全部离线测试通过；启动耗时达到 §19 目标 |
| **P5b GLM** | MP-0605 | `zai`、`zai-coding-cn` | `zaiToolStream` 和 thinking 字段 fixture 通过 |
| **P5c Strata** | 新增 | §16.1 | 地址校验、未配置时不可用、非 reasoning 模型丢弃 effort 并在响应中提示一次的 fixture 通过 |
| **P6 Live** | — | `npm run test:live:pi`（**需用户批准并提供 key**） | 见下 |

**Milestone D（改写）：** DeepSeek 和 GLM 至少各有一个模型能经 Pi AI 在 Claude Code 中跑完 Claude tool loop，包括多轮工具调用、thinking 往返和用量显示。维护者持有 DeepSeek 和 GLM coding plan 两家的 key，所以两家都要通过 live 验收，不能只凭离线测试算完成。GLM 只要求 key 所属的那个端点通过 live，另一个端点仅通过离线测试，并在 CHANGELOG 中写明。Strata 单独验收，不阻塞 Milestone D，通过标准相同。

**Live 探测预算：** 按**上游调用**计数，以 gateway 记录的请求事件为准，不按场景计数。一次工具往返至少要两次上游调用（模型发出 tool_use，再带 tool_result 回来）。

| 场景 | 上游调用 |
| --- | --- |
| 纯文本 | 1 |
| 带 thinking 的单次工具往返 | ≥2 |
| 多轮工具调用（Milestone D 要求） | ≥3 |
| Agent worker | 约 3 |

- 每个 provider 上限 **10 次**上游调用。用完就停，结果记为“验收未完成”，不再追加；要追加须重新获得用户批准。
- 使用 curated 中最便宜的模型和它支持的**最低** effort（§12.4 的级别表），`max_tokens` 约 1024。256 很可能被 thinking 用完。
- 任一调用的 `stop_reason` 为 `max_tokens`，或 thinking 被截断而没有产生文本或工具调用时，该场景记为“未完成”，不算通过。
- 报告列出每个 provider 的实际调用次数、各场景结果和 usage。Cursor Fast 规则不受影响。

---

# 18. 先行验证

都是 P0 的一次性实验，结论写回本节，实验代码不进仓库。

| # | 问题 | 方法 | 失败时 |
| --- | --- | --- | --- |
| **S1** | 通过 injected fetch 喂录制的 SSE，真实 `deepseekProvider` + `openai-completions` 能否走通 `start → thinking/text/toolcall → done`，`onProviderStreamEvent` 能否看到 usage，thinking 能否往返 | 离线脚本，假 key | 这是最大的单点风险。失败则重新评估是否改走 Zen 式自译 |
| **S2** | `[1m]`、已保存选择 | `npm run test:mod`，真实 Claude 启动，无推理 | `%2F` 部分推迟（§6.3） |
| **S3** | 实际磁盘增量、`import` 耗时 | 在 scratchpad 里 `npm i --ignore-scripts`，测量 | 超预算则加 §9 的懒加载范围，不改 pin 方式 |
| **S4** | Claude Code 真实请求是否用到 `stop_sequences`、`tool_choice: any`、`tool_reference`、`cache_control`、temperature；默认发送什么 `output_config.effort` 和 `thinking` | 让 Claude Code 指向本地假上游，只捕获字段名、类型和 effort 枚举值，不记内容 | 按结果调整 §12.3 中默认拒绝的条目和 §12.4 的 effort 规则 |
| **S5** | Agent 类型名是否接受连字符和 `.` | 首批只用连字符；现有 `multi-*` 已证明连字符可用 | `.` 推迟到真正需要时 |

S1 和 S3 需要实际运行下载的 Pi 代码。它们是 P0 的一部分，批准本设计即视为批准，运行时用假 key、不联网。

### 18.1 实验结论

**S1 — 通过。** 使用 `@earendil-works/pi-ai@1.4.0` 的真实 `deepseekProvider` 和其 `openai-completions` stream 实现，在 `fetch` 选项中注入录制 SSE，假 key 仅在本地实验脚本中使用，并将 `globalThis.fetch` 替换为调用即抛错的桩；两次请求均未访问网络。第一轮观察到的事件序列：`start → thinking_start → thinking_delta → text_start → text_delta → toolcall_start → toolcall_delta → thinking_end → text_end → toolcall_end → done`。`onProviderStreamEvent` 看到了原始 usage chunk（含 `prompt_cache_hit_tokens`）；第二轮请求体中的 thinking 字段为 `reasoning_content`，且包含第一轮 reasoning 内容。离线流通与 thinking 往返判据均成立。

**S3 — 通过（记录测量值）。** 在独立忽略目录安装该精确版本；测量整个 `node_modules` 普通文件为 69,622,276 字节，包含 98 个 `package.json`（依赖包数），安装报告新增 87 个包。Node `v24.22.1`。原先 5 个独立 Node 进程只导入 `@earendil-works/pi-ai/providers/deepseek` 的结果为 31.152 ms 中位数（单次：45.402、25.496、31.152、68.037、22.550 ms），仅代表 provider 入口导入，不含懒加载的 stream 实现。补测中 5 个独立冷启动进程均导入该 provider 并调用 `stream`，计时从 import 前至收到真实 `openai-completions` 实现处理录制 SSE 后的首个 `start` 事件；含 provider 与懒加载 stream 实现及其依赖的导入、请求设置和首事件解析，但不含 Node 进程启动和首事件之后的流处理。每次均使用注入的离线 fetch、假 key，并将 `globalThis.fetch` 设为抛错桩。加载至首事件耗时中位数为 944.815 ms（单次：1006.011、3230.313、742.725、944.815、454.730 ms）。

**S2 — 通过（CLI 2.1.318，Windows；仅下述保存选择与请求标签场景，未验证其他版本、真正交互 picker 或 `%2F`）。** 隔离 user `settings.json` 保存 `multi/deepseek/deepseek-v4-pro[1m]`。在 Node 中从 `plugins/multi-core/src/launcher.ts` 提取并执行原始 `savedSelection()` 函数（设置隔离 `CLAUDE_CONFIG_DIR`），返回值精确保留 `[1m]`。真实 CLI 请求通过 loopback 假上游观察到 `/v1/messages?beta=true` 的 `model` 为 `multi/deepseek/deepseek-v4-pro`（`[1m]` 不在 model 字符串中）；仅记录 header 名称 `anthropic-beta` 中 context-1m 标识是否出现，结果为是。显式使用普通 `sonnet` 模型的对照请求中该标识为否。与假设的差异是 CLI 将上下文标签编码为 beta 标识，而不是保留在请求 model 字符串；该差异与 `savedSelection()` 保留完整选择、Claude 请求剥离标签并采用 context-1m beta 的行为一致。未推断 `%2F` 行为。

**S4 — 通过（字段观察与 effort 契约已同步；不代表 Pi 上游映射实现已验收）。** CLI 版本以 `claude --version` 和本轮实际使用的原生 exe `--version` 核实，均为 `2.1.318 (Claude Code)`，环境为 Windows。前轮 Sonnet 默认/effort/工具往返的请求模型为 `claude-sonnet-5-5`；不能由此推出 Pi 路由的默认值。在 `.agent/spikes/s2s4/` 使用 loopback 假上游、隔离 `CLAUDE_CONFIG_DIR`、假认证、清除 `MULTI_*` 环境变量并直接调用真实 CLI 路径；假上游记录器仅投影字段名、类型、枚举和路径，不保存请求内容或 header 值。审查确认前轮 CLI 自身另有正文落盘，本轮已清理 30 个会话及备份、缓存等全部非投影文件；不能把假上游无正文误称为前轮全目录无正文。本轮每次均加 `--no-session-persistence` 和 `--system-prompt-snapshot off`，结束后立即清理 CLI 仍生成的配置/备份/插件缓存，仅保留去内容化的 `observations.jsonl`，全目录正文键扫描无命中。假上游返回合法 `message_start → content_block_start/delta/stop → message_delta → message_stop` SSE，真实 CLI 每次正常结束并输出 `ok`。前轮复现的 `parse: failed` 定位到无 body 的 `/api/hello`：记录器对所有路径尝试 JSON.parse；这不是 JSON Messages 请求，也不是 `count_tokens`，不据此追溯断言所有旧 parse 失败的唯一来源。CLI 消息请求路径为 `/v1/messages?beta=true`。

| 场景 / 字段 | 是否出现 / 类型 / 枚举 |
| --- | --- |
| 默认 `stop_sequences` | 未出现 |
| 默认 `tool_choice`（是否为 `any`） | 未出现 |
| 工具往返 `tool_choice` | 未出现 |
| 默认 / 工具往返 `tool_reference` | 未出现 |
| 默认 `cache_control` | object；system 和 message content 的 `type` 为 `ephemeral` |
| 工具往返 `cache_control` | object；system、user、assistant message content 的 `type` 为 `ephemeral` |
| 默认 `temperature` | 未出现 |
| `--effort low` | `output_config.effort`: string `low` |
| `--effort medium` | `output_config.effort`: string `medium` |
| `--effort high` | `output_config.effort`: string `high` |
| `--effort xhigh` | `output_config.effort`: string `xhigh` |
| `--effort max` | `output_config.effort`: string `max` |
| 前轮无 `--effort`（Sonnet 默认） | model: string `claude-sonnet-5-5`；`output_config.effort`: string `medium`；前轮记录不足以证明其他路由的默认配置 |
| 本轮无 `--effort`、无保存 effort（Sonnet） | model: string `claude-sonnet-5-5`；`output_config.effort`: string `medium`；`thinking.type`: string `adaptive` |
| 本轮无 `--effort`、无保存 effort（DeepSeek Multi 路由） | model: string `multi/deepseek/deepseek-v4-pro`；`output_config.effort`: string `high`；`thinking.type`: string `adaptive` |
| 本轮无 `--effort`、无保存 effort（Strata Multi 路由） | model: string `multi/strata/qwen3.8-flash-next`；`output_config.effort`: string `high`；`thinking.type`: string `adaptive` |
| thinking（默认、`alwaysThinkingEnabled: false`、`MAX_THINKING_TOKENS=0`） | object；`thinking.type`: string `adaptive`，尝试的关闭方式均未改变它；本轮没有找到可用关闭开关 |
| 工具往返第一请求 | `tools`: array，length 2；各项 keys 为 `name`、`description`、`input_schema`、`defer_loading`；name 为 string |
| 工具往返第二请求 | `messages[].content[].type`: string 枚举 `text`、`tool_use`、`tool_result`；观察到实际 tool_result 往返 |

本轮对照条件：每个模型单独启动原生 `claude.exe`，参数为 `--bare --print --no-session-persistence --system-prompt-snapshot off --setting-sources "" --settings '{}' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --tools "" --model <上表对应模型>`，不带 `--effort`；每次使用全新隔离 config 和专用 project，无保存 effort，环境不继承任何 `MULTI_*`、effort、认证或代理配置，仅加入假认证、loopback 地址及禁用非必要流量设置。三次均正常退出，假 SSE 响应为 `ok`，没有生成会话 JSONL。这是直接 CLI 的请求侧观察，没有经过 Multi launcher、picker 或模型元数据注入，也未访问真实 Pi/Strata 服务；未验证非 bare 模式、其他模型、用户已保存设置或其他 CLI 版本，不能推断 `/effort auto` 的行为。

与 §12.3 假设的差异：Claude Code 确实发送嵌套 `cache_control: {type: "ephemeral"}`，但未在本地实验确认它与 Pi provider 前缀自动缓存语义完全等价；§12.3 已记录该观察与未验证边界。`stop_sequences`、`tool_choice: any`、`tool_reference`、`temperature` 在覆盖场景均未出现。与 §12.4 假设的差异：默认 effort 随实测模型而异（Sonnet 为 `medium`，本轮两个 Multi 路由为 `high`），显式 effort 各档原样发送。按用户 2026-11-05 决定统一契约：不支持的档位就近映射（等距取高）并在响应中提示一次实际档位；未声明 effort 的模型丢弃 effort 并提示一次。CLI 发来的 `medium` 与请求真正缺省 effort 是两种情况，后者仍按 §12.4 的 curated 默认规则；未将本地假上游观察当作映射/提示实现通过的证据。thinking 关闭方式未能确认，§12.4 已记录。判定：通过（本轮补齐指定 Multi 路由的干净配置对照、版本和适用边界，effort 设计及规范已同步；其他边界未验证）。

---

# 19. 测试矩阵

**主力手段：** injected `fetch` + 录制 SSE fixture，走真实的 Pi `openai-completions` 路径。这样能覆盖 `onProviderStreamEvent` 和 compat 逻辑。`fauxProvider` 只用于错误和中止事件，因为它不产生原始 chunk。全部离线，不需要 key。

| 范围 | 用例 |
| --- | --- |
| Identity | 往返恒等；旧 ID 不变；连字符、`.`、`%2F`、`%40`；`[1m]` 在编码外；Cursor 预设；`multi//x`、`multi/core/x`、大写、超长被拒绝 |
| Registry | 重复 ID、非法 ID、保留 ID、kind 与 adapter 不匹配都报错；事实表与描述符一致；fake provider 贯通 |
| Worker | 嵌套 ID 不被丢弃；Cursor 预设仍被排除；未知 worker 失败；`--agents` 预算；`multi-zai-coding-cn` 解析 |
| 目录 | `MULTI_MODELS` 只列白名单；`MULTI_PI_MODELS` 含白名单外 ID 时报错 |
| Routing | 未知 provider → BadRequest；未启用 → 明确错误；已启用 `pi` 时 `multi/deepseek/...` 通过；`multi/zai/...` 不被当成 `multi/zai-coding-cn/...` |
| 请求映射 | §12.3 每行；字节稳定；跨模型切换丢弃 thinking；deferred tools |
| 流映射 | 纯文本；thinking + 文本；并行 tool call；Agent 的 `stripWorkerModel`；非 stream 请求；块索引连续。**真实事件顺序 fixture：** `thinking_start → thinking_delta → text_start → text_delta → thinking_delta → text_delta → thinking_end → text_end`，断言 Anthropic 端同一时刻只开一个块、thinking 在 text 之后恢复时开新块、签名在块关闭时发出；`thinking_end` 改写签名时显式失败 |
| 收尾 | adapter 输出不含 `message_delta` / `message_stop`；整条流 `message_stop` 只出现一次；stop_reason 和 usage 来自 `MessagesResponse` 并由 `emitTerminal` 发送 |
| 工具参数 | `argumentsError` → 显式失败、不发 tool_use；对允许空参数的工具也一样；错误、trace、事件中不含原始参数（金丝雀字符串断言） |
| 工具别名 | 超过 64 字符的 MCP 名完成“声明 → 响应 → 历史回放 → `tool_choice`”往返；`tool_choice` 指向未声明工具 → BadRequest；别名冲突报错；响应中出现未知名称报错 |
| 环境 | 设 `PI_CACHE_RETENTION=long` 后请求字节不变（`cacheRetention: 'short'` 生效） |
| Thinking | 同模型往返保留 `reasoning_content`；异模型丢弃；切回 Claude 时被 `forAnthropic` 过滤 |
| Effort | 仅 `thinkingLevelMap` 中值为字符串的档位受支持；`null` 与缺失键按不支持处理，并按 `low < medium < high < xhigh < max` 的距离映射到最近支持档位，等距取高，映射时每个响应提示一次实际档位；无 effort 的模型丢弃请求中的 effort 并提示一次；未声明 effort 时默认 `high`（`thinking: disabled` 不发送 reasoning）；未知枚举仍报错；核对 `deepseek` 和 `zai` wire 字段 |
| Usage | 完整；无 usage → `unavailable`（**不是 0**）；显式 0 → 0；缺缓存字段；DeepSeek `prompt_cache_hit_tokens`；`choice.usage`；receipt 和 Dashboard 一致 |
| 错误 | 401 → authHelp；429 带 retry-after；500；网络错误；流中 error；`pending`/`deferred`；所有路径都不含响应体 |
| 中止 | 客户端断开 → signal 传到 Pi；只发一次上游请求 |
| 权限 | plan 拒绝；auto 带 statement；reviewer 查找不再按名 |
| 安全 | 金丝雀 key：跑完整流程后断言不出现在事件、receipt、trace、错误、`gatewayEnvironment`、harness env；单一主机；不访问 `~/.pi`；未启用时变量不被删除 |
| Strata | 非回环 `http://`、非法 URL 报错；缺地址时不出现在 picker 和 worker；回环地址无 key 时发送占位值，非回环地址无 key 时报错；启用后不读 `~/.pi/agent/models.json`；带 effort 的请求丢弃 effort 并在响应中提示一次；usage 走 §13 |
| 平台 | `takeProviderCredentials` 和 launcher 分支接受显式 `platform`，在 Linux 上覆盖 Windows 分支 |
| 性能 | 无 key 启动不加载 `pi-ai`（断言模块未被 import）；Registry 构建 < 100 ms（PRD §59） |
| 回归 | 现有全部单测；P0 快照；`npm run test:mod` |

**Live：** 新增 `npm run test:live:pi`，只在用户明确批准时运行，加入 AGENTS.md 的 Verification 表。

---

# 20. 向后兼容

**保持不变：** `multi/<p>/*` 路由；现有 worker 名；`MULTI_ZEN_MODELS`、`MULTI_MODELS`；`MULTI_ENABLED_PROVIDERS` 的格式；已保存的模型选择；receipt 现有字段。

**破坏性改动（写进 CHANGELOG）：**

1. `multi/<unknown>/...` 以前被静默发给 OpenAI，现在返回 BadRequest。这是修复，`test/unit/gateway-provider-bounded.test.ts:11` 改为断言新行为。**这是 P1 唯一允许改的既有断言。**
2. `GatewayEvent.route`、`PreparedRequest.route` 从联合类型放宽成 `string`。只影响内部类型。

**未启用 `multi-pi` 时：** 不加载 Pi，不动环境变量，picker 和 worker 与现在相同；磁盘占用是唯一差异。

---

# 21. Upstream

当前 `Usage-Correctness` 领先 `upstream/main` 21 个提交，落后 0 个。上游更新先进 `Usage-Correctness`，再合入 v2。

冲突面最大的是 `gw/server.ts`、`core/launcher.ts`、`gw/worker-catalog.ts`、`core/install/plugins.ts`。按 PRD §81 人工移植，不做机械合并。

为减小冲突：P1–P4 每个阶段单独提交并保持可运行；不做无关重排；新逻辑尽量放新文件。

---

# 22. 需要同步的文档和规格

| 位置 | 内容 |
| --- | --- |
| `openspec/specs/usage-compatibility/spec.md:53-61` | 开 delta：该条禁止补丁层引入 registry，v2 按其“可吸收”条款修改 |
| `openspec/specs/usage-accounting/spec.md` | 不改。adapter 在 provider 一侧 |
| `AGENTS.md` | 代码地图加 `multi-pi`、`provider-facts.ts`、`provider-registry.ts`、`model-identity.ts`；Orientation 加 `docs/pi.md`；执行约定加 Pi 条目；Verification 表加 `test:live:pi` |
| `ARCHITECTURE.md`、`README.md` | Provider 列表和结构 |
| `docs/pi.md`（新） | 启用、key、端点差异、模型、局限、磁盘代价、环境变量被删除的行为 |
| `docs/platform-support.md`、`docs/permissions.md`、`docs/installation.md` | 加 Pi 行 |
| `CHANGELOG.md` | `## Unreleased`；版本只通过 `npm run release` |
| PRD | §23 的修订 |

---

# 23. PRD 修订清单

批准本设计后合入 PRD。证据笔记在 gitignored 的 `.agent/` 下，不可依赖，所以结论写在这里。

| # | PRD 位置 | 修订 | 处置 |
| --- | --- | --- | --- |
| R1 | §5.1、§6、MP-0101–0103 | 分层路由语法；放宽 `[a-z]+`；MP-0102 改目标 | 本设计 §6 |
| R2 | §13、§60 | 未知 provider → BadRequest 是破坏性的 | §20 |
| R3 | §25、MP-0601、MP-0606 | 区分 `pi-ai`（内存）和 `ModelRuntime`（`auth.json`）；`!command` 风险 | §10，不读文件 |
| R4 | §23、MP-0604、§45 | **改写：** Pi Usage 把缺失写成 0；适配层用 `onProviderStreamEvent` 观察原始 chunk | §13 |
| R5 | §45、§30 | 删除独立 usage 形状，映射 Canonical；`cost` 不进入 accounting | §13 |
| R6 | §46 | 以 `Reviewer` + `AutoReviewPolicy` 为起点 | §14 |
| R7 | §31 | 补 `auto`、删“放宽审批”、重写工作区限制 | 后置（§24） |
| R8 | §12、MP-0606 | 隔离扩展到 harness 子进程；registry 驱动 | §10；Pi 原生工具部分后置 |
| R9 | §22 | `capabilities.tools` 由 curated 声明；过滤 `type` | §7.2、§12.2 |
| R10 | §23、MP-0604 | 补签名往返、停止原因、流后失败、`tool_choice`、Claude 专属块；删“推荐两种” | §12 |
| R11–R14 | §30、§32、§36、§27 | 会话路径、扩展范围和遥测、压缩计费、`close` | 后置（§24） |
| R15 | §3、§62、§64 | 完整硬编码清单；加 `npm run test:mod` | §4、§17 |
| R16 | §63、§69 | MP-0303、Milestone B 验收改写；`PreparedRequest` 作起点 | §8 |
| R17 | §41、MP-0803 | 动态加载遵守信任规则 | §9 |
| R18 | §38、§40 | `--agents` 预算；保留 `core` | §6、§11 |
| R19 | §60、§70、§80 | 统一首轮；MP-0003 重定义 | §17 |
| R20 | §37、§47 | 统一 `toolMode` 命名 | 首批只有 `claude-tools`；Harness 时处理 |
| R21 | MP-0605、§19 | 首批改为 `deepseek`、`zai`、`zai-coding-cn` | §16 |
| R22 | §26–§30 | `multi-pi` 路由语法 | 后置（§24） |
| R23 | §42、MP-0601 | 依赖位置；精确 pin | §9 |
| R24 | §79 | §79-A 改为“从 `Usage-Correctness` 开分支”；§79-B 写明未满足 | 文字修订 |
| R25 | 工作流 | openspec delta；AGENTS 代码地图 | §22 |
| R26（新） | §66、§69 Milestone D | 改为 DeepSeek + GLM，见 §17 | §17 |
| R27（新） | §42、§6–§11 文件路径 | 留在 `gw/`，不建 `providers/` | 决定 D-G |
| R28（新） | §60–§68 顺序 | Pi AI 提前到 Generic 之前 | 决定 D-B |
| R29（新） | §11 | `DirectProviderAdapter` 用 `prepare` + `PreparedRequest.open` | §8 |
| R30（新） | §21、MP-0605 | 增加 Strata：自定义 Pi provider，用 `createProvider`，不读 `models.json` | §16.1 |
| R31（新，来自设计审查） | §23、MP-0603、MP-0604 | 终止事件只由 server 发；流映射按 delta 驱动并处理 Pi 的块生命周期；`argumentsError` 显式失败；工具名别名往返复用 `gw/tools.ts`；`env: {}` 不构成隔离；严格白名单；live 预算按上游调用计数 | §10、§11、§12.2、§12.3.1、§12.6、§15、§17、§19 |

---

# 24. 后置项与重启条件

**Pi NativeHarness（MP-07xx）。** 只有在用户明确要“Pi 自己当 agent”时才启动。开工前必须先回答：

- **工作区边界（最大的未决项）。** Pi 没有沙箱，cwd 不构成限制（Pi `docs/security.md:7,16,19`）。选项是：接受并明说；只给受控工具、不开 bash；要求 OS 沙箱。这决定它能否默认启用。
- 路由语法（`multi/pi/<provider>%2F<model>`，或复用 `multi/<provider>/...` 加 worker 类型）。
- MCP 和子代理（默认与 Antigravity、Grok 一致：拒绝）。
- 配置隔离：context files、skills、extensions、`agentDir`、遥测（`enableInstallTelemetry` 默认开）。
- 自动压缩和重试的额外计费；会话路径与其中可能含有的凭据；Windows 下脱离进程的回收（未验证）。
- 依赖 23.4 MB 的 `pi-coding-agent`，并重新评估 §9 的打包方式。

**Generic API（MP-05xx）。** 当需要接 Pi 目录之外的端点时启动，例如 GLM 按量付费（§25）。

**更多 Pi provider。** 每个只需：§16 加一行、事实表加一行、一个 fixture。非 `openai-completions` API（比如 Google）要先扩展决定 D-K，核对签名和 usage 字段。带 `/` 的模型要先完成 U2。

**外部插件（MP-08xx）。** 没有现实需求，维持后置。

---

# 25. 未决事项

这些不阻塞批准，都有默认值。

| # | 问题 | 默认 | 什么时候需要你 |
| --- | --- | --- | --- |
| 1 | ~~GLM 的 key 类型~~ | **已确认：coding plan**，与 Pi 的两个端点匹配 | 不再需要 |
| 2 | ~~手上有哪家的 key~~ | **已确认：DeepSeek、GLM coding plan，另有本地 Strata 的 Qwen 3.8 NextFlash**（见第 5 项）。key 只放环境变量，不写进文档或对话 | 不再需要 |
| 3 | 是否批准 P6 的付费探测 | 不跑 | P6 开始前 |
| 4 | `Usage-Correctness` 和 v2 是否向上游提交 | 不推送、不开 PR | 由你决定 |
| 5 | ~~Strata 的模型事实~~ | **已取得**，见 §16.1 | 不再需要 |

---

# 26. 留给实现者的事

- 描述符字段的细节命名、`GatewayOptions` 的最终形状、阶段内的提交划分。
- `stream.ts` 是否抽出与 Zen 共用的块累加 helper：不强求，除非 Zen 测试不变。
- P0 快照的文件形式。
- Biome 约束下的函数拆分（认知复杂度 ≤15，不加抑制）。

实现计划放在获批之后写。

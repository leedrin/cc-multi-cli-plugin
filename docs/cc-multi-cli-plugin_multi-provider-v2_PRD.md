# cc-multi-cli-plugin Multi-Provider Architecture v2 PRD

> 项目：`greenpolo/cc-multi-cli-plugin` Fork  
> 文档类型：Architecture PRD + Technical Design  
> 建议分支：`feature/multi-provider-v2`  
> 状态：Draft v1.1  
> 日期：2026-09-30  
> 目标读者：Codex、Claude Code、项目维护者、Reviewer

修订记录：v1.1（2026-11-03），按 DD §23 合入 R1–R31；R25 为工作流条目，不涉及 PRD 正文。

---

# A. 文档定位

本 PRD 是**架构级 fork 路线**。目标是把当前固定 Provider 集成重构成 registry-driven Multi-Provider 平台，并支持 Generic API、Pi AI、Pi NativeHarness 以及未来外部 Provider 插件。

它与 Usage Patchset 分开维护：

```text
upstream/main
│
├── fix/usage-observability
│     └── Usage Correctness & Observability PRD
│
└── feature/multi-provider-v2
      └── 本 PRD
```

推荐逻辑基线：

```text
upstream/main
    +
Usage Correctness & Observability patchset
```

但 Usage patchset 是可替换的前置修复层：如果 upstream 已原生提供等价修复，则采用 upstream 实现，不保留重复 patch。

---

# B. Upstream 同步策略

本分支允许核心架构显著变化，因此不要假定长期可以无冲突 rebase。

upstream 更新时采用：

```text
upstream diff
    ↓
change classification
    ↓
selective cherry-pick / manual port
```

重点吸收：

```text
security fixes
Claude Mods compatibility
provider bug fixes
model catalog updates
native harness correctness fixes
credential/auth fixes
protocol fixes
tests
```

如果 upstream 修改的文件已经在 v2 中被拆分或重构，应按 v2 结构手工 port，而不是为了保持旧文件形态强行 merge。

---

# C. Architecture Fork Boundary

本 PRD允许重构：

```text
launcher.ts
gateway/server.ts
worker-catalog.ts
install/plugins.ts
provider discovery
provider routing
model identity
worker generation
provider usage dispatch
```

核心目标：

```text
hard-coded five providers
        ↓
registry-driven provider platform
```

---

# D. 与 Usage PRD 的责任边界

Usage PRD 负责：

```text
token accounting correctness
cache accounting
receipts
/multi-usage
Orca / terminal-host UI compatibility
usage tracing
```

本 PRD 负责：

```text
provider identity
provider registry
provider runtime
direct adapters
native harness adapters
generic API providers
Pi AI
Pi NativeHarness
dynamic worker/catalog generation
external provider plugin API
```

原则：

> 不为了 ProviderRegistry 重构 Usage UI；也不为了修 Usage UI 把 Provider core 带进维护分支。

---

# E. Integration 分支（可选）

可以维护一个可随时丢弃重建的：

```text
integration/latest
```

只用于验证：

```text
latest upstream
+
latest usage patchset
+
multi-provider v2
```

它不是长期开发主线，也不承担稳定历史。


---

# 0. 文档目标

本 PRD 将当前 `cc-multi-cli-plugin` 从：

```text
固定的 OpenAI / Zen / Cursor / Antigravity / Grok 集成
```

演进为：

```text
可注册、可发现、可扩展的 Multi-Provider Runtime
```

重点实现：

1. `ProviderRegistry`
2. `DirectProviderAdapter`
3. `ModelDescriptor`
4. `ModelIdentity`
5. `Pi AI Adapter`
6. `Pi NativeHarness`
7. Generic API Provider
8. Provider Plugin 生命周期
9. Credential isolation
10. 完整测试与迁移方案

要求最终设计可以让新 Provider 尽量做到：

```text
新增 provider package
        ↓
register(provider)
        ↓
无需修改 gateway core
```

---

---

# 1. 产品目标

## 1.1 核心目标

允许用户在同一个 Claude Code session 中：

- 使用 Claude 原生模型
- 使用 OpenAI subscription/Codex 模型
- 使用 Zen
- 使用 Cursor/Grok/Antigravity native agent
- 使用用户自己的 Provider API Key
- 使用 OpenAI-compatible endpoint
- 使用 Pi AI 支持的 Provider/model
- 使用 Pi Coding Agent native worker

并保持：

- `/model`
- `/effort`
- Agent tool
- Claude permissions
- streaming
- tool rows
- cancellation
- resume
- compaction
- usage
- session isolation

体验一致。

---

---

# 2. 非目标

本阶段不追求：

- 自动支持任何未知私有协议
- 统一所有 Provider 账单系统
- 让所有 Provider 具有相同 reasoning 语义
- 在 Native Harness 中伪装 Claude tool calls
- 绕过 Claude permission policy
- 将 API Key 暴露给 Claude child process
- 自动把所有 Pi extension 映射为 Claude tools
- 重写 Claude Code UI
- 替换现有 Claude Mods 控制面

---

---

# 3. 当前基线

当前 Provider：

```text
Direct:
  openai
  zen

Native Harness:
  cursor
  antigravity
  grok
```

当前 Provider 写死位置不止以下四处，重构必须逐项收口：

| 位置 | 硬编码内容 |
| --- | --- |
| `plugins/multi-core/src/gateway/provider.ts` | Provider 联合类型、Harness/provider 列表、auto-review 策略及未知路由回退 |
| `plugins/multi-core/src/gateway/provider-workers.ts`、`plugins/multi-core/hooks/provider.ts` | worker 类型与 Harness 判断 |
| `plugins/multi-core/src/gateway/provider-request.ts` | 事件和请求 route 联合类型 |
| `plugins/multi-core/src/gateway/provider-usage.ts` | usage provider 类型、reader 与 unavailable 映射 |
| `plugins/multi-core/src/gateway/worker-catalog.ts` | worker provider/label、路由解析和 provider 分组 |
| `plugins/multi-core/src/gateway/server.ts` | GatewayEvent route、usage readers、provider/harness/reviewer/display-tools 分派、签名前缀和路由解析 |
| `plugins/multi-core/src/launcher.ts` | Provider imports/discovery、worker runs、工具模式、picker 与子进程环境 |
| `plugins/multi-core/src/install/plugins.ts`、`plugins/multi-core/src/install/bootstrap.ts`、`plugins/multi-core/src/account.ts` | 安装、启用选择及账号插件列表 |
| `.claude-plugin/marketplace.json`、`scripts/versioning.ts` | Marketplace 条目与版本 pin |
| `plugins/multi-cursor/src/models.ts`、`plugins/multi-zen/src/chat.ts`、`plugins/multi-zen/src/request.ts`、`plugins/multi-core/hooks/worker-rows.ts` | 其他路由解析位置 |

该清单以详细设计 §4 为准；实现时必须检查其列出的全部位置，而非仅修改 launcher、server、worker catalog 和 install。

当前 Native Harness contract：

```text
plugins/multi-core/src/gateway/native-harness.ts
```

该接口继续保留，并作为 PiHarness 的基线。

---

---

# 4. 目标架构

```text
┌──────────────────────────────────────────────┐
│                 Claude Code                  │
│ /model /effort Agent tools permission Mods  │
└──────────────────────┬───────────────────────┘
                       │ Anthropic Messages
                       ▼
┌──────────────────────────────────────────────┐
│                Multi Gateway                 │
│                                              │
│ request identity / permission / usage / UI  │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│              ProviderRegistry                │
│                                              │
│ resolve(providerId, modelId)                 │
│ discover models                             │
│ auth / usage / review capability            │
└──────────────┬───────────────────┬───────────┘
               │                   │
               ▼                   ▼
      DirectProviderAdapter      NativeHarness
               │                   │
       ┌───────┼────────┐     ┌────┼────────────┐
       │       │        │     │    │            │
      Zen    Pi AI   Generic Cursor Grok   Pi Agent
                       API          Antigravity
               │
               ▼
       Actual Model Provider
```

---

---

# 5. 核心领域模型

## 5.1 ProviderId

```ts
export type ProviderId = string;
```

约束：

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

允许：

```text
openai
zen
openrouter
deepseek
google
azure-openai
local.ollama
```

不再使用：

```regex
[a-z]+
```

---

---

# 6. ModelIdentity

文件：

```text
plugins/multi-core/src/gateway/model-identity.ts
```

接口：

```ts
export interface ModelIdentity {
  providerId: ProviderId;

  /**
   * Provider-native model ID.
   *
   * May contain:
   * /
   * :
   * .
   * -
   */
  modelId: string;

  /**
   * Stable route exposed to Claude Code.
   */
  routeId: string;
}
```

路由语法：

```text
multi/<provider>/<encoded-model-id>[/<cursor-params>][[1m]]
```

`<provider>` 必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，并保留 `core`（`multi-core` 是插件名，不能作为 worker）；`<encoded-model-id>` 是 `encodeURIComponent(modelId)`。完整语法为 `multi/<provider>/<encoded-model-id>[/<cursor-params>][[1m]]`：Cursor 预设参数只用于 Cursor，保留在编码段之外；`[1m]` 也位于编码之外。`decode(encode(provider, model))` 必须恒等，反向编码不要求对带原始字符的 Cursor 预设恒等。已保存的 OpenAI、Zen、Cursor 路由解析结果保持兼容。凡解析路由的位置统一使用 `decodeModelRoute`，不得直接 `split('/')`；`byProvider` 用 `identity.preset !== undefined` 识别预设，不能以解码后的 `/` 判断。

例如：

```text
provider:
openrouter

native:
anthropic/claude-sonnet-x

route:
multi/openrouter/anthropic%2Fclaude-sonnet-x
```

实现：

```ts
export function encodeModelRoute(
  providerId: ProviderId,
  modelId: string
): string {
  return `multi/${providerId}/${encodeURIComponent(modelId)}`;
}

export function decodeModelRoute(
  routeId: string
): ModelIdentity | undefined;
```

兼容要求：

旧 ID：

```text
multi/openai/gpt-...
multi/zen/kimi-k3
```

解析结果必须保持一致。

---

---

# 7. ModelDescriptor

文件：

```text
plugins/multi-core/src/gateway/model-descriptor.ts
```

接口：

```ts
export type ModelProtocol =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'native-harness'
  | 'custom';

export interface ModelCapabilities {
  text: boolean;
  streaming?: boolean;

  images?: boolean;
  documents?: boolean;

  tools?: boolean;
  parallelToolCalls?: boolean;

  json?: boolean;
  jsonSchema?: boolean;

  reasoning?: boolean;
}

export interface ModelReasoningDescriptor {
  native?: boolean;

  /**
   * Empty / undefined means there is no externally selectable effort.
   */
  efforts?: readonly string[];
}

export interface ModelPricingDescriptor {
  currency?: string;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
}

export interface ModelDescriptor {
  identity: ModelIdentity;

  label: string;
  description?: string;

  protocol: ModelProtocol;

  contextWindow?: number;
  maxOutputTokens?: number;

  capabilities: ModelCapabilities;

  reasoning?: ModelReasoningDescriptor;
  pricing?: ModelPricingDescriptor;

  /**
   * Provider-private immutable metadata.
   * Core must not inspect provider-specific keys.
   */
  metadata?: Readonly<Record<string, unknown>>;
}
```

原则：

```text
Core only reads generic fields.
Provider-specific data remains provider-owned.
```

---

---

# 8. ProviderDescriptor

文件：

```text
plugins/multi-core/src/gateway/provider.ts
```

接口：

```ts
export type ProviderKind =
  | 'direct'
  | 'harness';

export interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

export interface ProviderDiscoveryContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  kind: ProviderKind;

  availability(
    context: ProviderDiscoveryContext
  ): Promise<ProviderAvailability>;

  discoverModels(
    context: ProviderDiscoveryContext
  ): Promise<readonly ModelDescriptor[]>;

  auth?: ProviderAuthAdapter;

  usage?: ProviderUsageReader;

  autoReview: AutoReviewPolicy;

  direct?: DirectProviderAdapter;

  createHarness?: (
    context: NativeHarnessFactoryContext
  ) => Promise<NativeHarness>;

  worker?: ProviderWorkerDescriptor;
}
```

Invariant：

```ts
provider.kind === 'direct'
  => provider.direct !== undefined

provider.kind === 'harness'
  => provider.createHarness !== undefined
```

---

---

# 9. ProviderRegistry

文件：

```text
plugins/multi-core/src/gateway/registry.ts
```

接口：

```ts
export interface ResolvedProviderModel {
  provider: ProviderDescriptor;
  model: ModelDescriptor;
}

export class ProviderRegistry {
  register(provider: ProviderDescriptor): void;

  registerMany(
    providers: readonly ProviderDescriptor[]
  ): void;

  get(
    providerId: string
  ): ProviderDescriptor | undefined;

  list(): readonly ProviderDescriptor[];

  models(): readonly ModelDescriptor[];

  resolveRoute(
    routeId: string
  ): ResolvedProviderModel | undefined;

  resolve(
    providerId: string,
    modelId: string
  ): ResolvedProviderModel | undefined;
}
```

注册时必须检查：

```text
duplicate provider id
duplicate route id
invalid provider id
invalid model identity
kind/adapter mismatch
```

---

---

# 10. Provider Runtime

Provider discovery 不应该散落在 `launcher.ts`。

新增：

```text
plugins/multi-core/src/gateway/runtime.ts
```

```ts
export interface ActiveProvider {
  descriptor: ProviderDescriptor;
  models: readonly ModelDescriptor[];
  harness?: NativeHarness;
}

export interface ProviderRuntime {
  active(): readonly ActiveProvider[];

  resolveModel(
    routeId: string
  ): ResolvedProviderModel | undefined;

  close(): Promise<void>;
}
```

Launcher：

```text
load plugin providers
      ↓
ProviderRegistry
      ↓
discover availability
      ↓
discover models
      ↓
create harness when necessary
      ↓
ProviderRuntime
```

---

---

# 11. DirectProviderAdapter

文件：

```text
plugins/multi-core/src/gateway/direct.ts
```

建议接口：

```ts
export interface DirectProviderContext {
  provider: ProviderDescriptor;
  model: ModelDescriptor;

  sessionId: string;
  workerId?: string;

  cwd: string;

  cacheKey?: string;
}

export interface DirectRequestValidation {
  estimatedInputTokens: number;
}

export interface PreparedRequest {
  label: string;
  authHelp: string;
  endpoint: string;
  route: string;
  inputTokens(): number;
  completion?: Partial<GatewayEvent>;
  requestEvent(agentId?: string): ProviderEvent;
  failureEvent(status: number, agentId?: string): ProviderEvent;
  open(signal: AbortSignal, fetchImpl: GatewayFetch): Promise<UpstreamOpen>;
}

export type UpstreamOpen =
  | { ok: false; status: number; retryAfter: string | null }
  | {
      ok: true;
      translate(
        emit: Emit | undefined,
        remember: RememberWorkerModel
      ): Promise<MessagesResponse>;
    };

export interface DirectProviderAdapter {
  prepare(input: ProviderRequestInput): PreparedRequest;
  signaturePrefixes: readonly string[];
}
```

`prepare` 生成请求描述和 provider-specific 转换；`PreparedRequest.open(signal, fetch)` 执行 transport 并返回 `UpstreamOpen`。Zen、OpenAI 的 HTTP transport 由共享 `httpUpstream` 包装。token count endpoint 可只使用 `inputTokens()`，请求转换可独立单测，transport 和 response translation 可用 fixture 分别验证。Gateway 仍负责 keepalive、事件、失败映射和最终回复。

---

---

# 12. Credential abstraction

文件：

```text
plugins/multi-core/src/gateway/credentials.ts
```

```ts
export type ProviderCredential =
  | {
      type: 'api-key';
      value: string;
    }
  | {
      type: 'bearer-token';
      value: string;
    }
  | {
      type: 'oauth';
      accessToken: string;
      expiresAt?: number;
    }
  | {
      type: 'ambient';
    };

export interface CredentialResolver {
  resolve(
    providerId: ProviderId
  ): Promise<ProviderCredential | undefined>;
}
```

规则：

1. 仅由已启用 Provider 的 registry descriptor 声明 credential env；不从模型名推断
2. Credential 不进入 model metadata、Mods payload、receipt、trace 或错误消息
3. 在创建任何子进程之前，从 `process.env` 取出并删除已启用 Provider 的凭据；仅过滤 Claude child env 不足以隔离其他 harness 子进程
4. Provider runtime dispose 后不得保留不必要 secret
5. Pi 首批凭据只从明确指定的环境变量读入内存，不读取 `auth.json` / `models.json`，不执行 `!command`

---

---

# 13. Direct Provider 的通用执行流程

`server.ts` 目标代码不再是：

```ts
if (route === 'zen') {
  return handleZen(...);
}

return handleOpenAI(...);
```

而是：

```ts
const resolved = runtime.resolveModel(externalModel);

if (!resolved) {
  // Includes unknown provider and unknown model routes; never fall back to OpenAI.
  throw new BadRequest('Unknown provider model');
}

if (resolved.provider.kind === 'direct') {
  return handleDirectProvider(
    exchange,
    resolved
  );
}

return handleNativeProvider(
  exchange,
  resolved
);
```

---

---

# 14. handleDirectProvider

新增：

```text
plugins/multi-core/src/gateway/direct-provider.ts
```

建议：

```ts
export async function handleDirectProvider(
  exchange: ProviderExchange,
  resolved: ResolvedProviderModel,
  context: DirectGatewayContext
): Promise<void> {
  const adapter = resolved.provider.direct;

  if (!adapter) {
    throw new Error('Direct provider adapter missing');
  }

  const validation = adapter.validate(
    exchange.body,
    resolved.model
  );

  if (
    exchange.url.pathname ===
    '/v1/messages/count_tokens'
  ) {
    return sendTokenEstimate(
      exchange,
      validation.estimatedInputTokens
    );
  }

  const prepared = await adapter.prepare(
    exchange.body,
    buildDirectContext(
      exchange,
      resolved
    )
  );

  const result = await adapter.execute(
    prepared,
    {
      signal: exchange.signal,
      stream: Boolean(exchange.body.stream),
      emit: exchange.body.stream
        ? exchange.emit
        : undefined,
      fetch: context.fetch,
      originalRequest: exchange.body,
      providerContext: ...
    }
  );

  sendResult(exchange, result);
}
```

---

---

# 15. 现有 Zen 迁移方案

Zen 应成为第一个迁移到新接口的 Provider。

目录：

```text
plugins/multi-zen/
  src/
    provider.ts
    models.ts
    adapter.ts
    auth.ts
    chat.ts
    responses.ts
    usage.ts
```

`provider.ts`：

```ts
export const zenProvider: ProviderDescriptor = {
  id: 'zen',
  label: 'OpenCode Zen',
  kind: 'direct',

  availability: discoverZenAvailability,

  discoverModels: discoverZenModels,

  auth: zenAuth,

  usage: zenUsageReader,

  direct: zenDirectAdapter,

  worker: {
    defaultModelId: ZEN_DEFAULT_WORKER_MODEL,
    defaultEffort: ZEN_WORKER_EFFORT,
    toolMode: 'claude-tools'
  }
};
```

迁移要求：

- 先包裹现有逻辑
- 不改 wire behavior
- 不改 auth storage
- 不改 `/model` row
- 不改 worker 名称 `multi-zen`
- 不改 usage semantics

---

---

# 16. OpenAI 迁移

OpenAI 与 Zen 都属于 Direct Provider，但认证和 review 不同。

`ProviderDescriptor` 必须允许 Provider 自己拥有：

```text
auth
review
usage
```

不允许 Core 根据 model name 推断：

```text
是不是 GPT
是不是 Codex
是不是某种 billing
```

OpenAI provider：

```ts
export const openAIProvider: ProviderDescriptor = {
  id: 'openai',
  kind: 'direct',
  ...
};
```

`Codex login` 仍保留 Provider-owned。

---

---

# 17. Generic OpenAI-compatible Provider

新增：

```text
plugins/multi-api/
```

第一版目标：

```text
OpenAI Chat Completions
OpenAI Responses
```

配置示例：

```json
{
  "providers": {
    "my-company": {
      "protocol": "openai-chat",
      "baseUrl": "https://llm.company.example/v1",
      "apiKeyEnv": "MY_COMPANY_LLM_KEY",
      "models": [
        {
          "id": "code-large",
          "label": "Company Code Large",
          "contextWindow": 131072,
          "maxOutputTokens": 32768,
          "tools": true
        }
      ]
    }
  }
}
```

安全要求：

- 禁止非 HTTP(S)
- 默认禁止 URL userinfo
- header 名 allowlist / validation
- 不允许 config 文件直接默认回显 secret
- trace 不打印 request/response body

---

---

# 18. Generic API 配置 schema

```ts
export interface GenericProviderConfig {
  id: ProviderId;
  label?: string;

  baseUrl: string;

  protocol:
    | 'openai-responses'
    | 'openai-chat';

  auth:
    | {
        type: 'env';
        env: string;
        header?: string;
        prefix?: string;
      }
    | {
        type: 'none';
      };

  headers?: Readonly<Record<string, string>>;

  models: readonly GenericModelConfig[];
}
```

Model：

```ts
export interface GenericModelConfig {
  id: string;
  label?: string;

  contextWindow?: number;
  maxOutputTokens?: number;

  images?: boolean;
  documents?: boolean;
  tools?: boolean;

  reasoning?: {
    native?: boolean;
    efforts?: readonly string[];
  };
}
```

---

---

# 19. Pi AI Adapter

## 19.1 定位

Pi AI 不暴露为：

```text
providerId = pi
```

它是：

```text
Direct Provider Runtime Backend
```

Pi AI 首批真实路由仅包括 curated 白名单中的 Provider：

| Provider | 端点 | 环境变量 | curated 模型 |
| --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | `deepseek-v4-pro`、`deepseek-flash` |
| `zai` | `https://api.z.ai/api/coding/paas/v4` | `ZAI_API_KEY` | `glm-5.3`、`glm-5.2` |
| `zai-coding-cn` | `https://open.bigmodel.cn/api/coding/paas/v4` | `ZAI_CODING_CN_API_KEY` | `glm-5.3`、`glm-5.3-flash` |

两个 GLM provider 均使用 coding plan 端点，不是通用按量付费 API；国际端点与 CN 端点分别使用各自环境变量，设置哪个就启用哪个。对应路由分别为 `multi/deepseek/deepseek-v4-pro`、`multi/zai/glm-5.3`、`multi/zai-coding-cn/glm-5.3`。首批模型由 Multi 明确维护白名单；Pi 的完整目录不因此全部暴露。Strata 是单独配置的自定义 Pi provider，见 §21，不属于 Pi 内置目录。

---

---

# 20. Pi AI package

使用：

```text
@earendil-works/pi-ai
```

Pi 当前主仓库：

```text
https://github.com/earendil-works/pi
```

Pi 文档：

```text
https://pi.dev/docs/latest/
```

---

---

# 21. PiProviderBackend

建议新增：

```text
plugins/multi-pi/src/ai/
```

结构：

```text
plugins/multi-pi/
  src/
    ai/
      backend.ts
      discovery.ts
      adapter.ts
      auth.ts
      models.ts
      capabilities.ts
      usage.ts
```

Backend 只加载 Pi 内置首批 Provider 的单独工厂（DeepSeek、Z.AI、Z.AI Coding CN），不加载 `providers/all`。Strata 不在 Pi 目录中，作为自定义 provider 通过 `createProvider` 注册，复用 `openai-completions` API，不读取 `models.json`。其 curated 模型为 `qwen3.8-flash-next`（仅文本）；只有设置 `MULTI_STRATA_BASE_URL` 才启用，地址仅接受 HTTPS 或回环 HTTP。`STRATA_API_KEY` 可选：回环服务未设 key 时传入占位值 `local`，非回环地址必须提供 key；模型目录与 key 来源由 Multi 显式维护。

接口：

```ts
export interface PiAIBackend {
  discoverProviders(): Promise<
    readonly PiProviderDescriptor[]
  >;

  discoverModels(
    providerId: string
  ): Promise<
    readonly PiModelDescriptor[]
  >;

  complete(
    request: PiAIRequest,
    signal: AbortSignal,
    observer: PiAIObserver
  ): Promise<PiAIResult>;
}
```

---

---

# 22. Pi AI → ModelDescriptor 映射

实现：

```ts
export function modelFromPi(
  providerId: string,
  model: PiModel
): ModelDescriptor;
```

映射字段：

```text
Pi provider       → providerId
Pi model id       → modelId
Pi display name   → label
context window    → contextWindow
output limit      → maxOutputTokens
vision            → capabilities.images
reasoning         → reasoning
pricing           → pricing (catalog display only; not accounting)
```

Pi 的 Model 不提供可靠的工具能力字段。`capabilities.tools` 由 Multi 维护的 curated model catalog 明确声明，不从 Pi 元数据推测。Pi backend 只暴露白名单内、`type` 为聊天类且 `api === 'openai-completions'` 的模型。

无法可靠确定的 capability：

```text
保守设为 false / undefined
```

不要推测。

---

---

# 23. Pi AI Adapter 执行模式

只实现一种模式：Pi AI 提供 transport 与事件归一化，工具执行仍由 Claude Code tool loop 负责。

```text
Claude tool schema
      ↓
Pi AI Direct adapter
      ↓
Provider model
      ↓
Pi events / result
      ↓
Multi MessagesResponse
      ↓
Claude Code executes tool
```

Adapter 不执行或模拟工具，不发送 `message_delta` / `message_stop` 等终止事件；由 server 按统一收尾路径发出。流按连续 text/thinking delta 分段生成 Anthropic 内容块，不将 Pi 的 start/end 事件一一映射；thinking 签名在块结束时发出，若 `thinking_end` 改变已发送签名则显式失败。`toolcall_end` 前缓冲工具调用；若 `argumentsError` 存在，则在发出 `tool_use` 前显式失败，错误只报告固定类别，不转发或记录 `argumentsError` 对象及其原始参数；否则再还原工具别名并一次性发送完整调用。解析失败不得发送 `tool_use`。对应 fixture 必须使用金丝雀参数，断言错误、trace 和事件均不含原始参数。回放相邻同模型 thinking 块时合并。停止原因映射为 `stop → end_turn`、`length → max_tokens`、`toolUse → tool_use`；`error`、`aborted` 走失败/中止路径，`pending`、`deferred` 显式失败。`tool_choice` 支持 auto/none、any→required、指定工具名→别名；未声明的指定工具返回 `BadRequest`。请求输入支持 user text、仅在模型声明支持 image input 时接受的 base64 image，以及映射为 Pi `toolResult` 的 `tool_result`；`document` 和其他不支持的 Claude 专有输入块返回 `BadRequest`。assistant 内容块仅支持 text、thinking、tool_use，其他专有 assistant 块显式拒绝，不静默转换。Pi 的归一化 `Usage` 会把缺失计数写为 0；usage 必须通过 `onProviderStreamEvent` 观察 Pi 处理前的原始 chunk，不得从归一化 Usage 反推缺失字段，并按 §45 映射至 Canonical usage。

---

---

# 24. Pi model discovery

Provider Registry 初始化时：

```text
Pi AI
  ↓
discover provider catalog
  ↓
filter credentials / availability
  ↓
convert ModelDescriptor
  ↓
register provider models
```

避免把所有 Pi 支持模型全部塞入 `/model`。

默认 picker 应：

```text
curated only
```

完整 catalog：

```text
--models all
```

或 Provider 专属：

```text
--<provider>-models
```

长期可以改为：

```text
multi models <provider>
```

---

---

# 25. Pi auth

Pi 支持：

- API Key
- OAuth
- auth.json
- ambient cloud credentials
- models.json/custom endpoint

第一阶段仅使用 `@earendil-works/pi-ai`（Pi AI）的 provider/model discovery；凭据只从各 Provider 明确指定的环境变量读取，在内存中传给 adapter，并保留真实 provider identity 与来源。Multi 不复制 secret，也不读取 `~/.pi/agent/auth.json`、`models.json` 或 cwd 下配置。

`@earendil-works/pi-coding-agent` 的 ModelRuntime 会读取 `auth.json`，且认证配置可含有解析时执行的 `!command`；这会引入命令执行及凭据来源不透明风险，因此 ModelRuntime、文件认证和 `!command` 不属于首批范围。

必须明确：

```text
Provider credential lifetime
Provider identity
Credential source
```

不要让:

```text
OpenRouter credential
Google credential
Anthropic credential
```

被抽象成一个不可区分的 “Pi key”。

---

---

# 26. Pi NativeHarness

**后置项：** Pi NativeHarness 不属于首批 Pi AI Direct adapter，也不作为其启用或运行前提。只有用户明确要求 Pi 自己作为 agent 后，才启动 NativeHarness 的设计与实现；安全和隔离决策见 §27–§31。其路由语法（专用 `multi/pi/<provider>%2F<model>`，或复用 `multi/<provider>/...` 并以 worker 类型区分）仍待届时决定，不是首批路由要求。

## 26.1 目标

提供：

```text
multi-pi
```

worker。

用途：

> 需要 Pi 自己的 Agent Loop / Tool / Extension / Session 时使用。

它与 Pi AI Direct Adapter 是独立功能。

---

---

# 27. PiHarness contract

**后置项：** Pi NativeHarness 只有在用户明确要求 Pi 自己作为 agent 后启动（见 §31、§69）。首批 Pi AI Direct adapter 不实现或依赖此 contract。

文件：

```text
plugins/multi-pi/src/harness/pi-harness.ts
```

```ts
export class PiHarness implements NativeHarness {
  constructor(
    models: readonly ModelDescriptor[],
    options: PiHarnessOptions
  );

  validate(
    body: MessagesRequest,
    context?: PermissionContext
  ): number;

  handle(
    body: MessagesRequest,
    scope: string,
    signal: AbortSignal,
    emit?: Emit,
    context?: PermissionContext,
    observe?: NativeProgressObserver
  ): Promise<MessagesResponse>;

  recordedResponse(
    scope: string,
    context?: PermissionContext
  ): Promise<MessagesResponse | undefined>;

  close(): Promise<void>;
}
```

`close()` 的资源释放语义、Pi session/子进程关闭顺序及失败处理均待 NativeHarness 启动前设计；不得据此假设能重置或回退 native session state。

---

---

# 28. PiHarnessOptions

```ts
export interface PiHarnessOptions {
  cwd?: string;

  stateDirectory?: string;

  createSession?: PiSessionFactory;

  checkPermissions: (
    cwd: string,
    context: PermissionContext
  ) => Promise<PiPermissionPolicy>;

  platform?: NodeJS.Platform;
}
```

---

---

# 29. Pi Agent SDK 生命周期

推荐：

```ts
import {
  createAgentSession
} from '@earendil-works/pi-coding-agent';
```

逻辑：

```text
Multi scope
   ↓
canonical cwd + Claude session + worker id
   ↓
HarnessSessionStore
   ↓
Pi session identity
   ↓
create / resume Pi AgentSession
```

Session identity 必须包含：

```text
provider
workspace
Claude session
worker
```

不得跨 workspace 复用。

---

---

# 30. Pi Native session record

该 native session record 仅属后置的 Pi NativeHarness（MP-07xx）；首批 Pi AI Direct 不创建或持久化它。NativeHarness 启动前必须确定会话文件路径、权限、生命周期和凭据风险，不得把 cwd 当作隔离边界，也不得跨 workspace 复用会话。

推荐保存：

```ts
interface PiHarnessSaved
  extends HarnessSessionBase {

  version: 1;

  piSessionId?: string;

  model?: {
    providerId: string;
    modelId: string;
  };

  usage?: CanonicalTokenUsage;
}
```

`usage` 只复用 Multi 的 Canonical token usage；不另建 Pi usage shape，目录 `pricing` / 成本估算不进入 accounting。Pi 的自动压缩、重试可能产生额外计费，计费归属与记录方式须在 NativeHarness 开工前决定。

不要把：

```text
Pi SDK object
AgentSession object
credential
tool object
```

序列化进 saved record。

---

---

# 31. Pi permission policy

这是 Pi Harness 的最高风险模块，属于后置项：只有用户明确要求 Pi 自己作为 agent 后才能启动。开工前必须决定 Pi 无沙箱时如何处理工作区边界；cwd 本身不是安全边界，选项为接受并明确说明，或要求 OS 沙箱。MCP、子代理、配置/扩展隔离、会话路径及重试/压缩计费也须先定方案。

未来实现必须显式支持 `plan`、`normal`、`auto`、`bypass`：没有 reviewer 的 `auto` 必须明确告知动作未经审查；`bypass` 不得放宽 managed deny 或 workspace policy，也不意味着批准任意 Pi 原生工具。未识别或无法可靠分类的工具一律 fail closed。下列映射只是待定约束，不是首批交付要求。

文件：

```text
plugins/multi-pi/src/harness/permissions.ts
```

```ts
export interface PiPermissionPolicy {
  mode:
    | 'plan'
    | 'normal'
    | 'auto'
    | 'bypass';

  allowedTools?: readonly string[];

  deniedTools: readonly string[];

  workspace: string;

  notice?: string;
}
```

映射原则：

## Plan

禁止：

```text
shell write edit mutation
```

允许：

```text
read
search
list
```

前提是 Pi 工具能够可靠分类。

---

## Normal / Auto

只允许 Multi 明确支持映射的工具。

不能识别的 Pi tool：

```text
fail closed
```

---

## Auto / Bypass

`auto` 在没有 provider reviewer 时运行未审查动作，必须向用户说明。`bypass` 不得放宽显式 deny 或 managed policy；工作区边界在 Pi 无沙箱的前提下尚未解决，不能声称仅靠 cwd 限制了访问范围。

---

---

# 32. Pi extension 风险

本节属于后置 Pi NativeHarness（MP-07xx），不适用于首批 Pi AI Direct adapter。Pi extension 与 Pi 进程拥有相同 OS 权限，Claude permission 无法证明控制了 extension 内部动作。

NativeHarness 启动前必须确定 extension、配置文件、context files、skills、`agentDir` 和遥测的隔离范围，并验证遥测默认行为；不能把“禁用第三方 extensions”误认为已隔离其余 Pi 配置或进程行为。第一版应默认禁用第三方 extensions，或仅加载显式 allowlist，且不能默认继承用户全部 Pi extension。是否以及如何提供 `MULTI_PI_EXTENSIONS=trusted-a,trusted-b` 由后置方案决定。

---

---

# 33. Pi tool observation

需要将 Pi agent event 转换为：

```ts
NativeObservation
```

例如：

```text
Pi read file
   ↓
NativeActionTracker
   ↓
mcp__multi-core__<native-name>
   ↓
Claude transcript display row
```

要求：

- 只观察真实完成的 Pi native action
- 不重新执行
- 不把 display row 提供给模型
- gateway-issued token
- output bounded
- arguments bounded

完全遵守现有 Cursor/Grok/Antigravity 模型。

---

---

# 34. PiHarness Response

复用：

```text
HarnessResponse
HarnessModelCalls
NativeActionTracker
```

不要创建 Pi 专有 response renderer。

---

---

# 35. Pi cancellation

Claude client disconnect：

```text
AbortSignal
   ↓
Pi AgentSession abort/cancel
   ↓
settleOrAbort
```

要求：

- 不留下 orphan shell
- 不再次执行 uncertain action
- durable state 标记 interrupted
- 下次 resume 时给出 interrupted notice

---

---

# 36. Pi compaction

本节属于后置 Pi NativeHarness（MP-07xx），不属于首批 Pi AI Direct adapter。Native state is never rewound：不得为了匹配 Claude transcript 而 rewind 或重放 Pi session。

NativeHarness 启动前须确定 Pi 自有压缩/重试导致的额外上游调用和费用如何计量，并确保不会将目录 pricing 或估算成本当作 usage accounting。若 Claude transcript 已被 compact，继续使用 Pi native record，必要时注入 history divergence notice；不得据此回退 native state。

---

---

# 37. Worker Catalog 重构

当前：

```ts
type WorkerProvider =
  'openai'
  | 'zen'
  | 'cursor'
  | 'antigravity'
  | 'grok';
```

改成动态：

```ts
export interface ProviderWorker {
  type: string;
  providerId: ProviderId;
  label: string;

  models: readonly WorkerModel[];

  defaultId: string;

  effort?: string;

  toolMode:
    | 'claude-tools'
    | 'native-mapped';
}
```

构建：

```ts
buildWorkerCatalog(
  models,
  providers
)
```

不要再遍历固定 `WORKER_PROVIDERS`。

---

---

# 38. Worker type

默认：

```text
multi-<providerId>
```

Provider ID 必须符合 `^[a-z0-9][a-z0-9._-]{0,63}$`，并保留 `core`（`multi-core` 是插件名，不能作为 provider worker）。ProviderDescriptor 可覆盖默认 worker type；注册时必须拒绝与保留或现有 worker slug 冲突。

例如：

```text
multi-openrouter
multi-deepseek
multi-pi
```

但 ProviderDescriptor 可覆盖：

```ts
worker: {
  type: 'multi-pi',
  ...
}
```

避免 slug 冲突。

---

---

# 39. Direct worker

首批 Direct provider 使用 `toolMode = 'claude-tools'`：工具由 Claude Code 执行，Pi AI Direct adapter 也沿用该模式。Native Harness 的 `toolMode = 'native-mapped'` 属于后置范围，只有完成 Native 工具映射和权限验证后才能启用。

如果：

```text
toolMode = 'claude-tools'
```

定义：

```text
Read
Grep
Glob
Bash
Edit
Write
```

Native harness：

```text
Read
Grep
Glob
Bash
Edit
Write
mcp__multi-core
```

沿用现有原则。

---

---

# 40. Launcher 重构

当前 `launcher.ts` import 所有 Provider。

目标：

```text
launcher.ts
   ↓
loadProviderPlugins()
   ↓
ProviderRegistry
   ↓
ProviderRuntime.create()
   ↓
picker
workers
usage
gateway
```

Launcher 不再包含：

```text
discoverZen
discoverGrok
discoverAntigravity
```

而变成：

```ts
const runtime =
  await createProviderRuntime({
    registry,
    cwd: process.cwd(),
    env: process.env
  });
```

动态 worker 必须受现有 `--agents` 参数预算约束：验证所有 provider 同时启用时的 worker 定义，在 Windows 8000 字符限制下不超限；超限沿用现有显式报错，不得静默裁剪。`core` 保留为不可用作 provider worker 的 ID。涉及 hooks 的阶段还必须通过 `npm run test:mod`。

---

---

# 41. Provider plugin loading

第一阶段可静态注册：

```ts
registerBuiltinProviders(registry);
```

第二阶段再支持真正第三方 provider plugin。

建议：

```text
plugins/*/src/provider.ts
```

统一导出：

```ts
export default ProviderDescriptor;
```

动态加载必须遵守信任边界：仅从已安装、受信任的插件 manifest 解析并校验入口；不得从 cwd、项目配置或任意用户路径解析/执行 Provider 代码。任何允许的导入都须落在插件自身受控目录，并遵守 core 当前安装与路径校验规则。

---

---

# 42. 目录调整方案

建议目标：

```text
plugins/
  multi-core/
    src/
      gateway/
        provider.ts
        provider-registry.ts
        runtime.ts
        model-descriptor.ts
        model-identity.ts
        direct.ts
        credentials.ts
        errors.ts

        server.ts
        direct-provider.ts
        native-provider.ts

        messages.ts
        fetch.ts
        tools.ts

        harness-session.ts
        harness-exchange.ts
        harness-response.ts
        harness-completion.ts
        harness-progress.ts
        harness-notices.ts

      workers/
        catalog.ts
        definitions.ts

      install/
        plugins.ts

  multi-openai/
    src/
      provider.ts
      adapter.ts
      auth.ts
      models.ts
      review.ts
      usage.ts

  multi-zen/
    src/
      provider.ts
      adapter.ts
      auth.ts
      models.ts
      chat.ts
      usage.ts

  multi-pi/
    src/
      provider.ts

      ai/
        backend.ts
        discovery.ts
        adapter.ts
        models.ts
        capabilities.ts
        auth.ts
        usage.ts

      harness/
        pi-harness.ts
        session.ts
        request.ts
        progress.ts
        permissions.ts
        errors.ts
        usage.ts

  multi-api/
    src/
      provider.ts
      config.ts
      adapter.ts
      models.ts
      auth.ts
```

`@earendil-works/pi-ai` 作为 core 分发依赖在仓库根 `package.json` 精确 pin（`"@earendil-works/pi-ai": "1.4.0"`），不使用范围版本；`multi-pi` 插件清单仅控制启用。首批不添加或依赖 `@earendil-works/pi-coding-agent`。

---

---

# 43. server.ts 目标职责

重构后 `server.ts` 只负责：

```text
HTTP server
authentication
request parsing
Claude passthrough
provider lookup
review dispatch
follow-up/display rows
common failure translation
```

不能继续承担：

```text
Zen request construction
OpenAI request construction
Pi API conversion
Provider URL
Provider auth header
Provider-specific model validation
```

---

---

# 44. Provider error

新增：

```ts
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      providerId: string;
      status?: number;
      retryAfter?: string;
      code?: string;
      safe?: boolean;
    }
  ) {
    super(message);
  }
}
```

Core 只读取：

```text
status
retryAfter
safe message
```

不得读取 Provider response body。

---

---

# 45. Usage contract

沿用 Multi 的 `CanonicalTokenUsage` 与现有 accounting contract，不另建 `ProviderUsage` 或 Pi 专属 usage shape。Pi adapter 通过 `onProviderStreamEvent` 观察 Pi 处理前的原始 chunk（包括 `chunk.usage` 或 `chunk.choices[0].usage`），只保留数字字段且观察器不得抛错；不从 Pi 已归一化、会把缺失字段写为 0 的 `Usage` 反推缺失值。

将原始字段映射到 Canonical：prompt（扣除缓存）→ `inputTokens`；completion → `outputTokens`；缓存命中/写入 → 对应 cache 字段；reasoning → `reasoningTokens`；total → `totalTokens`。缺少字段保持 undefined；全流无 usage 时 `source: 'unavailable'` 且不因此判请求失败。沿用现有 OpenAI usage 解析对部分缺失字段的 `source` 规则。每次 direct 请求恰好一次上游调用，`modelCalls: 1`。

`pricing` 仅用于目录展示；provider cost 和模型目录价格不进入 token accounting，Canonical 不增加 `cost` 字段。配额和账单解释仍由 Provider 自己负责，Core 不根据 model 名计算账单归属。

---

---

# 46. Review capability

以仓库现有 `Reviewer` 接口与 `AutoReviewPolicy` 为起点，不新增 `ProviderReviewCapability` 或 `NativeApprovalBridge` 抽象。Provider 描述自身的 auto-review policy；reviewer 由对应 Provider 创建并由 runtime 持有。OpenAI 的 reviewer 仍归 OpenAI 所有，其他 Provider 不得借用它。无 reviewer 的 Provider 在 `auto` 模式下不执行自动审查，必须明确告知动作未经审查；`plan` 模式仍拒绝动作。

---

---

# 47. Permission contract

ProviderDescriptor 增加：

```ts
permissions?: {
  mode:
    | 'claude-tools'
    | 'native-mapped';

  validate?(
    context: PermissionContext
  ): Promise<void>;
};
```

Direct Provider：

```text
claude-tools
```

Pi AI：

```text
claude-tools
```

Pi Agent：

```text
native-mapped
```

---

---

# 48. Provider enable/disable

当前：

```text
MULTI_ENABLED_PROVIDERS
```

继续支持。

但解析改为动态：

```text
Registry known providers
```

而不是固定 enum。

未知 provider：

```text
明确报错
```

---

---

# 49. Provider plugin manifest

可选第二阶段格式：

```json
{
  "multiProvider": {
    "id": "deepseek",
    "entry": "./src/provider.js",
    "apiVersion": 1
  }
}
```

Core load：

```text
plugin manifest
  ↓
validate
  ↓
dynamic import
  ↓
register
```

---

---

# 50. API version

Provider interface 必须带：

```ts
export const MULTI_PROVIDER_API_VERSION = 1;
```

Provider：

```ts
apiVersion: 1
```

避免未来 Core upgrade 无法判定兼容性。

---

---

# 51. 向后兼容

必须保留：

```text
multi-openai
multi-zen
multi-cursor
multi-antigravity
multi-grok
```

以及：

```text
multi/openai/*
multi/zen/*
multi/cursor/*
multi/antigravity/*
multi/grok/*
```

现有环境变量：

```text
MULTI_ZEN_MODELS
MULTI_GROK_MODELS
MULTI_CURSOR_EXTRA_MODELS
```

第一阶段继续支持。

以后可增加统一：

```text
MULTI_PROVIDER_MODELS_<PROVIDER>
```

但不能立即删除旧配置。

---

---

# 52. 测试架构

新增：

```text
test/unit/providers/
test/e2e/providers/
```

---

---

# 53. ProviderRegistry unit tests

必须覆盖：

```text
register provider
duplicate provider
invalid provider id
model route encode/decode
model id containing /
model id containing :
model id containing %
model id containing unicode
duplicate route
unknown provider
unknown model
```

---

---

# 54. ModelIdentity tests

测试：

```text
openrouter:
anthropic/claude-x

azure-openai:
deployment:gpt-x

local.ollama:
qwen2.5-coder:32b
```

round trip：

```ts
decode(
  encode(
    provider,
    model
  )
) === original
```

---

---

# 55. DirectProviderAdapter tests

Fixture：

```text
Anthropic Messages
   ↓
prepared provider request
   ↓
fake SSE
   ↓
MessagesResponse
```

覆盖：

- text
- reasoning
- tool call
- parallel tool
- stop
- usage
- cache usage
- cancellation
- malformed SSE
- provider 401
- provider 429
- provider 500
- truncated stream

---

---

# 56. Pi AI tests

不做真实付费请求作为普通 CI。

Mock：

```text
Pi AI provider catalog
Pi model catalog
Pi streaming
Pi tool call
Pi usage
```

Live opt-in：

```text
test:live:pi-ai
```

只执行 bounded request。

---

---

# 57. PiHarness tests

Unit：

```text
Pi session create
resume
busy lock
workspace isolation
permission mapping
plan mode
bypass
unknown tool refusal
action observation
cancellation
interrupted state
durable response
replay
compaction
```

E2E：

```text
multi-pi picker
multi-pi worker
native action rows
resume
cancel
```

---

---

# 58. 安全测试

必须增加：

```text
credential not in child env
credential not in trace
credential not in receipts
credential not in mod payload
credential not in error body
provider request body not logged
```

Native Harness：

```text
unknown tool fails closed
managed deny survives bypass
workspace escape denied
native MCP disabled unless explicit support
native child-agent denied by default
```

---

---

# 59. 性能目标

Provider Registry：

```text
startup overhead:
< 100 ms excluding provider network discovery
```

Provider discovery：

```text
each provider has bounded timeout
```

禁止：

```text
one offline provider blocks entire launcher indefinitely
```

Model catalog：

```text
cache allowed
stale cache must be identifiable
```

---

---

# 60. Phase 0 — Baseline / Characterization

目标：

> 在架构重构前锁定当前行为。

任务：

### MP-0001

建立现有 Provider matrix fixture。

覆盖：

```text
openai
zen
cursor
antigravity
grok
```

Acceptance：

```text
npm run check
existing tests unchanged
```

---

### MP-0002

补齐：

```text
provider routing characterization test
```

确保每个 `multi/<provider>/<model>` 只路由一次。未知 `multi/<provider>/...` 路由返回 `BadRequest`，不得回落到 OpenAI；这是相对当前行为的破坏性变更。

---

### MP-0003

建立 v2 特征快照：真实 picker 行、权限断言、`%2F`、连字符 provider、Cursor 预设和 `[1m]`。它是 P0 的先行验证，不是泛化的 public behavior snapshot；快照须在未改动代码上通过，验证结果记录在详细设计（DD）§18「先行验证」。

---

---

# 61. Phase 1 — ModelIdentity

### MP-0101

新增：

```text
plugins/multi-core/src/gateway/model-identity.ts
```

实现：

```text
ProviderId validation: ^[a-z0-9][a-z0-9._-]{0,63}$；保留 core
encodeModelRoute / decodeModelRoute
```

路由采用 `multi/<provider>/<encoded-model-id>[/<cursor-params>][[1m]]` 分层语法；模型 ID 用 `encodeURIComponent` 编码。

---

### MP-0102

所有路由解析位置统一使用 `decodeModelRoute()`，禁止直接按 `/` 拆分路由，包括 `core/launcher.ts`、`gw/server.ts`、`plugins/multi-cursor/src/models.ts`、`plugins/multi-zen/src/chat.ts`、`plugins/multi-zen/src/request.ts`、`hooks/worker-rows.ts` 与 worker catalog。`byProvider` 用 `identity.preset !== undefined` 判断 Cursor 预设，不能根据解码后模型 ID 是否含 `/` 判断。

---

### MP-0103

支持 nested model id。

Acceptance：

```text
multi/openrouter/anthropic%2Fclaude-test
```

解码后 `modelId` 为 `anthropic/claude-test`，可成为 worker model。编解码单测必须覆盖嵌套 ID；Claude Code 对 `%2F` 的端到端行为不阻塞首批里程碑，推迟到首个带 `/` 的 Provider 接入时验证。

---

---

# 62. Phase 2 — ModelDescriptor + Registry

### MP-0201

新增：

```text
model-descriptor.ts
provider.ts
registry.ts
```

---

### MP-0202

建立：

```ts
registerBuiltinProviders()
```

暂时只注册 wrapper provider。

---

### MP-0203

将：

```text
WORKER_PROVIDERS
PROVIDERS
```

固定 union 删除。

Acceptance：

```text
添加 fake provider 不修改 worker-catalog.ts
```

涉及 hooks 的改动还必须通过 `npm run test:mod`。

---

---

# 63. Phase 3 — DirectProviderAdapter

### MP-0301

增加：

```text
plugins/multi-core/src/gateway/direct.ts
plugins/multi-core/src/gateway/direct-provider.ts
```

---

### MP-0302

将 Zen 包装成：

```text
zenProvider
zenDirectAdapter
```

---

### MP-0303

`server.ts` 不再包含 Zen request construction；将现有 `PreparedRequest`（`send` + `translate`）作为演进起点，统一成 `prepare` → `PreparedRequest.open(signal, fetch)` → `UpstreamOpen`，由共用 HTTP 后端包装现有 Zen 行为。server 继续持有 keepalive、事件、失败映射和最终回复；Provider 模块不写 HTTP 回复或 terminal 事件。

验收：`plugins/multi-core/src/gateway/server.ts` 不 import `plugins/multi-*`；Zen 和 OpenAI 的既有测试断言保持不变。

---

### MP-0304

迁移 OpenAI direct adapter。

注意：

```text
OpenAI reviewer 不得一起泛化掉
```

它仍是 Provider-owned capability。

---

---

# 64. Phase 4 — Launcher / Worker 动态化

### MP-0401

实现：

```text
ProviderRuntime
```

---

### MP-0402

picker 从：

```text
hardcoded provider options
```

变成：

```text
runtime.models()
```

---

### MP-0403

worker catalog 从 ProviderDescriptor 构造。

---

### MP-0404

usage dashboard 动态注册。

---

### MP-0405

`MULTI_ENABLED_PROVIDERS` 动态验证。

Acceptance：涉及 hooks 的改动必须通过 `npm run test:mod`；P0 快照除明确允许的差异外不变。

---

---

# 65. Phase 5 — Pi AI

### MP-0601

仅添加并精确锁定 `@earendil-works/pi-ai`，用于 Direct adapter 的 provider/model discovery 与调用。首批不引入 `@earendil-works/pi-coding-agent` / ModelRuntime，不读 Pi `auth.json`、`models.json` 或执行其中的 `!command`；凭据从明确列出的 Provider 环境变量读取。

---

### MP-0602

实现：

```text
Pi AI provider discovery
```

---

### MP-0603

实现 Pi model → `ModelDescriptor`，只暴露 curated 白名单中的聊天模型，且仅接受 `api === 'openai-completions'`。工具能力由 Multi 的 curated catalog 明确声明，不从 Pi 元数据推测；白名单外模型不因 `MULTI_MODELS` 或 `MULTI_PI_MODELS` 而加入。

---

### MP-0604

实现 Pi AI `DirectProviderAdapter`，由 Pi 提供 transport/event normalization，Claude Code 保留 tool loop。除 text、stream、reasoning、tool use、usage、abort 外，还必须：以 delta 类型管理 Anthropic block 生命周期并在结束时发 thinking signature；做签名往返及模型身份校验；映射 stop reason；缓冲 tool call、校验 `argumentsError`，并复用 `gw/tools.ts` 的 `toolName`、`callId`、`originalToolNames` 完成工具声明、历史回放、指定 `tool_choice` 和响应原名的别名往返；实现 `tool_choice` 映射与未声明工具拒绝；拒绝不支持的 Claude block 和 `pending`/`deferred` stopReason；流后错误走失败路径。Pi 的归一化 `Usage` 会把缺失计数写为 0，必须通过 `onProviderStreamEvent` 观察 Pi 处理前的原始 chunk，并按 §45 映射到 Canonical usage，不得从归一化 Usage 反推缺失字段。请求输入接受 user text、仅当模型声明支持 image input 时接受的 base64 image，以及映射为 Pi `toolResult` 的 `tool_result`；`document` 和其他不支持的 Claude 专有输入块返回 `BadRequest`。assistant 内容块仅支持 text、thinking、tool_use，其他专有 assistant 块显式拒绝。Adapter 返回 `MessagesResponse`，不发送 message terminal 事件；只由 server 统一收尾。由于 `env: {}` 不隔离 Pi 对 `process.env` 的回退，必须显式设置 `cacheRetention: 'short'` 并测试环境变量不能改变请求。

---

### MP-0605

接入首批 Pi 内置 Provider：`deepseek`、`zai`、`zai-coding-cn`，对应端点、环境变量和 curated 模型见 §19.1。只加载这三个 Pi provider 工厂，不加载 `providers/all`。

另接入自定义 Strata provider：通过 `createProvider` 与 `openai-completions` API，不读取 Pi `models.json`；使用 `MULTI_STRATA_BASE_URL`，地址和凭据约束见 §21。Strata 单独验收，不作为首批 Pi 内置目录的一员，也不阻塞 Milestone D。

---

### MP-0606

实现由 registry descriptor 驱动的 Pi credential integration：只读取已启用 Provider 明确声明的环境变量，将凭据仅传入 adapter 内存，并在任何子进程创建前从 `process.env` 删除这些凭据，保护 Claude 与其他 harness 子进程环境。未启用的 Provider 凭据保持原样。不读取 `auth.json` / `models.json`，不执行 `!command`。

Acceptance：凭据不进入 Claude 或其他 harness 子进程 env、model metadata、Mod payload、receipt、trace、错误消息；环境回退不能改变请求。Pi NativeHarness 原生工具相关隔离是后置，不属于此阶段。

---

---

# 66. Phase 6 — Generic API Provider

### MP-0501

新增：

```text
plugins/multi-api
```

---

### MP-0502

实现 config parser + JSON schema。

---

### MP-0503

实现：

```text
OpenAI Chat Completions
```

---

### MP-0504

实现：

```text
OpenAI Responses
```

---

### MP-0505

增加用户配置 command：

```text
/multi-api:connect
```

或者：

```text
/multi-core:provider add
```

第二种更利于长期统一。

---

---

# 67. Phase 7 — Pi NativeHarness

### MP-0701

新增：

```text
PiHarness
```

先实现：

```text
text only
no tools
```

验证 session 生命周期。

---

### MP-0702

接：

```text
HarnessSessionStore
ExchangeRegistry
HarnessResponse
```

---

### MP-0703

实现 Pi native tool observation。

---

### MP-0704

实现 permission mapping。

优先：

```text
plan
bypass
explicit deny
workspace
```

---

### MP-0705

实现 cancellation / interrupted resume。

---

### MP-0706

实现 display rows。

---

### MP-0707

限制 Pi extensions。

默认：

```text
off
```

或 trusted allowlist。

---

---

# 68. Phase 8 — External Provider Plugin API

在前面稳定后再做。

### MP-0801

定义：

```text
Multi Provider API v1
```

---

### MP-0802

plugin manifest。

---

### MP-0803

动态 import ProviderDescriptor 时，只允许从 core 自身目录内的固定相对路径加载；不得从 cwd、项目配置或任意用户路径解析。未来的外部插件 API 属于后置范围，不能放宽当前受控路径边界。

---

### MP-0804

写：

```text
provider-authoring.md
```

提供最小示例：

```text
multi-example
```

---

---

# 69. 推荐 Milestone

## Milestone A

```text
Provider Registry
ModelIdentity
ModelDescriptor
```

完成标准：

> 新增 fake provider 不修改 gateway core。

---

## Milestone B

```text
DirectProviderAdapter
Zen migration
OpenAI migration
```

完成标准：

> `plugins/multi-core/src/gateway/server.ts` 不 import `plugins/multi-*`；Zen 和 OpenAI 现有测试断言不变。迁移从现有 `PreparedRequest` 的 `send` + `translate` 边界演进为 `prepare` → `PreparedRequest.open(signal, fetch)` → `UpstreamOpen`，HTTP 后端复用共用包装；gateway 仍负责 keepalive、事件、失败映射及最终回复。

---

## Milestone C

```text
Generic API
```

完成标准：

> 用户可配置一个 OpenAI-compatible API key provider，并进入 `/model`。

---

## Milestone D

```text
Pi AI: DeepSeek + GLM
```

完成标准：

> DeepSeek 和 GLM 至少各有一个模型可通过 Pi AI 在 Claude Code 中完成多轮 Claude tool loop、thinking 往返及用量显示。维护者持有两家的 coding plan key，两家都必须通过经批准的 live 验收；GLM 只要求 key 所属端点通过 live，另一个端点以离线测试验收并在 CHANGELOG 说明。Strata 单独验收，不阻塞本里程碑。Live 每个 provider 最多 10 次上游调用，按上游调用计数；耗尽即记为“验收未完成”，增加预算须重新获用户批准。

---

## Milestone E

```text
Pi NativeHarness
```

完成标准：

> `multi-pi` 可以执行 Agent task，并安全显示 Pi native actions。

---

---

# 70. 推荐首轮 Codex / Claude Code 工作包

不要一次让 Agent 实现全部功能。

第一轮只做：

```text
MP-0001
MP-0002
MP-0003
MP-0101
MP-0102
MP-0103
MP-0201
MP-0202
MP-0203
```

也就是：

> **只完成 Provider Registry 基础重构，不接任何新 Provider。**

这样风险最低。

---

---

# 71. 可直接交给 Codex / Claude Code 的第一轮任务描述

```text
Repository:
greenpolo/cc-multi-cli-plugin fork

Goal:
Refactor the current provider identity and provider catalog code so that new
providers can be registered without adding them to hard-coded provider unions.

Do NOT add a new external provider yet.

Requirements:

1. Preserve all existing behavior for:
   - openai
   - zen
   - cursor
   - antigravity
   - grok

2. Add:
   plugins/multi-core/src/gateway/model-identity.ts
   plugins/multi-core/src/gateway/model-descriptor.ts
   plugins/multi-core/src/gateway/provider.ts
   plugins/multi-core/src/gateway/registry.ts

3. Replace hard-coded provider parsing in worker-catalog with ModelIdentity
   helpers.

4. Model IDs must support nested provider-native IDs such as:
   anthropic/claude-test

5. Route IDs should be stable and reversible:
   multi/<provider>/<encoded-model-id>

6. Existing route IDs such as:
   multi/openai/gpt-...
   multi/zen/kimi-k3
   must continue to work unchanged.

7. Remove fixed provider unions where they are only used for registration /
   catalog grouping. Do not alter permission semantics or native harness
   execution yet.

8. Add unit tests for:
   - encode/decode
   - nested model IDs
   - invalid provider IDs
   - duplicate registration
   - unknown provider
   - unknown model
   - existing five providers

9. Run:
   npm run check

Constraints:

- Do not modify Claude Mods behavior.
- Do not change provider credentials.
- Do not change review ownership.
- Do not change worker permission behavior.
- Do not change native harness state.
- Do not introduce a second UI channel.
- Never infer provider ownership from model display labels.
```

---

---

# 72. 第二轮任务

完成第一轮并稳定后：

```text
Goal:
Introduce DirectProviderAdapter and migrate Zen without behavioral changes.
```

范围：

```text
MP-0301
MP-0302
MP-0303
```

明确禁止同时：

```text
接 Pi
接 OpenRouter
改 OpenAI reviewer
```

避免重构和新功能混在一个 PR。

---

---

# 73. 第三轮任务

```text
Generic OpenAI-compatible Provider
```

用于验证：

```text
ProviderRegistry
DirectProviderAdapter
credential isolation
dynamic picker
worker
```

都真正可用。

---

---

# 74. 第四轮任务

再引入：

```text
@earendil-works/pi-ai
```

原因：

如果直接在 Provider Registry 尚未稳定前接 Pi，会导致：

```text
Pi compatibility problem
+
Multi architecture refactor
```

难以区分 bug 来源。

---

---

# 75. Reviewer checklist

每个 Provider PR 必须回答：

```text
Who owns credentials?
Who owns model catalog?
Who owns session state?
Who executes tools?
Who enforces permissions?
Who owns automatic review?
How is cancellation propagated?
How is usage reported?
How is workspace identity isolated?
What happens after process crash?
Are uncertain actions ever replayed?
```

任何答案不明确：

```text
PR 不应合并。
```

---

---

# 76. Definition of Done

## Provider Registry

```text
[ ] no hard-coded provider enumeration in worker catalog
[ ] nested model IDs work
[ ] existing IDs remain compatible
[ ] registry duplicate checks
[ ] tests pass
```

## Direct Provider

```text
[ ] provider-specific request conversion outside server.ts
[ ] provider-specific auth outside core
[ ] provider-specific usage outside core
[ ] streaming normalized
[ ] cancellation propagated
```

## Pi AI

```text
[ ] real provider identity preserved
[ ] Pi is runtime, not fake provider namespace
[ ] model capabilities conservatively mapped
[ ] Claude tools remain execution owner
[ ] API credentials isolated
```

## Pi NativeHarness

```text
[ ] NativeHarness contract
[ ] workspace isolation
[ ] permission mapping
[ ] cancellation
[ ] native action rows
[ ] replay safety
[ ] interrupted resume
[ ] extension loading restricted
```

---

---

# 77. 最终推荐

本项目的二次开发不应定义为：

> “给 cc-multi-cli-plugin 多加几个模型。”

更合理的目标是：

> **将其演进为 Claude Code 的通用 Model / Agent Provider Runtime。**

技术路线：

```text
Step 1
Provider Identity + Registry

Step 2
DirectProviderAdapter

Step 3
Generic OpenAI-compatible provider

Step 4
Pi AI runtime

Step 5
Pi NativeHarness

Step 6
External Provider Plugin API
```

其中：

```text
Pi AI
```

解决的是：

> 大规模模型 Provider 兼容与维护成本。

而：

```text
Pi Coding Agent
```

解决的是：

> 第三方 Agent Harness 与 Claude Code 协作。

二者应分别实现，不应混成一个 `multi-pi` API Provider。

---

---

# 78. 参考资料

## cc-multi-cli-plugin

- https://github.com/greenpolo/cc-multi-cli-plugin
- `ARCHITECTURE.md`
- `AGENTS.md`
- `plugins/multi-core/src/launcher.ts`
- `plugins/multi-core/src/gateway/server.ts`
- `plugins/multi-core/src/gateway/native-harness.ts`
- `plugins/multi-core/src/gateway/worker-catalog.ts`
- `plugins/multi-core/src/install/plugins.ts`
- `plugins/multi-zen/src/*`
- `plugins/multi-grok/src/harness.ts`
- `plugins/multi-antigravity/src/harness.ts`

## Pi

- https://pi.dev/docs/latest/
- https://pi.dev/docs/latest/sdk
- https://pi.dev/docs/latest/providers
- https://pi.dev/docs/latest/models
- https://pi.dev/docs/latest/custom-provider
- https://pi.dev/docs/latest/cli-integration
- https://pi.dev/changelog/2026/5/7/pi-has-a-new-home
- https://github.com/earendil-works/pi

---

---

# 79. Multi-Provider v2 前置条件

开始 Provider core 大规模重构前，至少满足以下任一条件：

```text
A. 从 Usage-Correctness 开分支，并将该 patchset 纳入 feature/multi-provider-v2
```

或：

```text
B. upstream 已提供等价的 Usage / Cache accounting 修复（当前尚未满足，须先核实并记录）
```

原因是 DirectProviderAdapter、Generic API Provider、Pi AI 都需要可信的 Usage / Receipt 观测面进行验证。

但 ProviderRegistry、ModelDescriptor、DirectProviderAdapter 不得依赖具体 `/multi-usage` Pane 实现。

---

# 80. 独立实施顺序

本 PRD 的实施顺序从 Provider 架构开始：

```text
Phase M0
Architecture Baseline / Characterization
    ↓
Phase M1
ModelIdentity
    ↓
Phase M2
ModelDescriptor + ProviderRegistry
    ↓
Phase M3
DirectProviderAdapter
    ↓
Phase M4
Dynamic Launcher / Worker
    ↓
Phase M5
Generic API Provider
    ↓
Phase M6
Pi AI
    ↓
Phase M7
Pi NativeHarness
    ↓
Phase M8
External Provider Plugin API
```

首轮仍建议只执行：

```text
MP-0001
MP-0002
MP-0003
MP-0101
MP-0102
MP-0103
MP-0201
MP-0202
MP-0203
```

首轮禁止同时加入：

```text
Pi
OpenRouter
DeepSeek
Generic Provider
OpenAI reviewer redesign
Usage UI redesign
```

目标是先建立稳定的：

```text
ModelIdentity
+
ModelDescriptor
+
ProviderRegistry
```

然后再迁移 DirectProviderAdapter。

---

# 81. Upstream Port Checklist

每次同步 upstream 时，对变更逐项判断：

```text
[ ] 是否是 security fix？
[ ] 是否改变 Claude Mods API / behavior？
[ ] 是否改变 provider auth？
[ ] 是否改变 upstream request/response protocol？
[ ] 是否改变 native harness session/replay semantics？
[ ] 是否改变 permission enforcement？
[ ] 是否只是 model catalog 更新？
[ ] 是否与 v2 已删除/拆分的旧代码重叠？
[ ] 应 cherry-pick、manual port，还是无需吸收？
```

对 `server.ts / launcher.ts / worker-catalog.ts / install/plugins.ts` 的 upstream commit 默认进入 manual review，而不是自动 merge。

---

# 82. Multi-Provider v2 Definition of Done

```text
[ ] Provider core 不再依赖固定五 Provider union
[ ] nested provider-native model IDs 可逆
[ ] existing route IDs 保持兼容
[ ] ProviderRegistry 可注册 fake/new provider
[ ] duplicate provider/model/route 有明确错误
[ ] worker catalog 从 registry/runtime 生成
[ ] launcher 从 provider runtime 生成 picker/workers/usage readers
[ ] server 不再承担 provider-specific request building
[ ] DirectProviderAdapter 有统一协议
[ ] Generic API Provider 可配置
[ ] Pi AI 保留真实 provider identity
[ ] Pi NativeHarness 复用 NativeHarness contract
[ ] credentials / permissions / session isolation 不回归
[ ] provider reviewer ownership 不串用
[ ] cancellation / replay / interrupted semantics 有测试
[ ] upstream security / harness fixes 有明确 port 流程
```

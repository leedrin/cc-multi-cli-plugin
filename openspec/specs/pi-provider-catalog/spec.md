# pi-provider-catalog Specification

## Purpose
规定经 Pi AI 接入的 provider 和模型：哪些 provider 和模型可用、如何筛选、effort 如何校验，以及维护者本地 Strata 服务的接入条件。

## Requirements

### Requirement: 首批 Pi provider 和模型
`multi-pi` 启用后，系统 SHALL 提供以下 provider 和模型，前提是对应密钥存在：`deepseek`（`deepseek-v4-pro`、`deepseek-flash`）、`zai`（`glm-5.3`、`glm-5.2`）、`zai-coding-cn`（`glm-5.3`、`glm-5.3-flash`）。来自 Pi 目录的模型 SHALL 是聊天类且使用 `openai-completions` API。白名单中的 ID 在锁定的 Pi 版本中不存在时，单测 SHALL 失败。

#### Scenario: DeepSeek 路由
- **WHEN** 已启用 `pi` 并设置 `DEEPSEEK_API_KEY`
- **THEN** picker 中 SHALL 出现 `multi/deepseek/deepseek-v4-pro` 和 `multi/deepseek/deepseek-flash`

#### Scenario: 白名单 ID 与 Pi 版本不符
- **WHEN** 白名单中有一个 ID 在锁定的 Pi 目录中不存在
- **THEN** 单测 SHALL 失败

### Requirement: 严格白名单
上述白名单 SHALL 是 Pi provider 可以使用的全部模型。`MULTI_MODELS` 的全目录模式对 Pi provider SHALL 只列白名单中的模型。`MULTI_PI_MODELS` SHALL 只能在白名单内缩小范围，含白名单外的 ID 时 SHALL 报错。

#### Scenario: MULTI_MODELS 不扩大
- **WHEN** 设置了 `MULTI_MODELS`
- **THEN** Pi provider 的 picker 行 SHALL 仍只有白名单中的模型

#### Scenario: MULTI_PI_MODELS 含白名单外 ID
- **WHEN** `MULTI_PI_MODELS` 包含不在白名单中的模型 ID
- **THEN** 启动 SHALL 报错并指出该 ID

### Requirement: effort 就近映射与无 effort 模型的处理
请求带 `output_config.effort` 时，系统 SHALL 仅将模型 thinking 级别表中值为字符串的档位视为支持档位；null 和缺失键 SHALL 视为不支持。已支持的档位 SHALL 原样采用；不支持的档位 SHALL 按 `low < medium < high < xhigh < max` 的序号距离就近映射到支持档位，距离相等 SHALL 取较高的一档，MUST NOT 因该档位不支持而拒绝请求或将其原样透传。映射后 SHALL 在该请求的响应中提示一次实际使用的档位，流式与非流式 SHALL 一致且不得按块重复。未声明 effort 的模型（如 Strata）SHALL 直接丢弃请求中的 effort，不向上游发送 reasoning effort，并在响应中提示一次已忽略 effort。curated reasoning 模型 SHALL 声明非空支持集合及受支持的默认 effort。

#### Scenario: 缺失的级别
- **WHEN** 对 `deepseek-v4-pro` 请求 effort `xhigh`，该模型支持 `high`、`max`
- **THEN** 系统 SHALL 映射为 `max`（等距取高），上游使用对应 reasoning 设置，响应提示一次实际档位 `max`

#### Scenario: medium 不被支持
- **WHEN** 对任一首批 reasoning 模型请求 effort `medium`
- **THEN** 系统 SHALL 映射为 `high`，并在响应中提示一次实际档位 `high`

#### Scenario: CLI 默认 medium 被映射
- **WHEN** Claude Code 的请求携带默认 `output_config.effort: "medium"`，目标为 `deepseek-v4-pro`
- **THEN** 系统 SHALL 将该字段视为存在，映射为 `high` 并在响应中提示一次实际档位 `high`，不得将其视为缺省字段

#### Scenario: Strata 丢弃 effort
- **WHEN** 对未声明 effort 的 `qwen3.8-flash-next` 请求携带 effort `high`（无论由 CLI 默认还是显式选择产生）
- **THEN** 系统 SHALL 丢弃 effort，上游请求不含 reasoning effort，响应提示一次已忽略 effort

#### Scenario: 支持的级别
- **WHEN** 对 `glm-5.3` 请求 effort `low`
- **THEN** 上游请求 SHALL 带上对应的 reasoning 设置，不产生映射提示

### Requirement: 未指定 effort 时的默认值
对声明了 effort 的模型，请求没有 `output_config.effort` 时：若 `thinking.type` 为 `disabled`，SHALL 不发送 reasoning 设置；否则 SHALL 使用该模型在白名单中声明的默认 effort（首批 reasoning 模型为 `high`），不让 Pi 默认关闭 thinking。未声明 effort 的模型 SHALL 始终不发送 reasoning effort；字段缺省时不产生忽略提示。

#### Scenario: 默认开启 thinking
- **WHEN** 对 `deepseek-v4-pro` 的请求没有 effort，也没有关闭 thinking
- **THEN** 上游请求 SHALL 使用 effort `high`

#### Scenario: 显式关闭 thinking
- **WHEN** 请求的 `thinking.type` 为 `disabled`
- **THEN** 上游请求 SHALL 不带 reasoning 设置

### Requirement: Strata 只在配置地址后启用
Strata provider SHALL 只在设置了 `MULTI_STRATA_BASE_URL` 时启用。该地址 SHALL 是 `https://` 地址，或回环地址的 `http://`，否则启动时报错。未设置时，Strata SHALL 不出现在 picker 和 worker 中。Multi MUST NOT 从 Pi 的 `models.json` 读取 Strata 的配置。

#### Scenario: 非回环的 http 地址
- **WHEN** `MULTI_STRATA_BASE_URL` 为 `http://192.168.1.5:8080/v1`
- **THEN** 启动 SHALL 报错

#### Scenario: 未配置地址
- **WHEN** 未设置 `MULTI_STRATA_BASE_URL`
- **THEN** picker 和 worker 中 SHALL 没有 Strata

### Requirement: Strata 的密钥
`STRATA_API_KEY` 对 Strata 是可选的。地址为回环地址且未设置密钥时，SHALL 发送占位值 `local`。地址不是回环地址且未设置密钥时，启动 SHALL 报错。

#### Scenario: 本地服务无密钥
- **WHEN** 地址为 `http://127.0.0.1:8080/v1`，未设置 `STRATA_API_KEY`
- **THEN** Strata SHALL 可用，请求使用占位密钥 `local`

#### Scenario: 远程地址无密钥
- **WHEN** 地址为 `https://strata.example/v1`，未设置 `STRATA_API_KEY`
- **THEN** 启动 SHALL 报错

### Requirement: Strata 模型
Strata SHALL 提供模型 `qwen3.8-flash-next`（路由 `multi/strata/qwen3.8-flash-next`）：仅文本输入，上下文 196608，最大输出 32768，不支持 reasoning。它的请求 SHALL 不发送 developer 角色和 reasoning effort，最大输出字段 SHALL 为 `max_tokens`。

#### Scenario: Strata 请求格式
- **WHEN** 向 Strata 发送请求
- **THEN** 请求 SHALL 使用 `max_tokens`，且不含 `reasoning_effort` 和 developer 角色消息

#### Scenario: Strata 收到图片
- **WHEN** 发给 Strata 的请求含图片
- **THEN** 系统 SHALL 返回 BadRequest

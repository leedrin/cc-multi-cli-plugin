# provider-credentials Specification

## Purpose
规定 Direct provider（首批为 Pi provider）的密钥从哪里读、读出后如何不泄漏给 Claude、Bash 和其他子进程，以及 Multi 不触碰 Pi 自己的配置文件。

## Requirements

### Requirement: 只从环境变量读取凭据
Pi provider 的凭据 SHALL 按以下顺序取得：环境变量（`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`ZAI_CODING_CN_API_KEY`、`STRATA_API_KEY`、`MULTI_STRATA_BASE_URL`）中非空的值优先；没有时才取 Pi 配置。Multi MUST NOT 读取当前目录下的 `auth.json`，MUST NOT 依赖 `pi-coding-agent`，MUST NOT 执行 Pi 配置中的任何命令。

#### Scenario: Pi 文件存在
- **WHEN** 用户的 Pi 配置 `auth.json` 中有 DeepSeek 的 key，环境变量中没有，且 Pi 配置开关未关闭
- **THEN** DeepSeek SHALL 可用，并使用 `auth.json` 中的 key

#### Scenario: 环境变量优先
- **WHEN** 环境变量 `DEEPSEEK_API_KEY` 与 `auth.json` 中的 DeepSeek key 不同
- **THEN** 请求 SHALL 使用环境变量中的值

#### Scenario: 当前目录的 auth.json
- **WHEN** 启动目录下有 `auth.json`
- **THEN** Multi SHALL 不读取它

### Requirement: 读取后从进程环境中删除
launcher SHALL 在创建任何子进程之前读取已启用插件的凭据，并从 `process.env` 中删除这些变量。密钥只在内存中传给 provider。未启用 `multi-pi` 时，这些变量 SHALL 原样保留。

#### Scenario: 子进程拿不到密钥
- **WHEN** 已启用 `multi-pi` 并设置了 `DEEPSEEK_API_KEY`
- **THEN** Claude 子进程、会话中的 Bash，以及 Cursor、Antigravity、Grok 的子进程环境中 SHALL 都没有这个变量

#### Scenario: 未启用时不动环境
- **WHEN** 未启用 `multi-pi`
- **THEN** `DEEPSEEK_API_KEY` SHALL 保留在环境中

### Requirement: 密钥不进入任何输出
密钥 MUST NOT 出现在 gateway 事件、receipt、trace、错误消息、agent 定义参数或模型描述符元数据中。

#### Scenario: 金丝雀密钥
- **WHEN** 用一个金丝雀密钥跑完一次完整请求（含失败路径）
- **THEN** 所有事件、receipt、trace、错误消息和子进程环境中 SHALL 都找不到该字符串

### Requirement: 可用性只看密钥是否存在
provider 是否可用 SHALL 只看密钥是否非空，启动时 MUST NOT 发出网络请求。无效的密钥在第一次调用时表现为上游 401，并附带认证帮助。

#### Scenario: 无效密钥
- **WHEN** 设置了无效的 `DEEPSEEK_API_KEY`
- **THEN** 启动 SHALL 不访问网络；第一次请求 SHALL 返回 401 与认证帮助

### Requirement: 环境变量不能改变请求
调用 Pi 时 SHALL 显式传入密钥，并对 Pi 会从 `process.env` 回退读取、且影响请求的配置显式赋值（首批为缓存保留策略）。因此进程环境中的这类变量 MUST NOT 改变发往上游的请求。

#### Scenario: PI_CACHE_RETENTION
- **WHEN** 进程环境设置了 `PI_CACHE_RETENTION=long`
- **THEN** 发往上游的请求 SHALL 与未设置时完全一致

### Requirement: 单一上游主机
一次 Pi provider 请求 SHALL 只访问该 provider 的 base URL 所在主机，SHALL 拒绝跟随跳转，MUST NOT 产生遥测或其他外发请求。启动时 MUST NOT 刷新 Pi 的模型目录，也 MUST NOT 从当前工作目录加载代码。

#### Scenario: 跳转
- **WHEN** 上游返回跳转到其他主机
- **THEN** 请求 SHALL 失败，凭据 SHALL 不被发往其他主机

#### Scenario: 主机记录
- **WHEN** 用记录 fetch 的 fixture 跑完一次请求
- **THEN** 记录中 SHALL 只有 base URL 的主机

### Requirement: Pi 配置开关与目录
Multi SHALL 默认读取 Pi 配置。`MULTI_PI_CONFIG=0` 时 MUST NOT 访问任何 Pi 文件。配置目录 SHALL 为 `PI_CODING_AGENT_DIR`（设置且非空时），否则为用户主目录下的 `.pi/agent`。未启用 `multi-pi` 时 MUST NOT 访问 Pi 文件。

#### Scenario: 关闭开关
- **WHEN** 设置 `MULTI_PI_CONFIG=0`，且 Pi 配置中有密钥
- **THEN** Multi SHALL 不打开任何 Pi 文件，行为与没有 Pi 配置时一致

#### Scenario: 目录覆盖
- **WHEN** `PI_CODING_AGENT_DIR` 指向另一个目录
- **THEN** Multi SHALL 只读取该目录下的 `auth.json` 和 `models.json`

#### Scenario: 未启用 multi-pi
- **WHEN** 未启用 `multi-pi`
- **THEN** Multi SHALL 不访问 Pi 文件，也不加载 Pi 后端

### Requirement: Pi 配置到 provider 的映射
`auth.json` 中以 `deepseek`、`zai`、`zai-coding-cn` 为键、`type` 为 `api_key` 的条目 SHALL 提供该 provider 的 key。`models.json` 的 `providers` 条目 SHALL 按 `baseUrl` 归属：与某个内置 provider 的上游地址（协议、主机、路径）一致时，归属该 provider；名为 `strata` 的条目归属 Strata。其他条目 SHALL 被忽略。

#### Scenario: 自定义名字按地址归属
- **WHEN** `models.json` 有一个名为 `glm-coding` 的条目，`baseUrl` 为 `https://open.bigmodel.cn/api/coding/paas/v4`，并带有 `apiKey`
- **THEN** 该 `apiKey` SHALL 成为 `zai-coding-cn` 的 key

#### Scenario: 不相关条目
- **WHEN** `models.json` 有一个 `baseUrl` 不属于任何 Pi provider 的条目
- **THEN** Multi SHALL 忽略它，不报错

#### Scenario: Strata 地址
- **WHEN** 未设置 `MULTI_STRATA_BASE_URL`，`models.json` 的 `strata` 条目有 `baseUrl`
- **THEN** Strata SHALL 启用，并使用该地址；地址校验规则与 `MULTI_STRATA_BASE_URL` 相同

#### Scenario: Strata 地址被环境变量覆盖
- **WHEN** 同时设置了 `MULTI_STRATA_BASE_URL` 和 `strata.baseUrl`
- **THEN** Strata SHALL 使用 `MULTI_STRATA_BASE_URL`

### Requirement: 歧义时报错
同一个 provider 在 Pi 配置中有多个取值不同的候选时，启动 SHALL 失败，错误信息 SHALL 写明 provider ID，MUST NOT 包含密钥。取值相同的多个候选 SHALL 视为一个。环境变量已提供该值时 SHALL 不检查歧义。

#### Scenario: 两个不同的 key
- **WHEN** `auth.json` 的 `zai-coding-cn` 条目和 `models.json` 中按地址归属 `zai-coding-cn` 的条目 key 不同，且未设置 `ZAI_CODING_CN_API_KEY`
- **THEN** 启动 SHALL 失败，错误信息指出 `zai-coding-cn` 有多个 Pi 配置凭据

#### Scenario: 环境变量消除歧义
- **WHEN** 同样的歧义存在，但设置了 `ZAI_CODING_CN_API_KEY`
- **THEN** 启动 SHALL 成功，并使用环境变量中的值

### Requirement: apiKey 写法
Pi 配置中的 `key`、`apiKey` 值 SHALL 按以下规则解析：以 `!` 开头时启动失败，MUST NOT 执行；值与启动环境中某个非空环境变量同名时，取该变量的值；否则按字面值使用。错误信息 MUST NOT 包含原值。

#### Scenario: 命令写法
- **WHEN** `auth.json` 的 DeepSeek `key` 为 `!cat secret.txt`
- **THEN** 启动 SHALL 失败并说明不支持命令写法，且不启动任何子进程

#### Scenario: 引用环境变量
- **WHEN** `apiKey` 为 `MY_GLM_KEY`，环境中 `MY_GLM_KEY` 非空
- **THEN** provider SHALL 使用 `MY_GLM_KEY` 的值

### Requirement: 引用的环境变量同样清除
被 Pi 配置引用并实际采用的环境变量 SHALL 与 provider 的密钥变量一样，在创建任何子进程之前从 `process.env` 中删除，Windows 上不区分大小写。

#### Scenario: 子进程拿不到引用变量
- **WHEN** `apiKey` 引用了 `MY_GLM_KEY` 并被采用
- **THEN** Claude 子进程、会话中的 Bash，以及其他 provider 的子进程环境中 SHALL 都没有 `MY_GLM_KEY`

### Requirement: Pi 文件缺失与格式错误
Pi 配置目录或其中某个文件不存在时，Multi SHALL 跳过它，不报错。文件存在但不是合法 JSON，或结构不符合预期时，启动 SHALL 失败，错误信息 SHALL 写明是哪个文件，MUST NOT 包含文件内容、密钥或 URL 中的用户信息和查询参数。

#### Scenario: 没有 Pi 安装
- **WHEN** Pi 配置目录不存在
- **THEN** 启动 SHALL 成功，行为与关闭开关时一致

#### Scenario: JSON 损坏
- **WHEN** `models.json` 不是合法 JSON
- **THEN** 启动 SHALL 失败，错误信息只写明 `models.json` 无法解析

#### Scenario: 金丝雀密钥不泄漏
- **WHEN** Pi 配置中放入金丝雀密钥，跑完一次请求（含失败路径）
- **THEN** 所有事件、receipt、trace、错误消息和子进程环境中 SHALL 都找不到该字符串

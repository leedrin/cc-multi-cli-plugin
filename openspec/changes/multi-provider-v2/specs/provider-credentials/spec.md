## Purpose

规定 Direct provider（首批为 Pi provider）的密钥从哪里读、读出后如何不泄漏给 Claude、Bash 和其他子进程，以及 Multi 不触碰 Pi 自己的配置文件。

## ADDED Requirements

### Requirement: 只从环境变量读取凭据
Pi provider 的密钥 SHALL 只从环境变量读取：`DEEPSEEK_API_KEY`、`ZAI_API_KEY`、`ZAI_CODING_CN_API_KEY`、`STRATA_API_KEY`。Multi MUST NOT 读取或执行 `~/.pi/agent/auth.json`、`~/.pi/agent/models.json`，或当前目录下的 `auth.json`，MUST NOT 依赖 `pi-coding-agent`。

#### Scenario: Pi 文件存在
- **WHEN** 用户的 `~/.pi/agent/auth.json` 中有 DeepSeek 的 key，但环境变量中没有
- **THEN** DeepSeek SHALL 不可用，且 Multi 不访问该文件

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

# Design

## Context

动机见 proposal.md 的 Why，要求见 `specs/provider-credentials/spec.md`。现状如下：

- `launcher.ts` 的 `main()` 一开始调用 `takeProviderCredentials(env, descriptors, { platform })`。它把每个 provider 的 `credentialEnv` 从 `env`（默认就是 `process.env`）中取出并删除，得到 `Map<环境变量名, 值>`。这个 Map 在内存中传给 `runLauncherProbes` 和 `discoverLaunchProviders`。
- `discoverLaunchProviders` 从这个 Map 拼出 `piKeys`，并把 `env.MULTI_STRATA_BASE_URL` 原样作为 `strataBaseUrl` 返回。`validatePiModelSelection` 和 Pi descriptor 的可用性检查也直接读 `env.MULTI_STRATA_BASE_URL` / `context.env.MULTI_STRATA_BASE_URL`。`discoveryContext` 只为 `descriptor.credentialEnv` 叠加凭据。
- `plugins/multi-pi/src/providers.ts` 只依赖 `provider-facts.ts`，不加载 `pi-ai`。各 provider 的上游地址只在 `pi-ai` 里。
- `test/unit/native-pi-backend.test.ts` 目前断言 Pi 后端不打开 `~/.pi/agent` 下的文件。

## Goals / Non-Goals

**Goals:**

- 读取、映射、校验全部放在一个纯函数模块里。文件系统、home 目录和平台都通过参数注入，Linux 上就能测到 Windows 分支。
- launcher 只多一步：环境变量取完之后，用 Pi 配置补齐缺失的值。之后的数据流（Map → `piKeys`，`strataBaseUrl`）保持原样。
- 关闭开关或未启用 `multi-pi` 时，代码路径与现在完全相同：不调用 `fs`，也不 import `pi-ai`。

**Non-Goals:**

- 不支持 Pi 的 OAuth 条目、`!命令` 求值、`headers`、自定义 `models` 列表，也不支持 Multi 之外的 provider（例如 `minimax`）。
- 不监听文件变化。Pi 配置只在启动时读一次，修改后需要重启 `claude-multi`。
- 不写 Pi 文件，也不在 Multi 状态目录中缓存 Pi 配置中的任何值。

## Decisions

### D1 新模块 `plugins/multi-pi/src/pi-config.ts`

导出 `readPiConfigCredentials(input)`：

- 输入：`env`、`platform`、`homedir`、`readFile`（默认 `fs.readFileSync`，文件不存在时返回 `undefined`）、需要补齐的环境变量名集合（即 `env` 和已取出的 Map 中都没有非空值的那些）。
- 输出：`{ credentials: Map<环境变量名, 值>, strataBaseUrl?: string, consumedEnv: string[] }`。

它只 import `node:fs`、`node:path` 和 `providers.ts` 中的 spec 表。

- 备选：放在 multi-core 中。不采用：Pi 的文件格式和映射规则属于 Pi provider 的知识，AGENTS.md 要求 provider 认证留在 provider 目录中。
- 备选：复用 `pi-coding-agent` 的 AuthStorage。不采用：会引入依赖，还可能执行 `!命令`，规范不允许。

### D2 上游地址表写在模块里，用测试和 `pi-ai` 对齐

为了不加载 `pi-ai`，模块内置 `deepseek`、`zai`、`zai-coding-cn` 三个上游地址，只比较协议、主机和路径（忽略末尾的 `/`、大小写主机名）。另写一个单元测试 import `pi-ai`，断言这张表与 `pi-ai` 的 baseUrl 一致，`pi-ai` 升级后改了地址就会被测试发现。

- 备选：运行时从 `pi-ai` 读。不采用：违反“关闭时不加载 `pi-ai`”。

### D3 候选收集与歧义

每个 provider 的候选按以下顺序收集：

1. `auth.json[providerId]`，要求 `type === 'api_key'`。
2. `models.json.providers` 中 `baseUrl` 归属该 provider 的条目，取 `apiKey`。
3. Strata 只看名为 `strata` 的条目，取 `apiKey` 和 `baseUrl`。

候选值先按 D4 解析，再去重。去重后多于一个就抛错，错误信息只含 provider ID 和来源文件名。环境变量已提供的 provider 不收集候选，所以用户可以用环境变量消除歧义。

- 备选：按来源定优先级（auth.json 先）。不采用：用户选择了“报错”，静默选一个容易让用户用错密钥。

### D4 值解析

解析规则如下：

- 先 `trim`，空串视为没有。
- 以 `!` 开头时抛错，不执行。
- 与 `env` 中某个非空变量同名（Windows 上不区分大小写）时，取该变量的值，并把变量名记入 `consumedEnv`。
- 其他情况按字面值使用。

Pi 本身也按这个顺序解析（先查环境变量，再当字面值），所以同一份配置在 Pi 和 Multi 中含义一致。解析结果仍然要经过 `validatedPiKey`。

### D5 launcher 合并点

在 `main()` 中 `takeProviderCredentials` 之后：

- 只有启用的 descriptor 中包含 Pi provider，且 `env.MULTI_PI_CONFIG !== '0'` 时，才调用 `readPiConfigCredentials`。
- 结果中的密钥写入 credentials Map，仅限缺失的键。
- `consumedEnv` 中的变量从 `env` 删除，用 `withoutProviderCredentials` 的同一套大小写规则。
- 解析出的 Strata 地址只在 `env.MULTI_STRATA_BASE_URL` 为空时生效。生效时构造一份浅拷贝 `discoveryEnv = { ...env, MULTI_STRATA_BASE_URL: url }`，只传给 `runLauncherProbes`、`discoverLaunchProviders`，不写回 `process.env`。

这样 `validatePiModelSelection`、descriptor 可用性和 `strataBaseUrl` 都不用改。

- 备选：给每个函数新增 `strataBaseUrl` 参数。不采用：要改的签名多，而且容易漏掉某个读 env 的点。
- 备选：直接写 `process.env.MULTI_STRATA_BASE_URL`。不采用：地址会进入 Claude 子进程和 Bash 环境。地址不是密钥，但规范要求不改子进程环境。

### D6 错误信息

所有抛出的错误统一用 `Pi config: <文件名>: <原因>` 的格式。原因只能是固定文案，例如：

- 无法解析
- 结构不符
- 不支持命令写法
- `<providerId>` 有多个不同的凭据
- Strata 地址无效

不拼接原值、路径中的用户名以外的内容或 JSON 解析器的原始消息（原始消息可能带出文件片段）。Strata 地址无效时复用 `validatedStrataUrl` 的错误，它已经做了脱敏。

## Risks / Trade-offs

- [用户本以为会用环境变量中的密钥，实际用了 Pi 中的旧密钥] → 只有环境变量未设置时才用 Pi。`multi status` 和启动提示中注明“凭据来源：Pi 配置”，只写来源，不写值。
- [字面值恰好与某个环境变量同名，被误解析为引用] → 与 Pi 的语义一致，属于可接受的歧义；文档中说明这一点。
- [Pi 的文件格式将来变化] → 结构校验只检查用到的字段，多余字段忽略；格式不符时报错并给出 `MULTI_PI_CONFIG=0` 的提示，不会静默用错。
- [内置地址表与 `pi-ai` 脱节] → D2 的对齐测试。
- [`PI_CODING_AGENT_DIR` 指向攻击者可写的目录] → 与环境变量本身同一信任级别。Multi 只读 JSON，不执行任何内容。

## Migration Plan

- 默认开启。已经设置环境变量的用户行为不变。只用 Pi 配置的用户升级后，无需额外设置就能看到 DeepSeek/GLM/Strata。
- 回滚：设置 `MULTI_PI_CONFIG=0`，或安装上一个版本。
- 用户的 `models.json` 中 `strata.baseUrl` 若是失效的端口（例如本机实际端口为 47831，配置中写的是 8080），设置 `MULTI_STRATA_BASE_URL` 即可覆盖。安装文档中写明这一点。

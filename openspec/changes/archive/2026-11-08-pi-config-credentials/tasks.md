# Tasks

## 1. Pi 配置读取模块

- [x] 1.1 新建 `plugins/multi-pi/src/pi-config.ts`，导出 `readPiConfigCredentials`（D1）：注入 `env`、`platform`、`homedir`、`readFile`；目录取 `PI_CODING_AGENT_DIR`，否则取 `<home>/.pi/agent`；文件不存在时跳过。模块只 import `node:fs`、`node:path` 和 `providers.ts`。新增 `test/unit/pi-config.test.ts` 覆盖以下情况，测试通过即完成：目录覆盖、目录或文件缺失、不读启动目录下的 `auth.json`。
- [x] 1.2 实现映射（D2、D3）：
  - `auth.json` 中 `type: api_key` 的条目按 provider ID 取 key。
  - `models.json` providers 按 `baseUrl` 的协议、主机、路径归属 `deepseek`、`zai`、`zai-coding-cn`。
  - `strata` 条目取 `apiKey` 和 `baseUrl`。
  - 不相关的条目忽略。

  测试覆盖：`glm-coding` 自定义名字归属 `zai-coding-cn`、`minimax` 被忽略、地址末尾带 `/` 也能匹配、OAuth 条目被忽略。另加一个对齐测试，断言内置地址表与 `pi-ai` 的 baseUrl 一致。测试通过即完成。
- [x] 1.3 实现值解析与歧义（D3、D4）：
  - `!` 开头时报错，并断言没有创建子进程（注入的 spawn 桩未被调用，或不 import `child_process`）。
  - 环境变量名引用：取值，并记入 `consumedEnv`；Windows 上不区分大小写，通过 `platform` 参数测试。
  - 其他按字面值使用。
  - 同值去重；不同值报错，错误信息含 provider ID。

  测试通过即完成。
- [x] 1.4 实现错误脱敏（D6）：
  - JSON 损坏、结构不符、Strata 地址无效时，错误信息只含文件名和固定原因。
  - 用金丝雀密钥和带用户信息、查询参数的 URL 断言错误信息中不出现它们。

  测试通过即完成。

## 2. launcher 接入

- [x] 2.1 在 `plugins/multi-core/src/launcher.ts` 的 `main()` 中，`takeProviderCredentials` 之后接入（D5）：
  - 只有启用了 Pi provider 且 `MULTI_PI_CONFIG !== '0'` 时才读取。
  - 只补齐空缺的键，不覆盖环境变量已提供的值。
  - 删除 `consumedEnv` 中的变量。
  - Strata 地址只放进 `discoveryEnv` 浅拷贝，不写回 `process.env`。

  在 launcher 单元测试中断言以下情况后完成：
  - 环境变量优先。
  - 只有 Pi 配置时，DeepSeek 出现在 `availableProviderIds` 中。
  - `MULTI_STRATA_BASE_URL` 优先于 `strata.baseUrl`。
  - 引用的变量从 env 中删除。
  - 歧义报错，但设置环境变量后启动成功。
  - `process.env` 中没有 Strata 地址。
- [x] 2.2 开关与懒加载：
  - `MULTI_PI_CONFIG=0` 或未启用 `multi-pi` 时，注入的 `readFile` 调用次数为 0。
  - 没有任何 Pi 凭据时，`pi-ai` 不被加载，沿用现有懒加载测试的手段。

  测试通过即完成。
- [x] 2.3 调整 `test/unit/native-pi-backend.test.ts` 中“不读 Pi 文件”的断言：改为断言 `pi-ai` 后端本身仍不打开 Pi 文件，只有 launcher 在开关打开时读取。`npm test` 通过即完成。
- [x] 2.4 金丝雀泄漏检查：Pi 配置中放入金丝雀密钥，跑一次成功请求和一次失败请求（离线 fake upstream）。断言以下位置中都没有金丝雀：事件、receipt、trace、错误消息、Claude 子进程 env、Bash env。测试通过即完成。
- [x] 2.5 启动提示注明哪些凭据来自 Pi 配置（只列 provider 和目录），不显示值。测试断言输出含来源、不含金丝雀后完成。（`multi status` 由安装器提供、拿不到启动凭据，不在本次范围内。）

## 3. 规定与文档

- [x] 3.1 更新以下文件中关于 Pi 文件的旧规定，改为“环境变量优先，其次 Pi 配置；`MULTI_PI_CONFIG=0` 关闭”。`grep -rn "local Pi files\|不读取.*Pi\|MUST NOT 读取" AGENTS.md docs/` 不再命中旧说法即完成。
  - AGENTS.md 执行契约
  - docs/pi.md 第 23、87 行附近
  - `docs/cc-multi-cli-plugin_multi-provider-v2_detailed-design.md` 中的相关段落
- [x] 3.2 更新 `docs/installation-multi-provider-v2.md` 第 1、5 节：
  - 新增“从 Pi 配置读取”小节，写明映射表、优先级、开关、`PI_CODING_AGENT_DIR`、`!命令` 不支持、修改后需重启。
  - 写明 `strata.baseUrl` 端口与实际不符时用 `MULTI_STRATA_BASE_URL` 覆盖。
  - 排错表增加歧义、格式错误两行。

  文档中的命令可按原样执行、且不含任何密钥即完成。
- [x] 3.3 在 `CHANGELOG.md` 新增 `## Unreleased`（放在 0.4.1-pi.1 之上），写一条用户可见变更。`npm run check:versions` 通过即完成。

## 4. 集成验证

- [x] 4.1 运行 `npm run check`：唯一允许的失败是已知的 Windows EUNSAFEARG 用例（`test/unit/native-cursor-settings.test.ts:213`），且没有 `DEP0190` 警告。
- [x] 4.2 用户批准后做一次有界的 live 验证：不设置任何密钥环境变量，只靠 `~/.pi/agent` 运行 `npm run test:live:pi`（≤10 次上游调用）。报告为 passed，且输出中没有密钥。
  - 实际做法改为手动验证（2026-11-08）：`test/live/native-pi.ts` 只从 `DEEPSEEK_API_KEY` 取密钥、不经过 launcher，验证不到本功能。改为：
    - 用已安装的 0.4.1-pi.2 缓存离线调用 `applyPiConfigCredentials`，在去掉全部密钥环境变量后读取真实 `~/.pi/agent`，得到 deepseek、zai-coding-cn、strata 的凭据和 Strata 地址；`MULTI_PI_CONFIG=0` 时一个都不读；输出不含密钥。
    - 用户不设密钥环境变量启动 `claude-multi`，DeepSeek、GLM、Strata 子代理均成功返回（Strata 需在 `claude-multi` 之前启动）。

## Workflow follow-up

- 实施完成后，用 openspec-solo-archive（或 `/opsx:archive`）归档，并把 delta spec 同步到 `openspec/specs/provider-credentials/spec.md`。
- 归档后再发版，例如 `npm run release -- 0.4.1-pi.2`，并按安装文档重新做本地升级（含重跑 setup）。

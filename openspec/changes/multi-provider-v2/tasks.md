# Tasks

阶段与 DD §17 一一对应（DD = `docs/cc-multi-cli-plugin_multi-provider-v2_detailed-design.md`）。每组结束都跑 `npm run check`（Node ≥24.12，无 `DEP0190`），并单独提交。涉及 `hooks/` 的组另跑 `npm run test:mod`。路径缩写同 design.md。

## 1. P0 基线与先行验证（MP-0003、DD §18）

- [x] 1.1 MP-0003：新增特征快照测试 `test/unit/native-provider-snapshot.test.ts`，覆盖真实 picker 行、权限断言、`%2F` 编码、连字符 provider、Cursor 预设和 `[1m]`；在未改动的代码上运行 `npm test` 通过
- [x] 1.2 S1：在 scratchpad 用假 key 和录制的 SSE，通过 injected fetch 离线跑真实 `deepseekProvider` + `openai-completions`，确认 `start → thinking/text/toolcall → done`、`onProviderStreamEvent` 可见 usage、thinking 可往返；结论写入 DD §18。失败则停止第 6–9 组并重新评估（实验代码不进仓库，不联网）
- [x] 1.3 S2：运行 `npm run test:mod` 并做一次无推理的真实 Claude 启动，确认 `[1m]` 与已保存选择的行为；结论写入 DD §18
- [x] 1.4 S3：在 scratchpad 里 `npm i --ignore-scripts @earendil-works/pi-ai@1.4.0`，测量磁盘增量和 `import` 耗时；结论写入 DD §18
- [x] 1.5 S4：让 Claude Code 指向本地假上游，只记录字段名、类型和 effort 枚举值（不记内容），确认 `stop_sequences`、`tool_choice`、`tool_reference`、`cache_control`、temperature、默认 `output_config.effort` 和 `thinking`；必要时调整 DD §12.3/§12.4，结论写入 DD §18
- [x] 1.6 按 DD §23 修订 PRD，确认每条修订都有对应位置；`npm run check` 通过

## 2. P1 ModelIdentity（MP-0101–0103、DD §6）

- [x] 2.1 MP-0101：新增 `gw/model-identity.ts`（`encodeModelRoute`、`decodeModelRoute`），新增 `test/unit/native-model-identity.test.ts` 覆盖往返恒等、旧 ID 不变、连字符、`.`、`%2F`、`%40`、`[1m]` 在编码外、Cursor 预设，以及 `multi//x`、`multi/core/x`、大写、超长被拒绝
- [x] 2.2 MP-0102：把 `core/launcher.ts:780`、`gw/server.ts:1361`、`plugins/multi-cursor/src/models.ts:111`、`plugins/multi-zen/src/chat.ts:183`、`plugins/multi-zen/src/request.ts:36`、`hooks/worker-rows.ts:46` 改用 `decodeModelRoute`；`grep -n "split('/')"` 在这些文件中不再命中路由解析；`npm run test:mod` 通过
- [x] 2.3 MP-0103：`gw/worker-catalog.ts` 的 `parseProviderModel` 放宽 `[a-z]+`、`byProvider` 不再用 `includes('/')` 丢弃嵌套 ID；扩展 `native-worker-catalog.test.ts`：嵌套 ID 保留、Cursor 预设仍排除、`multi-zai-coding-cn` 可解析
- [x] 2.4 `providerRoute` 对未知 provider 改为 BadRequest，未启用 provider 返回明确错误；只修改 `test/unit/gateway-provider-bounded.test.ts:11` 一处既有断言；第 1 组快照除此之外不变
- [x] 2.5 `GatewayEvent.route`、`PreparedRequest.route` 放宽为 `string`；`CHANGELOG.md` 的 `## Unreleased` 写入两条破坏性改动（DD §20）

## 3. P2 ProviderRegistry（MP-0201–0203、DD §7）

- [x] 3.1 MP-0201：新增 host-free 的 `gw/provider-facts.ts`（`PROVIDER_FACTS`），`hooks/provider.ts` 与 `gw/provider-workers.ts` 改为读取它；断言 `hooks/` 不 import `src/` 的宿主模块，`npm run test:mod` 通过
- [x] 3.2 MP-0202：新增 `gw/provider-registry.ts`（`ProviderDescriptor`、注册校验、`ProviderRuntime`）；新增 `test/unit/native-provider-registry.test.ts` 覆盖重复 ID、非法 ID、保留 ID、kind 与 adapter 不匹配报错，事实表与描述符一致，构建 < 100 ms
- [x] 3.3 MP-0203：OpenAI、Zen、Cursor、Antigravity、Grok 各在 `src/provider.ts` 提供描述符（auto-review 策略、签名前缀、worker 信息）；`gw/provider.ts` 的 `PROVIDERS`、`PROVIDER_AUTO_REVIEW` 和 `gw/server.ts:76` 的 `FOREIGN_SIGNATURE_PREFIXES` 改由 Registry 汇总；`native-verdicts`、`native-reviewer-discovery` 测试断言不变
- [ ] 3.4 fake provider 测试：只加一个描述符和一行事实，就出现在 picker、worker 和 usage 中，且未修改 gateway 核心文件
- [x] 3.5 插件启用按插件 ID 判断（`core/install/plugins.ts`、`core/install/bootstrap.ts`、`core/account.ts:66`）；扩展 `native-install.test.ts`
- [ ] 3.6 更新 `AGENTS.md` 代码地图（`provider-facts.ts`、`provider-registry.ts`、`model-identity.ts`）与 `ARCHITECTURE.md` 的 provider 结构；`npm run check` 通过

## 4. P3 Direct 执行契约（MP-0301–0304、DD §8）

- [x] 4.1 MP-0301：`gw/provider-request.ts` 新增 `UpstreamOpen` 与 `PreparedRequest.open(signal, fetch)`，以及 `httpUpstream` 包装；新增单测覆盖成功、非 2xx 返回 `{ok:false}`、网络错误
- [x] 4.2 MP-0302：`handleHosted` 重命名为 `handleDirect`，只经 `open` 打开上游；只有 server 发送终止事件（`emitTerminal`），adapter 输出不含 `message_delta`/`message_stop`；单测断言整条流 `message_stop` 只出现一次
- [x] 4.3 MP-0303：Zen 与 OpenAI 改为实现 `DirectProviderAdapter{prepare, signaturePrefixes}`；`native-zen-*`、`native-openai-*` 测试断言不变
- [ ] 4.4 MP-0304：准备失败返回 BadRequest 且无上游请求；客户端断开时 signal 传到上游且只发一次请求；`gw/server.ts` 不 import `plugins/multi-*`（加一条 import 断言测试）
- [ ] 4.5 更新 `ARCHITECTURE.md` 的 Direct 执行说明；`npm run check` 通过

## 5. P4 Launcher、worker 与 usage 表驱动（MP-0401–0405、DD §7.4、§11）

- [ ] 5.1 MP-0401：`registerBuiltinProviders()` 静态注册内置描述符；launcher 发现流程遍历 `registry.list()` 并过滤已启用插件；`native-launcher.test.ts` 通过
- [ ] 5.2 MP-0402：`GatewayOptions` 改为接收 `runtime`，删除 `zen`、`cursor`、`antigravity`、`grok`、`reviewers`、`displayTools`、`usageReaders`；`ProviderRuntime.close()` 沿用 `Closable`；`native-gateway*` 测试通过
- [ ] 5.3 MP-0403：`WORKER_RUNS`、`direct`、`pickerSettings`、`gatewayEnvironment` 改为由 Registry 派生；每个 route provider 一个 worker；Agent 定义 ≤8000 的 `--agents` 预算测试通过
- [ ] 5.4 MP-0404：`gw/provider-usage.ts` 的 `UsageProvider`、`providers`、`unavailable` 改为表驱动；`native-provider-usage.test.ts` 断言不变
- [x] 5.5 MP-0405：`.claude-plugin/marketplace.json` 与 `scripts/versioning.ts` 支持新增插件条目；`npm run check:versions` 通过
- [ ] 5.6 第 1 组快照除明确允许的差异外不变；usage 相关既有测试断言未修改；`npm run check` 与 `npm run test:mod` 通过

## 6. P5a multi-pi 插件与 DeepSeek（MP-0601–0604、0606、DD §9–§13）

- [ ] 6.1 MP-0601：在根 `package.json` 精确 pin `@earendil-works/pi-ai@1.4.0`；新建 `plugins/multi-pi/`（插件清单、`src/provider.ts` 描述符，不 import `pi-ai`）；`npm ci` 与 `npm run check:versions` 通过
- [ ] 6.2 MP-0606：`gw/` 新增 `takeProviderCredentials(env, descriptors)`，接受显式 `platform`；在创建子进程之前调用并删除 `process.env` 上的条目；单测覆盖只读环境变量、读取后删除、未启用时不删除、不访问 `~/.pi`、Windows 分支
- [ ] 6.3 `src/catalog.ts`：首批 DeepSeek 模型的严格白名单，只放行 `openai-completions`；`MULTI_PI_MODELS` 含白名单外 ID 时报错；支持的 effort 与默认 effort（null 级别、缺失键就近映射到支持档位，按 low < medium < high < xhigh < max、等距取高，响应提示一次实际档位；缺省 `high`，`thinking: disabled`）；单测通过
- [ ] 6.4 `src/backend.ts`：懒加载（代码旁注明 AGENTS.md 直接 import 规则的例外理由），只 import `providers/deepseek`；显式 `cacheRetention: 'short'`、`maxRetries: 0`、`redirect: 'error'`、单一上游主机；`open` 等待首个事件。单测：无 key 启动未 import `pi-ai`，`PI_CACHE_RETENTION=long` 时请求字节不变
- [ ] 6.5 MP-0602：`src/messages.ts` 与 `src/signature.ts`：请求转换（DD §12.3 每行）、`max_tokens` 范围、`tool_choice`、工具名别名复用 `gw/tools.ts`、`multipi:v1:` 签名往返与相邻 thinking 合并、BadRequest 路径、字节稳定；单测覆盖 spec `pi-message-translation` 的请求侧场景
- [ ] 6.6 MP-0603：`src/stream.ts`：按 delta 生成块、签名在关闭时发出、`thinking_end` 改写签名时失败、工具调用完整后才发出并 `stripWorkerModel`、`argumentsError` 显式失败（金丝雀断言）、停止原因映射、未支持签名字段失败、错误不含响应体；用真实事件顺序 fixture 离线通过
- [ ] 6.7 MP-0604：`src/usage.ts` 从原始 chunk 构建 canonical usage（`prompt_cache_hit_tokens`、`choices[0].usage`、无 usage → `unavailable`、显式 0 → 0），不使用 Pi 的 usage 和 cost；receipt 与 `/multi-usage` 一致，配额行显示 unavailable 和原因
- [ ] 6.8 `src/gateway-request.ts` 接入 Direct 契约；count_tokens 返回带估算标记的本地值且不加载 Pi；权限测试：plan 拒绝、auto 带 statement `no auto mode: actions run unreviewed`
- [ ] 6.9 安全测试：金丝雀 key 跑完整流程后不出现在事件、receipt、trace、错误、`gatewayEnvironment`、harness env；新增 `test:live:pi` 脚本（默认不运行）
- [ ] 6.10 新增 `docs/pi.md`（启用、key、模型、局限、磁盘代价、环境变量被删除）；更新 `AGENTS.md`（代码地图、Orientation、执行约定、Verification 表的 `test:live:pi`）、`README.md`、`ARCHITECTURE.md`、`docs/platform-support.md`、`docs/permissions.md`、`docs/installation.md`；`CHANGELOG.md` 记录 DeepSeek 支持；`npm run check` 与 `npm run test:mod` 通过

## 7. P5b GLM（MP-0605）

- [ ] 7.1 catalog 加入 `zai` 与 `zai-coding-cn`，backend 只 import 对应 provider 工厂；`multi/zai/...` 不被当成 `multi/zai-coding-cn/...`；单测通过
- [ ] 7.2 录制 fixture 覆盖 `zaiToolStream` 与 GLM thinking 字段、`zai` 的 effort wire 字段；离线测试通过
- [ ] 7.3 更新 `docs/pi.md` 的 GLM 端点差异与 `CHANGELOG.md`；`npm run check` 通过

## 8. P5c Strata（DD §16.1）

- [ ] 8.1 用 `createProvider` 定义 Strata，地址和 key 来自 Multi 的环境变量；非回环 `http://` 与非法 URL 报错；缺地址时不出现在 picker 和 worker；回环地址无 key 发送占位值，非回环无 key 报错；不读 `~/.pi/agent/models.json`；单测通过
- [ ] 8.2 Strata 模型无 effort，带 effort 的请求丢弃 effort 并提示一次；usage 走第 6.7 项的规则；fixture 离线通过
- [ ] 8.3 更新 `docs/pi.md` 的 Strata 配置与 `CHANGELOG.md`；`npm run check` 通过

## 9. P6 Live 验收（需用户批准）

- [ ] 9.1 取得用户对付费 live 验收的明确批准，否则本组保持未完成
- [ ] 9.2 DeepSeek 运行 `npm run test:live:pi`：多轮工具调用、thinking 往返、用量显示；≤10 次上游调用，最低 effort，`max_tokens` 约 1024；截断记为未完成
- [ ] 9.3 GLM（key 所属端点）同 9.2；另一端点只有离线覆盖，写入 `CHANGELOG.md`
- [ ] 9.4 Strata 单独验收（不阻塞里程碑）
- [ ] 9.5 报告每个 provider 的实际调用次数、各场景结果和 usage，写入 DD §17

## 10. 集成检查

- [ ] 10.1 完整运行 `npm run check` 与 `npm run test:mod`，无 `DEP0190` 警告
- [ ] 10.2 未启用 `multi-pi` 时 picker、worker 与第 1 组快照一致，且环境变量未被删除
- [ ] 10.3 逐条对照 `specs/` 各场景与 DD §19 测试矩阵，确认都有对应测试
- [ ] 10.4 确认 diff 不含 Generic API Provider、Pi NativeHarness 或动态 provider 插件加载

## Workflow follow-up

- 实施完成并通过审查后归档本 change（`/opsx:archive`）。
- 是否推送或向 upstream 开 PR 由用户决定（DD §25）。

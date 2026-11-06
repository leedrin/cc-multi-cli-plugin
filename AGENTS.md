# Contributor guide

## Orientation

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [README.md](README.md) first. Setup
and provider details live in [docs/installation.md](docs/installation.md),
[docs/openai.md](docs/openai.md), [docs/cursor.md](docs/cursor.md),
[docs/zen.md](docs/zen.md), [docs/pi.md](docs/pi.md), [docs/antigravity.md](docs/antigravity.md), [docs/grok.md](docs/grok.md),
[docs/permissions.md](docs/permissions.md), and [docs/platform-support.md](docs/platform-support.md).
Claude Code function-hook UI and extensibility rules live in
[docs/claude-mods.md](docs/claude-mods.md).
`.agent/` is gitignored scratch space. It is never authoritative.

## Code map

| Path | Responsibility |
| --- | --- |
| `plugins/multi-core/src/launcher.ts` | Launches the gateway and registers models and workers. |
| `plugins/multi-core/src/gateway/server.ts` | Routes requests and manages sessions. |
| `plugins/multi-core/src/gateway/messages.ts`, `fetch.ts`, `tools.ts`, `responses.ts`, `bounded.ts`, `record.ts` | Shared protocol, outbound fetch, tool aliases, Responses translation and SSE reader, bounded maps, and the `isRecord` guard. |
| `plugins/multi-core/src/gateway/provider-facts.ts` | Host-free provider facts shared with hooks and installation, including provider IDs, plugin IDs, kinds, workers, and labels. |
| `plugins/multi-core/src/gateway/provider-registry.ts` | `ProviderRegistry`, `ProviderRuntime`, discovery context, descriptor and model types, registration validation, and provider/model resolution. |
| `plugins/multi-core/src/gateway/model-identity.ts` | Encodes and decodes provider model routes, including presets and the `[1m]` suffix. |
| `plugins/multi-core/src/gateway/builtin-providers.ts` | Aggregates built-in provider descriptors and registers them in a `ProviderRegistry`. |
| `plugins/multi-core/src/gateway/provider.ts`, `provider-request.ts` | Model-route provider lookup, `nativeSpelling`, and the contract through which OpenAI and Zen modules build their own requests. |
| `plugins/multi-core/src/gateway/executable.ts`, `process-tree.ts` | Resolves executables and manages child processes. |
| `plugins/multi-core/src/gateway/atomic-write.ts`, `state-lock.ts` | Protects files and serializes native state. |
| `plugins/multi-core/src/gateway/harness-settings.ts`, `mode-hook.ts`, `agent-definitions.ts`, `worker-catalog.ts` | Admits harness settings (`checkHarnessSettings`, `mergePermissions`), maps prompt and worker permissions, and resolves the Agent tool's `model` against each provider's worker catalog. |
| `plugins/multi-core/src/gateway/verdicts.ts`, `provider.ts` | Core verdict contract, Reviewer interface, and provider auto-review policy. `server.ts` alone finalises served replies and terminal events. |
| `plugins/multi-core/src/gateway/mod-*.ts`, `display-rows.ts`, `nested-env.ts` | Claude Mods control-plane routes, per-session mod key (`mod-keys.ts`), compaction, policy, native action display rows, and the nested-`claude` environment restore. |
| `plugins/multi-core/hooks/` | Claude Mods function hooks; `gateway.ts` is the single gateway client, state lives in `$.state`, timing in `$.clock`. |
| `plugins/multi-core/src/gateway/harness-*.ts` | Session store, exchange registry, response builder, completion, notices, and failure classifier (`harness-failure.ts`) shared by Cursor, Antigravity, and Grok; the CLI harness base (`harness-cli.ts`), process runner, and text prompt preparation shared by Antigravity and Grok. |
| `plugins/multi-core/src/account.ts`, `setup.ts`, `install/` | Accounts, bootstrap, plugin discovery, and installation. |
| `plugins/multi-openai/src/provider.ts` | OpenAI descriptor and typed `discoverOpenAI(context, deps?)`; provider-specific discovery, request construction, authentication, instructions, and review live in the OpenAI plugin. |
| `plugins/multi-cursor/src/provider.ts` | Cursor descriptor and typed `discoverCursor(context, required, deps?)`; provider-specific SDK harness, permissions, progress, requests, models, and workspaces live in the Cursor plugin. |
| `plugins/multi-zen/src/provider.ts` | Zen descriptor and typed `discoverZen(context, deps?)`; provider-specific API-key authentication, catalogs, request construction, and translations live in the Zen plugin. |
| `plugins/multi-antigravity/src/provider.ts` | Antigravity descriptor and typed `discoverAntigravity(context, deps?)`; provider-specific `agy` CLI harness, models, hooks, requests, and permissions live in the Antigravity plugin. |
| `plugins/multi-grok/src/provider.ts` | Grok descriptor and typed `discoverGrok(context, deps?)`; provider-specific Grok Build CLI harness, models, requests, permissions, and login state live in the Grok plugin. |
| `plugins/multi-pi/src/provider.ts` | DeepSeek, GLM, and Strata descriptors, Pi backend discovery, environment credential binding, and Direct request preparation. Strata is enabled by `MULTI_STRATA_BASE_URL`. |
| `test/unit/` | Offline unit tests for gateway and provider behavior. |
| `test/live/` | Opt-in checks against native CLIs and provider services. |
| `scripts/` | Development utilities: banner generation, release versioning (`versioning.ts`), and the release CLIs. |
| `.github/workflows/ci.yml` | Runs `npm run check` on Node 24 across Linux, macOS, and Windows. |
| `.github/workflows/release.yml` | Tags `v<version>` and publishes its GitHub release when a new version reaches `main`. |
| `package.json`, `biome.json`, `knip.json` | Scripts, lint rules, and entry/project analysis. |

Keep provider authentication and catalogs in provider folders. Keep shared protocol
types and cross-provider helpers in `plugins/multi-core/src/gateway/`. Prefer
direct module imports, the existing repository convention. Platform-dependent code
accepts an explicit `platform` option so every branch is unit-testable on Linux.

## Current execution contracts

These describe the implemented provider boundaries to preserve during ordinary
changes. Provider limitations are not permanent bans on requested new features;
changes to those boundaries need corresponding implementation and verification.

- Claude's permission mode controls every provider at prompt boundaries.
- Each provider owns its login, reviewer, execution state, and credentials. Pi-backed DeepSeek and GLM credentials come from their provider-specific environment variables; Strata is enabled by `MULTI_STRATA_BASE_URL`; `STRATA_API_KEY` is optional for loopback URLs and required otherwise, and any valid key supplied is used even for loopback. Loopback without a key uses a placeholder credential. Do not infer provider credentials or configuration from local Pi files.
- Fail explicitly on unsupported modes, unknown workers, or ambiguous ownership.
- A provider without a reviewer runs auto mode unreviewed and says so; plan mode still refuses actions.
- Never replay external tool events as executable Claude tools.
- Native state is never rewound, and uncertain actions are never rerun blindly.
- Antigravity native children and MCP are denied. Grok denies native subagents and MCP execution, and verifies the toolset the CLI announces.
- New bridges isolate session, worker, provider, and workspace state.
- Do not use Cursor Fast in development or live tests; set `fast:false` explicitly.
- Keep paid probes bounded and reuse existing usage records when possible.

## Claude Code extensibility requirement

Use Claude Mods function hooks for Claude Code harness UI or extensibility changes,
as explicitly requested by the maintainer. Read [docs/claude-mods.md](docs/claude-mods.md)
before changing that surface. Reuse the authenticated `/multi/mod/*` control plane
when gateway data or actions are needed; local rendering changes need no new route.

## Verification

Run `npm run check`. It checks the generated banner, version consistency, Biome
lint, Knip, strict type checking, and offline tests. `npm test` runs `tsc --noEmit` and the unit
test suite. Use Node 24.12 or newer and avoid `DEP0190` warnings.

For Claude Mods hook or surface changes, also run `npm run test:mod`. It type-checks
the hooks against `.claude-plugin/types/` (Claude Code writes them when it loads the
plugin; they are gitignored) and runs `claude plugin test` with the installed Claude
executable and the Mods rollout flag forced on, without provider inference. It is separate from `npm run check` and the current CI matrix.

| Command | Check | Login needed |
| --- | --- | --- |
| `npm run test:live:compaction` | Claude/OpenAI compaction and resume | Claude and Codex login |
| `npm run test:live:zen` | Zen tools, cache, and resume | Zen API key |
| `npm run test:live:pi` | DeepSeek tools, thinking, and usage (≤10 upstream calls) | DeepSeek API key |
| `npm run test:live:cursor` | Cursor SDK tools, continuation, and disk resume | Cursor SDK login |
| `npm run test:live:openai-instructions` | Requested planning/delegation and Plan restrictions (three-request budget) | Codex login |
| `npm run test:live:auto-mode` | Native Auto mode | Provider login under test |
| `npm run test:live:reviewer` | OpenAI reviewer allow/deny and inspection | Codex login |
| `npm run test:live:permissions` | Native permissions | Claude and provider login |
| `npm run test:live:antigravity` | Antigravity CLI harness | `agy` login |
| `npm run test:live:grok` | Grok Build CLI harness | Grok Build login |
| `npm run test:live:install` | Plugin installation | None |

The definition of done is passing relevant checks, no `DEP0190` warnings, and an
updated `CHANGELOG.md` for user-facing changes.

### Releasing

`package.json` owns the version. Release on a branch with
`npm run release -- <version> --summary "<one line>"`: it refuses a version that
is not semver or not greater than the current one, sets every manifest version,
`package-lock.json`, the `~<version>` multi-core pins and the Codex client version,
and renames `## Unreleased` to `## <version> — <date>`. The summary becomes the line
under that heading; omit `--summary` if `## Unreleased` already opens with a
one-line paragraph. No empty `## Unreleased` is left, matching earlier releases; the
next user-facing change adds it back above the newest release. Never edit versions
by hand: `npm run check:versions` (part of `npm run check`) fails when any field,
pin, or the CHANGELOG section disagrees with `package.json`.

Merging to `main` runs `.github/workflows/release.yml`. If tag `v<version>` does
not exist, it creates the tag and a GitHub release titled `v<version> — <summary>`,
with the rest of that CHANGELOG section as notes. A run whose tag exists does
nothing, so rerun it from the Actions tab (`workflow_dispatch`) after a failure.

## Code style

Biome requires braces, one variable declaration per statement, no nested ternaries,
no parameter reassignment, no explicit `any`, no non-null assertions, and cognitive
complexity of 15 or less. Do not disable rules, add blanket suppressions, or raise
limits. Explain any narrow suppression beside the constrained code. Use clear
state ownership and keep protocol constraints explicit.

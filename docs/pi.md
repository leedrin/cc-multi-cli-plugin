# DeepSeek, GLM and Strata via Pi

DeepSeek, Z.AI, and Strata are direct providers: Claude Code continues to run tools and enforce its permission mode. Multi uses the Pi AI library as the API backend; it does not run the Pi CLI or use Pi's local account configuration.

## Setup

1. Install `multi-core` and `multi-pi` from the marketplace:

   ```text
   /plugin install multi-pi@cc-multi-cli-plugin
   /reload-plugins
   ```

2. Set each provider's required credentials or configuration in the environment of the terminal that launches `claude-multi`:
   - `DEEPSEEK_API_KEY` enables the DeepSeek provider.
   - `ZAI_API_KEY` enables the Z.AI international coding-plan endpoint.
   - `ZAI_CODING_CN_API_KEY` enables the Z.AI Coding (CN) coding-plan endpoint.
   - `MULTI_STRATA_BASE_URL` enables Strata at the configured base URL. `STRATA_API_KEY` is optional for loopback URLs and required otherwise.

   The two Z.AI endpoints are coding-plan endpoints, not pay-as-you-go API endpoints. Each credential enables only its corresponding provider; set the variables for the providers you want to use. Strata is enabled by its base URL, not by its key.
3. Relaunch the session so the providers are discovered.

There is no `/multi-pi:connect` command or interactive key-entry flow. Multi reads credentials during startup, removes them from its process environment, and passes each only in memory to its owning provider. They are not passed to provider/harness child processes or Claude's plugin-list probe. Multi does not read `~/.pi/` or Pi's local auth files.

## Models

Select GLM models with `/model` or the Agent tool's `model` parameter:

| Provider | Model IDs | Worker |
| --- | --- | --- |
| `zai` | `glm-5.3`, `glm-5.2` | `multi-zai` |
| `zai-coding-cn` | `glm-5.3`, `glm-5.3-flash` | `multi-zai-coding-cn` |

For example, select `multi/zai/glm-5.3` or `multi/zai-coding-cn/glm-5.3`.

Effort support varies by model:

| Provider | Model ID | Supported effort |
| --- | --- | --- |
| `zai` | `glm-5.3` | `low`, `high`, `max` |
| `zai` | `glm-5.2` | `high`, `max` |
| `zai-coding-cn` | `glm-5.3` | `low`, `high`, `max` |
| `zai-coding-cn` | `glm-5.3-flash` | `low`, `high`, `max` |

Multi accepts `low`, `medium`, `high`, `xhigh`, and `max`; an accepted level not supported by the selected model resolves to the nearest supported level, with ties choosing the higher level. Thus `medium` resolves to `high` and `xhigh` to `max` for all four models; for `zai/glm-5.2`, `low` also resolves to `high`, and Multi includes a notice when it changes the requested level. `off` is not an accepted effort value; `thinking: disabled` disables reasoning effort.

| Provider | Base URL origin | Environment variable | Curated models |
| --- | --- | --- | --- |
| `zai` | `https://api.z.ai` | `ZAI_API_KEY` | `glm-5.3`, `glm-5.2` |
| `zai-coding-cn` | `https://open.bigmodel.cn` | `ZAI_CODING_CN_API_KEY` | `glm-5.3`, `glm-5.3-flash` |

`MULTI_PI_MODELS` filters the model IDs available across all Pi providers. Startup validates it when an enabled DeepSeek/GLM provider has a valid key, or when Strata is enabled with a valid `MULTI_STRATA_BASE_URL`—including a loopback URL without a key. An ID outside the combined built-in whitelist makes startup fail. If neither condition applies, the setting is ignored; `STRATA_API_KEY` alone, without a Strata URL, does not trigger validation.

## Strata

Set `MULTI_STRATA_BASE_URL` to enable Strata; without it, Strata has no picker row, worker, or usage-menu entry. The URL must use HTTPS, or HTTP on loopback (`localhost`, `127.0.0.0/8`, or `[::1]`). Invalid URLs, non-loopback HTTP, and URLs containing username/password are rejected at startup. Validation errors do not include the configured URL, userinfo, query, or key.

Set `STRATA_API_KEY` for a non-loopback HTTPS address. A loopback address can omit it; requests then use a placeholder credential, not a real key. Multi reads the optional credential from the launch environment and removes it before child processes are started. Never put credentials in the URL.

The curated model is text-only:

| Model ID | Route | Context window | Maximum output | Input | Worker |
| --- | --- | ---: | ---: | --- | --- |
| `qwen3.8-flash-next` | `multi/strata/qwen3.8-flash-next` | 196,608 | 32,768 | Text | `multi-strata` |

Strata supports no effort. If a request carries `output_config.effort`, Multi drops it and includes one notice that effort was ignored. `MULTI_PI_MODELS` may filter this catalog using built-in Pi model IDs; it cannot add a model.

## DeepSeek

Select a model with `/model multi/deepseek/<model-id>`. Both curated models are available when the provider is enabled:

| Model ID | Context window | Maximum output | Input |
| --- | ---: | ---: | --- |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | Text |
| `deepseek-flash` | 1,000,000 | 384,000 | Text and images |

`MULTI_PI_MODELS` may narrow this catalog using a comma-separated list of built-in IDs, but cannot add models. Its startup validation condition is shared across Pi providers: a valid key for an enabled DeepSeek/GLM provider or a configured Strata URL (even loopback without a key) triggers validation; see [the shared rule above](#models). Effort defaults to `high`. Supported effort is mapped to the nearest level available for the selected model (ties choose the higher level), and Multi reports a changed level once in the response. `thinking: disabled` disables reasoning effort.

## Execution

Claude Code owns the tool loop and applies its permission mode. DeepSeek, GLM, and Strata have no independent reviewer: Auto runs actions unreviewed and says “no auto mode: actions run unreviewed”; Plan refuses actions that require review. `/v1/messages/count_tokens` is answered with a local token estimate and does not load the Pi backend.

## Limits

- Requests go only to the configured Strata origin or the corresponding DeepSeek/GLM upstream origin. Redirects are rejected; the adapter does not retry requests (`maxRetries: 0`).
- DeepSeek and GLM backends are loaded lazily when their corresponding credentials are present. Strata is enabled by `MULTI_STRATA_BASE_URL` and uses the Pi backend only when a request is opened; its key is required only for non-loopback addresses.
- Multi does not read `~/.pi/`, Pi's `models.json`, or `auth.json`; Strata's model and connection settings come from the curated catalog and Multi environment variables.
- Session usage follows provider-reported usage observed from the response stream. If the upstream omits usage, it is recorded as unavailable, not zero; token estimates used for `count_tokens` are local estimates, not account billing. Strata exposes no account quota reader; per-run usage appears in session receipts.
- `glm-5.3` declares no `off` thinking level in the curated catalog, but Pi still sends `thinking: disabled`; whether the upstream accepts this remains to be confirmed by a live check.
- GLM and Strata have only been verified with offline fixtures so far. T039 will live-test only the GLM endpoint corresponding to the available key; the other endpoint remains offline-verified only. Strata live acceptance is separate and does not block the milestone.
- The usage dashboard has no DeepSeek account-quota reader. Session token usage is available in receipts; see [usage and receipts](usage.md). Check [DeepSeek usage](https://platform.deepseek.com/usage) for account balance and charges.
- `npm run test:live:pi` is an opt-in, potentially billable check. It requires `DEEPSEEK_API_KEY` and enforces a maximum of 10 upstream requests. It is not part of `npm run check`.
- The Pi dependency adds disk use even when its backend is not loaded. On this checkout, `@earendil-works/pi-ai` occupies 4,303,837 bytes (4.10 MiB), and its exclusive dependencies occupy a further 65,583,294 bytes (62.55 MiB), for 69,887,131 bytes (66.65 MiB) combined. Method: package-lock v3 dependency traversal started at `@earendil-works/pi-ai` and at every other root dependency; only Pi-reachable packages absent from every other root's closure were treated as exclusive, with the Pi package itself excluded. Node recursively summed regular-file byte sizes in the installed directories of the Pi package and each exclusive dependency (not following symlinks). This is a local installed-size measurement, not a download-size estimate.

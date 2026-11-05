# DeepSeek via Pi

DeepSeek is a direct provider: Claude Code continues to run tools and enforce its permission mode. Multi uses the Pi AI library as the DeepSeek API backend; it does not run the Pi CLI or use Pi's local account configuration.

## Setup

1. Install `multi-core` and `multi-pi` from the marketplace:

   ```text
   /plugin install multi-pi@cc-multi-cli-plugin
   /reload-plugins
   ```

2. Set `DEEPSEEK_API_KEY` in the environment of the terminal that launches `claude-multi`.
3. Relaunch the session so DeepSeek is discovered.

There is no `/multi-pi:connect` command or interactive key-entry flow. Multi reads the credential during startup, removes it from its process environment, and passes it only in memory to the DeepSeek provider. It is not passed to provider/harness child processes or Claude's plugin-list probe. As a result, Bash and other child processes in that Multi session do not inherit this variable. Multi does not read `~/.pi/` or Pi's local auth files.

## Models

Select a model with `/model multi/deepseek/<model-id>`. Both curated models are available when the provider is enabled:

| Model ID | Context window | Maximum output | Input |
| --- | ---: | ---: | --- |
| `deepseek-v4-pro` | 1,000,000 | 384,000 | Text |
| `deepseek-flash` | 1,000,000 | 384,000 | Text and images |

`MULTI_PI_MODELS` may narrow this catalog using a comma-separated list of these IDs. An ID outside the built-in whitelist is an error; this setting cannot add models. Effort defaults to `high`. Supported effort is mapped to the nearest level available for the selected model (ties choose the higher level), and Multi reports a changed level once in the response. `thinking: disabled` disables reasoning effort.

## Execution

Claude Code owns the tool loop and applies its permission mode. DeepSeek has no independent reviewer: Auto runs actions unreviewed and says “no auto mode: actions run unreviewed”; Plan refuses actions that require review. `/v1/messages/count_tokens` is answered with a local token estimate and does not load the Pi backend.

## Limits

- Requests go to DeepSeek's API host. Redirects are rejected; the adapter does not retry requests (`maxRetries: 0`).
- The adapter uses Pi's short cache-retention setting. Its provider is loaded lazily when the DeepSeek credential is present; without it, discovery does not load the backend.
- The usage dashboard has no DeepSeek account-quota reader. Session token usage is available in receipts; see [usage and receipts](usage.md). Check [DeepSeek usage](https://platform.deepseek.com/usage) for account balance and charges.
- `npm run test:live:pi` is an opt-in, potentially billable check. It requires `DEEPSEEK_API_KEY` and enforces a maximum of 10 upstream requests. It is not part of `npm run check`.
- The Pi dependency adds disk use even when its backend is not loaded. On this checkout, `@earendil-works/pi-ai` occupies 4,303,837 bytes (4.10 MiB), and its exclusive dependencies occupy a further 65,583,294 bytes (62.55 MiB), for 69,887,131 bytes (66.65 MiB) combined. Method: package-lock v3 dependency traversal started at `@earendil-works/pi-ai` and at every other root dependency; only Pi-reachable packages absent from every other root's closure were treated as exclusive, with the Pi package itself excluded. Node recursively summed regular-file byte sizes in the installed directories of the Pi package and each exclusive dependency (not following symlinks). This is a local installed-size measurement, not a download-size estimate.

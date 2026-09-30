# Usage and receipts

Run `/multi-usage` inside `claude-multi` to open the native Claude Mods usage
pane. It starts with an overview of all five providers. Select a provider for
quota, billing, and session token details; select **Receipts** for completed
worker and main-turn records. The pane is drawn by Claude Code's own focus ring:
press Tab to move between the provider tabs and controls, Enter to choose one,
scroll with the mouse wheel or the **Page Up** and **Page Down** buttons,
choose **Refresh** to reload the page you are on, and **Close** (or Escape) to
leave. Closing and running `/multi-usage` again starts on the overview.

### When the pane does not work: `--text`

`/multi-usage --text` (or `/multi-usage text`) prints the same data as plain
text. It asks for no pane, runs in any host, and works in non-interactive (`-p`)
runs. Any other argument is refused with `Use /multi-usage or /multi-usage --text.`
before the gateway is asked.

The plain command also falls back to that text by itself when the host places no
pane (`$.ui.open()` answers that it was not placed, or throws). The reply then says
why, for example `The usage pane could not be shown (terminal is narrower than 144
columns). Showing text instead.` Multi does not guess which host it is running in
and sets no timers to decide that focus failed: a pane that is placed but never
receives focus is a host problem, and `--text` is the way around it. To tell a pane
problem from a host problem, follow the [host checklist](usage-host-checklist.md).

| Provider | Account information in the menu |
| --- | --- |
| OpenAI / Codex | Native account quota windows, percent used, reset times, plan and credits when reported |
| Cursor | Account subscription usage percentages and billing-cycle resets, plus billed token totals and charged USD for this session's active native agents |
| OpenCode Zen | Go subscription quota windows and resets when entitled; prepaid balance and billed API spend require the billing console |
| Antigravity | Native account quota groups, remaining percentages, reset times, and AI credit balance when reported |
| Grok | Local login/renewal status; an access-token expiry is shown only without a refresh token. The CLI exposes no account quota, and local token presence does not prove the login remains accepted. |

Unavailable and disabled providers stay visible. Missing billing data is never
shown as a zero charge. The menu also shows session token counts for every
provider and keeps these separate from account quota and charges.

Each provider's page lists this session's usage after its account details:

```text
This session: 3 completed requests · 7 model calls
Context: 150 input · 800 cache read · prompt cache read ratio 84.2%
Consumed: 450 input · 2,400 cache read · 600 output · 360 reasoning · 3,810 total
Source: provider
```

- **Context** is the last response's live context window, the number Claude Code
  uses for its own context gauge. **Consumed** is everything the session's
  requests used. They are separate on purpose: a harness turn makes many model
  calls, and the last call's context is not what the turn consumed.
- **Prompt cache read ratio** is token-weighted: `cache read / (uncached input +
  cache read + cache write)`. An unreported cache write adds nothing to the
  denominator. The ratio is shown only when the counts are provider-reported
  (`80.0%`) or an estimate (`~82.4% (estimated)`); a mixed or unavailable total
  has no sound ratio and shows none.
- **Source** says where the counts came from: `provider` (reported by the
  provider), `estimate` (computed locally), `mixed` (some requests reported
  complete counts and some did not), or `unavailable` (nothing was reported).
  A mixed total lists its counts as `known input 40 · known cache read 60`, and the
  page adds `Some requests did not report complete token telemetry.`
- A count the provider did not report is left out, never shown as `0`. `0` means
  the provider reported zero. `Consumed: usage unavailable` means no request of
  that provider reported usage at all.

### Claude Code's own usage display

Claude Code's built-in usage and cost display has no place for a cache ratio, and
it shows the `input_tokens` and `output_tokens` the gateway sends on the wire.
When a provider sends no usage, the wire usage carries placeholder zeros so Claude
Code can continue, and its display then shows `0`. That zero is a protocol
placeholder, not a report that nothing was used: `/multi-usage` (`Source:
unavailable`) and the receipts are the record. The ratio is shown in
`/multi-usage`, where it can be read in full.

Opening or refreshing the pane performs read-only account lookups, without model
inference. Account results are cached for 30 seconds; Refresh requests fresh data.
A failed provider lookup does not prevent the others from displaying. The only
slash command is `/multi-usage`; receipts and billing live within its menu.

## Quota-aware model selection

The menu's **Quota-aware model selection** toggle enables an advisory hook for
the main agent in the current session. It is off by default. When enabled, the
agent receives current provider quota summaries from a `PreToolUse` hook on its
`Agent`/`Task` calls, before the subagent tool executes,
with guidance to prefer the least-used subscription among models suitable for
the task. It can still choose another model, and explicit user model requests
take precedence. The hook does not change worker arguments, block spawns, or wait
for quota resets.

Ordinary prompts, other tools, and nested workers do not trigger the advisory.
The model consumes the added context on its next inference; the hook does not
restart model selection for an already-issued spawn.

The advisory uses the same cached account lookups as the menu. Unavailable quota
is labeled unknown, and lookup failures do not stop the agent. Worker receipts
are not included in the advisory. Disabling the toggle stops future advisories;
earlier context already received by the agent is not removed. The preference is
session-only and is cleared when the session detaches.

Runtime totals cover requests observed by this gateway process; restarting the
launcher starts a new in-memory view. Claude subscription passthrough and reviewer
inference are not included in these totals.

## Saving receipts

Set `MULTI_RECEIPTS_FILE` to an existing directory's file path before launching:

```sh
MULTI_RECEIPTS_FILE="$PWD/usage.jsonl" claude-multi
```

In PowerShell:

```powershell
$env:MULTI_RECEIPTS_FILE = Join-Path $PWD "usage.jsonl"
claude-multi
```

The gateway appends one JSON line when a worker invocation or main turn finishes.
Each receipt includes a schema version, unique receipt ID, session and agent IDs,
invocation ID when available, timestamps, outcome, request count, and usage entries
grouped by provider, model, effort, endpoint or native transport, and count source.
Model or effort changes remain separate entries. Native SDK/CLI transports are
identified as `@cursor/sdk`, `agy`, and `grok`; their upstream URLs are not known to Multi.

### Receipt schema v2 (breaking for readers)

Receipts are written with `schemaVersion: 2`. Two things change for anything that
reads the file, and earlier v1 lines stay valid as they were written:

- **Unknown is omitted, not zero.** A token field nobody reported is absent from
  `usage` and from every entry. In v1 it was written as `0`. A reader that treats
  a missing field as zero reproduces the old numbers; a reader that wants to tell
  unreported from zero can now do so.
- **A receipt with no usage says so.** A failed or cancelled receipt with no
  completed response has `usage: { "source": "unavailable" }` and
  `incomplete: true`, where v1 wrote zeros. A cancelled receipt that did complete
  a response keeps that response's counts.

Every `usage` object carries `source` (`provider`, `estimate`, `mixed`,
`unavailable`). `reasoning_tokens` and `total_tokens` are summed when reported.
`cache_read_ratio` is written only for a `provider` total. The last response's
context is kept apart in `context`, and never added to the totals. The main turn
and each worker keep separate receipts.

Receipts contain no prompts, responses, tool arguments, or credentials. File errors
are reported on stderr without failing inference. A normal shutdown drains queued
writes and marks unfinished invocations incomplete. Abrupt process termination can
lose pending records; this is a local accounting aid, not an exactly-once billing
ledger. Use separate files per concurrent launcher process when collecting a fleet.

## Understanding the numbers

`source` distinguishes provider counts, local estimates, mixed counts, and missing
usage information. Failed or cancelled runs can have incomplete usage; a count that
was never reported is absent, and a reported `0` is a real zero. Replaying a saved
response does not add another request's usage. Cache reads and writes remain
separate from uncached input, and `input_tokens` is the uncached remainder: OpenAI
counts cached tokens inside its input total, and the gateway subtracts them.
Reported reasoning tokens are informational and must not be added again to output
totals; the provider's own total is used when it reports one.

An OpenAI response whose usage object is malformed (a negative, fractional or
non-finite count) fails instead of being summed. An OpenAI response that completes
without any usage is recorded as unavailable, never as zero; OpenCode Zen still
refuses a completion without usage, because its cost accounting needs it.

Cursor uses the SDK's per-run counters. Antigravity differences its native
cumulative counters across continuations. Estimates remain a fallback when native
counts are unavailable. These runtime counts do not establish a monetary charge.

Cursor billed usage in the menu is a separate, provider-owned view covering each native agent's
lifetime, potentially including previous launcher sessions. Local billing entries
are per turn, rather than gateway requests. Costs are in USD cents; missing cost
means not yet available, while a reported zero can represent included usage. Billing
may settle after a run ends, so query again later if needed. See the
[Cursor SDK documentation](https://cursor.com/docs/sdk/typescript#token-usage).

Codex quota comes from its native
[`account/rateLimits/read` interface](https://developers.openai.com/codex/app-server/).
Cursor subscription quota uses its native `DashboardService/GetCurrentPeriodUsage`
endpoint with the existing SDK login. This internal interface can change independently
of the public SDK. Its reported percentages are kept separate from per-agent charged
USD; raw plan allowance units are not assumed to be dollars.

Zen Go quota comes from `/zen/go/v1/usage` using the same API key as inference.
Go subscription allowance and the prepaid Zen wallet are different account data.
An account without Go entitlement has no Go quota to display; this does not mean
its prepaid balance is zero.

Antigravity quota comes from separate, read-only native CLI invocations:
`agy -p /usage --output-format json` and `agy -p /credits --output-format json`.
These use the same native login as workers and do not run model inference or send
commands into an active worker. Credits remain credits, with no assumed dollar
conversion. A failed credit lookup does not hide a successful quota lookup.
The third-party `antigravity-auth` package and its separate credential store are
not needed. See Google's [headless CLI documentation](https://antigravity.google/docs/cli/headless/).

Quota percentages and credit balances are not API dollar charges. Account snapshots
include activity outside this launcher. Changes between snapshots cannot establish
an individual worker's charge, especially when several workers share an account.

## Finding where a wrong number comes from

Three switches show what each layer saw. All are off by default and write only
counts and identifiers, never prompts, replies, reasoning, tool input or output,
credentials, or the gateway token.

| Switch | Where | What it writes |
| --- | --- | --- |
| `MULTI_USAGE_TRACE=1` | Gateway process, to stderr | One JSON line per terminal response: `provider`, `event`, `usagePresent`, `source` and the known `inputTokens`, `cachedTokens`, `cacheWriteTokens`, `outputTokens`, `reasoningTokens`, `totalTokens`. A response with no usage is `usagePresent: false` with no counts. |
| `MULTI_UI_TRACE=1` | The usage hooks, to Claude Code's debug log (`claude --debug`) | One line per pane event: the surface, placement (`requested`, `placed`, `reason`), `ui.focus`, `ui.press`, `ui.scroll`, `ui.close`. No session id is written. |
| `MULTI_RECEIPTS_FILE=<path>` | Gateway process | The durable receipts described above. |

Read them together, from the provider outward:

| Case | What you see | Where to look |
| --- | --- | --- |
| A | The receipt has `output_tokens > 0` and `cache_read_input_tokens > 0`, but Claude Code's own display shows output `0` | Claude Code's display or its aggregation of the streamed usage, not the gateway |
| B | The receipt has no output and no cache reads, and `source` is `unavailable` (the usage trace says `usagePresent: false`) | The gateway never got terminal usage: the Responses parser, or the shape of the upstream event |
| C | The usage trace shows output greater than `0`, but the receipt has none | The gateway's normalization, completion event, or receipt |

The receipts file holds no prompts, responses, tool arguments, or credentials.

For terminal hosts where the pane misbehaves, see the [host
checklist](usage-host-checklist.md).

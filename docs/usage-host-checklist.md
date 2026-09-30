# `/multi-usage` terminal-host checklist

`/multi-usage` opens an interactive pane in hosts that can place one, and
`/multi-usage --text` prints the same data in any host. This checklist is how a
person decides which layer a host problem belongs to. Function hooks cannot
observe terminal bytes, so the byte-level behavior of a host (focus reporting,
key delivery, pane placement) is verified here, by hand. The offline suite covers
what the engine can see: the placement answer, the drawn tree, presses and focus
moves (`plugins/multi-core/hooks/tests/usage-host-matrix.test.ts`), and a headless
`--text` run against real Claude Code (`test/e2e/usage-text-headless.test.ts`).

## Record for every run

Copy this block once per run and fill it in. A result without these fields is not
comparable.

| Field | Value |
| --- | --- |
| Date | |
| Orca version (or other host and its version) | |
| Claude Code version (`claude --version`) | |
| Operating system and build | |
| Shell and PTY (for example PowerShell on ConPTY, bash on WSL, SSH, tmux) | |
| cc-multi commit (`git rev-parse --short HEAD`) | |
| Command used to launch (`claude-multi`, or the custom name) | |

## Test A: does the host hand focus to a pane at all

Run in one Orca session, in this order.

1. Run Claude Code's own `/diff` and confirm you can move between its files and
   press Esc. Note: works / does not work.
2. In the same session run `/multi-usage`. Confirm the tab row shows `[All]`.
3. Press Tab. Focus moves to the next control. Note: works / does not work.

Reading the result:

| `/diff` | `/multi-usage` | Conclusion |
| --- | --- | --- |
| interactive | not interactive | Look first at the Multi usage pane implementation. |
| not interactive | not interactive | Look first at Claude Code's or Orca's terminal integration. |
| interactive | interactive | The host is healthy for this pane. |

## Test B: same build, two hosts

With the same `claude-multi`, Claude Code version and repository, run
`/multi-usage` once in Windows Terminal and once in Orca, and compare the steps
below in both. Windows Terminal must pass every step: interactive, text, Refresh
and Close.

| Step | What to do | Expected |
| --- | --- | --- |
| Provider focus ring | Press Tab repeatedly | Focus visits `All`, each provider, `Receipts`, the quota switch, Page Up, Page Down, Refresh, Close |
| Choose a provider | Press Enter on a provider | Its page shows and the tab reads `[Name]` |
| Receipts | Choose `Receipts` | Receipts load once; the page says so if none exist |
| Scroll | Mouse wheel, or Page Down and Page Up | The window moves; the footer range changes and stays within the page |
| Refresh | Press Refresh | Account data is read again (`updatedAt` changes) |
| Esc | Press Esc | The pane closes |
| Close | Reopen, focus Close, press Enter | The pane closes without using Esc |
| Reopen | Run `/multi-usage` again | The pane opens on `All` |
| Narrow window | Shrink the terminal below the pane's minimum width | Either a readable pane or the same data as text with the reason |

If any step does not work, note the step and continue; the remaining steps are
still informative.

## Test C: the data is reachable everywhere

In every host run `/multi-usage --text`. The text must list all five providers
(OpenAI / Codex, Cursor, OpenCode Zen, Antigravity, Grok Build) and be the same
across hosts for the same session. Interaction failing while `--text` works means
the usage data is healthy and the problem is the pane's interaction in that host.

| Interactive | `--text` | Conclusion |
| --- | --- | --- |
| fails | works | The usage data is healthy; the UI or focus problem is isolated to the pane. |
| works in Windows Terminal, fails in Orca | works | Host-triggered focus or protocol incompatibility. |
| fails | fails | Gateway or launch problem; check `MULTI_USAGE_TRACE` and the gateway log. |

To see what the pane did, launch with `MULTI_UI_TRACE=1` and read Claude Code's
debug log (`claude --debug`); the lines carry the surface, the placement answer,
focus moves, presses, scrolls and close, and never a session id or usage text.

## Host matrix

Fill one row per host and Claude Code version. The lowest supported, the pinned
and the latest supported Claude Code versions are all required.

| Host | Claude Code | OS | Interactive | Text | Refresh | Close | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Windows Terminal | | | | | | | |
| PowerShell terminal | | | | | | | |
| Orca on Windows (ConPTY) | | | | | | | interactive or text fallback |
| Orca on WSL | | | | | | | |
| Orca remote runtime | | | | | | | |
| WSL terminal | | | | | | | |
| SSH session | | | | | | | |
| tmux | | | | | | | |
| xterm or kitty | | | | | | | |
| Narrow terminal | | | | | | | text or a clear warning |
| Non-interactive (`-p`) | | | | | | | text only |

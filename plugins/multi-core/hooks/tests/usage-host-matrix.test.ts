import { expect, mock, type TestBody, test } from 'claude-code/testing';

// The terminal-host matrix as the engine sees it. A host differs in what `$.ui.open` answers
// and in how wide its pane is; the bytes a terminal exchanges are out of reach of function
// hooks, so they are covered by the manual Orca/host checklist in docs/usage.md. Whatever a
// host does, the usage must stay readable: the pane when it is placed, the same data as text
// when it is not, and `--text` everywhere.

type Open =
  | { kind: 'placed' }
  | { kind: 'refused'; reason: string }
  | { kind: 'throws' }
  | { kind: 'silent' };

const hosts: Array<{ host: string; columns: number; open: Open }> = [
  { host: 'Windows Terminal', columns: 120, open: { kind: 'placed' } },
  { host: 'PowerShell terminal', columns: 120, open: { kind: 'placed' } },
  { host: 'Orca on Windows ConPTY', columns: 100, open: { kind: 'placed' } },
  { host: 'Orca on WSL', columns: 100, open: { kind: 'placed' } },
  {
    host: 'Orca remote runtime',
    columns: 100,
    open: { kind: 'refused', reason: 'the remote runtime places no panes' },
  },
  { host: 'WSL terminal', columns: 120, open: { kind: 'placed' } },
  { host: 'SSH session', columns: 100, open: { kind: 'placed' } },
  { host: 'tmux', columns: 90, open: { kind: 'silent' } },
  { host: 'xterm', columns: 80, open: { kind: 'placed' } },
  { host: 'kitty', columns: 200, open: { kind: 'placed' } },
  {
    host: 'narrow terminal',
    columns: 40,
    open: { kind: 'refused', reason: 'terminal is narrower than 144 columns' },
  },
  { host: 'headless', columns: 80, open: { kind: 'throws' } },
];

const dashboard = {
  updatedAt: '2026-09-30T12:00:00Z',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI / Codex',
      status: 'ready',
      summary: 'quota 10% used',
      details: ['Context: 150 input · 800 cache read · prompt cache read ratio 80.0%'],
    },
    { id: 'cursor', name: 'Cursor', status: 'ready', summary: 'Included plan', details: [] },
    { id: 'zen', name: 'OpenCode Zen', status: 'unavailable', summary: 'Unavailable', details: [] },
    { id: 'antigravity', name: 'Antigravity', status: 'disabled', summary: 'Off', details: [] },
    { id: 'grok', name: 'Grok Build', status: 'error', summary: 'Error', details: [] },
  ],
};

type Kit = Parameters<TestBody>;

function environment(on: Kit[1], open: Open, calls: { open: number }) {
  mock.clock(on);
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: 'secret',
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.id', () => ({ value: 'matrix' }));
  on('ui.open', (() => {
    calls.open++;
    if (open.kind === 'throws') {
      throw new Error('no surface');
    }
    if (open.kind === 'refused') {
      return { value: { isPlaced: false, reason: open.reason } };
    }
    return { value: open.kind === 'placed' ? { isPlaced: true } : undefined };
  }) as never);
  on('ui.close', () => ({ value: undefined }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
}

/** The first host's --text; every other host must print exactly the same. */
let reference: string | undefined;

async function usageText($: Kit[0]): Promise<string> {
  const result = await $.command.run({ command: 'multi-usage', args: '--text' } as never);
  return result.text ?? '';
}

for (const { host, columns, open } of hosts) {
  test(`host matrix: ${host} keeps usage readable`, async ($, on) => {
    const calls = { open: 0 };
    environment(on, open, calls);
    // `--text` is the same complete data on every host and never asks for a pane.
    const text = await usageText($);
    expect(calls.open).toBe(0);
    reference ??= text;
    expect(text).toBe(reference);
    for (const name of ['OpenAI / Codex', 'Cursor', 'OpenCode Zen', 'Antigravity', 'Grok Build']) {
      expect(text).toContain(name);
    }
    expect(text).toContain('prompt cache read ratio 80.0%');

    const result = await $.command.run({ command: 'multi-usage', args: '' } as never);
    expect(calls.open).toBe(1);
    if (open.kind === 'refused' || open.kind === 'throws') {
      // No pane: the same usage arrives as text, with the reason when the host gave one.
      expect(result.text).toContain('Grok Build [error]');
      expect(result.text).toContain('prompt cache read ratio 80.0%');
      if (open.kind === 'refused') {
        expect(result.text).toContain(open.reason);
      }
      return;
    }
    expect(result.text).toBeUndefined();
    const pane = await $.ui.mount({
      plugin: 'multi-core',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'multi-usage',
      props: { title: 'Multi usage', isFocused: true, bodyColumns: columns } as never,
    });
    // Every provider is reachable, the page can be refreshed and closed without a keyboard.
    for (const provider of ['openai', 'cursor', 'zen', 'antigravity', 'grok']) {
      expect(await pane.find({ type: 'Button', key: `provider:${provider}` })).toBeTruthy();
    }
    expect(await pane.find({ type: 'Button', key: 'action:refresh' })).toBeTruthy();
    expect(await pane.find({ type: 'Button', key: 'action:close' })).toBeTruthy();
    // Choosing a provider shows its page; closing and reopening starts from All again.
    await pane.press({ key: 'provider:openai' });
    expect(await pane.find({ type: 'Button', text: '[OpenAI / Codex]' })).toBeTruthy();
    await pane.press({ key: 'action:close' });
    await $.command.run({ command: 'multi-usage', args: '' } as never);
    expect(await pane.find({ type: 'Button', text: '[All]' })).toBeTruthy();
    // A pane that never got focus (the host's fault) costs nothing: the text is still there.
    expect(await usageText($)).toBe(text);
    await pane.unmount();
  });
}

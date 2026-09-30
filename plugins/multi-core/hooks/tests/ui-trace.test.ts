import { expect, mock, test } from 'claude-code/testing';

const dashboard = {
  updatedAt: '2026-09-30T12:00:00Z',
  providers: [
    {
      id: 'openai',
      name: 'OpenAI',
      status: 'ready',
      summary: 'PRIVATE-SUMMARY',
      details: ['PRIVATE-DETAIL'],
    },
  ],
};

const SESSION = 'SESSION-SECRET-123';
const TOKEN = 'token-xyz-789';

type Kit = Parameters<Parameters<typeof test>[1]>;

function setup(on: Kit[1], trace: string | undefined, open: unknown) {
  const lines: string[] = [];
  mock.env(on, {
    MULTI_GATEWAY_TOKEN: TOKEN,
    MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
    ...(trace === undefined ? {} : { MULTI_UI_TRACE: trace }),
  });
  on('session.id', () => ({ value: SESSION }));
  on('ui.open', () => ({ value: open }) as never);
  on('ui.close', () => ({ value: undefined }));
  on('ui.log', (_$, event) => {
    lines.push(event.text);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  return lines;
}

test('UI trace is silent unless MULTI_UI_TRACE is 1', async ($, on) => {
  const lines = setup(on, undefined, { isPlaced: true });
  await $.command.run({ command: 'multi-usage', args: '' });
  expect(lines).toEqual([]);
});

test('UI trace records a refused placement with its reason', async ($, on) => {
  const lines = setup(on, '1', {
    isPlaced: false,
    reason: 'terminal is narrower than 144 columns',
  });
  await $.command.run({ command: 'multi-usage', args: '' });
  const open = lines
    .map((line) => JSON.parse(line.replace(/^multi-usage /, '')))
    .find((line) => line.event === 'pane.open');
  expect(open).toEqual({
    event: 'pane.open',
    requested: true,
    placed: false,
    reason: 'terminal is narrower than 144 columns',
  });
});

test('UI trace records a placed pane, presses and the surface, and never identifies the session', async ($, on) => {
  const lines = setup(on, '1', { isPlaced: true });
  await $.command.run({ command: 'multi-usage', args: '' });
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 80 },
  });
  await pane.press({ key: 'provider:openai' });
  await pane.press({ key: 'action:refresh' });
  await pane.press({ key: 'action:close' });
  const parsed = lines.map((line) => JSON.parse(line.replace(/^multi-usage /, '')));
  expect(parsed).toContainEqual({ event: 'pane.open', requested: true, placed: true });
  expect(parsed).toContainEqual({
    event: 'ui.render',
    surface: 'terminal',
    requestId: 'multi-usage',
    columns: 80,
  });
  expect(parsed).toContainEqual({
    event: 'ui.press',
    surface: 'terminal',
    requestId: 'multi-usage',
    element: 'provider:openai',
  });
  expect(parsed.filter((line) => line.event === 'ui.press').map((line) => line.element)).toEqual([
    'provider:openai',
    'action:refresh',
    'action:close',
  ]);
  // Nothing the pane shows, nothing that identifies the session, and no credential.
  const all = lines.join('\n');
  for (const secret of [
    SESSION,
    TOKEN,
    'PRIVATE-SUMMARY',
    'PRIVATE-DETAIL',
    'x-multi-gateway-token',
    'Authorization',
  ]) {
    expect(all).not.toContain(secret);
  }
  await pane.unmount();
});

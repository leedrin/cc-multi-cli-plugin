import type { UiOpenResult } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

// The Usage Pane reaches a person through four layers that fail independently: the gateway
// data renders into a tree, the engine places the pane, the focus system lands focus on one of
// its elements, and choosing a tab moves the pane to it. (The kit cannot raise a person's focus move, so ui.focus\n// itself is covered beside the other hooks in native-usage-menu.test.ts.) This fixture observes each layer on its own so a host
// problem can be attributed to one of them. It characterizes the pane as it is, and what the command does when placement fails.

interface Layers {
  requested: boolean;
  placed: boolean;
  rendered: boolean;
  focusRequested: boolean;
  focusEvents: number;
  navigated: boolean;
}
type Failure = 'none' | 'render' | 'placement' | 'focus' | 'navigate';

/** The first layer that did not hold, in the order a person meets them. */
function classify(layers: Layers): Failure {
  if (!layers.rendered) {
    return 'render';
  }
  if (!layers.requested || !layers.placed) {
    return 'placement';
  }
  if (!layers.focusRequested || layers.focusEvents === 0) {
    return 'focus';
  }
  return layers.navigated ? 'none' : 'navigate';
}

const dashboard = {
  updatedAt: '2026-09-30T12:00:00Z',
  providers: [
    { id: 'openai', name: 'OpenAI', status: 'ready', summary: 'quota ok', details: ['line'] },
    { id: 'cursor', name: 'Cursor', status: 'ready', summary: 'cursor ok', details: [] },
  ],
};

const env = {
  MULTI_GATEWAY_TOKEN: 'secret',
  MULTI_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
};

test('layers: a healthy host renders, places, focuses and opens the chosen tab', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-healthy' }));
  let opened: UiOpenResult | undefined;
  on('ui.open', () => {
    opened = { isPlaced: true };
    return { value: opened };
  });
  const focused: string[] = [];
  on('ui.focus', (_$, event) => {
    focused.push(event.key);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  const result = await $.command.run({ command: 'multi-usage', args: '' });
  expect(result.text).toBeUndefined();
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 80 },
  });
  const selected = await pane.find({ type: 'Button', text: '[All]' });
  expect(selected?.key).toBe('tab:all');
  await $.ui.focus({ requestId: 'multi-usage', key: 'tab:all' });
  await pane.press({ key: 'provider:openai' });
  const moved = await pane.find({ type: 'Button', text: '[OpenAI]' });
  const layers: Layers = {
    requested: opened !== undefined,
    placed: opened?.isPlaced === true,
    rendered: selected !== undefined,
    focusRequested: selected?.props.autoFocus === true,
    focusEvents: focused.length,
    navigated: moved !== undefined,
  };
  expect(layers).toEqual({
    requested: true,
    placed: true,
    rendered: true,
    focusRequested: true,
    focusEvents: 1,
    navigated: true,
  });
  expect(classify(layers)).toBe('none');
  await pane.unmount();
});

test('layers: a refused placement falls back to text and closes the waiting pane', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-placement' }));
  on('ui.open', () => ({
    value: { isPlaced: false, reason: 'terminal is narrower than 144 columns' },
  }));
  const closed: string[] = [];
  on('ui.close', (_$, event) => {
    closed.push(event.id);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  const result = await $.command.run({ command: 'multi-usage', args: '' });
  expect(result.text).toContain('terminal is narrower than 144 columns');
  expect(result.text).toContain('OpenAI [ready]');
  expect(result.text).toContain('Cursor [ready]');
  expect(closed).toEqual(['multi-usage']);
  expect(
    classify({
      requested: true,
      placed: false,
      rendered: true,
      focusRequested: true,
      focusEvents: 0,
      navigated: false,
    }),
  ).toBe('placement');
});
test('layers: a session without gateway data never reaches a pane', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-render' }));
  let opens = 0;
  on('ui.open', () => {
    opens++;
    return { value: undefined };
  });
  on('http.fetch', () => ({ value: { ok: false, status: 503, headers: {}, text: '' } }));
  const result = await $.command.run({ command: 'multi-usage', args: '' });
  expect(result.text).toContain('unavailable');
  expect(opens).toBe(0);
  expect(
    classify({
      requested: false,
      placed: false,
      rendered: false,
      focusRequested: false,
      focusEvents: 0,
      navigated: false,
    }),
  ).toBe('render');
});

test('layers: a placed, rendered pane that receives no focus event is a focus failure', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-focus' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  const focused: string[] = [];
  on('ui.focus', (_$, event) => {
    focused.push(event.key);
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  await $.command.run({ command: 'multi-usage', args: '' });
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 80 },
  });
  const selected = await pane.find({ type: 'Button', text: '[All]' });
  const layers: Layers = {
    requested: true,
    placed: true,
    rendered: selected !== undefined,
    focusRequested: selected?.props.autoFocus === true,
    // The engine never raised `ui.focus`: the host did not give the pane focus.
    focusEvents: focused.length,
    navigated: false,
  };
  expect(layers.rendered).toBe(true);
  expect(layers.focusRequested).toBe(true);
  expect(layers.focusEvents).toBe(0);
  expect(classify(layers)).toBe('focus');
  await pane.unmount();
});

test('layers: a control that is not a tab leaves the pane where it was', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-key' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  let focusEvents = 0;
  on('ui.focus', () => {
    focusEvents++;
    return { value: undefined };
  });
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  await $.command.run({ command: 'multi-usage', args: '' });
  const pane = await $.ui.mount({
    plugin: 'multi-core',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'multi-usage',
    props: { title: 'Multi usage', isFocused: true, bodyColumns: 80 },
  });
  await $.ui.focus({ requestId: 'multi-usage', key: 'tab:all' });
  // A press on a control that is not a tab leaves the selection where it was.
  await pane.press({ key: 'action:quota-advice' });
  const stillAll = await pane.find({ type: 'Button', text: '[All]' });
  const layers: Layers = {
    requested: true,
    placed: true,
    rendered: true,
    focusRequested: stillAll?.props.autoFocus === true,
    focusEvents,
    navigated: stillAll === undefined,
  };
  expect(classify(layers)).toBe('navigate');
  await pane.unmount();
});

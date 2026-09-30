import type { UiOpenResult } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

// The Usage Pane reaches a person through four layers that fail independently: the gateway
// data renders into a tree, the engine places the pane, the focus system lands focus on one of
// its elements, and keys are delivered. This fixture observes each layer on its own so a host
// problem can be attributed to one of them. It characterizes the Client-based pane as it is.

interface Layers {
  requested: boolean;
  placed: boolean;
  rendered: boolean;
  focusRequested: boolean;
  focusEvents: number;
  keyDelivered: boolean;
}
type Failure = 'none' | 'render' | 'placement' | 'focus' | 'key';

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
  return layers.keyDelivered ? 'none' : 'key';
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

test('layers: a healthy host renders, places, focuses and delivers keys', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-healthy' }));
  let opened: UiOpenResult | undefined;
  on('ui.open', () => {
    opened = { isPlaced: true };
    return { value: opened };
  });
  on('ui.invalidate', () => ({ value: undefined }));
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
  const selected = await pane.find({ type: 'Button', text: '[All]', in: 'usage' });
  await $.ui.focus({ requestId: 'multi-usage', key: String(selected?.key) });
  await pane.key({ key: 'right', in: 'usage' });
  const moved = await pane.find({ type: 'Button', text: '[OpenAI]', in: 'usage' });
  const layers: Layers = {
    requested: opened !== undefined,
    placed: opened?.isPlaced === true,
    rendered: (await pane.find({ type: 'Client', key: 'usage' })) !== undefined,
    focusRequested: selected?.props.autoFocus === true,
    focusEvents: focused.length,
    keyDelivered: moved !== undefined,
  };
  expect(layers).toEqual({
    requested: true,
    placed: true,
    rendered: true,
    focusRequested: true,
    focusEvents: 1,
    keyDelivered: true,
  });
  expect(classify(layers)).toBe('none');
  await pane.unmount();
});

test('layers: a refused placement leaves the command silent today', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-placement' }));
  on('ui.open', () => ({
    value: { isPlaced: false, reason: 'terminal is narrower than 144 columns' },
  }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', () => ({
    value: { ok: true, status: 200, headers: {}, text: JSON.stringify(dashboard) },
  }));
  const result = await $.command.run({ command: 'multi-usage', args: '' });
  // Characterization of the gap the text fallback closes: the placement result is ignored,
  // so the person gets neither a pane nor any text.
  expect(result).toEqual({});
  expect(
    classify({
      requested: true,
      placed: false,
      rendered: true,
      focusRequested: true,
      focusEvents: 0,
      keyDelivered: false,
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
      keyDelivered: false,
    }),
  ).toBe('render');
});

test('layers: a placed, rendered pane that receives no focus event is a focus failure', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-focus' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.invalidate', () => ({ value: undefined }));
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
  const selected = await pane.find({ type: 'Button', text: '[All]', in: 'usage' });
  const layers: Layers = {
    requested: true,
    placed: true,
    rendered: (await pane.find({ type: 'Client', key: 'usage' })) !== undefined,
    focusRequested: selected?.props.autoFocus === true,
    // The engine never raised `ui.focus`: the host did not give the pane focus.
    focusEvents: focused.length,
    keyDelivered: false,
  };
  expect(layers.rendered).toBe(true);
  expect(layers.focusRequested).toBe(true);
  expect(layers.focusEvents).toBe(0);
  expect(classify(layers)).toBe('focus');
  await pane.unmount();
});

test('layers: focus that arrives but keys that never reach the Client is a key failure', async ($, on) => {
  mock.env(on, env);
  on('session.id', () => ({ value: 'layers-key' }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.invalidate', () => ({ value: undefined }));
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
  await $.ui.focus({ requestId: 'multi-usage', key: 'All' });
  // The host delivered focus but no key: the tab selection is unchanged.
  const stillAll = await pane.find({ type: 'Button', text: '[All]', in: 'usage' });
  const layers: Layers = {
    requested: true,
    placed: true,
    rendered: true,
    focusRequested: stillAll?.props.autoFocus === true,
    focusEvents,
    keyDelivered: stillAll === undefined,
  };
  expect(classify(layers)).toBe('key');
  await pane.unmount();
});

import assert from 'node:assert/strict';
import test from 'node:test';

// Load the actual Mod modules without requiring Claude's host-only type package
// in the offline TypeScript project. All runtime imports in these modules are erased types.
const hooksUrl = new URL('../../plugins/multi-core/hooks/usage.ts', import.meta.url);
const formatUrl = new URL('../../plugins/multi-core/hooks/usage-format.ts', import.meta.url);
const dashboard = {
  updatedAt: 'today',
  providers: [
    {
      id: 'cursor',
      name: 'Cursor',
      status: 'ready',
      summary: '$0.00 charged',
      details: ['native spend'],
    },
  ],
};

type Element = { type: string; props: Record<string, unknown>; children?: Element[] };
type PaneHook = (
  host: unknown,
  event: Record<string, unknown>,
  next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
) => Promise<Record<string, unknown>>;

const manyLines = {
  updatedAt: 'today',
  providers: [
    {
      id: 'cursor',
      name: 'Cursor',
      status: 'ready',
      summary: '$0.00 charged',
      details: ['native spend'],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      status: 'ready',
      summary: 'quota ok',
      details: Array.from({ length: 40 }, (_, index) => `detail ${index}`),
    },
  ],
};

function flatten(element: Element): Element[] {
  const children = element.children ?? [];
  return [element, ...(Array.isArray(children) ? children.flatMap((child) => flatten(child)) : [])];
}

/** The usage hooks over a fake engine that records every gateway read and pane call. */
async function paneHarness(options: { receiptsFail?: boolean; trace?: string[] } = {}) {
  const requests: string[] = [];
  const closed: string[] = [];
  let session = 'session/one';
  const factories = Object.fromEntries(
    ['Box', 'Text', 'Button'].map((name) => [
      name,
      (props: Record<string, unknown>): Element => {
        const { children, ...rest } = props;
        return {
          type: name,
          props: rest,
          children: Array.isArray(children)
            ? (children as Element[])
            : [{ type: 'Raw', props: { text: children } }],
        };
      },
    ]),
  );
  const engine = {
    env: {
      get: async (name: string) => {
        if (name === 'MULTI_UI_TRACE') {
          return options.trace ? '1' : undefined;
        }
        return name === 'MULTI_GATEWAY_TOKEN' ? 'secret' : 'http://localhost';
      },
    },
    session: { id: async () => session },
    http: {
      fetch: async (url: string) => {
        requests.push(url);
        if (url.includes('/receipts?')) {
          return options.receiptsFail
            ? { ok: false, text: '{}' }
            : {
                ok: true,
                text: JSON.stringify({
                  receipts: [
                    {
                      agentId: 'worker',
                      outcome: 'completed',
                      time: 'today',
                      requests: 1,
                      usage: { input_tokens: 2, output_tokens: 3 },
                    },
                  ],
                }),
              };
        }
        return { ok: true, text: JSON.stringify(manyLines) };
      },
    },
    ui: {
      open: async () => {},
      close: async (args: { id: string }) => {
        closed.push(args.id);
      },
      invalidate: () => {},
      log: (text: string) => {
        options.trace?.push(text);
      },
      resolve: async () => factories,
    },
  };
  const module = await import(hooksUrl.href);
  const hooks = new Map<string, PaneHook>();
  module.register((name: string, filter: unknown, hook?: PaneHook) => {
    hooks.set(name, typeof filter === 'function' ? (filter as PaneHook) : (hook as PaneHook));
  });
  const passed = { passed: true };
  const next = async () => passed;
  const call = (name: string, event: Record<string, unknown>) => {
    const hook = hooks.get(name);
    assert(hook, name);
    return hook(engine, event, next);
  };
  const pane = { requestId: 'multi-usage', component: 'Pane' };
  return {
    requests,
    closed,
    passed,
    setSession: (value: string) => {
      session = value;
    },
    open: () => call('command.run', { args: '' }),
    focus: (element: string | undefined) =>
      call('ui.focus', { ...pane, ...(element ? { element } : {}), origin: 'keyboard' }),
    press: (element: string) => call('ui.press', { ...pane, element, surface: 'terminal' }),
    scroll: (by: number, bodyRows = 12) =>
      call('ui.scroll', { ...pane, by, bodyRows, offset: 0, contentRows: 99, origin: 'keyboard' }),
    close: () => call('ui.close', { id: 'multi-usage' }),
    draw: async (extra: Record<string, unknown> = {}) => {
      const tree = await call('ui.render', {
        ...pane,
        surface: 'terminal',
        props: { bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 } },
        ...extra,
      });
      return tree === passed ? undefined : flatten(tree as unknown as Element);
    },
  };
}

const textOf = (element: Element) =>
  (element.children ?? []).map((child) => String(child.props.text ?? '')).join('');
const buttons = (tree: Element[] | undefined) =>
  (tree ?? []).filter((item) => item.type === 'Button');
const footer = (tree: Element[] | undefined) =>
  (tree ?? []).map(textOf).find((text) => / of \d+ · /.test(text));

test('the pane is drawn from hook state: Buttons, and only the selected tab asks for focus', async () => {
  const harness = await paneHarness();
  await harness.open();
  const tree = await harness.draw();
  const keys = buttons(tree).map((button) => button.props.key);
  assert.deepEqual(keys, [
    'tab:all',
    'provider:cursor',
    'provider:openai',
    'tab:receipts',
    'action:quota-advice',
    'action:page-up',
    'action:page-down',
    'action:refresh',
    'action:close',
  ]);
  const focusAsked = buttons(tree).filter((button) => button.props.autoFocus === true);
  assert.deepEqual(
    focusAsked.map((button) => button.props.key),
    ['tab:all'],
  );
  assert(
    !buttons(tree).some((button) => 'autoFocus' in button.props && button.props.autoFocus !== true),
  );
  assert(!JSON.stringify(tree).includes('Client'));
});

test('focus on a tab selects it and resets the scroll; focus elsewhere changes nothing', async () => {
  const harness = await paneHarness();
  await harness.open();
  await harness.focus('provider:openai');
  assert.equal(footer(await harness.draw()), '1–4 of 42 · Tab moves between controls');
  await harness.scroll(10);
  assert.equal(footer(await harness.draw()), '11–14 of 42 · Tab moves between controls');
  await harness.focus('provider:cursor');
  const cursor = await harness.draw();
  assert(
    buttons(cursor).some(
      (button) => button.props.key === 'provider:cursor' && button.props.autoFocus === true,
    ),
  );
  assert.match(footer(cursor) ?? '', /^1–/);
  // The engine's own stops, a control that is not a tab, and a refused move leave the page alone.
  await harness.focus(undefined);
  await harness.focus('action:refresh');
  assert(
    buttons(await harness.draw()).some(
      (button) => button.props.key === 'provider:cursor' && button.props.autoFocus === true,
    ),
  );
  assert.equal(harness.requests.length, 1);
});

test('scrolling stays within the page', async () => {
  const harness = await paneHarness();
  await harness.open();
  await harness.focus('provider:openai');
  await harness.scroll(1000);
  assert.equal(footer(await harness.draw()), '39–42 of 42 · Tab moves between controls');
  await harness.scroll(-1000);
  assert.match(footer(await harness.draw()) ?? '', /^1–4 of 42/);
  await harness.press('action:page-down');
  assert.match(footer(await harness.draw()) ?? '', /^4–7 of 42/);
  await harness.press('action:page-up');
  assert.match(footer(await harness.draw()) ?? '', /^1–4 of 42/);
});

test('receipts load once on first selection; Refresh reloads the page that is shown', async () => {
  const harness = await paneHarness();
  await harness.open();
  assert.equal(harness.requests.length, 1);
  await harness.focus('tab:receipts');
  assert.equal(harness.requests.length, 2);
  assert(harness.requests[1].includes('/multi/mod/receipts?sessionId=session%2Fone'));
  assert((await harness.draw())?.map(textOf).some((text) => text.startsWith('worker · completed')));
  await harness.focus('tab:all');
  await harness.focus('tab:receipts');
  assert.equal(harness.requests.length, 2);
  await harness.press('action:refresh');
  assert(harness.requests[2].includes('/multi/mod/receipts?'));
  await harness.press('tab:all');
  await harness.press('action:refresh');
  assert(harness.requests[3].includes('view=providers&refresh=true&sessionId=session%2Fone'));
  assert.equal(harness.requests.length, 4);
});

test('a receipts failure says so, keeps the providers, and is tried again on the next selection', async () => {
  const harness = await paneHarness({ receiptsFail: true });
  await harness.open();
  await harness.focus('tab:receipts');
  const failed = await harness.draw();
  assert(failed?.map(textOf).includes('Could not load receipts.'));
  await harness.focus('tab:all');
  assert(buttons(await harness.draw()).some((button) => button.props.key === 'provider:openai'));
  await harness.focus('tab:receipts');
  assert.equal(harness.requests.filter((url) => url.includes('/receipts?')).length, 2);
});

test('the pane ignores another pane, another surface and elements that are not its own', async () => {
  const harness = await paneHarness();
  await harness.open();
  assert.equal(await harness.draw({ requestId: 'another-pane' }), undefined);
  assert.equal(await harness.draw({ surface: 'sdk' }), undefined);
  await harness.press('provider:unknown');
  await harness.press('someone-elses-button');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.closed.length, 0);
  assert(
    buttons(await harness.draw()).some(
      (button) => button.props.key === 'tab:all' && button.props.autoFocus === true,
    ),
  );
});

test('UI trace records focus, scroll and close as metadata and names no session', async () => {
  const lines: string[] = [];
  const secret = 'session/one';
  const harness = await paneHarness({ trace: lines });
  await harness.open();
  await harness.focus('provider:openai');
  await harness.scroll(5);
  await harness.press('action:refresh');
  await harness.close();
  const parsed = lines.map((line) => JSON.parse(line.replace(/^multi-usage /, '')));
  assert.deepEqual(
    parsed.filter((line) => line.event !== 'ui.render'),
    [
      { event: 'pane.open', requested: true, placed: true },
      { event: 'ui.focus', requestId: 'multi-usage', element: 'provider:openai' },
      { event: 'ui.scroll', requestId: 'multi-usage', by: 5 },
      {
        event: 'ui.press',
        surface: 'terminal',
        requestId: 'multi-usage',
        element: 'action:refresh',
      },
      { event: 'ui.close', requestId: 'multi-usage' },
    ],
  );
  const all = lines.join('\n');
  for (const text of [secret, encodeURIComponent(secret), 'secret', 'native spend', 'quota ok']) {
    assert(!all.includes(text), text);
  }
});

test('Close closes the pane and forgets its state; a host close does too', async () => {
  const harness = await paneHarness();
  await harness.open();
  await harness.press('action:close');
  assert.deepEqual(harness.closed, ['multi-usage']);
  assert.equal(await harness.draw(), undefined);
  await harness.open();
  assert((await harness.draw()) !== undefined);
  await harness.close();
  assert.equal(await harness.draw(), undefined);
});

test('pane state is kept per session, capped, and dropped when the session goes', async () => {
  const harness = await paneHarness();
  const module = await import(hooksUrl.href);
  harness.setSession('first');
  await harness.open();
  await harness.focus('provider:openai');
  harness.setSession('second');
  await harness.open();
  harness.setSession('first');
  assert(
    buttons(await harness.draw()).some(
      (button) => button.props.key === 'provider:openai' && button.props.autoFocus === true,
    ),
  );
  module.forgetUsageSession('first');
  assert.equal(await harness.draw(), undefined);
  for (let index = 0; index < 17; index++) {
    harness.setSession(`many-${index}`);
    await harness.open();
  }
  harness.setSession('many-0');
  assert.equal(await harness.draw(), undefined);
  harness.setSession('many-16');
  assert((await harness.draw()) !== undefined);
});
test('quota advice is opt-in, session scoped, advisory and removed on detach', async () => {
  const module = await import(hooksUrl.href);
  let session = 'advice-one';
  let reads = 0;
  let available = true;
  const engine = {
    env: {
      get: async (name: string) => (name === 'MULTI_GATEWAY_TOKEN' ? 'secret' : 'http://localhost'),
    },
    session: { id: async () => session, model: async () => 'claude-sonnet-5' },
    http: {
      fetch: async () => {
        reads++;
        return { ok: available, text: JSON.stringify(dashboard) };
      },
    },
    ui: { open: async () => {}, invalidate: () => {} },
  };
  type Hook = (
    host: typeof engine,
    event: Record<string, unknown>,
    next: (event: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>;
  const hooks = new Map<string, Hook>();
  module.register((name: string, filter: unknown, handler?: Hook) => {
    hooks.set(name, typeof filter === 'function' ? (filter as Hook) : (handler as Hook));
  });
  const submit = hooks.get('classic.PreToolUse');
  const command = hooks.get('command.run');
  const press = hooks.get('ui.press');
  assert(submit && command && press);
  const next = async (event: Record<string, unknown>) => ({
    ...event,
    additionalContext: ['existing context'],
    ask: 'Existing permission review',
  });
  const prompt = {
    tool: 'Agent',
    tool_use_id: 'call-1',
    prompt: 'Delegate this task',
    model: 'chosen-model',
    subagent_type: 'cursor',
  };
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, 0);
  await command(engine, { args: '' }, next);
  const toggle = {
    requestId: 'multi-usage',
    component: 'Pane',
    surface: 'terminal',
    element: 'action:quota-advice',
  };
  await press(engine, toggle, next);
  const readsBeforeSpawn = reads;
  const informed = await submit(engine, prompt, async (event) => {
    assert.equal(reads, readsBeforeSpawn + 1);
    assert.deepEqual(event, prompt);
    return next(event);
  });
  assert.equal(informed.model, prompt.model);
  assert.equal(informed.prompt, prompt.prompt);
  assert.equal(informed.ask, 'Existing permission review');
  const context = informed.additionalContext as string[];
  assert.equal(context[0], 'existing context');
  assert.match(context[1], /lowest subscription usage/);
  assert.match(context[1], /may choose a more-used model/);
  assert.match(context[1], /without waiting/);
  assert(!context[1].includes('native spend'));
  const readsBeforeSkipped = reads;
  for (const event of [
    { ...prompt, tool: 'Read' },
    { ...prompt, agentId: 'nested-worker' },
  ]) {
    assert.deepEqual(await submit(engine, event, next), await next(event));
  }
  assert.equal(reads, readsBeforeSkipped);
  const task = { ...prompt, tool: 'Task' };
  assert.equal(((await submit(engine, task, next)).additionalContext as string[]).length, 2);
  assert.equal(reads, readsBeforeSkipped + 1);
  const beforeOther = reads;
  session = 'advice-two';
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeOther);
  session = 'advice-one';
  available = false;
  assert.match(
    ((await submit(engine, prompt, next)).additionalContext as string[])[1],
    /could not be retrieved/,
  );
  await press(engine, toggle, next);
  const beforeDisabled = reads;
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeDisabled);
  await press(engine, toggle, next);
  module.forgetUsageSession(session);
  assert.deepEqual(await submit(engine, prompt, next), await next(prompt));
  assert.equal(reads, beforeDisabled);
  assert(!hooks.has('prompt.submit'));
});

test('receipt lines show unavailable usage as unavailable and leave unreported counts out', async () => {
  const { formatReceipts, renderUsageText } = await import(formatUrl.href);
  // Newest first: the ledger lists receipts oldest first.
  const [complete, mixed, unavailable] = formatReceipts({
    receipts: [
      {
        outcome: 'cancelled',
        incomplete: true,
        time: 't3',
        requests: 0,
        usage: { source: 'unavailable' },
        entries: [],
      },
      {
        agentId: 'w2',
        outcome: 'completed',
        time: 't2',
        requests: 2,
        usage: { source: 'mixed', input_tokens: 40, cache_read_input_tokens: 60 },
        entries: [],
      },
      {
        agentId: 'w1',
        outcome: 'completed',
        time: 't1',
        requests: 1,
        usage: { source: 'provider', input_tokens: 10, output_tokens: 0, reasoning_tokens: 4 },
        context: { source: 'provider', input_tokens: 10 },
        entries: [],
      },
    ],
  }).reduce((groups: string[][], line: string) => {
    if (line.startsWith('  ')) {
      groups[groups.length - 1].push(line);
    } else {
      groups.push([line]);
    }
    return groups;
  }, [] as string[][]);
  assert.equal(complete[0], 'w1 · completed · t1');
  assert.equal(
    complete[1],
    '  1 requests · context 10 · consumed 10 input · 0 output · 4 reasoning',
  );
  assert.equal(mixed[1], '  2 requests · consumed known input 40 · cached 60');
  assert.equal(unavailable[0], 'Main turn · cancelled (incomplete) · t3');
  assert.equal(unavailable[1], '  0 requests · consumed usage unavailable');
  assert.equal(formatReceipts({}), undefined);
  assert.equal(typeof renderUsageText, 'function');
});

test('renderUsageText needs only the dashboard data', async () => {
  const { renderUsageText } = await import(formatUrl.href);
  const text = renderUsageText({
    updatedAt: 'now',
    providers: [
      {
        id: 'grok',
        name: 'Grok Build',
        status: 'ready',
        summary: 'no quota',
        details: ['Source: estimate'],
        url: 'https://x.ai/build',
      },
    ],
  });
  assert.equal(
    text,
    [
      'Multi usage · account data checked now',
      '',
      'Grok Build [ready]',
      '  no quota',
      '  Source: estimate',
      '  https://x.ai/build',
    ].join('\n'),
  );
});

test('the usage views carry no host-specific branches or focus timers', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../../plugins/multi-core/hooks/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => /^usage.*\.ts$/.test(file))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /orca|TERM_PROGRAM/i, name);
    // The only timer is the request timeout; none may decide that focus failed.
    assert.doesNotMatch(source, /setInterval|no key|focus.?timeout/i, name);
  }
});

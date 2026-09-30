import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderUsageDashboard,
  type ProviderUsageView,
} from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import {
  createNativeGateway,
  type GatewayEvent,
} from '../../plugins/multi-core/src/gateway/server.ts';

const empty = () => new ReceiptLedger().snapshot();
test('provider dashboard reads every enabled provider and preserves unavailable quota status', async () => {
  const calls: string[] = [];
  const reader = (provider: string) => async (session: string) => {
    calls.push(`${provider}:${session}`);
    return { summary: `${provider} quota`, details: ['Account snapshot'] };
  };
  const dashboard = new ProviderUsageDashboard({
    enabled: ['openai', 'cursor', 'zen', 'antigravity'],
    openai: reader('openai'),
    cursor: reader('cursor'),
    zen: reader('zen'),
    antigravity: async () => ({
      summary: 'Native quota unavailable',
      details: ['No native quota connection'],
      status: 'unavailable',
    }),
  });
  const result = await dashboard.read('owned', empty());
  assert.deepEqual(calls.sort(), ['cursor:owned', 'openai:owned', 'zen:owned']);
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['ready', 'ready', 'ready', 'unavailable', 'disabled'],
  );
  assert.equal(result.providers[2].summary, 'zen quota');
  assert(result.providers[3].details.includes('No native quota connection'));
});

test('provider dashboard isolates errors and explicitly reports disabled and unsupported billing', async () => {
  const dashboard = new ProviderUsageDashboard({
    enabled: ['openai', 'cursor', 'zen'],
    openai: async () => ({ summary: 'quota', details: ['50% used'] }),
    cursor: async () => {
      throw new Error('secret token');
    },
  });
  const result = await dashboard.read('s', empty());
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['ready', 'error', 'unavailable', 'disabled', 'disabled'],
  );
  assert(!JSON.stringify(result).includes('secret'));
  assert(result.providers[2].details.some((line) => line.includes('billing console')));
});

test('provider dashboard coalesces reads, caches account data, refreshes and keeps session counts fresh', async () => {
  let calls = 0;
  let now = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['cursor'],
    now: () => now,
    cursor: async (session) => {
      calls++;
      return { summary: session, details: [] };
    },
  });
  const ledger = new ReceiptLedger();
  await Promise.all([
    dashboard.read('a', ledger.snapshot()),
    dashboard.read('a', ledger.snapshot(), true),
  ]);
  assert.equal(calls, 1);
  ledger.observe({
    route: 'cursor',
    session: 'a',
    usage: { input_tokens: 10, output_tokens: 20 },
    usageMetadata: { source: 'provider' },
  });
  const cached = await dashboard.read('a', ledger.snapshot('a'));
  assert.equal(calls, 1);
  assert(cached.providers[1].details.includes('Consumed: 10 input · 20 output'));
  assert(cached.providers[1].details.includes('Source: provider'));
  cached.providers[1].details.push('mutation');
  assert(!(await dashboard.read('a', empty())).providers[1].details.includes('mutation'));
  await dashboard.read('b', empty());
  assert.equal(calls, 2);
  await dashboard.read('a', empty(), true);
  assert.equal(calls, 3);
  now = 30001;
  await dashboard.read('a', empty());
  assert.equal(calls, 4);
});

test('provider menu route is authenticated, session scoped and read-only', async (t) => {
  let reads = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['cursor'],
    cursor: async (session) => {
      reads++;
      return { summary: session, details: [] };
    },
  });
  const server = createNativeGateway({
    token: 'secret',
    authFile: 'unused',
    usageDashboard: dashboard,
    fetchImpl: async () => {
      throw new Error('Menu must not infer');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=owned&view=providers`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(url, { headers: { 'x-multi-gateway-token': 'secret' } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as ProviderUsageView;
  assert.equal(body.providers[1].summary, 'owned');
  assert.equal(reads, 1);
});

const at = (
  route: 'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok',
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number },
  usageMetadata: NonNullable<GatewayEvent['usageMetadata']>,
  requestId: string,
): GatewayEvent => ({ route, session: 's', usage, usageMetadata, requestId });

const rowsFor = async (ledger: ReceiptLedger, enabled: readonly string[], fail = false) => {
  const dashboard = new ProviderUsageDashboard({
    enabled,
    ...(enabled.includes('cursor')
      ? {
          cursor: async () => {
            if (fail) {
              throw new Error('offline');
            }
            return { summary: 'quota', details: [] };
          },
        }
      : {}),
    ...(enabled.includes('openai')
      ? { openai: async () => ({ summary: 'quota', details: [] }) }
      : {}),
  });
  return (await dashboard.read('s', ledger.snapshot('s'))).providers;
};

test('a provider session shows context, consumption, reasoning, total and the cache read ratio', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    at(
      'openai',
      { input_tokens: 150, output_tokens: 200, cache_read_input_tokens: 800 },
      {
        source: 'provider',
        accounting: {
          input_tokens: 150,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
          reasoning_tokens: 120,
          total_tokens: 1200,
        },
      },
      'a',
    ),
  );
  const [openai] = await rowsFor(ledger, ['openai']);
  assert.equal(openai.session?.requests, 1);
  assert.equal(openai.session?.source, 'provider');
  assert.equal(openai.session?.consumed.cache_read_ratio, 0.8);
  assert.equal(openai.session?.consumed.reasoning_tokens, 120);
  assert.equal(openai.session?.context?.input_tokens, 150);
  assert.deepEqual(
    openai.details.filter((line) => /^(This session|Context|Consumed|Source)/.test(line)),
    [
      'This session: 1 completed requests',
      'Context: 150 input · 800 cache read · 50 cache write · prompt cache read ratio 80.0%',
      'Consumed: 150 input · 800 cache read · 50 cache write · 200 output · 120 reasoning · 1,200 total',
      'Source: provider',
    ],
  );
});

test('an unavailable session says so and never prints a zero', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    at('openai', { input_tokens: 0, output_tokens: 0 }, { source: 'unavailable' }, 'a'),
  );
  const [openai] = await rowsFor(ledger, ['openai']);
  assert.equal(openai.session?.source, 'unavailable');
  assert(openai.details.includes('Consumed: usage unavailable'));
  assert(openai.details.includes('Source: unavailable'));
  assert(!openai.details.some((line) => /Output: 0|Cache: 0|\b0 (input|output|cache)/.test(line)));
  assert(!openai.details.some((line) => line.includes('prompt cache read ratio')));
});

test('a mixed session shows known counts, the source and a telemetry warning, without a ratio', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    at(
      'openai',
      { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 60 },
      { source: 'provider' },
      'a',
    ),
  );
  ledger.observe(
    at('openai', { input_tokens: 0, output_tokens: 0 }, { source: 'unavailable' }, 'b'),
  );
  const [openai] = await rowsFor(ledger, ['openai']);
  assert.equal(openai.session?.source, 'mixed');
  assert(
    openai.details.includes('Consumed: known input 40 · known cache read 60 · known output 10'),
  );
  assert(openai.details.includes('Source: mixed'));
  assert(openai.details.some((line) => /did not report complete token telemetry/.test(line)));
  assert(!openai.details.some((line) => line.includes('prompt cache read ratio')));
});

test('an estimated session marks its ratio as estimated', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    at(
      'cursor',
      { input_tokens: 176, output_tokens: 5, cache_read_input_tokens: 824 },
      { source: 'estimate' },
      'a',
    ),
  );
  const [, cursor] = await rowsFor(ledger, ['cursor']);
  assert(
    cursor.details.some((line) => line.includes('prompt cache read ratio ~82.4% (estimated)')),
  );
  assert(cursor.details.includes('Source: estimate'));
});

test('a harness session reports its model calls beside the requests', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    at(
      'cursor',
      { input_tokens: 10, output_tokens: 2 },
      {
        source: 'provider',
        consumed_input_tokens: 100,
        consumed_output_tokens: 20,
        model_calls: 7,
      },
      'a',
    ),
  );
  ledger.observe(
    at(
      'cursor',
      { input_tokens: 10, output_tokens: 2 },
      { source: 'provider', consumed_input_tokens: 100, consumed_output_tokens: 20 },
      'b',
    ),
  );
  const [, cursor] = await rowsFor(ledger, ['cursor']);
  assert(cursor.details.includes('This session: 2 completed requests · 7 model calls'));
  assert.equal(cursor.session?.modelCalls, 7);
  assert(cursor.details.includes('Context: 10 input'));
  assert(cursor.details.includes('Consumed: 200 input · 40 output'));
});

test('a failed quota read still shows the session usage, and other rows are untouched', async () => {
  const ledger = new ReceiptLedger();
  ledger.observe(at('cursor', { input_tokens: 3, output_tokens: 2 }, { source: 'provider' }, 'a'));
  const rows = await rowsFor(ledger, ['openai', 'cursor'], true);
  const cursor = rows[1];
  assert.equal(cursor.status, 'error');
  assert(cursor.details.includes('Consumed: 3 input · 2 output'));
  assert.equal(cursor.session?.requests, 1);
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].session, undefined);
});

test('the provider route exposes the structured session beside the detail lines', async (t) => {
  const ledger = new ReceiptLedger();
  ledger.observe({
    route: 'cursor',
    session: 'owned',
    usage: { input_tokens: 3, output_tokens: 2 },
    usageMetadata: { source: 'provider' },
  });
  const dashboard = new ProviderUsageDashboard({
    enabled: ['cursor'],
    cursor: async () => ({ summary: 'quota', details: [] }),
  });
  const server = createNativeGateway({
    token: 'secret',
    authFile: 'unused',
    receipts: ledger,
    usageDashboard: dashboard,
    fetchImpl: async () => {
      throw new Error('Menu must not infer');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=owned&view=providers`;
  const body = (await (
    await fetch(url, { headers: { 'x-multi-gateway-token': 'secret' } })
  ).json()) as ProviderUsageView;
  const [openai, cursor] = body.providers;
  assert.equal(openai.session, undefined);
  assert.equal(cursor.session?.requests, 1);
  assert.equal(cursor.session?.consumed.input_tokens, 3);
  assert(cursor.details.includes('Consumed: 3 input · 2 output'));
  const other = (await (
    await fetch(url.replace('owned', 'other'), { headers: { 'x-multi-gateway-token': 'secret' } })
  ).json()) as ProviderUsageView;
  assert.equal(other.providers[1].session, undefined);
});

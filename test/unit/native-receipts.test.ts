import assert from 'node:assert/strict';
import test from 'node:test';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';

const completion: GatewayEvent = {
  route: 'openai',
  endpoint: 'responses',
  session: 'session-1',
  agentId: 'worker-7',
  model: 'gpt-6-astra',
  effort: 'high',
  stopReason: 'end_turn',
  tools: ['Read'],
  usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 },
  usageMetadata: { source: 'provider' },
};

test('ledger aggregates an invocation and ignores replayed usage', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    now: () => new Date(0),
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.observe({ ...completion, invocationId: 'turn-1' });
  ledger.observe({
    ...completion,
    invocationId: 'turn-1',
    route: 'zen',
    endpoint: 'chat/completions',
    model: 'zen-model',
    effort: 'low',
    usage: { input_tokens: 2, output_tokens: 3 },
    usageMetadata: { source: 'provider', replayed: true },
  });
  const before = ledger.snapshot();
  assert.equal(before.requests, 1);
  assert.equal(before.totals.output_tokens, 30);
  assert.equal(before.byModel['gpt-6-astra']?.output_tokens, 30);
  const receipt = ledger.complete(
    { session: 'session-1', agentId: 'worker-7', invocationId: 'turn-1' },
    'completed',
  );
  assert.ok(receipt);
  await ledger.drain();
  assert.equal(lines.length, 1);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.usage.source, 'provider');
  assert.equal(receipt.provenance, 'gateway');
  assert.equal(receipt.byEndpoint.responses?.input_tokens, 120);
  assert.equal(JSON.parse(lines[0]).outcome, 'completed');
  assert.equal(ledger.snapshot().requests, 1);
});

test('ledger emits unavailable usage for failed or cancelled invocations without a completion', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.start({ session: 's', agentId: 'a' });
  ledger.complete({ session: 's', agentId: 'a', invocationId: 'cancelled' }, 'cancelled');
  await ledger.drain();
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.outcome, 'cancelled');
  assert.deepEqual(receipt.usage, { source: 'unavailable' });
  assert.equal(receipt.incomplete, true);
});

test('session totals survive receipt history eviction and returned records are isolated', () => {
  const ledger = new ReceiptLedger({ maxRecent: 1 });
  for (const invocationId of ['one', 'two']) {
    ledger.observe(completion);
    ledger.complete({ ...completion, invocationId }, 'completed');
  }
  ledger.observe({ ...completion, session: 'other' });
  assert.equal(ledger.snapshot('session-1').requests, 2);
  assert.equal(ledger.snapshot('other').requests, 1);
  assert.equal(ledger.recent('session-1').length, 1);
  const recent = ledger.recent('session-1')[0];
  recent.byModel['gpt-6-astra'].input_tokens = 9000;
  assert.equal(ledger.recent('session-1')[0].byModel['gpt-6-astra'].input_tokens, 120);
});

test('receipts retain correlated sources and count each request and completion once', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  const event = {
    ...completion,
    requestId: 'request',
    usageMetadata: {
      source: 'provider' as const,
      reasoning_tokens: 10,
      total_tokens: 250,
    },
  };
  ledger.observe(event);
  ledger.observe(event);
  ledger.observe({ ...event, requestId: 'second' });
  ledger.observe({ ...completion, usageMetadata: { source: 'estimate' } });
  const ref = { ...completion, invocationId: 'turn' };
  ledger.complete(ref, 'completed');
  assert.equal(ledger.complete(ref, 'completed'), undefined);
  ledger.observe(event);
  await ledger.drain();
  assert.equal(lines.length, 1);
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.requests, 3);
  assert.equal(receipt.entries.length, 2);
  assert.equal(receipt.entries[0].requests, 2);
  assert.equal(receipt.entries[0].usage.reasoning_tokens, 20);
  assert.equal(receipt.entries[0].usage.total_tokens, 500);
  assert.equal(ledger.snapshot().requests, 3);
});

test('capacity and shutdown preserve incomplete receipts and failed writes do not block later ones', async () => {
  const errors: unknown[] = [];
  const lines: string[] = [];
  let attempts = 0;
  const ledger = new ReceiptLedger({
    maxInvocations: 1,
    onError: (error) => errors.push(error),
    writer: async (line) => {
      if (++attempts === 1) {
        throw new Error('disk full');
      }
      lines.push(line);
    },
  });
  ledger.start({ session: 's', agentId: 'first' });
  ledger.start({ session: 's', agentId: 'second' });
  ledger.finishAll();
  await ledger.drain();
  assert.equal(errors.length, 1);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).incomplete, true);
  assert.equal(JSON.parse(lines[0]).agentId, 'second');
  assert.equal(ledger.complete({ session: 's', agentId: 'unknown' }, 'completed'), undefined);
});

const usageOf = (
  usage: NonNullable<GatewayEvent['usage']>,
  usageMetadata: NonNullable<GatewayEvent['usageMetadata']>,
  extra: Partial<GatewayEvent> & { requestId?: string; invocationId?: string } = {},
): GatewayEvent => ({ ...completion, usage, usageMetadata, ...extra });

test('v2 totals keep an explicit zero and omit counts that were never reported', () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    usageOf(
      { input_tokens: 10, output_tokens: 0 },
      { source: 'provider', accounting: { input_tokens: 10, output_tokens: 0 } },
    ),
  );
  const totals = ledger.snapshot().totals;
  assert.equal(totals.source, 'provider');
  assert.equal(totals.input_tokens, 10);
  assert.equal(totals.output_tokens, 0);
  for (const key of [
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'reasoning_tokens',
    'total_tokens',
    'model_calls',
    'cache_read_ratio',
  ]) {
    assert.equal(key in totals, false, key);
  }
});

test('an unavailable event never adds the protocol placeholder zeros', () => {
  const ledger = new ReceiptLedger();
  ledger.observe(usageOf({ input_tokens: 0, output_tokens: 0 }, { source: 'unavailable' }));
  const snapshot = ledger.snapshot();
  assert.deepEqual(snapshot.totals, { source: 'unavailable' });
  assert.deepEqual(snapshot.entries[0]?.usage, { source: 'unavailable' });
  assert.deepEqual(snapshot.contexts?.openai, { source: 'unavailable' });
  assert.equal(snapshot.requests, 1);
});

test('provider merged with unavailable or estimate is mixed and keeps the known sums', () => {
  for (const other of ['unavailable', 'estimate'] as const) {
    const ledger = new ReceiptLedger();
    ledger.observe(
      usageOf(
        { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 60 },
        { source: 'provider' },
      ),
    );
    ledger.observe(usageOf({ input_tokens: 0, output_tokens: 0 }, { source: other }));
    const totals = ledger.snapshot().totals;
    assert.equal(totals.source, 'mixed', other);
    assert.equal(totals.input_tokens, 40);
    assert.equal(totals.cache_read_input_tokens, 60);
    assert.equal('cache_read_ratio' in totals, false, 'no ratio for mixed totals');
  }
});

test('accounting wins over the protocol usage and carries reasoning, total and the ratio', () => {
  const ledger = new ReceiptLedger();
  const event = (requestId: string, reasoning: number, total: number) =>
    usageOf(
      { input_tokens: 999, output_tokens: 999 },
      {
        source: 'provider',
        accounting: {
          input_tokens: 150,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 50,
          reasoning_tokens: reasoning,
          total_tokens: total,
        },
      },
      { requestId },
    );
  ledger.observe(event('a', 100, 1200));
  ledger.observe(event('b', 50, 300));
  const totals = ledger.snapshot().totals;
  assert.equal(totals.input_tokens, 300);
  assert.equal(totals.output_tokens, 400);
  assert.equal(totals.cache_read_input_tokens, 1600);
  assert.equal(totals.cache_creation_input_tokens, 100);
  assert.equal(totals.reasoning_tokens, 150);
  assert.equal(totals.total_tokens, 1500);
  assert.equal(totals.cache_read_ratio, 0.8);
});

test('harness consumed fields override the standard usage while the context keeps it', () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    usageOf(
      { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
      {
        source: 'provider',
        consumed_input_tokens: 500,
        consumed_output_tokens: 70,
        consumed_cache_read_tokens: 300,
        consumed_cache_creation_tokens: 20,
        model_calls: 4,
      },
      { route: 'cursor' },
    ),
  );
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.totals.input_tokens, 500);
  assert.equal(snapshot.totals.output_tokens, 70);
  assert.equal(snapshot.totals.cache_read_input_tokens, 300);
  assert.equal(snapshot.totals.cache_creation_input_tokens, 20);
  assert.equal(snapshot.totals.model_calls, 4);
  assert.deepEqual(snapshot.contexts?.cursor, {
    source: 'provider',
    input_tokens: 10,
    cache_read_input_tokens: 5,
    cache_read_ratio: 5 / 15,
  });
});

test('a legacy provider without an accounting block keeps the standard numbers', () => {
  const ledger = new ReceiptLedger();
  ledger.observe(
    usageOf(
      { input_tokens: 60, output_tokens: 15, cache_read_input_tokens: 40 },
      { source: 'provider' },
      { route: 'zen' },
    ),
  );
  const totals = ledger.snapshot().totals;
  assert.equal(totals.source, 'provider');
  assert.equal(totals.input_tokens, 60);
  assert.equal(totals.output_tokens, 15);
  assert.equal(totals.cache_read_input_tokens, 40);
  assert.equal('cache_creation_input_tokens' in totals, false);
});

test('a cancellation after a completion keeps the known usage and marks the receipt incomplete', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.observe({ ...completion, invocationId: 'turn' });
  ledger.complete({ ...completion, invocationId: 'turn' }, 'cancelled');
  await ledger.drain();
  const receipt = JSON.parse(lines[0]);
  assert.equal(receipt.outcome, 'cancelled');
  assert.equal(receipt.incomplete, true);
  assert.equal(receipt.usage.source, 'provider');
  assert.equal(receipt.usage.input_tokens, 120);
  assert.equal(receipt.usage.output_tokens, 30);
});

test('receipt lines hold token counts and metadata only', async () => {
  const lines: string[] = [];
  const ledger = new ReceiptLedger({
    writer: async (line) => {
      lines.push(line);
    },
  });
  ledger.observe({ ...completion, invocationId: 'turn' });
  ledger.complete({ ...completion, invocationId: 'turn' }, 'completed');
  await ledger.drain();
  const keys = Object.keys(JSON.parse(lines[0])).sort();
  assert.deepEqual(keys, [
    'agentId',
    'byEffort',
    'byEndpoint',
    'byModel',
    'context',
    'entries',
    'id',
    'invocationId',
    'kind',
    'outcome',
    'provenance',
    'requests',
    'schemaVersion',
    'session',
    'startedAt',
    'time',
    'usage',
  ]);
});

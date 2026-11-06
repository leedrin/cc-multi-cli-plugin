import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import { ProviderUsageDashboard } from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import { parseOpenAIResponseUsage } from '../../plugins/multi-core/src/gateway/response-usage.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { preparePiRequest } from '../../plugins/multi-pi/src/gateway-request.ts';
import { ObservedUsage } from '../../plugins/multi-pi/src/usage.ts';
import { createNativeGateway } from './support/runtime.ts';

const canonical = (chunk: unknown) => {
  const observed = new ObservedUsage();
  observed.observe(chunk);
  return observed.canonical();
};

test('reads DeepSeek cache hit usage and subtracts cache reads from input', () => {
  assert.deepEqual(
    canonical({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 8,
        prompt_cache_hit_tokens: 40,
        total_tokens: 108,
      },
    }),
    {
      source: 'provider',
      inputTokens: 60,
      outputTokens: 8,
      cacheReadTokens: 40,
      totalTokens: 108,
      cacheReadRatio: 0.4,
      modelCalls: 1,
    },
  );
});

test('reads usage from the first choice', () => {
  assert.equal(
    canonical({ choices: [{ usage: { prompt_tokens: 12, completion_tokens: 2 } }] }).inputTokens,
    12,
  );
});

test('leaves absent usage unavailable and does not invent counts', () => {
  assert.deepEqual(canonical({ choices: [] }), { source: 'unavailable', modelCalls: 1 });
});

test('preserves explicitly reported zero output', () => {
  assert.equal(canonical({ usage: { completion_tokens: 0 } }).outputTokens, 0);
});

test('uses the last usage snapshot as a whole', () => {
  const observed = new ObservedUsage();
  observed.observe({ usage: { prompt_tokens: 10, completion_tokens: 3 } });
  observed.observe({ usage: { completion_tokens: 0 } });
  assert.deepEqual(observed.canonical(), { source: 'mixed', outputTokens: 0, modelCalls: 1 });
});

test('uses the first available cache field in documented priority order', () => {
  const allCandidates = canonical({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 20 },
      prompt_cache_hit_tokens: 30,
      cached_tokens: 40,
    },
  });
  assert.equal(allCandidates.cacheReadTokens, 20);
  assert.equal(allCandidates.inputTokens, 80);

  const secondCandidate = canonical({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 30,
      cached_tokens: 40,
    },
  });
  assert.equal(secondCandidate.cacheReadTokens, 30);
  assert.equal(secondCandidate.inputTokens, 70);

  const thirdCandidate = canonical({
    usage: { prompt_tokens: 100, completion_tokens: 1, cached_tokens: 40 },
  });
  assert.equal(thirdCandidate.cacheReadTokens, 40);
  assert.equal(thirdCandidate.inputTokens, 60);

  const explicitZero = canonical({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 30,
    },
  });
  assert.equal(explicitZero.cacheReadTokens, 0);
  assert.equal(explicitZero.inputTokens, 100);
});

test('maps partial Pi usage with the existing OpenAI usage accounting rules', () => {
  const pi = canonical({
    usage: {
      prompt_tokens: 20,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
    },
  });
  const existing = parseOpenAIResponseUsage({
    input_tokens: 20,
    input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
  });
  assert.equal(pi.source, existing.source);
  assert.equal(pi.inputTokens, existing.inputTokens);
  assert.equal(pi.cacheReadTokens, existing.cacheReadTokens);
  assert.equal(pi.cacheWriteTokens, existing.cacheWriteTokens);
});

test('ignores malformed chunks without throwing and keeps only valid usage snapshots', () => {
  const observed = new ObservedUsage();
  assert.doesNotThrow(() => observed.observe(null));
  assert.doesNotThrow(() => observed.observe({ choices: 'bad' }));
  assert.equal(observed.canonical().source, 'unavailable');
  observed.observe({ usage: { prompt_tokens: 'bad', completion_tokens: 2, reasoning_tokens: 3 } });
  assert.deepEqual(observed.canonical(), { source: 'mixed', outputTokens: 2, modelCalls: 1 });
});

test('filters invalid token counts without throwing and preserves accounting source', () => {
  const invalidCounts: unknown[] = [Number.NaN, -1, Number.POSITIVE_INFINITY, '2'];
  for (const value of invalidCounts) {
    const promptOnly = new ObservedUsage();
    assert.doesNotThrow(() => promptOnly.observe({ usage: { prompt_tokens: value } }));
    assert.deepEqual(promptOnly.canonical(), { source: 'unavailable', modelCalls: 1 });

    const coreCounts = new ObservedUsage();
    assert.doesNotThrow(() =>
      coreCounts.observe({
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: value },
      }),
    );
    assert.deepEqual(coreCounts.canonical(), {
      source: 'provider',
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      modelCalls: 1,
    });

    const details = new ObservedUsage();
    assert.doesNotThrow(() =>
      details.observe({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: value, cache_write_tokens: value },
          completion_tokens_details: { reasoning_tokens: value },
        },
      }),
    );
    assert.deepEqual(details.canonical(), {
      source: 'provider',
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      modelCalls: 1,
    });
  }
});

test('maps a complete Pi usage snapshot including reasoning and cache writes', () => {
  assert.deepEqual(
    canonical({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    }),
    {
      source: 'provider',
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      totalTokens: 120,
      cacheReadRatio: 0.4,
      modelCalls: 1,
    },
  );
});

test('Pi usage stays numerically consistent through gateway events, receipts, and dashboard', async (t) => {
  const registry = createBuiltinRegistry();
  const descriptor = registry.get('deepseek');
  assert.ok(descriptor?.kind === 'direct' && descriptor.direct);
  descriptor.direct.prepare = (request) =>
    preparePiRequest(request, 'fake-key', {
      loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
    });
  const events: GatewayEvent[] = [];
  const receipts = new ReceiptLedger();
  const server = createNativeGateway({
    registry,
    token: 'usage-test-token',
    receipts,
    onEvent: (event) => events.push(event),
    fetchImpl: async () =>
      new Response(
        `${[
          { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
          { choices: [{ delta: { content: 'ok' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
              completion_tokens_details: { reasoning_tokens: 5 },
            },
          },
        ]
          .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
          .join('')}data: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': 'usage-test-token',
      'x-claude-code-session-id': 'usage-session',
    },
    body: JSON.stringify({
      model: 'multi/deepseek/deepseek-v4-pro',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'usage fixture' }],
    }),
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const event = events.find(({ usageMetadata }) => usageMetadata?.accounting);
  assert.ok(event?.usageMetadata?.accounting);
  const expected = {
    input_tokens: 50,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
    reasoning_tokens: 5,
    total_tokens: 120,
    cache_read_ratio: 0.4,
  };
  assert.deepEqual(event.usageMetadata.accounting, expected);
  const snapshot = receipts.snapshot('usage-session');
  assert.deepEqual(snapshot.entries[0]?.usage, {
    source: 'provider',
    ...expected,
  });
  const dashboard = new ProviderUsageDashboard({ enabled: ['deepseek'] });
  const row = (await dashboard.read('usage-session', snapshot)).providers.find(
    ({ id }) => id === 'deepseek',
  );
  assert.deepEqual(row?.session?.consumed, snapshot.entries[0]?.usage);
});

test('does not receive Pi summary usage, message usage, or cost', () => {
  const unavailable = canonical({
    usage: {
      input: 10,
      output: 3,
      cacheRead: 4,
      cacheWrite: 2,
      totalTokens: 13,
      cost: { total: 1 },
    },
    message: { usage: { input: 10, output: 3, totalTokens: 13 } },
    cost: { total: 1 },
  });
  assert.deepEqual(unavailable, { source: 'unavailable', modelCalls: 1 });
  assert.equal('cost' in unavailable, false);

  const rawOnly = canonical({
    usage: { prompt_tokens: 1, completion_tokens: 2 },
    message: { usage: { input: 90, output: 80, totalTokens: 170 } },
    cost: { total: 999 },
  });
  assert.deepEqual(rawOnly, {
    source: 'provider',
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    modelCalls: 1,
  });
  assert.equal('cost' in rawOnly, false);
});

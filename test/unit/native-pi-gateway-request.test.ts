import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { ContentBlock } from '../../plugins/multi-core/src/gateway/messages.ts';
import type { ProviderRequestInput } from '../../plugins/multi-core/src/gateway/provider-request.ts';
import { estimateTextTokens } from '../../plugins/multi-core/src/gateway/tokens.ts';
import { PI_DEEPSEEK_MODELS } from '../../plugins/multi-pi/src/catalog.ts';
import { preparePiRequest } from '../../plugins/multi-pi/src/gateway-request.ts';
import { encodePiSignature } from '../../plugins/multi-pi/src/signature.ts';
import { createNativeGateway } from './support/runtime.ts';

const route = 'multi/deepseek/deepseek-v4-pro';
const input = (overrides: Partial<ProviderRequestInput> = {}): ProviderRequestInput => ({
  method: 'POST',
  pathname: '/v1/messages',
  body: { model: route, max_tokens: 1234, messages: [{ role: 'user', content: 'hello' }] },
  session: 'session',
  fallbackSession: 'fallback',
  ...overrides,
});
const first = { type: 'start', partial: {} } as AssistantMessageEvent;
const thinkingText = 'reasoning history with enough text to count accurately';

function thinkingBlock(thinking = thinkingText, signedRoute = route): ContentBlock {
  return {
    type: 'thinking',
    thinking,
    signature: encodePiSignature(signedRoute, { thinking, thinkingSignature: 'opaque' }),
  };
}

function historyBody(thinking: ContentBlock[] = []): ProviderRequestInput['body'] {
  return {
    ...input().body,
    messages: [
      {
        role: 'assistant',
        content: [...thinking, { type: 'text', text: 'previous answer' }],
      },
      { role: 'user', content: 'continue' },
    ],
  };
}

function historyTokens(thinking: ContentBlock[] = []): number {
  return preparePiRequest(input({ body: historyBody(thinking) }), 'fake-key').inputTokens();
}

function loader(openPiStream: (request: Record<string, unknown>) => unknown) {
  return async () => ({ openPiStream }) as never;
}

test('Pi request rejects unsupported methods, paths and curated-unknown model IDs', () => {
  assert.throws(() => preparePiRequest(input({ method: 'GET' }), 'fake-key'), /requires POST/);
  assert.throws(
    () => preparePiRequest(input({ pathname: '/v1/other' }), 'fake-key'),
    /requires POST/,
  );
  assert.throws(
    () =>
      preparePiRequest(
        input({ body: { ...input().body, model: 'multi/deepseek/unknown' } }),
        'fake-key',
      ),
    /Unknown DeepSeek model/,
  );
});

test('counting is lazy, estimates translated history and never loads Pi backend', () => {
  let loads = 0;
  const prepared = preparePiRequest(input(), 'fake-key', {
    loadBackend: async () => {
      loads += 1;
      throw new Error('should not load');
    },
  });
  assert.equal(prepared.label, 'DeepSeek');
  assert.equal(prepared.route, 'deepseek');
  assert.equal(prepared.endpoint, 'chat/completions');
  assert(prepared.inputTokens() > 0);
  assert.equal(prepared.inputTokens(), prepared.inputTokens());
  assert.equal(loads, 0);
});

test('Pi signed thinking history is counted and opens through the real backend', async () => {
  const body = historyBody([thinkingBlock()]);
  const baseline = historyTokens();
  const prepared = preparePiRequest(input({ body }), 'fake-key', {
    loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
  });
  assert.equal(prepared.inputTokens(), baseline + estimateTextTokens(thinkingText));
  let fetchCalls = 0;
  const opened = await prepared.open(new AbortController().signal, async () => {
    fetchCalls += 1;
    return new Response(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
      { status: 200 },
    );
  });
  assert.equal(opened.ok, true);
  if (opened.ok) {
    await opened.translate(undefined, () => {});
  }
  assert.equal(fetchCalls, 1);
});

test('Pi thinking estimate counts merged retained thinking exactly once', () => {
  const baseline = historyTokens();
  // Matching opaque signatures merge before tokenization; a split inside a word
  // distinguishes tokenizing the retained merged text from each original block.
  const fragments = ['hel', 'lo'];
  assert.notEqual(
    fragments.reduce((total, text) => total + estimateTextTokens(text), 0),
    estimateTextTokens(fragments.join('')),
  );
  assert.equal(
    historyTokens(fragments.map((text) => thinkingBlock(text))),
    baseline + estimateTextTokens(fragments.join('')),
  );
});

for (const [name, block] of [
  ['foreign-prefix', { ...thinkingBlock(), signature: 'multiopenai:foreign-opaque-state' }],
  ['other-route', thinkingBlock(thinkingText, 'multi/deepseek/deepseek-v4-flash')],
] as const) {
  test(`Pi thinking estimate excludes ${name} signatures`, () => {
    assert.equal(historyTokens([block]), historyTokens());
    assert.equal(
      historyTokens([thinkingBlock('reason'), block, thinkingBlock('ing')]),
      historyTokens() + estimateTextTokens('reasoning'),
    );
  });
}

test('Pi signed history count_tokens matches exact estimate without loading backend', async (t) => {
  let loads = 0;
  const deps = {
    loadBackend: async () => {
      loads += 1;
      throw new Error('count_tokens must not load backend');
    },
  };
  const body = historyBody([thinkingBlock()]);
  const expected = historyTokens() + estimateTextTokens(thinkingText);
  assert.equal(preparePiRequest(input({ body }), 'fake-key', deps).inputTokens(), expected);
  const prepared = preparePiRequest(
    input({ body, pathname: '/v1/messages/count_tokens' }),
    'fake-key',
    deps,
  );
  assert.equal(prepared.inputTokens(), expected);
  assert.equal(prepared.inputTokens(), expected);
  const registry = createBuiltinRegistry();
  const deepseek = registry.get('deepseek');
  assert.ok(deepseek?.kind === 'direct' && deepseek.direct);
  let prepares = 0;
  deepseek.direct.prepare = (request) => {
    prepares += 1;
    assert.equal(request.pathname, '/v1/messages/count_tokens');
    return preparePiRequest(request, 'fake-key', deps);
  };
  const server = createNativeGateway({
    token: 'local-test-secret',
    registry,
    fetchImpl: async () => assert.fail('count_tokens must not fetch upstream'),
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
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': 'local-test-secret',
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-multi-token-count'), 'estimate');
  assert.deepEqual(await response.json(), { input_tokens: expected });
  assert.equal(prepares, 1);
  assert.equal(loads, 0);
});

for (const pathname of ['/v1/messages', '/v1/messages/count_tokens']) {
  test(`Pi rejects damaged same-route thinking on ${pathname}`, () => {
    const block = thinkingBlock();
    block.signature = `${block.signature?.split(':').slice(0, -1).join(':')}:broken`;
    assert.throws(
      () => preparePiRequest(input({ pathname, body: historyBody([block]) }), 'fake-key'),
      /Invalid Pi thinking signature/,
    );
  });
}

test('Pi open forwards effort, options, gateway fetch and raw usage observer lazily', async () => {
  let seen: Record<string, unknown> | undefined;
  const prepared = preparePiRequest(
    input({
      body: {
        ...input().body,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      },
    }),
    'fake-key',
    {
      loadBackend: loader((request) => {
        seen = request;
        (request.onProviderStreamEvent as (chunk: unknown) => void)({
          usage: { prompt_tokens: 20, completion_tokens: 2, prompt_cache_hit_tokens: 5 },
        });
        return {
          first,
          stream: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'done', reason: 'stop', message: { content: [] } };
            },
          },
        };
      }),
    },
  );
  let fetchCalls = 0;
  const opened = await prepared.open(new AbortController().signal, async () => {
    fetchCalls += 1;
    return new Response();
  });
  assert.equal(opened.ok, true);
  assert.equal(fetchCalls, 0, 'the injected backend event stream owns fetch');
  assert.equal(seen?.apiKey, 'fake-key');
  assert.equal(seen?.reasoningEffort, 'high');
  assert.deepEqual(seen?.options, { maxTokens: 1234 });
  const translated = await opened.translate(undefined, () => {});
  assert.equal(translated.content[0]?.type, 'text');
  assert.equal(
    translated.content[0]?.text,
    '[DeepSeek] DeepSeek deepseek-v4-pro does not support effort medium; using high.',
  );
  assert.deepEqual(translated.usage, {
    input_tokens: 15,
    output_tokens: 2,
    cache_read_input_tokens: 5,
  });
  assert.equal(translated.multi_usage?.source, 'provider');
});

test('real Pi SDK usage chunks reach translated gateway usage', async () => {
  const prepared = preparePiRequest(input(), 'fake-key', {
    loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
  });
  const payloads = [
    { id: 'chatcmpl-offline', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl-offline', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
    { id: 'chatcmpl-offline', choices: [{ delta: {}, finish_reason: 'stop' }] },
    {
      id: 'chatcmpl-offline',
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 7 },
    },
  ];
  const sse = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join('')}data: [DONE]\n\n`;
  const opened = await prepared.open(
    new AbortController().signal,
    async () =>
      new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    return;
  }
  const result = await opened.translate(undefined, () => {});
  assert.deepEqual(result.usage, {
    input_tokens: 13,
    output_tokens: 3,
    cache_read_input_tokens: 7,
  });
  assert.deepEqual(result.multi_usage, {
    source: 'provider',
    accounting: {
      input_tokens: 13,
      output_tokens: 3,
      cache_read_input_tokens: 7,
      cache_read_ratio: 0.35,
      total_tokens: 23,
    },
    total_tokens: 23,
    model: route,
  });
});

test('real Pi SDK without usage reports unavailable usage', async () => {
  const prepared = preparePiRequest(input(), 'fake-key', {
    loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
  });
  const sse = [
    { id: 'chatcmpl-no-usage', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
    { id: 'chatcmpl-no-usage', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
    { id: 'chatcmpl-no-usage', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
    .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
    .join('');
  const opened = await prepared.open(
    new AbortController().signal,
    async () =>
      new Response(`${sse}data: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  assert.equal(opened.ok, true);
  if (opened.ok) {
    const result = await opened.translate(undefined, () => {});
    assert.deepEqual(result.multi_usage, { source: 'unavailable', model: route });
  }
});

test('disabled thinking omits reasoning effort and carries explicit tool choice', async () => {
  let seen: Record<string, unknown> | undefined;
  const body = {
    ...input().body,
    thinking: { type: 'disabled' },
    tool_choice: { type: 'any' },
  };
  const prepared = preparePiRequest(input({ body }), 'fake-key', {
    loadBackend: loader((request) => {
      seen = request;
      return {
        first,
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'done', reason: 'stop', message: { content: [] } };
          },
        },
      };
    }),
  });
  await prepared.open(new AbortController().signal, async () => new Response());
  assert.equal(seen?.reasoningEffort, undefined);
  assert.deepEqual(seen?.options, { maxTokens: 1234, toolChoice: 'required' });
  assert.equal(
    PI_DEEPSEEK_MODELS.some(({ id }) => id === 'deepseek-v4-pro'),
    true,
  );
});

test('non-2xx typed Pi status maps without exposing body or losing retry-after', async () => {
  const error = Object.assign(new Error('DeepSeek returned HTTP 429.'), {
    name: 'PiUpstreamStatus',
    status: 429,
    retryAfter: '11',
  });
  const prepared = preparePiRequest(input(), 'fake-key', {
    loadBackend: loader(() => Promise.reject(error)),
  });
  assert.deepEqual(await prepared.open(new AbortController().signal, async () => new Response()), {
    ok: false,
    status: 429,
    retryAfter: '11',
  });
});

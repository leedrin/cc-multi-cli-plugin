import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import {
  BUILTIN_PROVIDERS,
  createBuiltinRegistry,
} from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type {
  ContentBlock,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  ProviderRegistry,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type { ProviderRequestInput } from '../../plugins/multi-core/src/gateway/provider-request.ts';
import { createNativeGateway as createGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { estimateTextTokens } from '../../plugins/multi-core/src/gateway/tokens.ts';
import { PI_DEEPSEEK_MODELS, PI_MODELS_BY_PROVIDER } from '../../plugins/multi-pi/src/catalog.ts';
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

test('GLM routes are provider-bound and similarly named routes never cross-match', () => {
  const international = preparePiRequest(
    input({
      body: {
        ...input().body,
        model: 'multi/zai/glm-5.3',
      },
    }),
    'fake-zai-key',
    { providerId: 'zai' },
  );
  const china = preparePiRequest(
    input({
      body: {
        ...input().body,
        model: 'multi/zai-coding-cn/glm-5.3',
      },
    }),
    'fake-cn-key',
    { providerId: 'zai-coding-cn' },
  );
  assert.equal(international.route, 'zai');
  assert.equal(international.label, 'Z.AI');
  assert.match(international.authHelp, /ZAI_API_KEY/);
  assert.equal(china.route, 'zai-coding-cn');
  assert.equal(china.label, 'Z.AI Coding (CN)');
  assert.match(china.authHelp, /ZAI_CODING_CN_API_KEY/);
  assert.throws(
    () =>
      preparePiRequest(
        input({
          body: {
            ...input().body,
            model: 'multi/zai-coding-cn/glm-5.3',
          },
        }),
        'fake-zai-key',
        { providerId: 'zai' },
      ),
    /Unknown Z.AI model/,
  );
  assert.throws(
    () =>
      preparePiRequest(
        input({
          body: {
            ...input().body,
            model: 'multi/zai/glm-5.3',
          },
        }),
        'fake-cn-key',
        { providerId: 'zai-coding-cn' },
      ),
    /Unknown Z.AI Coding \(CN\) model/,
  );
});

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

test('a registered fake provider receives and completes its routed model request', async (t) => {
  const fakeRegistry = new ProviderRegistry();
  fakeRegistry.registerMany(BUILTIN_PROVIDERS.filter(({ id }) => id !== 'strata'));
  const strata = BUILTIN_PROVIDERS.find(({ id }) => id === 'strata');
  assert.ok(strata?.direct);
  fakeRegistry.register(strata);
  const modelDescriptor = {
    identity: {
      providerId: 'strata',
      modelId: 'dispatch-fixture',
      routeId: 'multi/strata/dispatch-fixture',
      oneMillionContext: false,
    },
    label: 'Dispatch fixture',
    description: 'Fake direct model',
    protocol: 'custom' as const,
    capabilities: { text: true },
  };
  let prepareCalls = 0;
  let openCalls = 0;
  const expected: MessagesResponse = {
    id: 'fake-dispatch',
    type: 'message',
    role: 'assistant',
    model: 'dispatch-fixture',
    content: [{ type: 'text', text: 'fake provider dispatched' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  strata.direct = {
    ...strata.direct,
    prepare: () => {
      prepareCalls += 1;
      return {
        label: 'Fake Strata',
        authHelp: '',
        endpoint: 'fixture',
        route: 'strata',
        inputTokens: () => 1,
        requestEvent: () => ({ route: 'strata' }),
        failureEvent: () => ({ route: 'strata' }),
        open: async () => {
          openCalls += 1;
          return { ok: true, translate: async () => expected };
        },
      };
    },
  };
  const server = createGateway({
    token: 'fake-dispatch-token',
    runtime: new ProviderRuntime([{ descriptor: strata, models: [modelDescriptor] }], {
      registry: fakeRegistry,
    }),
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
  assert(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': 'fake-dispatch-token' },
    body: JSON.stringify({
      model: modelDescriptor.identity.routeId,
      messages: [{ role: 'user', content: 'dispatch' }],
    }),
  });
  assert.equal(response.status, 200);
  const actual = (await response.json()) as MessagesResponse;
  assert.deepEqual(actual.content, expected.content);
  assert.equal(prepareCalls, 1);
  assert.equal(openCalls, 1);
});

test('the same Pi request produces byte-identical upstream bodies with complete tool history', async () => {
  const longName = `mcp__fixture__${'search'.repeat(12)}`;
  const body = {
    ...input().body,
    system: [{ type: 'text', text: 'cached system', cache_control: { type: 'ephemeral' } }],
    // DD §12.3 follows toChat: supplied sampling parameters are not forwarded.
    temperature: 0.37,
    top_p: 0.63,
    top_k: 17,
    tools: [
      {
        name: longName,
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: longName, input: { query: 'stable' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: [
              { type: 'text', text: 'result' },
              { type: 'tool_reference', tool_name: longName },
            ],
          },
          { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
  const wireBodies: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const prepared = preparePiRequest(input({ body }), 'fake-key', {
      loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
    });
    const opened = await prepared.open(new AbortController().signal, async (_url, init) => {
      wireBodies.push(String(init?.body));
      const payloads = [
        { id: 'stable', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
        { id: 'stable', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
        { id: 'stable', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      const separator = String.fromCharCode(10);
      const sse = `${payloads.map((payload) => `data: ${JSON.stringify(payload)}${separator}${separator}`).join('')}data: [DONE]${separator}${separator}`;
      return new Response(sse, { status: 200 });
    });
    assert.equal(opened.ok, true);
    if (opened.ok) {
      await opened.translate(undefined, () => {});
    }
  }
  assert.equal(wireBodies.length, 2);
  assert.equal(wireBodies[0], wireBodies[1]);
  assert(!wireBodies[0]?.includes('cache_control'));
  const payload = JSON.parse(wireBodies[0] ?? 'null') as {
    temperature?: unknown;
    top_p?: unknown;
    top_k?: unknown;
    tools?: Array<{ function?: { strict?: boolean; name?: string } }>;
    messages?: Array<{
      tool_calls?: Array<{ function?: { name?: string } }>;
      content?: string | Array<{ text?: string }>;
    }>;
  };
  const alias = payload.tools?.[0]?.function?.name;
  assert.match(alias ?? '', /^multi_tool_[a-f0-9]{48}$/);
  assert.equal(payload.tools?.[0]?.function?.strict, false);
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.top_p, undefined);
  assert.equal(payload.top_k, undefined);
  assert.equal(
    payload.messages?.find(({ tool_calls }) => tool_calls)?.tool_calls?.[0]?.function?.name,
    alias,
  );
  assert(
    JSON.stringify(payload.messages).includes(`Available tool: ${alias}`),
    'tool_reference should be rendered as an available-tool text block',
  );
  assert(!wireBodies[0]?.includes('timestamp'));
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

test('Strata drops effort, binds route signature, and emits one notice', async () => {
  let seen: Record<string, unknown> | undefined;
  const strataModel = PI_MODELS_BY_PROVIDER.strata[0];
  assert.ok(strataModel);
  const prepared = preparePiRequest(
    input({
      body: {
        ...input().body,
        model: 'multi/strata/qwen3.8-flash-next',
        output_config: { effort: 'high' },
      },
    }),
    'local',
    {
      providerId: 'strata',
      baseUrl: 'http://127.0.0.1:8321/v1',
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
    },
  );
  assert.equal(prepared.route, 'strata');
  const result = await prepared.open(new AbortController().signal, async () => new Response());
  assert.equal(seen?.reasoningEffort, undefined);
  assert.equal(seen?.baseUrl, 'http://127.0.0.1:8321/v1');
  assert.ok(result.ok);
  if (result.ok) {
    const translated = await result.translate(undefined, () => {});
    assert.deepEqual(
      translated.content.filter((block) => block.type === 'text').map((block) => block.text),
      ['[Strata] qwen3.8-flash-next does not support effort; ignoring high.'],
    );
  }
  assert.equal(strataModel.id, 'qwen3.8-flash-next');
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

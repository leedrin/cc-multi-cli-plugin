import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { format } from 'node:util';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import { nativeEnvironment } from '../../plugins/multi-core/src/gateway/harness-process.ts';
import { ProviderRuntime } from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import { ProviderUsageDashboard } from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  gatewayEnvironment,
  workerCatalog,
  workerDefinitions,
} from '../../plugins/multi-core/src/launcher.ts';
import { PI_MODELS_BY_PROVIDER } from '../../plugins/multi-pi/src/catalog.ts';
import { preparePiRequest } from '../../plugins/multi-pi/src/gateway-request.ts';
import { bindPiProvider, discoverPiModels } from '../../plugins/multi-pi/src/provider.ts';
import { type PiLiveProvider, resolvePiLiveSelection } from '../live/native-pi.ts';

test('Pi live selection matches each provider catalog and feeds request and report', async () => {
  const providers = ['deepseek', 'zai-coding-cn', 'strata'] satisfies readonly PiLiveProvider[];
  const liveSource = readFileSync(new URL('../live/native-pi.ts', import.meta.url), 'utf8');
  assert.match(liveSource, /model:\s*selection\.model/);
  assert.match(liveSource, /model:\s*selection\.route/);
  for (const provider of providers) {
    const selection = resolvePiLiveSelection(provider);
    assert(
      PI_MODELS_BY_PROVIDER[provider].some(({ id }) => id === selection.model),
      `${selection.model} is not in the ${provider} catalog`,
    );
    assert.equal(selection.route, `multi/${provider}/${selection.model}`);
  }
});

const route = 'multi/deepseek/deepseek-v4-pro';
const canary = `sk-canary-${crypto.randomUUID()}`;
const upstreamMarker = `UPSTREAM-${crypto.randomUUID()}`;
const token = 'fake-gateway-token';
const baseBody = {
  model: route,
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'test prompt' }],
};
const registry = createBuiltinRegistry();
const descriptor = bindPiProvider({ apiKey: canary });
const registryDescriptor = registry.get('deepseek');
assert(registryDescriptor?.kind === 'direct' && registryDescriptor.direct);
descriptor.direct = registryDescriptor.direct;
descriptor.direct.prepare = (input) =>
  preparePiRequest(input, canary, {
    loadBackend: async () => await import('../../plugins/multi-pi/src/backend.ts'),
  });
const runtime = new ProviderRuntime([{ descriptor, models: [] }], { registry });
const sensitiveSurfaces: Array<[string, string]> = [];
const events: GatewayEvent[] = [];
const traceOutput: string[] = [];
const receiptLines: string[] = [];
const receipts = new ReceiptLedger({
  writer: async (line) => {
    receiptLines.push(line);
  },
});

function capture(name: string, value: unknown): void {
  sensitiveSurfaces.push([name, typeof value === 'string' ? value : JSON.stringify(value)]);
}

function assertNoSecrets(): void {
  assert(sensitiveSurfaces.length > 0, 'security collection surfaces must be non-empty');
  for (const [name, value] of sensitiveSurfaces) {
    assert(!value.includes(canary), `${name} exposed the canary key`);
    assert(!value.includes(upstreamMarker), `${name} exposed upstream response data`);
  }
}

async function start(fetchImpl: GatewayFetch) {
  const server = createNativeGateway({
    runtime,
    token,
    fetchImpl,
    receipts,
    onEvent: (event) => {
      events.push(event);
      // Equivalent to launcher.ts:1547-1550, wired at :472; approved T033 c test seam.
      if (process.env.MULTI_NATIVE_TRACE === '1') {
        const line = `[native] ${JSON.stringify(event)}\n`;
        traceOutput.push(line);
        process.stderr.write(line);
      }
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function call(url: string, body: unknown, pathname = '/v1/messages') {
  return fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': token,
      'x-claude-code-session-id': 'security-session',
    },
    body: JSON.stringify(body),
  });
}

function providerSse(events: unknown[]): Response {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(`${data}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('Pi gateway maps stream 401 to credential help before emitting any SSE content', async (t) => {
  let calls = 0;
  const fixture = await start(async () => {
    calls += 1;
    return new Response('UPSTREAM_AUTH_DETAIL', { status: 401 });
  });
  t.after(async () => {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });
  const response = await call(fixture.url, { ...baseBody, stream: true });
  const text = await response.text();
  assert.equal(response.status, 401);
  assert.match(text, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(text, /UPSTREAM_AUTH_DETAIL/);
  assert.doesNotMatch(
    text,
    /event: (message_start|content_block_start|content_block_delta|message_delta|message_stop)/,
  );
  assert.equal(calls, 1);
});

test('Pi gateway emits exactly one terminal pair with response usage at EOF', async (t) => {
  const fixture = await start(async () =>
    providerSse([
      { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'complete' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]),
  );
  t.after(async () => {
    fixture.server.closeAllConnections();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });
  const response = await call(fixture.url, { ...baseBody, stream: true });
  const text = await response.text();
  assert.equal(response.status, 200);
  const lines = text.split('\n');
  const events = lines
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length));
  assert.equal(events.filter((name) => name === 'message_delta').length, 1);
  assert.equal(events.filter((name) => name === 'message_stop').length, 1);
  assert.equal(events.at(-1), 'message_stop');
  const deltaLine = lines.indexOf('event: message_delta');
  const delta = JSON.parse(lines[deltaLine + 1]?.slice('data: '.length) ?? '{}');
  assert.equal(delta?.delta?.stop_reason, 'end_turn');
  assert.deepEqual(delta?.usage, { input_tokens: 12, output_tokens: 3 });
});

test('Pi gateway rejects document and Strata image inputs before backend loading or fetch', async (t) => {
  let documentLoads = 0;
  let documentFetches = 0;
  const documentRegistry = createBuiltinRegistry();
  const documentDescriptor = documentRegistry.get('deepseek');
  assert.ok(documentDescriptor?.direct);
  documentDescriptor.direct.prepare = (request) =>
    preparePiRequest(request, canary, {
      loadBackend: async () => {
        documentLoads += 1;
        return await import('../../plugins/multi-pi/src/backend.ts');
      },
    });
  const documentServer = createNativeGateway({
    runtime: new ProviderRuntime([{ descriptor: documentDescriptor, models: [] }], {
      registry: documentRegistry,
    }),
    token,
    fetchImpl: async () => {
      documentFetches += 1;
      return new Response();
    },
  });
  await new Promise<void>((resolve, reject) => {
    documentServer.once('error', reject);
    documentServer.listen(0, '127.0.0.1', resolve);
  });
  const documentAddress = documentServer.address();
  assert(documentAddress && typeof documentAddress === 'object');
  const documentFixture = {
    server: documentServer,
    url: `http://127.0.0.1:${documentAddress.port}`,
  };
  t.after(async () => {
    documentFixture.server.closeAllConnections();
    await new Promise<void>((resolve) => documentFixture.server.close(() => resolve()));
  });
  const documentResponse = await call(documentFixture.url, {
    ...baseBody,
    messages: [
      {
        role: 'user',
        content: [{ type: 'document', source: { type: 'text', data: 'PRIVATE_DOCUMENT_CONTENT' } }],
      },
    ],
  });
  const documentError = await documentResponse.text();
  assert.equal(documentResponse.status, 400);
  assert.match(documentError, /document/i);
  assert.doesNotMatch(documentError, /PRIVATE_DOCUMENT_CONTENT/);
  assert.equal(documentLoads, 0);
  assert.equal(documentFetches, 0);

  const strataRegistry = createBuiltinRegistry({
    piKeys: { strata: 'local' },
    strataBaseUrl: 'http://127.0.0.1:8321/v1',
  });
  const strataDescriptor = strataRegistry.get('strata');
  assert.ok(strataDescriptor?.direct);
  const strataRuntime = new ProviderRuntime([{ descriptor: strataDescriptor, models: [] }], {
    registry: strataRegistry,
  });
  let imageLoads = 0;
  let imageFetches = 0;
  strataDescriptor.direct.prepare = (request) =>
    preparePiRequest(request, 'local', {
      providerId: 'strata',
      baseUrl: 'http://127.0.0.1:8321/v1',
      loadBackend: async () => {
        imageLoads += 1;
        return await import('../../plugins/multi-pi/src/backend.ts');
      },
    });
  const strataServer = createNativeGateway({
    runtime: strataRuntime,
    token,
    fetchImpl: async () => {
      imageFetches += 1;
      return new Response();
    },
  });
  await new Promise<void>((resolve, reject) => {
    strataServer.once('error', reject);
    strataServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    strataServer.closeAllConnections();
    await new Promise<void>((resolve) => strataServer.close(() => resolve()));
  });
  const address = strataServer.address();
  assert(address && typeof address === 'object');
  const imageResponse = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
    body: JSON.stringify({
      model: 'multi/strata/qwen3.8-flash-next',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
          ],
        },
      ],
    }),
  });
  assert.equal(imageResponse.status, 400);
  assert.match(await imageResponse.text(), /image/i);
  assert.equal(imageLoads, 0);
  assert.equal(imageFetches, 0);
});

test('Pi full-flow security canary stays out of gateway outputs and errors', async (t) => {
  const originalEnv = { ...process.env };
  process.env.DEEPSEEK_API_KEY = canary;
  process.env.MULTI_NATIVE_TRACE = '1';
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  t.after(() => {
    for (const key of [
      'DEEPSEEK_API_KEY',
      'MULTI_NATIVE_TRACE',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    ]) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });
  const stderrOutput: string[] = [];
  const consoleOutput: string[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    stderrOutput.push(String(chunk));
    return true;
  });
  for (const method of [
    'debug',
    'error',
    'info',
    'log',
    'warn',
    'trace',
    'dir',
    'table',
  ] as const) {
    t.mock.method(console, method, (...args: unknown[]) => consoleOutput.push(format(...args)));
  }
  const toolId = `tool-${crypto.randomUUID()}`;
  const goodFetch: GatewayFetch = async (_url, init) => {
    const payload = JSON.parse(String(init.body)) as { tools?: unknown[] };
    if (payload.tools?.length) {
      return providerSse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: toolId,
                    type: 'function',
                    function: { name: 'echo', arguments: '{"text":"safe"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
      ]);
    }
    return providerSse([
      { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
      {
        choices: [{ delta: { reasoning_content: 'safe private reasoning' }, finish_reason: null }],
      },
      { choices: [{ delta: { content: 'safe answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
  };
  const { server, url } = await start(goodFetch);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const response = await call(url, baseBody);
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert(responseText.length > 0, 'successful client response must be collected');
  capture('client response', responseText);
  assert.match(responseText, /safe answer/);
  assert.match(responseText, /"stop_reason":"end_turn"/);
  const firstContent = (
    JSON.parse(responseText) as { content: Array<{ type?: string; signature?: string }> }
  ).content;
  const thinkingBlocks = firstContent.filter((block) => block.type === 'thinking');
  assert(thinkingBlocks.length > 0, 'thinking collection must be non-empty');
  assert(thinkingBlocks.every(({ signature }) => typeof signature === 'string'));
  const continuation = await call(url, {
    ...baseBody,
    messages: [
      { role: 'assistant', content: firstContent },
      { role: 'user', content: 'continue after signed thinking' },
    ],
  });
  assert.equal(continuation.status, 200);
  const continuationText = await continuation.text();
  assert(continuationText.length > 0, 'signed-thinking continuation must be collected');
  capture('signed thinking round-trip', continuationText);

  const tools = [
    {
      name: 'echo',
      description: 'Echo safe test input.',
      input_schema: { type: 'object', properties: { text: { type: 'string' } } },
    },
  ];
  const toolResponse = await call(url, { ...baseBody, tools });
  const toolText = await toolResponse.text();
  assert.equal(toolResponse.status, 200);
  assert(toolText.length > 0, 'tool-call response must be collected');
  capture('tool call', toolText);
  const toolContent = (JSON.parse(toolText) as { content: Array<{ type?: string; id?: string }> })
    .content;
  const toolUse = toolContent.find((block) => block.type === 'tool_use');
  assert.equal(toolUse?.id, toolId, 'tool call must survive translation');
  const toolFollowUp = await call(url, {
    ...baseBody,
    tools,
    messages: [
      { role: 'assistant', content: toolContent },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'safe' }] },
    ],
  });
  const toolFollowUpText = await toolFollowUp.text();
  assert(toolFollowUpText.length > 0, 'tool-result round-trip must be collected');
  capture('tool result round-trip', toolFollowUpText);

  const malformedArgument = '{"text":"RAW_TOOL_ARGUMENT_CANARY';
  const malformedFetch: GatewayFetch = async () =>
    providerSse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'malformed-tool-id',
                  type: 'function',
                  function: { name: 'echo', arguments: malformedArgument },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
  const malformed = await start(malformedFetch);
  t.after(async () => {
    malformed.server.closeAllConnections();
    await new Promise<void>((resolve) => malformed.server.close(() => resolve()));
  });
  const eventStart = events.length;
  const traceStart = traceOutput.length;
  const stderrStart = stderrOutput.length;
  const malformedResponse = await call(malformed.url, { ...baseBody, tools });
  const malformedText = await malformedResponse.text();
  assert(malformedText.length > 0, 'malformed tool response must be collected');
  assert(!malformedText.includes('"type":"tool_use"'));
  assert.notEqual(malformedResponse.status, 200);
  const malformedEvents = JSON.stringify(events.slice(eventStart));
  const malformedTrace = traceOutput.slice(traceStart).join('');
  const malformedLogs = stderrOutput.slice(stderrStart).join('');
  assert(malformedEvents.length > 0, 'malformed tool events must be collected');
  assert(malformedTrace.length > 0, 'malformed tool trace must be collected');
  const leakedForms = [
    malformedArgument,
    JSON.stringify(malformedArgument).slice(1, -1),
    'RAW_TOOL_ARGUMENT_CANARY',
  ];
  for (const text of [malformedText, malformedEvents, malformedTrace, malformedLogs]) {
    for (const form of leakedForms) {
      assert(!text.includes(form), `malformed tool argument leaked as ${form}`);
    }
  }
  assert(!malformedEvents.includes('"type":"tool_use"'));
  capture('malformed tool argument response', malformedText);
  capture(
    'malformed tool argument events and trace',
    `${malformedEvents}${malformedTrace}${malformedLogs}`,
  );

  const streamed = await call(url, { ...baseBody, stream: true });
  const sseText = await streamed.text();
  assert.equal(streamed.status, 200);
  assert(sseText.length > 0, 'client SSE collector must be non-empty');
  capture('client SSE', sseText);
  assert.match(sseText, /safe answer/);
  const failedStatuses = [401, 403, 500];
  for (const status of failedStatuses) {
    const failing = await start(
      async () => new Response(`${upstreamMarker} ${canary}`, { status }),
    );
    t.after(async () => {
      failing.server.closeAllConnections();
      await new Promise<void>((resolve) => failing.server.close(() => resolve()));
    });
    const failed = await call(failing.url, baseBody);
    const text = await failed.text();
    assert.equal(failed.status, status);
    assert(text.length > 0, `HTTP ${status} error body must be collected`);
    capture(`HTTP ${status} error`, text);
  }

  const network = await start(async () => {
    throw new Error(`${upstreamMarker} ${canary}`);
  });
  t.after(async () => {
    network.server.closeAllConnections();
    await new Promise<void>((resolve) => network.server.close(() => resolve()));
  });
  const networkResponse = await call(network.url, baseBody);
  const networkText = await networkResponse.text();
  assert(networkText.length > 0, 'network error response must be collected');
  capture('network error', networkText);

  const streamFailure = await start(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
                  'data: {"choices":[{"delta":{"content":"stream prefix"},"finish_reason":null}]}\n\n',
              ),
            );
            setImmediate(() => controller.error(new Error(`${upstreamMarker} ${canary}`)));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  t.after(async () => {
    streamFailure.server.closeAllConnections();
    await new Promise<void>((resolve) => streamFailure.server.close(() => resolve()));
  });
  const streamErrorResponse = await call(streamFailure.url, { ...baseBody, stream: true });
  const streamErrorText = await streamErrorResponse.text();
  assert(streamErrorText.length > 0, 'stream error response must be collected');
  assert.match(streamErrorText, /stream prefix/, 'client must receive content before the error');
  assert.match(streamErrorText, /event: error/, 'client SSE must receive the mid-stream error');
  capture('stream error SSE', streamErrorText);

  const count = await call(url, baseBody, '/v1/messages/count_tokens');
  assert.equal(count.status, 200);
  const countText = await count.text();
  assert(countText.length > 0, 'count_tokens response must be collected');
  capture('count_tokens', countText);

  let backendLoaded = false;
  const modelDescriptors = await discoverPiModels(
    {
      cwd: process.cwd(),
      env: { DEEPSEEK_API_KEY: canary },
      explicit: true,
      log: () => {},
    },
    async () => {
      backendLoaded = true;
      return await import('../../plugins/multi-pi/src/backend.ts');
    },
  );
  assert(backendLoaded, 'production discovery must load its backend with the fake credential');
  assert(modelDescriptors.length > 0, 'production model discovery must be non-empty');
  assert(
    modelDescriptors.every(
      ({ identity, capabilities }) => identity.providerId === 'deepseek' && capabilities.streaming,
    ),
  );
  capture('ModelDescriptor.metadata', modelDescriptors);

  const gatewayEnv = gatewayEnvironment(
    43123,
    token,
    false,
    createBuiltinRegistry({ deepseekKey: canary }),
  );
  assert(gatewayEnv.ANTHROPIC_BASE_URL?.includes('43123'));
  assert.equal(gatewayEnv.DEEPSEEK_API_KEY, undefined);
  capture('gatewayEnvironment', gatewayEnv);
  const harnessEnv = nativeEnvironment({
    overrides: { DEEPSEEK_API_KEY: canary },
    drop: ['DEEPSEEK_API_KEY'],
  });
  assert.equal(harnessEnv.DEEPSEEK_API_KEY, undefined);
  assert(Object.keys(harnessEnv).length > 0, 'harness environment collector must be non-empty');
  capture('harness subprocess env', harnessEnv);

  const definitions = workerDefinitions(
    workerCatalog([{ model: route }]),
    createBuiltinRegistry({ deepseekKey: canary }),
  );
  const agentDefinition = JSON.stringify(definitions);
  assert(Object.keys(definitions).length > 0, '--agents production definition must be non-empty');
  assert(
    agentDefinition.includes(route),
    '--agents production definition must include Pi model route',
  );
  capture('--agents definition', agentDefinition);

  await receipts.drain();
  const snapshot = receipts.snapshot('security-session');
  assert(snapshot.requests > 0, 'receipt/usage collector must contain recorded requests');
  const receipt =
    JSON.stringify(snapshot) +
    JSON.stringify(receipts.recent('security-session')) +
    receiptLines.join('');
  assert(receipt.length > 0, 'receipt writer output must be non-empty');
  capture('receipt/usage', receipt);
  assert(events.length > 0, 'gateway event collector must be non-empty');
  assert(events.some(({ status }) => status === 401));
  assert(events.some(({ status }) => status === 403));
  assert(events.some(({ status }) => status === 500));
  capture('onEvent after all scenarios', events);

  const dashboard = new ProviderUsageDashboard({ enabled: ['deepseek'] });
  const dashboardView = await dashboard.read('security-session', snapshot);
  const deepseekRow = dashboardView.providers.find(({ id }) => id === 'deepseek');
  assert(
    (deepseekRow?.session?.requests ?? 0) > 0,
    'dashboard must contain production DeepSeek usage',
  );
  capture('dashboard/usage rows', dashboardView);

  const usageEvent = events.find(({ usage }) => usage !== undefined);
  assert(usageEvent?.usage, 'real Pi completion event must provide usage for receipt/dashboard');
  // usageTrace is OpenAI/Zen-only; gateway event trace applies to Pi/direct as well.
  const trace = traceOutput.join('');
  assert(traceOutput.length > 0, 'gateway trace must contain real request events');
  assert.match(trace, /"route":"deepseek-request"/);
  assert.match(trace, /"route":"deepseek"/);
  for (const status of failedStatuses) {
    assert(trace.includes(`"status":${status}`), `trace must contain HTTP ${status} failure`);
  }
  assert(!trace.includes(canary), 'gateway trace exposed the canary key');
  capture('gateway trace', trace);
  const requestLogs = stderrOutput.join('') + consoleOutput.join('\n');
  assert(requestLogs.length > 0, 'request-lifetime stderr/console collector must be non-empty');
  assert(!requestLogs.includes(canary), 'request-lifetime logs exposed the canary key');
  capture('request-lifetime stderr/console', requestLogs);
  assertNoSecrets();
});

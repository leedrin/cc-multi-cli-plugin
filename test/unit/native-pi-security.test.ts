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
import { PI_DEEPSEEK_MODELS } from '../../plugins/multi-pi/src/catalog.ts';
import { preparePiRequest } from '../../plugins/multi-pi/src/gateway-request.ts';
import { bindPiProvider, discoverPiModels } from '../../plugins/multi-pi/src/provider.ts';

test('Pi live report and request model IDs stay in the production catalog', () => {
  const source = readFileSync(new URL('../live/native-pi.ts', import.meta.url), 'utf8');
  const models = [...source.matchAll(/model: '(?:multi\/deepseek\/)?([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.equal(
    models.length,
    2,
    'collect both report model and request route without running live',
  );
  assert.equal(models[0], models[1], 'report and request must use the same model');
  for (const id of models) {
    assert(
      PI_DEEPSEEK_MODELS.some((model) => model.id === id),
      `Unknown Pi live model: ${id}`,
    );
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

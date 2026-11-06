import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { openPiStream } from '../../plugins/multi-pi/src/backend.ts';
import { PI_MODELS_BY_PROVIDER } from '../../plugins/multi-pi/src/catalog.ts';

const model = PI_MODELS_BY_PROVIDER.strata[0];
assert.ok(model);
const context = { messages: [] } as Parameters<typeof openPiStream>[0]['context'];
const sse = 'data: [DONE]\n\n';

async function withServer(
  models: unknown,
  run: (
    baseUrl: string,
    requests: Array<{ url: string; authorization: string | undefined; body?: string }>,
  ) => Promise<void>,
  options: { status?: number; body?: string; delayMs?: number } = {},
): Promise<void> {
  const requests: Array<{ url: string; authorization: string | undefined; body?: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        ...(body ? { body } : {}),
      });
      const respond = () => {
        if (request.url === '/v1/models') {
          response.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
          response.end(options.body ?? JSON.stringify({ data: models }));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse);
      };
      if (options.delayMs) {
        setTimeout(respond, options.delayMs);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function open(baseUrl: string, fetch: typeof globalThis.fetch = globalThis.fetch) {
  return openPiStream({
    providerId: 'strata',
    model,
    context,
    apiKey: 'strata-test-key',
    label: 'Strata',
    baseUrl,
    fetch,
  });
}

test('Strata resolves the current sole upstream model without changing the curated model identity', async () => {
  await withServer([{ id: 'unsloth-ud-iq4_xs' }], async (baseUrl, requests) => {
    const opened = await open(baseUrl);
    assert.equal(opened.model.id, 'unsloth-ud-iq4_xs');
    assert.equal(model.id, 'qwen3.8-flash-next');
    assert.deepEqual(
      requests.map(({ url }) => url),
      ['/v1/models', '/v1/chat/completions'],
    );
    assert.deepEqual(
      requests.map(({ authorization }) => authorization),
      ['Bearer strata-test-key', 'Bearer strata-test-key'],
    );
    assert.equal(JSON.parse(requests[1]?.body ?? '{}').model, 'unsloth-ud-iq4_xs');
    await open(baseUrl);
    assert.equal(requests.filter(({ url }) => url === '/v1/models').length, 2);
  });
});

test('Strata refreshes the wire model ID on every open', async () => {
  let listings = 0;
  const sentModels: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (init?.method === 'GET') {
      listings += 1;
      const id = listings === 1 ? 'unsloth-first' : 'unsloth-second';
      return new Response(JSON.stringify({ data: [{ id }] }), { status: 200 });
    }
    sentModels.push(JSON.parse(String(init?.body)).model);
    return new Response(sse, { status: 200 });
  };
  await open('https://strata.fake.invalid/v1', fetch);
  await open('https://strata.fake.invalid/v1', fetch);
  assert.equal(listings, 2);
  assert.deepEqual(sentModels, ['unsloth-first', 'unsloth-second']);
});

test('Strata prefers the curated upstream ID when it is present', async () => {
  await withServer(
    [{ id: 'unsloth-ud-iq4_xs' }, { id: 'qwen3.8-flash-next' }],
    async (baseUrl, requests) => {
      const opened = await open(baseUrl);
      assert.equal(opened.model.id, 'qwen3.8-flash-next');
      assert.equal(JSON.parse(requests[1]?.body ?? '{}').model, 'qwen3.8-flash-next');
    },
  );
});

for (const [description, models, expected] of [
  ['multiple models', [{ id: 'one' }, { id: 'two' }], /2 models/],
  ['empty list', [], /0 models/],
  ['malformed model entries', [{ name: 'missing-id' }], /1 models/],
] as const) {
  test(`Strata refuses ${description}`, async () => {
    await withServer(models, async (baseUrl) => {
      await assert.rejects(open(baseUrl), expected);
    });
  });
}

test('Strata bounds the /models request and sanitizes a timeout', async () => {
  await withServer(
    [],
    async (baseUrl, requests) => {
      await assert.rejects(open(baseUrl), /Strata \/models request failed/);
      assert.deepEqual(
        requests.map(({ url }) => url),
        ['/v1/models'],
      );
    },
    { delayMs: 5_500 },
  );
});

test('Strata refuses failed or non-JSON model-list responses without exposing secrets', async () => {
  for (const [status, body] of [
    [503, '{"error":"model-key-canary"}'],
    [200, 'not-json model-key-canary'],
  ] as const) {
    await withServer(
      [],
      async (baseUrl) => {
        await assert.rejects(open(baseUrl), (error: Error) => {
          assert.match(error.message, /models/);
          assert.doesNotMatch(error.message, /model-key-canary|strata-test-key|127\.0\.0\.1/);
          return true;
        });
      },
      { status, body },
    );
  }
});

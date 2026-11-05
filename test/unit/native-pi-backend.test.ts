import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inspect } from 'node:util';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createPiFetch, openPiStream } from '../../plugins/multi-pi/src/backend.ts';
import { PI_DEEPSEEK_MODELS } from '../../plugins/multi-pi/src/catalog.ts';
import { discoverPiModels } from '../../plugins/multi-pi/src/provider.ts';

const fakeKey = 'test-only-DEEPSEEK-FAKE-KEY';
const model = PI_DEEPSEEK_MODELS[0];
const context = normalizeContext({ messages: [] });
const request = (overrides: Partial<Parameters<typeof openPiStream>[0]> = {}) => ({
  providerId: 'deepseek' as const,
  model,
  context,
  apiKey: fakeKey,
  label: 'DeepSeek',
  ...overrides,
});
const successfulFetch: typeof globalThis.fetch = async () =>
  new Response('data: [DONE]\n\n', { status: 200 });

test('Pi keyless runtime discovery does not load backend or pi-ai', () => {
  const providerUrl = new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { discoverPiModels } = await import(${JSON.stringify(providerUrl)});
    const models = await discoverPiModels({ cwd: '.', env: {}, explicit: true, log: () => {} });
    if (models.length !== 2) throw new Error('Unexpected keyless model count');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.error, undefined);
});

test('only ZAI key loads only the ZAI provider in a child process', () => {
  const launcherUrl = new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-zai-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { createLaunchRegistry, discoverLaunchProviders } = await import(${JSON.stringify(launcherUrl)});
    const found = await discoverLaunchProviders(createLaunchRegistry, ['zai'], {
      env: { ZAI_API_KEY: 'fake-zai-key' }, platform: 'linux'
    });
    if (found.genericModels.zai?.length !== 2) throw new Error('ZAI discovery did not load its models');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /PI_PROVIDER_LOADS:/);
  assert.match(result.stderr, /zai\.js/);
  assert.doesNotMatch(result.stderr, /all\.js|deepseek\.js|zai-coding-cn\.js/);
});

test('ZAI import boundary rejects every other provider subpath', () => {
  const loaderUrl = new URL('./fixtures/native-pi-zai-import-boundary-loader.mjs', import.meta.url)
    .href;
  for (const provider of [
    'all',
    'deepseek',
    'zai-coding-cn',
    'openai',
    'anthropic',
    'google-vertex',
  ]) {
    const script = `await import('@earendil-works/pi-ai/providers/${provider}');`;
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `${provider} was unexpectedly allowed`);
    assert.match(result.stderr, /Unexpected Pi provider module:/);
  }
});

test('count_tokens estimates in a child process without loading the Pi backend', () => {
  const requestUrl = new URL('../../plugins/multi-pi/src/gateway-request.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { preparePiRequest } = await import(${JSON.stringify(requestUrl)});
    const prepared = preparePiRequest({
      method: 'POST',
      pathname: '/v1/messages/count_tokens',
      body: { model: 'multi/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }] },
      session: 'session', fallbackSession: 'fallback'
    }, 'fake-key');
    if (prepared.inputTokens() < 1) throw new Error('Missing local token estimate');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  assert.equal(result.error, undefined);
});

test('Pi model discovery loads its backend only when a key is present', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return await import('../../plugins/multi-pi/src/backend.ts');
  };
  const noKey = await discoverPiModels(
    { cwd: '.', env: {}, explicit: true, log: () => {} },
    loader,
  );
  assert.equal(noKey.length, 2);
  assert.equal(calls, 0);
  await discoverPiModels(
    { cwd: '.', env: { DEEPSEEK_API_KEY: fakeKey }, explicit: true, log: () => {} },
    loader,
  );
  assert.equal(calls, 1);
});

test('each GLM backend loads only its provider and confines fetch to its own origin', async () => {
  for (const [providerId, model, expectedOrigin, label] of [
    ['zai', { ...PI_DEEPSEEK_MODELS[0], id: 'glm-5.3' }, 'https://api.z.ai', 'Z.AI'],
    [
      'zai-coding-cn',
      { ...PI_DEEPSEEK_MODELS[0], id: 'glm-5.3' },
      'https://open.bigmodel.cn',
      'Z.AI Coding (CN)',
    ],
  ] as const) {
    let target = '';
    await openPiStream({
      providerId,
      model,
      context,
      apiKey: 'fake-glm-key',
      label,
      fetch: async (input) => {
        target = input instanceof Request ? input.url : String(input);
        return new Response('data: [DONE]\\n\\n', { status: 200 });
      },
    });
    assert.equal(new URL(target).origin, expectedOrigin);
  }
});

test('each GLM origin rejects every other Pi provider origin before fetch', async () => {
  const origins = {
    deepseek: 'https://api.deepseek.com',
    zai: 'https://api.z.ai',
    'zai-coding-cn': 'https://open.bigmodel.cn',
  } as const;
  for (const [providerId, allowedOrigin] of Object.entries(origins)) {
    let calls = 0;
    const guarded = createPiFetch(
      async () => {
        calls += 1;
        return new Response(null);
      },
      allowedOrigin,
      providerId,
    );
    for (const [otherProvider, otherOrigin] of Object.entries(origins)) {
      if (otherProvider === providerId) {
        continue;
      }
      await assert.rejects(guarded(`${otherOrigin}/chat/completions`, {}), /target is not allowed/);
      assert.equal(calls, 0, `${providerId} fetch must not reach ${otherProvider}`);
    }
  }
});

test('Pi requests force redirect error and stay on DeepSeek origin', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    capturedInit = init;
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  await openPiStream(request({ fetch: fetchImpl }));
  assert.equal(new URL(capturedUrl).origin, 'https://api.deepseek.com');
  assert.equal(capturedInit?.redirect, 'error');

  let sent = false;
  const secureFetch = createPiFetch(async () => {
    sent = true;
    return new Response(null);
  });
  await assert.rejects(secureFetch('https://attacker.invalid/chat', {}), /target is not allowed/);
  assert.equal(sent, false);
});

test('Pi stream opens on start, preserves the first event, and sanitizes HTTP errors', async () => {
  const opened = await openPiStream(request({ fetch: successfulFetch }));
  assert.equal(opened.first.type, 'start');
  assert.equal(opened.model.id, model.id);

  for (const status of [401, 429, 500]) {
    const responseBody = 'CANARY_UPSTREAM_SECRET';
    const failedFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: responseBody }), { status });
    await assert.rejects(openPiStream(request({ fetch: failedFetch })), (error: Error) => {
      assert.match(error.message, new RegExp(`DeepSeek returned HTTP ${status}`));
      assert.doesNotMatch(error.message, /CANARY_UPSTREAM_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
      return true;
    });
  }
});

test('Pi network failures use fixed text and do not retry', async () => {
  let calls = 0;
  const failedFetch: typeof globalThis.fetch = async () => {
    calls += 1;
    throw new Error('CANARY_NETWORK_SECRET');
  };
  await assert.rejects(openPiStream(request({ fetch: failedFetch })), (error: Error) => {
    assert.equal(error.message, 'DeepSeek request failed.');
    assert.doesNotMatch(error.message, /CANARY_NETWORK_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
    return true;
  });
  assert.equal(calls, 1);
});

test('Pi SDK debug logs never expose network or HTTP error content', async () => {
  const previous = process.env.OPENAI_LOG;
  const logged: string[] = [];
  const methods = ['debug', 'info', 'log', 'warn', 'error'] as const;
  const originals = new Map<(typeof methods)[number], typeof console.debug>();
  try {
    process.env.OPENAI_LOG = 'debug';
    for (const method of methods) {
      originals.set(method, console[method]);
      console[method] = (...args: unknown[]) => logged.push(inspect(args));
    }
    for (const [kind, responseBody] of [
      ['network', undefined],
      ['non-json', 'CANARY_BODY_SECRET'],
      ['json', JSON.stringify({ error: 'CANARY_JSON_SECRET test-only-DEEPSEEK-FAKE-KEY' })],
    ] as const) {
      let calls = 0;
      let responseBodyCancelled = false;
      const fetchImpl: typeof globalThis.fetch = async () => {
        calls += 1;
        if (kind === 'network') {
          throw new Error('CANARY_NETWORK_SECRET test-only-DEEPSEEK-FAKE-KEY');
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseBody));
          },
          cancel() {
            responseBodyCancelled = true;
          },
        });
        return new Response(body, {
          status: 401,
          headers: {
            'content-type': kind === 'non-json' ? 'text/plain' : 'application/json',
            'retry-after': '17',
          },
        });
      };
      const expected =
        kind === 'network' ? 'DeepSeek request failed.' : 'DeepSeek returned HTTP 401.';
      await assert.rejects(openPiStream(request({ fetch: fetchImpl })), (error: Error) => {
        assert.equal(error.message, expected);
        assert.doesNotMatch(error.message, /CANARY_|test-only-DEEPSEEK-FAKE-KEY/);
        return true;
      });
      assert.equal(calls, 1);
      if (kind !== 'network') {
        assert.equal(responseBodyCancelled, true);
      }
      assert(logged.length > 0);
      assert.doesNotMatch(logged.join(' '), /CANARY_|test-only-DEEPSEEK-FAKE-KEY/);
    }
  } finally {
    for (const method of methods) {
      const original = originals.get(method);
      if (original) {
        console[method] = original;
      }
    }
    if (previous === undefined) {
      delete process.env.OPENAI_LOG;
    } else {
      process.env.OPENAI_LOG = previous;
    }
  }
});

test('Pi cancellation aborts before fetch, while awaiting headers, and while consuming', async () => {
  const timed = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Pi cancellation timed out.')), 500);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let preAbortedCalls = 0;
  const unusedFetch: typeof globalThis.fetch = async () => {
    preAbortedCalls += 1;
    return new Response('data: [DONE]\\n\\n');
  };
  await assert.rejects(
    timed(openPiStream(request({ signal: alreadyAborted.signal, fetch: unusedFetch }))),
    (error: Error) => {
      assert.notEqual(error.message, 'Pi cancellation timed out.');
      assert.doesNotMatch(error.message, /CANARY/);
      return true;
    },
  );
  assert.equal(preAbortedCalls, 0);

  const waitingController = new AbortController();
  let waitingSignal: AbortSignal | undefined;
  let waitingCalls = 0;
  const waitingFetch: typeof globalThis.fetch = async (_input, init) => {
    waitingCalls += 1;
    waitingSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('CANARY_WAITING_SECRET')), {
        once: true,
      });
    });
  };
  const waitingOpen = openPiStream(
    request({ signal: waitingController.signal, fetch: waitingFetch }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  waitingController.abort();
  await assert.rejects(timed(waitingOpen), (error: Error) => {
    assert.notEqual(error.message, 'Pi cancellation timed out.');
    assert.doesNotMatch(error.message, /CANARY_WAITING_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
    return true;
  });
  assert.equal(waitingCalls, 1);
  assert.equal(waitingSignal?.aborted, true);

  const consumingController = new AbortController();
  let consumingSignal: AbortSignal | undefined;
  let consumingCalls = 0;
  let bodyCancelled = false;
  const consumingFetch: typeof globalThis.fetch = async (_input, init) => {
    consumingCalls += 1;
    consumingSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { status: 200 },
    );
  };
  const opened = await timed(
    openPiStream(request({ signal: consumingController.signal, fetch: consumingFetch })),
  );
  assert.equal(opened.first.type, 'start');
  const next = opened.stream[Symbol.asyncIterator]().next();
  consumingController.abort();
  try {
    await timed(next);
  } catch (error) {
    assert.notEqual(String(error), 'Error: Pi cancellation timed out.');
    assert.doesNotMatch(String(error), /CANARY|test-only-DEEPSEEK-FAKE-KEY/);
  }
  assert.equal(consumingCalls, 1);
  assert.equal(consumingSignal?.aborted, true);
  assert.equal(bodyCancelled, true);
});

test('Pi cache retention ignores PI_CACHE_RETENTION=long', async () => {
  const previous = process.env.PI_CACHE_RETENTION;
  const capture = async () => {
    let body: string | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      body = String(init?.body ?? '');
      return new Response('data: [DONE]\n\n', { status: 200 });
    };
    await openPiStream(request({ fetch: fetchImpl }));
    return body;
  };
  try {
    delete process.env.PI_CACHE_RETENTION;
    const shortBody = await capture();
    process.env.PI_CACHE_RETENTION = 'long';
    assert.equal(await capture(), shortBody);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = previous;
    }
  }
});

test('Pi reasoning effort is included in the outgoing request', async () => {
  let body = '';
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    body = String(init?.body ?? '');
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  await openPiStream(request({ reasoningEffort: 'high', fetch: fetchImpl }));
  assert.equal(JSON.parse(body).reasoning_effort, 'high');
});

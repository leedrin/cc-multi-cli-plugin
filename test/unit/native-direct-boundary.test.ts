import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { ProviderRegistry } from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type { ProviderRequestInput } from '../../plugins/multi-core/src/gateway/provider-request.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { ZenAuthError } from '../../plugins/multi-zen/src/auth.ts';
import { zenUnavailable } from '../../plugins/multi-zen/src/gateway-request.ts';

const headers = {
  'content-type': 'application/json',
  'x-multi-gateway-token': 'fixture-token',
};
const body = (model: string) => ({
  model,
  max_tokens: 128,
  messages: [{ role: 'user', content: 'hello' }],
});

async function startGateway(
  t: TestContext,
  fetchImpl: typeof fetch,
  zen?: { apiKey: string },
  options: { authFile?: string | null; registry?: ProviderRegistry } = {},
) {
  const server = createNativeGateway({
    token: 'fixture-token',
    ...(options.authFile === null
      ? {}
      : { authFile: options.authFile ?? '/nonexistent/codex-auth.json' }),
    ...(options.registry ? { registry: options.registry } : {}),
    zen,
    fetchImpl,
    blockAnthropic: true,
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
  return `http://127.0.0.1:${address.port}/v1/messages`;
}

test('unbound Zen prepare fails with the exact unavailable message', () => {
  const prepare = createBuiltinRegistry().get('zen')?.direct?.prepare;
  assert(prepare);
  assert.throws(
    () =>
      prepare({
        method: 'POST',
        pathname: '/v1/messages',
        body: body('multi/zen/gpt-5.6-luna') as unknown as ProviderRequestInput['body'],
        session: '',
        fallbackSession: 'fallback',
        agentId: undefined,
      } as never),
    (error: unknown) => error instanceof Error && error.message === zenUnavailable,
  );
  const bound = createBuiltinRegistry({ zenKey: 'fixture-zen-key' }).get('zen')?.direct?.prepare;
  assert(bound);
  assert.doesNotThrow(() =>
    bound({
      method: 'POST',
      pathname: '/v1/messages',
      body: body('multi/zen/gpt-5.6-luna') as unknown as ProviderRequestInput['body'],
      session: '',
      fallbackSession: 'fallback',
      agentId: undefined,
    } as never),
  );
});

test('a custom registry cannot be combined with gateway credentials', () => {
  const registry = createBuiltinRegistry({ zenKey: 'fixture-zen-key' });
  assert.throws(
    () =>
      createNativeGateway({ token: 'fixture-token', authFile: '/explicit/auth.json', registry }),
    /credentials.*registry/i,
  );
  assert.throws(
    () =>
      createNativeGateway({
        token: 'fixture-token',
        authFile: undefined as unknown as string,
        zen: { apiKey: 'fixture-zen-key' },
        registry,
      }),
    /credentials.*registry/i,
  );
});

test('a pre-bound registry remains intact and works without gateway credentials', async (t) => {
  const registry = createBuiltinRegistry({ zenKey: 'fixture-zen-key' });
  const prepare = registry.get('zen')?.direct?.prepare;
  assert(prepare);
  let calls = 0;
  const url = await startGateway(
    t,
    async () => {
      calls++;
      return new Response('upstream fixture', { status: 429 });
    },
    undefined,
    { authFile: null, registry },
  );
  assert.equal(registry.get('zen')?.direct?.prepare, prepare);
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body('multi/zen/gpt-5.6-luna')),
  });
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
});

test('the default registry uses its explicit OpenAI auth file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-auth-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const authFile = path.join(directory, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-access-token', account_id: 'fixture-account' },
    }),
  );
  let authorization: string | undefined;
  const url = await startGateway(
    t,
    async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      return new Response('{}', { status: 502 });
    },
    undefined,
    { authFile },
  );
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body('multi/openai/gpt-6-luna')),
  });
  assert.equal(authorization, 'Bearer fixture-access-token');
});

test('an invalid Zen key fails gateway creation with ZenAuthError', () => {
  assert.throws(
    () =>
      createNativeGateway({
        token: 'fixture-token',
        authFile: '/nonexistent/codex-auth.json',
        zen: { apiKey: 'bad key' },
      }),
    (error: unknown) => error instanceof ZenAuthError,
  );
});

test('Zen without a key and invalid direct requests fail before an upstream call', async (t) => {
  let calls = 0;
  const url = await startGateway(t, async () => {
    calls++;
    return new Response('{}');
  });
  const missing = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body('multi/zen/gpt-5.6-luna')),
  });
  assert.equal(missing.status, 400);
  const missingError = (await missing.json()) as { error: { message: string } };
  assert.equal(missingError.error.message, `Native gateway: ${zenUnavailable}`);

  const invalid = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body('multi/openai/not-a-model')),
  });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
});

test('a disconnected client aborts the single direct upstream request', async (t) => {
  const started = Promise.withResolvers<AbortSignal>();
  let calls = 0;
  const fakeUpstream: typeof fetch = async (_input, init) => {
    calls++;
    const signal = init?.signal;
    assert(signal);
    started.resolve(signal);
    return new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error('cancelled')), {
            once: true,
          });
        },
      }),
    );
  };
  const url = await startGateway(t, fakeUpstream, { apiKey: 'fixture-zen-key' });
  const controller = new AbortController();
  const pending = fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body('multi/zen/gpt-5.6-luna'), stream: true }),
    signal: controller.signal,
  });
  const signal = await started.promise;
  controller.abort();
  await assert.rejects(pending);
  let abortTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
        } else {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      }),
      new Promise<never>((_, reject) => {
        abortTimer = setTimeout(() => reject(new Error('upstream signal was not aborted')), 500);
      }),
    ]);
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(calls, 1);
  assert(signal.aborted);
});

function directProviderImports(entry: string): string[] {
  const entryURL = pathToFileURL(entry).href;
  const script = `
    import { registerHooks } from 'node:module';
    const entry = process.argv[1];
    const resolutions = [];
    registerHooks({
      resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (context.parentURL === entry) {
          resolutions.push({ parentURL: context.parentURL, url: result.url });
        }
        return result;
      },
    });
    await import(entry);
    console.log(JSON.stringify(resolutions));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, entryURL], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  const resolutions: { parentURL: string; url: string }[] = JSON.parse(child.stdout.trim());
  // Runtime hooks record dynamic imports only when execution reaches them.
  return resolutions
    .filter(
      ({ parentURL, url }) =>
        parentURL === entryURL &&
        /\/plugins\/multi-(?:openai|zen|cursor|antigravity|grok|pi)\//.test(new URL(url).pathname),
    )
    .map(({ url }) => url);
}

test('resolve hook ignores import decoys and detects real provider imports', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multi-import-boundary-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const pluginDirectory = path.join(directory, 'plugins', 'multi-openai');
  await mkdir(pluginDirectory, { recursive: true });
  const plugin = path.join(pluginDirectory, 'provider.mjs');
  await writeFile(plugin, 'export const value = 1;');
  const entry = path.join(directory, 'entry.mjs');
  const specifier = './plugins/multi-openai/provider.mjs';
  for (const source of [
    `import
 '${specifier}';`,
    String.raw`import './plugins/multi-\u006fpenai/provider.mjs';`,
    `import /* gap */ '${specifier}';`,
  ]) {
    await writeFile(entry, source);
    assert.deepEqual(directProviderImports(entry), [pathToFileURL(plugin).href], source);
  }
  await writeFile(
    entry,
    `
    // import '${specifier}';
    /* import '${specifier}'; */
    const text = 'import' + ('${specifier}');
    const template = \`import '${specifier}'\`;
  `,
  );
  assert.deepEqual(directProviderImports(entry), []);
});

test('server source does not import provider plugin modules directly', () => {
  const entry = fileURLToPath(
    new URL('../../plugins/multi-core/src/gateway/server.ts', import.meta.url),
  );
  assert.deepEqual(directProviderImports(entry), []);
});

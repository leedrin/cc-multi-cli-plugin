import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PROVIDER_FACTS } from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import { bindPiProviders, deepseekDescriptor } from '../../plugins/multi-pi/src/provider.ts';
import { strataUrlUsesLoopback, validatedStrataUrl } from '../../plugins/multi-pi/src/providers.ts';

const fact = PROVIDER_FACTS.find(({ id }) => id === 'deepseek');

const context = (
  apiKey?: string,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  explicit: boolean;
  log: (message: string) => void;
} => ({
  cwd: process.cwd(),
  env: apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey },
  explicit: true,
  log: () => {},
});

test('DeepSeek descriptor matches its provider facts', () => {
  assert(fact);
  assert.equal(deepseekDescriptor.id, fact.id);
  assert.equal(deepseekDescriptor.plugin, fact.plugin);
  assert.equal(deepseekDescriptor.kind, fact.kind);
  assert.equal(deepseekDescriptor.label, fact.label);
  assert.equal(deepseekDescriptor.worker?.type, fact.worker);
  assert.deepEqual(deepseekDescriptor.credentialEnv, ['DEEPSEEK_API_KEY']);
  assert.deepEqual(deepseekDescriptor.autoReview, {
    review: 'none',
    statement: 'no auto mode: actions run unreviewed',
  });
  assert.match(deepseekDescriptor.unavailableMessage, /DEEPSEEK_API_KEY/);
});

test('DeepSeek availability requires a nonblank supplied API key', async () => {
  assert.deepEqual(await deepseekDescriptor.availability(context('secret')), { available: true });
  assert.equal((await deepseekDescriptor.availability(context())).available, false);
  assert.equal((await deepseekDescriptor.availability(context('  \t'))).available, false);
  assert.deepEqual(
    (await deepseekDescriptor.discoverModels(context('secret'))).map(
      ({ identity }) => identity.modelId,
    ),
    ['deepseek-v4-pro', 'deepseek-flash'],
  );
});

test('DeepSeek discovery filters models from its context environment', async () => {
  const discoveryContext = context('secret');
  discoveryContext.env.MULTI_PI_MODELS = ' deepseek-flash,deepseek-flash ';
  assert.deepEqual(
    (await deepseekDescriptor.discoverModels(discoveryContext)).map(
      ({ identity }) => identity.modelId,
    ),
    ['deepseek-flash'],
  );
  discoveryContext.env.MULTI_PI_MODELS = 'unknown';
  await assert.rejects(
    deepseekDescriptor.discoverModels(discoveryContext),
    /unknown.*deepseek-v4-pro.*deepseek-flash/,
  );
});

test('Pi provider bindings keep GLM keys, worker facts, and availability isolated', async () => {
  const bound = bindPiProviders({ zai: 'fake-zai-key', 'zai-coding-cn': 'fake-cn-key' });
  assert.deepEqual(
    bound.map(({ id, credentialEnv, worker }) => [id, credentialEnv, worker?.type]),
    [
      ['deepseek', ['DEEPSEEK_API_KEY'], 'multi-deepseek'],
      ['zai', ['ZAI_API_KEY'], 'multi-zai'],
      ['zai-coding-cn', ['ZAI_CODING_CN_API_KEY'], 'multi-zai-coding-cn'],
      ['strata', ['STRATA_API_KEY'], 'multi-strata'],
    ],
  );
  assert.equal((await bound[0].availability(context())).available, false);
  assert.equal((await bound[1].availability(context())).available, false);
  assert.equal(
    (await bound[1].availability({ ...context(), env: { ZAI_API_KEY: 'fake-zai-key' } })).available,
    true,
  );
  assert.match(bound[1].unavailableMessage, /ZAI_API_KEY/);
  assert.match(bound[2].unavailableMessage, /ZAI_CODING_CN_API_KEY/);
  assert.deepEqual(
    (
      await bound[1].discoverModels({
        cwd: '.',
        env: { ZAI_API_KEY: 'fake-zai-key' },
        explicit: true,
        log: () => {},
      })
    ).map(({ identity }) => identity.routeId),
    ['multi/zai/glm-5.3', 'multi/zai/glm-5.2'],
  );
  assert.deepEqual(
    (
      await bound[2].discoverModels({
        cwd: '.',
        env: { ZAI_CODING_CN_API_KEY: 'fake-cn-key' },
        explicit: true,
        log: () => {},
      })
    ).map(({ identity }) => identity.routeId),
    ['multi/zai-coding-cn/glm-5.3', 'multi/zai-coding-cn/glm-5.3-flash'],
  );
});

test('Strata is available only with a valid base URL and isolated credentials', async () => {
  const strata = bindPiProviders(
    { strata: 'fake-strata-key' },
    {
      strataBaseUrl: 'https://strata.example.test/v1',
    },
  ).find(({ id }) => id === 'strata');
  assert.ok(strata);
  assert.deepEqual(strata.credentialEnv, ['STRATA_API_KEY']);
  assert.equal(strata.worker?.type, 'multi-strata');
  assert.deepEqual(await strata.availability(context()), {
    available: false,
    reason: 'Set MULTI_STRATA_BASE_URL to enable Strata.',
  });
  assert.deepEqual(
    await strata.availability({
      ...context(),
      env: {
        MULTI_STRATA_BASE_URL: 'https://strata.example.test/v1',
        STRATA_API_KEY: 'fake-strata-key',
      },
    }),
    { available: true },
  );
  assert.deepEqual(
    await strata.availability({
      ...context(),
      env: { MULTI_STRATA_BASE_URL: 'http://[::1]:8080/v1' },
    }),
    { available: true },
  );
  await assert.rejects(
    strata.discoverModels({
      ...context(),
      env: { MULTI_STRATA_BASE_URL: 'http://strata.example.test' },
    }),
    /HTTPS or HTTP on loopback/,
  );
});

test('Strata URL validation rejects malformed, unsafe protocols, and userinfo without echoing secrets', () => {
  for (const value of [
    'http://userinfo-secret:password-secret@[invalid?token=query-secret&key=fake-key-secret',
    'ftp://strata.fake.invalid/path?token=query-secret&key=fake-key-secret',
    'http://strata.fake.invalid/path?token=query-secret&key=fake-key-secret',
    'https://userinfo-secret:password-secret@strata.fake.invalid/v1?token=query-secret&key=fake-key-secret',
  ]) {
    assert.throws(
      () => validatedStrataUrl(value),
      (error: Error) => {
        assert.doesNotMatch(
          error.message,
          /userinfo-secret|password-secret|query-secret|fake-key-secret/,
        );
        assert.ok(
          error.message === 'Strata base URL is invalid.' ||
            error.message === 'Strata base URL must not contain credentials.' ||
            error.message === 'Strata base URL must use HTTPS or HTTP on loopback.',
        );
        return true;
      },
    );
  }
  assert.equal(
    validatedStrataUrl('https://strata.fake.invalid/v1')?.hostname,
    'strata.fake.invalid',
  );
  for (const hostname of ['localhost', '127.42.5.9', '[::1]']) {
    assert.equal(strataUrlUsesLoopback(new URL(`http://${hostname}:8321/v1`)), true);
    assert.equal(validatedStrataUrl(`http://${hostname}:8321/v1`)?.protocol, 'http:');
  }
  assert.equal(strataUrlUsesLoopback(new URL('http://128.0.0.1:8321/v1')), false);
});

test('Strata request binding rejects absent or whitespace keys without borrowing other credentials', () => {
  for (const key of [undefined, '', '  \t']) {
    const strata = bindPiProviders(
      { strata: key, deepseek: 'fake-other-key', zai: 'fake-zai-key' },
      { strataBaseUrl: 'https://strata.fake.invalid/v1?token=query-secret' },
    ).find(({ id }) => id === 'strata');
    assert(strata?.direct);
    assert.throws(
      () =>
        strata.direct?.prepare({
          method: 'POST',
          pathname: '/v1/messages',
          body: { model: 'multi/strata/qwen3.8-flash-next', messages: [] },
          session: 'offline',
          fallbackSession: 'fallback',
        }),
      (error: Error) => {
        assert.equal(error.message, 'Strata requires STRATA_API_KEY for a non-loopback base URL.');
        assert.doesNotMatch(error.message, /fake-other-key|fake-zai-key|query-secret/);
        return true;
      },
    );
  }
});

test('Strata provider source does not import pi-ai', async () => {
  const source = await readFile(
    new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /pi-ai/i);
});

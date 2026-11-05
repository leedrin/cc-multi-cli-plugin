import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PROVIDER_FACTS } from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import { bindPiProviders, deepseekDescriptor } from '../../plugins/multi-pi/src/provider.ts';

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

test('DeepSeek provider source does not import pi-ai', async () => {
  const source = await readFile(
    new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /pi-ai/i);
});

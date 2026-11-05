import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PROVIDER_FACTS } from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import { deepseekDescriptor } from '../../plugins/multi-pi/src/provider.ts';

const fact = PROVIDER_FACTS.find(({ id }) => id === 'deepseek');

const context = (apiKey?: string) => ({
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
  assert.deepEqual(await deepseekDescriptor.discoverModels(context('secret')), []);
});

test('DeepSeek provider source does not import pi-ai', async () => {
  const source = await readFile(
    new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /pi-ai/i);
});

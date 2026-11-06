import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as providerCredentials from '../../plugins/multi-core/src/gateway/provider-credentials.ts';
import { bindPiProviders } from '../../plugins/multi-pi/src/provider.ts';

const { takeProviderCredentials } = providerCredentials;

const descriptor = (credentialEnv: string[]) => ({ credentialEnv });

test('takes declared credentials and deletes them from the supplied environment', () => {
  const env = { DEEPSEEK_API_KEY: ' secret ', KEEP: 'untouched' };
  assert.deepEqual(
    takeProviderCredentials(env, [descriptor(['DEEPSEEK_API_KEY'])]),
    new Map([['DEEPSEEK_API_KEY', ' secret ']]),
  );
  assert.deepEqual(env, { KEEP: 'untouched' });
});

test('all enabled Pi credentials are extracted from launcher environment', () => {
  const env = {
    DEEPSEEK_API_KEY: 'fake-deepseek',
    ZAI_API_KEY: 'fake-zai',
    ZAI_CODING_CN_API_KEY: 'fake-zai-cn',
    STRATA_API_KEY: 'fake-strata',
  };
  assert.deepEqual(
    takeProviderCredentials(env, bindPiProviders()),
    new Map([
      ['DEEPSEEK_API_KEY', 'fake-deepseek'],
      ['ZAI_API_KEY', 'fake-zai'],
      ['ZAI_CODING_CN_API_KEY', 'fake-zai-cn'],
      ['STRATA_API_KEY', 'fake-strata'],
    ]),
  );
  assert.deepEqual(env, {});
});

test('returns present empty and whitespace credentials unchanged while deleting them', () => {
  const env = { EMPTY: '', SPACES: '  \t ' };
  assert.deepEqual(
    takeProviderCredentials(env, [descriptor(['EMPTY', 'SPACES'])]),
    new Map([
      ['EMPTY', ''],
      ['SPACES', '  \t '],
    ]),
  );
  assert.deepEqual(env, {});
});

test('leaves credentials for descriptors that are not supplied untouched', () => {
  const env = { DEEPSEEK_API_KEY: 'keep' };
  assert.deepEqual(takeProviderCredentials(env, []), new Map());
  assert.deepEqual(env, { DEEPSEEK_API_KEY: 'keep' });
});

test('on Windows removes all case variants and prefers the exact spelling', () => {
  const env = { deepseek_api_key: 'first', DEEPSEEK_API_KEY: 'exact', DeepSeek_Api_Key: 'last' };
  assert.deepEqual(
    takeProviderCredentials(env, [descriptor(['DEEPSEEK_API_KEY'])], { platform: 'win32' }),
    new Map([['DEEPSEEK_API_KEY', 'exact']]),
  );
  assert.deepEqual(env, {});
});

test('on non-Windows platforms does not match credential names by case', () => {
  const env = { deepseek_api_key: 'keep' };
  assert.deepEqual(
    takeProviderCredentials(env, [descriptor(['DEEPSEEK_API_KEY'])], { platform: 'linux' }),
    new Map(),
  );
  assert.deepEqual(env, { deepseek_api_key: 'keep' });
});

test('withoutProviderCredentials filters Windows case variants without mutating input', () => {
  const candidate = Reflect.get(providerCredentials, 'withoutProviderCredentials');
  assert.equal(typeof candidate, 'function');
  if (typeof candidate !== 'function') {
    return;
  }
  const env = {
    deepseek_api_key: 'fake-lowercase',
    DeepSeek_Api_Key: 'fake-mixedcase',
    KEEP: 'retained',
  };
  const snapshot = { ...env };
  assert.deepEqual(candidate(env, ['DEEPSEEK_API_KEY'], { platform: 'win32' }), {
    KEEP: 'retained',
  });
  assert.deepEqual(env, snapshot);
});

test('credential helper source does not import fs or mention Pi state', async () => {
  const source = await readFile(
    new URL('../../plugins/multi-core/src/gateway/provider-credentials.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /from ['"]node:fs(?:\/|['"])/);
  assert.doesNotMatch(source, /\.pi/);
});

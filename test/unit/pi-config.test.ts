import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  PI_UPSTREAM_BASE_URLS,
  type PiConfigInput,
  piConfigDirectory,
  readPiConfigCredentials,
} from '../../plugins/multi-pi/src/pi-config.ts';

const HOME = path.join(path.sep, 'home', 'pi-user');
const PI_DIR = path.join(HOME, '.pi', 'agent');

function files(entries: Record<string, unknown>, directory = PI_DIR) {
  const reads: string[] = [];
  const contents = new Map(
    Object.entries(entries).map(([name, value]) => [
      path.join(directory, name),
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
  return {
    reads,
    readFile: (file: string) => {
      reads.push(file);
      return contents.get(file);
    },
  };
}

function read(
  entries: Record<string, unknown>,
  overrides: Partial<PiConfigInput> = {},
): ReturnType<typeof readPiConfigCredentials> & { reads: string[] } {
  const fake = files(entries);
  const result = readPiConfigCredentials({
    env: {},
    providers: ['deepseek', 'zai', 'zai-coding-cn', 'strata'],
    strataBaseUrl: true,
    platform: 'linux',
    homedir: HOME,
    readFile: fake.readFile,
    ...overrides,
  });
  return { ...result, reads: fake.reads };
}

test('reads only auth.json and models.json from <home>/.pi/agent', () => {
  const result = read({ 'auth.json': { deepseek: { type: 'api_key', key: 'fake-ds' } } });
  assert.deepEqual(result.reads, [
    path.join(PI_DIR, 'auth.json'),
    path.join(PI_DIR, 'models.json'),
  ]);
  assert.equal(result.credentials.get('DEEPSEEK_API_KEY'), 'fake-ds');
  assert.deepEqual(result.sources, ['deepseek']);
});

test('PI_CODING_AGENT_DIR overrides the directory; blank override is ignored', () => {
  const other = path.join(path.sep, 'elsewhere', 'pi');
  assert.equal(piConfigDirectory({ PI_CODING_AGENT_DIR: other }, HOME), other);
  assert.equal(piConfigDirectory({ PI_CODING_AGENT_DIR: '  ' }, HOME), PI_DIR);
  const fake = files({ 'auth.json': { deepseek: { type: 'api_key', key: 'fake-other' } } }, other);
  const result = readPiConfigCredentials({
    env: { PI_CODING_AGENT_DIR: other },
    providers: ['deepseek'],
    strataBaseUrl: false,
    homedir: HOME,
    readFile: fake.readFile,
  });
  assert.equal(result.credentials.get('DEEPSEEK_API_KEY'), 'fake-other');
  assert.ok(fake.reads.every((file) => file.startsWith(other)));
});

test('missing directory or files are skipped; nothing requested reads nothing', () => {
  const missing = read({});
  assert.equal(missing.credentials.size, 0);
  assert.equal(missing.strataBaseUrl, undefined);
  const none = read({}, { providers: [], strataBaseUrl: false });
  assert.deepEqual(none.reads, []);
});

test('never reads auth.json from the working directory', () => {
  const result = read({});
  assert.ok(result.reads.every((file) => file.startsWith(PI_DIR)));
  assert.ok(!result.reads.includes(path.resolve('auth.json')));
});

test('maps models.json providers by base URL, ignores unrelated and OAuth entries', () => {
  const result = read({
    'auth.json': {
      zai: { type: 'oauth', access: 'fake-oauth-token' },
      openai: { type: 'api_key', key: 'fake-openai' },
    },
    'models.json': {
      providers: {
        'glm-coding': {
          baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/',
          apiKey: 'fake-glm',
          models: [],
        },
        'my-zai': { baseUrl: 'https://API.Z.AI/api/coding/paas/v4', apiKey: 'fake-zai' },
        minimax: { baseUrl: 'https://api.minimax.io/v1', apiKey: 'fake-minimax' },
        noUrl: { apiKey: 'fake-no-url' },
        weird: 'not an object',
      },
    },
  });
  assert.deepEqual(Object.fromEntries(result.credentials), {
    ZAI_CODING_CN_API_KEY: 'fake-glm',
    ZAI_API_KEY: 'fake-zai',
  });
});

test('only requested providers are collected', () => {
  const result = read(
    {
      'auth.json': { deepseek: { type: 'api_key', key: 'fake-ds' } },
      'models.json': {
        providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'fake-glm' } },
      },
    },
    { providers: ['zai-coding-cn'], strataBaseUrl: false },
  );
  assert.deepEqual([...result.credentials.keys()], ['ZAI_CODING_CN_API_KEY']);
});

test('strata entry supplies key and base URL', () => {
  const result = read({
    'models.json': {
      providers: { strata: { baseUrl: 'http://127.0.0.1:47831/v1', apiKey: 'fake-st' } },
    },
  });
  assert.equal(result.credentials.get('STRATA_API_KEY'), 'fake-st');
  assert.equal(result.strataBaseUrl, 'http://127.0.0.1:47831/v1');
  const urlNotNeeded = read(
    { 'models.json': { providers: { strata: { baseUrl: 'http://127.0.0.1:1/v1' } } } },
    { strataBaseUrl: false },
  );
  assert.equal(urlNotNeeded.strataBaseUrl, undefined);
});

test('built-in upstream table matches pi-ai provider base URLs', async () => {
  const providers = {
    deepseek: (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider(),
    zai: (await import('@earendil-works/pi-ai/providers/zai')).zaiProvider(),
    'zai-coding-cn': (
      await import('@earendil-works/pi-ai/providers/zai-coding-cn')
    ).zaiCodingCnProvider(),
  };
  for (const [id, provider] of Object.entries(providers)) {
    assert.equal(PI_UPSTREAM_BASE_URLS[id as keyof typeof PI_UPSTREAM_BASE_URLS], provider.baseUrl);
  }
});

test('pi-config imports only node built-ins and providers.ts (no pi-ai)', async () => {
  const source = await readFile(
    new URL('../../plugins/multi-pi/src/pi-config.ts', import.meta.url),
    'utf8',
  );
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(([, name]) => name);
  assert.deepEqual(imports.sort(), ['./providers.ts', 'node:fs', 'node:os', 'node:path']);
});

test('!command values fail and are never executed', () => {
  for (const entries of [
    { 'auth.json': { deepseek: { type: 'api_key', key: '!echo pwned' } } },
    {
      'models.json': {
        providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS.zai, apiKey: ' !cat secret' } },
      },
    },
  ]) {
    assert.throws(
      () => read(entries),
      (error: Error) => {
        assert.match(error.message, /command values \(!command\) are not supported/);
        assert.doesNotMatch(error.message, /pwned|secret/);
        return true;
      },
    );
  }
});

test('environment name references resolve and are reported as consumed', () => {
  const result = read(
    {
      'models.json': {
        providers: {
          glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'MY_GLM_KEY' },
        },
      },
    },
    { env: { MY_GLM_KEY: 'fake-from-env' } },
  );
  assert.equal(result.credentials.get('ZAI_CODING_CN_API_KEY'), 'fake-from-env');
  assert.deepEqual(result.consumedEnv, ['MY_GLM_KEY']);
});

test('environment references are case-insensitive only on Windows', () => {
  const entries = { 'auth.json': { deepseek: { type: 'api_key', key: 'MY_DS_KEY' } } };
  const windows = read(entries, { env: { my_ds_key: 'fake-win' }, platform: 'win32' });
  assert.equal(windows.credentials.get('DEEPSEEK_API_KEY'), 'fake-win');
  assert.deepEqual(windows.consumedEnv, ['my_ds_key']);
  const linux = read(entries, { env: { my_ds_key: 'fake-win' }, platform: 'linux' });
  assert.equal(linux.credentials.get('DEEPSEEK_API_KEY'), 'MY_DS_KEY');
  assert.deepEqual(linux.consumedEnv, []);
});

test('unset or blank referenced variable falls back to the literal value', () => {
  const entries = { 'auth.json': { deepseek: { type: 'api_key', key: 'MY_DS_KEY' } } };
  assert.equal(
    read(entries, { env: { MY_DS_KEY: ' ' } }).credentials.get('DEEPSEEK_API_KEY'),
    'MY_DS_KEY',
  );
});

test('identical candidates merge; different candidates fail naming the provider only', () => {
  const same = read({
    'auth.json': { 'zai-coding-cn': { type: 'api_key', key: 'fake-same' } },
    'models.json': {
      providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'fake-same' } },
    },
  });
  assert.equal(same.credentials.get('ZAI_CODING_CN_API_KEY'), 'fake-same');
  assert.throws(
    () =>
      read({
        'auth.json': { 'zai-coding-cn': { type: 'api_key', key: 'CANARY_ONE' } },
        'models.json': {
          providers: {
            glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'CANARY_TWO' },
          },
        },
      }),
    (error: Error) => {
      assert.match(error.message, /zai-coding-cn has more than one different credential/);
      assert.doesNotMatch(error.message, /CANARY/);
      return true;
    },
  );
});

test('a provider the environment already supplied is not checked for ambiguity', () => {
  const result = read(
    {
      'auth.json': { 'zai-coding-cn': { type: 'api_key', key: 'fake-one' } },
      'models.json': {
        providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'fake-two' } },
      },
    },
    { providers: ['deepseek'] },
  );
  assert.equal(result.credentials.size, 0);
});

test('malformed files fail with the file name and no content', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      { 'models.json': '{"providers": {"x": "CANARY_JSON' },
      /models\.json: cannot be parsed as JSON/,
    ],
    [{ 'auth.json': '["CANARY_ARRAY"]' }, /auth\.json: has an unexpected structure/],
    [{ 'auth.json': { deepseek: 'CANARY_STRING' } }, /auth\.json: has an unexpected structure/],
    [
      { 'auth.json': { deepseek: { type: 'api_key', key: 42 } } },
      /auth\.json: has an unexpected structure/,
    ],
    [
      { 'models.json': { providers: ['CANARY_LIST'] } },
      /models\.json: has an unexpected structure/,
    ],
    [
      {
        'models.json': {
          providers: {
            strata: { baseUrl: 'https://u:CANARY_PASS@strata.invalid/v1?token=CANARY_Q' },
          },
        },
      },
      /models\.json: strata Strata base URL must not contain credentials/,
    ],
    [
      {
        'models.json': {
          providers: { strata: { baseUrl: 'http://strata.invalid/v1?token=CANARY_Q' } },
        },
      },
      /models\.json: strata Strata base URL must use HTTPS or HTTP on loopback/,
    ],
  ];
  for (const [entries, expected] of cases) {
    assert.throws(
      () => read(entries),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.match(error.message, /MULTI_PI_CONFIG=0/);
        assert.doesNotMatch(error.message, /CANARY/);
        return true;
      },
    );
  }
});

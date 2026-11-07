import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { takeProviderCredentials } from '../../plugins/multi-core/src/gateway/provider-credentials.ts';
import {
  applyPiConfigCredentials,
  createLaunchRegistry,
  discoverLaunchProviders,
  launcherRuntime,
  main,
} from '../../plugins/multi-core/src/launcher.ts';
import { PI_UPSTREAM_BASE_URLS } from '../../plugins/multi-pi/src/pi-config.ts';

const HOME = path.join(path.sep, 'home', 'pi-user');
const PI_DIR = path.join(HOME, '.pi', 'agent');
const PI_IDS = ['deepseek', 'zai', 'zai-coding-cn', 'strata'];

function piFiles(entries: Record<string, unknown>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: (file: string) => {
      reads.push(file);
      const value = entries[path.relative(PI_DIR, file)];
      return value === undefined ? undefined : JSON.stringify(value);
    },
  };
}

function launch(
  env: NodeJS.ProcessEnv,
  entries: Record<string, unknown>,
  ids: readonly string[] = PI_IDS,
) {
  const descriptors = createLaunchRegistry()
    .list()
    .filter(({ id }) => ids.includes(id));
  const credentials = takeProviderCredentials(env, descriptors, { platform: 'linux' });
  const fake = piFiles(entries);
  const logs: string[] = [];
  const discoveryEnv = applyPiConfigCredentials(env, credentials, descriptors, {
    platform: 'linux',
    homedir: HOME,
    readFile: fake.readFile,
    log: (message) => logs.push(message),
  });
  return { credentials, discoveryEnv, logs, reads: fake.reads };
}

test('environment keys win over Pi config; Pi config fills only the gaps', () => {
  const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'fake-env-ds' };
  const { credentials, logs } = launch(env, {
    'auth.json': { deepseek: { type: 'api_key', key: 'fake-pi-ds' } },
    'models.json': {
      providers: {
        glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'fake-pi-glm' },
      },
    },
  });
  assert.equal(credentials.get('DEEPSEEK_API_KEY'), 'fake-env-ds');
  assert.equal(credentials.get('ZAI_CODING_CN_API_KEY'), 'fake-pi-glm');
  assert.deepEqual(logs, [`Multi: credentials from Pi config (${PI_DIR}): zai-coding-cn.`]);
});

test('a blank environment key counts as unset', () => {
  const { credentials } = launch(
    { DEEPSEEK_API_KEY: '  ' },
    { 'auth.json': { deepseek: { type: 'api_key', key: 'fake-pi-ds' } } },
  );
  assert.equal(credentials.get('DEEPSEEK_API_KEY'), 'fake-pi-ds');
});

test('Pi-config-only DeepSeek becomes an available provider', async () => {
  const env: NodeJS.ProcessEnv = {};
  const { credentials, discoveryEnv } = launch(
    env,
    { 'auth.json': { deepseek: { type: 'api_key', key: 'fake-pi-ds' } } },
    ['deepseek'],
  );
  const discovery = await discoverLaunchProviders(createLaunchRegistry, ['deepseek'], {
    env: discoveryEnv,
    credentials,
    platform: 'linux',
  });
  assert.ok(discovery.availableProviderIds.includes('deepseek'));
  assert.equal(discovery.piKeys.deepseek, 'fake-pi-ds');
});

test('MULTI_STRATA_BASE_URL wins over strata.baseUrl; Pi URL never reaches env', () => {
  const entries = {
    'models.json': { providers: { strata: { baseUrl: 'http://127.0.0.1:8080/v1' } } },
  };
  const explicit: NodeJS.ProcessEnv = { MULTI_STRATA_BASE_URL: 'http://127.0.0.1:47831/v1' };
  assert.equal(
    launch(explicit, entries).discoveryEnv.MULTI_STRATA_BASE_URL,
    'http://127.0.0.1:47831/v1',
  );
  const env: NodeJS.ProcessEnv = {};
  const { discoveryEnv, logs } = launch(env, entries);
  assert.equal(discoveryEnv.MULTI_STRATA_BASE_URL, 'http://127.0.0.1:8080/v1');
  assert.equal(env.MULTI_STRATA_BASE_URL, undefined);
  assert.notEqual(discoveryEnv, env);
  assert.match(logs.join('\n'), /strata base URL/);
});

test('adopted environment references are removed from the launch environment', () => {
  const env: NodeJS.ProcessEnv = { MY_GLM_KEY: 'fake-ref', KEEP_ME: '1' };
  const { credentials } = launch(env, {
    'models.json': {
      providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'MY_GLM_KEY' } },
    },
  });
  assert.equal(credentials.get('ZAI_CODING_CN_API_KEY'), 'fake-ref');
  assert.equal(env.MY_GLM_KEY, undefined);
  assert.equal(env.KEEP_ME, '1');
});

test('ambiguous Pi credentials fail until the environment variable resolves them', () => {
  const entries = {
    'auth.json': { 'zai-coding-cn': { type: 'api_key', key: 'fake-one' } },
    'models.json': {
      providers: { glm: { baseUrl: PI_UPSTREAM_BASE_URLS['zai-coding-cn'], apiKey: 'fake-two' } },
    },
  };
  assert.throws(() => launch({}, entries), /zai-coding-cn has more than one different credential/);
  const { credentials } = launch({ ZAI_CODING_CN_API_KEY: 'fake-env' }, entries);
  assert.equal(credentials.get('ZAI_CODING_CN_API_KEY'), 'fake-env');
});

test('MULTI_PI_CONFIG=0 or no enabled Pi provider never touches Pi files', () => {
  const entries = { 'auth.json': { deepseek: { type: 'api_key', key: 'fake-pi-ds' } } };
  const off = launch({ MULTI_PI_CONFIG: '0' }, entries);
  assert.deepEqual(off.reads, []);
  assert.equal(off.credentials.get('DEEPSEEK_API_KEY'), undefined);
  const notEnabled = launch({}, entries, ['openai', 'zen']);
  assert.deepEqual(notEnabled.reads, []);
});

test('all keys from the environment skips reading auth.json', () => {
  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: 'a',
    ZAI_API_KEY: 'b',
    ZAI_CODING_CN_API_KEY: 'c',
    STRATA_API_KEY: 'd',
    MULTI_STRATA_BASE_URL: 'http://127.0.0.1:1/v1',
  };
  assert.deepEqual(launch(env, {}).reads, []);
});

test('a Pi config canary key reaches only the upstream Authorization header', async () => {
  const canary = 'CANARY_PI_CONFIG_STRATA_KEY';
  const env: NodeJS.ProcessEnv = { MY_STRATA_KEY: canary };
  const { credentials, discoveryEnv, logs } = launch(
    env,
    {
      'models.json': {
        providers: {
          strata: { baseUrl: 'https://strata.fake.invalid/v1', apiKey: 'MY_STRATA_KEY' },
        },
      },
    },
    ['strata'],
  );
  assert.ok(!JSON.stringify(env).includes(canary), 'launch env still carries the canary');
  const discovery = await discoverLaunchProviders(createLaunchRegistry, ['strata'], {
    env: discoveryEnv,
    credentials,
    platform: 'linux',
  });
  const runtime = launcherRuntime(
    '',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    discovery.genericModels,
    createLaunchRegistry,
    undefined,
    discovery.piKeys,
    discovery.strataBaseUrl,
  );
  const descriptor = runtime.registry?.get('strata');
  assert(descriptor?.direct);
  const observed: string[] = [...logs];
  for (const status of [200, 500]) {
    const prepared = descriptor.direct.prepare({
      method: 'POST',
      pathname: '/v1/messages',
      body: {
        model: 'multi/strata/qwen3.8-flash-next',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
      session: `canary-${status}`,
      fallbackSession: 'fallback',
    });
    let authorization = '';
    const opened = await prepared.open(new AbortController().signal, async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      if (init?.method === 'GET') {
        return new Response(JSON.stringify({ data: [{ id: 'wire-model' }] }), { status: 200 });
      }
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: 'upstream failed' } }), { status });
      }
      const events = [
        { choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    assert.equal(authorization, `Bearer ${canary}`);
    observed.push(JSON.stringify(prepared.requestEvent('canary-agent')));
    observed.push(
      JSON.stringify(opened, (_key, value) => (value instanceof Response ? value.status : value)),
    );
    if ('response' in opened && opened.response instanceof Response) {
      observed.push(await opened.response.text());
    }
  }
  assert.ok(!observed.join('\n').includes(canary), 'canary leaked into events or replies');
});

test('main reads Pi config after scrubbing env and passes Strata URL only to discovery', async () => {
  const env: NodeJS.ProcessEnv = { MULTI_ENABLED_PROVIDERS: 'pi', MY_DS_KEY: 'fake-ref-ds' };
  const fake = piFiles({
    'auth.json': { deepseek: { type: 'api_key', key: 'MY_DS_KEY' } },
    'models.json': { providers: { strata: { baseUrl: 'http://127.0.0.1:8123/v1' } } },
  });
  let discoveryOptions: { env?: NodeJS.ProcessEnv; credentials?: ReadonlyMap<string, string> } = {};
  let available: readonly string[] = [];
  await main({
    piConfig: { homedir: HOME, readFile: fake.readFile, log: () => {} },
    env,
    platform: 'linux',
    args: [],
    hooks: {
      versionProbe: async () => {},
      pluginInventory: async () => ({ permissions: {}, multiCoreEnabled: false }),
      anthropicAuth: async () => true,
      discovery: async (factory, selected, options) => {
        discoveryOptions = options ?? {};
        const result = await discoverLaunchProviders(factory, selected, options);
        available = result.availableProviderIds;
        return result;
      },
      afterProbes: () => true,
    },
  });
  assert.equal(discoveryOptions.credentials?.get('DEEPSEEK_API_KEY'), 'fake-ref-ds');
  assert.equal(discoveryOptions.env?.MULTI_STRATA_BASE_URL, 'http://127.0.0.1:8123/v1');
  assert.equal(env.MULTI_STRATA_BASE_URL, undefined);
  assert.equal(env.MY_DS_KEY, undefined);
  assert.deepEqual(available, ['deepseek', 'strata']);
});

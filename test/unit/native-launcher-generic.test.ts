import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { antigravityEnvironment, runAntigravity } from '../../plugins/multi-antigravity/src/cli.ts';
import {
  BUILTIN_PROVIDERS,
  createBuiltinRegistry,
} from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import { nativeEnvironment } from '../../plugins/multi-core/src/gateway/harness-process.ts';
import { takeProviderCredentials } from '../../plugins/multi-core/src/gateway/provider-credentials.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import {
  ProviderRegistry,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import {
  createLaunchRegistry,
  discoverLaunchProviders,
  gatewayEnvironment,
  genericActiveProviders,
  launcherRuntime,
  main,
  pickerSettings,
  workerCatalog,
  workerDefinitions,
} from '../../plugins/multi-core/src/launcher.ts';
import { discoverEnabledProviders } from '../../plugins/multi-core/src/provider-discovery.ts';
import { grokEnvironment, runGrok } from '../../plugins/multi-grok/src/cli.ts';
import { PI_DEEPSEEK_MODELS } from '../../plugins/multi-pi/src/catalog.ts';
import { removeTemporary } from '../temporary.ts';

function context(
  explicit: boolean,
  log: (message: string) => void = () => {},
): ProviderDiscoveryContext {
  return { cwd: '.', env: {}, explicit, log };
}

function registryWithoutStrata() {
  const registry = new ProviderRegistry();
  registry.registerMany(BUILTIN_PROVIDERS.filter(({ id }) => id !== 'strata'));
  return registry;
}

function genericDescriptor(
  available: boolean,
  models: readonly {
    identity: { providerId: string; modelId: string; routeId: string; oneMillionContext: boolean };
    label: string;
    protocol: 'custom';
    capabilities: { text: boolean };
  }[],
  reject?: Error,
) {
  return {
    availability: async () => ({ available, reason: 'not signed in' }),
    discoverModels: async () => {
      if (reject) {
        throw reject;
      }
      return models;
    },
  };
}

const model = {
  identity: {
    providerId: 'strata',
    modelId: 'model-a',
    routeId: 'multi/strata/model-a',
    oneMillionContext: false,
  },
  label: 'Model A',
  protocol: 'custom' as const,
  capabilities: { text: true },
};

test('real launch discovery rejects invalid MULTI_PI_MODELS before generic discovery can swallow it', async () => {
  const env: NodeJS.ProcessEnv = {
    ZAI_API_KEY: 'fake-zai-key',
    MULTI_PI_MODELS: 'glm-not-real',
  };
  await assert.rejects(
    discoverLaunchProviders(createLaunchRegistry, ['zai'], { env, platform: 'linux' }),
    (error: Error) => {
      assert.match(error.message, /glm-not-real/);
      assert.match(error.message, /Allowed IDs:.*glm-5\.3.*glm-5\.2/);
      assert.doesNotMatch(error.message, /fake-zai-key/);
      return true;
    },
  );
});

function offlineLaunchRegistry() {
  const registry = registryWithoutStrata();
  registry.register({
    id: 'strata',
    plugin: 'pi',
    label: 'Offline provider',
    unavailableMessage: 'Offline provider unavailable',
    kind: 'direct',
    direct: {
      signaturePrefixes: [],
      prepare: () => {
        throw new Error('offline discovery only');
      },
    },
    autoReview: { review: 'none', statement: 'unreviewed' },
    ...genericDescriptor(true, [model]),
  });
  return registry;
}

test('invalid MULTI_PI_MODELS is ignored without effective selected Pi keys', async () => {
  const factory = offlineLaunchRegistry;
  const selected = ['strata', 'deepseek', 'zai', 'zai-coding-cn'];
  for (const keys of [
    {},
    { DEEPSEEK_API_KEY: ' ', ZAI_API_KEY: '\t', ZAI_CODING_CN_API_KEY: '\n' },
  ]) {
    const result = await discoverLaunchProviders(factory, selected, {
      env: { ...keys, MULTI_PI_MODELS: 'glm-not-real' },
      platform: 'linux',
    });
    assert.deepEqual(result.availableProviderIds, ['strata']);
    assert.deepEqual(result.genericModels.strata, [model]);
    for (const id of ['deepseek', 'zai', 'zai-coding-cn']) {
      assert.deepEqual(result.genericModels[id], []);
    }
  }
  const disabled = await discoverLaunchProviders(factory, ['strata'], {
    env: { ZAI_API_KEY: 'fake-disabled-key', MULTI_PI_MODELS: 'glm-not-real' },
    platform: 'linux',
  });
  assert.deepEqual(disabled.availableProviderIds, ['strata']);
  const blankCredentials = await discoverLaunchProviders(factory, selected, {
    env: { MULTI_PI_MODELS: 'glm-not-real' },
    credentials: new Map([['ZAI_API_KEY', '   ']]),
  });
  assert.deepEqual(blankCredentials.availableProviderIds, ['strata']);
});

test('invalid MULTI_PI_MODELS rejects every effective Pi key from env or credentials', async () => {
  for (const name of ['DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY']) {
    for (const supplied of [false, true]) {
      const key = `fake-${name}-key`;
      await assert.rejects(
        discoverLaunchProviders(createLaunchRegistry, ['deepseek', 'zai', 'zai-coding-cn'], {
          env: { MULTI_PI_MODELS: 'glm-not-real', ...(supplied ? {} : { [name]: key }) },
          ...(supplied ? { credentials: new Map([[name, key]]) } : {}),
          platform: 'linux',
        }),
        (error: Error) => {
          assert.match(error.message, /glm-not-real/);
          assert.match(
            error.message,
            /Allowed IDs: deepseek-v4-pro, deepseek-flash, glm-5\.3, glm-5\.2, glm-5\.3-flash, qwen3\.8-flash-next/,
          );
          assert.ok(!error.message.includes(key));
          return true;
        },
      );
    }
  }
});

for (const [providerId, name] of [
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['zai', 'ZAI_API_KEY'],
  ['zai-coding-cn', 'ZAI_CODING_CN_API_KEY'],
] as const) {
  for (const source of ['empty map', 'other provider map'] as const) {
    test(`mixed credential sources reject invalid MULTI_PI_MODELS: ${providerId}, ${source}`, async () => {
      const key = `fake-env-${providerId}-key`;
      const otherKey = 'fake-other-provider-key';
      const credentials = new Map<string, string>(
        source === 'empty map' ? [] : [['ZEN_API_KEY', otherKey]],
      );
      await assert.rejects(
        discoverLaunchProviders(createLaunchRegistry, [providerId], {
          env: { [name]: key, MULTI_PI_MODELS: 'glm-not-real' },
          credentials,
          platform: 'linux',
        }),
        (error: Error) => {
          assert.match(error.message, /glm-not-real/);
          assert.match(
            error.message,
            /Allowed IDs: deepseek-v4-pro, deepseek-flash, glm-5\.3, glm-5\.2, glm-5\.3-flash, qwen3\.8-flash-next/,
          );
          assert.ok(!error.message.includes(key));
          assert.ok(!error.message.includes(otherKey));
          return true;
        },
      );
    });
  }

  test(`mixed credential sources preserve explicit blank overrides: ${providerId}`, async () => {
    for (const value of ['', ' ', '\t\n']) {
      const result = await discoverLaunchProviders(offlineLaunchRegistry, ['strata', providerId], {
        env: { [name]: `fake-env-${providerId}-key`, MULTI_PI_MODELS: 'glm-not-real' },
        credentials: new Map([[name, value]]),
        platform: 'linux',
      });
      assert.deepEqual(result.availableProviderIds, ['strata']);
      assert.deepEqual(result.genericModels.strata, [model]);
      assert.deepEqual(result.genericModels[providerId], []);
    }
  });
}

test('keyless DeepSeek and unconfigured Strata discovery produce no picker rows or workers', async () => {
  const discovery = await discoverLaunchProviders(createLaunchRegistry, ['deepseek', 'strata'], {
    env: {},
    platform: 'linux',
  });
  assert.ok(!discovery.availableProviderIds.includes('deepseek'));
  assert.ok(!discovery.availableProviderIds.includes('strata'));
  const settings = pickerSettings(
    false,
    [],
    false,
    [],
    [],
    false,
    discovery.availableProviderIds,
    discovery.genericModels,
  );
  assert.deepEqual(
    settings.modelPicker.options.filter(
      ({ model: id }) => id.startsWith('multi/deepseek/') || id.startsWith('multi/strata/'),
    ),
    [],
  );
  assert.deepEqual(workerDefinitions(workerCatalog(settings.modelPicker.options)), {});
});

test('main expands plugin selection pi into all providers and activates DeepSeek', async () => {
  const env: NodeJS.ProcessEnv = {
    MULTI_ENABLED_PROVIDERS: 'pi',
    DEEPSEEK_API_KEY: 'T051_DEEPSEEK',
    ZAI_API_KEY: 'T051_ZAI',
    ZAI_CODING_CN_API_KEY: 'T051_ZAI_CN',
    MULTI_STRATA_BASE_URL: 'http://127.0.0.1:8123/v1',
  };
  let launchedDiscovery: Awaited<ReturnType<typeof discoverLaunchProviders>> | undefined;
  let selectedIds: readonly string[] | undefined;
  await main({
    env,
    platform: 'linux',
    args: [],
    hooks: {
      versionProbe: async () => {},
      pluginInventory: async () => ({ permissions: {}, multiCoreEnabled: false }),
      anthropicAuth: async () => true,
      discovery: async (factory, selected, options) => {
        selectedIds = selected;
        launchedDiscovery = await discoverLaunchProviders(factory, selected, options);
        return launchedDiscovery;
      },
      afterProbes: () => true,
    },
  });
  assert.deepEqual(selectedIds, ['deepseek', 'zai', 'zai-coding-cn', 'strata']);
  assert.deepEqual(launchedDiscovery?.availableProviderIds, [
    'deepseek',
    'zai',
    'zai-coding-cn',
    'strata',
  ]);
  assert.equal(launchedDiscovery?.genericModels.deepseek?.length, 2);
  const settings = pickerSettings(
    false,
    [],
    false,
    [],
    [],
    false,
    launchedDiscovery?.availableProviderIds,
    launchedDiscovery?.genericModels,
  );
  assert.deepEqual(
    settings.modelPicker.options
      .filter(({ model: id }) => id.startsWith('multi/deepseek/'))
      .map(({ model: id }) => id),
    ['multi/deepseek/deepseek-v4-pro', 'multi/deepseek/deepseek-flash'],
  );
  const agents = workerDefinitions(workerCatalog(settings.modelPicker.options));
  assert.ok(agents['multi-deepseek']);
  const runtime = launcherRuntime(
    '',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    launchedDiscovery?.genericModels,
    createLaunchRegistry,
    launchedDiscovery?.deepseekKey,
    launchedDiscovery?.piKeys,
    launchedDiscovery?.strataBaseUrl,
  );
  const descriptor = runtime.registry?.get('deepseek');
  assert.ok(descriptor?.direct);
  assert.equal(
    descriptor.direct.prepare({
      method: 'POST',
      pathname: '/v1/messages',
      body: {
        model: 'multi/deepseek/deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
      },
      session: 'session',
      fallbackSession: 'fallback',
    }).route,
    'deepseek',
  );
});

test('MULTI_MODELS=all picker output stays within the curated DeepSeek allowlist', () => {
  // Observe the actual post-filter settings passed to the harness, stopping before
  // permissions, gateway startup, or spawning Claude. Module mocks stay in this child.
  const fixture = `
    import assert from 'node:assert/strict';
    import { mock } from 'node:test';
    import * as fs from 'node:fs/promises';
    const stop = new Error('captured caller settings');
    let settings;
    mock.module('node:fs/promises', { namedExports: {
      ...fs,
      mkdtemp: async () => '/virtual/T051-settings',
      writeFile: async (file, body) => {
        assert.equal(file.replaceAll('\\\\', '/'), '/virtual/T051-settings/caller-settings.json');
        settings = JSON.parse(body);
        throw stop;
      },
    }});
    const { main } = await import('./plugins/multi-core/src/launcher.ts');
    await assert.rejects(main({
      env: {
        MULTI_MODELS: 'all',
        MULTI_ENABLED_PROVIDERS: 'pi',
        DEEPSEEK_API_KEY: 'T051_DEEPSEEK',
      },
      platform: 'linux',
      args: [],
      hooks: {
        versionProbe: async () => {},
        pluginInventory: async () => ({ permissions: {}, multiCoreEnabled: false }),
        anthropicAuth: async () => true,
      },
    }), (error) => error === stop);
    assert.ok(settings);
    console.log(JSON.stringify(settings.modelPicker.options));
  `;
  const child = spawnSync(
    process.execPath,
    ['--experimental-test-module-mocks', '--input-type=module', '-e', fixture],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MULTI_MODELS: 'all', MULTI_ENABLED_PROVIDERS: 'pi' },
    },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const rows = JSON.parse(child.stdout) as { model: string }[];
  assert.deepEqual(
    rows.filter(({ model: id }) => id.startsWith('multi/deepseek/')).map(({ model: id }) => id),
    PI_DEEPSEEK_MODELS.map(({ id }) => `multi/deepseek/${id}`),
  );
});

test('an invalid nonblank DeepSeek key does not trigger network access during discovery', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('unexpected discovery network access');
  };
  try {
    const result = await discoverLaunchProviders(createLaunchRegistry, ['deepseek'], {
      env: { DEEPSEEK_API_KEY: 'T051_INVALID_KEY' },
      platform: 'linux',
    });
    assert.deepEqual(result.availableProviderIds, ['deepseek']);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Strata discovery requires a valid configured address and admits loopback without a key', async () => {
  const noAddressEnv: NodeJS.ProcessEnv = { STRATA_API_KEY: 'fake-strata-key' };
  const disabled = await discoverLaunchProviders(createLaunchRegistry, ['strata'], {
    env: noAddressEnv,
    platform: 'linux',
  });
  assert.equal(noAddressEnv.STRATA_API_KEY, undefined);
  assert.deepEqual(disabled.availableProviderIds, []);
  assert.deepEqual(disabled.genericModels.strata, []);

  const localEnv: NodeJS.ProcessEnv = { MULTI_STRATA_BASE_URL: 'http://127.0.0.1:8080/v1' };
  const local = await discoverLaunchProviders(createLaunchRegistry, ['strata'], {
    env: localEnv,
    platform: 'linux',
  });
  assert.deepEqual(local.availableProviderIds, ['strata']);
  assert.deepEqual(
    local.genericModels.strata?.map(({ identity }) => identity.routeId),
    ['multi/strata/qwen3.8-flash-next'],
  );

  await assert.rejects(
    discoverLaunchProviders(createLaunchRegistry, ['strata'], {
      env: { MULTI_STRATA_BASE_URL: 'https://strata.fake.invalid/v1' },
      platform: 'linux',
    }),
    /STRATA_API_KEY/,
  );
  await assert.rejects(
    discoverLaunchProviders(createLaunchRegistry, ['strata'], {
      env: { MULTI_STRATA_BASE_URL: 'http://strata.fake.invalid/v1' },
      platform: 'linux',
    }),
    /HTTPS or HTTP on loopback/,
  );
});

test('Strata rejects blank credentials and never falls back to another Pi provider key', async () => {
  for (const credentials of [
    new Map<string, string>(),
    ...['', '  ', '\t\n'].map((key) => new Map<string, string>([['STRATA_API_KEY', key]])),
  ]) {
    await assert.rejects(
      discoverLaunchProviders(createLaunchRegistry, ['strata', 'deepseek', 'zai'], {
        env: {
          MULTI_STRATA_BASE_URL: 'https://strata.fake.invalid/v1',
          ...(credentials.has('STRATA_API_KEY') ? { STRATA_API_KEY: 'fake-host-strata-key' } : {}),
          DEEPSEEK_API_KEY: 'fake-deepseek-key',
          ZAI_API_KEY: 'fake-zai-key',
        },
        credentials,
        platform: 'linux',
      }),
      (error: Error) => {
        assert.equal(error.message, 'Strata requires STRATA_API_KEY for a non-loopback base URL.');
        assert.doesNotMatch(error.message, /fake-host-strata-key|fake-deepseek-key|fake-zai-key/);
        return true;
      },
    );
  }
});

test('real launcher binds all Pi keys to their provider requests and omits providers without keys', async () => {
  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: 'fake-deepseek-key',
    ZAI_API_KEY: 'fake-zai-key',
    ZAI_CODING_CN_API_KEY: 'fake-cn-key',
  };
  const discovery = await discoverLaunchProviders(
    createLaunchRegistry,
    ['deepseek', 'zai', 'zai-coding-cn'],
    { env, platform: 'linux' },
  );
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.ZAI_API_KEY, undefined);
  assert.equal(env.ZAI_CODING_CN_API_KEY, undefined);
  assert.deepEqual(discovery.piKeys, {
    deepseek: 'fake-deepseek-key',
    zai: 'fake-zai-key',
    'zai-coding-cn': 'fake-cn-key',
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
  );
  for (const [providerId, key, modelId] of [
    ['deepseek', 'fake-deepseek-key', 'deepseek-v4-pro'],
    ['zai', 'fake-zai-key', 'glm-5.3'],
    ['zai-coding-cn', 'fake-cn-key', 'glm-5.3'],
  ] as const) {
    const descriptor = runtime.registry?.get(providerId);
    assert(descriptor?.direct);
    const prepared = descriptor.direct.prepare({
      method: 'POST',
      pathname: '/v1/messages',
      body: {
        model: `multi/${providerId}/${modelId}`,
        messages: [{ role: 'user', content: 'hi' }],
      },
      session: 'session',
      fallbackSession: 'fallback',
    });
    let authorization: string | null = null;
    await prepared.open(new AbortController().signal, async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response('data: [DONE]\\n\\n', { status: 200 });
    });
    assert.equal(authorization, `Bearer ${key}`);
  }

  const onlyZai = await discoverLaunchProviders(createLaunchRegistry, ['zai', 'zai-coding-cn'], {
    env: { ZAI_API_KEY: 'fake-only-zai-key' },
    platform: 'linux',
  });
  assert.ok(onlyZai.availableProviderIds.includes('zai'));
  assert.ok(!onlyZai.availableProviderIds.includes('zai-coding-cn'));
  assert.deepEqual(onlyZai.genericModels['zai-coding-cn'], []);
  const unavailableRuntime = launcherRuntime(
    '',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    onlyZai.genericModels,
    createLaunchRegistry,
    undefined,
    onlyZai.piKeys,
  );
  assert.throws(
    () =>
      unavailableRuntime.registry?.get('zai-coding-cn')?.direct?.prepare({
        method: 'POST',
        pathname: '/v1/messages',
        body: { model: 'multi/zai-coding-cn/glm-5.3', messages: [{ role: 'user', content: 'hi' }] },
        session: 'session',
        fallbackSession: 'fallback',
      }),
    /ZAI_CODING_CN_API_KEY/,
  );
});

test('generic launcher discovery handles available and unavailable providers', async () => {
  const available = genericDescriptor(true, [model]);
  const unavailable = genericDescriptor(false, [model]);
  const registry = {
    list: () => [{ id: 'strata' }, { id: 'deepseek' }],
    get: (id: string) => (id === 'strata' ? available : unavailable),
  };
  const results = await discoverEnabledProviders(registry, undefined, {}, (_id) => context(false));
  assert.deepEqual(results, { strata: [model], deepseek: [] });
});

test('generic launcher discovery logs only explicit unavailable and failure cases', async () => {
  const messages: string[] = [];
  const failure = genericDescriptor(true, [], new Error('catalog offline'));
  const unavailable = genericDescriptor(false, []);
  const registry = {
    list: () => [{ id: 'strata' }, { id: 'deepseek' }],
    get: (id: string) => (id === 'strata' ? failure : unavailable),
  };
  const results = await discoverEnabledProviders(registry, undefined, {}, (_id) =>
    context(true, (message) => messages.push(message)),
  );
  assert.deepEqual(results, { strata: [], deepseek: [] });
  assert.deepEqual(messages.sort(), [
    'DeepSeek unavailable: not signed in',
    'Strata discovery failed: catalog offline',
  ]);
});

test('generic launcher picker creates model rows with shared route encoding and fact order', () => {
  const settings = pickerSettings(false, [], false, [], [], false, ['strata'], {
    strata: [
      {
        ...model,
        identity: { ...model.identity, modelId: 'model/a' },
        description: 'Custom endpoint',
        reasoning: { efforts: ['low'] },
      },
    ],
  });
  assert.deepEqual(settings.modelPicker.options, [
    {
      model: 'multi/strata/model%2Fa',
      label: 'Strata · Model A',
      description: 'Custom endpoint',
      behavesAs: 'claude-sonnet-4-6',
    },
  ]);
});

test('generic discovered models are activated in ProviderRuntime', () => {
  const descriptor: ProviderDescriptor = {
    id: 'strata',
    plugin: 'pi',
    label: 'Strata',
    kind: 'direct',
    autoReview: { review: 'none', statement: 'No reviewer' },
    availability: async () => ({ available: true }),
    discoverModels: async () => [model],
    direct: {
      prepare: () => {
        throw new Error('not invoked');
      },
      signaturePrefixes: [],
    },
    unavailableMessage: 'Strata unavailable',
  };
  const active = genericActiveProviders([descriptor], { strata: [model] });
  const runtime = new ProviderRuntime(active);
  assert.deepEqual(
    runtime.active().map(({ descriptor: provider, models }) => [provider.id, models]),
    [['strata', [model]]],
  );
});

test('launcher takes enabled credentials before discovery and isolates each provider context', async () => {
  const seen: Record<string, NodeJS.ProcessEnv> = {};
  const make = (id: 'zai' | 'strata', credential: string): ProviderDescriptor => ({
    id,
    plugin: 'pi',
    label: id,
    kind: 'direct',
    credentialEnv: [credential],
    autoReview: { review: 'none', statement: 'No reviewer' },
    direct: {
      prepare: () => {
        throw new Error('not invoked');
      },
      signaturePrefixes: [],
    },
    availability: async (context) => {
      assert.equal(env[credential], undefined, 'host environment is scrubbed before discovery');
      seen[id] = context.env;
      return { available: true };
    },
    discoverModels: async () => [],
    unavailableMessage: `${id} unavailable`,
  });
  const zai = make('zai', 'ZAI_API_KEY');
  const strata = make('strata', 'STRATA_API_KEY');
  const registryFactory = () => {
    const registry = new ProviderRegistry();
    registry.registerMany([zai, strata]);
    return registry;
  };
  const env: NodeJS.ProcessEnv = {
    ZAI_API_KEY: 'zai-secret',
    STRATA_API_KEY: 'strata-secret',
    KEEP: 'visible',
  };
  await discoverLaunchProviders(registryFactory, ['zai', 'strata'], {
    env,
    platform: 'linux',
  });
  assert.deepEqual(env, { KEEP: 'visible' });
  assert.equal(seen.zai?.ZAI_API_KEY, 'zai-secret');
  assert.equal(seen.zai?.STRATA_API_KEY, undefined);
  assert.equal(seen.strata?.STRATA_API_KEY, 'strata-secret');
  assert.equal(seen.strata?.ZAI_API_KEY, undefined);
});

test('real launch registry scrubs DeepSeek only when enabled and isolates other provider contexts', async () => {
  const otherContexts: Array<string | undefined> = [];
  const otherProvider: ProviderDescriptor = {
    id: 'strata',
    plugin: 'pi',
    label: 'Z.AI',
    kind: 'direct',
    autoReview: { review: 'none', statement: 'No reviewer' },
    unavailableMessage: 'Z.AI unavailable',
    direct: {
      signaturePrefixes: [],
      prepare: () => {
        throw new Error('not invoked');
      },
    },
    availability: async (context) => {
      otherContexts.push(context.env.DEEPSEEK_API_KEY);
      return { available: true };
    },
    discoverModels: async () => [],
  };
  const registryFactory = () => {
    const registry = registryWithoutStrata();
    registry.register(otherProvider);
    return registry;
  };
  const enabledEnv: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'fake-deepseek-key' };
  const enabled = await discoverLaunchProviders(registryFactory, ['deepseek', 'strata'], {
    env: enabledEnv,
    platform: 'linux',
  });
  assert.equal(enabled.deepseekKey, 'fake-deepseek-key');
  assert.equal(enabledEnv.DEEPSEEK_API_KEY, undefined);
  assert.deepEqual(otherContexts, [undefined]);

  const disabledEnv: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'fake-disabled-key' };
  const disabled = await discoverLaunchProviders(registryFactory, ['strata'], {
    env: disabledEnv,
    platform: 'linux',
  });
  assert.equal(disabled.deepseekKey, undefined);
  assert.equal(disabledEnv.DEEPSEEK_API_KEY, 'fake-disabled-key');
  assert.deepEqual(otherContexts, [undefined, 'fake-disabled-key']);
});

test('main scrubs the real host before help and every startup probe, forwarding win32 selection', async () => {
  const envKeys = ['MULTI_ENABLED_PROVIDERS', 'OPENCODE_API_KEY', 'opencode_api_key'] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.MULTI_ENABLED_PROVIDERS = 'zen';
  delete process.env.OPENCODE_API_KEY;
  process.env.opencode_api_key = 'host-secret';
  const reached: string[] = [];
  try {
    await main({
      env: process.env,
      platform: 'win32',
      args: ['--help'],
      hooks: {
        command: async () => {
          reached.push('help');
          assert.equal(process.env.opencode_api_key, undefined);
          return true;
        },
      },
    });
    assert.deepEqual(reached, ['help']);

    process.env.OPENCODE_API_KEY = 'owned-secret';
    await main({
      env: process.env,
      platform: 'win32',
      args: [],
      hooks: {
        command: async () => false,
        versionProbe: async () => {
          reached.push('version');
          assert.equal(process.env.OPENCODE_API_KEY, undefined);
        },
        pluginInventory: async () => {
          reached.push('inventory');
          assert.equal(process.env.OPENCODE_API_KEY, undefined);
          return { permissions: {}, multiCoreEnabled: false };
        },
        anthropicAuth: async () => {
          reached.push('anthropic');
          assert.equal(process.env.OPENCODE_API_KEY, undefined);
          return true;
        },
        discovery: async (factory, selected, options) => {
          reached.push('discovery');
          assert.equal(process.env.OPENCODE_API_KEY, undefined);
          assert.deepEqual(options?.credentials, new Map([['OPENCODE_API_KEY', 'owned-secret']]));
          return discoverLaunchProviders(factory, selected, options);
        },
        afterProbes: () => true,
      },
    });
    assert.deepEqual(reached, ['help', 'version', 'inventory', 'anthropic', 'discovery']);
  } finally {
    restore();
  }
});

test('Pi keys are scrubbed before Claude and provider harness spawn boundaries', async () => {
  const names = ['DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY', 'STRATA_API_KEY'];
  const registry = createBuiltinRegistry();
  const credentialNames = registry.list().flatMap(({ credentialEnv }) => credentialEnv ?? []);
  const touchedNames = new Set([
    ...credentialNames,
    ...Object.keys(process.env).filter((key) =>
      credentialNames.some((name) =>
        process.platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name,
      ),
    ),
  ]);
  const before = new Map([...touchedNames].map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      process.env[name] = `test-only-${name}`;
    }
    process.env.OPENCODE_API_KEY = 'test-only-zen-key';
    const credentials = takeProviderCredentials(process.env, registry.list(), {
      platform: process.platform,
    });
    assert.deepEqual([...credentials.keys()].sort(), [...names, 'OPENCODE_API_KEY'].sort());
    assert.equal(credentials.get('OPENCODE_API_KEY') === 'test-only-zen-key', true);
    assert.equal(process.env.OPENCODE_API_KEY, undefined);
    assert.deepEqual(
      Object.fromEntries(names.map((name) => [name, typeof process.env[name] === 'string'])),
      Object.fromEntries(names.map((name) => [name, false])),
    );
    const claudeEnv = gatewayEnvironment(43210, 'test-only-token', false, registry);
    const bashInheritedEnv = nativeEnvironment({ overrides: claudeEnv });
    const fixture = `
      const names = ${JSON.stringify(names)};
      process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name => [name, typeof process.env[name] === 'string']))));
    `;
    const assertFixture = (env: NodeJS.ProcessEnv) => {
      const child = spawnSync(process.execPath, ['-e', fixture], {
        encoding: 'utf8',
        env,
        timeout: 10000,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(child.stdout),
        Object.fromEntries(names.map((name) => [name, false])),
      );
    };
    assertFixture(claudeEnv);
    assertFixture(bashInheritedEnv);

    const captureSpawn = (
      _command: string,
      _args: readonly string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      assertFixture(options?.env ?? {});
      throw new Error('captured provider spawn environment');
    };
    await assert.rejects(
      runAntigravity({
        cwd: os.tmpdir(),
        prompt: 'fixture',
        signal: new AbortController().signal,
        env: claudeEnv,
        executable: process.execPath,
        spawn: captureSpawn,
      }),
      /captured provider spawn environment/,
    );
    assertFixture(antigravityEnvironment(claudeEnv));

    await assert.rejects(
      runGrok({
        cwd: os.tmpdir(),
        prompt: 'fixture',
        signal: new AbortController().signal,
        env: claudeEnv,
        executable: process.execPath,
        spawn: captureSpawn,
      }),
      /captured provider spawn environment/,
    );
    assertFixture(grokEnvironment(claudeEnv));

    const directory = await mkdtemp(path.join(os.tmpdir(), 'launcher-pi-spawn-'));
    try {
      const launcherUrl = new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url).href;
      const cursorHarnessUrl = new URL('../../plugins/multi-cursor/src/harness.ts', import.meta.url)
        .href;
      const cursorModelsUrl = new URL('../../plugins/multi-cursor/src/models.ts', import.meta.url)
        .href;
      const fixture = `
        const { spawnSync } = await import('node:child_process');
        const names = ${JSON.stringify(names)};
        const nestedSource = 'process.stdout.write(JSON.stringify(Object.fromEntries(JSON.parse(process.argv[1]).map(name => [name, typeof process.env[name] === "string"]))))';
        const nested = spawnSync(process.execPath, ['-e', nestedSource, JSON.stringify(names)], { encoding: 'utf8', env: process.env });
        process.stdout.write(JSON.stringify({
          scrubbedBeforeSpawn: process.env.T049_SCRUBBED_BEFORE_SPAWN === 'true',
          claude: Object.fromEntries(names.map(name => [name, typeof process.env[name] === 'string'])),
          bash: JSON.parse(nested.stdout),
        }));
      `;
      const script = `
        import assert from 'node:assert/strict';
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        const require = createRequire(import.meta.url);
        const childProcess = require('node:child_process');
        const names = ${JSON.stringify(names)};
        const fixture = ${JSON.stringify(fixture)};
        const realSpawn = childProcess.spawn;
        childProcess.spawn = (_command, _args, options = {}) => {
          const scrubbed = names.every(name => typeof process.env[name] !== 'string');
          return realSpawn(process.execPath, ['-e', fixture], {
            ...options,
            env: { ...options.env, T049_SCRUBBED_BEFORE_SPAWN: String(scrubbed) },
          });
        };
        syncBuiltinESMExports();
        for (const name of names) process.env[name] = 'test-only-' + name;
        process.env.MULTI_REAL_CLAUDE = process.execPath;
        const { main } = await import(${JSON.stringify(launcherUrl)});
        const { CursorHarness } = await import(${JSON.stringify(cursorHarnessUrl)});
        const { cursorModelOptions } = await import(${JSON.stringify(cursorModelsUrl)});
        const cleanSnapshot = Object.fromEntries(names.map(name => [name, false]));
        const snapshot = () => Object.fromEntries(names.map(name => [name, typeof process.env[name] === 'string']));
        await main({
          args: [],
          hooks: {
            versionProbe: async () => {},
            pluginInventory: async () => ({ permissions: {}, multiCoreEnabled: false }),
            anthropicAuth: async () => true,
            discovery: async () => {
              assert.deepEqual(snapshot(), cleanSnapshot, 'Pi credentials reached Cursor discovery before production scrub');
              const models = cursorModelOptions([{ id: 'test-model', displayName: 'Test Model' }]);
              let sdkCalls = 0;
              const harness = new CursorHarness(models, {
                cwd: process.cwd(),
                stateDirectory: process.cwd() + '/cursor-state',
                createAgent: async () => {
                  assert.deepEqual(snapshot(), cleanSnapshot, 'Pi credentials reached Cursor SDK create');
                  sdkCalls++;
                  throw new Error('captured Cursor SDK environment');
                },
                resumeAgent: async () => { throw new Error('unexpected Cursor SDK resume'); },
              });
              try {
                await assert.rejects(
                  harness.handle(
                    { model: models[0].model, messages: [{ role: 'user', content: 'fixture' }] },
                    'main', new AbortController().signal, undefined, { permissionMode: 'auto' },
                  ),
                  /captured Cursor SDK environment/,
                );
                assert.equal(sdkCalls, 1, 'production harness must reach injected SDK create');
              } finally {
                await harness.close();
              }
              return {
                codexSignedIn: false,
                openaiReview: false,
                cursorModels: [],
                antigravityModels: [],
                grokModels: [],
                genericModels: {},
                piKeys: {},
                availableProviderIds: [],
              };
            },
          },
        });
      `;
      const inheritedEnv = Object.fromEntries(
        ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
        ),
      );
      const launched = spawnSync(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', script],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 15000,
          env: { ...inheritedEnv, HOME: directory, USERPROFILE: directory },
        },
      );
      assert.equal(launched.status, 0, `${launched.stdout}\n${launched.stderr}`);
      const output = JSON.parse(launched.stdout.trim()) as {
        scrubbedBeforeSpawn: boolean;
        claude: Record<string, boolean>;
        bash: Record<string, boolean>;
      };
      assert.equal(output.scrubbedBeforeSpawn, true);
      assert.deepEqual(output.claude, Object.fromEntries(names.map((name) => [name, false])));
      assert.deepEqual(output.bash, Object.fromEntries(names.map((name) => [name, false])));
    } finally {
      await removeTemporary(directory);
    }
  } finally {
    for (const name of touchedNames) {
      const value = before.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  for (const name of touchedNames) {
    assert.equal(process.env[name] === before.get(name), true, `${name} was not restored`);
  }
});

test('Zen rejects an explicitly empty key without falling back to the auth file', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'launcher-zen-credentials-'));
  t.after(() => removeTemporary(directory));
  const authFile = path.join(directory, 'auth.json');
  await writeFile(authFile, JSON.stringify({ opencode: { type: 'api', key: 'valid-disk-key' } }));

  for (const key of ['', '  ']) {
    const env: NodeJS.ProcessEnv = { OPENCODE_API_KEY: key, OPENCODE_AUTH_FILE: authFile };
    await assert.rejects(
      discoverLaunchProviders(createLaunchRegistry, ['zen'], { env, platform: 'linux' }),
      { message: 'Invalid OpenCode Zen API key.' },
    );
    assert.equal(env.OPENCODE_API_KEY, undefined);
  }

  const valid = await discoverLaunchProviders(createLaunchRegistry, ['zen'], {
    env: { OPENCODE_API_KEY: 'valid-env-key', OPENCODE_AUTH_FILE: authFile },
    platform: 'linux',
  });
  assert.equal(valid.zenKey, 'valid-env-key');
  assert.equal(
    createLaunchRegistry().get('zen')?.unavailableMessage,
    'Zen is not configured. Set OPENCODE_API_KEY or connect OpenCode Zen.',
  );
});

for (const platform of ['linux', 'win32'] as const) {
  test(`disabled Pi discovery preserves all six environment sentinels on ${platform}`, async () => {
    const names = [
      'DEEPSEEK_API_KEY',
      'ZAI_API_KEY',
      'ZAI_CODING_CN_API_KEY',
      'STRATA_API_KEY',
      'MULTI_STRATA_BASE_URL',
      'MULTI_PI_MODELS',
    ] as const;
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      names.map((name) => [name, `T051_SENTINEL_${name}`]),
    );
    const before = { ...env };
    const result = await discoverLaunchProviders(createLaunchRegistry, [], { env, platform });
    assert.deepEqual(env, before);
    assert.deepEqual(result.availableProviderIds, []);
    assert.deepEqual(result.genericModels, {});
  });
}

test('launcher discovery and runtime share a registry factory without duplicate registration', async () => {
  const strata = {
    id: 'strata',
    plugin: 'pi',
    label: 'Strata',
    kind: 'direct' as const,
    autoReview: { review: 'none' as const, statement: 'No reviewer' },
    availability: async () => ({ available: true }),
    discoverModels: async () => [model],
    direct: {
      prepare: () => {
        throw new Error('not invoked');
      },
      signaturePrefixes: [],
    },
    unavailableMessage: 'Strata unavailable',
  } satisfies ProviderDescriptor;
  const receivedCredentials: Array<
    { authFile?: string; zenKey?: string; deepseekKey?: string } | undefined
  > = [];
  const factory = (credentials?: { authFile?: string; zenKey?: string; deepseekKey?: string }) => {
    receivedCredentials.push(credentials);
    const registry = new ProviderRegistry();
    registry.registerMany(
      createBuiltinRegistry(credentials)
        .list()
        .filter(({ id }) => id !== 'strata'),
    );
    registry.register(strata);
    return registry;
  };
  assert.equal(typeof createLaunchRegistry, 'function');
  const discovery = await discoverLaunchProviders(factory, ['strata']);
  const runtime = launcherRuntime(
    'auth-file',
    'zen-secret',
    {
      openai: async () => ({ summary: '', details: [] }),
      zen: async () => ({ summary: '', details: [] }),
    },
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    discovery.genericModels,
    factory,
    'fake-deepseek-key',
  );
  assert.deepEqual(
    runtime
      .active()
      .filter(({ descriptor }) => descriptor.id === 'strata')
      .map(({ models }) => models),
    [[model]],
  );
  assert.ok(runtime.registry?.get('strata')?.direct);
  assert.ok(runtime.registry?.get('openai')?.direct);
  assert.ok(runtime.registry?.get('zen')?.direct);
  const deepseekAdapter = runtime.registry?.get('deepseek')?.direct;
  assert.ok(deepseekAdapter);
  const deepseekPrepared = deepseekAdapter.prepare({
    method: 'POST',
    pathname: '/v1/messages',
    body: { model: 'multi/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
    session: 'session',
    fallbackSession: 'fallback',
  });
  assert.equal(deepseekPrepared.route, 'deepseek');
  assert.deepEqual(receivedCredentials, [
    undefined,
    { authFile: 'auth-file', zenKey: 'zen-secret', deepseekKey: 'fake-deepseek-key' },
  ]);
  assert.equal(runtime.active().filter(({ descriptor }) => descriptor.id === 'openai').length, 1);
  assert.equal(runtime.active().filter(({ descriptor }) => descriptor.id === 'zen').length, 1);
  assert.deepEqual(
    launcherRuntime(
      'auth-file',
      undefined,
      {},
      { cursor: undefined, antigravity: undefined, grok: undefined },
      undefined,
      { strata: [] },
      factory,
    )
      .active()
      .filter(({ descriptor }) => descriptor.id === 'strata'),
    [],
  );
  assert.throws(
    () =>
      launcherRuntime(
        'auth-file',
        undefined,
        {},
        { cursor: undefined, antigravity: undefined, grok: undefined },
        undefined,
        { absent: [model] },
        factory,
      ),
    /Missing provider descriptor for discovered provider: absent/,
  );
});

test('generic picker appends fact-ordered provider models with fallback descriptions and profiles', () => {
  const makeModel = (providerId: string, modelId: string, label: string, efforts?: string[]) => ({
    ...model,
    identity: { ...model.identity, providerId, modelId },
    label,
    ...(efforts ? { reasoning: { efforts } } : {}),
  });
  const settings = pickerSettings(
    true,
    [],
    false,
    [],
    [],
    false,
    ['strata', 'deepseek', 'zen', 'openai'],
    {
      strata: [
        makeModel('strata', 's1', 'Strata One'),
        makeModel('strata', 's2', 'Strata Two', ['low']),
      ],
      deepseek: [
        makeModel('deepseek', 'd1', 'Deep One'),
        makeModel('deepseek', 'd2', 'Deep Two', ['medium']),
      ],
    },
  );
  const options = settings.modelPicker.options;
  const genericStart = options.findIndex(({ model: id }) => id.startsWith('multi/deepseek/'));
  const generic = options.slice(genericStart);
  assert.ok(genericStart > 0);
  assert.ok(
    options.slice(0, genericStart).every(({ model: id }) => id.startsWith('multi/openai/')),
  );
  assert.deepEqual(
    generic.map(({ model: id, label: name, description, behavesAs }) => [
      id,
      name,
      description,
      behavesAs,
    ]),
    [
      ['multi/deepseek/d1', 'DeepSeek · Deep One', 'DeepSeek · Claude tools', 'claude-haiku-4-5'],
      ['multi/deepseek/d2', 'DeepSeek · Deep Two', 'DeepSeek · Claude tools', 'claude-sonnet-4-6'],
      ['multi/strata/s1', 'Strata · Strata One', 'Strata · Claude tools', 'claude-haiku-4-5'],
      ['multi/strata/s2', 'Strata · Strata Two', 'Strata · Claude tools', 'claude-sonnet-4-6'],
    ],
  );
});

test('generic launcher discovery forwards context and validates discovered model identities', async () => {
  const prior = process.env.T045_CONTEXT_PROBE;
  process.env.T045_CONTEXT_PROBE = 'host-conflict';
  try {
    const received: unknown[] = [];
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const ctx = {
      cwd: 'fixture-cwd',
      env: { T045_CONTEXT_PROBE: 'caller-value' },
      explicit: true,
      log: () => {},
      signal,
    };
    const descriptor = {
      availability: async (value: ProviderDiscoveryContext) => {
        calls.push('availability');
        received.push(value);
        return { available: true };
      },
      discoverModels: async (value: ProviderDiscoveryContext) => {
        calls.push('discoverModels');
        received.push(value);
        return [model];
      },
    };
    const registry = { list: () => [{ id: 'strata' }], get: () => descriptor };
    assert.deepEqual(await discoverEnabledProviders(registry, undefined, {}, () => ctx), {
      strata: [model],
    });
    assert.deepEqual(received, [ctx, ctx]);
    assert.deepEqual(calls, ['availability', 'discoverModels']);
    assert.equal((received[0] as ProviderDiscoveryContext).env.T045_CONTEXT_PROBE, 'caller-value');
    assert.equal((received[0] as ProviderDiscoveryContext).cwd, 'fixture-cwd');
    assert.equal((received[0] as ProviderDiscoveryContext).explicit, true);
    assert.equal((received[0] as ProviderDiscoveryContext).signal, signal);
    const invalid = { ...model, identity: { ...model.identity, providerId: 'deepseek' } };
    const messages: string[] = [];
    const invalidContext = { ...ctx, log: (message: string) => messages.push(message) };
    for (const invalidModels of [[invalid], 'not-models']) {
      assert.deepEqual(
        await discoverEnabledProviders(
          {
            ...registry,
            get: () => ({ ...descriptor, discoverModels: async () => invalidModels as never }),
          },
          undefined,
          {},
          () => invalidContext,
        ),
        { strata: [] },
      );
    }
    assert.deepEqual(messages, [
      'Strata discovery failed: Invalid discovered models for provider strata: models[0].identity.providerId',
      'Strata discovery failed: Invalid discovered models for provider strata: models',
    ]);
    await assert.rejects(
      discoverEnabledProviders(
        { list: () => [{ id: 'strata' }], get: () => undefined },
        undefined,
        {},
        () => ctx,
      ),
      /Missing provider descriptor for registered provider: strata/,
    );
    await assert.rejects(
      discoverEnabledProviders(
        { list: () => [{ id: 'not-a-fact' }], get: () => descriptor },
        undefined,
        {},
        () => ctx,
      ),
      /Missing provider facts for registered provider: not-a-fact/,
    );
  } finally {
    if (prior === undefined) {
      delete process.env.T045_CONTEXT_PROBE;
    } else {
      process.env.T045_CONTEXT_PROBE = prior;
    }
  }
});

test('generic launcher discovery handles availability failures and silent non-explicit unavailable states', async () => {
  for (const explicit of [true, false]) {
    const messages: string[] = [];
    const registry = {
      list: () => [{ id: 'strata' }],
      get: () => ({
        availability: async () => {
          throw new Error('availability offline');
        },
        discoverModels: async () => [model],
      }),
    };
    const results = await discoverEnabledProviders(registry, undefined, {}, () =>
      context(explicit, (message) => messages.push(message)),
    );
    assert.deepEqual(results, { strata: [] });
    assert.deepEqual(messages, explicit ? ['Strata discovery failed: availability offline'] : []);
  }
  const messages: string[] = [];
  let discoveryCalls = 0;
  const unavailable = {
    list: () => [{ id: 'strata' }],
    get: () => ({
      availability: async () => ({ available: false }),
      discoverModels: async () => {
        discoveryCalls += 1;
        return [model];
      },
    }),
  };
  assert.deepEqual(
    await discoverEnabledProviders(unavailable, undefined, {}, () =>
      context(false, (message) => messages.push(message)),
    ),
    { strata: [] },
  );
  assert.equal(discoveryCalls, 0);
  assert.deepEqual(messages, []);
});

const invalidModels: ReadonlyArray<{ name: string; value: unknown; field: string }> = [
  {
    name: 'missing modelId',
    value: { ...model, identity: { providerId: 'strata' } },
    field: 'identity.modelId',
  },
  {
    name: 'numeric modelId',
    value: { ...model, identity: { ...model.identity, modelId: 42 } },
    field: 'identity.modelId',
  },
  {
    name: 'empty modelId',
    value: { ...model, identity: { ...model.identity, modelId: '' } },
    field: 'identity.modelId',
  },
  {
    name: 'unencodable modelId',
    value: { ...model, identity: { ...model.identity, modelId: '\ud800' } },
    field: 'identity.modelId',
  },
  {
    name: 'missing label',
    value: { identity: model.identity, capabilities: model.capabilities },
    field: 'label',
  },
  { name: 'numeric label', value: { ...model, label: 42 }, field: 'label' },
  { name: 'empty label', value: { ...model, label: '' }, field: 'label' },
  { name: 'null identity', value: { ...model, identity: null }, field: 'identity' },
  { name: 'array identity', value: { ...model, identity: [] }, field: 'identity' },
  {
    name: 'numeric preset',
    value: { ...model, identity: { ...model.identity, preset: 42 } },
    field: 'identity.preset',
  },
  {
    name: 'missing capabilities',
    value: { identity: model.identity, label: model.label },
    field: 'capabilities',
  },
  { name: 'null capabilities', value: { ...model, capabilities: null }, field: 'capabilities' },
  { name: 'array capabilities', value: { ...model, capabilities: [] }, field: 'capabilities' },
];

for (const { name, value, field } of invalidModels) {
  test(`generic model validation rejects ${name} with discovery error policy`, async () => {
    for (const explicit of [true, false]) {
      const messages: string[] = [];
      const registry = {
        list: () => [{ id: 'strata' }],
        get: () => ({
          availability: async () => ({ available: true }),
          discoverModels: async () => [model, value] as never,
        }),
      };
      assert.deepEqual(
        await discoverEnabledProviders(registry, undefined, {}, () =>
          context(explicit, (message) => messages.push(message)),
        ),
        { strata: [] },
      );
      assert.deepEqual(
        messages,
        explicit
          ? [
              `Strata discovery failed: Invalid discovered models for provider strata: models[1].${field}`,
            ]
          : [],
      );
    }
  });
}

test('generic model validation accepts nested model IDs and leaves dedicated discovery untouched', async () => {
  const nested = {
    ...model,
    identity: { ...model.identity, modelId: 'org/model@v1', preset: 'fast' },
  };
  const registry = {
    list: () => [{ id: 'strata' }],
    get: () => ({
      availability: async () => ({ available: true }),
      discoverModels: async () => [nested],
    }),
  };
  const messages: string[] = [];
  assert.deepEqual(
    await discoverEnabledProviders(registry, undefined, {}, () =>
      context(true, (message) => messages.push(message)),
    ),
    { strata: [nested] },
  );
  assert.deepEqual(messages, []);
  const dedicated = { list: () => [{ id: 'openai' }] };
  assert.deepEqual(
    await discoverEnabledProviders(
      dedicated,
      undefined,
      { openai: async () => 'dedicated result' },
      () => context(true),
    ),
    { openai: 'dedicated result' },
  );
});

test('generic launcher discovery suppresses non-explicit errors', async () => {
  const failure = genericDescriptor(true, [], new Error('catalog offline'));
  const registry = {
    list: () => [{ id: 'strata' }],
    get: () => failure,
  };
  const messages: string[] = [];
  const results = await discoverEnabledProviders(registry, undefined, {}, (_id) =>
    context(false, (message) => messages.push(message)),
  );
  assert.deepEqual(results, { strata: [] });
  assert.deepEqual(messages, []);
});

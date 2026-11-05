import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import { ProviderRuntime } from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import {
  createLaunchRegistry,
  discoverLaunchProviders,
  genericActiveProviders,
  launcherRuntime,
  pickerSettings,
} from '../../plugins/multi-core/src/launcher.ts';
import { discoverEnabledProviders } from '../../plugins/multi-core/src/provider-discovery.ts';

function context(
  explicit: boolean,
  log: (message: string) => void = () => {},
): ProviderDiscoveryContext {
  return { cwd: '.', env: {}, explicit, log };
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
  const receivedCredentials: Array<{ authFile?: string; zenKey?: string } | undefined> = [];
  const factory = (credentials?: { authFile?: string; zenKey?: string }) => {
    receivedCredentials.push(credentials);
    const registry = createBuiltinRegistry(credentials);
    if (!registry.get('strata')) {
      registry.register(strata);
    }
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
  assert.deepEqual(receivedCredentials, [
    undefined,
    { authFile: 'auth-file', zenKey: 'zen-secret' },
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

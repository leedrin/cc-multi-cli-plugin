import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDER_FACTS } from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import {
  type ModelDescriptor,
  type ProviderDescriptor,
  ProviderRegistry,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type { PreparedRequest } from '../../plugins/multi-core/src/gateway/provider-request.ts';

function preparedRequest(): PreparedRequest {
  return {
    label: 'test',
    authHelp: '',
    endpoint: 'test',
    route: 'test',
    inputTokens: () => 0,
    requestEvent: () => ({ route: 'test' }),
    failureEvent: () => ({ route: 'test' }),
    open: async () => ({
      ok: true,
      translate: async () => ({
        id: 'test',
        type: 'message',
        role: 'assistant',
        model: 'test',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    }),
  };
}

function descriptor(
  id: string,
  plugin: string,
  kind: 'direct' | 'harness' = 'direct',
): ProviderDescriptor {
  return {
    id,
    plugin,
    label: id,
    kind,
    autoReview: { review: 'none', statement: 'unreviewed' },
    unavailableMessage: `${id} unavailable`,
    availability: async () => ({ available: true }),
    discoverModels: async () => [],
    ...(kind === 'direct'
      ? { direct: { signaturePrefixes: [], prepare: () => preparedRequest() } }
      : {
          createHarness: async () => ({
            validate: () => 200,
            handle: async () => ({}) as never,
          }),
        }),
  } as ProviderDescriptor;
}

test('registry rejects duplicate, illegal, reserved IDs and mismatched adapters', () => {
  const registry = new ProviderRegistry();
  registry.register(descriptor('openai', 'openai'));
  assert.throws(() => registry.register(descriptor('openai', 'openai')), /duplicate/i);
  assert.throws(() => registry.register(descriptor('bad id', 'openai')), /invalid/i);
  assert.throws(() => registry.register(descriptor('core', 'openai')), /reserved/i);
  assert.throws(
    () => registry.register(descriptor('openai', 'openai', 'harness')),
    /adapter|kind|fact/i,
  );
  assert.throws(
    () => registry.register({ ...descriptor('openai', 'openai'), direct: undefined }),
    /adapter|kind/i,
  );
  assert.throws(
    () =>
      registry.register({ ...descriptor('cursor', 'cursor', 'harness'), createHarness: undefined }),
    /harness adapter/i,
  );
  assert.throws(
    () =>
      registry.register({
        ...descriptor('cursor', 'cursor', 'harness'),
        direct: { signaturePrefixes: [], prepare: () => preparedRequest() },
      }),
    /harness adapter/i,
  );
  assert.throws(
    () =>
      registry.register({
        ...descriptor('openai', 'openai'),
        createHarness: async () => ({ validate: () => 200, handle: async () => ({}) as never }),
      }),
    /direct adapter/i,
  );
});

test('registry checks provider facts against descriptor identity, plugin, and kind', () => {
  const registry = new ProviderRegistry();
  for (const fact of PROVIDER_FACTS) {
    registry.register(descriptor(fact.id, fact.plugin, fact.kind));
  }
  assert.deepEqual(
    registry.list().map(({ id, plugin, kind }) => ({ id, plugin, kind })),
    PROVIDER_FACTS.map(({ id, plugin, kind }) => ({ id, plugin, kind })),
  );
  assert.throws(() => new ProviderRegistry().register(descriptor('openai', 'zen')), /fact|plugin/i);
  assert.throws(
    () => new ProviderRegistry().register(descriptor('cursor', 'cursor', 'direct')),
    /fact|kind/i,
  );
});

const cursorModel = {
  identity: {
    providerId: 'cursor',
    modelId: 'composer-2',
    routeId: 'multi/cursor/composer-2',
    oneMillionContext: false,
  },
  label: 'Composer 2',
  protocol: 'native-harness',
  capabilities: { text: true },
} as const;

test('provider runtime resolves active models by their full identity and rejects unknown presets', async () => {
  let closed = 0;
  const harness = {
    validate: () => 200,
    handle: async () => ({}) as never,
    close: async () => {
      closed += 1;
    },
  };
  const provider = descriptor('cursor', 'cursor', 'harness');
  const runtime = new ProviderRuntime([{ descriptor: provider, models: [cursorModel], harness }]);
  assert.equal(runtime.active().length, 1);
  assert.equal(
    runtime.resolveModel('multi/cursor/composer-2')?.model.identity.modelId,
    'composer-2',
  );
  assert.equal(runtime.resolveModel('multi/cursor/composer-2/nonexistent-preset'), undefined);
  assert.equal(runtime.resolveModel('multi/cursor/composer-2/'), undefined);
  await runtime.close();
  await runtime.close();
  assert.equal(closed, 1);
});

test('registry exposes model listing and route resolution', () => {
  const registry = new ProviderRegistry();
  registry.register({
    ...descriptor('cursor', 'cursor', 'harness'),
    discoverModels: async () => [cursorModel],
  });
  registry.setModels('cursor', [cursorModel]);
  assert.deepEqual(registry.models(), [cursorModel]);
  assert.deepEqual(registry.resolve('cursor', 'composer-2'), {
    provider: registry.get('cursor'),
    model: cursorModel,
  });
  assert.deepEqual(registry.resolveRoute('multi/cursor/composer-2'), {
    provider: registry.get('cursor'),
    model: cursorModel,
  });
  assert.equal(registry.resolveRoute('multi/cursor/composer-2/unknown'), undefined);
});

function modelResolvers(models: readonly ModelDescriptor[]) {
  const provider = descriptor('cursor', 'cursor', 'harness');
  const registry = new ProviderRegistry();
  registry.register(provider);
  registry.setModels('cursor', models);
  const runtime = new ProviderRuntime([{ descriptor: provider, models }]);
  return {
    registry: () => registry.resolve('cursor', 'composer-2'),
    route: () => registry.resolveRoute('multi/cursor/composer-2'),
    runtime: () => runtime.resolveModel('multi/cursor/composer-2'),
  };
}

const presetModel: ModelDescriptor = {
  ...cursorModel,
  identity: { ...cursorModel.identity, preset: 'fast', routeId: 'multi/cursor/composer-2/fast' },
};
const foreignModel: ModelDescriptor = {
  ...cursorModel,
  identity: { ...cursorModel.identity, providerId: 'grok', routeId: 'multi/grok/composer-2' },
};

for (const entry of ['registry', 'route', 'runtime'] as const) {
  test(`${entry}: base lookup skips preset candidates and selects the base model`, () => {
    assert.equal(modelResolvers([presetModel, cursorModel])[entry]()?.model, cursorModel);
  });
  test(`${entry}: base lookup rejects a preset-only catalog`, () => {
    assert.equal(modelResolvers([presetModel])[entry](), undefined);
  });
  test(`${entry}: same modelId from another provider cannot shadow the target`, () => {
    assert.equal(modelResolvers([foreignModel, cursorModel])[entry]()?.model, cursorModel);
  });
  test(`${entry}: same modelId from another provider alone is not a match`, () => {
    assert.equal(modelResolvers([foreignModel])[entry](), undefined);
  });
  test(`${entry}: another modelId from the same provider is not a match`, () => {
    const otherModel = {
      ...cursorModel,
      identity: { ...cursorModel.identity, modelId: 'other', routeId: 'multi/cursor/other' },
    };
    assert.equal(modelResolvers([otherModel])[entry](), undefined);
  });
}

test('preset routes never fall back to the base model in registry or runtime', () => {
  const provider = descriptor('cursor', 'cursor', 'harness');
  const registry = new ProviderRegistry();
  registry.register(provider);
  registry.setModels('cursor', [cursorModel]);
  const runtime = new ProviderRuntime([{ descriptor: provider, models: [cursorModel] }]);
  for (const route of ['multi/cursor/composer-2/fast', 'multi/cursor/composer-2/']) {
    assert.equal(registry.resolveRoute(route), undefined);
    assert.equal(runtime.resolveModel(route), undefined);
  }
});

test('registerMany rejects valid-but-unknown facts and does not partially register duplicate batches', () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.register(descriptor('valid-but-unknown', 'valid-but-unknown')),
    /provider facts/i,
  );
  assert.throws(
    () => registry.registerMany([descriptor('zen', 'zen'), descriptor('zen', 'zen')]),
    /duplicate/i,
  );
  assert.equal(registry.get('zen'), undefined);
});

test('provider registry construction and complete fact validation take under 100 ms', () => {
  const descriptors = PROVIDER_FACTS.map((fact) => descriptor(fact.id, fact.plugin, fact.kind));
  const build = () => {
    const registry = new ProviderRegistry();
    registry.registerMany(descriptors);
    return registry;
  };
  build();
  const samples: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const start = performance.now();
    const registry = build();
    samples.push(performance.now() - start);
    assert.equal(registry.list().length, PROVIDER_FACTS.length);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  assert.ok(median < 100, `median registry build: ${median.toFixed(2)} ms`);
});

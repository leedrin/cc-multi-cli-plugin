import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import {
  type ProviderDescriptor,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type {
  ProviderUsageReader,
  ProviderUsageView,
} from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { launcherRuntime } from '../../plugins/multi-core/src/launcher.ts';

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

const usageReader: ProviderUsageReader = async (session) => ({
  summary: `${session} strata quota`,
  details: ['Strata account usage'],
});

function strataDescriptor(usage?: ProviderUsageReader): ProviderDescriptor {
  return {
    id: 'strata',
    plugin: 'pi',
    label: 'Strata',
    kind: 'direct',
    autoReview: { review: 'none', statement: 'No reviewer' },
    availability: async () => ({ available: true }),
    discoverModels: async () => [model],
    ...(usage ? { usage } : {}),
    direct: {
      prepare: () => {
        throw new Error('Usage test must not prepare model requests');
      },
      signaturePrefixes: [],
    },
    unavailableMessage: 'Strata unavailable',
  };
}

async function readUsage(runtime: ProviderRuntime, enabledProviders?: readonly string[]) {
  const server = createNativeGateway({
    token: 'generic-usage-token',
    runtime,
    enabledProviders,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=generic-owned&view=providers`,
      { headers: { 'x-multi-gateway-token': 'generic-usage-token' } },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as ProviderUsageView;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('production usage menu shows generic active rows and calls descriptor usage readers', async () => {
  const registry = createBuiltinRegistry();
  registry.register(strataDescriptor(usageReader));
  const runtime = launcherRuntime(
    'unused-auth-file',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    { strata: [model] },
    () => registry,
  );
  const view = await readUsage(runtime);
  const row = view.providers.find(({ id }) => id === 'strata');
  assert.deepEqual(row && [row.name, row.status, row.summary], [
    'Strata',
    'ready',
    'generic-owned strata quota',
  ]);
  assert(row?.details.includes('Strata account usage'));
});

test('production usage menu reports unavailable quota for generic active providers without a reader', async () => {
  const registry = createBuiltinRegistry();
  registry.register(strataDescriptor());
  const runtime = launcherRuntime(
    'unused-auth-file',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    { strata: [model] },
    () => registry,
  );
  const view = await readUsage(runtime);
  const row = view.providers.find(({ id }) => id === 'strata');
  assert.equal(row?.status, 'unavailable');
  assert.equal(
    row?.details[0],
    'Strata reports no account quota; per-run usage appears in session receipts.',
  );
  assert.equal(row?.url, undefined);
});

test('production usage menu applies generic provider activation, harness and enabled filters', async () => {
  const registry = createBuiltinRegistry();
  const strata = strataDescriptor(usageReader);
  registry.register(strata);
  const antigravity = registry.get('antigravity');
  assert(antigravity);
  const deepseek = registry.get('deepseek');
  assert(deepseek);
  const runtime = new ProviderRuntime(
    [
      { descriptor: strata, models: [model], usage: usageReader },
      { descriptor: antigravity, models: [] },
      { descriptor: deepseek, models: [] },
    ],
    { registry },
  );
  const view = await readUsage(runtime);
  assert.deepEqual(
    view.providers.map(({ id }) => id),
    ['openai', 'cursor', 'zen', 'deepseek', 'antigravity', 'grok', 'strata'],
  );
  assert.equal(view.providers.filter(({ id }) => id === 'deepseek').length, 1);
  assert(view.providers.some(({ id }) => id === 'strata'));
  assert.equal(view.providers.find(({ id }) => id === 'antigravity')?.status, 'disabled');

  const noGenericActive = await readUsage(new ProviderRuntime([], { registry }));
  assert(!noGenericActive.providers.some(({ id }) => id === 'strata'));
  assert.equal(noGenericActive.providers.filter(({ id }) => id === 'deepseek').length, 1);

  const filtered = await readUsage(runtime, ['strata']);
  assert.equal(filtered.providers.find(({ id }) => id === 'strata')?.status, 'ready');
  assert.equal(filtered.providers.find(({ id }) => id === 'deepseek')?.status, 'disabled');
  assert.equal(filtered.providers.find(({ id }) => id === 'antigravity')?.status, 'disabled');
});

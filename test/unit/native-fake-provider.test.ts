import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { ProviderDescriptor } from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type {
  ProviderUsageReader,
  ProviderUsageView,
} from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import {
  discoverLaunchProviders,
  launcherRuntime,
  pickerSettings,
  workerCatalog,
  workerDefinitions,
} from '../../plugins/multi-core/src/launcher.ts';

const models = [
  {
    identity: {
      providerId: 'strata',
      modelId: 'fixture-one',
      routeId: 'multi/strata/fixture-one',
      oneMillionContext: false,
    },
    label: 'Fixture One',
    description: 'First Strata fixture',
    protocol: 'custom' as const,
    capabilities: { text: true },
  },
  {
    identity: {
      providerId: 'strata',
      modelId: 'fixture-two',
      routeId: 'multi/strata/fixture-two',
      oneMillionContext: false,
    },
    label: 'Fixture Two',
    description: 'Second Strata fixture',
    protocol: 'custom' as const,
    capabilities: { text: true },
  },
];

const usageCalls: string[] = [];
const usageReader: ProviderUsageReader = async (session) => {
  usageCalls.push(session);
  return { summary: `Fixture quota for ${session}`, details: ['Fixture usage reader called'] };
};

const registry = createBuiltinRegistry();
registry.register({
  id: 'strata',
  plugin: 'pi',
  label: 'Strata',
  kind: 'direct',
  autoReview: { review: 'none', statement: 'No reviewer' },
  availability: async () => ({ available: true }),
  discoverModels: async () => models,
  usage: usageReader,
  direct: {
    prepare: () => {
      throw new Error('Fake provider test must not prepare model requests');
    },
    signaturePrefixes: [],
  },
  unavailableMessage: 'Strata unavailable',
} satisfies ProviderDescriptor);

const registryFactory = () => registry;

test('a generic Strata descriptor reaches picker, worker, runtime, and production usage menu', async () => {
  const discovery = await discoverLaunchProviders(registryFactory, ['strata']);
  assert.deepEqual(discovery.availableProviderIds, ['strata']);
  assert.deepEqual(discovery.genericModels.strata, models);

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
  assert.deepEqual(settings.modelPicker.options, [
    {
      model: 'multi/strata/fixture-one',
      label: 'Strata · Fixture One',
      description: 'First Strata fixture',
      behavesAs: 'claude-haiku-4-5',
    },
    {
      model: 'multi/strata/fixture-two',
      label: 'Strata · Fixture Two',
      description: 'Second Strata fixture',
      behavesAs: 'claude-haiku-4-5',
    },
  ]);

  const catalog = workerCatalog(settings.modelPicker.options);
  assert.equal(catalog['multi-strata']?.provider, 'strata');
  assert.deepEqual(catalog['multi-strata']?.models, [
    { id: 'fixture-one', model: 'multi/strata/fixture-one' },
    { id: 'fixture-two', model: 'multi/strata/fixture-two' },
  ]);
  const workers = workerDefinitions(catalog, registry);
  assert.deepEqual(workers['multi-strata']?.tools, [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    'Edit',
    'Write',
  ]);
  assert.equal(workers['multi-strata']?.model, 'multi/strata/fixture-one');
  assert.match(workers['multi-strata']?.description ?? '', /Strata worker \(Claude Code's tools\)/);

  const runtime = launcherRuntime(
    'unused-auth-file',
    undefined,
    {},
    { cursor: undefined, antigravity: undefined, grok: undefined },
    undefined,
    discovery.genericModels,
    registryFactory,
  );
  assert.deepEqual(
    runtime.active().map(({ descriptor, models: activeModels }) => [descriptor.id, activeModels]),
    [['strata', models]],
  );

  const server = createNativeGateway({ token: 'fake-provider-token', runtime });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=fake-provider-session&view=providers`,
      { headers: { 'x-multi-gateway-token': 'fake-provider-token' } },
    );
    assert.equal(response.status, 200);
    const view = (await response.json()) as ProviderUsageView;
    const row = view.providers.find(({ id }) => id === 'strata');
    assert.deepEqual(row && [row.id, row.name, row.status, row.summary], [
      'strata',
      'Strata',
      'ready',
      'Fixture quota for fake-provider-session',
    ]);
    assert(row?.details.includes('Fixture usage reader called'));
    assert.deepEqual(usageCalls, ['fake-provider-session']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return typescriptFiles(path);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return files.flat();
}

test('gateway core sources contain no provider-specific Strata branch', async () => {
  const sourceFiles = await typescriptFiles('plugins/multi-core/src');
  const filesToCheck = sourceFiles.filter(
    (file) => file !== join('plugins/multi-core/src/gateway', 'provider-facts.ts'),
  );
  const matches = await Promise.all(
    filesToCheck.map(async (file) => {
      const source = await readFile(file, 'utf8');
      return /strata/i.test(source) ? file : undefined;
    }),
  );
  const offendingFiles = matches.filter((file): file is string => file !== undefined);
  assert.deepEqual(
    offendingFiles,
    [],
    `Provider-specific Strata text found in core sources:\n${offendingFiles.join('\n')}`,
  );
});

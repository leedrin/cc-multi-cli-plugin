import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BUILTIN_PROVIDERS } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  type ProviderDescriptor,
  ProviderRegistry,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
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

const registry = new ProviderRegistry();
registry.registerMany(BUILTIN_PROVIDERS.filter(({ id }) => id !== 'strata'));
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

test('reviewer policy and reviewer instance are selected from a non-OpenAI descriptor', async (t) => {
  const fakeRegistry = new ProviderRegistry();
  const descriptor = registry.get('strata');
  assert.ok(descriptor?.direct);
  fakeRegistry.registerMany(BUILTIN_PROVIDERS.filter(({ id }) => id !== 'strata'));
  const isolated = {
    ...descriptor,
    autoReview: { review: 'reviewer' as const, statement: 'Fixture reviewer' },
  };
  fakeRegistry.register(isolated);
  let reviewerCalls = 0;
  const reviewer = async () => {
    reviewerCalls += 1;
    return { model: 'fixture-reviewer', outcome: 'deny' as const, reason: 'fixture denial' };
  };
  const response: MessagesResponse = {
    id: 'fixture-response',
    type: 'message',
    role: 'assistant',
    model: 'fixture-one',
    content: [{ type: 'tool_use', id: 'fixture-call', name: 'Bash', input: { command: 'true' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  isolated.direct = {
    ...descriptor.direct,
    prepare: () => ({
      label: 'Strata',
      authHelp: '',
      endpoint: 'fixture',
      route: 'strata',
      inputTokens: () => 1,
      requestEvent: () => ({ route: 'strata' }),
      failureEvent: () => ({ route: 'strata' }),
      open: async () => ({ ok: true, translate: async () => response }),
    }),
  };
  const server = createNativeGateway({
    token: 'fixture-review-token',
    runtime: new ProviderRuntime([{ descriptor: isolated, models, reviewer }], {
      registry: fakeRegistry,
    }),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const result = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': 'fixture-review-token',
    },
    body: JSON.stringify({
      model: 'multi/strata/fixture-one',
      messages: [{ role: 'user', content: 'review this' }],
      safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } }],
    }),
  });
  assert.equal(result.status, 200);
  const reply = (await result.json()) as MessagesResponse & {
    safeguard_results?: Array<{ status: { tool_uses: Record<string, { outcome: string }> } }>;
  };
  assert.equal(reviewerCalls, 1);
  assert.equal(reply.safeguard_results?.[0]?.status.tool_uses['fixture-call']?.outcome, 'flagged');
});

async function reviewScenario(
  t: import('node:test').TestContext,
  review: 'reviewer' | 'none',
  runtimeReviewer: boolean,
  activateOpenAIReviewer = false,
) {
  const fakeRegistry = new ProviderRegistry();
  const base = registry.get('strata');
  assert.ok(base?.direct);
  fakeRegistry.registerMany(BUILTIN_PROVIDERS.filter(({ id }) => id !== 'strata'));
  const descriptor = {
    ...base,
    autoReview: {
      review,
      statement: review === 'none' ? 'no auto mode: actions run unreviewed' : 'Fixture reviewer',
    },
  };
  fakeRegistry.register(descriptor);
  let reviewerCalls = 0;
  const reviewer = async () => {
    reviewerCalls += 1;
    return { model: 'fixture-reviewer', outcome: 'deny' as const, reason: 'fixture denial' };
  };
  let openAIReviewerCalls = 0;
  const openAIReviewer = async () => {
    openAIReviewerCalls += 1;
    return {
      model: 'openai-fixture-reviewer',
      outcome: 'deny' as const,
      reason: 'OpenAI fixture denial',
    };
  };
  const response: MessagesResponse = {
    id: 'fixture-response',
    type: 'message',
    role: 'assistant',
    model: 'fixture-one',
    content: [{ type: 'tool_use', id: 'fixture-call', name: 'Bash', input: { command: 'true' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  descriptor.direct = {
    ...base.direct,
    prepare: () => ({
      label: 'Strata',
      authHelp: '',
      endpoint: 'fixture',
      route: 'strata',
      inputTokens: () => 1,
      requestEvent: () => ({ route: 'strata' }),
      failureEvent: () => ({ route: 'strata' }),
      open: async () => ({ ok: true, translate: async () => response }),
    }),
  };
  const openAIDescriptor = fakeRegistry.get('openai');
  assert.ok(openAIDescriptor);
  const runtimeProviders = [
    { descriptor, models, ...(runtimeReviewer ? { reviewer } : {}) },
    ...(activateOpenAIReviewer
      ? [{ descriptor: openAIDescriptor, models: [], reviewer: openAIReviewer }]
      : []),
  ];
  const server = createNativeGateway({
    token: 'fixture-review-token',
    runtime: new ProviderRuntime(runtimeProviders, { registry: fakeRegistry }),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const result = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': 'fixture-review-token',
    },
    body: JSON.stringify({
      model: 'multi/strata/fixture-one',
      messages: [{ role: 'user', content: 'review this' }],
      safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } }],
    }),
  });
  assert.equal(result.status, 200);
  const reply = (await result.json()) as MessagesResponse & {
    safeguard_results?: Array<{ status: { tool_uses: Record<string, { outcome: string }> } }>;
  };
  const statementResponse = await fetch(`http://127.0.0.1:${address.port}/multi/mod/telemetry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-multi-gateway-token': 'fixture-review-token',
    },
    body: JSON.stringify({ sessionId: 'fixture-session', model: 'multi/strata/fixture-one' }),
  });
  const statement = (await statementResponse.json()) as { reviewStatement?: string };
  return { reviewerCalls, openAIReviewerCalls, reply, statement: statement.reviewStatement };
}

test('descriptor review none does not call an available runtime reviewer', async (t) => {
  const { reviewerCalls, reply } = await reviewScenario(t, 'none', true);
  assert.equal(reviewerCalls, 0);
  assert.equal(
    reply.safeguard_results?.[0]?.status.tool_uses['fixture-call']?.outcome,
    'not_flagged',
  );
});

test('reviewer descriptor without runtime reviewer reports unreviewed and does not borrow OpenAI', async (t) => {
  const { reviewerCalls, openAIReviewerCalls, reply, statement } = await reviewScenario(
    t,
    'reviewer',
    false,
    true,
  );
  assert.equal(reviewerCalls, 0);
  assert.equal(openAIReviewerCalls, 0);
  assert.equal(
    reply.safeguard_results?.[0]?.status.tool_uses['fixture-call']?.outcome,
    'not_flagged',
  );
  assert.equal(statement, 'no auto mode: actions run unreviewed');
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
  const providerIntegrationFiles = new Set([
    join('plugins/multi-core/src/gateway', 'provider-facts.ts'),
    join('plugins/multi-core/src/gateway', 'builtin-providers.ts'),
    join('plugins/multi-core/src/gateway', 'provider-usage.ts'),
    join('plugins/multi-core/src', 'launcher.ts'),
  ]);
  const filesToCheck = sourceFiles.filter((file) => !providerIntegrationFiles.has(file));
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

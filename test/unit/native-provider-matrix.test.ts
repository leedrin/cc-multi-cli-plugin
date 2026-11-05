import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import test from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { PermissionModes } from '../../plugins/multi-core/src/gateway/mode-hook.ts';
import { ProviderUsageDashboard } from '../../plugins/multi-core/src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../plugins/multi-core/src/gateway/receipts.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { buildWorkerCatalog } from '../../plugins/multi-core/src/gateway/worker-catalog.ts';
import { removeTemporary } from '../temporary.ts';
import { createNativeGateway } from './support/runtime.ts';

// Characterization of the five-provider matrix as it stands before the usage patchset. It
// pins routing, worker types and completion-event usage so a usage change that alters provider
// or worker behaviour shows up here. It is not a specification of how usage should look.

type Provider = 'openai' | 'zen' | 'cursor' | 'antigravity' | 'grok';
const PROVIDERS: readonly Provider[] = ['openai', 'zen', 'cursor', 'antigravity', 'grok'];
const SESSION = 'matrix-session';

interface MatrixRow {
  provider: Provider;
  model: string;
  endpoint?: string;
  /** What the provider's completion event reports, before any accounting block. */
  usage: Record<string, number>;
  source: 'provider' | 'unavailable';
}

const MATRIX: readonly MatrixRow[] = [
  {
    provider: 'openai',
    model: 'multi/openai/gpt-6-astra',
    usage: {
      input_tokens: 60,
      cache_read_input_tokens: 40,
      output_tokens: 15,
    },
    source: 'provider',
  },
  {
    provider: 'zen',
    model: 'multi/zen/gpt-5.6-luna',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    source: 'provider',
  },
  {
    provider: 'cursor',
    model: 'multi/cursor/auto',
    endpoint: '@cursor/sdk',
    usage: { input_tokens: 3, output_tokens: 2 },
    source: 'unavailable',
  },
  {
    provider: 'antigravity',
    model: 'multi/antigravity/gemini-test-low',
    endpoint: 'agy',
    usage: { input_tokens: 3, output_tokens: 2 },
    source: 'unavailable',
  },
  {
    provider: 'grok',
    model: 'multi/grok/grok-4.6',
    endpoint: 'grok',
    usage: { input_tokens: 3, output_tokens: 2 },
    source: 'unavailable',
  },
];

const openaiSse = [
  { type: 'response.created', response: { id: 'resp_matrix' } },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_matrix',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 15,
      },
    },
  },
]
  .map((event) => `data: ${JSON.stringify(event)}\n\n`)
  .join('');

const zenSse = `data: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'zen_matrix',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'zen' }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})}\n\n`;

const harnessReply = (model: string): MessagesResponse => ({
  id: `msg_${model}`,
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: 'native' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
});

/** The same stream with the terminal event's usage removed, as a provider that omits telemetry sends it. */
const withoutUsage = (sse: string) =>
  sse
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const event = JSON.parse(frame.slice('data: '.length)) as {
        response?: { usage?: unknown };
      };
      delete event.response?.usage;
      return `data: ${JSON.stringify(event)}\n\n`;
    })
    .join('');

async function startMatrix(
  t: TestContext,
  options: { enabled?: readonly string[]; noUsage?: boolean } = {},
) {
  const hits: Record<string, number> = { anthropic: 0 };
  for (const provider of PROVIDERS) {
    hits[provider] = 0;
  }
  const completions: GatewayEvent[] = [];
  const modes = new PermissionModes(async () => ({}));
  modes.recordModSession(SESSION, { permissionMode: 'auto', cwd: process.cwd() });
  const fetchImpl: GatewayFetch = async (url) => {
    if (url.includes('api.anthropic.com')) {
      hits.anthropic++;
      return Response.json({ content: [{ type: 'text', text: 'claude' }] });
    }
    if (url.includes('opencode.ai')) {
      hits.zen++;
      return new Response(options.noUsage ? withoutUsage(zenSse) : zenSse);
    }
    hits.openai++;
    return new Response(options.noUsage ? withoutUsage(openaiSse) : openaiSse);
  };
  const harness = (provider: Provider, model: string) => ({
    validate: () => 4,
    handle: async () => {
      hits[provider]++;
      return harnessReply(model);
    },
  });
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'native-provider-matrix-'));
  const authFile = path.join(cwd, 'auth.json');
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'openai-secret', account_id: 'account-test' },
    }),
  );
  const receipts = new ReceiptLedger();
  const server = createNativeGateway({
    token: 'matrix-secret',
    authFile,
    fetchImpl,
    permissionModes: modes,
    receipts,
    zen: { apiKey: 'zen-matrix-fixture' },
    ...(options.enabled ? { enabledProviders: options.enabled } : {}),
    onEvent: (event) => {
      if (event.usage) {
        completions.push(event);
      }
    },
    cursor: harness('cursor', 'multi/cursor/auto'),
    antigravity: harness('antigravity', 'multi/antigravity/gemini-test-low'),
    grok: harness('grok', 'multi/grok/grok-4.6'),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTemporary(cwd);
  });
  const address = server.address();
  assert(address !== null && typeof address === 'object', 'Gateway port');
  const call = (payload: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'matrix-secret',
        'x-claude-code-session-id': SESSION,
      },
      body: JSON.stringify(payload),
    });
  return { call, hits, completions, receipts };
}

const ask = (model: string) => ({
  model,
  messages: [{ role: 'user', content: 'hi' }],
});

test('provider matrix: every multi/<provider>/<model> reaches its own handler exactly once', async (t) => {
  const { call, hits, completions } = await startMatrix(t);
  for (const row of MATRIX) {
    const before = { ...hits };
    const beforeCompletions = completions.length;
    const response = await call(ask(row.model));
    assert.equal(response.status, 200, row.provider);
    await response.text();
    for (const name of Object.keys(hits)) {
      const expected = name === row.provider ? 1 : 0;
      assert.equal(hits[name] - before[name], expected, `${row.provider} request touched ${name}`);
    }
    const added = completions.slice(beforeCompletions);
    assert.equal(added.length, 1, `${row.provider} produced one completion event`);
    assert.equal(added[0].route, row.provider);
    if (row.endpoint) {
      assert.equal(added[0].endpoint, row.endpoint);
    }
  }
});

test('provider matrix: completion events keep each provider usage and source as today', async (t) => {
  const { call, completions } = await startMatrix(t);
  for (const row of MATRIX) {
    await (await call(ask(row.model))).text();
  }
  assert.deepEqual(
    completions.map((event) => event.route),
    MATRIX.map((row) => row.provider),
  );
  for (const [index, row] of MATRIX.entries()) {
    const event = completions[index];
    assert.deepEqual(event.usage, row.usage, `${row.provider} usage`);
    assert.equal(event.usageMetadata?.source, row.source, `${row.provider} source`);
    assert.equal(event.stopReason, 'end_turn', row.provider);
  }
});

test('provider matrix: OpenAI without usage answers once as unavailable; Zen still refuses it', async (t) => {
  const { call, hits, completions } = await startMatrix(t, { noUsage: true });
  const answered = await call(ask('multi/openai/gpt-6-astra'));
  assert.equal(answered.status, 200);
  assert.match(await answered.text(), /Done/);
  assert.equal(hits.openai, 1, 'a paid request is never repeated');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].usageMetadata?.source, 'unavailable');
  assert.equal(completions[0].usageMetadata?.accounting, undefined);
  const refused = await call(ask('multi/zen/gpt-5.6-luna'));
  assert.match(await refused.text(), /Provider completed without token usage/);
});

test('provider matrix: the ledger holds one request per provider for the session', async (t) => {
  const { call, receipts } = await startMatrix(t);
  for (const row of MATRIX) {
    await (await call(ask(row.model))).text();
  }
  const snapshot = receipts.snapshot(SESSION);
  assert.equal(snapshot.requests, MATRIX.length);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.provider, entry.requests]),
    MATRIX.map((row) => [row.provider, 1]),
  );
});

test('provider matrix: a disabled or unknown provider model fails before any provider call', async (t) => {
  const { call, hits } = await startMatrix(t, { enabled: ['openai'] });
  const refused = await call(ask('multi/cursor/auto'));
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /provider plugin is not enabled/);
  const unknown = await call(ask('multi/nonexistent/model'));
  assert.equal(unknown.status, 400);
  await unknown.text();
  assert.deepEqual(
    Object.entries(hits).filter(([, count]) => count > 0),
    [],
  );
});

test('provider matrix: picker rows resolve to one worker type per provider', () => {
  const catalog = buildWorkerCatalog(MATRIX.map((row) => ({ model: row.model })));
  assert.deepEqual(Object.keys(catalog).sort(), PROVIDERS.map((name) => `multi-${name}`).sort());
  for (const row of MATRIX) {
    const worker = catalog[`multi-${row.provider}`];
    assert.equal(worker.provider, row.provider);
    assert.deepEqual(
      worker.models.map((entry) => entry.model),
      [row.model],
    );
    assert.equal(worker.defaultId, row.model.split('/')[2]);
  }
});

test('provider matrix: the usage dashboard lists all six providers in a stable order', async () => {
  const dashboard = new ProviderUsageDashboard({
    enabled: ['openai', 'cursor', 'zen', 'deepseek'],
    openai: async () => ({ summary: 'openai quota', details: [] }),
  });
  const view = await dashboard.read('s', new ReceiptLedger().snapshot());
  assert.deepEqual(
    view.providers.map((row) => [row.id, row.name, row.status]),
    [
      ['openai', 'OpenAI / Codex', 'ready'],
      ['cursor', 'Cursor', 'unavailable'],
      ['zen', 'OpenCode Zen', 'unavailable'],
      ['deepseek', 'DeepSeek', 'unavailable'],
      ['antigravity', 'Antigravity', 'disabled'],
      ['grok', 'Grok Build', 'disabled'],
    ],
  );
  assert.equal(view.providers[0].summary, 'openai quota');
  const deepseek = view.providers.find(({ id }) => id === 'deepseek');
  assert(deepseek);
  assert.deepEqual(
    [deepseek.status, deepseek.url, deepseek.details],
    [
      'unavailable',
      'https://platform.deepseek.com/usage',
      [
        'DeepSeek exposes no account quota here; session tokens appear in receipts.',
        'Check the DeepSeek platform console for balance and charges.',
        'This session: 0 completed requests',
      ],
    ],
  );
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { removeTemporary } from '../temporary.ts';

const providers = [
  {
    label: 'OpenAI Responses',
    model: 'multi/openai/gpt-6-astra',
    url: 'https://chatgpt.com/backend-api/codex/responses',
    chat: false,
  },
  {
    label: 'Zen Responses',
    model: 'multi/zen/gpt-5.6-luna',
    url: 'https://opencode.ai/zen/v1/responses',
    chat: false,
  },
  {
    label: 'Zen Chat',
    model: 'multi/zen/kimi-k3',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    chat: true,
  },
];

const usage = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
  output_tokens: 12,
};
const expectedUsage = {
  input_tokens: 50,
  output_tokens: 12,
  cache_read_input_tokens: 40,
  cache_creation_input_tokens: 10,
};

function completion(chat: boolean): Response {
  const item = { type: 'message', content: [{ type: 'output_text', text: 'Done' }] };
  const events = chat
    ? [
        {
          id: 'chat_fixture',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'Do' } }],
        },
        { id: 'chat_fixture', choices: [{ index: 0, delta: { content: 'ne' } }] },
        {
          id: 'chat_fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 12,
            prompt_tokens_details: { cached_tokens: 40, cache_creation_input_tokens: 10 },
          },
        },
      ]
    : [
        { type: 'response.created', response: { id: 'resp_fixture', usage: null } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, delta: 'Do' },
        { type: 'response.output_text.delta', output_index: 0, delta: 'ne' },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { id: 'resp_fixture', status: 'completed', output: [item], usage },
        },
      ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

async function gateway(t: TestContext, fetchImpl: GatewayFetch) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'native-direct-open-'));
  t.after(() => removeTemporary(directory));
  const authFile = path.join(directory, 'auth.json');
  // Synthetic login only; all provider HTTP calls go to the injected fetch below.
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture-token', account_id: 'fixture-account' },
    }),
  );
  const server = createNativeGateway({
    token: 'local-fixture-token',
    authFile,
    zen: { apiKey: 'fixture-zen-key' },
    blockAnthropic: true,
    fetchImpl,
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
  return (model: string, stream: boolean) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-multi-gateway-token': 'local-fixture-token',
      },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
}

interface Event {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { output_tokens: number };
}

for (const provider of providers) {
  test(`${provider.label} open translates the complete SSE stream with exactly one terminal`, async (t) => {
    let calls = 0;
    const post = await gateway(t, async (url, init) => {
      calls++;
      assert.equal(url, provider.url);
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(String(init.body)).stream, true);
      return completion(provider.chat);
    });
    const response = await post(provider.model, true);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    // Read through EOF: stopping at the first message_stop would miss duplicates.
    const wire = await response.text();
    const events: Event[] = wire
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.filter((event) => event.type === 'message_stop').length, 1);
    assert.equal(events.filter((event) => event.type === 'message_start').length, 1);
    const terminals = events.filter((event) => event.type === 'message_delta');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.delta?.stop_reason, 'end_turn');
    assert.equal(terminals[0]?.usage?.output_tokens, 12);
    assert.equal(events.at(-1)?.type, 'message_stop');
    assert.equal(
      events
        .filter(
          (event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta',
        )
        .map((event) => event.delta?.text ?? '')
        .join(''),
      'Done',
    );
    assert.equal(calls, 1);
  });

  test(`${provider.label} open translates SSE to a non-streaming JSON reply`, async (t) => {
    let calls = 0;
    const post = await gateway(t, async (url) => {
      calls++;
      assert.equal(url, provider.url);
      return completion(provider.chat);
    });
    const response = await post(provider.model, false);
    assert.equal(response.status, 200);
    const reply = (await response.json()) as MessagesResponse;
    assert.equal(reply.model, provider.model);
    assert.deepEqual(reply.content, [{ type: 'text', text: 'Done' }]);
    assert.equal(reply.stop_reason, 'end_turn');
    assert.deepEqual(reply.usage, expectedUsage);
    assert.equal(calls, 1);
  });

  test(`${provider.label} open preserves upstream 429 status and retry-after`, async (t) => {
    let calls = 0;
    const post = await gateway(t, async (url) => {
      calls++;
      assert.equal(url, provider.url);
      return new Response('private-upstream-error', {
        status: 429,
        headers: { 'retry-after': '7' },
      });
    });
    const response = await post(provider.model, true);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '7');
    const wire = await response.text();
    assert.match(wire, /(?:OpenAI|Zen) returned HTTP 429/);
    assert.doesNotMatch(wire, /private-upstream-error|message_stop/);
    assert.equal(calls, 1);
  });
}

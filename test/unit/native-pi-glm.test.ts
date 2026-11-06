import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProviderRequestInput } from '../../plugins/multi-core/src/gateway/provider-request.ts';
import { preparePiRequest } from '../../plugins/multi-pi/src/gateway-request.ts';
import { decodePiSignature } from '../../plugins/multi-pi/src/signature.ts';
import { nativePiGlmPlainSse, nativePiGlmSse } from './fixtures/native-pi-glm-events.ts';

const providers = [
  { id: 'zai', key: 'fake-zai-key', origin: 'https://api.z.ai' },
  { id: 'zai-coding-cn', key: 'fake-cn-key', origin: 'https://open.bigmodel.cn' },
] as const;

function request(providerId: (typeof providers)[number]['id'], model: string, overrides = {}) {
  const route = `multi/${providerId}/${model}`;
  return {
    method: 'POST',
    pathname: '/v1/messages',
    body: {
      model: route,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 321,
      ...overrides,
    },
    session: 'session',
    fallbackSession: 'fallback',
  } as ProviderRequestInput;
}

function assertStreamEvents(response: Awaited<ReturnType<typeof send>>, hasNotice: boolean): void {
  const thinkingBlock = response.result.content.find((item) => item.type === 'thinking');
  assert.equal(thinkingBlock?.type, 'thinking');
  if (thinkingBlock?.type !== 'thinking') {
    throw new Error('expected translated thinking');
  }
  assert.deepEqual(
    response.output
      .filter((_, index) => !(hasNotice && index > 0 && index < 4))
      .map(({ type, value }) => {
        const event = value as {
          index?: number;
          content_block?: { type?: string };
          delta?: {
            type?: string;
            thinking?: string;
            text?: string;
            signature?: string;
            partial_json?: string;
          };
        };
        return {
          type,
          index: event.index === undefined ? undefined : event.index - (hasNotice ? 1 : 0),
          blockType: event.content_block?.type,
          deltaType: event.delta?.type,
          deltaValue:
            event.delta?.thinking ??
            event.delta?.text ??
            event.delta?.signature ??
            event.delta?.partial_json,
        };
      }),
    [
      {
        type: 'message_start',
        index: undefined,
        blockType: undefined,
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_start',
        index: 0,
        blockType: 'thinking',
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_delta',
        index: 0,
        blockType: undefined,
        deltaType: 'thinking_delta',
        deltaValue: 'considering',
      },
      {
        type: 'content_block_delta',
        index: 0,
        blockType: undefined,
        deltaType: 'signature_delta',
        deltaValue: thinkingBlock.signature,
      },
      {
        type: 'content_block_stop',
        index: 0,
        blockType: undefined,
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_start',
        index: 1,
        blockType: 'text',
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_delta',
        index: 1,
        blockType: undefined,
        deltaType: 'text_delta',
        deltaValue: 'answer',
      },
      {
        type: 'content_block_stop',
        index: 1,
        blockType: undefined,
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_start',
        index: 2,
        blockType: 'tool_use',
        deltaType: undefined,
        deltaValue: undefined,
      },
      {
        type: 'content_block_delta',
        index: 2,
        blockType: undefined,
        deltaType: 'input_json_delta',
        deltaValue: '{"q":"x"}',
      },
      {
        type: 'content_block_stop',
        index: 2,
        blockType: undefined,
        deltaType: undefined,
        deltaValue: undefined,
      },
    ],
  );
  assert.equal(
    response.output.some(({ type }) => type === 'message_stop' || type === 'message_delta'),
    false,
  );
}

function assertEffortNotice(
  provider: (typeof providers)[number],
  model: string,
  effort: string,
  wireEffort: string,
  content: Awaited<ReturnType<typeof send>>['result']['content'],
): void {
  const notice = content.find(
    (item) => item.type === 'text' && item.text.includes('does not support effort'),
  );
  if (wireEffort !== effort) {
    assert.equal(
      notice?.type === 'text' ? notice.text : undefined,
      `[${provider.id === 'zai' ? 'Z.AI' : 'Z.AI Coding (CN)'}] GLM ${model} does not support effort ${effort}; using ${wireEffort}.`,
    );
    return;
  }
  assert.equal(notice, undefined);
}

async function send(provider: (typeof providers)[number], model: string, overrides = {}) {
  let target = '';
  let sent: Record<string, unknown> = {};
  const prepared = preparePiRequest(request(provider.id, model, overrides), provider.key, {
    providerId: provider.id,
  });
  const opened = await prepared.open(new AbortController().signal, async (url, init) => {
    target = String(url);
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(Object.hasOwn(overrides, 'tools') ? nativePiGlmSse : nativePiGlmPlainSse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    throw new Error('expected Pi stream to open');
  }
  const output: Array<{ type: string; value: unknown }> = [];
  const result = await opened.translate(
    (type, value) => output.push({ type, value }),
    () => {},
  );
  return { target, sent, result, output };
}

for (const provider of providers) {
  test(`${provider.id} builds GLM wire request and translates offline stream`, async () => {
    const choices =
      provider.id === 'zai'
        ? [
            ['glm-5.3', 'low', 'low'],
            ['glm-5.3', 'medium', 'high'],
            ['glm-5.3', 'high', 'high'],
            ['glm-5.3', 'xhigh', 'max'],
            ['glm-5.3', 'max', 'max'],
            ['glm-5.2', 'low', 'high'],
            ['glm-5.2', 'high', 'high'],
            ['glm-5.2', 'max', 'max'],
          ]
        : [
            ['glm-5.3', 'low', 'low'],
            ['glm-5.3', 'high', 'high'],
            ['glm-5.3', 'max', 'max'],
          ];
    for (const [model, effort, wireEffort] of choices) {
      const response = await send(provider, model, {
        system: 'GLM-system-instruction',
        tools: [{ name: 'lookup', description: 'lookup', input_schema: { type: 'object' } }],
        output_config: { effort },
      });
      assert.equal(new URL(response.target).origin, provider.origin);
      assert.equal(response.sent.tool_stream, true);
      assert.deepEqual(response.sent.thinking, { type: 'enabled', clear_thinking: false });
      assert.equal(response.sent.reasoning_effort, wireEffort);
      assertEffortNotice(provider, model, effort, wireEffort, response.result.content);
      const notice = response.result.content.find(
        (item) => item.type === 'text' && item.text.includes('does not support effort'),
      );
      assert.equal(response.sent.max_tokens, 321);
      assert.equal('max_completion_tokens' in response.sent, false);
      assert.equal('store' in response.sent, false);
      const plain = await send(provider, model);
      assert.equal('tool_stream' in plain.sent, false);
      assert.deepEqual(
        plain.result.content.map(({ type, ...block }) => ({ type, ...block })),
        [
          {
            type: 'thinking',
            thinking: 'considering',
            signature: plain.result.content.find((item) => item.type === 'thinking')?.signature,
          },
          { type: 'text', text: 'answer' },
        ],
      );
      assert.equal(plain.result.stop_reason, 'end_turn');
      assert.equal(plain.result.stop_sequence, null);
      const sentMessages = response.sent.messages as Array<{ role: string; content?: unknown }>;
      assert.equal(
        sentMessages.some(({ role }) => role === 'developer'),
        false,
      );
      assert.deepEqual(
        sentMessages.find(({ role }) => role === 'system'),
        { role: 'system', content: 'GLM-system-instruction' },
      );
      assert.deepEqual(
        response.result.content.map(({ type, ...block }) => ({ type, ...block })),
        [
          ...(wireEffort !== effort
            ? [{ type: 'text' as const, text: notice?.type === 'text' ? notice.text : '' }]
            : []),
          {
            type: 'thinking',
            thinking: 'considering',
            signature: response.result.content.find((item) => item.type === 'thinking')?.signature,
          },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } },
        ],
      );
      assert.match(
        response.result.content.find((item) => item.type === 'thinking')?.signature ?? '',
        /^multipi:/,
      );
      assert.equal(response.result.stop_reason, 'tool_use');
      assertStreamEvents(response, wireEffort !== effort);
      assert.deepEqual(response.result.usage, {
        input_tokens: 16,
        output_tokens: 7,
        cache_read_input_tokens: 4,
      });
      const thinking = response.result.content.find((item) => item.type === 'thinking');
      assert.equal(thinking?.type, 'thinking');
      if (thinking?.type === 'thinking') {
        assert.deepEqual(decodePiSignature(thinking.signature, `multi/${provider.id}/${model}`), {
          kind: 'owned',
          payload: { thinking: 'considering', thinkingSignature: 'reasoning_content' },
        });
      }
    }
    const disabled = await send(provider, 'glm-5.3', { thinking: { type: 'disabled' } });
    assert.deepEqual(disabled.sent.thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in disabled.sent, false);
  });

  test(`${provider.id} rejects invalid GLM effort before opening the gateway`, () => {
    assert.throws(
      () =>
        preparePiRequest(
          request(provider.id, 'glm-5.3', { output_config: { effort: 'minimal' } }),
          provider.key,
          { providerId: provider.id },
        ),
      /Unknown effort: minimal/,
    );
  });

  test(`${provider.id} rejects an undeclared tool call from the GLM stream`, async () => {
    const prepared = preparePiRequest(request(provider.id, 'glm-5.3'), provider.key, {
      providerId: provider.id,
    });
    const opened = await prepared.open(
      new AbortController().signal,
      async () => new Response(nativePiGlmSse, { status: 200 }),
    );
    assert.equal(opened.ok, true);
    if (!opened.ok) {
      throw new Error('expected Pi stream to open');
    }
    const output: Array<{ type: string; value: unknown }> = [];
    await assert.rejects(
      opened.translate(undefined, (type, value) => output.push({ type, value })),
      /stream failed/,
    );
    assert.equal(
      output.filter(
        ({ type, value }) =>
          type === 'content_block_start' &&
          (value as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
      ).length,
      0,
      'undeclared GLM tools must not emit tool_use blocks',
    );
  });

  test(`${provider.id} reasoning signature cannot replay across GLM routes`, async () => {
    const first = await send(provider, 'glm-5.3', {
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    });
    const thought = first.result.content.find((item) => item.type === 'thinking');
    assert.equal(thought?.type, 'thinking');
    if (thought?.type !== 'thinking') {
      throw new Error('expected translated thinking');
    }
    const otherProvider = provider.id === 'zai' ? providers[1] : providers[0];
    assert(otherProvider);
    assert.deepEqual(decodePiSignature(thought.signature, `multi/${otherProvider.id}/glm-5.3`), {
      kind: 'foreign',
    });
    const second = preparePiRequest(
      request(provider.id, 'glm-5.3', {
        messages: [
          {
            role: 'assistant',
            content: [thought, ...first.result.content.filter((item) => item.type !== 'thinking')],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
          },
        ],
        tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
      }),
      provider.key,
      { providerId: provider.id },
    );
    let replayBody: Record<string, unknown> = {};
    const opened = await second.open(new AbortController().signal, async (_url, init) => {
      replayBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(nativePiGlmSse, { status: 200 });
    });
    assert.equal(opened.ok, true);
    const assistant = (replayBody.messages as Array<Record<string, unknown>>).find(
      (item) => item.role === 'assistant',
    );
    assert(assistant);
    assert.equal(assistant.reasoning_content, 'considering');
    assert.equal(assistant.content, 'answer');
    assert.deepEqual(assistant.tool_calls, [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"x"}' },
      },
    ]);
  });
}

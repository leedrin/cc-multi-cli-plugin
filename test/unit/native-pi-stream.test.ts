import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';
import { toolName } from '../../plugins/multi-core/src/gateway/tools.ts';
import { decodePiSignature, encodePiSignature } from '../../plugins/multi-pi/src/signature.ts';
import { translatePiStream } from '../../plugins/multi-pi/src/stream.ts';
import { interleavedPiEvents, nativePiStreamEvents } from './fixtures/native-pi-stream-events.ts';

const route = 'multi/deepseek/deepseek-flash';
const message = () => ({
  role: 'assistant' as const,
  content: [],
  api: 'openai-completions' as const,
  provider: 'deepseek' as const,
  model: 'deepseek-flash',
  usage: {
    input: 3,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 7,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop' as const,
  timestamp: 1,
});
const event = (value: Record<string, unknown>) => value as unknown as AssistantMessageEvent;
const collect = async (
  events: AssistantMessageEvent[],
  toolNames: string[] = ['Agent', 'search'],
  overrides: { rememberWorkerModel?: (id: string, type: string, model: string) => void } = {},
) => {
  const output: Array<{ type: string; value: unknown }> = [];
  const first = events[0];
  assert.ok(first);
  const result = await translatePiStream(
    {
      first,
      stream: {
        async *[Symbol.asyncIterator]() {
          yield* events.slice(1);
        },
      },
    },
    {
      routeId: route,
      label: 'DeepSeek',
      model: route,
      request: { tools: toolNames.map((name) => ({ name })) },
      ...overrides,
    },
    (type, value) => output.push({ type, value }),
  );
  return { output, result };
};

test(`fixture records the real interleaved event order: ${nativePiStreamEvents.join(' → ')}`, async () => {
  const base = message();
  const signature = 'reasoning_content';
  const result = await collect(interleavedPiEvents(base, signature));
  assert.deepEqual(
    result.output.map(({ type }) => type),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
    ],
  );
  const observed = result.output.map(({ type, value }) => {
    if (type !== 'message_start') {
      return { type, value };
    }
    const started = (
      value as {
        message: {
          model: string;
          role: string;
          content: unknown[];
          stop_reason: unknown;
          stop_sequence: unknown;
          usage: unknown;
        };
      }
    ).message;
    return {
      type,
      value: {
        message: {
          model: started.model,
          role: started.role,
          content: started.content,
          stop_reason: started.stop_reason,
          stop_sequence: started.stop_sequence,
          usage: started.usage,
        },
      },
    };
  });
  const signatureFor = (thinking: string) =>
    encodePiSignature(route, { thinking, thinkingSignature: signature });
  assert.deepEqual(observed, [
    {
      type: 'message_start',
      value: {
        message: {
          model: route,
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    },
    {
      type: 'content_block_start',
      value: { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    },
    {
      type: 'content_block_delta',
      value: { index: 0, delta: { type: 'thinking_delta', thinking: 'why' } },
    },
    {
      type: 'content_block_delta',
      value: { index: 0, delta: { type: 'thinking_delta', thinking: ' because' } },
    },
    {
      type: 'content_block_delta',
      value: {
        index: 0,
        delta: { type: 'signature_delta', signature: signatureFor('why because') },
      },
    },
    { type: 'content_block_stop', value: { index: 0 } },
    { type: 'content_block_start', value: { index: 1, content_block: { type: 'text', text: '' } } },
    { type: 'content_block_delta', value: { index: 1, delta: { type: 'text_delta', text: 'a' } } },
    { type: 'content_block_delta', value: { index: 1, delta: { type: 'text_delta', text: 'n' } } },
    { type: 'content_block_stop', value: { index: 1 } },
    {
      type: 'content_block_start',
      value: { index: 2, content_block: { type: 'thinking', thinking: '', signature: '' } },
    },
    {
      type: 'content_block_delta',
      value: { index: 2, delta: { type: 'thinking_delta', thinking: ' again' } },
    },
    {
      type: 'content_block_delta',
      value: { index: 2, delta: { type: 'signature_delta', signature: signatureFor(' again') } },
    },
    { type: 'content_block_stop', value: { index: 2 } },
    { type: 'content_block_start', value: { index: 3, content_block: { type: 'text', text: '' } } },
    {
      type: 'content_block_delta',
      value: { index: 3, delta: { type: 'text_delta', text: 'swer' } },
    },
    { type: 'content_block_stop', value: { index: 3 } },
  ]);
  assert.deepEqual(result.result.content, [
    { type: 'thinking', thinking: 'why because', signature: signatureFor('why because') },
    { type: 'text', text: 'an' },
    { type: 'thinking', thinking: ' again', signature: signatureFor(' again') },
    { type: 'text', text: 'swer' },
  ]);
  const signatureEvent = result.output.find(
    ({ type, value }) =>
      type === 'content_block_delta' &&
      (value as { delta?: { type?: string } }).delta?.type === 'signature_delta',
  );
  assert.ok(signatureEvent);
  const sig = (signatureEvent.value as { delta: { signature: string } }).delta.signature;
  assert.deepEqual(decodePiSignature(sig, route), {
    kind: 'owned',
    payload: { thinking: 'why because', thinkingSignature: signature },
  });
  assert.equal(result.result.stop_reason, 'end_turn');
});

test('Pi stream snapshots signature fields and rejects queued terminal rewrites', async () => {
  const base = message();
  const mutable = {
    ...base,
    content: [{ type: 'thinking', thinking: 'why', thinkingSignature: 'reasoning_content' }],
  };
  const queued = [
    event({ type: 'start', partial: mutable }),
    event({ type: 'thinking_delta', contentIndex: 0, delta: 'why', partial: mutable }),
    event({ type: 'thinking_end', contentIndex: 0, content: 'why', partial: mutable }),
    event({ type: 'done', reason: 'stop', message: mutable }),
  ];
  (mutable.content[0] as { thinkingSignature?: string }).thinkingSignature =
    '{"reasoning_details":"changed"}';
  await assert.rejects(
    collect(queued),
    (error: Error) => error.message === 'DeepSeek stream failed.',
  );
});

test('Pi stream buffers complete tools, restores aliases, normalizes worker models, and maps stops', async () => {
  const base = message();
  const longName = 'tool-name-'.repeat(9);
  const alias = toolName(longName);
  assert.ok(longName.length > 64);
  const output: Array<{ type: string; value: unknown }> = [];
  const tools = [
    {
      name: 'Agent',
      args: { subagent_type: 'multi-deepseek', model: 'deepseek-reasoner', prompt: 'work' },
    },
    { name: alias, args: { query: 'complete query', limit: 3 } },
  ];
  const sequence = [event({ type: 'start', partial: base })];
  for (const [index, tool] of tools.entries()) {
    sequence.push(
      event({
        type: 'toolcall_start',
        contentIndex: index,
        partial: base,
        toolCall: { id: `id-${index}`, name: tool.name },
      }),
      event({ type: 'toolcall_delta', contentIndex: index, partial: base, delta: '{"partial":' }),
      event({
        type: 'toolcall_end',
        contentIndex: index,
        partial: base,
        toolCall: { type: 'toolCall', id: `id-${index}`, name: tool.name, arguments: tool.args },
      }),
    );
  }
  sequence.push(
    event({
      type: 'done',
      reason: 'length',
      message: { ...base, stopReason: 'length', content: [] },
    }),
  );
  const remembered: unknown[][] = [];
  const first = sequence[0];
  assert.ok(first);
  const stream = {
    async *[Symbol.asyncIterator]() {
      let completedTools = 0;
      for (const item of sequence.slice(1)) {
        yield item;
        if (item.type === 'toolcall_start' || item.type === 'toolcall_delta') {
          assert.equal(
            output.filter(
              ({ type, value }) =>
                type === 'content_block_start' &&
                (value as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
            ).length,
            completedTools,
          );
        }
        if (item.type === 'toolcall_end') {
          completedTools += 1;
          assert.equal(
            output.filter(
              ({ type, value }) =>
                type === 'content_block_start' &&
                (value as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
            ).length,
            completedTools,
          );
        }
      }
    },
  };
  const result = await translatePiStream(
    { first, stream },
    {
      routeId: route,
      label: 'DeepSeek',
      model: route,
      request: { tools: [{ name: 'Agent' }, { name: longName }] },
      rememberWorkerModel: (...args) => remembered.push(args),
    },
    (type, value) => output.push({ type, value }),
  );
  const starts = output.filter(
    ({ type, value }) =>
      type === 'content_block_start' &&
      (value as { content_block?: { type?: string } }).content_block?.type === 'tool_use',
  );
  assert.deepEqual(
    starts.map(
      ({ value }) =>
        (value as { index: number; content_block: { name: string; input: unknown } }).index,
    ),
    [0, 1],
  );
  assert.deepEqual(
    starts.map(({ value }) => (value as { content_block: { name: string } }).content_block.name),
    ['Agent', longName],
  );
  const deltas = output.filter(
    ({ type, value }) =>
      type === 'content_block_delta' &&
      (value as { delta?: { type?: string } }).delta?.type === 'input_json_delta',
  );
  assert.deepEqual(
    deltas.map(({ value }) =>
      JSON.parse((value as { delta: { partial_json: string } }).delta.partial_json),
    ),
    [
      { subagent_type: 'multi-deepseek', prompt: 'work' },
      { query: 'complete query', limit: 3 },
    ],
  );
  assert.deepEqual(result.content, [
    {
      type: 'tool_use',
      id: 'id-0',
      name: 'Agent',
      input: { subagent_type: 'multi-deepseek', prompt: 'work' },
    },
    { type: 'tool_use', id: 'id-1', name: longName, input: { query: 'complete query', limit: 3 } },
  ]);
  assert.deepEqual(remembered, [['id-0', 'multi-deepseek', 'deepseek-reasoner']]);
  assert.equal(result.stop_reason, 'max_tokens');
  await assert.rejects(
    collect([
      event({ type: 'start', partial: base }),
      event({
        type: 'toolcall_end',
        contentIndex: 0,
        partial: base,
        toolCall: { type: 'toolCall', id: 'bad', name: 'unknown_alias', arguments: {} },
      }),
    ]),
    (error: Error) => error.message === 'DeepSeek stream failed.',
  );
});

test('Pi stream isolates interleaved tools and emits each complete call only at its end', async () => {
  const base = message();
  const longName = 'interleaved-tool-'.repeat(6);
  const calls: ToolCall[] = [
    {
      type: 'toolCall' as const,
      id: 'worker-A',
      name: 'Agent',
      arguments: { subagent_type: 'multi-deepseek', model: 'deepseek-reasoner', prompt: 'only A' },
    },
    {
      type: 'toolCall' as const,
      id: 'search-B',
      name: toolName(longName),
      arguments: { query: 'only B', limit: 7 },
    },
  ];
  const partial = { ...base, content: calls };
  const output: unknown[] = [];
  const remembered: unknown[][] = [];
  const expectedB = [
    {
      type: 'content_block_start',
      value: {
        index: 0,
        content_block: { type: 'tool_use', id: 'search-B', name: longName, input: {} },
      },
    },
    {
      type: 'content_block_delta',
      value: {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(calls[1]?.arguments) },
      },
    },
    { type: 'content_block_stop', value: { index: 0 } },
  ];
  const expectedA = [
    {
      type: 'content_block_start',
      value: {
        index: 1,
        content_block: { type: 'tool_use', id: 'worker-A', name: 'Agent', input: {} },
      },
    },
    {
      type: 'content_block_delta',
      value: {
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({ subagent_type: 'multi-deepseek', prompt: 'only A' }),
        },
      },
    },
    { type: 'content_block_stop', value: { index: 1 } },
  ];
  const result = await translatePiStream(
    {
      first: { type: 'start', partial },
      stream: {
        async *[Symbol.asyncIterator]() {
          for (const contentIndex of [0, 1]) {
            yield event({ type: 'toolcall_start', contentIndex, partial });
            assert.equal(output.length, 1);
          }
          for (const [contentIndex, delta] of [
            [0, '{"subagent_type":"multi-deepseek","model":"deepseek-reasoner","prompt":"only'],
            [1, '{"query":"only'],
            [0, ' A"}'],
            [1, ' B","limit":7}'],
          ] as const) {
            yield event({ type: 'toolcall_delta', contentIndex, delta, partial });
            assert.equal(output.length, 1);
          }
          yield event({ type: 'toolcall_end', contentIndex: 1, toolCall: calls[1], partial });
          assert.deepEqual(output.slice(1), expectedB);
          yield event({ type: 'toolcall_end', contentIndex: 0, toolCall: calls[0], partial });
          assert.deepEqual(output.slice(1), [...expectedB, ...expectedA]);
          yield event({
            type: 'done',
            reason: 'toolUse',
            message: { ...partial, stopReason: 'toolUse' },
          });
        },
      },
    },
    {
      routeId: route,
      label: 'DeepSeek',
      model: route,
      request: { tools: [{ name: 'Agent' }, { name: longName }] },
      rememberWorkerModel: (...args) => remembered.push(args),
    },
    (type, value) => output.push({ type, value }),
  );
  assert.deepEqual(output.slice(1), [...expectedB, ...expectedA]);
  assert.deepEqual(result.content, [
    { type: 'tool_use', id: 'search-B', name: longName, input: { query: 'only B', limit: 7 } },
    {
      type: 'tool_use',
      id: 'worker-A',
      name: 'Agent',
      input: { subagent_type: 'multi-deepseek', prompt: 'only A' },
    },
  ]);
  assert.deepEqual(remembered, [['worker-A', 'multi-deepseek', 'deepseek-reasoner']]);
  assert.equal(result.stop_reason, 'tool_use');
  const ordinary = { subagent_type: 'Explore', model: 'haiku', prompt: 'ordinary' };
  const control = await collect(
    [
      event({ type: 'start', partial: base }),
      event({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'ordinary', name: 'Agent', arguments: ordinary },
        partial: base,
      }),
      event({ type: 'done', reason: 'toolUse', message: base }),
    ],
    ['Agent'],
    { rememberWorkerModel: (...args) => remembered.push(args) },
  );
  assert.deepEqual(control.result.content, [
    { type: 'tool_use', id: 'ordinary', name: 'Agent', input: ordinary },
  ]);
  assert.deepEqual(control.output[2], {
    type: 'content_block_delta',
    value: {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(ordinary) },
    },
  });
  assert.deepEqual(remembered, [['worker-A', 'multi-deepseek', 'deepseek-reasoner']]);
});

test('Pi stream rejects invalid arguments and errors without leaking upstream text', async () => {
  const base = message();
  const argumentEvents = [
    event({ type: 'start', partial: base }),
    event({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: {
        type: 'toolCall',
        id: 'id',
        name: 'search',
        arguments: {},
        argumentsError: 'SECRET_ARGUMENTS',
      },
      partial: base,
    }),
  ];
  const output: Array<{ type: string; value: unknown }> = [];
  const first = argumentEvents[0];
  const second = argumentEvents[1];
  assert.ok(first);
  assert.ok(second);
  const failure = await translatePiStream(
    {
      first,
      stream: {
        async *[Symbol.asyncIterator]() {
          yield second;
        },
      },
    },
    { routeId: route, label: 'DeepSeek', model: route, request: { tools: [{ name: 'search' }] } },
    (type, value) => output.push({ type, value }),
  ).catch((caught: unknown) => caught);
  assert.ok(failure instanceof Error);
  assert.equal(failure.message, 'DeepSeek returned a tool call with invalid arguments.');
  assert.equal(
    output.some(
      ({ type, value }) =>
        type === 'content_block_start' && JSON.stringify(value).includes('tool_use'),
    ),
    false,
  );
  assert.equal(
    JSON.stringify({ error: failure.message, output }).includes('SECRET_ARGUMENTS'),
    false,
  );
  await assert.rejects(
    collect([
      event({ type: 'start', partial: base }),
      event({ type: 'error', reason: 'error', error: { ...base, errorMessage: 'SECRET_BODY' } }),
    ]),
    (error: Error) => error.message === 'DeepSeek stream failed.',
  );
  await assert.rejects(
    translatePiStream(
      {
        first: event({ type: 'start', partial: base }),
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error('DeepSeek SECRET_BODY SECRET_KEY');
              },
            };
          },
        },
      },
      { routeId: route, label: 'DeepSeek', model: route, request: { tools: [] } },
      () => {},
    ),
    (error: Error) => error.message === 'DeepSeek stream failed.',
  );
});

test('Pi stream covers every documented stop mapping and rejects non-success stops', async () => {
  const base = message();
  for (const [reason, stop] of [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['toolUse', 'tool_use'],
  ] as const) {
    const { result } = await collect([
      event({ type: 'start', partial: base }),
      event({ type: 'done', reason, message: { ...base, stopReason: reason } }),
    ]);
    assert.equal(result.stop_reason, stop);
  }
  for (const reason of ['pending', 'deferred', 'error', 'aborted', 'unrecognized']) {
    await assert.rejects(
      collect([
        event({ type: 'start', partial: base }),
        event({ type: 'done', reason, message: { ...base, stopReason: reason } }),
      ]),
      /stream failed/,
    );
  }
});

for (const entry of ['delta', 'text_end', 'done'] as const) {
  test(`Pi stream rejects text signatures only at ${entry}`, async () => {
    const base = message();
    const plain = { ...base, content: [{ type: 'text' as const, text: 'x' }] };
    const signed = {
      ...base,
      content: [{ type: 'text' as const, text: 'x', textSignature: 'TEXT_SIG_CANARY' }],
    };
    const output: unknown[] = [];
    const failure = await translatePiStream(
      {
        first: { type: 'start', partial: base },
        stream: {
          async *[Symbol.asyncIterator]() {
            yield event({
              type: 'text_delta',
              contentIndex: 0,
              delta: 'x',
              partial: entry === 'delta' ? signed : plain,
            });
            yield event({
              type: 'text_end',
              contentIndex: 0,
              content: 'x',
              partial: entry === 'text_end' ? signed : plain,
            });
            yield event({
              type: 'done',
              reason: 'stop',
              message: entry === 'done' ? signed : plain,
            });
          },
        },
      },
      { routeId: route, label: 'DeepSeek', model: route, request: {} },
      (type, value) => output.push({ type, value }),
    ).catch((caught: unknown) => caught);
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, 'DeepSeek stream failed.');
    assert.deepEqual(Object.getOwnPropertyNames(failure).sort(), ['message', 'stack']);
    assert.equal(
      JSON.stringify({ error: failure.message, stack: failure.stack, output }).includes(
        'TEXT_SIG_CANARY',
      ),
      false,
    );
  });
}

test('Pi stream rejects tool signatures instead of dropping them', async () => {
  const base = message();
  await assert.rejects(
    collect([
      event({ type: 'start', partial: base }),
      event({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'id',
          name: 'search',
          arguments: {},
          thoughtSignature: 'TOOL_SIG',
        },
        partial: base,
      }),
    ]),
    (error: Error) => error.message === 'DeepSeek stream failed.',
  );
});

test('Pi stream rejects unsupported terminal reasons and changed thinking signatures', async () => {
  const base = message();
  await assert.rejects(
    collect([
      event({ type: 'start', partial: base }),
      event({ type: 'done', reason: 'deferred', message: { ...base, stopReason: 'deferred' } }),
    ]),
    /stream failed/,
  );
  await assert.rejects(
    collect([
      event({ type: 'start', partial: base }),
      event({ type: 'thinking_delta', contentIndex: 0, delta: 'x', partial: base }),
      event({
        type: 'thinking_end',
        contentIndex: 0,
        content: 'x',
        partial: {
          ...base,
          content: [{ type: 'thinking', thinking: 'x', thinkingSignature: 'different' }],
        },
      }),
    ]),
    /stream failed/,
  );
  for (const [firstSignature, nextSignature] of [
    ['reasoning_content', undefined],
    [undefined, 'reasoning_content'],
  ] as const) {
    const first = {
      ...base,
      content: [
        {
          type: 'thinking' as const,
          thinking: 'x',
          ...(firstSignature === undefined ? {} : { thinkingSignature: firstSignature }),
        },
      ],
    };
    const second = {
      ...base,
      content: [
        {
          type: 'thinking' as const,
          thinking: 'x',
          ...(nextSignature === undefined ? {} : { thinkingSignature: nextSignature }),
        },
      ],
    };
    await assert.rejects(
      collect([
        event({ type: 'start', partial: base }),
        event({ type: 'thinking_delta', contentIndex: 0, delta: 'x', partial: first }),
        event({ type: 'thinking_delta', contentIndex: 0, delta: 'y', partial: second }),
        event({ type: 'thinking_end', contentIndex: 0, content: 'xy', partial: second }),
        event({ type: 'done', reason: 'stop', message: second }),
      ]),
      (error: Error) => error.message === 'DeepSeek stream failed.',
    );
  }
  const encoded = encodePiSignature(route, { thinking: 'x' });
  assert.equal(decodePiSignature(encoded, route).kind, 'owned');
});

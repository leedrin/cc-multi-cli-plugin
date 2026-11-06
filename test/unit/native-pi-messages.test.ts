import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { MessagesRequest } from '../../plugins/multi-core/src/gateway/messages.ts';
import { toolName } from '../../plugins/multi-core/src/gateway/tools.ts';
import { PI_DEEPSEEK_MODELS, PI_MODELS_BY_PROVIDER } from '../../plugins/multi-pi/src/catalog.ts';
import { toPiContext } from '../../plugins/multi-pi/src/messages.ts';
import { encodePiSignature } from '../../plugins/multi-pi/src/signature.ts';
import { translatePiStream } from '../../plugins/multi-pi/src/stream.ts';

const route = 'multi/deepseek/deepseek-flash';
const model = PI_DEEPSEEK_MODELS[1];

test('Pi provider history rejects a thinking signature from the similarly named other route', () => {
  const glmModel = PI_MODELS_BY_PROVIDER.zai[0];
  const foreignRoute = 'multi/zai-coding-cn/glm-5.3';
  const signature = encodePiSignature(foreignRoute, { thinking: 'private reasoning' });
  const translated = toPiContext(
    {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'private reasoning', signature }],
        },
      ],
      max_tokens: 1,
    },
    glmModel,
    'multi/zai/glm-5.3',
    'zai',
  );
  assert.deepEqual(translated.context.messages, []);
  assert.equal(JSON.stringify(translated.context).includes('private reasoning'), false);
});

for (const maxTokens of [-1, 0, 1.5]) {
  test(`Pi translation rejects independent max_tokens boundary ${maxTokens}`, () => {
    assert.throws(() => toPiContext({ messages: [], max_tokens: maxTokens }, model, route), {
      message: 'Invalid max_tokens',
    });
  });
}

for (const [name, payload] of [
  ['redacted plaintext', { thinking: 'visible', redacted: true }],
  ['different content', { thinking: 'signed secret', redacted: false }],
] as const) {
  test(`Pi translation rejects owned thinking signature with ${name}`, () => {
    const signature = encodePiSignature(route, payload);
    assert.throws(
      () =>
        toPiContext(
          {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'thinking', thinking: 'visible', signature }],
              },
            ],
            max_tokens: 1,
          },
          model,
          route,
        ),
      { message: 'Invalid Pi thinking signature' },
    );
  });
}

test('Pi assistant history uses the selected provider rather than DeepSeek', () => {
  const translated = toPiContext(
    {
      messages: [
        { role: 'assistant', content: 'earlier' },
        { role: 'user', content: 'next' },
      ],
    },
    PI_MODELS_BY_PROVIDER.zai[0],
    'multi/zai/glm-5.3',
    'zai',
  );
  const assistant = translated.context.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant?.role, 'assistant');
  if (assistant?.role === 'assistant') {
    assert.equal(assistant.provider, 'zai');
  }
});

test('Pi thinking keeps different redacted metadata separate', () => {
  const content = [
    { type: 'thinking', thinking: 'A', signature: encodePiSignature(route, { thinking: 'A' }) },
    {
      type: 'thinking',
      thinking: 'B',
      signature: encodePiSignature(route, { thinking: 'B', redacted: false }),
    },
  ];
  const result = toPiContext(
    { messages: [{ role: 'assistant', content }], max_tokens: 1 },
    model,
    route,
  ).context.messages[0];
  assert.equal(result?.role, 'assistant');
  if (result?.role !== 'assistant') {
    throw new Error('expected assistant');
  }
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'A' },
    { type: 'thinking', thinking: 'B', redacted: false },
  ]);
});

test('Pi messages translate text, system prompt, cache, tools, and tool history deterministically', () => {
  const request = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'mcp:long tool', input: { ok: true } }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'result follows' },
          { type: 'tool_result', tool_use_id: 'call-1', content: 'done' },
          { type: 'text', text: 'continued' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ],
    tools: [{ name: 'mcp:long tool', description: 'tool', input_schema: { type: 'object' } }],
    max_tokens: 32,
    tool_choice: { type: 'tool', name: 'mcp:long tool' },
  };
  const first = toPiContext(request, model, route);
  assert.deepEqual(toPiContext(request, model, route), first);
  assert.equal(JSON.stringify(first), JSON.stringify(toPiContext(request, model, route)));
  assert.equal(first.context.systemPrompt, 'system');
  assert.equal(first.context.messages[1]?.role, 'toolResult');
  assert.equal(first.context.messages[2]?.role, 'user');
  assert.match(first.context.tools?.[0]?.name ?? '', /^multi_tool_[a-f0-9]{48}$/);
  assert.equal(first.options.maxTokens, 32);
  assert.deepEqual(first.options.toolChoice, {
    type: 'function',
    function: { name: first.context.tools?.[0]?.name },
  });
});

test('Pi translation restores only own-route signed reasoning and combines neighbors', () => {
  const own = encodePiSignature(route, { thinking: 'A', thinkingSignature: 'reasoning_content' });
  const own2 = encodePiSignature(route, { thinking: 'B', thinkingSignature: 'reasoning_content' });
  const foreign = encodePiSignature('other-route', { thinking: 'discard' });
  const context = toPiContext(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'A', signature: own },
            { type: 'thinking', thinking: 'B', signature: own2 },
            { type: 'thinking', thinking: 'foreign', signature: foreign },
          ],
        },
      ],
      max_tokens: 1,
    },
    model,
    route,
  ).context;
  assert.equal(context.messages[0]?.role, 'assistant');
  if (context.messages[0]?.role !== 'assistant') {
    throw new Error('expected assistant');
  }
  assert.deepEqual(context.messages[0].content, [
    { type: 'thinking', thinking: 'AB', thinkingSignature: 'reasoning_content' },
  ]);
});

test('Pi translation validates images, documents, stops, token limits, and named tool choice', () => {
  assert.throws(
    () =>
      toPiContext(
        {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
                },
              ],
            },
          ],
          max_tokens: 1,
        },
        PI_DEEPSEEK_MODELS[0],
        route,
      ),
    /image/i,
  );
  assert.throws(
    () =>
      toPiContext(
        { messages: [{ role: 'user', content: [{ type: 'document' }] }], max_tokens: 1 },
        model,
        route,
      ),
    /document/i,
  );
  assert.throws(
    () => toPiContext({ messages: [], stop_sequences: ['stop'], max_tokens: 1 }, model, route),
    /stop/i,
  );
  assert.throws(
    () => toPiContext({ messages: [], max_tokens: model.maxTokens + 1 }, model, route),
    /max_tokens/i,
  );
  assert.throws(
    () =>
      toPiContext(
        { messages: [], tools: [], tool_choice: { type: 'tool', name: 'missing' }, max_tokens: 1 },
        model,
        route,
      ),
    /tool/i,
  );
  assert.throws(() => toPiContext({ messages: [], max_tokens: 0 }, model, route), /max_tokens/i);
});

test('Pi translation rejects historical tool calls without a declared name', () => {
  for (const tools of [undefined, [{ name: 'known', input_schema: { type: 'object' } }]]) {
    assert.throws(
      () =>
        toPiContext(
          {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call-x', name: 'unknown', input: {} }],
              },
            ],
            ...(tools === undefined ? {} : { tools }),
            max_tokens: 1,
          },
          model,
          route,
        ),
      /tool/i,
    );
  }
});

test('Pi translation keeps supported images and maps all tool choices and token defaults', () => {
  const request = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
      },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
  };
  const translated = toPiContext(request, model, route);
  assert.deepEqual(translated.options, { maxTokens: 32000 });
  assert.deepEqual(translated.context.messages[0], {
    role: 'user',
    content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
    timestamp: 0,
  });
  assert.equal(
    toPiContext({ ...request, tool_choice: { type: 'auto' } }, model, route).options.toolChoice,
    'auto',
  );
  assert.equal(
    toPiContext({ ...request, tool_choice: { type: 'none' } }, model, route).options.toolChoice,
    'none',
  );
  assert.equal(
    toPiContext({ ...request, tool_choice: { type: 'any' } }, model, route).options.toolChoice,
    'required',
  );
  assert.throws(
    () => toPiContext({ messages: [], tools: [], max_tokens: 1.5 }, model, route),
    /max_tokens/i,
  );
  assert.deepEqual(toPiContext({ messages: [], tools: [] }, PI_DEEPSEEK_MODELS[0], route).options, {
    maxTokens: 32000,
  });
  assert.deepEqual(
    toPiContext({ messages: [], tools: [] }, { ...PI_DEEPSEEK_MODELS[0], maxTokens: 100 }, route)
      .options,
    { maxTokens: 100 },
  );
});

test('Pi translation separates tool aliases and call IDs and preserves tool result details', () => {
  const longName = `mcp__server__${'a'.repeat(80)}`;
  const otherName = 'finish';
  const request = {
    tools: [
      { name: longName, input_schema: { type: 'object' } },
      { name: otherName, input_schema: { type: 'object' } },
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: otherName, name: longName, input: { index: 1 } },
          { type: 'tool_use', id: 'call-2', name: otherName, input: { index: 2 } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: otherName,
            is_error: true,
            content: [
              { type: 'text', text: 'failed' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
              { type: 'text', text: 'details' },
              { type: 'tool_reference', tool_name: longName },
            ],
          },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'ok' },
        ],
      },
    ],
    tool_choice: { type: 'tool', name: longName },
    max_tokens: 1,
  };
  const translated = toPiContext(request, model, route);
  const alias = translated.context.tools?.[0]?.name;
  assert.match(alias ?? '', /^multi_tool_[a-f0-9]{48}$/);
  assert.equal(translated.context.tools?.[1]?.name, 'finish');
  const calls = translated.context.messages[0];
  assert.equal(calls?.role, 'assistant');
  if (calls?.role !== 'assistant') {
    throw new Error('expected assistant calls');
  }
  assert.deepEqual(calls.content, [
    { type: 'toolCall', id: 'finish', name: alias, arguments: { index: 1 } },
    { type: 'toolCall', id: 'call-2', name: 'finish', arguments: { index: 2 } },
  ]);
  const failed = translated.context.messages[1];
  const success = translated.context.messages[2];
  assert.equal(failed?.role, 'toolResult');
  if (failed?.role !== 'toolResult') {
    throw new Error('expected tool result');
  }
  assert.deepEqual(failed, {
    role: 'toolResult',
    toolCallId: 'finish',
    toolName: alias,
    content: [
      { type: 'text', text: 'failed' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      { type: 'text', text: 'details' },
      { type: 'text', text: `Available tool: ${alias}` },
    ],
    isError: true,
    timestamp: 0,
  });
  assert.equal(success?.role, 'toolResult');
  if (success?.role !== 'toolResult') {
    throw new Error('expected second result');
  }
  assert.equal(success.toolCallId, 'call-2');
  assert.equal(success.toolName, 'finish');
  assert.equal(success.isError, false);
  assert.deepEqual(success.content, [{ type: 'text', text: 'ok' }]);
  assert.deepEqual(translated.options.toolChoice, { type: 'function', function: { name: alias } });
});

test('Pi tool aliases remain distinct from reserved-prefix tool names and round-trip', async () => {
  const longName = `mcp__server__${'a'.repeat(80)}`;
  const reservedName = toolName(longName);
  const declared = [longName, reservedName];
  const request = {
    messages: [],
    tools: declared.map((name) => ({ name, input_schema: { type: 'object' } })),
  };
  const translated = toPiContext(request, model, route);
  const wireNames = translated.context.tools?.map(({ name }) => name) ?? [];
  assert.equal(wireNames.length, 2);
  assert.notEqual(wireNames[0], wireNames[1]);

  const base = {
    role: 'assistant' as const,
    content: [],
    api: 'openai-completions' as const,
    provider: 'deepseek' as const,
    model: 'deepseek-flash',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 0,
  };
  const events = [
    { type: 'start', partial: base },
    ...wireNames.map((name, index) => ({
      type: 'toolcall_end',
      contentIndex: index,
      partial: base,
      toolCall: { type: 'toolCall', id: `call-${index}`, name, arguments: { index } },
    })),
    { type: 'done', reason: 'toolUse', message: { ...base, content: [] } },
  ] as unknown as AssistantMessageEvent[];
  const first = events[0];
  assert.ok(first);
  const response = await translatePiStream(
    {
      first,
      stream: {
        async *[Symbol.asyncIterator]() {
          yield* events.slice(1);
        },
      },
    },
    { routeId: route, label: 'DeepSeek', model: route, request },
    () => {},
  );
  const responseTools = response.content.filter((block) => block.type === 'tool_use');
  assert.deepEqual(responseTools, [
    { type: 'tool_use', id: 'call-0', name: longName, input: { index: 0 } },
    { type: 'tool_use', id: 'call-1', name: reservedName, input: { index: 1 } },
  ]);
  const replay = toPiContext(
    {
      ...request,
      messages: [
        {
          role: 'assistant',
          content: responseTools.map(({ id, name, input }) => ({
            type: 'tool_use',
            id,
            name,
            input,
          })),
        },
        {
          role: 'user',
          content: responseTools.map(({ id, name }) => ({
            type: 'tool_result',
            tool_use_id: id,
            content: `result for ${name}`,
          })),
        },
      ],
    },
    model,
    route,
  );
  const replayedAssistant = replay.context.messages[0];
  const replayedResults = replay.context.messages.filter(
    (message) => message.role === 'toolResult',
  );
  assert.equal(replayedAssistant?.role, 'assistant');
  if (replayedAssistant?.role !== 'assistant') {
    throw new Error('expected replayed assistant tool calls');
  }
  assert.deepEqual(
    replayedAssistant.content,
    wireNames.map((name, index) => ({
      type: 'toolCall',
      id: `call-${index}`,
      name,
      arguments: { index },
    })),
  );
  assert.deepEqual(
    replayedResults.map((message) => message.role === 'toolResult' && message.toolName),
    wireNames,
  );
});

test('Pi deferred tool declarations are loaded only by references, selection, or use', () => {
  const deferred = {
    name: 'deferred_search',
    defer_loading: true,
    input_schema: { type: 'object' },
  };
  const always = { name: 'always_search', input_schema: { type: 'object' } };
  const names = (request: MessagesRequest) =>
    toPiContext(request, model, route).context.tools?.map(({ name }) => name) ?? [];
  assert.deepEqual(names({ messages: [], tools: [always, deferred] }), ['always_search']);
  assert.deepEqual(
    names({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'old', name: 'deferred_search', input: {} }],
        },
      ],
      tools: [always, deferred],
    }),
    ['always_search', 'deferred_search'],
  );
  assert.deepEqual(
    names({
      messages: [],
      tools: [always, deferred],
      tool_choice: { type: 'tool', name: 'deferred_search' },
    }),
    ['always_search', 'deferred_search'],
  );
  assert.deepEqual(
    names({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'old', name: 'always_search', input: {} }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'old',
              content: [{ type: 'tool_reference', tool_name: 'deferred_search' }],
            },
          ],
        },
      ],
      tools: [always, deferred],
    }),
    ['always_search', 'deferred_search'],
  );
});

test('Pi thinking merges only adjacent blocks with matching signature metadata', () => {
  const sigA = encodePiSignature(route, { thinking: 'A', thinkingSignature: 'field-a' });
  const sigB = encodePiSignature(route, { thinking: 'B', thinkingSignature: 'field-a' });
  const sigC = encodePiSignature(route, { thinking: 'C', thinkingSignature: 'field-a' });
  const sigD = encodePiSignature(route, { thinking: 'D', thinkingSignature: 'field-b' });
  const foreign = encodePiSignature('elsewhere', { thinking: 'discarded' });
  const result = toPiContext(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'A', signature: sigA },
            { type: 'thinking', thinking: 'foreign', signature: foreign },
            { type: 'thinking', thinking: 'B', signature: sigB },
            { type: 'text', text: 'boundary' },
            { type: 'thinking', thinking: 'C', signature: sigC },
            { type: 'thinking', thinking: 'D', signature: sigD },
          ],
        },
      ],
      max_tokens: 1,
    },
    model,
    route,
  ).context.messages[0];
  assert.equal(result?.role, 'assistant');
  if (result?.role !== 'assistant') {
    throw new Error('expected assistant');
  }
  assert.deepEqual(result.content, [
    { type: 'thinking', thinking: 'AB', thinkingSignature: 'field-a' },
    { type: 'text', text: 'boundary' },
    { type: 'thinking', thinking: 'C', thinkingSignature: 'field-a' },
    { type: 'thinking', thinking: 'D', thinkingSignature: 'field-b' },
  ]);
});

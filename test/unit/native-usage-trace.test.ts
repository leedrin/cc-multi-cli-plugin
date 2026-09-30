import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { usageTrace } from '../../plugins/multi-core/src/gateway/usage-trace.ts';
import { fromResponses } from '../../plugins/multi-openai/src/responses.ts';

const provider = {
  source: 'provider',
  inputTokens: 150,
  cacheReadTokens: 800,
  cacheWriteTokens: 0,
  outputTokens: 200,
  reasoningTokens: 120,
  totalTokens: 1150,
} as const;

function trace(
  env: Record<string, string | undefined>,
  usage: Parameters<typeof usageTrace>[0]['usage'],
) {
  const lines: string[] = [];
  usageTrace(
    { provider: 'openai', event: 'response.completed', usage },
    { env, write: (line) => lines.push(line) },
  );
  return lines;
}

test('usage trace is silent unless MULTI_USAGE_TRACE is 1', () => {
  assert.deepEqual(trace({}, provider), []);
  assert.deepEqual(trace({ MULTI_USAGE_TRACE: '0' }, provider), []);
  assert.deepEqual(trace({ MULTI_USAGE_TRACE: 'true' }, provider), []);
});

test('usage trace writes one JSON line of counts and nothing else', () => {
  const lines = trace({ MULTI_USAGE_TRACE: '1' }, provider);
  assert.equal(lines.length, 1);
  assert(lines[0].endsWith('\n'));
  assert.deepEqual(JSON.parse(lines[0]), {
    provider: 'openai',
    event: 'response.completed',
    usagePresent: true,
    source: 'provider',
    inputTokens: 150,
    cachedTokens: 800,
    cacheWriteTokens: 0,
    outputTokens: 200,
    reasoningTokens: 120,
    totalTokens: 1150,
  });
});

test('a missing usage is traced as absent with no invented zeros; unreported counts are left out', () => {
  const absent = JSON.parse(trace({ MULTI_USAGE_TRACE: '1' }, { source: 'unavailable' })[0]);
  assert.deepEqual(absent, {
    provider: 'openai',
    event: 'response.completed',
    usagePresent: false,
    source: 'unavailable',
  });
  const partial = JSON.parse(
    trace({ MULTI_USAGE_TRACE: '1' }, { source: 'mixed', outputTokens: 7 })[0],
  );
  assert.equal(partial.usagePresent, true);
  assert.equal(partial.outputTokens, 7);
  assert(!('inputTokens' in partial));
});

async function* sse(events: unknown[]) {
  for (const event of events) {
    yield Buffer.from(`data: ${JSON.stringify(event)}\n\n`);
  }
}

const created = { type: 'response.created', response: { id: 'resp' } };
const message = {
  type: 'message',
  id: 'msg',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'SECRET-ANSWER' }],
};
const completed = (usage?: unknown) => ({
  type: 'response.completed',
  response: { id: 'resp', output: [message], ...(usage === undefined ? {} : { usage }) },
});

async function traced(env: string | undefined, usage?: unknown) {
  const previous = process.env.MULTI_USAGE_TRACE;
  if (env === undefined) {
    delete process.env.MULTI_USAGE_TRACE;
  } else {
    process.env.MULTI_USAGE_TRACE = env;
  }
  const write = mock.method(process.stderr, 'write', () => true);
  try {
    await fromResponses(sse([created, completed(usage)]), 'multi/openai/gpt', undefined, {});
    return write.mock.calls.map((call) => String(call.arguments[0]));
  } finally {
    write.mock.restore();
    if (previous === undefined) {
      delete process.env.MULTI_USAGE_TRACE;
    } else {
      process.env.MULTI_USAGE_TRACE = previous;
    }
  }
}

test('OpenAI response.completed is traced once, with counts and no content', async () => {
  const lines = await traced('1', {
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1234,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 120 },
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    provider: 'openai',
    event: 'response.completed',
    usagePresent: true,
    source: 'provider',
    inputTokens: 150,
    cachedTokens: 800,
    cacheWriteTokens: 50,
    outputTokens: 200,
    reasoningTokens: 120,
    totalTokens: 1234,
  });
  assert(!lines[0].includes('SECRET-ANSWER'));
});

test('a completion without usage is traced as absent, and tracing is off by default', async () => {
  const absent = await traced('1');
  assert.deepEqual(JSON.parse(absent[0]), {
    provider: 'openai',
    event: 'response.completed',
    usagePresent: false,
    source: 'unavailable',
  });
  assert.deepEqual(await traced(undefined, { input_tokens: 1, output_tokens: 1 }), []);
});

test('a session with a prompt, reasoning and a tool call traces counts and none of its content', async () => {
  const previous = process.env.MULTI_USAGE_TRACE;
  process.env.MULTI_USAGE_TRACE = '1';
  const write = mock.method(process.stderr, 'write', () => true);
  try {
    await fromResponses(
      sse([
        created,
        {
          type: 'response.completed',
          response: {
            id: 'resp',
            output: [
              {
                type: 'reasoning',
                id: 'rs',
                summary: [{ type: 'summary_text', text: 'REASONING-TEXT' }],
                encrypted_content: 'ENCRYPTED-STATE',
              },
              message,
              {
                type: 'function_call',
                call_id: 'call_1',
                name: 'Read',
                arguments: '{"file_path":"TOOL-ARG-SECRET"}',
              },
            ],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
      ]),
      'multi/openai/gpt',
      undefined,
      { toolNames: new Map([['Read', 'Read']]) },
    );
    const output = write.mock.calls.map((call) => String(call.arguments[0])).join('');
    assert(output.length > 0);
    for (const secret of [
      'SECRET-ANSWER',
      'REASONING-TEXT',
      'ENCRYPTED-STATE',
      'TOOL-ARG-SECRET',
      'call_1',
      'Authorization',
      'Bearer',
      'x-multi-gateway-token',
    ]) {
      assert(!output.includes(secret), secret);
    }
  } finally {
    write.mock.restore();
    if (previous === undefined) {
      delete process.env.MULTI_USAGE_TRACE;
    } else {
      process.env.MULTI_USAGE_TRACE = previous;
    }
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { toProtocolUsage } from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  isOpenAIResponsesUsage,
  openAIAccountingMetadata,
  parseOpenAIResponseUsage,
} from '../../plugins/multi-openai/src/response-usage.ts';

test('a full usage keeps every count, uncached input and the provider total', () => {
  const usage = parseOpenAIResponseUsage({
    input_tokens: 1000,
    output_tokens: 200,
    total_tokens: 1200,
    input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 120 },
  });
  assert.deepEqual(usage, {
    source: 'provider',
    inputTokens: 150,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    reasoningTokens: 120,
    totalTokens: 1200,
    cacheReadRatio: 0.8,
  });
});

test('absent and null usage are unavailable, with no fields', () => {
  for (const value of [undefined, null, {}]) {
    assert.deepEqual(parseOpenAIResponseUsage(value), { source: 'unavailable' });
  }
});

test('an explicit provider zero is provider usage, not unknown', () => {
  const usage = parseOpenAIResponseUsage({ input_tokens: 0, output_tokens: 0 });
  assert.equal(usage.source, 'provider');
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.outputTokens, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.cacheReadTokens, undefined);
  assert.equal(usage.cacheWriteTokens, undefined);
});

test('a partial usage is mixed and leaves the missing side unknown', () => {
  const usage = parseOpenAIResponseUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
  });
  assert.equal(usage.source, 'mixed');
  assert.equal(usage.inputTokens, 60);
  assert.equal(usage.cacheReadTokens, 40);
  assert.equal(usage.outputTokens, undefined);
  assert.equal(usage.totalTokens, undefined);
  assert.deepEqual(toProtocolUsage(usage), {
    input_tokens: 60,
    output_tokens: 0,
    cache_read_input_tokens: 40,
  });
  const accounting = openAIAccountingMetadata(usage);
  assert.equal(accounting?.input_tokens, 60);
  assert.equal('output_tokens' in (accounting ?? {}), false);
});

test('an output-only usage is mixed and does not invent input', () => {
  const usage = parseOpenAIResponseUsage({ output_tokens: 30 });
  assert.equal(usage.source, 'mixed');
  assert.equal(usage.outputTokens, 30);
  assert.equal(usage.inputTokens, undefined);
  assert.equal(usage.totalTokens, undefined);
});

test('the total is derived only when input and output are both known', () => {
  assert.equal(parseOpenAIResponseUsage({ input_tokens: 10, output_tokens: 5 }).totalTokens, 15);
  assert.equal(parseOpenAIResponseUsage({ input_tokens: 10 }).totalTokens, undefined);
  assert.equal(
    parseOpenAIResponseUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 99 }).totalTokens,
    99,
  );
});

test('null detail objects are accepted and leave their fields unknown', () => {
  const usage = parseOpenAIResponseUsage({
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: null,
    output_tokens_details: null,
  });
  assert.equal(usage.source, 'provider');
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.cacheReadTokens, undefined);
  assert.equal(usage.cacheWriteTokens, undefined);
  assert.equal(usage.reasoningTokens, undefined);
});

test('cached tokens beyond the input never produce a negative uncached count', () => {
  const usage = parseOpenAIResponseUsage({
    input_tokens: 10,
    output_tokens: 1,
    input_tokens_details: { cached_tokens: 30 },
  });
  assert.equal(usage.inputTokens, 0);
  assert.equal(usage.cacheReadTokens, 30);
});

test('negative, fractional, non-finite and unsafe counts are malformed', () => {
  const bad = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '5'];
  for (const value of bad) {
    for (const usage of [
      { input_tokens: value },
      { output_tokens: value },
      { total_tokens: value },
      { input_tokens_details: { cached_tokens: value } },
      { input_tokens_details: { cache_write_tokens: value } },
      { output_tokens_details: { reasoning_tokens: value } },
    ]) {
      assert.throws(() => parseOpenAIResponseUsage(usage), /malformed/);
      assert.equal(isOpenAIResponsesUsage(usage), false);
    }
  }
  assert.throws(() => parseOpenAIResponseUsage('x'), /malformed/);
  assert.throws(() => parseOpenAIResponseUsage([1]), /malformed/);
});

test('unavailable usage gets protocol placeholders but no accounting', () => {
  const usage = parseOpenAIResponseUsage(null);
  assert.deepEqual(toProtocolUsage(usage), { input_tokens: 0, output_tokens: 0 });
  assert.equal(openAIAccountingMetadata(usage), undefined);
});

test('the accounting block carries every known count and the ratio, and nothing else', () => {
  const accounting = openAIAccountingMetadata(
    parseOpenAIResponseUsage({
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
      output_tokens_details: { reasoning_tokens: 120 },
    }),
  );
  assert.deepEqual(accounting, {
    input_tokens: 150,
    output_tokens: 200,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 50,
    reasoning_tokens: 120,
    total_tokens: 1200,
    cache_read_ratio: 0.8,
  });
});

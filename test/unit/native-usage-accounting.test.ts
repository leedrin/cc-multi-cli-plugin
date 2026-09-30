import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCanonicalUsage,
  type CanonicalTokenUsage,
  cacheReadRatio,
  createUsageAccumulator,
  mergeUsageSource,
  serializeUsageTotals,
  type UsageSource,
} from '../../plugins/multi-core/src/gateway/usage-accounting.ts';

const SOURCES: readonly UsageSource[] = ['provider', 'estimate', 'mixed', 'unavailable'];

test('cacheReadRatio is token-weighted over uncached input, cache reads and cache writes', () => {
  assert.equal(
    cacheReadRatio({ inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000 }),
    0.8,
  );
  assert.equal(cacheReadRatio({ inputTokens: 0, cacheReadTokens: 500, cacheWriteTokens: 0 }), 1);
  assert.equal(cacheReadRatio({ inputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }), 0);
  assert.equal(
    cacheReadRatio({ inputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 100 }),
    0.5,
    'cache writes count against the ratio',
  );
  assert.equal(cacheReadRatio({ inputTokens: 60, cacheReadTokens: 40 }), 0.4);
});

test('cacheReadRatio is unknown when the denominator is zero or a required count is unknown', () => {
  assert.equal(
    cacheReadRatio({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    undefined,
  );
  assert.equal(cacheReadRatio({ cacheReadTokens: 800 }), undefined);
  assert.equal(cacheReadRatio({ inputTokens: 100 }), undefined);
  assert.equal(cacheReadRatio({}), undefined);
});

test('mergeUsageSource keeps equal sources, mixes different ones, and mixed absorbs all', () => {
  for (const source of SOURCES) {
    assert.equal(mergeUsageSource(source, source), source);
  }
  for (const [a, b] of [
    ['provider', 'estimate'],
    ['provider', 'unavailable'],
    ['estimate', 'unavailable'],
  ] as const) {
    assert.equal(mergeUsageSource(a, b), 'mixed');
    assert.equal(mergeUsageSource(b, a), 'mixed');
  }
  for (const source of SOURCES) {
    assert.equal(mergeUsageSource('mixed', source), 'mixed');
    assert.equal(mergeUsageSource(source, 'mixed'), 'mixed');
  }
});

test('an accumulator that saw nothing serializes as unavailable with no counts', () => {
  assert.deepEqual(serializeUsageTotals(createUsageAccumulator()), { source: 'unavailable' });
});

test('an unavailable event adds no counts and never becomes zero', () => {
  const accumulator = createUsageAccumulator();
  addCanonicalUsage(accumulator, { source: 'unavailable' });
  assert.deepEqual(serializeUsageTotals(accumulator), { source: 'unavailable' });
});

test('a known zero stays zero while a never-reported count is omitted', () => {
  const accumulator = createUsageAccumulator();
  addCanonicalUsage(accumulator, { source: 'provider', inputTokens: 100, outputTokens: 0 });
  const totals = serializeUsageTotals(accumulator);
  assert.equal(totals.output_tokens, 0);
  assert.equal(totals.input_tokens, 100);
  assert.equal('reasoning_tokens' in totals, false);
  assert.equal('cache_read_input_tokens' in totals, false);
  assert.equal('total_tokens' in totals, false);
  assert.equal('model_calls' in totals, false);
});

test('accumulation sums only the known values of each field', () => {
  const accumulator = createUsageAccumulator();
  const full: CanonicalTokenUsage = {
    source: 'provider',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    reasoningTokens: 100,
    totalTokens: 1200,
    modelCalls: 2,
  };
  addCanonicalUsage(accumulator, full);
  addCanonicalUsage(accumulator, {
    source: 'provider',
    inputTokens: 50,
    outputTokens: 10,
    cacheReadTokens: 100,
    reasoningTokens: 50,
    totalTokens: 300,
  });
  assert.deepEqual(serializeUsageTotals(accumulator), {
    source: 'provider',
    input_tokens: 150,
    output_tokens: 30,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 150,
    total_tokens: 1500,
    model_calls: 2,
    cache_read_ratio: 500 / 650,
  });
});

test('merging provider with unavailable or estimate yields mixed totals without a ratio', () => {
  for (const other of ['unavailable', 'estimate'] as const) {
    const accumulator = createUsageAccumulator();
    addCanonicalUsage(accumulator, {
      source: 'provider',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 90,
    });
    addCanonicalUsage(
      accumulator,
      other === 'estimate'
        ? { source: 'estimate', inputTokens: 1, outputTokens: 1 }
        : { source: other },
    );
    const totals = serializeUsageTotals(accumulator);
    assert.equal(totals.source, 'mixed');
    assert.equal(totals.input_tokens, other === 'estimate' ? 11 : 10);
    assert.equal('cache_read_ratio' in totals, false);
  }
});

test('a ratio is serialized only for provider totals with a known denominator', () => {
  const estimated = createUsageAccumulator();
  addCanonicalUsage(estimated, {
    source: 'estimate',
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 90,
  });
  assert.equal('cache_read_ratio' in serializeUsageTotals(estimated), false);

  const noInput = createUsageAccumulator();
  addCanonicalUsage(noInput, { source: 'provider', outputTokens: 4, cacheReadTokens: 10 });
  assert.equal('cache_read_ratio' in serializeUsageTotals(noInput), false);

  const exact = createUsageAccumulator();
  addCanonicalUsage(exact, {
    source: 'provider',
    inputTokens: 200,
    outputTokens: 1,
    cacheReadTokens: 800,
  });
  assert.equal(serializeUsageTotals(exact).cache_read_ratio, 0.8);
});

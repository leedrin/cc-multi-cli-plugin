import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoverAntigravityWithHook,
  discoverEnabledProviders,
  providerExplicit,
} from '../../plugins/multi-core/src/provider-discovery.ts';

function context(id: string) {
  return { cwd: id, env: {}, explicit: true, log: () => {} };
}

test('launcher discovery filters by enabled provider and stores results by provider id', async () => {
  const calls: string[] = [];
  const registry = { list: () => [{ id: 'zen' }, { id: 'openai' }] };
  const discovery = {
    openai: async () => {
      calls.push('openai');
      return { codexSignedIn: true, openaiReview: false };
    },
    zen: async () => {
      calls.push('zen');
      return 'fixture-key';
    },
  };
  const results = await discoverEnabledProviders(registry, ['openai'], discovery, context);
  assert.deepEqual(calls, ['openai']);
  assert.deepEqual(results, { openai: { codexSignedIn: true, openaiReview: false } });
});

test('launcher discovery keeps enabled filtering separate from explicit selection context', async () => {
  const registry = { list: () => [{ id: 'antigravity' }] };
  const cases = [
    { selection: undefined, calls: 1, explicit: false },
    { selection: [], calls: 0, explicit: false },
    { selection: ['antigravity'], calls: 1, explicit: true },
    { selection: ['openai'], calls: 0, explicit: false },
  ] as const;
  for (const { selection, calls: expectedCalls, explicit } of cases) {
    let calls = 0;
    const results = await discoverEnabledProviders(
      registry,
      selection,
      {
        antigravity: async (received) => {
          calls += 1;
          assert.equal(received.explicit, explicit);
          return ['model'];
        },
      },
      (id) => ({ ...context(id), explicit: providerExplicit(id, selection) }),
    );
    assert.equal(calls, expectedCalls);
    if (expectedCalls) {
      assert.deepEqual(results.antigravity, ['model']);
    }
  }
});

test('Antigravity hook installs only for explicit selection with discovered models', async () => {
  const installCases = [
    { explicit: false, models: ['model'], expected: 0 },
    { explicit: true, models: [], expected: 0 },
    { explicit: true, models: ['model'], expected: 1 },
  ] as const;
  for (const { explicit, models, expected } of installCases) {
    let installs = 0;
    const result = await discoverAntigravityWithHook(
      { ...context('antigravity'), explicit },
      async () => models,
      async () => {
        installs += 1;
      },
    );
    assert.deepEqual(result, models);
    assert.equal(installs, expected);
  }
});

test('launcher discovery uses the registered descriptor when no typed handler exists', async () => {
  const registry = {
    list: () => [{ id: 'strata' }],
    get: () => ({
      availability: async () => ({ available: true }),
      discoverModels: async () => [],
    }),
  };
  const results = await discoverEnabledProviders(registry, undefined, {}, context);
  assert.deepEqual(results, { strata: [] });
});

test('launcher discovery runs registered providers concurrently and preserves id association across orderings', async () => {
  const registry = { list: () => [{ id: 'zen' }, { id: 'openai' }] };
  const started: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = discoverEnabledProviders(
    registry,
    undefined,
    {
      openai: async () => {
        started.push('openai');
        await barrier;
        return { codexSignedIn: false, openaiReview: false };
      },
      zen: async () => {
        started.push('zen');
        await barrier;
        return 'zen-key';
      },
    },
    context,
  );
  await Promise.resolve();
  const allStartedBeforeRelease = started.length === 2;
  release();
  assert.equal(allStartedBeforeRelease, true, 'all discoveries start before any is released');
  const results = await pending;
  assert.deepEqual(started, ['zen', 'openai']);
  assert.deepEqual(results, {
    zen: 'zen-key',
    openai: { codexSignedIn: false, openaiReview: false },
  });
});

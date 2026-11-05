import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import '../../plugins/multi-core/src/gateway/builtin-providers.ts';

function context(env: NodeJS.ProcessEnv = {}, explicit = false, messages: string[] = []) {
  return {
    cwd: 'fixture-cwd',
    env,
    explicit,
    log: (message: string) => messages.push(message),
  };
}

test('OpenAI discovery keeps login and reviewer outcomes and exact log messages', async () => {
  const { discoverOpenAI } = await import('../../plugins/multi-openai/src/provider.ts');
  const logs: string[] = [];
  const lockedOut = await discoverOpenAI(context({}, true, logs), {
    readAuth: async () => {
      throw new Error('missing fixture auth');
    },
  });
  assert.deepEqual(lockedOut, { codexSignedIn: false, openaiReview: false });
  assert.deepEqual(logs, ['OpenAI choices unavailable: sign in with codex login to enable them.']);

  for (const reviewerResult of [true, false] as const) {
    const signedIn = await discoverOpenAI(context({}, true, logs), {
      readAuth: async () => ({ authorization: 'fixture', 'chatgpt-account-id': 'fixture' }),
      discoverReviewer: async () => reviewerResult,
    });
    assert.deepEqual(signedIn, { codexSignedIn: true, openaiReview: reviewerResult });
  }
  const reviewerFailed = await discoverOpenAI(context({}, true, logs), {
    readAuth: async () => ({ authorization: 'fixture', 'chatgpt-account-id': 'fixture' }),
    discoverReviewer: async () => {
      throw new Error('fixture reviewer error');
    },
  });
  assert.deepEqual(reviewerFailed, { codexSignedIn: true, openaiReview: false });
  assert.deepEqual(logs, [
    'OpenAI choices unavailable: sign in with codex login to enable them.',
    'OpenAI reviewer unavailable; actions in auto mode run unreviewed.',
    'OpenAI reviewer unavailable; actions in auto mode run unreviewed.',
  ]);
});

test('Zen discovery reads the injected environment and skips disabled providers', async () => {
  const { discoverZen } = await import('../../plugins/multi-zen/src/provider.ts');
  let seenEnv: NodeJS.ProcessEnv | undefined;
  assert.equal(
    await discoverZen(context({ OPENCODE_API_KEY: 'fixture' }), {
      readKey: async (options) => {
        seenEnv = options?.env;
        return options?.env?.OPENCODE_API_KEY;
      },
    }),
    'fixture',
  );
  assert.equal(seenEnv?.OPENCODE_API_KEY, 'fixture');
  assert.equal(
    await discoverZen(context({ MULTI_ENABLED_PROVIDERS: 'openai' }), {
      readKey: async () => 'must-not-read',
    }),
    undefined,
  );
});

test('Cursor discovery handles sign-in, models, timeout and required errors', async () => {
  const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
  const messages: string[] = [];
  const signedOut = await discoverCursor(context({}), false, {
    cursor: {
      auth: { status: async () => ({ status: 'logged-out' }) },
      models: { list: async () => [] },
    },
  });
  assert.deepEqual(signedOut, { cursorModels: [], cursorSignedIn: false });

  const signedIn = await discoverCursor(context({ CURSOR_API_KEY: 'fixture' }), false, {
    cursor: {
      auth: { status: async () => ({ status: 'logged-out' }) },
      models: { list: async () => [] },
    },
  });
  assert.deepEqual(signedIn, { cursorModels: [], cursorSignedIn: true });

  assert.deepEqual(messages, []);
  await assert.rejects(
    discoverCursor(context({ CURSOR_API_KEY: 'fixture' }), true, {
      cursor: {
        auth: {
          status: async () => ({ status: 'logged-in', backendUrl: 'https://fixture.invalid' }),
        },
        models: { list: async () => Promise.reject(new Error('required fixture failure')) },
      },
    }),
    /required fixture failure/,
  );
});

test('Antigravity discovery obeys selection and MULTI_ANTIGRAVITY and logs failures', async () => {
  const { discoverAntigravity } = await import('../../plugins/multi-antigravity/src/provider.ts');
  const fixture = [{ id: 'fixture', model: 'multi/antigravity/fixture', label: 'Fixture' }];
  const deps = {
    resolveExecutable: () => 'agy-fixture',
    discoverModels: async () => fixture,
  };
  assert.deepEqual(await discoverAntigravity(context(), deps), []);
  assert.deepEqual(
    await discoverAntigravity(
      context({ MULTI_ANTIGRAVITY: '1', MULTI_ENABLED_PROVIDERS: 'openai' }),
      deps,
    ),
    [],
  );
  assert.deepEqual(
    await discoverAntigravity(context({ MULTI_ANTIGRAVITY: '1' }, false), deps),
    fixture,
  );
  const messages: string[] = [];
  assert.deepEqual(
    await discoverAntigravity(context({ MULTI_ANTIGRAVITY: '1' }, true, messages), {
      resolveExecutable: () => 'agy-fixture',
      discoverModels: async () => {
        throw new Error('fixture agy failure');
      },
    }),
    [],
  );
  assert.deepEqual(messages, ['Antigravity choices unavailable: fixture agy failure']);
});

test('Grok discovery reports failures only for explicitly selected providers', async () => {
  const { discoverGrok } = await import('../../plugins/multi-grok/src/provider.ts');
  const failure = {
    resolveExecutable: () => 'grok-fixture',
    discoverModels: async () => {
      throw new Error('fixture grok failure');
    },
  };
  const implicitLogs: string[] = [];
  assert.deepEqual(await discoverGrok(context({}, false, implicitLogs), failure), []);
  assert.deepEqual(implicitLogs, []);
  const explicitLogs: string[] = [];
  assert.deepEqual(await discoverGrok(context({}, true, explicitLogs), failure), []);
  assert.deepEqual(explicitLogs, ['Grok choices unavailable: fixture grok failure']);
  assert.deepEqual(
    await discoverGrok(context(), {
      resolveExecutable: () => 'grok-fixture',
      discoverModels: async () => [
        { id: 'fixture', model: 'multi/grok/fixture', label: 'Fixture', default: true },
      ],
    }),
    [{ id: 'fixture', model: 'multi/grok/fixture', label: 'Fixture', default: true }],
  );
});

for (const id of ['openai', 'cursor', 'grok'] as const) {
  test(`${id} explicit disable skips every dependency and explicit enable calls them`, async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const disabled = context({ MULTI_ENABLED_PROVIDERS: 'zen' }, false, logs);
    const enabled = context({ MULTI_ENABLED_PROVIDERS: id }, true, logs);
    if (id === 'openai') {
      const { discoverOpenAI } = await import('../../plugins/multi-openai/src/provider.ts');
      const deps = {
        readAuth: async () => {
          calls.push('auth');
          return { authorization: 'fixture', 'chatgpt-account-id': 'fixture' };
        },
        discoverReviewer: async () => {
          calls.push('reviewer');
          return true;
        },
      };
      assert.deepEqual(await discoverOpenAI(disabled, deps), {
        codexSignedIn: false,
        openaiReview: false,
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(await discoverOpenAI(enabled, deps), {
        codexSignedIn: true,
        openaiReview: true,
      });
      assert.deepEqual(calls, ['auth', 'reviewer']);
    } else if (id === 'cursor') {
      const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
      const deps = {
        cursor: {
          auth: {
            status: async () => {
              calls.push('auth');
              return { status: 'logged-in' as const, backendUrl: 'https://fixture.invalid' };
            },
          },
          models: {
            list: async () => {
              calls.push('models');
              return [];
            },
          },
        },
      };
      assert.deepEqual(await discoverCursor(disabled, true, deps), {
        cursorModels: [],
        cursorSignedIn: false,
      });
      assert.deepEqual(calls, []);
      assert.deepEqual(await discoverCursor(enabled, true, deps), {
        cursorModels: [],
        cursorSignedIn: true,
      });
      assert.deepEqual(calls, ['auth', 'models']);
    } else {
      const { discoverGrok } = await import('../../plugins/multi-grok/src/provider.ts');
      const deps = {
        resolveExecutable: () => {
          calls.push('resolve');
        },
        discoverModels: async () => {
          calls.push('models');
          return [];
        },
      };
      assert.deepEqual(await discoverGrok(disabled, deps), []);
      assert.deepEqual(calls, []);
      assert.deepEqual(await discoverGrok(enabled, deps), []);
      assert.deepEqual(calls, ['resolve', 'models']);
    }
    assert.deepEqual(logs, []);
  });
}

test('Cursor SDK receives context key instead of the different host key', async () => {
  const moduleUrl = new URL(
    '../../plugins/multi-core/src/gateway/builtin-providers.ts',
    import.meta.url,
  );
  const providerUrl = new URL('../../plugins/multi-cursor/src/provider.ts', import.meta.url);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
await import(${JSON.stringify(moduleUrl.href)});
const { discoverCursor } = await import(${JSON.stringify(providerUrl.href)});
assert.equal(process.env.CURSOR_API_KEY, 'host-fixture');
const calls = [];
const result = await discoverCursor({ cwd: '.', env: { CURSOR_API_KEY: 'context-fixture' },
  explicit: true, log: (message) => assert.fail(message) }, true, {
  cursor: {
    auth: { status: async () => assert.fail('key must bypass saved-login status') },
    models: { list: async (...args) => { calls.push(args); return []; } }
  }
});
assert.deepEqual(result, { cursorModels: [], cursorSignedIn: true });
assert.deepEqual(calls, [[{ apiKey: 'context-fixture' }]]);
assert.equal(process.env.CURSOR_API_KEY, 'host-fixture');
console.log('isolated SDK key arguments verified');`,
    ],
    { env: { ...process.env, CURSOR_API_KEY: 'host-fixture' }, timeout: 10000 },
  );
  assert.equal(stdout, 'isolated SDK key arguments verified\n');
  assert.equal(stderr, '');
});

test('Cursor saved login without a key preserves exact non-empty model mapping', async () => {
  const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
  const catalog = [{ id: 'fixture-model', displayName: 'Fixture Model' }];
  const authCalls: unknown[][] = [];
  const modelCalls: unknown[][] = [];
  const result = await discoverCursor(context(), true, {
    cursor: {
      auth: {
        status: async (...args) => {
          authCalls.push(args);
          return { status: 'logged-in', backendUrl: 'https://fixture.invalid' };
        },
      },
      models: {
        list: async (...args) => {
          modelCalls.push(args);
          return catalog;
        },
      },
    },
  });
  assert.deepEqual(authCalls, [[]]);
  assert.deepEqual(modelCalls, [[{ apiKey: undefined }]]);
  assert.deepEqual(result, {
    cursorSignedIn: true,
    cursorModels: [
      {
        model: 'multi/cursor/fixture-model',
        label: 'Fixture Model via Cursor',
        description: 'Fixture Model via Cursor',
        selection: { id: 'fixture-model' },
        catalog: catalog[0],
      },
    ],
  });
});

test('Cursor auth.status failures propagate without listing models or logging', async () => {
  const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
  const failure = new Error('fixture auth status failure');
  for (const required of [false, true]) {
    const messages: string[] = [];
    let modelCalls = 0;
    await assert.rejects(
      discoverCursor(context({}, false, messages), required, {
        cursor: {
          auth: {
            status: async () => {
              throw failure;
            },
          },
          models: {
            list: async () => {
              modelCalls++;
              return [];
            },
          },
        },
      }),
      (error) => error === failure,
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(messages, []);
  }
});

test('Cursor ordinary model errors log exactly when not required', async () => {
  const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
  const messages: string[] = [];
  assert.deepEqual(
    await discoverCursor(context({ CURSOR_API_KEY: 'fixture' }, false, messages), false, {
      cursor: {
        auth: { status: async () => assert.fail('key bypasses status') },
        models: {
          list: async () => {
            throw new Error('ordinary fixture failure');
          },
        },
      },
    }),
    { cursorModels: [], cursorSignedIn: true },
  );
  assert.deepEqual(messages, ['Cursor choices unavailable: ordinary fixture failure']);
});

test('Cursor timeout starts at 15000 not 14999 ms and clears timers on every exit', async (t) => {
  const { discoverCursor } = await import('../../plugins/multi-cursor/src/provider.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const clear = t.mock.method(globalThis, 'clearTimeout');
  for (const required of [false, true]) {
    const messages: string[] = [];
    let settled = false;
    const pending = discoverCursor(
      context({ CURSOR_API_KEY: 'fixture' }, true, messages),
      required,
      {
        cursor: {
          auth: { status: async () => assert.fail('key bypasses status') },
          models: { list: async () => new Promise<never>(() => {}) },
        },
      },
    );
    const outcome = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const clearCount = clear.mock.callCount();
    t.mock.timers.tick(14999);
    await setImmediate();
    assert.equal(settled, false, 'must not time out at 14999 ms');
    assert.deepEqual(messages, []);
    assert.equal(clear.mock.callCount(), clearCount);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(settled, true, 'must time out at 15000 ms');
    const result = await outcome;
    if (required) {
      assert(result instanceof Error);
      assert.equal(result.message, 'Cursor model discovery timed out');
      assert.deepEqual(messages, []);
    } else {
      assert.deepEqual(result, { cursorModels: [], cursorSignedIn: true });
      assert.deepEqual(messages, ['Cursor choices unavailable: Cursor model discovery timed out']);
    }
    assert.equal(clear.mock.callCount(), clearCount + 1);
    assert.notEqual(scheduled.mock.calls.at(-1)?.result, undefined);
    assert.equal(clear.mock.calls.at(-1)?.arguments[0], scheduled.mock.calls.at(-1)?.result);
  }
  for (const fail of [false, true]) {
    const messages: string[] = [];
    const clearCount = clear.mock.callCount();
    const result = await discoverCursor(
      context({ CURSOR_API_KEY: 'fixture' }, false, messages),
      false,
      {
        cursor: {
          auth: { status: async () => assert.fail('key bypasses status') },
          models: {
            list: async () => {
              if (fail) {
                throw new Error('cleanup fixture');
              }
              return [];
            },
          },
        },
      },
    );
    assert.deepEqual(result, { cursorModels: [], cursorSignedIn: true });
    assert.equal(clear.mock.callCount(), clearCount + 1);
    assert.notEqual(scheduled.mock.calls.at(-1)?.result, undefined);
    assert.equal(clear.mock.calls.at(-1)?.arguments[0], scheduled.mock.calls.at(-1)?.result);
    t.mock.timers.tick(15000);
    await setImmediate();
    assert.deepEqual(messages, fail ? ['Cursor choices unavailable: cleanup fixture'] : []);
  }
});

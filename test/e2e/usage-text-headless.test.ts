import assert from 'node:assert/strict';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { NativeScript } from './types.ts';

const grok: NativeScript = ({ args }) => {
  if (args[0] === 'models') {
    return { stdout: '* e2e (default)\n' };
  }
  throw new Error('A usage command must never invoke Grok inference');
};

// A headless host has no pane to place. `/multi-usage --text` must still print every
// provider's usage, and must not ask any model or native CLI for it.
test('usage-text-headless: --text prints the usage of every provider in a headless run', async (t) => {
  const result = await runScenario(t, {
    name: 'usage-text-headless',
    enabledProviders: ['grok'],
    permissionMode: 'bypassPermissions',
    prompt: '/multi-usage --text',
    native: { grok },
    fixtures: {
      '.grok/auth.json': JSON.stringify({
        account: {
          key: 'e2e-dummy-grok',
          expires_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
        },
      }),
    },
    upstream: { anthropic: () => ({ text: 'The model must not be asked.' }) },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  for (const name of ['OpenAI / Codex', 'Cursor', 'OpenCode Zen', 'Antigravity', 'Grok Build']) {
    assert.match(result.stdout, new RegExp(name), result.stdout);
  }
  assert.match(result.stdout, /Multi usage · account data checked/);
  assert.match(result.stdout, /Grok Build \[ready\]/);
  assert.equal(
    result.requests.filter((request) => request.provider === 'anthropic').length,
    0,
    'No model request for a usage command',
  );
  assert.equal(result.nativeInvocations.filter(({ args }) => args[0] !== 'models').length, 0);
  assert.deepEqual(result.upstreamErrors, []);
});

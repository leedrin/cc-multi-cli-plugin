import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';
import type { JsonObject, ReplyUsage } from './types.ts';

// An OpenAI streaming response must reach three readers with the same numbers: Claude's own
// usage (output and cache read), the receipt ledger, and /multi-usage. Claude's native usage
// UI has no place for a cache ratio, so the ratio is read where it is shown: the dashboard.
const first = { input: 1234, output: 56, cacheRead: 9000, cacheWrite: 300 } satisfies ReplyUsage;
const second = { input: 100, output: 20, cacheRead: 10000 } satisfies ReplyUsage;
const ratio = first.cacheRead / (first.input + first.cacheRead + first.cacheWrite);

test('openai-usage-visible: output, cache reads and the cache ratio survive to /multi-usage', async (t) => {
  const result = await runScenario(t, {
    name: 'openai-usage-visible',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    permissionMode: 'bypassPermissions',
    fixtures: {
      'workspace/wire.mjs': await readFile(
        new URL('./fixtures/usage-receipts/wire.mjs', import.meta.url),
        'utf8',
      ),
    },
    // The account quota is out of scope here: a Codex that answers nothing leaves the row\n    // without quota, and the session's own usage is still listed on it.
    native: { codex: () => ({ code: 1 }) },
    upstream: {
      openai: (request, index) => {
        if (index === 0) {
          const session = String(request.headers.session_id);
          return {
            usage: first,
            tool: {
              name: 'Bash',
              id: 'call_usage',
              input: {
                command: `node wire.mjs ${session} quota`,
                description: 'Read this session usage through the authenticated gateway',
              },
            },
          };
        }
        return { text: 'Usage is visible.', usage: second };
      },
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(result.upstreamErrors, []);
  // Claude's own result: the final output is not zero, and the cached tokens are there.
  const final = result.transcript.findLast((event) => event.type === 'result');
  assert.ok(final, JSON.stringify(result.transcript.slice(-3)));
  const claude = final.usage as JsonObject;
  assert.ok(Number(claude.output_tokens) > 0);
  assert.ok(Number(claude.cache_read_input_tokens) > 0);
  // /multi-usage, read mid-session: the first response's numbers, exactly, with the ratio.
  const output = JSON.parse(
    await readFile(path.join(result.workspace, 'wire-output.json'), 'utf8'),
  );
  const row = output.providers.find((provider: JsonObject) => provider.id === 'openai');
  assert.ok(row?.session, JSON.stringify(row));
  assert.equal(row.session.source, 'provider');
  assert.equal(row.session.consumed.output_tokens, first.output);
  assert.equal(row.session.consumed.cache_read_input_tokens, first.cacheRead);
  assert.equal(row.session.consumed.cache_creation_input_tokens, first.cacheWrite);
  assert.ok(Math.abs(row.session.consumed.cache_read_ratio - ratio) < 1e-9);
  const lines = (row.details as string[]).join('\n');
  assert.match(lines, new RegExp(`prompt cache read ratio ${(ratio * 100).toFixed(1)}%`));
  assert.match(lines, /Source: provider/);
});

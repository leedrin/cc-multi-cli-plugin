import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ANTIGRAVITY_TOOLS } from '../../plugins/multi-antigravity/src/progress.ts';
import {
  BUILTIN_PROVIDERS,
  createBuiltinRegistry,
} from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import {
  harnessUnavailable,
  PROVIDER_AUTO_REVIEW,
} from '../../plugins/multi-core/src/gateway/provider.ts';
import { PROVIDER_FACTS } from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import { CURSOR_TOOLS } from '../../plugins/multi-cursor/src/progress.ts';
import { GROK_TOOLS } from '../../plugins/multi-grok/src/permissions.ts';
import { removeTemporary } from '../temporary.ts';

const BUILTIN_IDS = ['openai', 'zen', 'cursor', 'antigravity', 'grok'];
const LEGACY_SIGNATURE_PREFIXES = ['multi-openai:', 'multi-zen-responses:', 'multi-zen-chat:'];
const LEGACY_AUTO_REVIEW = {
  openai: { review: 'reviewer', statement: 'reviewed by the OpenAI account reviewer' },
  zen: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  cursor: {
    review: 'harness',
    statement: 'Cursor reviews its own actions natively and fails open',
  },
  antigravity: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  grok: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
} as const;
const LEGACY_HARNESS_UNAVAILABLE = {
  cursor: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
  antigravity: 'Antigravity is unavailable. Install and connect the multi-antigravity plugin.',
  grok: 'Grok is unavailable. Install Grok Build, run grok login, and relaunch.',
} as const;

test('harness descriptors expose their native display tools', () => {
  const expected = {
    cursor: CURSOR_TOOLS,
    antigravity: ANTIGRAVITY_TOOLS,
    grok: GROK_TOOLS,
  } as const;
  for (const [id, tools] of Object.entries(expected)) {
    const descriptor = BUILTIN_PROVIDERS.find((provider) => provider.id === id);
    assert(descriptor);
    assert.deepEqual(descriptor.displayTools, tools);
  }
});

test('built-in registry registers five provider descriptors with matching facts', () => {
  const registry = createBuiltinRegistry();
  assert.deepEqual(
    registry.list().map(({ id }) => id),
    BUILTIN_IDS,
  );
  for (const descriptor of registry.list()) {
    const fact = PROVIDER_FACTS.find(({ id }) => id === descriptor.id);
    assert(fact);
    assert.equal(descriptor.plugin, fact.plugin);
    assert.equal(descriptor.kind, fact.kind);
    assert.equal(descriptor.label, fact.label);
    assert.equal(descriptor.worker?.type, fact.worker);
  }
});

test('Registry prefixes, review policies, and harness unavailable messages retain existing values', () => {
  assert.deepEqual(
    [...createBuiltinRegistry().signaturePrefixes()].sort(),
    [...LEGACY_SIGNATURE_PREFIXES].sort(),
  );
  for (const descriptor of BUILTIN_PROVIDERS) {
    const id = descriptor.id as keyof typeof LEGACY_AUTO_REVIEW;
    assert.deepEqual(descriptor.autoReview, LEGACY_AUTO_REVIEW[id]);
    assert.deepEqual(PROVIDER_AUTO_REVIEW[id], LEGACY_AUTO_REVIEW[id]);
  }
  for (const id of ['cursor', 'antigravity', 'grok'] as const) {
    const descriptor = BUILTIN_PROVIDERS.find(({ id: candidate }) => candidate === id);
    assert(descriptor);
    assert.equal(descriptor.unavailableMessage, LEGACY_HARNESS_UNAVAILABLE[id]);
    assert.equal(harnessUnavailable[id], LEGACY_HARNESS_UNAVAILABLE[id]);
  }
});

test('Antigravity and Grok discovery honor the supplied environment without spawning', async () => {
  const context = {
    cwd: process.cwd(),
    env: { PATH: '', MULTI_ANTIGRAVITY: '1' },
    explicit: true,
    log: () => {},
  };
  for (const id of ['antigravity', 'grok'] as const) {
    const descriptor = BUILTIN_PROVIDERS.find((provider) => provider.id === id);
    assert(descriptor);
    const availability = await descriptor.availability(context);
    assert.equal(availability.available, false, `${id} ignored the supplied empty PATH`);
    assert.match(availability.reason ?? '', /Executable not found on PATH/);
    await assert.rejects(descriptor.discoverModels(context), /Executable not found on PATH/);
  }
});

// Only OS process-launch support is inherited; no host PATH, credentials or Node preloads.
function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: directory, PATHEXT: '.CMD' };
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(systemroot|windir|comspec|temp|tmp)$/i.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

async function writeDiscoveryCli(directory: string, name: string, catalog: string) {
  if (process.platform === 'win32') {
    await writeFile(
      path.join(directory, `${name}.cmd`),
      `@echo off\r\nif not "%~1"=="models" exit /b 2\r\nif not "%~2"=="" exit /b 2\r\necho ${catalog}\r\n`,
    );
    return;
  }
  await writeFile(
    path.join(directory, name),
    `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = models ] || exit 2\nprintf '%s\\n' '${catalog}'\n`,
    { mode: 0o755 },
  );
}

for (const id of ['antigravity', 'grok'] as const) {
  for (const operation of ['availability', 'discoverModels'] as const) {
    test(`${id} ${operation} uses context.env PATH rather than the host PATH`, async (t) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'builtin-discovery-'));
      t.after(() => removeTemporary(directory));
      const bin = path.join(directory, 'fake cli');
      const empty = path.join(directory, 'empty');
      await mkdir(bin);
      await mkdir(empty);
      const catalog =
        id === 'antigravity' ? 'fixture-agy\tFixture Agy' : '* grok-fixture (default)';
      await writeDiscoveryCli(bin, id === 'antigravity' ? 'agy' : 'grok', catalog);
      const moduleUrl = new URL(
        '../../plugins/multi-core/src/gateway/builtin-providers.ts',
        import.meta.url,
      ).href;
      const context = {
        cwd: directory,
        env: { ...isolatedEnvironment(bin), MULTI_ANTIGRAVITY: '1' },
        explicit: true,
        log: () => {},
      };
      // The fresh process has no real CLI on PATH even if a callback regresses to process.env.
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { BUILTIN_PROVIDERS } = await import(${JSON.stringify(moduleUrl)});
const descriptor = BUILTIN_PROVIDERS.find(({ id }) => id === ${JSON.stringify(id)});
console.log(JSON.stringify(await descriptor[${JSON.stringify(operation)}](${JSON.stringify(context)})));`,
        ],
        { cwd: directory, env: isolatedEnvironment(empty), timeout: 20000 },
      );
      assert.equal(stderr, '');
      const result = JSON.parse(stdout);
      if (operation === 'availability') {
        assert.deepEqual(result, { available: true });
      } else {
        assert.deepEqual(result, [
          {
            identity: {
              providerId: id,
              modelId: id === 'antigravity' ? 'fixture-agy' : 'grok-fixture',
              routeId: `multi/${id}/${id === 'antigravity' ? 'fixture-agy' : 'grok-fixture'}`,
              oneMillionContext: false,
            },
            label: id === 'antigravity' ? 'Antigravity · Fixture Agy' : 'Grok fixture',
            protocol: 'native-harness',
            capabilities: { text: true, streaming: true, tools: true },
          },
        ]);
      }
    });
  }
}

test('provider imports before server without an ESM initialization cycle', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    "await import('./plugins/multi-core/src/gateway/provider.ts'); await import('./plugins/multi-core/src/gateway/server.ts'); console.log('imports ok')",
  ]);
  assert.equal(stdout.trim(), 'imports ok');
  assert.equal(stderr, '');
});

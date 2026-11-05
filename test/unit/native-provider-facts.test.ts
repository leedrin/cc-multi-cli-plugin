import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  isHarnessModel as forwardedHarness,
  isHarnessProvider as forwardedHarnessProvider,
  providerOf as forwardedProviderOf,
} from '../../plugins/multi-core/hooks/provider.ts';
import {
  isHarnessModel,
  isHarnessProvider,
  isProviderWorker,
  PROVIDER_FACTS,
  providerOf,
} from '../../plugins/multi-core/src/gateway/provider-facts.ts';
import { isProviderWorker as forwardedWorker } from '../../plugins/multi-core/src/gateway/provider-workers.ts';

const root = process.cwd();
const hooks = path.join(root, 'plugins/multi-core/hooks');
const hostFreeSrc = new Set([
  'plugins/multi-core/src/gateway/model-identity.ts',
  'plugins/multi-core/src/gateway/provider-facts.ts',
  'plugins/multi-core/src/gateway/provider-workers.ts',
]);

// Does not handle dynamic paths constructed by string concatenation.
function moduleSpecifiers(source: string): string[] {
  const uncommented = source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith('/') ? ' ' : token),
  );
  const dependencies =
    /\b(?:import\s*(?:\(\s*)?|(?:import|export)\s+[^;'"`]*?\bfrom\s*)(['"])([^'"\r\n]+)\1/g;
  return [...uncommented.matchAll(dependencies)].map((match) => match[2]);
}

function validateDependencies(file: string, source: string, hostFree: boolean): string[] {
  const targets: string[] = [];
  for (const specifier of moduleSpecifiers(source)) {
    if (hostFree) {
      assert.ok(!specifier.startsWith('node:'), `${file} depends on host module ${specifier}`);
    }
    if (!specifier.startsWith('.')) {
      continue;
    }
    const target = path.resolve(root, path.dirname(file), specifier);
    const relative = path.relative(root, target).replaceAll('\\', '/');
    if (hostFree || relative.includes('/src/')) {
      assert.ok(hostFreeSrc.has(relative), `${file} depends on non-host-free ${relative}`);
      targets.push(relative);
    }
  }
  return targets;
}

async function validateHostFreeClosure(
  readSource: (file: string) => Promise<string>,
): Promise<void> {
  const pending = [...hostFreeSrc];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    pending.push(...validateDependencies(file, await readSource(file), true));
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(file) : [file];
    }),
  );
  return nested.flat();
}

test('provider facts cover current and planned providers with derived helpers', () => {
  assert.deepEqual(
    PROVIDER_FACTS.map(({ id, plugin, kind, worker }) => [id, plugin, kind, worker]),
    [
      ['openai', 'openai', 'direct', 'multi-openai'],
      ['zen', 'zen', 'direct', 'multi-zen'],
      ['cursor', 'cursor', 'harness', 'multi-cursor'],
      ['antigravity', 'antigravity', 'harness', 'multi-antigravity'],
      ['grok', 'grok', 'harness', 'multi-grok'],
      ['deepseek', 'pi', 'direct', 'multi-deepseek'],
      ['zai', 'pi', 'direct', 'multi-zai'],
      ['zai-coding-cn', 'pi', 'direct', 'multi-zai-coding-cn'],
      ['strata', 'pi', 'direct', 'multi-strata'],
    ],
  );
  assert.deepEqual(PROVIDER_FACTS.find(({ id }) => id === 'zai')?.credentialEnv, ['ZAI_API_KEY']);
  assert.deepEqual(PROVIDER_FACTS.find(({ id }) => id === 'zai-coding-cn')?.credentialEnv, [
    'ZAI_CODING_CN_API_KEY',
  ]);
  assert.equal(isProviderWorker('multi-zai-coding-cn'), true);
  assert.equal(isProviderWorker('multi-unknown'), false);
  assert.equal(isHarnessProvider('cursor'), true);
  assert.equal(isHarnessProvider('deepseek'), false);
  assert.equal(isHarnessModel('multi/grok/model'), true);
  assert.equal(isHarnessModel('multi/deepseek/model'), false);
  assert.equal(providerOf('multi/zai-coding-cn/model/nested'), 'zai-coding-cn');
  assert.equal(providerOf('multi/unknown/model'), undefined);
  assert.equal(forwardedWorker('multi-zai-coding-cn'), true);
  assert.equal(forwardedHarness('multi/antigravity/model'), true);
  assert.equal(forwardedHarnessProvider('grok'), true);
  assert.equal(forwardedProviderOf('multi/deepseek/model'), 'deepseek');
});

test('all pi worker names are reserved independently of plugin installation', () => {
  for (const worker of ['multi-deepseek', 'multi-zai', 'multi-zai-coding-cn', 'multi-strata']) {
    assert.equal(isProviderWorker(worker), true, worker);
  }
  assert.equal(isProviderWorker('multi-unknown'), false);
});

test('harness model matching preserves the legacy provider prefix semantics', () => {
  const legacyIsHarnessModel = (model: string | undefined) =>
    Boolean(
      model?.startsWith('multi/cursor/') ||
        model?.startsWith('multi/antigravity/') ||
        model?.startsWith('multi/grok/'),
    );
  const cases = [
    'multi/cursor/',
    'multi/antigravity/',
    'multi/grok/',
    'multi/cursor/a\nb',
    'multi/antigravity/a\nb',
    'multi/grok/a\nb',
    'plain-model',
    'multi/cursor/model/nested',
    'multi/cursor',
    'multi/cursorx/a',
  ];
  for (const model of cases) {
    assert.equal(isHarnessModel(model), legacyIsHarnessModel(model), model);
  }
  assert.equal(isHarnessModel(undefined), legacyIsHarnessModel(undefined));
});

test('module dependency extraction covers import and export forms with either quote', () => {
  const forms = [
    'import x from MODULE;',
    'import { a } from MODULE;',
    'import type { A } from MODULE;',
    'import type A from MODULE;',
    'import {\n a,\n b,\n} from MODULE;',
    'import MODULE;',
    'export { a } from MODULE;',
    'export * from MODULE;',
    'export * as n from MODULE;',
    'void import(MODULE);',
  ];
  for (const form of forms) {
    for (const quote of ["'", '"']) {
      const source = form.replace('MODULE', `${quote}module-name${quote}`);
      assert.deepEqual(moduleSpecifiers(source), ['module-name'], source);
    }
  }
});

test('module dependency extraction ignores line and block comments', () => {
  assert.deepEqual(
    moduleSpecifiers(`// import 'ignored-line';
/* export { a } from 'ignored-block';
import('ignored-dynamic'); */
import /* comment */ { a } from 'kept';`),
    ['kept'],
  );
});

test('dependency validation rejects hook side-effect imports outside the whitelist', () => {
  assert.throws(
    () =>
      validateDependencies(
        'plugins/multi-core/hooks/fixture.ts',
        "import '../src/gateway/server.ts';",
        false,
      ),
    /non-host-free .*server\.ts/,
  );
});

test('host-free dependency closure rejects host and non-whitelisted src dependencies', async () => {
  for (const source of [
    "export { readFile } from 'node:fs';",
    "void import('node:fs');",
    "import 'node:fs';",
    "export * from './server.ts';",
    "import './server.ts';",
  ]) {
    const sources = new Map([
      [
        'plugins/multi-core/src/gateway/provider-workers.ts',
        "export * from './provider-facts.ts';",
      ],
      ['plugins/multi-core/src/gateway/provider-facts.ts', "import './model-identity.ts';"],
      ['plugins/multi-core/src/gateway/model-identity.ts', source],
    ]);
    await assert.rejects(
      validateHostFreeClosure(async (file) => {
        const fixture = sources.get(file);
        assert.notEqual(fixture, undefined, file);
        return fixture ?? '';
      }),
      /host module node:fs|non-host-free .*server\.ts/,
      source,
    );
  }
});

test('host-free dependency closure accepts whitelist cycles and checks each file once', async () => {
  const visited: string[] = [];
  await validateHostFreeClosure(async (file) => {
    visited.push(file);
    return "export * from './provider-facts.ts';";
  });
  assert.deepEqual(visited.toSorted(), [...hostFreeSrc].toSorted());
});

test('provider facts are host-free and hooks import src only from host-free modules', async () => {
  await validateHostFreeClosure((file) => readFile(path.join(root, file), 'utf8'));
  for (const file of await filesUnder(hooks)) {
    const source = await readFile(file, 'utf8');
    validateDependencies(path.relative(root, file), source, false);
  }
});

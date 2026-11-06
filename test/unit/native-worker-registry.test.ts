import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAntigravityModels } from '../../plugins/multi-antigravity/src/models.ts';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import { executableInvocation } from '../../plugins/multi-core/src/gateway/executable.ts';
import { buildWorkerCatalog } from '../../plugins/multi-core/src/gateway/worker-catalog.ts';
import {
  checkLauncherArgumentLimit,
  gatewayEnvironment,
  launcherArguments,
  pickerRowsForProviders,
  pickerSettings,
  workerCatalog,
  workerDefinitions,
} from '../../plugins/multi-core/src/launcher.ts';
import { cursorModelOptions } from '../../plugins/multi-cursor/src/models.ts';
import { parseGrokModels } from '../../plugins/multi-grok/src/models.ts';
import { MODELS } from '../../plugins/multi-openai/src/models.ts';
import { PI_MODELS_BY_PROVIDER, toPiModelDescriptors } from '../../plugins/multi-pi/src/catalog.ts';
import { zenModelOptions } from '../../plugins/multi-zen/src/models.ts';

test('worker catalog derives provider ids and labels from provider facts', () => {
  const catalog = buildWorkerCatalog([{ model: 'multi/deepseek/deepseek-v4' }]);
  assert.deepEqual(Object.keys(catalog), ['multi-deepseek']);
  assert.equal(catalog['multi-deepseek'].provider, 'deepseek');
  assert.equal(catalog['multi-deepseek'].label, 'DeepSeek');
});

test('worker definitions reject a harness descriptor without a runs description', () => {
  const catalog = buildWorkerCatalog([{ model: 'multi/cursor/composer-2.5' }]);
  const registry = createBuiltinRegistry();
  const cursor = registry.get('cursor');
  assert.ok(cursor);
  const runs = cursor.runs;
  cursor.runs = undefined;
  try {
    assert.throws(
      () => workerDefinitions(catalog, registry),
      /Harness provider cursor is missing a runs description/,
    );
  } finally {
    cursor.runs = runs;
  }
});

test('picker uses the launch availability set, rejects extras, and preserves/extends row order', () => {
  assert.throws(
    () => pickerSettings(false, [], false, [], [], false, ['deepseek']),
    /Picker provider deepseek has no row builder/,
  );
  const original = pickerSettings(true, [], true, [], [], true).modelPicker.options;
  const originalBuilders = {
    openai: () => original.filter(({ model }) => model.startsWith('multi/openai/')),
    zen: () => original.filter(({ model }) => model.startsWith('multi/zen/')),
  };
  assert.deepEqual(pickerRowsForProviders(['openai', 'zen'], originalBuilders), original);
  const builders = {
    openai: () => [
      { model: 'multi/openai/test', label: 'OpenAI', description: 'openai', behavesAs: 'o' },
    ],
    cursor: () => [
      { model: 'multi/cursor/test', label: 'Cursor', description: 'cursor', behavesAs: 'c' },
    ],
    antigravity: () => [
      { model: 'multi/antigravity/test', label: 'Antigravity', description: 'agy', behavesAs: 'a' },
    ],
    grok: () => [{ model: 'multi/grok/test', label: 'Grok', description: 'grok', behavesAs: 'g' }],
    zen: () => [{ model: 'multi/zen/test', label: 'Zen', description: 'zen', behavesAs: 'z' }],
    deepseek: () => [
      { model: 'multi/deepseek/test', label: 'DeepSeek', description: 'test', behavesAs: 'd' },
    ],
  };
  const legacy = pickerRowsForProviders(
    ['openai', 'cursor', 'antigravity', 'grok', 'zen'],
    builders,
  );
  const rows = pickerRowsForProviders(
    ['deepseek', 'zen', 'grok', 'openai', 'antigravity', 'cursor'],
    builders,
  );
  assert.deepEqual(rows.slice(0, legacy.length), legacy);
  assert.deepEqual(rows.at(-1), builders.deepseek()[0]);
});

test('Pi direct workers retain Claude Code tools and direct runs text', () => {
  const providers = ['deepseek', 'zai', 'zai-coding-cn', 'strata'];
  const rows = providers.map((provider) => ({ model: `multi/${provider}/model` }));
  const agents = workerDefinitions(buildWorkerCatalog(rows));
  for (const provider of providers) {
    const definition = agents[`multi-${provider}`];
    assert.deepEqual(definition.tools, ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
    assert.match(definition.description, /Claude Code's tools/);
  }
});

test('real provider worker catalogs fit the Windows cmd.exe argument budget', () => {
  const cursorCatalog = [
    'gemini-3.8-flash',
    'composer-2',
    'claude-fable-5-1',
    'default',
    'gpt-5.6-sol',
    'grok-4.7',
    'grok-4.6',
    'composer-2.5',
  ].map((id) => ({ id, displayName: id }));
  const cursorRows = cursorModelOptions(cursorCatalog);
  const antigravity = parseAntigravityModels(
    [
      'gemini-3.8-flash-low\tGemini Low',
      'gemini-3.8-flash-high\tGemini High',
      'claude-sonnet-4-6\tSonnet',
      'gemini-low\tGemini (Low)',
      'gemini-high\tGemini (High)',
      'gemini-medium\tGemini (Medium)',
      'sonnet-thinking\tSonnet Thinking',
      'single-low\tSingle Low',
    ].join('\n'),
  );
  const grok = parseGrokModels('  * grok-4.6 (default)\n  - grok-4.5\n');
  const rows = [
    ...Object.values(MODELS).map((model) => ({ model: `multi/openai/${model}` })),
    ...zenModelOptions().map(({ model }) => ({ model })),
    ...cursorRows.map(({ model }) => ({ model })),
    ...antigravity.map(({ model }) => ({ model })),
    ...grok.map(({ model }) => ({ model })),
    ...Object.entries(PI_MODELS_BY_PROVIDER).flatMap(([provider, models]) =>
      toPiModelDescriptors(models, provider as 'deepseek' | 'zai' | 'zai-coding-cn' | 'strata').map(
        ({ identity }) => ({ model: identity.routeId }),
      ),
    ),
  ];
  const agents = workerDefinitions(workerCatalog(rows, grok));
  const args = launcherArguments(
    [],
    'C:\\Users\\user\\AppData\\Local\\Temp\\settings.json',
    JSON.stringify(agents),
    { permissions: {}, multiCoreEnabled: true },
    'C:\\multi-plugin',
  );
  assert.ok(args.includes('--settings'));
  assert.ok(args.includes('--agents'));
  assert.ok(args.includes(JSON.stringify(agents)));
  const invocation = executableInvocation(
    'C:\\Program Files\\Claude\\claude.exe',
    args,
    'win32',
    {},
  );
  const commandLength = [invocation.command, ...invocation.args].join(' ').length;
  assert.ok(commandLength <= 8000, `Windows cmd.exe argument length was ${commandLength}`);
  assert.doesNotThrow(() =>
    checkLauncherArgumentLimit(agents, { ...invocation, viaComSpec: true }, 'claude.exe', 'win32'),
  );
});

test('gateway removes descriptor credentials and preserves unrelated variables', () => {
  const key = 'OPENCODE_API_KEY';
  const preserved = 'T020_UNRELATED_ENV';
  const previousKey = process.env[key];
  const previousPreserved = process.env[preserved];
  process.env[key] = 'secret-fixture';
  process.env[preserved] = 'retained';
  try {
    const env = gatewayEnvironment(1234, 'fixture-token', false);
    assert.equal(env[key], undefined);
    assert.equal(env[preserved], 'retained');
  } finally {
    if (previousKey === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousKey;
    }
    if (previousPreserved === undefined) {
      delete process.env[preserved];
    } else {
      process.env[preserved] = previousPreserved;
    }
  }
});

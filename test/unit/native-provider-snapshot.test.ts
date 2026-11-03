import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildWorkerCatalog,
  type WorkerCatalog,
} from '../../plugins/multi-core/src/gateway/worker-catalog.ts';
import { cursorModelOptions, cursorSelection } from '../../plugins/multi-cursor/src/models.ts';
import {
  assertCursorClaudeSettings,
  cursorPermissionPolicy,
} from '../../plugins/multi-cursor/src/permissions.ts';
import { removeTemporary } from '../temporary.ts';

const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);

function windowsHome(root: string): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') {
    return {};
  }
  return {
    USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
  };
}

async function writeClaudeFixture(bin: string): Promise<void> {
  const source = `const fs=require('node:fs');const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('2.1.272');process.exit(0)}
if(args[0]==='auth'){console.log('{"loggedIn":false}');process.exit(1)}
if(args.includes('plugin')&&args.includes('list')){console.log('[]');process.exit(0)}
const settings=JSON.parse(fs.readFileSync(args[args.indexOf('--settings')+1],'utf8'));
console.log(JSON.stringify({settings,args,models:args.filter(x=>x.startsWith('multi/'))}));
`;
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'claude-fixture.js'), source);
    await writeFile(
      path.join(bin, 'claude.cmd'),
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\claude-fixture.js" %*\r\n`,
    );
    return;
  }
  await writeFile(path.join(bin, 'claude'), `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
}

async function launchWithPicker(root: string, savedModel?: string) {
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeClaudeFixture(bin);
  const fakeCursor = path.join(root, 'cursor-sdk.mjs');
  await writeFile(
    fakeCursor,
    `export const getDefaultSdkAuthPath=()=>'';\nexport const Cursor={auth:{status:async()=>({status:'logged-in'})},models:{list:async()=>[{\n      id:'composer-2.5',displayName:'Composer 2.5',variants:[{displayName:'Standard',isDefault:true,params:[{id:'fast',value:'false'}]}]\n    }]}};\n`,
  );
  const fetchStub = path.join(root, 'fetch-stub.mjs');
  await writeFile(
    fetchStub,
    `globalThis.fetch=async()=>new Response(JSON.stringify({models:[]}));\n`,
  );
  const loader = path.join(root, 'cursor-loader.mjs');
  await writeFile(
    loader,
    `import {pathToFileURL} from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@cursor/sdk') return {url:pathToFileURL(process.env.MULTI_TEST_CURSOR_SDK).href,shortCircuit:true};
  return nextResolve(specifier,context);
}\n`,
  );
  const claudeSettings = path.join(root, 'claude');
  await mkdir(claudeSettings, { recursive: true });
  const codexHome = path.join(root, 'codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fixture', account_id: 'fixture' },
    }),
  );
  const agy = process.platform === 'win32' ? path.join(bin, 'agy.cmd') : path.join(bin, 'agy');
  const agySource = `if(process.argv[2] !== 'models') process.exit(9); console.log('gemini-3.8-flash\tGemini 3.8 Flash');`;
  if (process.platform === 'win32') {
    await writeFile(path.join(bin, 'agy-fixture.js'), agySource);
    await writeFile(
      agy,
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\agy-fixture.js" %*\r\n`,
    );
  } else {
    await writeFile(agy, `#!/usr/bin/env node\n${agySource}`, { mode: 0o755 });
  }
  if (savedModel !== undefined) {
    await writeFile(
      path.join(claudeSettings, 'settings.json'),
      JSON.stringify({ model: savedModel }),
    );
  }
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      pathToFileURL(fetchStub).href,
      '--experimental-loader',
      pathToFileURL(loader).href,
      launcher,
    ],
    {
      cwd: root,
      timeout: 30000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        ...(process.platform === 'win32'
          ? {
              SystemRoot: process.env.SystemRoot,
              COMSPEC: process.env.COMSPEC,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
            }
          : {}),
        HOME: root,
        ...windowsHome(root),
        CLAUDE_CONFIG_DIR: claudeSettings,
        CODEX_HOME: codexHome,
        MULTI_TEST_CURSOR_SDK: fakeCursor,
        CURSOR_API_KEY: 'fixture',
        OPENCODE_API_KEY: 'fixture',
        MULTI_ANTIGRAVITY: '1',
        MULTI_ENABLED_PROVIDERS: 'openai,cursor,zen,antigravity',
        ...(savedModel === undefined ? {} : { MULTI_MODELS: 'all' }),
      },
    },
  );
  return JSON.parse(stdout) as {
    settings: {
      modelPicker: {
        options: { model: string; label: string; description: string; behavesAs: string }[];
      };
    };
    args: string[];
    models: string[];
  };
}

test('launcher keeps complete OpenAI, Zen, Cursor and tagged picker rows', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), `provider-snapshot-${crypto.randomUUID()}-`));
  t.after(() => removeTemporary(root));
  const result = await launchWithPicker(root);
  const rows = result.settings.modelPicker.options;
  assert.deepEqual(rows, [
    ...[
      ['gpt-6.1-sol', 'multi/openai/gpt-6.1-sol'],
      ['gpt-6-astra', 'multi/openai/gpt-6-astra'],
      ['gpt-6.1-terra', 'multi/openai/gpt-6.1-terra'],
      ['gpt-6-luna', 'multi/openai/gpt-6-luna'],
    ].map(([label, model]) => ({
      model,
      label,
      description: 'OpenAI subscription · native Claude Code harness',
      behavesAs: 'claude-sonnet-4-6',
    })),
    {
      model: 'multi/cursor/composer-2.5',
      label: 'Composer 2.5 via Cursor',
      description: 'Composer 2.5 via Cursor',
      behavesAs: 'claude-haiku-4-5',
    },
    {
      model: 'multi/antigravity/gemini-3.8-flash[1m]',
      label: 'Antigravity · Gemini 3.8 Flash',
      behavesAs: 'claude-sonnet-4-6',
      description: 'Native Antigravity CLI',
    },
    {
      model: 'multi/zen/deepseek-v4.1-flash',
      label: 'Zen · DeepSeek V4.1 Flash',
      behavesAs: 'claude-haiku-4-5',
      description: 'Zen API billing · Claude tools · native reasoning; /effort not applicable',
    },
    {
      model: 'multi/zen/kimi-k3',
      label: 'Zen · Kimi K3',
      behavesAs: 'claude-haiku-4-5',
      description: 'Zen API billing · Claude tools · native reasoning; /effort not applicable',
    },
    {
      model: 'multi/zen/glm-5.3',
      label: 'Zen · GLM-5.3',
      behavesAs: 'claude-haiku-4-5',
      description: 'Zen API billing · Claude tools · native reasoning; /effort not applicable',
    },
    {
      model: 'multi/zen/glm-5.3-flash',
      label: 'Zen · GLM-5.3-Flash',
      behavesAs: 'claude-haiku-4-5',
      description: 'Zen API billing · Claude tools · native reasoning; /effort not applicable',
    },
    {
      model: 'multi/zen/muse-spark-1.3',
      label: 'Zen · Muse Spark 1.3',
      behavesAs: 'claude-sonnet-4-6',
      description: 'Zen API billing · Claude tools',
    },
  ]);
});

test('Cursor permission policy and Claude settings retain accepted and rejected outcomes', () => {
  assert.throws(
    () => cursorPermissionPolicy({ permissionMode: 'default' as never }),
    /selected mode is unsupported/,
  );
  assert.deepEqual(cursorPermissionPolicy({ permissionMode: 'plan' }), {
    mode: 'plan',
    tools: ['read', 'grep', 'glob', 'ls'],
    autoReview: true,
    identity: '["plan",["read","grep","glob","ls"],true]',
  });
  assert.deepEqual(cursorPermissionPolicy({ permissionMode: 'auto' }), {
    mode: 'agent',
    tools: ['shell', 'read', 'edit', 'grep', 'glob', 'ls'],
    autoReview: true,
    identity: '["agent",["shell","read","edit","grep","glob","ls"],true]',
  });
  assert.doesNotThrow(() => assertCursorClaudeSettings({ permissions: { allow: ['Read'] } }));
  assert.throws(
    () => assertCursorClaudeSettings({ permissions: { deny: ['Bash(rm:*)'] } }),
    /cannot enforce Claude tool rule Bash\(rm:\*\)/,
  );
});

test('Cursor route percent-encodes slash-containing model IDs', () => {
  const options = cursorModelOptions([{ id: 'org/model', displayName: 'Org Model' }]);
  assert.deepEqual(
    options.map(({ model, label, description, selection }) => ({
      model,
      label,
      description,
      selection,
    })),
    [
      {
        model: 'multi/cursor/org%2Fmodel',
        label: 'Org Model via Cursor',
        description: 'Org Model via Cursor',
        selection: { id: 'org/model' },
      },
    ],
  );
});

test('hyphenated provider routes never enter existing worker model lists', () => {
  const catalog: WorkerCatalog = {
    ...buildWorkerCatalog([
      { model: 'multi/openai/gpt-6-luna' },
      { model: 'multi/zen/kimi-k3' },
      { model: 'multi/cursor/composer-2.5' },
      { model: 'multi/antigravity/gemini-3.8-flash[1m]' },
      { model: 'multi/grok/grok-4.7' },
      { model: 'multi/zai-coding-cn/x' },
      { model: 'multi/zai/x' },
    ]),
    'multi-zai': {
      type: 'multi-zai',
      provider: 'zen',
      label: 'Z.AI',
      models: [{ id: 'x', model: 'multi/zai/x' }],
      defaultId: 'x',
    },
  };
  const existingWorkerTypes = [
    'multi-openai',
    'multi-zen',
    'multi-cursor',
    'multi-antigravity',
    'multi-grok',
  ] as const;
  assert.deepEqual(
    Object.fromEntries(
      existingWorkerTypes.map((type) => [
        type,
        catalog[type]?.models.map(({ model }) => model) ?? [],
      ]),
    ),
    {
      'multi-openai': ['multi/openai/gpt-6-luna'],
      'multi-zen': ['multi/zen/kimi-k3'],
      'multi-cursor': ['multi/cursor/composer-2.5'],
      'multi-antigravity': ['multi/antigravity/gemini-3.8-flash[1m]'],
      'multi-grok': ['multi/grok/grok-4.7'],
    },
  );
});

test('Cursor presets expand and remain excluded from selection defaults and worker catalog', () => {
  const options = cursorModelOptions([
    {
      id: 'composer-test',
      displayName: 'Composer Test',
      parameters: [{ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }],
      variants: [
        { displayName: 'Low', isDefault: true, params: [{ id: 'effort', value: 'low' }] },
        { displayName: 'High', params: [{ id: 'effort', value: 'high' }] },
      ],
    },
  ]);
  assert.deepEqual(
    options.map(({ model }) => model),
    [
      'multi/cursor/composer-test',
      'multi/cursor/composer-test/effort=low',
      'multi/cursor/composer-test/effort=high',
    ],
  );
  assert.deepEqual(cursorSelection(options[0], 'high'), {
    id: 'composer-test',
    params: [{ id: 'effort', value: 'high' }],
  });
  assert.deepEqual(cursorSelection(options[2], 'low'), {
    id: 'composer-test',
    params: [{ id: 'effort', value: 'high' }],
  });
  const catalog = buildWorkerCatalog(options.map(({ model }) => ({ model })));
  assert.deepEqual(catalog['multi-cursor'].models, [
    { id: 'composer-test', model: 'multi/cursor/composer-test' },
  ]);
});

test('saved selections with and without [1m] are passed as their picker spelling', async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), `provider-snapshot-saved-${crypto.randomUUID()}-`),
  );
  t.after(() => removeTemporary(root));
  const withTag = await launchWithPicker(root, 'multi/antigravity/gemini-3.8-flash[1m]');
  assert.deepEqual(
    withTag.args.filter((arg) => arg === '--model'),
    [],
  );
  const withoutTag = await launchWithPicker(root, 'multi/antigravity/gemini-3.8-flash');
  const modelIndex = withoutTag.args.lastIndexOf('--model');
  assert.equal(withoutTag.args[modelIndex + 1], 'multi/antigravity/gemini-3.8-flash[1m]');
});

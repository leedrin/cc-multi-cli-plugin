import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { createPiFetch, openPiStream } from '../../plugins/multi-pi/src/backend.ts';
import { PI_DEEPSEEK_MODELS, PI_MODELS_BY_PROVIDER } from '../../plugins/multi-pi/src/catalog.ts';
import { discoverPiModels } from '../../plugins/multi-pi/src/provider.ts';
import { decodePiSignature } from '../../plugins/multi-pi/src/signature.ts';

const fakeKey = 'test-only-DEEPSEEK-FAKE-KEY';
const model = PI_DEEPSEEK_MODELS[0];
const context = normalizeContext({ messages: [] });
const request = (overrides: Partial<Parameters<typeof openPiStream>[0]> = {}) => ({
  providerId: 'deepseek' as const,
  model,
  context,
  apiKey: fakeKey,
  label: 'DeepSeek',
  ...overrides,
});
const successfulFetch: typeof globalThis.fetch = async () =>
  new Response('data: [DONE]\n\n', { status: 200 });

test('Pi keyless runtime discovery does not load backend or pi-ai', () => {
  const providerUrl = new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { discoverPiModels, bindPiProviders } = await import(${JSON.stringify(providerUrl)});
    const models = await discoverPiModels({ cwd: '.', env: {}, explicit: true, log: () => {} });
    if (models.length !== 2) throw new Error('Unexpected keyless model count');
    const strata = bindPiProviders().find(({ id }) => id === 'strata');
    const ctx = { cwd: '.', env: { STRATA_API_KEY: 'fake-disabled-key' }, explicit: true, log: () => {} };
    if ((await strata.availability(ctx)).available) throw new Error('Unconfigured Strata available');
    if ((await strata.discoverModels(ctx)).length) throw new Error('Unconfigured Strata discovered');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.error, undefined);
});

test('only ZAI key loads only the ZAI provider in a child process', () => {
  const launcherUrl = new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-zai-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { createLaunchRegistry, discoverLaunchProviders } = await import(${JSON.stringify(launcherUrl)});
    const found = await discoverLaunchProviders(createLaunchRegistry, ['zai'], {
      env: { ZAI_API_KEY: 'fake-zai-key' }, platform: 'linux'
    });
    if (found.genericModels.zai?.length !== 2) throw new Error('ZAI discovery did not load its models');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  assert.equal(result.error, undefined);
  assert.match(result.stderr, /PI_PROVIDER_LOADS:/);
  assert.match(result.stderr, /zai\.js/);
  assert.doesNotMatch(result.stderr, /all\.js|deepseek\.js|zai-coding-cn\.js/);
});

test('keyless DeepSeek ignores Pi auth files under isolated HOME and USERPROFILE', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'multi-deepseek-home-'));
  const piDir = path.join(home, '.pi', 'agent');
  const marker = path.join(home, 'SHOULD_NOT_RUN');
  const payload = Buffer.from(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  ).toString('base64');
  const command = `"${process.execPath}" -e "eval(Buffer.from('${payload}', 'base64').toString())"`;
  await mkdir(piDir, { recursive: true });
  await writeFile(
    path.join(piDir, 'models.json'),
    JSON.stringify({
      providers: { deepseek: { apiKey: `!${command}` } },
      canary: 'DEEPSEEK_FILE_KEY_CANARY',
    }),
  );
  await writeFile(
    path.join(piDir, 'auth.json'),
    JSON.stringify({ deepseek: { type: 'api', key: `!${command}` } }),
  );
  try {
    const script = `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { fileURLToPath } from 'node:url';
      const targets = [${JSON.stringify(path.join(piDir, 'models.json'))}, ${JSON.stringify(path.join(piDir, 'auth.json'))}].map(value => value.toLowerCase());
      const reads = [];
      const record = original => function(file, ...args) {
        const name = file instanceof URL ? fileURLToPath(file) : file;
        const resolved = typeof name === 'string' || Buffer.isBuffer(name) ? path.resolve(String(name)).toLowerCase() : '';
        if (targets.includes(resolved)) reads.push(resolved);
        return original.call(this, file, ...args);
      };
      for (const method of ['readFile', 'readFileSync', 'existsSync', 'openSync', 'open', 'createReadStream']) fs[method] = record(fs[method]);
      fsp.readFile = record(fsp.readFile);
      fsp.open = record(fsp.open);
      syncBuiltinESMExports();
      const { bindPiProviders } = await import(${JSON.stringify(new URL('../../plugins/multi-pi/src/provider.ts', import.meta.url).href)});
      const provider = bindPiProviders().find(({ id }) => id === 'deepseek');
      if (!provider) throw new Error('DeepSeek descriptor missing');
      const context = { cwd: process.cwd(), env: {}, explicit: true, log: () => {} };
      if ((await provider.availability(context)).available) throw new Error('file credential enabled DeepSeek');
      await provider.discoverModels(context);
      if (reads.length) throw new Error('Pi auth file reads: ' + reads.join(','));
      process.stdout.write('KEYLESS_DEEPSEEK_UNAVAILABLE reads=0 marker=' + (fs.existsSync(${JSON.stringify(marker)}) ? 'true' : 'false'));
    `;
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--input-type=module', '-e', script],
      {
        cwd: home,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /KEYLESS_DEEPSEEK_UNAVAILABLE reads=0 marker=false/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /DEEPSEEK_(?:FILE_KEY|AUTH)_CANARY/);
    await assert.rejects(access(marker));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Strata backend confines imports, avoids home Pi files, and sends the curated request', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'multi-strata-home-'));
  const piDir = path.join(home, '.pi', 'agent');
  const marker = path.join(home, 'SHOULD_NOT_RUN');
  const payload = Buffer.from(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
  ).toString('base64');
  const command = `"${process.execPath}" -e "eval(Buffer.from('${payload}', 'base64').toString())"`;
  await mkdir(piDir, { recursive: true });
  await writeFile(
    path.join(piDir, 'models.json'),
    JSON.stringify({
      providers: {
        strata: { baseUrl: 'https://strata.fake.invalid/v1', apiKey: `!${command}`, models: [] },
      },
      canary: 'CANARY_STRATA_MODELS_KEY',
    }),
  );
  await writeFile(
    path.join(piDir, 'auth.json'),
    JSON.stringify({ strata: { type: 'api_key', key: `!${command}` } }),
  );
  try {
    const loaderUrl = new URL(
      './fixtures/native-pi-strata-import-boundary-loader.mjs',
      import.meta.url,
    ).href;
    const backendUrl = new URL('../../plugins/multi-pi/src/backend.ts', import.meta.url).href;
    const catalogUrl = new URL('../../plugins/multi-pi/src/catalog.ts', import.meta.url).href;
    const transcriptUrl = import.meta.resolve('@earendil-works/pi-ai/utils/transcript');
    const script = `
      import fs from 'node:fs';
      import fsp from 'node:fs/promises';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { fileURLToPath } from 'node:url';
      const reads = [];
      const piFiles = [${JSON.stringify(path.join(piDir, 'models.json'))}, ${JSON.stringify(path.join(piDir, 'auth.json'))}];
      const recordsPiRead = (original) => function(file, ...args) {
        const name = file instanceof URL ? fileURLToPath(file) : file;
        const resolved = typeof name === 'string' || Buffer.isBuffer(name) ? path.resolve(String(name)).toLowerCase() : '';
        if (piFiles.some((target) => resolved === target.toLowerCase())) reads.push(resolved);
        return original.call(this, file, ...args);
      };
      for (const method of ['readFile', 'readFileSync', 'existsSync', 'openSync', 'open', 'createReadStream']) {
        fs[method] = recordsPiRead(fs[method]);
      }
      fsp.readFile = recordsPiRead(fsp.readFile);
      fsp.open = recordsPiRead(fsp.open);
      syncBuiltinESMExports();
      const { createLaunchRegistry, discoverLaunchProviders } = await import(${JSON.stringify(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url).href)});
      const found = await discoverLaunchProviders(createLaunchRegistry, ['strata'], {
        env: { MULTI_STRATA_BASE_URL: 'http://127.0.0.1:8321/v1' }, platform: 'linux'
      });
      if (found.genericModels.strata?.length !== 1) throw new Error('Strata discovery missing');
      const [{ openPiStream }, { PI_MODELS_BY_PROVIDER }, { normalizeContext }] = await Promise.all([
        import(${JSON.stringify(backendUrl)}),
        import(${JSON.stringify(catalogUrl)}),
        import(${JSON.stringify(transcriptUrl)})
      ]);
      const model = PI_MODELS_BY_PROVIDER.strata[0];
      let target = '';
      let headers;
      let sentBody;
      const fetch = async (input, init) => {
        target = input instanceof Request ? input.url : String(input);
        headers = new Headers(init?.headers);
        sentBody = JSON.parse(String(init?.body));
        return new Response([
          'data: ' + JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }) + '\\n\\n',
          'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n',
          'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 2 } }) + '\\n\\n',
          'data: [DONE]\\n\\n'
        ].join(''), { status: 200 });
      };
      const opened = await openPiStream({
        providerId: 'strata', model, baseUrl: 'https://strata.fake.invalid/v1',
        context: normalizeContext({ messages: [{ role: 'user', content: 'hello', timestamp: 0 }] }),
        apiKey: process.env.STRATA_API_KEY, label: 'Strata', options: { maxTokens: 32000 }, fetch
      });
      for await (const _event of opened.stream) {}
      if (reads.length) throw new Error('Unexpected Pi file reads: ' + reads.join(','));
      if (new URL(target).origin !== 'https://strata.fake.invalid') throw new Error('wrong origin ' + target);
      if (headers.get('authorization') !== 'Bearer fake-strata-key') throw new Error('wrong authorization');
      if (sentBody.max_tokens !== 32000) throw new Error('wrong max_tokens ' + JSON.stringify(sentBody));
      if ('reasoning_effort' in sentBody || 'thinking' in sentBody) throw new Error('effort leaked');
      if (sentBody.messages.some(message => message.role === 'developer')) throw new Error('developer role leaked');
      process.stdout.write('STRATA_REQUEST_OK');
    `;
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
      {
        cwd: home,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          STRATA_API_KEY: 'fake-strata-key',
        },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
    assert.match(result.stdout, /STRATA_REQUEST_OK/);
    assert.doesNotMatch(result.stderr, /PI_STRATA_FORBIDDEN_BUILTIN/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CANARY_STRATA_MODELS_KEY/);
    await assert.rejects(access(marker));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Strata launch binding drives offline SSE through the real backend and stream translator', async () => {
  const { createLaunchRegistry, discoverLaunchProviders, launcherRuntime } = await import(
    '../../plugins/multi-core/src/launcher.ts'
  );
  for (const [baseUrl, apiKey, expectedKey, reasoning] of [
    ['http://127.0.0.1:8321/v1', undefined, 'local', false],
    ['https://strata.fake.invalid/v1', 'fake-strata-key', 'fake-strata-key', false],
    ['https://strata.fake.invalid/v1', 'fake-strata-key', 'fake-strata-key', true],
  ] as const) {
    const discovery = await discoverLaunchProviders(createLaunchRegistry, ['strata'], {
      env: {
        MULTI_STRATA_BASE_URL: baseUrl,
        ...(apiKey === undefined ? {} : { STRATA_API_KEY: apiKey }),
      },
      platform: 'linux',
    });
    const runtime = launcherRuntime(
      '',
      undefined,
      {},
      { cursor: undefined, antigravity: undefined, grok: undefined },
      undefined,
      discovery.genericModels,
      createLaunchRegistry,
      undefined,
      discovery.piKeys,
      discovery.strataBaseUrl,
    );
    const descriptor = runtime.registry?.get('strata');
    assert(descriptor?.direct);
    const prepared = descriptor.direct.prepare({
      method: 'POST',
      pathname: '/v1/messages',
      body: {
        model: 'multi/strata/qwen3.8-flash-next',
        system: 'Follow the system directive.',
        max_tokens: 1234,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: 'Weather in Oslo?' }],
        tools: [
          {
            name: 'weather',
            description: 'Look up weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
      session: 'offline-strata',
      fallbackSession: 'fallback',
    });
    let target = '';
    let authorization = '';
    let sentBody: Record<string, unknown> = {};
    const opened = await prepared.open(new AbortController().signal, async (url, init) => {
      target = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      sentBody = JSON.parse(String(init?.body));
      const events = [
        ...(reasoning
          ? [
              {
                choices: [
                  { delta: { reasoning_content: 'Check the forecast.' }, finish_reason: null },
                ],
              },
            ]
          : []),
        { choices: [{ delta: { role: 'assistant', content: 'Forecast ' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'ready.' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-weather',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } },
      ];
      return new Response(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    });
    assert.equal(opened.ok, true);
    assert.equal(new URL(target).origin, new URL(baseUrl).origin);
    assert.equal(authorization, `Bearer ${expectedKey}`);
    assert.equal(sentBody.max_tokens, 1234);
    assert.equal('reasoning_effort' in sentBody, false);
    assert.equal('thinking' in sentBody, false);
    const messages = sentBody.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(
      messages.map(({ role }) => role),
      ['system', 'user'],
    );
    assert.equal(messages[0]?.content, 'Follow the system directive.');
    assert.deepEqual(sentBody.tools, [
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'Look up weather',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      },
    ]);
    if (opened.ok) {
      const notices: string[] = [];
      const result = await opened.translate(
        (type, value) => {
          if (
            type === 'content_block_delta' &&
            'delta' in value &&
            value.delta.type === 'text_delta'
          ) {
            notices.push(value.delta.text);
          }
        },
        () => {},
      );
      assert.equal(result.stop_reason, 'tool_use');
      assert(
        result.content.some((block) => block.type === 'text' && block.text === 'Forecast ready.'),
      );
      const thinking = result.content.filter((block) => block.type === 'thinking');
      assert.equal(thinking.length, reasoning ? 1 : 0);
      if (reasoning) {
        const block = thinking[0];
        assert(block?.type === 'thinking');
        assert.equal(block.thinking, 'Check the forecast.');
        assert.deepEqual(decodePiSignature(block.signature, 'multi/strata/qwen3.8-flash-next'), {
          kind: 'owned',
          payload: { thinking: 'Check the forecast.', thinkingSignature: 'reasoning_content' },
        });
        assert.deepEqual(decodePiSignature(block.signature, 'multi/deepseek/deepseek-v4-pro'), {
          kind: 'foreign',
        });
      }
      assert.deepEqual(
        result.content
          .filter(({ type }) => type === 'tool_use')
          .map((block) => (block.type === 'tool_use' ? [block.name, block.input] : [])),
        [['weather', { city: 'Oslo' }]],
      );
      assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 4 });
      assert.equal(notices.filter((text) => text.includes('does not support effort')).length, 1);
    }
    await runtime.close();
  }
});

test('Strata transport errors redact key, userinfo and query secrets', async () => {
  const canary = 'fake-key-secret userinfo-secret password-secret query-secret';
  for (const status of [undefined, 401]) {
    await assert.rejects(
      openPiStream({
        providerId: 'strata',
        model: PI_MODELS_BY_PROVIDER.strata[0],
        baseUrl: 'https://strata.fake.invalid/v1?token=query-secret',
        apiKey: 'fake-key-secret',
        label: 'Strata',
        context,
        fetch: async () => {
          if (status === undefined) {
            throw new Error(canary);
          }
          return new Response(JSON.stringify({ error: canary }), { status });
        },
      }),
      (error: Error) => {
        assert.equal(
          error.message,
          status === undefined ? 'Strata request failed.' : 'Strata returned HTTP 401.',
        );
        assert.doesNotMatch(
          error.message,
          /fake-key-secret|userinfo-secret|password-secret|query-secret/,
        );
        return true;
      },
    );
  }
});

test('ZAI import boundary rejects every other provider subpath', () => {
  const loaderUrl = new URL('./fixtures/native-pi-zai-import-boundary-loader.mjs', import.meta.url)
    .href;
  for (const provider of [
    'all',
    'deepseek',
    'zai-coding-cn',
    'openai',
    'anthropic',
    'google-vertex',
  ]) {
    const script = `await import('@earendil-works/pi-ai/providers/${provider}');`;
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `${provider} was unexpectedly allowed`);
    assert.match(result.stderr, /Unexpected Pi provider module:/);
  }
});

test('count_tokens estimates in a child process without loading the Pi backend', () => {
  const requestUrl = new URL('../../plugins/multi-pi/src/gateway-request.ts', import.meta.url).href;
  const loaderUrl = new URL('./fixtures/native-pi-import-boundary-loader.mjs', import.meta.url)
    .href;
  const script = `
    const { preparePiRequest } = await import(${JSON.stringify(requestUrl)});
    const prepared = preparePiRequest({
      method: 'POST',
      pathname: '/v1/messages/count_tokens',
      body: { model: 'multi/deepseek/deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }] },
      session: 'session', fallbackSession: 'fallback'
    }, 'fake-key');
    if (prepared.inputTokens() < 1) throw new Error('Missing local token estimate');
  `;
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--experimental-loader', loaderUrl, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 10000 },
  );
  assert.equal(result.status, 0, `${result.stdout}\\n${result.stderr}`);
  assert.equal(result.error, undefined);
});

test('Pi model discovery loads its backend only when a key is present', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return await import('../../plugins/multi-pi/src/backend.ts');
  };
  const noKey = await discoverPiModels(
    { cwd: '.', env: {}, explicit: true, log: () => {} },
    loader,
  );
  assert.equal(noKey.length, 2);
  assert.equal(calls, 0);
  await discoverPiModels(
    { cwd: '.', env: { DEEPSEEK_API_KEY: fakeKey }, explicit: true, log: () => {} },
    loader,
  );
  assert.equal(calls, 1);
});

test('each GLM backend loads only its provider and confines fetch to its own origin', async () => {
  for (const [providerId, model, expectedOrigin, label] of [
    ['zai', { ...PI_DEEPSEEK_MODELS[0], id: 'glm-5.3' }, 'https://api.z.ai', 'Z.AI'],
    [
      'zai-coding-cn',
      { ...PI_DEEPSEEK_MODELS[0], id: 'glm-5.3' },
      'https://open.bigmodel.cn',
      'Z.AI Coding (CN)',
    ],
  ] as const) {
    let target = '';
    await openPiStream({
      providerId,
      model,
      context,
      apiKey: 'fake-glm-key',
      label,
      fetch: async (input) => {
        target = input instanceof Request ? input.url : String(input);
        return new Response('data: [DONE]\\n\\n', { status: 200 });
      },
    });
    assert.equal(new URL(target).origin, expectedOrigin);
  }
});

test('each GLM origin rejects every other Pi provider origin before fetch', async () => {
  const origins = {
    deepseek: 'https://api.deepseek.com',
    zai: 'https://api.z.ai',
    'zai-coding-cn': 'https://open.bigmodel.cn',
  } as const;
  for (const [providerId, allowedOrigin] of Object.entries(origins)) {
    let calls = 0;
    const guarded = createPiFetch(
      async () => {
        calls += 1;
        return new Response(null);
      },
      allowedOrigin,
      providerId,
    );
    for (const [otherProvider, otherOrigin] of Object.entries(origins)) {
      if (otherProvider === providerId) {
        continue;
      }
      await assert.rejects(guarded(`${otherOrigin}/chat/completions`, {}), /target is not allowed/);
      assert.equal(calls, 0, `${providerId} fetch must not reach ${otherProvider}`);
    }
  }
});

test('Pi requests force redirect error and stay on DeepSeek origin', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    capturedUrl = input instanceof Request ? input.url : String(input);
    capturedInit = init;
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  await openPiStream(request({ fetch: fetchImpl }));
  assert.equal(new URL(capturedUrl).origin, 'https://api.deepseek.com');
  assert.equal(capturedInit?.redirect, 'error');

  let sent = false;
  const secureFetch = createPiFetch(async () => {
    sent = true;
    return new Response(null);
  });
  await assert.rejects(secureFetch('https://attacker.invalid/chat', {}), /target is not allowed/);
  assert.equal(sent, false);
});

test('Pi stream opens on start, preserves the first event, and sanitizes HTTP errors', async () => {
  const opened = await openPiStream(request({ fetch: successfulFetch }));
  assert.equal(opened.first.type, 'start');
  assert.equal(opened.model.id, model.id);

  for (const status of [401, 429, 500]) {
    const responseBody = 'CANARY_UPSTREAM_SECRET';
    const failedFetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: responseBody }), { status });
    await assert.rejects(openPiStream(request({ fetch: failedFetch })), (error: Error) => {
      assert.match(error.message, new RegExp(`DeepSeek returned HTTP ${status}`));
      assert.doesNotMatch(error.message, /CANARY_UPSTREAM_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
      return true;
    });
  }
});

test('Pi network failures use fixed text and do not retry', async () => {
  let calls = 0;
  const failedFetch: typeof globalThis.fetch = async () => {
    calls += 1;
    throw new Error('CANARY_NETWORK_SECRET');
  };
  await assert.rejects(openPiStream(request({ fetch: failedFetch })), (error: Error) => {
    assert.equal(error.message, 'DeepSeek request failed.');
    assert.doesNotMatch(error.message, /CANARY_NETWORK_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
    return true;
  });
  assert.equal(calls, 1);
});

test('Pi SDK debug logs never expose network or HTTP error content', async () => {
  const previous = process.env.OPENAI_LOG;
  const logged: string[] = [];
  const methods = ['debug', 'info', 'log', 'warn', 'error'] as const;
  const originals = new Map<(typeof methods)[number], typeof console.debug>();
  try {
    process.env.OPENAI_LOG = 'debug';
    for (const method of methods) {
      originals.set(method, console[method]);
      console[method] = (...args: unknown[]) => logged.push(inspect(args));
    }
    for (const [kind, responseBody] of [
      ['network', undefined],
      ['non-json', 'CANARY_BODY_SECRET'],
      ['json', JSON.stringify({ error: 'CANARY_JSON_SECRET test-only-DEEPSEEK-FAKE-KEY' })],
    ] as const) {
      let calls = 0;
      let responseBodyCancelled = false;
      const fetchImpl: typeof globalThis.fetch = async () => {
        calls += 1;
        if (kind === 'network') {
          throw new Error('CANARY_NETWORK_SECRET test-only-DEEPSEEK-FAKE-KEY');
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(responseBody));
          },
          cancel() {
            responseBodyCancelled = true;
          },
        });
        return new Response(body, {
          status: 401,
          headers: {
            'content-type': kind === 'non-json' ? 'text/plain' : 'application/json',
            'retry-after': '17',
          },
        });
      };
      const expected =
        kind === 'network' ? 'DeepSeek request failed.' : 'DeepSeek returned HTTP 401.';
      await assert.rejects(openPiStream(request({ fetch: fetchImpl })), (error: Error) => {
        assert.equal(error.message, expected);
        assert.doesNotMatch(error.message, /CANARY_|test-only-DEEPSEEK-FAKE-KEY/);
        return true;
      });
      assert.equal(calls, 1);
      if (kind !== 'network') {
        assert.equal(responseBodyCancelled, true);
      }
      assert(logged.length > 0);
      assert.doesNotMatch(logged.join(' '), /CANARY_|test-only-DEEPSEEK-FAKE-KEY/);
    }
  } finally {
    for (const method of methods) {
      const original = originals.get(method);
      if (original) {
        console[method] = original;
      }
    }
    if (previous === undefined) {
      delete process.env.OPENAI_LOG;
    } else {
      process.env.OPENAI_LOG = previous;
    }
  }
});

test('Pi cancellation aborts before fetch, while awaiting headers, and while consuming', async () => {
  const timed = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Pi cancellation timed out.')), 500);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let preAbortedCalls = 0;
  const unusedFetch: typeof globalThis.fetch = async () => {
    preAbortedCalls += 1;
    return new Response('data: [DONE]\\n\\n');
  };
  await assert.rejects(
    timed(openPiStream(request({ signal: alreadyAborted.signal, fetch: unusedFetch }))),
    (error: Error) => {
      assert.notEqual(error.message, 'Pi cancellation timed out.');
      assert.doesNotMatch(error.message, /CANARY/);
      return true;
    },
  );
  assert.equal(preAbortedCalls, 0);

  const waitingController = new AbortController();
  let waitingSignal: AbortSignal | undefined;
  let waitingCalls = 0;
  const waitingFetch: typeof globalThis.fetch = async (_input, init) => {
    waitingCalls += 1;
    waitingSignal = init?.signal ?? undefined;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('CANARY_WAITING_SECRET')), {
        once: true,
      });
    });
  };
  const waitingOpen = openPiStream(
    request({ signal: waitingController.signal, fetch: waitingFetch }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  waitingController.abort();
  await assert.rejects(timed(waitingOpen), (error: Error) => {
    assert.notEqual(error.message, 'Pi cancellation timed out.');
    assert.doesNotMatch(error.message, /CANARY_WAITING_SECRET|test-only-DEEPSEEK-FAKE-KEY/);
    return true;
  });
  assert.equal(waitingCalls, 1);
  assert.equal(waitingSignal?.aborted, true);

  const consumingController = new AbortController();
  let consumingSignal: AbortSignal | undefined;
  let consumingCalls = 0;
  let bodyCancelled = false;
  const consumingFetch: typeof globalThis.fetch = async (_input, init) => {
    consumingCalls += 1;
    consumingSignal = init?.signal ?? undefined;
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          bodyCancelled = true;
        },
      }),
      { status: 200 },
    );
  };
  const opened = await timed(
    openPiStream(request({ signal: consumingController.signal, fetch: consumingFetch })),
  );
  assert.equal(opened.first.type, 'start');
  const next = opened.stream[Symbol.asyncIterator]().next();
  consumingController.abort();
  try {
    await timed(next);
  } catch (error) {
    assert.notEqual(String(error), 'Error: Pi cancellation timed out.');
    assert.doesNotMatch(String(error), /CANARY|test-only-DEEPSEEK-FAKE-KEY/);
  }
  assert.equal(consumingCalls, 1);
  assert.equal(consumingSignal?.aborted, true);
  assert.equal(bodyCancelled, true);
});

test('Pi cache retention ignores PI_CACHE_RETENTION=long', async () => {
  const previous = process.env.PI_CACHE_RETENTION;
  const capture = async () => {
    let body: string | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      body = String(init?.body ?? '');
      return new Response('data: [DONE]\n\n', { status: 200 });
    };
    await openPiStream(request({ fetch: fetchImpl }));
    return body;
  };
  try {
    delete process.env.PI_CACHE_RETENTION;
    const shortBody = await capture();
    process.env.PI_CACHE_RETENTION = 'long';
    assert.equal(await capture(), shortBody);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CACHE_RETENTION;
    } else {
      process.env.PI_CACHE_RETENTION = previous;
    }
  }
});

test('Pi reasoning effort is included in the outgoing request', async () => {
  let body = '';
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    body = String(init?.body ?? '');
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  await openPiStream(request({ reasoningEffort: 'high', fetch: fetchImpl }));
  assert.equal(JSON.parse(body).reasoning_effort, 'high');
});

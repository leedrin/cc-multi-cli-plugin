import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  filterPiModels,
  PI_DEEPSEEK_MODELS,
  resolvePiEffort,
  toPiModelDescriptors,
} from '../../plugins/multi-pi/src/catalog.ts';

const packageCatalog: {
  'openai-completions': Record<
    string,
    {
      id: string;
      name: string;
      api: string;
      type: string;
      contextWindow: number;
      maxTokens: number;
      input: string[];
      thinkingLevelMap?: Record<string, string | null>;
    }
  >;
} = JSON.parse(
  await readFile(
    new URL(
      '../../node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('curated DeepSeek catalog matches only the pinned chat package entries', () => {
  assert.deepEqual(
    PI_DEEPSEEK_MODELS.map(({ id }) => id),
    ['deepseek-v4-pro', 'deepseek-flash'],
  );
  for (const model of PI_DEEPSEEK_MODELS) {
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.type, 'chat');
    const packaged = Object.values(packageCatalog['openai-completions']).find(
      (entry) => entry.id === model.id,
    );
    assert(packaged);
    assert.deepEqual(
      {
        id: model.id,
        name: model.name,
        api: model.api,
        type: model.type,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        thinkingLevelMap: model.thinkingLevelMap,
      },
      {
        id: packaged.id,
        name: packaged.name,
        api: packaged.api,
        type: packaged.type,
        contextWindow: packaged.contextWindow,
        maxTokens: packaged.maxTokens,
        input: packaged.input,
        thinkingLevelMap: packaged.thinkingLevelMap,
      },
    );
  }
});

test('DeepSeek effort selection defaults and maps to nearest supported levels', () => {
  const pro = PI_DEEPSEEK_MODELS[0];
  const flash = PI_DEEPSEEK_MODELS[1];
  assert.deepEqual(resolvePiEffort(pro), { effort: 'high', notice: undefined });
  assert.deepEqual(resolvePiEffort(flash, 'medium'), {
    effort: 'high',
    notice: 'DeepSeek deepseek-flash does not support effort medium; using high.',
  });
  assert.deepEqual(resolvePiEffort(pro, 'low'), {
    effort: 'high',
    notice: 'DeepSeek deepseek-v4-pro does not support effort low; using high.',
  });
  assert.deepEqual(resolvePiEffort(pro, 'xhigh'), {
    effort: 'max',
    notice: 'DeepSeek deepseek-v4-pro does not support effort xhigh; using max.',
  });
});

test('DeepSeek effort can be disabled or omitted for models without supported levels', () => {
  const pro = PI_DEEPSEEK_MODELS[0];
  assert.deepEqual(resolvePiEffort(pro, 'high', { thinkingDisabled: true }), {
    effort: undefined,
    notice: undefined,
  });
  assert.deepEqual(resolvePiEffort({ ...pro, id: 'no-effort', thinkingLevelMap: {} }, 'high'), {
    effort: undefined,
    notice: 'no-effort does not support effort; ignoring high.',
  });
  assert.throws(() => resolvePiEffort(pro, 'minimal'), /Unknown effort: minimal/);
});

test('MULTI_PI_MODELS filters by strict allowlist and rejects unknown IDs', () => {
  assert.deepEqual(
    filterPiModels(undefined).map(({ id }) => id),
    ['deepseek-v4-pro', 'deepseek-flash'],
  );
  assert.deepEqual(
    filterPiModels('').map(({ id }) => id),
    ['deepseek-v4-pro', 'deepseek-flash'],
  );
  assert.deepEqual(
    filterPiModels(' deepseek-flash, ,deepseek-flash ').map(({ id }) => id),
    ['deepseek-flash'],
  );
  assert.throws(
    () => filterPiModels('deepseek-flash,not-a-model'),
    /not-a-model.*deepseek-v4-pro.*deepseek-flash/,
  );
});

test('Pi catalog descriptors expose routing, capabilities, and supported reasoning levels', () => {
  assert.deepEqual(toPiModelDescriptors(), [
    {
      identity: {
        providerId: 'deepseek',
        modelId: 'deepseek-v4-pro',
        routeId: 'multi/deepseek/deepseek-v4-pro',
        oneMillionContext: false,
      },
      label: 'DeepSeek V4 Pro',
      protocol: 'openai-chat',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      capabilities: {
        text: true,
        streaming: true,
        tools: true,
        reasoning: true,
        images: false,
      },
      reasoning: { native: true, efforts: ['high', 'max'] },
    },
    {
      identity: {
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        routeId: 'multi/deepseek/deepseek-flash',
        oneMillionContext: false,
      },
      label: 'DeepSeek V4.1 Flash',
      protocol: 'openai-chat',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      capabilities: {
        text: true,
        streaming: true,
        tools: true,
        reasoning: true,
        images: true,
      },
      reasoning: { native: true, efforts: ['low', 'high', 'max'] },
    },
  ]);
});

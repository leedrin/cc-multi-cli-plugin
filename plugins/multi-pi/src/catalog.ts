import type { ModelDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';
import type { PiProviderId } from './providers.ts';

export interface PiCatalogModel {
  id: string;
  name: string;
  api: 'openai-completions';
  type: 'chat';
  contextWindow: number;
  maxTokens: number;
  input: readonly string[];
  thinkingLevelMap: Readonly<Record<string, string | null | undefined>>;
  defaultEffort?: 'high';
  providerId?: PiProviderId;
}

const STRATA_MODELS: readonly PiCatalogModel[] = [
  {
    id: 'qwen3.8-flash-next',
    name: 'Qwen 3.8 Flash Next',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 196_608,
    maxTokens: 32_768,
    input: ['text'],
    thinkingLevelMap: {},
    providerId: 'strata',
  },
];

const DEEPSEEK_MODELS: readonly PiCatalogModel[] = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
    defaultEffort: 'high',
    providerId: 'deepseek',
  },
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'],
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    defaultEffort: 'high',
    providerId: 'deepseek',
  },
];

const ZAI_MODELS: readonly PiCatalogModel[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    defaultEffort: 'high',
    providerId: 'zai',
  },
  {
    id: 'glm-5.2',
    name: 'GLM-5.2',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    thinkingLevelMap: {
      off: 'none',
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    defaultEffort: 'high',
    providerId: 'zai',
  },
];

const ZAI_CODING_CN_MODELS: readonly PiCatalogModel[] = [
  {
    id: 'glm-5.3',
    name: 'GLM-5.3',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text'],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    defaultEffort: 'high',
    providerId: 'zai-coding-cn',
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    input: ['text', 'image'],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    },
    defaultEffort: 'high',
    providerId: 'zai-coding-cn',
  },
];

export const PI_MODELS_BY_PROVIDER: Readonly<Record<PiProviderId, readonly PiCatalogModel[]>> = {
  deepseek: DEEPSEEK_MODELS,
  zai: ZAI_MODELS,
  'zai-coding-cn': ZAI_CODING_CN_MODELS,
  strata: STRATA_MODELS,
};
export const PI_DEEPSEEK_MODELS = PI_MODELS_BY_PROVIDER.deepseek;

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type PiEffort = (typeof EFFORT_ORDER)[number];

function piLabel(providerId: PiProviderId | undefined): string {
  if (providerId === 'deepseek') {
    return 'DeepSeek';
  }
  if (providerId === 'strata') {
    return 'Strata';
  }
  return 'GLM';
}

export interface PiEffortResolution {
  effort: PiEffort | undefined;
  notice: string | undefined;
}

export function resolvePiEffort(
  model: PiCatalogModel,
  requested?: string,
  options: { thinkingDisabled?: boolean } = {},
): PiEffortResolution {
  if (requested !== undefined && !EFFORT_ORDER.includes(requested as PiEffort)) {
    throw new Error(`Unknown effort: ${requested}`);
  }
  const supported = EFFORT_ORDER.filter(
    (effort) => typeof model.thinkingLevelMap[effort] === 'string',
  );
  const target = requested ?? model.defaultEffort ?? 'high';
  if (supported.length === 0) {
    return {
      effort: undefined,
      notice:
        requested === undefined
          ? undefined
          : `${model.id} does not support effort; ignoring ${requested}.`,
    };
  }
  if (options.thinkingDisabled) {
    return { effort: undefined, notice: undefined };
  }
  if (supported.includes(target as PiEffort)) {
    return { effort: target as PiEffort, notice: undefined };
  }
  const targetIndex = EFFORT_ORDER.indexOf(target as PiEffort);
  const actual = supported.reduce((nearest, candidate) => {
    const candidateDistance = Math.abs(EFFORT_ORDER.indexOf(candidate) - targetIndex);
    const nearestDistance = Math.abs(EFFORT_ORDER.indexOf(nearest) - targetIndex);
    return candidateDistance <= nearestDistance ? candidate : nearest;
  });
  return {
    effort: actual,
    notice:
      actual === requested
        ? undefined
        : `${piLabel(model.providerId)} ${model.id} does not support effort ${target}; using ${actual}.`,
  };
}

export function filterPiModelsForProvider(
  providerId: PiProviderId,
  selection: string | undefined,
): readonly PiCatalogModel[] {
  const models = PI_MODELS_BY_PROVIDER[providerId];
  const ids = selection
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids?.length) {
    return models;
  }
  const allModels = Object.values(PI_MODELS_BY_PROVIDER).flat();
  const allIds = new Set(allModels.map(({ id }) => id));
  const unknown = [...new Set(ids.filter((id) => !allIds.has(id)))];
  if (unknown.length > 0) {
    throw new Error(
      `MULTI_PI_MODELS contains unknown model IDs: ${unknown.join(', ')}. Allowed IDs: ${[...allIds].join(', ')}.`,
    );
  }
  const selectedIds = new Set(ids);
  return models.filter(({ id }) => selectedIds.has(id));
}

export function filterPiModels(selection: string | undefined): readonly PiCatalogModel[] {
  if (selection === undefined || selection.trim() === '') {
    return PI_DEEPSEEK_MODELS;
  }
  const ids = selection
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const deepseekIds = new Set(PI_DEEPSEEK_MODELS.map(({ id }) => id));
  const unknown = [...new Set(ids.filter((id) => !deepseekIds.has(id)))];
  if (unknown.length > 0) {
    throw new Error(
      `MULTI_PI_MODELS contains unknown model IDs: ${unknown.join(', ')}. Allowed IDs: ${[...deepseekIds].join(', ')}.`,
    );
  }
  return filterPiModelsForProvider('deepseek', selection);
}

export function toPiModelDescriptors(
  models: readonly PiCatalogModel[] = PI_DEEPSEEK_MODELS,
  providerId: PiProviderId = 'deepseek',
): readonly ModelDescriptor[] {
  return models.map((model) => {
    const efforts = EFFORT_ORDER.filter(
      (effort) => typeof model.thinkingLevelMap[effort] === 'string',
    );
    return {
      identity: {
        providerId,
        modelId: model.id,
        routeId: `multi/${providerId}/${encodeURIComponent(model.id)}`,
        oneMillionContext: false,
      },
      label: model.name,
      protocol: 'openai-chat',
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens,
      capabilities: {
        text: true,
        streaming: true,
        tools: true,
        reasoning: efforts.length > 0,
        images: model.input.includes('image'),
      },
      ...(efforts.length > 0 ? { reasoning: { native: true, efforts } } : {}),
    };
  });
}

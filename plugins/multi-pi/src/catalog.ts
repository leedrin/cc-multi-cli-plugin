import type { ModelDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';

export interface PiCatalogModel {
  id: string;
  name: string;
  api: 'openai-completions';
  type: 'chat';
  contextWindow: number;
  maxTokens: number;
  input: readonly string[];
  thinkingLevelMap: Readonly<Record<string, string | null | undefined>>;
}

export const PI_DEEPSEEK_MODELS: readonly PiCatalogModel[] = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text'],
    thinkingLevelMap: {
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      max: 'max',
    },
  },
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    api: 'openai-completions',
    type: 'chat',
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    input: ['text', 'image'],
    thinkingLevelMap: {
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      max: 'max',
    },
  },
];

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type PiEffort = (typeof EFFORT_ORDER)[number];

export interface PiEffortResolution {
  effort: PiEffort | undefined;
  notice: string | undefined;
}

export function resolvePiEffort(
  model: PiCatalogModel,
  requested?: string,
  options: { thinkingDisabled?: boolean } = {},
): PiEffortResolution {
  if (options.thinkingDisabled) {
    return { effort: undefined, notice: undefined };
  }

  if (requested !== undefined && !EFFORT_ORDER.includes(requested as PiEffort)) {
    throw new Error(`Unknown effort: ${requested}`);
  }

  const supported = EFFORT_ORDER.filter(
    (effort) => typeof model.thinkingLevelMap[effort] === 'string',
  );
  const target = requested ?? 'high';
  if (supported.length === 0) {
    return {
      effort: undefined,
      notice:
        requested === undefined
          ? undefined
          : `${model.id} does not support effort; ignoring ${requested}.`,
    };
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
        : `DeepSeek ${model.id} does not support effort ${target}; using ${actual}.`,
  };
}

export function filterPiModels(selection: string | undefined): readonly PiCatalogModel[] {
  const ids = selection
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids?.length) {
    return PI_DEEPSEEK_MODELS;
  }

  const allowedIds = new Set(PI_DEEPSEEK_MODELS.map(({ id }) => id));
  const unknown = [...new Set(ids.filter((id) => !allowedIds.has(id)))];
  if (unknown.length > 0) {
    throw new Error(
      `MULTI_PI_MODELS contains unknown model IDs: ${unknown.join(', ')}. Allowed IDs: ${[...allowedIds].join(', ')}.`,
    );
  }

  const selectedIds = new Set(ids);
  return PI_DEEPSEEK_MODELS.filter(({ id }) => selectedIds.has(id));
}

export function toPiModelDescriptors(
  models: readonly PiCatalogModel[] = PI_DEEPSEEK_MODELS,
): readonly ModelDescriptor[] {
  return models.map((model) => ({
    identity: {
      providerId: 'deepseek',
      modelId: model.id,
      routeId: `multi/deepseek/${encodeURIComponent(model.id)}`,
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
      reasoning: true,
      images: model.input.includes('image'),
    },
    reasoning: {
      native: true,
      efforts: EFFORT_ORDER.filter((effort) => typeof model.thinkingLevelMap[effort] === 'string'),
    },
  }));
}

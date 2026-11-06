import type { Context } from '@earendil-works/pi-ai';
import type { OpenAICompletionsOptions } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { PiCatalogModel } from './catalog.ts';
import type { PiProviderId } from './providers.ts';

// Fixed provider subpaths are the narrow exception to AGENTS.md's direct-import preference.
type PiProvider = ReturnType<
  typeof import('@earendil-works/pi-ai/providers/deepseek').deepseekProvider
>;
type PiModel = ReturnType<PiProvider['getModels']>[number];
type PiEventStream = ReturnType<PiProvider['stream']>;
type PiIterator = ReturnType<PiEventStream[typeof Symbol.asyncIterator]>;
type PiEvent = Exclude<Awaited<ReturnType<PiIterator['next']>>['value'], undefined>;

const FACTORIES = {
  deepseek: async () =>
    (await import('@earendil-works/pi-ai/providers/deepseek')).deepseekProvider(),
  zai: async () => (await import('@earendil-works/pi-ai/providers/zai')).zaiProvider(),
  'zai-coding-cn': async () =>
    (await import('@earendil-works/pi-ai/providers/zai-coding-cn')).zaiCodingCnProvider(),
  strata: async (model: PiCatalogModel, baseUrl: string) => {
    const [{ createProvider }, { openAICompletionsApi }] = await Promise.all([
      import('@earendil-works/pi-ai/models'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    ]);
    return createProvider({
      id: 'strata',
      models: [
        {
          ...model,
          input: [...model.input] as ('text' | 'image')[],
          provider: 'strata',
          baseUrl,
          reasoning: false,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens',
          },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: 'Strata API key',
          resolve: async ({ credential }) => ({
            auth: { apiKey: credential?.key ?? 'local' },
          }),
        },
      },
    }) as unknown as PiProvider;
  },
} as const;

export interface PiStreamRequest {
  providerId: PiProviderId;
  model: PiCatalogModel;
  context: Context;
  apiKey: string;
  signal?: AbortSignal;
  reasoningEffort?: string;
  options?: Pick<OpenAICompletionsOptions, 'maxTokens' | 'toolChoice'>;
  onProviderStreamEvent?: (chunk: unknown) => void;
  fetch?: typeof globalThis.fetch;
  label: string;
  baseUrl?: string;
}

export interface OpenPiStreamResult {
  model: PiModel;
  first: PiEvent;
  stream: AsyncIterable<PiEvent>;
}

export class PiUpstreamStatus extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  constructor(status: number, retryAfter: string | null) {
    super(`Pi provider returned HTTP ${status}.`);
    this.name = 'PiUpstreamStatus';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function createPiFetch(
  fetchImpl: typeof globalThis.fetch,
  allowedOrigin = 'https://api.deepseek.com',
  label = 'DeepSeek',
  onResponse?: (response: Response) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (new URL(target).origin !== allowedOrigin) {
      throw new Error(`${label} request target is not allowed.`);
    }
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, redirect: 'error' });
    } catch {
      throw new Error(`${label} request failed.`);
    }
    onResponse?.(response);
    if (response.ok) {
      return response;
    }
    const safeHeaders = new Headers({ 'content-type': 'application/json' });
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      safeHeaders.set('retry-after', retryAfter);
    }
    await response.body?.cancel().catch(() => undefined);
    return new Response(JSON.stringify({ error: 'Upstream request failed.' }), {
      status: response.status,
      headers: safeHeaders,
    });
  };
}

function safeError(label: string, status: number | undefined, retryAfter: string | null): Error {
  if (status !== undefined) {
    const error = new PiUpstreamStatus(status, retryAfter);
    error.message = `${label} returned HTTP ${status}.`;
    return error;
  }
  return new Error(`${label} request failed.`);
}

export async function loadPiProvider(
  providerId: PiProviderId,
  model?: PiCatalogModel,
  baseUrl?: string,
) {
  if (providerId === 'strata') {
    if (!model || !baseUrl) {
      throw new Error('Strata model and base URL are required.');
    }
    return FACTORIES.strata(model, baseUrl);
  }
  return FACTORIES[providerId]();
}

async function resolveStrataModelId(request: PiStreamRequest): Promise<string> {
  const baseUrl = request.baseUrl;
  if (!baseUrl) {
    throw new Error('Strata model and base URL are required.');
  }
  const target = new URL(`${baseUrl.replace(/\/+$/, '')}/models`);
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
    : AbortSignal.timeout(5_000);
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: 'GET',
      headers: { authorization: `Bearer ${request.apiKey}` },
      signal,
      redirect: 'error',
    });
  } catch {
    if (request.signal?.aborted) {
      throw new Error('aborted');
    }
    throw new Error('Strata /models request failed (model count unavailable).');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Strata /models returned HTTP ${response.status} (model count unavailable).`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (request.signal?.aborted) {
      throw new Error('aborted');
    }
    throw new Error('Strata /models returned invalid JSON (model count unavailable).');
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error('Strata /models returned an invalid model list (model count unavailable).');
  }
  const models = payload.data;
  if (
    !models.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        'id' in entry &&
        typeof entry.id === 'string' &&
        entry.id.length > 0,
    )
  ) {
    throw new Error(`Strata /models returned an invalid model list (${models.length} models).`);
  }
  const ids = models.map((entry) => (entry as { id: string }).id);
  if (ids.includes(request.model.id)) {
    return request.model.id;
  }
  if (ids.length === 1) {
    return ids[0] as string;
  }
  throw new Error(
    `Strata /models returned ${ids.length} models; expected exactly one or ${request.model.id}.`,
  );
}

export async function openPiStream(request: PiStreamRequest): Promise<OpenPiStreamResult> {
  if (request.signal?.aborted) {
    throw new Error('aborted');
  }
  const provider = await loadPiProvider(request.providerId, request.model, request.baseUrl);
  const model = provider.getModels().find(({ id }) => id === request.model.id);
  if (!model) {
    throw new Error(`${request.label} model is unavailable.`);
  }
  const wireModelId =
    request.providerId === 'strata' ? await resolveStrataModelId(request) : request.model.id;
  const requestModel = {
    ...model,
    id: wireModelId,
    ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
    thinkingLevelMap: request.model.thinkingLevelMap,
  } as PiModel;
  let status: number | undefined;
  let retryAfter: string | null = null;
  const events = provider.stream(requestModel, normalizeContext(request.context), {
    apiKey: request.apiKey,
    env: {},
    cacheRetention: 'short',
    maxRetries: 0,
    ...request.options,
    ...(request.onProviderStreamEvent
      ? { onProviderStreamEvent: (chunk: unknown) => request.onProviderStreamEvent?.(chunk) }
      : {}),
    reasoningEffort: request.reasoningEffort as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max'
      | undefined,
    ...(request.signal ? { signal: request.signal } : {}),
    fetch: createPiFetch(
      request.fetch ?? globalThis.fetch,
      new URL(request.baseUrl ?? provider.baseUrl ?? '').origin,
      request.label,
      (response) => {
        status = response.status;
        retryAfter = response.headers.get('retry-after');
      },
    ),
  });
  const iterator = events[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (request.signal?.aborted) {
      throw new Error('aborted');
    }
    if (first.done || first.value.type !== 'start') {
      throw safeError(request.label, status, retryAfter);
    }
    return {
      model: requestModel,
      first: first.value,
      stream: { [Symbol.asyncIterator]: () => iterator },
    };
  } catch (error) {
    if (request.signal?.aborted || error instanceof PiUpstreamStatus) {
      throw error;
    }
    throw safeError(request.label, status, retryAfter);
  }
}

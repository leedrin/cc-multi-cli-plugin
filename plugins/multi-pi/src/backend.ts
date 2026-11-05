import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import type { TranscriptContext } from '@earendil-works/pi-ai/utils/transcript';
import type { PiCatalogModel } from './catalog.ts';

type PiProvider = ReturnType<typeof deepseekProvider>;
type PiModel = ReturnType<PiProvider['getModels']>[number];
type PiEventStream = ReturnType<PiProvider['stream']>;
type PiIterator = ReturnType<PiEventStream[typeof Symbol.asyncIterator]>;
type PiEvent = Exclude<Awaited<ReturnType<PiIterator['next']>>['value'], undefined>;

export interface PiStreamRequest {
  model: PiCatalogModel;
  context: TranscriptContext;
  apiKey: string;
  signal?: AbortSignal;
  reasoningEffort?: string;
  fetch?: typeof globalThis.fetch;
  label: string;
}

export interface OpenPiStreamResult {
  model: PiModel;
  first: PiEvent;
  stream: AsyncIterable<PiEvent>;
}

const deepseek = deepseekProvider();
const deepseekOrigin = new URL(deepseek.baseUrl ?? 'https://api.deepseek.com').origin;

export function createPiFetch(
  fetchImpl: typeof globalThis.fetch,
  onResponse?: (response: Response) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const target = input instanceof Request ? input.url : String(input);
    if (new URL(target).origin !== deepseekOrigin) {
      throw new Error('DeepSeek request target is not allowed.');
    }
    let response: Response;
    try {
      response = await fetchImpl(input, { ...init, redirect: 'error' });
    } catch {
      throw new Error('DeepSeek request failed.');
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

function safeError(label: string, status: number | undefined): Error {
  if (status !== undefined) {
    return new Error(`${label} returned HTTP ${status}.`);
  }
  return new Error(`${label} request failed.`);
}

export async function openPiStream(request: PiStreamRequest): Promise<OpenPiStreamResult> {
  if (request.signal?.aborted) {
    throw new Error('aborted');
  }
  const model = deepseek.getModels().find(({ id }) => id === request.model.id);
  if (!model) {
    throw new Error('DeepSeek model is unavailable.');
  }

  const requestModel: PiModel = {
    ...model,
    thinkingLevelMap: request.model.thinkingLevelMap,
  };
  let status: number | undefined;
  const events = deepseek.stream(requestModel, request.context, {
    apiKey: request.apiKey,
    env: {},
    cacheRetention: 'short',
    maxRetries: 0,
    reasoningEffort: request.reasoningEffort as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max'
      | undefined,
    ...(request.signal ? { signal: request.signal } : {}),
    fetch: createPiFetch(request.fetch ?? globalThis.fetch, (response) => {
      status = response.status;
    }),
  });
  const iterator = events[Symbol.asyncIterator]();
  try {
    const first = await iterator.next();
    if (request.signal?.aborted) {
      throw new Error('aborted');
    }
    if (first.done) {
      throw safeError(request.label, status);
    }
    if (first.value.type === 'error') {
      throw safeError(request.label, status);
    }
    if (first.value.type !== 'start') {
      throw safeError(request.label, status);
    }
    const stream: AsyncIterable<PiEvent> = {
      [Symbol.asyncIterator]: () => iterator,
    };
    return { model: requestModel, first: first.value, stream };
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    throw safeError(request.label, status);
  }
}

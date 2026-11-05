import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { GatewayFetch } from '../../multi-core/src/gateway/fetch.ts';
import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  PreparedRequest,
  ProviderRequestInput,
  UpstreamOpen,
} from '../../multi-core/src/gateway/provider-request.ts';
import { toResponses } from '../../multi-core/src/gateway/responses.ts';
import { estimateInputTokens, estimateTextTokens } from '../../multi-core/src/gateway/tokens.ts';
import type { CanonicalTokenUsage } from '../../multi-core/src/gateway/usage-accounting.ts';
import { PI_DEEPSEEK_MODELS, type PiCatalogModel, resolvePiEffort } from './catalog.ts';
import { toPiContext } from './messages.ts';
import { PI_SIGNATURE_PREFIX } from './signature.ts';
import { translatePiStream } from './stream.ts';
import { ObservedUsage } from './usage.ts';

const PATHS = ['/v1/messages', '/v1/messages/count_tokens'];
const LABEL = 'DeepSeek';
const AUTH_HELP = ' Check DEEPSEEK_API_KEY.';
const UNAVAILABLE = 'DeepSeek is unavailable. Set DEEPSEEK_API_KEY and relaunch.';

export type PiBackendLoader = () => Promise<typeof import('./backend.ts')>;

export interface PiGatewayRequestDeps {
  loadBackend?: PiBackendLoader;
}

function estimatePiInputTokens(
  body: ProviderRequestInput['body'],
  model: PiCatalogModel,
  context: ReturnType<typeof toPiContext>['context'],
): number {
  const estimationBody = {
    ...body,
    messages: (body.messages ?? []).map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        return message;
      }
      return {
        ...message,
        content: message.content.filter(
          (block) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
        ),
      };
    }),
  };
  const normalized = toResponses(estimationBody, model.id, PI_SIGNATURE_PREFIX);
  const thinkingTokens = context.messages.reduce((total, message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return total;
    }
    return (
      total +
      message.content.reduce((count, item) => {
        if (item.type === 'thinking' && typeof item.thinking === 'string') {
          return count + estimateTextTokens(item.thinking);
        }
        return count;
      }, 0)
    );
  }, 0);
  return estimateInputTokens(normalized) + thinkingTokens;
}

function modelFor(bodyModel: string | undefined): { routeId: string; model: PiCatalogModel } {
  const identity = typeof bodyModel === 'string' ? decodeModelRoute(bodyModel) : undefined;
  if (identity?.providerId !== 'deepseek' || identity.preset !== undefined) {
    throw new Error('Unknown DeepSeek model');
  }
  const model = PI_DEEPSEEK_MODELS.find(({ id }) => id === identity.modelId);
  if (!model) {
    throw new Error(`Unknown DeepSeek model: ${identity.modelId}`);
  }
  return { routeId: bodyModel as string, model };
}

export function preparePiRequest(
  input: ProviderRequestInput,
  apiKey: string,
  deps: PiGatewayRequestDeps = {},
): PreparedRequest {
  const { method, pathname, body } = input;
  if (method !== 'POST' || !PATHS.includes(pathname)) {
    throw new Error('DeepSeek requires POST /v1/messages or /v1/messages/count_tokens');
  }
  if (!apiKey.trim()) {
    throw new Error(UNAVAILABLE);
  }
  const { routeId, model } = modelFor(body.model);
  const translated = toPiContext(body, model, routeId);
  const effort = resolvePiEffort(model, body.output_config?.effort, {
    thinkingDisabled: body.thinking?.type === 'disabled',
  });
  let inputTokenCount: number | undefined;
  const inputTokens = () => {
    inputTokenCount ??= estimatePiInputTokens(body, model, translated.context);
    return inputTokenCount;
  };
  const loadBackend = deps.loadBackend ?? (() => import('./backend.ts'));
  return {
    label: LABEL,
    authHelp: AUTH_HELP,
    endpoint: 'chat/completions',
    route: 'deepseek',
    inputTokens,
    ...(effort.effort === undefined
      ? {}
      : { completion: { model: routeId, effort: effort.effort } }),
    requestEvent: (requestAgent) => ({
      route: 'deepseek-request',
      agentId: requestAgent,
      model: body.model,
      ...(effort.effort === undefined ? {} : { effort: effort.effort }),
    }),
    failureEvent: (status, requestAgent) => ({ route: 'deepseek', agentId: requestAgent, status }),
    open: async (signal: AbortSignal, fetchImpl: GatewayFetch): Promise<UpstreamOpen> => {
      try {
        const backend = await loadBackend();
        const usage = new ObservedUsage();
        const opened = await backend.openPiStream({
          model,
          context: translated.context,
          apiKey,
          signal,
          fetch: (url, init) => fetchImpl(String(url), init as Parameters<GatewayFetch>[1]),
          reasoningEffort: effort.effort,
          options: translated.options,
          onProviderStreamEvent: (chunk: unknown) => usage.observe(chunk),
          label: LABEL,
        });
        return {
          ok: true,
          translate: (emit, rememberWorkerModel) =>
            translatePiStream(
              { first: opened.first as AssistantMessageEvent, stream: opened.stream },
              {
                routeId,
                label: LABEL,
                model: routeId,
                request: body,
                inputTokens: inputTokens(),
                rememberWorkerModel,
                usage: () => usage.canonical() as CanonicalTokenUsage,
                ...(effort.notice === undefined ? {} : { notice: effort.notice }),
              },
              emit,
            ),
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === 'PiUpstreamStatus' &&
          'status' in error &&
          typeof error.status === 'number' &&
          'retryAfter' in error &&
          (typeof error.retryAfter === 'string' || error.retryAfter === null)
        ) {
          return { ok: false, status: error.status, retryAfter: error.retryAfter };
        }
        throw error;
      }
    },
  };
}

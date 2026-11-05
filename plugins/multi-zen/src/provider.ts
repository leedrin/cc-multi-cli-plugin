import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import { readZenKey } from './auth.ts';
import { prepareZenRequest, zenSignaturePrefixes, zenUnavailable } from './gateway-request.ts';
import { ZEN_MODELS } from './models.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export interface ZenDiscoveryDeps {
  readKey?: typeof readZenKey;
}

export async function discoverZen(
  context: ProviderDiscoveryContext,
  deps: ZenDiscoveryDeps = {},
): Promise<string | undefined> {
  if (context.env.MULTI_ENABLED_PROVIDERS !== undefined && !context.explicit) {
    return undefined;
  }
  return (deps.readKey ?? readZenKey)({ env: context.env });
}

export const zenProvider: ProviderDescriptor = {
  id: 'zen',
  plugin: 'zen',
  label: 'Zen',
  kind: 'direct',
  autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  unavailableMessage: zenUnavailable,
  worker: { type: 'multi-zen' },
  availability: async (context) => {
    try {
      const apiKey = await discoverZen(context);
      return apiKey ? { available: true } : { available: false, reason: zenUnavailable };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async (context) => {
    const apiKey = await discoverZen(context);
    return (apiKey ? ZEN_MODELS : []).map((model) => ({
      identity: modelIdentity(`multi/zen/${model.id}`),
      label: model.label,
      description: model.description,
      protocol: model.protocol === 'responses' ? 'openai-responses' : 'openai-chat',
      maxOutputTokens: model.maxOutputTokens,
      capabilities: {
        text: true,
        streaming: true,
        tools: true,
        images: model.images,
        documents: model.documents,
        reasoning: Boolean(model.efforts),
      },
      ...(model.efforts ? { reasoning: { efforts: model.efforts } } : {}),
    }));
  },
  direct: {
    signaturePrefixes: zenSignaturePrefixes,
    prepare: (input) => prepareZenRequest(input, process.env.OPENCODE_API_KEY ?? ''),
  },
};

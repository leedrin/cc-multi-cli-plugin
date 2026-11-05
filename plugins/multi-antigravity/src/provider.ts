import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import { AntigravityHarness } from './harness.ts';
import { discoverAntigravityModels } from './models.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export interface AntigravityDiscoveryDeps {
  resolveExecutable?: (env: NodeJS.ProcessEnv) => void;
  discoverModels?: typeof discoverAntigravityModels;
  throwOnError?: boolean;
}

export async function discoverAntigravity(
  context: ProviderDiscoveryContext,
  deps: AntigravityDiscoveryDeps = {},
): Promise<Awaited<ReturnType<typeof discoverAntigravityModels>>> {
  if (
    (context.env.MULTI_ENABLED_PROVIDERS !== undefined && !context.explicit) ||
    context.env.MULTI_ANTIGRAVITY !== '1'
  ) {
    return [];
  }
  try {
    deps.resolveExecutable?.(context.env);
    return await (deps.discoverModels ?? discoverAntigravityModels)({ env: context.env });
  } catch (error) {
    if (deps.throwOnError) {
      throw error;
    }
    context.log(
      `Antigravity choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export const antigravityProvider: ProviderDescriptor = {
  id: 'antigravity',
  plugin: 'antigravity',
  label: 'Antigravity',
  kind: 'harness',
  autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  unavailableMessage:
    'Antigravity is unavailable. Install and connect the multi-antigravity plugin.',
  worker: { type: 'multi-antigravity' },
  availability: async (context) => {
    try {
      const models = await discoverAntigravity(context, { throwOnError: true });
      return models.length
        ? { available: true }
        : { available: false, reason: 'Antigravity models are unavailable.' };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async (context) =>
    (await discoverAntigravity(context, { throwOnError: true })).map((model) => ({
      identity: modelIdentity(model.model),
      label: model.label,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true },
      ...(model.effort ? { reasoning: { efforts: [model.effort] } } : {}),
    })),
  createHarness: async () => new AntigravityHarness([]),
};

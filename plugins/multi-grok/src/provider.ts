import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import { GrokHarness } from './harness.ts';
import { discoverGrokModels } from './models.ts';
import { GROK_TOOLS } from './permissions.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export interface GrokDiscoveryDeps {
  resolveExecutable?: (env: NodeJS.ProcessEnv) => void;
  discoverModels?: typeof discoverGrokModels;
  throwOnError?: boolean;
}

export async function discoverGrok(
  context: ProviderDiscoveryContext,
  deps: GrokDiscoveryDeps = {},
): Promise<Awaited<ReturnType<typeof discoverGrokModels>>> {
  if (context.env.MULTI_ENABLED_PROVIDERS !== undefined && !context.explicit) {
    return [];
  }
  try {
    deps.resolveExecutable?.(context.env);
    return await (deps.discoverModels ?? discoverGrokModels)({ env: context.env });
  } catch (error) {
    if (deps.throwOnError) {
      throw error;
    }
    if (context.explicit) {
      context.log(
        `Grok choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

export const grokProvider: ProviderDescriptor = {
  id: 'grok',
  plugin: 'grok',
  label: 'Grok',
  kind: 'harness',
  autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  unavailableMessage: 'Grok is unavailable. Install Grok Build, run grok login, and relaunch.',
  worker: { type: 'multi-grok' },
  displayTools: GROK_TOOLS,
  availability: async (context) => {
    try {
      const models = await discoverGrok(context, { throwOnError: true });
      return models.length
        ? { available: true }
        : { available: false, reason: 'Grok models are unavailable.' };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async (context) =>
    (await discoverGrok(context, { throwOnError: true })).map((model) => ({
      identity: modelIdentity(model.model),
      label: model.label,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true },
    })),
  createHarness: async () => new GrokHarness([]),
};

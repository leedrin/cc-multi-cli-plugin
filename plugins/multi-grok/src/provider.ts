import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type { ProviderDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';
import { GrokHarness } from './harness.ts';
import { discoverGrokModels } from './models.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export const grokProvider: ProviderDescriptor = {
  id: 'grok',
  plugin: 'grok',
  label: 'Grok',
  kind: 'harness',
  autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  unavailableMessage: 'Grok is unavailable. Install Grok Build, run grok login, and relaunch.',
  worker: { type: 'multi-grok' },
  availability: async ({ env }) => {
    try {
      await discoverGrokModels({ env });
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async ({ env }) =>
    (await discoverGrokModels({ env })).map((model) => ({
      identity: modelIdentity(model.model),
      label: model.label,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true },
    })),
  createHarness: async () => new GrokHarness([]),
};

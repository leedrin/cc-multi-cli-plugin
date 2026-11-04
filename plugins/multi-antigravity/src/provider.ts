import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type { ProviderDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';
import { AntigravityHarness } from './harness.ts';
import { discoverAntigravityModels } from './models.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
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
  availability: async ({ env }) => {
    try {
      await discoverAntigravityModels({ env });
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async ({ env }) =>
    (await discoverAntigravityModels({ env })).map((model) => ({
      identity: modelIdentity(model.model),
      label: model.label,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true },
      ...(model.effort ? { reasoning: { efforts: [model.effort] } } : {}),
    })),
  createHarness: async () => new AntigravityHarness([]),
};

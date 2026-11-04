import { Cursor } from '@cursor/sdk';
import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type { ProviderDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';
import { CursorHarness } from './harness.ts';
import { cursorModelOptions } from './models.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export const cursorProvider: ProviderDescriptor = {
  id: 'cursor',
  plugin: 'cursor',
  label: 'Cursor',
  kind: 'harness',
  autoReview: {
    review: 'harness',
    statement: 'Cursor reviews its own actions natively and fails open',
  },
  unavailableMessage: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
  worker: { type: 'multi-cursor' },
  availability: async ({ env }) => {
    if (env.CURSOR_API_KEY) {
      return { available: true };
    }
    const status = await Cursor.auth.status();
    return status.status === 'logged-in'
      ? { available: true }
      : { available: false, reason: 'Cursor SDK is not signed in.' };
  },
  discoverModels: async () =>
    cursorModelOptions(await Cursor.models.list()).map((option) => ({
      identity: modelIdentity(option.model),
      label: option.label,
      description: option.description,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true, images: true },
      metadata: { selection: option.selection },
    })),
  createHarness: async () => new CursorHarness([]),
};

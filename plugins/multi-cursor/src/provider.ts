import { Cursor } from '@cursor/sdk';
import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import { CursorHarness } from './harness.ts';
import { cursorModelOptions } from './models.ts';
import { CURSOR_TOOLS } from './progress.ts';

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export interface CursorDiscoveryDeps {
  cursor?: {
    auth: Pick<typeof Cursor.auth, 'status'>;
    models: Pick<typeof Cursor.models, 'list'>;
  };
}

export interface CursorDiscoveryResult {
  cursorModels: ReturnType<typeof cursorModelOptions>;
  cursorSignedIn: boolean;
}

export async function discoverCursor(
  context: ProviderDiscoveryContext,
  required: boolean,
  deps: CursorDiscoveryDeps = {},
): Promise<CursorDiscoveryResult> {
  if (context.env.MULTI_ENABLED_PROVIDERS !== undefined && !context.explicit) {
    return { cursorModels: [], cursorSignedIn: false };
  }
  const sdk = deps.cursor ?? Cursor;
  const cursorSignedIn =
    Boolean(context.env.CURSOR_API_KEY) || (await sdk.auth.status()).status === 'logged-in';
  let cursorModels: ReturnType<typeof cursorModelOptions> = [];
  if (cursorSignedIn) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor model discovery timed out')), 15000);
      });
      cursorModels = cursorModelOptions(
        await Promise.race([sdk.models.list({ apiKey: context.env.CURSOR_API_KEY }), timeout]),
      );
    } catch (error) {
      if (required) {
        throw error;
      }
      context.log(
        `Cursor choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return { cursorModels, cursorSignedIn };
}

export const cursorProvider: ProviderDescriptor = {
  id: 'cursor',
  plugin: 'cursor',
  label: 'Cursor',
  kind: 'harness',
  runs: 'native Cursor agent',
  autoReview: {
    review: 'harness',
    statement: 'Cursor reviews its own actions natively and fails open',
  },
  unavailableMessage: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
  worker: { type: 'multi-cursor' },
  displayTools: CURSOR_TOOLS,
  availability: async (context) => {
    try {
      const { cursorSignedIn } = await discoverCursor(context, false);
      return cursorSignedIn
        ? { available: true }
        : { available: false, reason: 'Cursor SDK is not signed in.' };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async (context) => {
    const { cursorModels } = await discoverCursor(context, false);
    return cursorModels.map((option) => ({
      identity: modelIdentity(option.model),
      label: option.label,
      description: option.description,
      protocol: 'native-harness',
      capabilities: { text: true, streaming: true, tools: true, images: true },
      metadata: { selection: option.selection },
    }));
  },
  createHarness: async () => new CursorHarness([]),
};

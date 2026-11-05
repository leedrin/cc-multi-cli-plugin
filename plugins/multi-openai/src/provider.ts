import os from 'node:os';
import path from 'node:path';
import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import { discoverOpenAIReviewer } from './approval.ts';
import { readCodexAuth } from './auth.ts';
import { openaiSignaturePrefixes, prepareOpenAIRequest } from './gateway-request.ts';
import { MODELS } from './models.ts';

const authFile = (env: NodeJS.ProcessEnv) =>
  path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

function modelIdentity(route: string) {
  const identity = decodeModelRoute(route);
  if (!identity) {
    throw new Error(`Invalid built-in model route: ${route}`);
  }
  return identity;
}

export interface OpenAIDiscoveryResult {
  codexSignedIn: boolean;
  openaiReview: boolean;
}

export interface OpenAIDiscoveryDeps {
  readAuth?: typeof readCodexAuth;
  discoverReviewer?: typeof discoverOpenAIReviewer;
}

export async function discoverOpenAI(
  context: ProviderDiscoveryContext,
  deps: OpenAIDiscoveryDeps = {},
): Promise<OpenAIDiscoveryResult> {
  if (context.env.MULTI_ENABLED_PROVIDERS !== undefined && !context.explicit) {
    return { codexSignedIn: false, openaiReview: false };
  }
  const auth = deps.readAuth ?? readCodexAuth;
  const reviewer = deps.discoverReviewer ?? discoverOpenAIReviewer;
  const file = authFile(context.env);
  let codexSignedIn = false;
  try {
    await auth(file, { env: context.env });
    codexSignedIn = true;
  } catch {
    context.log('OpenAI choices unavailable: sign in with codex login to enable them.');
  }
  let openaiReview = false;
  if (codexSignedIn) {
    try {
      openaiReview = await reviewer(file, undefined, { env: context.env });
    } catch {
      // A failed capability probe preserves inference and leaves auto mode unreviewed.
    }
    if (!openaiReview) {
      context.log('OpenAI reviewer unavailable; actions in auto mode run unreviewed.');
    }
  }
  return { codexSignedIn, openaiReview };
}

export interface OpenAIProviderCredentials {
  authFile?: string;
}

const defaultAuthFile = authFile(process.env);

export const openaiProvider: ProviderDescriptor = {
  id: 'openai',
  plugin: 'openai',
  label: 'OpenAI',
  kind: 'direct',
  autoReview: { review: 'reviewer', statement: 'reviewed by the OpenAI account reviewer' },
  unavailableMessage: 'OpenAI is unavailable. Sign in with codex login first.',
  worker: { type: 'multi-openai' },
  availability: async (context) => {
    try {
      const result = await discoverOpenAI(context, { discoverReviewer: async () => true });
      return result.codexSignedIn
        ? { available: true }
        : { available: false, reason: 'OpenAI is unavailable. Sign in with codex login first.' };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async (context) => {
    const { codexSignedIn } = await discoverOpenAI(context);
    return (codexSignedIn ? Object.values(MODELS) : []).map((model) => ({
      identity: modelIdentity(`multi/openai/${model}`),
      label: model,
      protocol: 'openai-responses',
      capabilities: { text: true, streaming: true, tools: true, reasoning: true },
    }));
  },
  direct: {
    signaturePrefixes: openaiSignaturePrefixes,
    prepare: (input) => prepareOpenAIRequest(input, String(input.body.model), defaultAuthFile),
  },
};

export function bindOpenAIProvider({
  authFile: boundAuthFile,
}: OpenAIProviderCredentials): ProviderDescriptor {
  return {
    ...openaiProvider,
    direct: {
      signaturePrefixes: openaiSignaturePrefixes,
      prepare: (input) =>
        prepareOpenAIRequest(input, String(input.body.model), boundAuthFile ?? defaultAuthFile),
    },
  };
}

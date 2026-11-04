import os from 'node:os';
import path from 'node:path';
import { decodeModelRoute } from '../../multi-core/src/gateway/model-identity.ts';
import type { ProviderDescriptor } from '../../multi-core/src/gateway/provider-registry.ts';
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

export const openaiProvider: ProviderDescriptor = {
  id: 'openai',
  plugin: 'openai',
  label: 'OpenAI',
  kind: 'direct',
  autoReview: { review: 'reviewer', statement: 'reviewed by the OpenAI account reviewer' },
  unavailableMessage: 'OpenAI is unavailable. Sign in with codex login first.',
  worker: { type: 'multi-openai' },
  availability: async ({ env }) => {
    try {
      await readCodexAuth(authFile(env), { env });
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  discoverModels: async () =>
    Object.values(MODELS).map((model) => ({
      identity: modelIdentity(`multi/openai/${model}`),
      label: model,
      protocol: 'openai-responses',
      capabilities: { text: true, streaming: true, tools: true, reasoning: true },
    })),
  direct: {
    signaturePrefixes: openaiSignaturePrefixes,
    prepare: (input) =>
      prepareOpenAIRequest(input, String(input.body.model), authFile(process.env)),
  },
};

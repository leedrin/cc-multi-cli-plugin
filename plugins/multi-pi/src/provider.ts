import { PROVIDER_FACTS } from '../../multi-core/src/gateway/provider-facts.ts';
import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import type { ProviderRequestInput } from '../../multi-core/src/gateway/provider-request.ts';
import { filterPiModels, toPiModelDescriptors } from './catalog.ts';
import { preparePiRequest } from './gateway-request.ts';
import { PI_SIGNATURE_PREFIX } from './signature.ts';

type PiBackendLoader = () => Promise<typeof import('./backend.ts')>;

export async function discoverPiModels(
  context: ProviderDiscoveryContext,
  loadBackend: PiBackendLoader = () => import('./backend.ts'), // Fixed local import keeps the backend lazy without cwd-based resolution.
) {
  const apiKey = context.env.DEEPSEEK_API_KEY;
  if (apiKey?.trim()) {
    await loadBackend();
  }
  return toPiModelDescriptors(filterPiModels(context.env.MULTI_PI_MODELS));
}

const deepseekFact = PROVIDER_FACTS.find(({ id }) => id === 'deepseek');
if (!deepseekFact) {
  throw new Error('DeepSeek provider facts are missing.');
}

const deepseekUnavailable = 'DeepSeek is unavailable. Set DEEPSEEK_API_KEY and relaunch.';

export const deepseekDescriptor: ProviderDescriptor = {
  id: deepseekFact.id,
  plugin: deepseekFact.plugin,
  label: deepseekFact.label,
  kind: deepseekFact.kind,
  credentialEnv: deepseekFact.credentialEnv,
  autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
  unavailableMessage: deepseekUnavailable,
  worker: { type: deepseekFact.worker },
  availability: async (context: ProviderDiscoveryContext) => {
    const apiKey = context.env.DEEPSEEK_API_KEY;
    return apiKey?.trim() ? { available: true } : { available: false, reason: deepseekUnavailable };
  },
  discoverModels: discoverPiModels,
  direct: {
    signaturePrefixes: [PI_SIGNATURE_PREFIX],
    prepare: () => {
      throw new Error(deepseekUnavailable);
    },
  },
};

export interface PiProviderCredentials {
  apiKey?: string;
}

export function bindPiProvider({ apiKey }: PiProviderCredentials): ProviderDescriptor {
  const validatedKey = apiKey?.trim() ? apiKey : undefined;
  return {
    ...deepseekDescriptor,
    direct: {
      signaturePrefixes: [PI_SIGNATURE_PREFIX],
      prepare: (input: ProviderRequestInput) => {
        if (!validatedKey) {
          throw new Error(deepseekUnavailable);
        }
        return preparePiRequest(input, validatedKey, {
          loadBackend: () => import('./backend.ts'),
        });
      },
    },
  };
}

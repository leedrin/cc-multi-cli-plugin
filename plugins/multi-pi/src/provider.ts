import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import type { ProviderRequestInput } from '../../multi-core/src/gateway/provider-request.ts';
import { filterPiModelsForProvider, toPiModelDescriptors } from './catalog.ts';
import { preparePiRequest } from './gateway-request.ts';
import { PI_PROVIDERS, type PiProviderId, piProvider, validatedPiKey } from './providers.ts';
import { PI_SIGNATURE_PREFIX } from './signature.ts';

export interface PiProviderCredentials {
  apiKey?: string;
}

export type PiBackendLoader = () => Promise<typeof import('./backend.ts')>;

async function discoverModels(
  context: ProviderDiscoveryContext,
  providerId: PiProviderId,
  loadBackend: PiBackendLoader = () => import('./backend.ts'),
) {
  const provider = piProvider(providerId);
  const apiKey = context.env[provider.credentialEnv];
  if (validatedPiKey(apiKey)) {
    const backend = await loadBackend();
    await backend.loadPiProvider(providerId);
  }
  return toPiModelDescriptors(
    filterPiModelsForProvider(providerId, context.env.MULTI_PI_MODELS),
    providerId,
  );
}

export async function discoverPiModels(
  context: ProviderDiscoveryContext,
  loadBackend?: PiBackendLoader,
) {
  return discoverModels(context, 'deepseek', loadBackend);
}

function descriptorFor(providerId: PiProviderId, apiKey?: string): ProviderDescriptor {
  const spec = piProvider(providerId);
  const validatedKey = validatedPiKey(apiKey);
  const unavailable = `${spec.label} is unavailable. Set ${spec.credentialEnv} and relaunch.`;
  return {
    id: providerId,
    plugin: 'pi',
    label: spec.label,
    kind: 'direct',
    credentialEnv: [spec.credentialEnv],
    autoReview: { review: 'none', statement: 'no auto mode: actions run unreviewed' },
    unavailableMessage: unavailable,
    worker: { type: spec.worker },
    availability: async (context: ProviderDiscoveryContext) => {
      const key = context.env[spec.credentialEnv];
      return validatedPiKey(key) ? { available: true } : { available: false, reason: unavailable };
    },
    discoverModels: (context: ProviderDiscoveryContext) => discoverModels(context, providerId),
    direct: {
      signaturePrefixes: providerId === 'deepseek' ? [PI_SIGNATURE_PREFIX] : [],
      prepare: (input: ProviderRequestInput) => {
        if (!validatedKey) {
          throw new Error(unavailable);
        }
        return preparePiRequest(input, validatedKey, { providerId });
      },
    },
  };
}

export function bindPiProviders(
  keys: Partial<Record<PiProviderId, string>> = {},
): readonly ProviderDescriptor[] {
  return PI_PROVIDERS.map(({ id }) => descriptorFor(id, keys[id]));
}

export function bindPiProvider({ apiKey }: PiProviderCredentials): ProviderDescriptor {
  return bindPiProviders({ deepseek: apiKey })[0];
}

export const [deepseekDescriptor] = bindPiProviders();

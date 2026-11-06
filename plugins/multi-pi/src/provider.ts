import type {
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from '../../multi-core/src/gateway/provider-registry.ts';
import type { ProviderRequestInput } from '../../multi-core/src/gateway/provider-request.ts';
import { filterPiModelsForProvider, toPiModelDescriptors } from './catalog.ts';
import { preparePiRequest } from './gateway-request.ts';
import {
  PI_PROVIDERS,
  type PiProviderId,
  piProvider,
  strataUrlUsesLoopback,
  validatedPiKey,
  validatedStrataUrl,
} from './providers.ts';
import { PI_SIGNATURE_PREFIX } from './signature.ts';

export interface PiProviderCredentials {
  apiKey?: string;
  strataBaseUrl?: string;
}

export type PiBackendLoader = () => Promise<typeof import('./backend.ts')>;

async function discoverModels(
  context: ProviderDiscoveryContext,
  providerId: PiProviderId,
  loadBackend: PiBackendLoader = () => import('./backend.ts'),
) {
  const provider = piProvider(providerId);
  const apiKey = context.env[provider.credentialEnv];
  if (providerId === 'strata') {
    const url = validatedStrataUrl(context.env.MULTI_STRATA_BASE_URL);
    if (!url) {
      return [];
    }
    if (!strataUrlUsesLoopback(url) && !validatedPiKey(apiKey)) {
      throw new Error('Strata requires STRATA_API_KEY for a non-loopback base URL.');
    }
  } else if (validatedPiKey(apiKey)) {
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

function prepareProviderRequest(
  providerId: PiProviderId,
  unavailable: string,
  validatedKey: string | undefined,
  strataBaseUrl: string | undefined,
  input: ProviderRequestInput,
) {
  const baseUrl = providerId === 'strata' ? validatedStrataUrl(strataBaseUrl) : undefined;
  const loopback = baseUrl ? strataUrlUsesLoopback(baseUrl) : false;
  if (providerId === 'strata' && !baseUrl) {
    throw new Error('Set MULTI_STRATA_BASE_URL to enable Strata.');
  }
  if (!validatedKey && providerId !== 'strata') {
    throw new Error(unavailable);
  }
  if (providerId === 'strata' && !loopback && !validatedKey) {
    throw new Error('Strata requires STRATA_API_KEY for a non-loopback base URL.');
  }
  return preparePiRequest(input, validatedKey ?? 'local', {
    providerId,
    ...(baseUrl ? { baseUrl: baseUrl.toString() } : {}),
  });
}

function descriptorFor(
  providerId: PiProviderId,
  apiKey?: string,
  strataBaseUrl?: string,
): ProviderDescriptor {
  const spec = piProvider(providerId);
  const validatedKey = validatedPiKey(apiKey);
  const unavailable =
    providerId === 'strata'
      ? 'Strata is unavailable. Set MULTI_STRATA_BASE_URL and relaunch.'
      : `${spec.label} is unavailable. Set ${spec.credentialEnv} and relaunch.`;
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
      if (providerId === 'strata') {
        const url = validatedStrataUrl(context.env.MULTI_STRATA_BASE_URL);
        if (!url) {
          return { available: false, reason: 'Set MULTI_STRATA_BASE_URL to enable Strata.' };
        }
        if (!strataUrlUsesLoopback(url) && !validatedPiKey(context.env.STRATA_API_KEY)) {
          throw new Error('Strata requires STRATA_API_KEY for a non-loopback base URL.');
        }
        return { available: true };
      }
      const key = context.env[spec.credentialEnv];
      return validatedPiKey(key) ? { available: true } : { available: false, reason: unavailable };
    },
    discoverModels: (context: ProviderDiscoveryContext) => discoverModels(context, providerId),
    direct: {
      signaturePrefixes:
        providerId === 'deepseek' || providerId === 'strata' ? [PI_SIGNATURE_PREFIX] : [],
      prepare: (input: ProviderRequestInput) =>
        prepareProviderRequest(providerId, unavailable, validatedKey, strataBaseUrl, input),
    },
  };
}

export function bindPiProviders(
  keys: Partial<Record<PiProviderId, string>> = {},
  options: { strataBaseUrl?: string } = {},
): readonly ProviderDescriptor[] {
  return PI_PROVIDERS.map(({ id }) => descriptorFor(id, keys[id], options.strataBaseUrl));
}

export function bindPiProvider({ apiKey }: PiProviderCredentials): ProviderDescriptor {
  return bindPiProviders({ deepseek: apiKey })[0];
}

export const [deepseekDescriptor] = bindPiProviders();

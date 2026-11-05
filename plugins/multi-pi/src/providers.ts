import { PROVIDER_FACTS } from '../../multi-core/src/gateway/provider-facts.ts';

const PI_PROVIDER_SPECS = [
  {
    id: 'deepseek',
    modelIds: ['deepseek-v4-pro', 'deepseek-flash'],
    factory: 'deepseek',
    credentialEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'zai',
    modelIds: ['glm-5.3', 'glm-5.2'],
    factory: 'zai',
    credentialEnv: 'ZAI_API_KEY',
  },
  {
    id: 'zai-coding-cn',
    modelIds: ['glm-5.3', 'glm-5.3-flash'],
    factory: 'zai-coding-cn',
    credentialEnv: 'ZAI_CODING_CN_API_KEY',
  },
] as const;

export type PiProviderId = (typeof PI_PROVIDER_SPECS)[number]['id'];

export interface PiProviderSpec {
  id: PiProviderId;
  label: string;
  modelIds: readonly string[];
  factory: PiProviderId;
  credentialEnv: string;
  worker: string;
}

export const PI_PROVIDERS: readonly PiProviderSpec[] = PI_PROVIDER_SPECS.map((spec) => {
  const fact = PROVIDER_FACTS.find(({ id }) => id === spec.id);
  if (!fact) {
    throw new Error(`Pi provider facts are missing: ${spec.id}`);
  }
  return {
    ...spec,
    label: fact.label,
    worker: fact.worker,
  };
});

/** A key is usable exactly when it has non-whitespace content; preserve its wire value. */
export function validatedPiKey(key: string | undefined): string | undefined {
  return key?.trim() ? key : undefined;
}

export function piProvider(id: string): PiProviderSpec {
  const provider = PI_PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new Error(`Unknown Pi provider: ${id}`);
  }
  return provider;
}

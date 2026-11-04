import { decodeModelRoute, isProviderId, type ModelIdentity } from './model-identity.ts';
import type { NativeHarness } from './native-harness.ts';
import type { AutoReviewPolicy } from './provider.ts';
import { PROVIDER_FACTS } from './provider-facts.ts';
import type { PreparedRequest, ProviderRequestInput } from './provider-request.ts';

type ProviderKind = 'direct' | 'harness';

interface ProviderAvailability {
  available: boolean;
  reason?: string;
}

interface ProviderDiscoveryContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

type ModelProtocol =
  | 'openai-responses'
  | 'openai-chat'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'native-harness'
  | 'custom';

interface ModelCapabilities {
  text: boolean;
  streaming?: boolean;
  images?: boolean;
  documents?: boolean;
  tools?: boolean;
  parallelToolCalls?: boolean;
  json?: boolean;
  jsonSchema?: boolean;
  reasoning?: boolean;
}

export interface ModelDescriptor {
  identity: ModelIdentity;
  label: string;
  description?: string;
  protocol: ModelProtocol;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities: ModelCapabilities;
  reasoning?: { native?: boolean; efforts?: readonly string[] };
  pricing?: {
    currency?: string;
    inputPerMillion?: number;
    outputPerMillion?: number;
    cachedInputPerMillion?: number;
  };
  metadata?: Readonly<Record<string, unknown>>;
}

type NativeHarnessFactoryContext = ProviderDiscoveryContext;

interface ProviderUsageReader {
  read(...args: never[]): unknown;
}

interface DirectProviderAdapter {
  prepare(input: ProviderRequestInput): PreparedRequest;
  signaturePrefixes: readonly string[];
}

export interface ProviderDescriptor {
  id: string;
  plugin: string;
  label: string;
  kind: ProviderKind;
  credentialEnv?: readonly string[];
  autoReview: AutoReviewPolicy;
  availability(context: ProviderDiscoveryContext): Promise<ProviderAvailability>;
  discoverModels(context: ProviderDiscoveryContext): Promise<readonly ModelDescriptor[]>;
  usage?: ProviderUsageReader;
  direct?: DirectProviderAdapter;
  createHarness?: (context: NativeHarnessFactoryContext) => Promise<NativeHarness>;
  displayTools?: readonly string[];
  unavailableMessage: string;
  worker?: { type: string; label?: string };
}

export interface ActiveProvider {
  descriptor: ProviderDescriptor;
  models: readonly ModelDescriptor[];
  harness?: NativeHarness;
}

export interface ResolvedProviderModel {
  provider: ProviderDescriptor;
  model: ModelDescriptor;
}

function findModel(
  models: readonly ModelDescriptor[] | undefined,
  target: Pick<ModelIdentity, 'providerId' | 'modelId' | 'preset'>,
): ModelDescriptor | undefined {
  return models?.find(
    ({ identity }) =>
      identity.providerId === target.providerId &&
      identity.modelId === target.modelId &&
      identity.preset === target.preset,
  );
}

function validateProviderId(id: string): void {
  if (!isProviderId(id)) {
    throw new Error(`Invalid or reserved provider ID: ${id}`);
  }
}

/** Stores provider declarations after checking their routing facts and adapter shape. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDescriptor>();
  private readonly discoveredModels = new Map<string, readonly ModelDescriptor[]>();

  register(provider: ProviderDescriptor): void {
    this.registerMany([provider]);
  }

  registerMany(providers: readonly ProviderDescriptor[]): void {
    const pending = new Set<string>();
    for (const provider of providers) {
      this.validate(provider);
      if (pending.has(provider.id) || this.providers.has(provider.id)) {
        throw new Error(`Duplicate provider ID: ${provider.id}`);
      }
      pending.add(provider.id);
    }
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
    }
  }

  get(providerId: string): ProviderDescriptor | undefined {
    return this.providers.get(providerId);
  }

  list(): readonly ProviderDescriptor[] {
    return [...this.providers.values()];
  }

  signaturePrefixes(): readonly string[] {
    return this.list().flatMap((provider) => provider.direct?.signaturePrefixes ?? []);
  }

  models(): readonly ModelDescriptor[] {
    return [...this.discoveredModels.values()].flat();
  }

  setModels(providerId: string, models: readonly ModelDescriptor[]): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Unknown provider ID: ${providerId}`);
    }
    this.discoveredModels.set(providerId, models);
  }

  resolve(providerId: string, modelId: string): ResolvedProviderModel | undefined {
    const provider = this.providers.get(providerId);
    const model = findModel(this.discoveredModels.get(providerId), { providerId, modelId });
    return provider && model ? { provider, model } : undefined;
  }

  resolveRoute(routeId: string): ResolvedProviderModel | undefined {
    const identity = decodeModelRoute(routeId);
    if (!identity || identity.preset !== undefined) {
      return undefined;
    }
    return this.resolve(identity.providerId, identity.modelId);
  }

  private validate(provider: ProviderDescriptor): void {
    if (typeof provider.id !== 'string') {
      throw new Error(`Invalid provider ID: ${String(provider.id)}`);
    }
    validateProviderId(provider.id);

    const fact = PROVIDER_FACTS.find((candidate) => candidate.id === provider.id);
    if (!fact) {
      throw new Error(`Provider ID is not declared in provider facts: ${provider.id}`);
    }
    if (provider.plugin !== fact.plugin || provider.kind !== fact.kind) {
      throw new Error(`Provider descriptor does not match provider facts: ${provider.id}`);
    }
    if (provider.kind === 'direct' && (!provider.direct || provider.createHarness)) {
      throw new Error(`Direct provider ${provider.id} must have only a direct adapter.`);
    }
    if (provider.kind === 'harness' && (!provider.createHarness || provider.direct)) {
      throw new Error(`Harness provider ${provider.id} must have only a harness adapter.`);
    }
    if (provider.worker && provider.worker.type !== fact.worker) {
      throw new Error(`Provider worker does not match provider facts: ${provider.id}`);
    }
  }
}

/** Owns discovered provider state and closes any harness that exposes close(). */
export class ProviderRuntime {
  private closed = false;
  private readonly providers: readonly ActiveProvider[];

  constructor(providers: readonly ActiveProvider[]) {
    this.providers = providers;
  }

  active(): readonly ActiveProvider[] {
    return this.providers;
  }

  resolveModel(routeId: string): ResolvedProviderModel | undefined {
    const identity = decodeModelRoute(routeId);
    if (!identity || identity.preset !== undefined) {
      return undefined;
    }
    const provider = this.providers.find(({ descriptor }) => descriptor.id === identity.providerId);
    const model = findModel(provider?.models, identity);
    return provider && model ? { provider: provider.descriptor, model } : undefined;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await Promise.all(
      this.providers.map(async ({ harness }) => {
        if (harness && 'close' in harness && typeof harness.close === 'function') {
          await harness.close();
        }
      }),
    );
  }
}

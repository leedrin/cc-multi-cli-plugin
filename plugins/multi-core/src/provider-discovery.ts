import { encodeModelRoute } from './gateway/model-identity.ts';
import { PROVIDER_FACTS } from './gateway/provider-facts.ts';
import type {
  ModelDescriptor,
  ProviderDescriptor,
  ProviderDiscoveryContext,
} from './gateway/provider-registry.ts';
import { isRecord } from './gateway/record.ts';

export interface DiscoveryRegistry {
  list(): readonly { id: string }[];
  get?(providerId: string): Pick<ProviderDescriptor, 'availability' | 'discoverModels'> | undefined;
}

export type LauncherDiscoveryTable = Readonly<
  Record<string, (context: ProviderDiscoveryContext) => Promise<unknown>>
>;

function providerEnabled(
  providerId: string,
  enabledProviders: readonly string[] | undefined,
): boolean {
  return enabledProviders === undefined || enabledProviders.includes(providerId);
}

export function providerExplicit(
  providerId: string,
  enabledProviders: readonly string[] | undefined,
): boolean {
  return enabledProviders?.includes(providerId) ?? false;
}

function shouldInstallAntigravityHook(explicit: boolean, models: readonly unknown[]): boolean {
  return explicit && models.length > 0;
}

export async function discoverAntigravityWithHook<Models extends readonly unknown[]>(
  context: ProviderDiscoveryContext,
  discover: (context: ProviderDiscoveryContext) => Promise<Models>,
  installHook: () => Promise<void>,
): Promise<Models> {
  const models = await discover(context);
  if (shouldInstallAntigravityHook(context.explicit, models)) {
    await installHook();
  }
  return models;
}

type DiscoveryResults<Discoveries extends LauncherDiscoveryTable> = Partial<{
  [Id in keyof Discoveries]: Awaited<ReturnType<Discoveries[Id]>>;
}>;

function invalidModelField(model: unknown, providerId: string): string | undefined {
  if (!isRecord(model)) {
    return 'model';
  }
  const identity = model.identity;
  if (!isRecord(identity)) {
    return 'identity';
  }
  if (identity.providerId !== providerId) {
    return 'identity.providerId';
  }
  if (typeof identity.modelId !== 'string' || identity.modelId.length === 0) {
    return 'identity.modelId';
  }
  try {
    encodeModelRoute(providerId, identity.modelId);
  } catch {
    return 'identity.modelId';
  }
  if ('preset' in identity && typeof identity.preset !== 'string') {
    return 'identity.preset';
  }
  if (typeof model.label !== 'string' || model.label.length === 0) {
    return 'label';
  }
  if (!isRecord(model.capabilities)) {
    return 'capabilities';
  }
  return undefined;
}

function validateDiscoveredModels(models: unknown, providerId: string): readonly ModelDescriptor[] {
  const prefix = `Invalid discovered models for provider ${providerId}`;
  if (!Array.isArray(models)) {
    throw new Error(`${prefix}: models`);
  }
  for (const [index, model] of models.entries()) {
    const field = invalidModelField(model, providerId);
    if (field) {
      throw new Error(`${prefix}: models[${index}].${field}`);
    }
  }
  return models as readonly ModelDescriptor[];
}

async function discoverGenericProvider(
  registry: DiscoveryRegistry,
  id: string,
  providerContext: ProviderDiscoveryContext,
): Promise<readonly ModelDescriptor[]> {
  const descriptor = registry.get?.(id);
  if (!descriptor) {
    throw new Error(`Missing provider descriptor for registered provider: ${id}`);
  }
  const fact = PROVIDER_FACTS.find((candidate) => candidate.id === id);
  if (!fact) {
    throw new Error(`Missing provider facts for registered provider: ${id}`);
  }
  try {
    const availability = await descriptor.availability(providerContext);
    if (!availability.available) {
      if (providerContext.explicit) {
        providerContext.log(`${fact.label} unavailable: ${availability.reason ?? 'not available'}`);
      }
      return [];
    }
    return validateDiscoveredModels(await descriptor.discoverModels(providerContext), id);
  } catch (error) {
    if (providerContext.explicit) {
      const message = error instanceof Error ? error.message : String(error);
      providerContext.log(`${fact.label} discovery failed: ${message}`);
    }
    return [];
  }
}

/** Runs registered provider discovery through the launcher's typed provider table. */
export async function discoverEnabledProviders<const Discoveries extends LauncherDiscoveryTable>(
  registry: DiscoveryRegistry,
  enabledProviders: readonly string[] | undefined,
  discoveries: Discoveries,
  context: (providerId: string) => ProviderDiscoveryContext,
): Promise<DiscoveryResults<Discoveries>> {
  const providers = registry.list();
  const enabled = providers.filter(({ id }) => providerEnabled(id, enabledProviders));
  const results = await Promise.all(
    enabled.map(async ({ id }) => {
      const providerContext = context(id);
      const discover = discoveries[id];
      const result = discover
        ? await discover(providerContext)
        : await discoverGenericProvider(registry, id, providerContext);
      return [id, result] as const;
    }),
  );
  return Object.fromEntries(results) as DiscoveryResults<Discoveries> & Record<string, unknown>;
}

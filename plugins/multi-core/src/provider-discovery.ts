import type { ProviderDiscoveryContext } from './gateway/provider-registry.ts';

export interface DiscoveryRegistry {
  list(): readonly { id: string }[];
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

/** Runs registered provider discovery through the launcher's typed provider table. */
export async function discoverEnabledProviders<const Discoveries extends LauncherDiscoveryTable>(
  registry: DiscoveryRegistry,
  enabledProviders: readonly string[] | undefined,
  discoveries: Discoveries,
  context: (providerId: string) => ProviderDiscoveryContext,
): Promise<DiscoveryResults<Discoveries>> {
  const providers = registry.list();
  for (const { id } of providers) {
    if (!Object.hasOwn(discoveries, id)) {
      throw new Error(`No launcher discovery handler for registered provider: ${id}`);
    }
  }
  const enabled = providers.filter(({ id }) => providerEnabled(id, enabledProviders));
  const results = await Promise.all(
    enabled.map(async ({ id }) => {
      const discover = discoveries[id];
      if (!discover) {
        throw new Error(`No launcher discovery handler for registered provider: ${id}`);
      }
      return [id, await discover(context(id))] as const;
    }),
  );
  return Object.fromEntries(results) as DiscoveryResults<Discoveries>;
}

import type { ProviderDescriptor } from './provider-registry.ts';

function matchingEnvironmentKeys(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string[] {
  return Object.keys(env).filter((key) =>
    platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name,
  );
}

export function withoutProviderCredentials(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  options: { platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const removed = new Set(names.flatMap((name) => matchingEnvironmentKeys(env, name, platform)));
  return Object.fromEntries(Object.entries(env).filter(([key]) => !removed.has(key)));
}

export function takeProviderCredentials(
  env: NodeJS.ProcessEnv,
  descriptors: readonly Pick<ProviderDescriptor, 'credentialEnv'>[],
  options: { platform?: NodeJS.Platform } = {},
): Map<string, string> {
  const platform = options.platform ?? process.platform;
  const names = new Set(descriptors.flatMap(({ credentialEnv }) => credentialEnv ?? []));
  const credentials = new Map<string, string>();
  for (const name of names) {
    const matches = matchingEnvironmentKeys(env, name, platform);
    const key = matches.includes(name) ? name : matches[0];
    if (key === undefined) {
      continue;
    }
    const value = env[key];
    for (const match of matches) {
      delete env[match];
    }
    if (value !== undefined) {
      credentials.set(name, value);
    }
  }
  return credentials;
}

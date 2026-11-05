import type { ProviderDescriptor } from './provider-registry.ts';

export function takeProviderCredentials(
  env: NodeJS.ProcessEnv,
  descriptors: readonly Pick<ProviderDescriptor, 'credentialEnv'>[],
  options: { platform?: NodeJS.Platform } = {},
): Map<string, string> {
  const platform = options.platform ?? process.platform;
  const names = new Set(descriptors.flatMap(({ credentialEnv }) => credentialEnv ?? []));
  const credentials = new Map<string, string>();
  for (const name of names) {
    const matches = Object.keys(env).filter((key) =>
      platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name,
    );
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

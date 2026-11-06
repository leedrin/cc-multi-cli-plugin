import { antigravityProvider } from '../../../multi-antigravity/src/provider.ts';
import { cursorProvider } from '../../../multi-cursor/src/provider.ts';
import { grokProvider } from '../../../multi-grok/src/provider.ts';
import { bindOpenAIProvider, openaiProvider } from '../../../multi-openai/src/provider.ts';
import { bindPiProviders } from '../../../multi-pi/src/provider.ts';
import { bindZenProvider, zenProvider } from '../../../multi-zen/src/provider.ts';
import { type ProviderDescriptor, ProviderRegistry } from './provider-registry.ts';

export const BUILTIN_PROVIDERS: readonly ProviderDescriptor[] = [
  openaiProvider,
  zenProvider,
  cursorProvider,
  antigravityProvider,
  grokProvider,
  ...bindPiProviders(),
];

export interface BuiltinProviderCredentials {
  authFile?: string;
  zenKey?: string;
  deepseekKey?: string;
  piKeys?: Partial<Record<'deepseek' | 'zai' | 'zai-coding-cn' | 'strata', string>>;
  strataBaseUrl?: string;
}

export function registerBuiltinProviders(
  registry: ProviderRegistry,
  credentials: BuiltinProviderCredentials = {},
): void {
  registry.registerMany([
    bindOpenAIProvider(
      credentials.authFile === undefined ? {} : { authFile: credentials.authFile },
    ),
    bindZenProvider(credentials.zenKey === undefined ? {} : { apiKey: credentials.zenKey }),
    ...bindPiProviders(
      {
        ...credentials.piKeys,
        ...(credentials.deepseekKey === undefined ? {} : { deepseek: credentials.deepseekKey }),
      },
      { strataBaseUrl: credentials.strataBaseUrl },
    ),
    cursorProvider,
    antigravityProvider,
    grokProvider,
  ]);
}

export function createBuiltinRegistry(
  credentials: BuiltinProviderCredentials = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltinProviders(registry, credentials);
  return registry;
}

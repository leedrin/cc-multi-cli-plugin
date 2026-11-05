import { antigravityProvider } from '../../../multi-antigravity/src/provider.ts';
import { cursorProvider } from '../../../multi-cursor/src/provider.ts';
import { grokProvider } from '../../../multi-grok/src/provider.ts';
import { openaiProvider } from '../../../multi-openai/src/provider.ts';
import { zenProvider } from '../../../multi-zen/src/provider.ts';
import { type ProviderDescriptor, ProviderRegistry } from './provider-registry.ts';

export const BUILTIN_PROVIDERS: readonly ProviderDescriptor[] = [
  openaiProvider,
  zenProvider,
  cursorProvider,
  antigravityProvider,
  grokProvider,
];

export function registerBuiltinProviders(registry: ProviderRegistry): void {
  registry.registerMany(BUILTIN_PROVIDERS);
}

export function createBuiltinRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltinProviders(registry);
  return registry;
}

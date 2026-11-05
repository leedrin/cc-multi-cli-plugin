/** Static provider facts shared with Claude Mods hooks; keep this module host-free. */
// Listed worker names are reserved and recognized by Multi whether or not their plugin is installed.
interface ProviderFact {
  id:
    | 'openai'
    | 'zen'
    | 'cursor'
    | 'antigravity'
    | 'grok'
    | 'deepseek'
    | 'zai'
    | 'zai-coding-cn'
    | 'strata';
  plugin: 'openai' | 'zen' | 'cursor' | 'antigravity' | 'grok' | 'pi';
  kind: 'direct' | 'harness';
  worker: string;
  label: string;
  credentialEnv?: readonly string[];
}

export const PROVIDER_FACTS: readonly ProviderFact[] = [
  { id: 'openai', plugin: 'openai', kind: 'direct', worker: 'multi-openai', label: 'OpenAI' },
  {
    id: 'zen',
    plugin: 'zen',
    kind: 'direct',
    worker: 'multi-zen',
    label: 'Zen',
    credentialEnv: ['OPENCODE_API_KEY'],
  },
  { id: 'cursor', plugin: 'cursor', kind: 'harness', worker: 'multi-cursor', label: 'Cursor' },
  {
    id: 'antigravity',
    plugin: 'antigravity',
    kind: 'harness',
    worker: 'multi-antigravity',
    label: 'Antigravity',
  },
  { id: 'grok', plugin: 'grok', kind: 'harness', worker: 'multi-grok', label: 'Grok' },
  {
    id: 'deepseek',
    plugin: 'pi',
    kind: 'direct',
    worker: 'multi-deepseek',
    label: 'DeepSeek',
    credentialEnv: ['DEEPSEEK_API_KEY'],
  },
  { id: 'zai', plugin: 'pi', kind: 'direct', worker: 'multi-zai', label: 'Z.AI' },
  {
    id: 'zai-coding-cn',
    plugin: 'pi',
    kind: 'direct',
    worker: 'multi-zai-coding-cn',
    label: 'Z.AI Coding (CN)',
  },
  { id: 'strata', plugin: 'pi', kind: 'direct', worker: 'multi-strata', label: 'Strata' },
] as const;

export type ProviderId = (typeof PROVIDER_FACTS)[number]['id'];

export function providerPluginIds(): string[] {
  return [...new Set(PROVIDER_FACTS.map((fact) => fact.plugin))];
}

export function providersForPlugin(plugin: string): ProviderId[] {
  return PROVIDER_FACTS.filter((fact) => fact.plugin === plugin).map((fact) => fact.id);
}

export function isProviderWorker(type: unknown): boolean {
  return typeof type === 'string' && PROVIDER_FACTS.some((fact) => fact.worker === type);
}

export function providerOf(model: string | undefined): string | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  const match = /^multi\/([^/]+)\/.+$/.exec(model);
  return match && PROVIDER_FACTS.some((fact) => fact.id === match[1]) ? match[1] : undefined;
}

export function isHarnessProvider(provider: unknown): boolean {
  return (
    typeof provider === 'string' &&
    PROVIDER_FACTS.some((fact) => fact.id === provider && fact.kind === 'harness')
  );
}

export function isHarnessModel(model: string | undefined): boolean {
  return PROVIDER_FACTS.some(
    (fact) => fact.kind === 'harness' && model?.startsWith(`multi/${fact.id}/`),
  );
}

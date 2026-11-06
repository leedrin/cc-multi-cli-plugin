// The one place that reads a model ID's provider prefix. Every routing, review,
// signal and execution decision derives from `providerOf`.

import { BUILTIN_PROVIDERS } from './builtin-providers.ts';
import { decodeModelRoute } from './model-identity.ts';

export type HarnessProvider = 'cursor' | 'antigravity' | 'grok';
export type ProviderName = HarnessProvider | 'openai' | 'zen';
export type ProviderRoute = ProviderName | 'anthropic';

function builtinProviders() {
  return BUILTIN_PROVIDERS;
}

function providerNames(): readonly ProviderName[] {
  return builtinProviders().map(({ id }) => id) as readonly ProviderName[];
}

const HARNESS_PROVIDERS: readonly HarnessProvider[] = ['cursor', 'antigravity', 'grok'];

/** The provider whose `multi/<provider>/` prefix the model carries, if any. */
function providerOf(model: unknown): ProviderName | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  return providerNames().find((provider) => model.startsWith(`multi/${provider}/`));
}

export function isHarnessProvider(provider: string | undefined): provider is HarnessProvider {
  return HARNESS_PROVIDERS.some((name) => name === provider);
}

/** The native harness that runs the model's actions itself. */
export function harnessProvider(model: unknown): HarnessProvider | undefined {
  const provider = providerOf(model);
  return isHarnessProvider(provider) ? provider : undefined;
}

export class UnknownProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Unknown provider "${provider}".`);
    this.provider = provider;
    this.name = 'UnknownProviderError';
  }
}

export type ModelRouteClassification =
  | { kind: 'anthropic' }
  | { kind: 'provider'; route: ProviderRoute }
  | { kind: 'unknown'; provider: string };

/** Classify a model without throwing, including unknown encoded provider IDs. */
export function classifyModelRoute(model: string | null | undefined): ModelRouteClassification {
  if (!model) {
    return { kind: 'anthropic' };
  }
  const known = providerOf(model);
  if (known) {
    return { kind: 'provider', route: known };
  }
  const identity = decodeModelRoute(model);
  return identity
    ? { kind: 'unknown', provider: identity.providerId }
    : { kind: 'provider', route: 'openai' };
}

/** Route recognized provider models; unknown encoded providers are never sent to OpenAI. */
export function providerRoute(model: string | null | undefined): ProviderRoute {
  const classification = classifyModelRoute(model);
  if (classification.kind === 'unknown') {
    throw new UnknownProviderError(classification.provider);
  }
  return classification.kind === 'provider' ? classification.route : 'anthropic';
}

/** Claude's context tag is display metadata, never part of a native model ID. */
export function nativeSpelling(model: string | undefined): string | undefined {
  return model?.replace(/\[1m\]$/i, '');
}

/** The upstream a harness bills through, reported on its completion events. */
export function harnessEndpoint(provider: HarnessProvider): string {
  return { cursor: '@cursor/sdk', antigravity: 'agy', grok: 'grok' }[provider];
}

/** What a request for a harness the gateway does not run is told. */
function builtinProvider(id: ProviderName) {
  const descriptor = builtinProviders().find((provider) => provider.id === id);
  if (!descriptor) {
    throw new Error(`Missing built-in provider descriptor: ${id}`);
  }
  return descriptor;
}

export const harnessUnavailable: Record<HarnessProvider, string> = {
  get cursor() {
    return builtinProvider('cursor').unavailableMessage;
  },
  get antigravity() {
    return builtinProvider('antigravity').unavailableMessage;
  },
  get grok() {
    return builtinProvider('grok').unavailableMessage;
  },
};

export type AutoReviewPolicy = { review: 'reviewer' | 'harness' | 'none'; statement: string };
export const PROVIDER_AUTO_REVIEW: Record<ProviderName, AutoReviewPolicy> = {
  get openai() {
    return builtinProvider('openai').autoReview;
  },
  get zen() {
    return builtinProvider('zen').autoReview;
  },
  get cursor() {
    return builtinProvider('cursor').autoReview;
  },
  get antigravity() {
    return builtinProvider('antigravity').autoReview;
  },
  get grok() {
    return builtinProvider('grok').autoReview;
  },
};

export function autoReviewPolicy(
  policy: AutoReviewPolicy,
  reviewerAvailable: boolean,
  unavailableStatement = 'no auto mode: actions run unreviewed',
): AutoReviewPolicy {
  return policy.review === 'reviewer' && !reviewerAvailable
    ? { review: 'none', statement: unavailableStatement }
    : policy;
}

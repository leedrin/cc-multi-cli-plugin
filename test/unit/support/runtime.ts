import { createBuiltinRegistry } from '../../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { NativeHarness } from '../../../plugins/multi-core/src/gateway/native-harness.ts';
import {
  type ActiveProvider,
  type ProviderRegistry,
  ProviderRuntime,
} from '../../../plugins/multi-core/src/gateway/provider-registry.ts';
import type { ProviderUsageReader } from '../../../plugins/multi-core/src/gateway/provider-usage.ts';
import {
  createNativeGateway as createGateway,
  type GatewayOptions as NativeGatewayOptions,
} from '../../../plugins/multi-core/src/gateway/server.ts';
import type { Reviewer } from '../../../plugins/multi-core/src/gateway/verdicts.ts';

type ProviderId = 'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok';
type HarnessId = 'cursor' | 'antigravity' | 'grok';

export type GatewayEvent = import('../../../plugins/multi-core/src/gateway/server.ts').GatewayEvent;
export type GatewayOptions = Omit<NativeGatewayOptions, 'runtime'> & {
  authFile?: string;
  zen?: { apiKey: string };
  cursor?: NativeHarness;
  antigravity?: NativeHarness;
  grok?: NativeHarness;
  reviewers?: Partial<Record<'openai', Reviewer>>;
  usageReaders?: Partial<Record<ProviderId, ProviderUsageReader>>;
  registry?: ProviderRegistry;
};

function createRuntime(options: GatewayOptions): ProviderRuntime {
  const registry =
    options.registry ??
    createBuiltinRegistry({ authFile: options.authFile, zenKey: options.zen?.apiKey });
  const harnesses: Partial<Record<HarnessId, NativeHarness>> = {
    cursor: options.cursor,
    antigravity: options.antigravity,
    grok: options.grok,
  };
  const active: ActiveProvider[] = [];
  for (const descriptor of registry.list()) {
    const provider = activeProvider(descriptor, options, harnesses);
    if (provider) {
      active.push(provider);
    }
  }
  return new ProviderRuntime(active, { registry });
}

function activeProvider(
  descriptor: ActiveProvider['descriptor'],
  options: GatewayOptions,
  harnesses: Partial<Record<HarnessId, NativeHarness>>,
): ActiveProvider | undefined {
  const id = descriptor.id as ProviderId;
  const harness = harnesses[id as HarnessId];
  const usage = options.usageReaders?.[id];
  const active = id === 'openai' || (id === 'zen' && (options.zen || usage || options.registry));
  if (!active && !harness && !usage) {
    return undefined;
  }
  const reviewer = id === 'openai' ? options.reviewers?.openai : undefined;
  return {
    descriptor,
    models: [],
    ...(harness ? { harness } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function createNativeGateway(options: GatewayOptions) {
  const {
    authFile: _authFile,
    zen: _zen,
    cursor: _cursor,
    antigravity: _antigravity,
    grok: _grok,
    reviewers: _reviewers,
    usageReaders: _usageReaders,
    registry: _registry,
    ...gatewayOptions
  } = options;
  return createGateway({ ...gatewayOptions, runtime: createRuntime(options) });
}

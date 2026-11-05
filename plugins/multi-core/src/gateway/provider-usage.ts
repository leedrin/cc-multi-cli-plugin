import type { ContextUsage, UsageSnapshot } from './receipts.ts';
import {
  addCanonicalUsage,
  type CanonicalTokenUsage,
  cacheReadRatio,
  createUsageAccumulator,
  serializeUsageTotals,
  type UsageSource,
  type UsageTotalsV2,
} from './usage-accounting.ts';

const USAGE_ROWS = [
  {
    id: 'openai',
    name: 'OpenAI / Codex',
    url: 'https://chatgpt.com/codex/settings/usage',
    unavailable: ['Sign in with codex login to read account quota windows.'],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    url: 'https://cursor.com/dashboard?tab=usage',
    unavailable: ['Sign in with the Cursor SDK to read subscription quota.'],
  },
  {
    id: 'zen',
    name: 'OpenCode Zen',
    url: 'https://opencode.ai/zen',
    unavailable: [
      'Go subscription quota requires a supported Zen API key.',
      'Check the Zen billing console for credits and charges.',
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    unavailable: [
      'Native Antigravity account quota could not be retrieved.',
      'Run /usage or /credits inside agy to view your account.',
    ],
  },
  {
    id: 'grok',
    name: 'Grok Build',
    url: 'https://x.ai/build',
    unavailable: [
      'Grok Build exposes no account quota; per-run cost appears in session receipts.',
      'Run grok login if the browser credential has expired.',
    ],
  },
] as const;
type UsageProvider = (typeof USAGE_ROWS)[number]['id'];
type UsageProviderId = string;
interface ProviderUsageRow {
  id: UsageProviderId;
  name: string;
  status: 'ready' | 'unavailable' | 'disabled' | 'error';
  summary: string;
  details: string[];
  url?: string;
  /** This session's usage for the provider, absent before its first request. */
  session?: ProviderSessionUsage;
}
export interface ProviderUsageView {
  updatedAt: string;
  providers: ProviderUsageRow[];
}
export interface ProviderUsageOptions extends Partial<Record<UsageProvider, ProviderUsageReader>> {
  enabled: readonly string[];
  extraRows?: readonly { id: string; name: string }[];
  extraReaders?: Readonly<Record<string, ProviderUsageReader>>;
  now?: () => number;
}
export type ProviderUsageReader = (session: string) => Promise<{
  summary: string;
  details: string[];
  status?: ProviderUsageRow['status'];
}>;
/** What a provider's requests in one session reported, structured so a UI never parses text. */
interface ProviderSessionUsage {
  requests: number;
  /** The model calls a harness made, when it identified them. */
  modelCalls?: number;
  source: UsageSource;
  /** The last response's live context. */
  context?: ContextUsage;
  /** What the session's requests consumed. */
  consumed: UsageTotalsV2;
}

function canonicalOf(totals: UsageTotalsV2): CanonicalTokenUsage {
  return {
    source: totals.source,
    ...(totals.input_tokens === undefined ? {} : { inputTokens: totals.input_tokens }),
    ...(totals.output_tokens === undefined ? {} : { outputTokens: totals.output_tokens }),
    ...(totals.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: totals.cache_read_input_tokens }),
    ...(totals.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: totals.cache_creation_input_tokens }),
    ...(totals.reasoning_tokens === undefined ? {} : { reasoningTokens: totals.reasoning_tokens }),
    ...(totals.total_tokens === undefined ? {} : { totalTokens: totals.total_tokens }),
    ...(totals.model_calls === undefined ? {} : { modelCalls: totals.model_calls }),
  };
}

/** One provider's session usage from the ledger snapshot, or nothing before its first request. */
function sessionUsage(
  snapshot: UsageSnapshot,
  provider: UsageProviderId,
): ProviderSessionUsage | undefined {
  const entries = snapshot.entries.filter((entry) => entry.provider === provider);
  if (entries.length === 0) {
    return undefined;
  }
  const accumulator = createUsageAccumulator();
  let requests = 0;
  for (const entry of entries) {
    requests += entry.requests;
    addCanonicalUsage(accumulator, canonicalOf(entry.usage));
  }
  const consumed = serializeUsageTotals(accumulator);
  const context = snapshot.contexts?.[provider];
  return {
    requests,
    ...(consumed.model_calls === undefined ? {} : { modelCalls: consumed.model_calls }),
    source: consumed.source,
    ...(context ? { context } : {}),
    consumed,
  };
}

type Counts = Pick<
  UsageTotalsV2,
  | 'input_tokens'
  | 'cache_read_input_tokens'
  | 'cache_creation_input_tokens'
  | 'output_tokens'
  | 'reasoning_tokens'
  | 'total_tokens'
>;

const CONTEXT_FIELDS = [
  ['input_tokens', 'input'],
  ['cache_read_input_tokens', 'cache read'],
  ['cache_creation_input_tokens', 'cache write'],
] as const;
const CONSUMED_FIELDS = [
  ...CONTEXT_FIELDS,
  ['output_tokens', 'output'],
  ['reasoning_tokens', 'reasoning'],
  ['total_tokens', 'total'],
] as const;

const count = (value: number) => value.toLocaleString('en-US');

/** The counts that were reported; in a mixed total they are what is known, not the whole. */
function countParts(
  source: UsageSource,
  counts: Counts,
  fields: ReadonlyArray<readonly [keyof Counts, string]>,
): string[] {
  return fields.flatMap(([key, label]) => {
    const value = counts[key];
    if (value === undefined) {
      return [];
    }
    return [source === 'mixed' ? `known ${label} ${count(value)}` : `${count(value)} ${label}`];
  });
}

/** Shown for a provider or estimated total only: a mixed or unavailable one has no sound ratio. */
function ratioPart(source: UsageSource, counts: Counts): string[] {
  if (source !== 'provider' && source !== 'estimate') {
    return [];
  }
  const ratio = cacheReadRatio({
    inputTokens: counts.input_tokens,
    cacheReadTokens: counts.cache_read_input_tokens,
    cacheWriteTokens: counts.cache_creation_input_tokens,
  });
  if (ratio === undefined) {
    return [];
  }
  const percent = `${(ratio * 100).toFixed(1)}%`;
  return [`prompt cache read ratio ${source === 'estimate' ? `~${percent} (estimated)` : percent}`];
}

function contextLine(context: ContextUsage | undefined): string[] {
  if (!context) {
    return [];
  }
  if (context.source === 'unavailable') {
    return ['Context: usage unavailable'];
  }
  const parts = [
    ...countParts(context.source, context, CONTEXT_FIELDS),
    ...ratioPart(context.source, context),
  ];
  return parts.length > 0 ? [`Context: ${parts.join(' · ')}`] : [];
}

function consumedLine(consumed: UsageTotalsV2): string[] {
  if (consumed.source === 'unavailable') {
    return ['Consumed: usage unavailable'];
  }
  const parts = countParts(consumed.source, consumed, CONSUMED_FIELDS);
  return parts.length > 0 ? [`Consumed: ${parts.join(' · ')}`] : [];
}

function sessionLines(session: ProviderSessionUsage | undefined): string[] {
  if (!session) {
    return ['This session: 0 completed requests'];
  }
  const calls =
    session.modelCalls === undefined ? '' : ` · ${count(session.modelCalls)} model calls`;
  return [
    `This session: ${count(session.requests)} completed requests${calls}`,
    ...contextLine(session.context),
    ...consumedLine(session.consumed),
    `Source: ${session.source}`,
    ...(session.source === 'mixed'
      ? ['Some requests did not report complete token telemetry.']
      : []),
  ];
}
/** Read-only account lookups are cached and coalesced independently of model requests. */
export class ProviderUsageDashboard {
  private readonly cache = new Map<string, { expires: number; view: ProviderUsageView }>();
  private readonly pending = new Map<string, Promise<ProviderUsageView>>();
  private readonly now: () => number;
  private readonly options: ProviderUsageOptions;
  constructor(options: ProviderUsageOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async read(
    session: string,
    snapshot: UsageSnapshot,
    refresh = false,
  ): Promise<ProviderUsageView> {
    const active = this.pending.get(session);
    if (active) {
      return this.withSession(await active, snapshot);
    }
    const saved = this.cache.get(session);
    if (!refresh && saved && saved.expires > this.now()) {
      return this.withSession(saved.view, snapshot);
    }
    if (this.pending.size >= 32) {
      throw new Error('Too many simultaneous usage queries');
    }
    const request = this.collect(session);
    this.pending.set(session, request);
    try {
      const view = await request;
      if (this.cache.size >= 32) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) {
          this.cache.delete(oldest);
        }
      }
      this.cache.set(session, { expires: this.now() + 30000, view });
      return this.withSession(view, snapshot);
    } finally {
      this.pending.delete(session);
    }
  }

  private async collect(session: string): Promise<ProviderUsageView> {
    const providers: Array<{
      id: string;
      name: string;
      url?: string;
      unavailable: readonly string[];
    }> = [
      ...USAGE_ROWS,
      ...(this.options.extraRows ?? []).map(({ id, name }) => ({
        id,
        name,
        unavailable: [
          `${name} reports no account quota; per-run usage appears in session receipts.`,
        ],
      })),
    ];
    const rows = await Promise.all(
      providers.map(async (provider): Promise<ProviderUsageRow> => {
        const row: ProviderUsageRow = {
          id: provider.id,
          name: provider.name,
          ...('url' in provider ? { url: provider.url } : {}),
          status: 'unavailable',
          summary: 'Account usage unavailable',
          details: [...provider.unavailable],
        };
        if (!this.options.enabled.includes(provider.id)) {
          return {
            ...row,
            status: 'disabled',
            summary: 'Not enabled in this launcher',
            details: [],
          };
        }
        const reader =
          this.options.extraReaders?.[provider.id] ?? this.options[provider.id as UsageProvider];
        if (!reader) {
          return row;
        }
        try {
          const data = await reader(session);
          return { ...row, status: 'ready', ...data };
        } catch {
          return {
            ...row,
            status: 'error',
            summary: 'Could not refresh provider usage',
            details: ['Check the provider login or connection, then refresh.', ...row.details],
          };
        }
      }),
    );
    return { updatedAt: new Date(this.now()).toISOString(), providers: rows };
  }

  private withSession(view: ProviderUsageView, snapshot: UsageSnapshot): ProviderUsageView {
    return {
      ...view,
      providers: view.providers.map((row) => {
        const session = sessionUsage(snapshot, row.id);
        return {
          ...row,
          details: [...row.details, ...sessionLines(session)],
          ...(session ? { session } : {}),
        };
      }),
    };
  }
}

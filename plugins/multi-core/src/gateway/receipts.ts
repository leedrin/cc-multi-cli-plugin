import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import type { MessagesResponse } from './messages.ts';
import type { GatewayEvent } from './server.ts';
import {
  addCanonicalUsage,
  type CanonicalTokenUsage,
  cacheReadRatio,
  createUsageAccumulator,
  serializeUsageTotals,
  type UsageAccumulator,
  type UsageSource,
  type UsageTotalsV2,
} from './usage-accounting.ts';

const RECEIPT_SCHEMA_VERSION = 2;

type UsageMetadata = NonNullable<MessagesResponse['multi_usage']>;
type InvocationEvent = GatewayEvent & {
  invocationId?: string;
  requestId?: string;
};

export type ReceiptOutcome = 'completed' | 'failed' | 'cancelled';

export interface InvocationRef {
  session?: string;
  agentId?: string | null;
  invocationId?: string;
}

/**
 * Spend: what the requests consumed, as totals that keep what was never reported
 * out of the record. A harness turn's standard usage fields carry its last model
 * call (its live context), so its consumption comes from the `consumed_*` fields.
 */
type UsageTotals = UsageTotalsV2;

/**
 * The live context the last response reported: its input side, as Claude Code
 * reads it. An unavailable response is `{ source: 'unavailable' }`, never zeros.
 */
interface ContextUsage {
  source: UsageSource;
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_ratio?: number;
}

export interface UsageSnapshot {
  requests: number;
  totals: UsageTotals;
  /** The last response's context per provider. */
  contexts?: Partial<Record<GatewayEvent['route'], ContextUsage>>;
  byModel: Record<string, UsageTotals>;
  byEffort: Record<string, UsageTotals>;
  byEndpoint: Record<string, UsageTotals>;
  entries: UsageEntry[];
  truncated?: boolean;
}

interface UsageEntry {
  provider: GatewayEvent['route'];
  requests: number;
  model?: string;
  effort?: string;
  endpoint?: string;
  source: UsageSource;
  usage: UsageTotals;
}

/** A durable worker invocation summary. It contains no prompts, tool inputs, or credentials. */
export interface WorkerUsageReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  id: string;
  kind: 'worker-usage';
  provenance: 'gateway';
  time: string;
  startedAt: string;
  outcome: ReceiptOutcome;
  session?: string;
  agentId: string | null;
  invocationId?: string;
  requests: number;
  incomplete?: boolean;
  usage: UsageTotals;
  /** The invocation's last response's context, beside what it consumed. */
  context?: ContextUsage;
  byModel: Record<string, UsageTotals>;
  byEffort: Record<string, UsageTotals>;
  byEndpoint: Record<string, UsageTotals>;
  entries: UsageEntry[];
  truncated?: boolean;
}

export interface ReceiptLedgerOptions {
  file?: string;
  append?: (file: string, line: string) => Promise<void>;
  now?: () => Date;
  onError?: (error: unknown) => void;
  maxInvocations?: number;
  writer?: (line: string) => Promise<void>;
  maxRecent?: number;
}

/** The ledger's working state: accumulators, so a count nobody reported stays unknown. */
interface SnapshotState {
  requests: number;
  totals: UsageAccumulator;
  contexts?: Partial<Record<GatewayEvent['route'], ContextUsage>>;
  byModel: Record<string, UsageAccumulator>;
  byEffort: Record<string, UsageAccumulator>;
  byEndpoint: Record<string, UsageAccumulator>;
  entries: EntryState[];
  truncated?: boolean;
}

interface EntryState extends Omit<UsageEntry, 'usage'> {
  usage: UsageAccumulator;
}

interface PendingInvocation {
  ref: InvocationRef;
  state: SnapshotState;
  startedAt: string;
  context?: ContextUsage;
}

function emptyState(): SnapshotState {
  return {
    requests: 0,
    totals: createUsageAccumulator(),
    byModel: {},
    byEffort: {},
    byEndpoint: {},
    entries: [],
  };
}

function keyFor(ref: InvocationRef): string {
  return JSON.stringify([ref.session ?? null, ref.agentId ?? null]);
}

function serializeBreakdown(
  breakdown: Record<string, UsageAccumulator>,
): Record<string, UsageTotals> {
  return Object.fromEntries(
    Object.entries(breakdown).map(([name, totals]) => [name, serializeUsageTotals(totals)]),
  );
}

function serializeState(state: SnapshotState): UsageSnapshot {
  return {
    requests: state.requests,
    totals: serializeUsageTotals(state.totals),
    byModel: serializeBreakdown(state.byModel),
    byEffort: serializeBreakdown(state.byEffort),
    byEndpoint: serializeBreakdown(state.byEndpoint),
    entries: state.entries.map((entry) => ({ ...entry, usage: serializeUsageTotals(entry.usage) })),
    ...(state.contexts ? { contexts: structuredClone(state.contexts) } : {}),
    ...(state.truncated ? { truncated: true } : {}),
  };
}

function addBreakdown(
  breakdown: Record<string, UsageAccumulator>,
  name: string | undefined,
  usage: CanonicalTokenUsage,
) {
  if (!name) {
    return;
  }
  if (!Object.hasOwn(breakdown, name) && Object.keys(breakdown).length >= 256) {
    return;
  }
  const totals = Object.hasOwn(breakdown, name) ? breakdown[name] : createUsageAccumulator();
  addCanonicalUsage(totals, usage);
  breakdown[name] = totals;
}

/** The accounting block, read back as canonical usage; an absent count stays unknown. */
function fromAccountingMetadata(
  source: UsageSource,
  accounting: NonNullable<UsageMetadata['accounting']>,
): CanonicalTokenUsage {
  return {
    source,
    ...(accounting.input_tokens === undefined ? {} : { inputTokens: accounting.input_tokens }),
    ...(accounting.output_tokens === undefined ? {} : { outputTokens: accounting.output_tokens }),
    ...(accounting.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: accounting.cache_read_input_tokens }),
    ...(accounting.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: accounting.cache_creation_input_tokens }),
    ...(accounting.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: accounting.reasoning_tokens }),
    ...(accounting.total_tokens === undefined ? {} : { totalTokens: accounting.total_tokens }),
  };
}

/** A provider that has not moved to the accounting block: its standard usage and flat extras. */
function legacyAccounting(
  source: UsageSource,
  usage: NonNullable<GatewayEvent['usage']>,
  metadata: UsageMetadata | undefined,
): CanonicalTokenUsage {
  return {
    source,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : { cacheReadTokens: usage.cache_read_input_tokens }),
    ...(usage.cache_creation_input_tokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cache_creation_input_tokens }),
    ...(metadata?.reasoning_tokens === undefined
      ? {}
      : { reasoningTokens: metadata.reasoning_tokens }),
    ...(metadata?.total_tokens === undefined ? {} : { totalTokens: metadata.total_tokens }),
  };
}

/**
 * What the response reported. An unavailable response reports nothing: the
 * protocol's zeros for it are placeholders and never counted.
 */
function reported(event: InvocationEvent): CanonicalTokenUsage {
  const metadata = event.usageMetadata;
  const source = metadata?.source ?? 'unavailable';
  if (source === 'unavailable' || !event.usage) {
    return { source: 'unavailable' };
  }
  return metadata?.accounting
    ? fromAccountingMetadata(source, metadata.accounting)
    : legacyAccounting(source, event.usage, metadata);
}

/** What one response consumed: the harness's turn sums replace the reported counts when present. */
function spend(event: InvocationEvent): CanonicalTokenUsage {
  const usage = reported(event);
  if (usage.source === 'unavailable') {
    return usage;
  }
  const metadata = event.usageMetadata;
  return {
    ...usage,
    ...(metadata?.consumed_input_tokens === undefined
      ? {}
      : { inputTokens: metadata.consumed_input_tokens }),
    ...(metadata?.consumed_output_tokens === undefined
      ? {}
      : { outputTokens: metadata.consumed_output_tokens }),
    ...(metadata?.consumed_cache_read_tokens === undefined
      ? {}
      : { cacheReadTokens: metadata.consumed_cache_read_tokens }),
    ...(metadata?.consumed_cache_creation_tokens === undefined
      ? {}
      : { cacheWriteTokens: metadata.consumed_cache_creation_tokens }),
    ...(metadata?.model_calls === undefined ? {} : { modelCalls: metadata.model_calls }),
  };
}

/** The live context one response reported: its own counts, never a harness turn's sums. */
function contextOf(event: InvocationEvent): ContextUsage {
  const usage = reported(event);
  if (usage.source === 'unavailable') {
    return { source: 'unavailable' };
  }
  const ratio = usage.source === 'provider' ? cacheReadRatio(usage) : undefined;
  return {
    source: usage.source,
    ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cache_creation_input_tokens: usage.cacheWriteTokens }),
    ...(ratio === undefined ? {} : { cache_read_ratio: ratio }),
  };
}

function aggregate(state: SnapshotState, event: InvocationEvent) {
  const usage = spend(event);
  state.contexts = { ...state.contexts, [event.route]: contextOf(event) };
  state.requests++;
  addCanonicalUsage(state.totals, usage);
  addBreakdown(state.byModel, event.model, usage);
  addBreakdown(state.byEffort, event.effort, usage);
  addBreakdown(state.byEndpoint, event.endpoint, usage);
  const source = usage.source;
  const entry = state.entries.find(
    (item) =>
      item.provider === event.route &&
      item.model === event.model &&
      item.effort === event.effort &&
      item.endpoint === event.endpoint &&
      item.source === source,
  );
  if (entry) {
    entry.requests++;
    addCanonicalUsage(entry.usage, usage);
  } else if (state.entries.length < 256) {
    const totals = createUsageAccumulator();
    addCanonicalUsage(totals, usage);
    state.entries.push({
      provider: event.route,
      requests: 1,
      model: event.model,
      effort: event.effort,
      endpoint: event.endpoint,
      source,
      usage: totals,
    });
  } else {
    state.truncated = true;
  }
}

/** One gateway owns this ledger; persisted lines never contain prompt or credential data. */
export class ReceiptLedger {
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly sessions = new Map<string, SnapshotState>();
  private readonly completed: WorkerUsageReceipt[] = [];
  private readonly completedKeys = new Set<string>();
  private readonly seenRequests = new Set<string>();
  private readonly total = emptyState();
  private readonly maxInvocations: number;
  private readonly maxRecent: number;
  private readonly writeLine: (line: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly onError: (error: unknown) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: ReceiptLedgerOptions = {}) {
    const append =
      options.append ?? ((file: string, line: string) => appendFile(file, line, { mode: 0o600 }));
    const file = options.file;
    this.writeLine = options.writer ?? (file ? (line) => append(file, line) : async () => {});
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? (() => {});
    this.maxInvocations = Math.max(1, options.maxInvocations ?? 512);
    this.maxRecent = Math.max(1, options.maxRecent ?? 128);
  }

  start(ref: InvocationRef): void {
    if (this.pending.has(keyFor(ref))) {
      return;
    }
    if (this.pending.size >= this.maxInvocations) {
      const oldest = this.pending.values().next().value;
      if (oldest) {
        this.complete(oldest.ref, 'failed', true);
      }
    }
    this.pending.set(keyFor(ref), {
      ref,
      state: emptyState(),
      startedAt: this.now().toISOString(),
    });
  }

  observe(event: InvocationEvent): void {
    if (!event.usage || event.usageMetadata?.replayed) {
      return;
    }
    if (event.requestId && this.seenRequests.has(event.requestId)) {
      return;
    }
    if (event.requestId) {
      retain(this.seenRequests, event.requestId);
    }
    this.start(event);
    const pending = this.pending.get(keyFor(event));
    if (!pending) {
      return;
    }
    aggregate(pending.state, event);
    pending.context = contextOf(event);
    aggregate(this.total, event);
    const session = event.session ?? '';
    if (!this.sessions.has(session)) {
      if (this.sessions.size >= 128) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) {
          this.sessions.delete(oldest);
        }
      }
      this.sessions.set(session, emptyState());
    }
    const state = this.sessions.get(session);
    if (state) {
      aggregate(state, event);
    }
  }

  complete(
    ref: InvocationRef,
    outcome: ReceiptOutcome,
    incomplete = false,
  ): WorkerUsageReceipt | undefined {
    const dedup = JSON.stringify([keyFor(ref), ref.invocationId]);
    if (ref.invocationId && this.completedKeys.has(dedup)) {
      return undefined;
    }
    const pending = this.pending.get(keyFor(ref));
    if (!pending) {
      return undefined;
    }
    this.pending.delete(keyFor(ref));
    if (ref.invocationId) {
      retain(this.completedKeys, dedup);
    }
    const snapshot = serializeState(pending.state);
    const receipt: WorkerUsageReceipt = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      id: randomUUID(),
      kind: 'worker-usage',
      provenance: 'gateway',
      time: this.now().toISOString(),
      startedAt: pending.startedAt,
      outcome,
      session: ref.session,
      agentId: ref.agentId ?? null,
      invocationId: ref.invocationId,
      requests: snapshot.requests,
      incomplete: incomplete || outcome !== 'completed' || snapshot.truncated || undefined,
      usage: snapshot.totals,
      ...(pending.context ? { context: { ...pending.context } } : {}),
      byModel: snapshot.byModel,
      byEffort: snapshot.byEffort,
      byEndpoint: snapshot.byEndpoint,
      entries: snapshot.entries,
    };
    this.completed.push(receipt);
    if (this.completed.length > this.maxRecent) {
      this.completed.shift();
    }
    const line = `${JSON.stringify(receipt)}\n`;
    this.queue = this.queue
      .then(() => this.writeLine(line))
      .catch((error: unknown) => {
        this.onError(error);
      });
    return structuredClone(receipt);
  }

  finishAll(outcome: ReceiptOutcome = 'cancelled'): void {
    for (const pending of [...this.pending.values()]) {
      this.complete(pending.ref, outcome, true);
    }
  }

  snapshot(session?: string): UsageSnapshot {
    return serializeState(
      session === undefined ? this.total : (this.sessions.get(session) ?? emptyState()),
    );
  }

  recent(session: string): WorkerUsageReceipt[] {
    return structuredClone(this.completed.filter((receipt) => receipt.session === session));
  }

  drain(): Promise<void> {
    return this.queue;
  }
}

function retain(set: Set<string>, key: string) {
  set.add(key);
  if (set.size > 8192) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

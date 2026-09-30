/**
 * Canonical token accounting shared by every provider's usage path.
 *
 * A field that is `undefined` is unknown; `0` is a provider's explicit report of zero. Nothing
 * here may turn the first into the second: the only place a placeholder zero belongs is the
 * Anthropic-compatible protocol usage, which is built elsewhere.
 */

export type UsageSource = 'provider' | 'estimate' | 'mixed' | 'unavailable';

export interface CanonicalTokenUsage {
  source: UsageSource;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** The model calls a harness turn made, when the harness identifies them. */
  modelCalls?: number;
  cacheReadRatio?: number;
}

/** What one or many responses consumed. A field nobody reported is left out. */
export interface UsageTotalsV2 {
  source: UsageSource;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
  total_tokens?: number;
  model_calls?: number;
  cache_read_ratio?: number;
}

/** Sums with a known flag per field, so a total of nothing is not mistaken for zero. */
export interface UsageAccumulator {
  /** Unset until the first usage is added; merging starts from that usage's source. */
  source?: UsageSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelCalls: number;
  known: {
    input: boolean;
    output: boolean;
    cacheRead: boolean;
    cacheWrite: boolean;
    reasoning: boolean;
    total: boolean;
    modelCalls: boolean;
  };
}

export function createUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    known: {
      input: false,
      output: false,
      cacheRead: false,
      cacheWrite: false,
      reasoning: false,
      total: false,
      modelCalls: false,
    },
  };
}

/**
 * The share of the prompt served from cache, weighted by tokens:
 * cache read / (uncached input + cache read + cache write).
 *
 * It needs the uncached input and cache read counts. A cache write count that was not
 * reported adds nothing to the denominator rather than being assumed zero.
 */
export function cacheReadRatio(
  usage: Pick<CanonicalTokenUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>,
): number | undefined {
  const { inputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (inputTokens === undefined || cacheReadTokens === undefined) {
    return undefined;
  }
  const denominator = inputTokens + cacheReadTokens + (cacheWriteTokens ?? 0);
  return denominator > 0 ? cacheReadTokens / denominator : undefined;
}

/** Equal sources stay; different ones, or any `mixed`, become `mixed`. */
export function mergeUsageSource(a: UsageSource, b: UsageSource): UsageSource {
  return a === b ? a : 'mixed';
}

export function addCanonicalUsage(accumulator: UsageAccumulator, usage: CanonicalTokenUsage) {
  accumulator.source =
    accumulator.source === undefined
      ? usage.source
      : mergeUsageSource(accumulator.source, usage.source);
  const fields = [
    ['input', 'inputTokens', usage.inputTokens],
    ['output', 'outputTokens', usage.outputTokens],
    ['cacheRead', 'cacheReadTokens', usage.cacheReadTokens],
    ['cacheWrite', 'cacheWriteTokens', usage.cacheWriteTokens],
    ['reasoning', 'reasoningTokens', usage.reasoningTokens],
    ['total', 'totalTokens', usage.totalTokens],
    ['modelCalls', 'modelCalls', usage.modelCalls],
  ] as const;
  for (const [flag, sum, value] of fields) {
    if (value !== undefined) {
      accumulator[sum] += value;
      accumulator.known[flag] = true;
    }
  }
}

/** The accumulator's ratio: only a provider total, and only from counts it actually saw. */
function totalsRatio(accumulator: UsageAccumulator): number | undefined {
  const { known } = accumulator;
  if (accumulator.source !== 'provider') {
    return undefined;
  }
  return cacheReadRatio({
    ...(known.input ? { inputTokens: accumulator.inputTokens } : {}),
    ...(known.cacheRead ? { cacheReadTokens: accumulator.cacheReadTokens } : {}),
    ...(known.cacheWrite ? { cacheWriteTokens: accumulator.cacheWriteTokens } : {}),
  });
}

export function serializeUsageTotals(accumulator: UsageAccumulator): UsageTotalsV2 {
  const totals: UsageTotalsV2 = { source: accumulator.source ?? 'unavailable' };
  const fields = [
    ['input', 'input_tokens', accumulator.inputTokens],
    ['output', 'output_tokens', accumulator.outputTokens],
    ['cacheRead', 'cache_read_input_tokens', accumulator.cacheReadTokens],
    ['cacheWrite', 'cache_creation_input_tokens', accumulator.cacheWriteTokens],
    ['reasoning', 'reasoning_tokens', accumulator.reasoningTokens],
    ['total', 'total_tokens', accumulator.totalTokens],
    ['modelCalls', 'model_calls', accumulator.modelCalls],
  ] as const;
  for (const [flag, key, sum] of fields) {
    if (accumulator.known[flag]) {
      totals[key] = sum;
    }
  }
  const ratio = totalsRatio(accumulator);
  if (ratio !== undefined) {
    totals.cache_read_ratio = ratio;
  }
  return totals;
}

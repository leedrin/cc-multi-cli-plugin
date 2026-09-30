import { type MessagesResponse, toProtocolUsage } from '../../multi-core/src/gateway/messages.ts';
import {
  type CanonicalTokenUsage,
  cacheReadRatio,
} from '../../multi-core/src/gateway/usage-accounting.ts';

/**
 * The usage object of a Responses API terminal event. Every field may be absent and
 * a detail object may be `null`: each shape the API has sent is accepted, and only a
 * count that cannot be a token count is malformed.
 */
export interface OpenAIResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
}

type Accounting = NonNullable<NonNullable<MessagesResponse['multi_usage']>['accounting']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): boolean {
  return (
    value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function isDetails(value: unknown, keys: readonly string[]): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  return isRecord(value) && keys.every((key) => isCount(value[key]));
}

export function isOpenAIResponsesUsage(value: unknown): value is OpenAIResponsesUsage {
  return (
    isRecord(value) &&
    isCount(value.input_tokens) &&
    isCount(value.output_tokens) &&
    isCount(value.total_tokens) &&
    isDetails(value.input_tokens_details, ['cached_tokens', 'cache_write_tokens']) &&
    isDetails(value.output_tokens_details, ['reasoning_tokens'])
  );
}

function detail(details: unknown, key: string): number | undefined {
  if (!isRecord(details)) {
    return undefined;
  }
  const value = details[key];
  return typeof value === 'number' ? value : undefined;
}

function known(...values: Array<number | undefined>): boolean {
  return values.some((value) => value !== undefined);
}

function providerTotal(usage: OpenAIResponsesUsage): number | undefined {
  if (usage.total_tokens !== undefined) {
    return usage.total_tokens;
  }
  // A total is derived only from two known parts; one known part is not a total.
  if (usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
    return usage.input_tokens + usage.output_tokens;
  }
  return undefined;
}

/**
 * Canonical usage from a Responses `usage` value. A missing or `null` usage is
 * unavailable; a complete one is provider; a partial one is mixed, leaving what the
 * provider did not send unknown. A count that is not a safe non-negative integer
 * throws, so a corrupt report never becomes a plausible number.
 */
export function parseOpenAIResponseUsage(value: unknown): CanonicalTokenUsage {
  if (value === undefined || value === null) {
    return { source: 'unavailable' };
  }
  if (!isOpenAIResponsesUsage(value)) {
    throw new Error('OpenAI sent a malformed usage');
  }
  const cacheRead = detail(value.input_tokens_details, 'cached_tokens');
  const cacheWrite = detail(value.input_tokens_details, 'cache_write_tokens');
  const reasoning = detail(value.output_tokens_details, 'reasoning_tokens');
  const total = providerTotal(value);
  if (!known(value.input_tokens, value.output_tokens, cacheRead, cacheWrite, reasoning, total)) {
    return { source: 'unavailable' };
  }
  const complete = value.input_tokens !== undefined && value.output_tokens !== undefined;
  const usage: CanonicalTokenUsage = {
    source: complete ? 'provider' : 'mixed',
    // The API counts cached and written tokens inside input_tokens; the canonical
    // input is the uncached remainder. An absent detail takes nothing from the input.
    ...(value.input_tokens === undefined
      ? {}
      : { inputTokens: Math.max(0, value.input_tokens - (cacheRead ?? 0) - (cacheWrite ?? 0)) }),
    ...(value.output_tokens === undefined ? {} : { outputTokens: value.output_tokens }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    ...(total === undefined ? {} : { totalTokens: total }),
  };
  const ratio = cacheReadRatio(usage);
  return ratio === undefined ? usage : { ...usage, cacheReadRatio: ratio };
}

/** The protocol usage for a response; its zeros for unknown counts are placeholders. */
export function openAIProtocolUsage(usage: CanonicalTokenUsage): MessagesResponse['usage'] {
  return toProtocolUsage(usage);
}

/**
 * `multi_usage` for a response: the source, the accounting block, and the flat
 * reasoning and total counts older readers still use, each only when known.
 */
export function responseUsageMetadata(
  usage: CanonicalTokenUsage,
  model: string,
): NonNullable<MessagesResponse['multi_usage']> {
  const accounting = openAIAccountingMetadata(usage);
  return {
    source: usage.source,
    ...(accounting === undefined ? {} : { accounting }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    model,
  };
}

/** The `multi_usage.accounting` block: known counts only, or nothing when none is known. */
export function openAIAccountingMetadata(usage: CanonicalTokenUsage): Accounting | undefined {
  const accounting: Accounting = {
    ...(usage.inputTokens === undefined ? {} : { input_tokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { output_tokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cache_read_input_tokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cache_creation_input_tokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning_tokens: usage.reasoningTokens }),
    ...(usage.totalTokens === undefined ? {} : { total_tokens: usage.totalTokens }),
    ...(usage.cacheReadRatio === undefined ? {} : { cache_read_ratio: usage.cacheReadRatio }),
  };
  return Object.keys(accounting).length === 0 ? undefined : accounting;
}

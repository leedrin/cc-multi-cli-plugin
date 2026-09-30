import type { CanonicalTokenUsage } from './usage-accounting.ts';

export interface UsageTraceRecord {
  provider: string;
  event: string;
  usage: CanonicalTokenUsage;
}

export interface UsageTraceOptions {
  env?: Readonly<Record<string, string | undefined>>;
  write?: (line: string) => void;
}

/**
 * Writes one metadata line for a terminal usage when `MULTI_USAGE_TRACE=1`, and nothing
 * otherwise. The line carries counts and the source only: never text, tool data, headers,
 * or credentials. A usage that was not reported says so and has no counts, not zeros.
 */
export function usageTrace(record: UsageTraceRecord, options: UsageTraceOptions = {}): void {
  const env = options.env ?? process.env;
  if (env.MULTI_USAGE_TRACE !== '1') {
    return;
  }
  const { usage } = record;
  const present = usage.source !== 'unavailable';
  const line = {
    provider: record.provider,
    event: record.event,
    usagePresent: present,
    source: usage.source,
    ...(present && usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(present && usage.cacheReadTokens !== undefined
      ? { cachedTokens: usage.cacheReadTokens }
      : {}),
    ...(present && usage.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: usage.cacheWriteTokens }
      : {}),
    ...(present && usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(present && usage.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(present && usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
  };
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  write(`${JSON.stringify(line)}\n`);
}

import { parseOpenAIResponseUsage } from '../../multi-core/src/gateway/response-usage.ts';
import type { CanonicalTokenUsage } from '../../multi-core/src/gateway/usage-accounting.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readCount(value: unknown, key: string): number | undefined {
  return isRecord(value) ? count(value[key]) : undefined;
}

function firstCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = count(value);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function usageFromChunk(chunk: unknown): unknown {
  if (!isRecord(chunk)) {
    return undefined;
  }
  const choices = Array.isArray(chunk.choices) ? chunk.choices : undefined;
  const choice = choices?.[0];
  const choiceUsage = isRecord(choice) ? choice.usage : undefined;
  return chunk.usage ?? choiceUsage;
}

/** Observes raw provider stream snapshots before Pi normalizes missing counts to zero. */
export class ObservedUsage {
  private latest: CanonicalTokenUsage | undefined;

  observe(chunk: unknown): void {
    const raw = usageFromChunk(chunk);
    if (!isRecord(raw)) {
      return;
    }

    const promptTokens = readCount(raw, 'prompt_tokens');
    const completionTokens = readCount(raw, 'completion_tokens');
    const details = raw.prompt_tokens_details;
    const completionDetails = raw.completion_tokens_details;
    const cachedTokens = firstCount(
      readCount(details, 'cached_tokens'),
      raw.prompt_cache_hit_tokens,
      raw.cached_tokens,
    );
    const cacheWriteTokens = readCount(details, 'cache_write_tokens');
    const reasoningTokens = readCount(completionDetails, 'reasoning_tokens');
    const totalTokens = readCount(raw, 'total_tokens');

    this.latest = parseOpenAIResponseUsage({
      ...(promptTokens === undefined ? {} : { input_tokens: promptTokens }),
      ...(completionTokens === undefined ? {} : { output_tokens: completionTokens }),
      ...(totalTokens === undefined ? {} : { total_tokens: totalTokens }),
      ...(cachedTokens === undefined && cacheWriteTokens === undefined
        ? {}
        : {
            input_tokens_details: {
              ...(cachedTokens === undefined ? {} : { cached_tokens: cachedTokens }),
              ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
            },
          }),
      ...(reasoningTokens === undefined
        ? {}
        : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
    });
  }

  canonical(): CanonicalTokenUsage {
    return { ...(this.latest ?? { source: 'unavailable' }), modelCalls: 1 };
  }
}

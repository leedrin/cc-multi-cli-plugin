// Pure helpers for the usage views: no Client, focus, key or `$.ui` dependency, so the
// same data reads the same in the pane and as text on every host.

type Provider = {
  id: string;
  name: string;
  status: string;
  summary: string;
  details: string[];
  url?: string;
};

export type UsagePaneProps = {
  updatedAt: string;
  providers: Provider[];
  receiptLines?: string[];
  error?: string;
  quotaAdviceEnabled?: boolean;
};

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The gateway's provider view, or nothing when it is not shaped as one. */
export function parseDashboard(value: unknown): UsagePaneProps | undefined {
  if (!record(value) || typeof value.updatedAt !== 'string' || !Array.isArray(value.providers)) {
    return undefined;
  }
  if (
    !value.providers.every(
      (item) =>
        record(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.status === 'string' &&
        typeof item.summary === 'string' &&
        Array.isArray(item.details) &&
        item.details.every((line) => typeof line === 'string'),
    )
  ) {
    return undefined;
  }
  return value as UsagePaneProps;
}

/** Every provider with its status, account summary and session usage lines, as plain text. */
export function renderUsageText(props: UsagePaneProps): string {
  return [
    `Multi usage · account data checked ${props.updatedAt}`,
    ...props.providers.flatMap((provider) => [
      '',
      `${provider.name} [${provider.status}]`,
      `  ${provider.summary}`,
      ...provider.details.map((line) => `  ${line}`),
      ...(provider.url ? [`  ${provider.url}`] : []),
    ]),
  ].join('\n');
}

const count = (value: unknown) => (typeof value === 'number' ? value.toLocaleString('en-US') : '');

function known(label: string, value: unknown, mixed: boolean): string[] {
  if (typeof value !== 'number') {
    return [];
  }
  return [mixed ? `known ${label} ${count(value)}` : `${count(value)} ${label}`];
}

/**
 * Context and consumption side by side: a harness that resends its whole context
 * on every model call without a cache reads as a small context and a large spend.
 * A count the receipt does not carry was never reported, so it is left out.
 */
function receiptUsage(usage: Record<string, unknown>, requests: unknown, context: unknown) {
  const calls =
    typeof usage.model_calls === 'number' ? ` · ${count(usage.model_calls)} model calls` : '';
  return [
    `${String(requests)} requests${calls}`,
    ...contextPart(context),
    consumedPart(usage),
  ].join(' · ');
}

function contextPart(context: unknown): string[] {
  if (!record(context)) {
    return [];
  }
  if (context.source === 'unavailable') {
    return ['context usage unavailable'];
  }
  const parts = [
    context.input_tokens,
    context.cache_read_input_tokens,
    context.cache_creation_input_tokens,
  ].filter((item) => typeof item === 'number');
  return parts.length > 0 ? [`context ${count(parts.reduce((sum, item) => sum + item, 0))}`] : [];
}

function consumedPart(usage: Record<string, unknown>): string {
  if (usage.source === 'unavailable') {
    return 'consumed usage unavailable';
  }
  const mixed = usage.source === 'mixed';
  const parts = [
    ...known('input', usage.input_tokens, mixed),
    ...(typeof usage.cache_read_input_tokens === 'number'
      ? [`cached ${count(usage.cache_read_input_tokens)}`]
      : []),
    ...known('output', usage.output_tokens, mixed),
    ...known('reasoning', usage.reasoning_tokens, mixed),
  ];
  return parts.length > 0 ? `consumed ${parts.join(' · ')}` : 'consumed usage unavailable';
}
function receiptEntry(value: unknown): string[] {
  if (!record(value)) {
    return [];
  }
  return [
    `  ${String(value.provider)} · ${String(value.model ?? 'model unreported')} · effort ${String(value.effort ?? 'unreported')} · ${String(value.endpoint ?? 'endpoint unreported')} · ${String(value.source)}`,
  ];
}

function receiptLines(value: unknown): string[] {
  if (!record(value) || !record(value.usage)) {
    return [];
  }
  const owner = typeof value.agentId === 'string' ? value.agentId : 'Main turn';
  return [
    `${owner} · ${String(value.outcome)}${value.incomplete ? ' (incomplete)' : ''} · ${String(value.time)}`,
    `  ${receiptUsage(value.usage, value.requests, value.context)}`,
    ...(Array.isArray(value.entries) ? value.entries.flatMap(receiptEntry) : []),
  ];
}

/** The newest receipts first, as lines; a body that is not a receipt list is `undefined`. */
export function formatReceipts(response: unknown): string[] | undefined {
  if (!record(response) || !Array.isArray(response.receipts)) {
    return undefined;
  }
  return response.receipts.slice(-20).reverse().flatMap(receiptLines);
}

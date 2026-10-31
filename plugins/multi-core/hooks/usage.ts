import type { EngineInterface, Register, UiOpenResult } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreUsagePaneState } from '../types/multi-core.d.ts';
import { accepted, getJson, type Wire } from './gateway.ts';
import { quotaAdvice } from './quota-advice.ts';
import { rememberBounded, withBounded } from './state.ts';
import {
  formatReceipts,
  parseDashboard,
  renderUsageText,
  type UsagePaneProps,
} from './usage-format.ts';
import {
  MAX_PANES,
  newPaneState,
  PANE_ID,
  pageLines,
  renderPane,
  scrollPane,
  selectionOf,
  type UsagePaneState,
} from './usage-pane.ts';

// Atoms are declared where they are read so the engine can discover each state key.
const advisorySessions = atom(
  { plugin: 'multi-core', key: 'advisorySessions' } as const,
  [] as string[],
);
const usagePanes = atom(
  { plugin: 'multi-core', key: 'usagePanes' } as const,
  {} as Record<string, MultiCoreUsagePaneState>,
);
const modKeys = atom(
  { plugin: 'multi-core', key: 'modKeys' } as const,
  {} as Record<string, string>,
);
const usageTimeoutMs = 8500;
// Layout measurements are only a memo between draws; navigation lives in $.state.
const layouts = new Map<string, { columns: number; rows: number }>();

const wire = ($: EngineInterface): Wire => ({
  url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
  token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  keys: { read: () => read($, modKeys), save: (change) => update($, modKeys, change) },
});

export const register = (on: Parameters<Register>[0], _options?: Parameters<Register>[1]) => {
  on('classic.PreToolUse', async ($, event, next) => {
    const tool: string = event.tool;
    if (
      (tool !== 'Agent' && tool !== 'Task') ||
      (event as { agentId?: string }).agentId !== undefined
    ) {
      return next(event);
    }
    const session = await $.session.id();
    if (!(await read($, advisorySessions)).includes(session)) {
      return next(event);
    }
    const snapshot = parseDashboard(accepted(await fetchUsage($, session)));
    const result = await next(event);
    if (!(await read($, advisorySessions)).includes(session)) {
      return result;
    }
    return {
      ...result,
      additionalContext: [...(result.additionalContext ?? []), quotaAdvice(snapshot)],
    };
  });
  on('command.run', { command: 'multi-usage' }, async ($, event) => {
    const args = event.args.trim();
    const textOnly = args === '--text' || args === 'text';
    if (args && !textOnly) {
      return { text: 'Use /multi-usage or /multi-usage --text.' };
    }
    const session = await $.session.id();
    const response = parseDashboard(accepted(await fetchUsage($, session)));
    if (!response) {
      return { text: 'Multi usage is unavailable. Launch this session with claude-multi.' };
    }
    if (textOnly) {
      return { text: renderUsageText(response) };
    }
    const quotaAdviceEnabled = (await read($, advisorySessions)).includes(session);
    layouts.delete(session);
    await update($, usagePanes, (held) =>
      withBounded(held, session, newPaneState({ ...response, quotaAdviceEnabled }), MAX_PANES),
    );
    const fallback = await openPane($, session, response);
    return fallback === undefined ? {} : { text: fallback };
  });
  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    if (event.requestId !== PANE_ID || event.surface !== 'terminal') {
      return next(event);
    }
    const session = await $.session.id();
    const state = await paneState($, session);
    if (!state) {
      return next(event);
    }
    const elements = $.ui.resolve(event);
    state.columns = event.props.bodyColumns;
    state.rows = event.props.scroll?.bodyRows ?? state.rows;
    rememberBounded(layouts, session, { columns: state.columns, rows: state.rows }, MAX_PANES);
    await uiTrace($, {
      event: 'ui.render',
      surface: event.surface,
      requestId: event.requestId,
      columns: state.columns,
    });
    return renderPane(elements, state);
  });
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    const result = await next(event);
    await uiTrace($, {
      event: 'ui.focus',
      requestId: event.requestId,
      ...(event.element === undefined ? {} : { element: event.element }),
    });
    const session = await $.session.id();
    const state = await paneState($, session);
    const selection = state ? selectionOf(event.element, state.props) : undefined;
    if (state && selection !== undefined && selection !== state.selected && !result?.deny) {
      await selectTab($, session, state, selection);
    }
    return result;
  });
  on('ui.press', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    await uiTrace($, {
      event: 'ui.press',
      surface: event.surface,
      requestId: event.requestId,
      element: event.element,
    });
    const session = await $.session.id();
    const state = await paneState($, session);
    if (state) {
      await paneAction($, session, state, event.element);
    }
    return next(event);
  });
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    await uiTrace($, { event: 'ui.scroll', requestId: event.requestId, by: event.by });
    const session = await $.session.id();
    const state = await paneState($, session);
    if (state) {
      state.rows = event.bodyRows;
      state.offset = scrollPane(state, event.by);
      await savePane($, session, state);
    }
    return next(event);
  });
  on('ui.close', { id: PANE_ID }, async ($, event, next) => {
    await uiTrace($, { event: 'ui.close', requestId: event.id });
    await forgetPane($, await $.session.id());
    return next(event);
  });
};

async function paneState($: EngineInterface, session: string): Promise<UsagePaneState | undefined> {
  const state = (await read($, usagePanes))[session];
  return state ? { ...state, ...layouts.get(session), props: { ...state.props } } : undefined;
}

function savePane($: EngineInterface, session: string, state: UsagePaneState) {
  // A late refresh must not recreate a pane that has already been closed.
  return update($, usagePanes, (held) =>
    Object.hasOwn(held, session) ? withBounded(held, session, state, MAX_PANES) : held,
  );
}

function forgetPane($: EngineInterface, session: string) {
  layouts.delete(session);
  return update($, usagePanes, (held) =>
    Object.fromEntries(Object.entries(held).filter(([id]) => id !== session)),
  );
}

function fetchUsage($: EngineInterface, session: string, refresh = false) {
  const query: Record<string, string> = { sessionId: session, view: 'providers' };
  if (refresh) {
    query.refresh = 'true';
  }
  return getJson(wire($), '/multi/mod/usage', query, { timeoutMs: usageTimeoutMs });
}

function fetchReceipts($: EngineInterface, session: string) {
  return getJson(
    wire($),
    '/multi/mod/receipts',
    { sessionId: session },
    { timeoutMs: usageTimeoutMs },
  );
}

type UiTraceFields = {
  event: string;
  surface?: string;
  requestId?: string;
  element?: string;
  requested?: boolean;
  placed?: boolean;
  reason?: string;
  by?: number;
  columns?: number;
};

const REASON_LIMIT = 200;

/** Only metadata enters the debug log; the gateway key and session id have no field here. */
async function uiTrace($: EngineInterface, fields: UiTraceFields): Promise<void> {
  if ((await $.env.get('MULTI_UI_TRACE')) !== '1') {
    return;
  }
  const line = {
    ...fields,
    ...(fields.reason === undefined ? {} : { reason: fields.reason.slice(0, REASON_LIMIT) }),
  };
  $.ui.log(`multi-usage ${JSON.stringify(line)}`, { to: 'debug' });
}

async function selectTab(
  $: EngineInterface,
  session: string,
  state: UsagePaneState,
  selected: string,
) {
  state.selected = selected;
  state.offset = 0;
  if (selected === 'receipts' && !state.receiptLoaded && !state.loading) {
    await loadReceipts($, session, state);
  }
  await savePane($, session, state);
}

async function loadReceipts($: EngineInterface, session: string, state: UsagePaneState) {
  state.loading = true;
  await savePane($, session, state);
  try {
    state.props = updatePane(state.props, 'receipts', accepted(await fetchReceipts($, session)));
    state.receiptLoaded = state.props.error === undefined;
  } finally {
    state.loading = false;
  }
}

async function refreshPane($: EngineInterface, session: string, state: UsagePaneState) {
  const receipts = state.selected === 'receipts';
  state.loading = true;
  await savePane($, session, state);
  try {
    const response = receipts
      ? await fetchReceipts($, session)
      : await fetchUsage($, session, true);
    state.props = updatePane(state.props, receipts ? 'receipts' : 'refresh', accepted(response));
    if (receipts) {
      state.receiptLoaded = state.props.error === undefined;
    }
  } finally {
    state.loading = false;
  }
}

async function closePane($: EngineInterface, session: string) {
  await forgetPane($, session);
  try {
    await $.ui.close({ id: PANE_ID });
  } catch {
    // A pane that is already gone needs no closing.
  }
}

async function paneAction(
  $: EngineInterface,
  session: string,
  state: UsagePaneState,
  element: string,
) {
  const selection = selectionOf(element, state.props);
  if (selection !== undefined) {
    await selectTab($, session, state, selection);
    return;
  }
  if (element === 'action:close') {
    await closePane($, session);
    return;
  }
  if (element === 'action:refresh') {
    await refreshPane($, session, state);
  } else if (element === 'action:quota-advice') {
    const enabled = !(await read($, advisorySessions)).includes(session);
    await update($, advisorySessions, (held) =>
      enabled ? [...held, session] : held.filter((id) => id !== session),
    );
    state.props = { ...state.props, quotaAdviceEnabled: enabled };
  } else if (element === 'action:page-up' || element === 'action:page-down') {
    state.offset = scrollPane(state, (element === 'action:page-up' ? -1 : 1) * pageLines(state));
  } else {
    return;
  }
  await savePane($, session, state);
}

async function openPane(
  $: EngineInterface,
  session: string,
  response: UsagePaneProps,
): Promise<string | undefined> {
  let opened: UiOpenResult | undefined;
  try {
    opened = await $.ui.open({
      id: 'multi-usage',
      title: 'Multi usage',
      focus: true,
      closeOnEscape: true,
      rows: 20,
    });
  } catch {
    await forgetPane($, session);
    await uiTrace($, { event: 'pane.open', requested: true, placed: false, reason: 'open failed' });
    return renderUsageText(response);
  }
  await uiTrace($, {
    event: 'pane.open',
    requested: true,
    placed: opened?.isPlaced !== false,
    ...(opened?.isPlaced === false ? { reason: opened.reason } : {}),
  });
  if (opened?.isPlaced !== false) {
    return undefined;
  }
  $.ui.toast(`Multi usage: ${opened.reason}`);
  await closePane($, session);
  return (
    'The usage pane could not be shown (' +
    opened.reason +
    '). Showing text instead.\n\n' +
    renderUsageText(response)
  );
}

function updatePane(previous: UsagePaneProps, action: string, response: unknown): UsagePaneProps {
  const { error: _error, ...kept } = previous;
  if (action === 'refresh') {
    const refreshed = parseDashboard(response);
    return refreshed
      ? {
          ...refreshed,
          ...(previous.receiptLines ? { receiptLines: previous.receiptLines } : {}),
          ...(previous.quotaAdviceEnabled === undefined
            ? {}
            : { quotaAdviceEnabled: previous.quotaAdviceEnabled }),
        }
      : { ...previous, error: 'Refresh failed. Showing the previous values.' };
  }
  const lines = formatReceipts(response);
  if (!lines) {
    return { ...previous, error: 'Could not load receipts.' };
  }
  return { ...kept, receiptLines: lines };
}

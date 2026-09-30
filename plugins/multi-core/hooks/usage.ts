import type { EngineInterface, Register, UiOpenResult } from 'claude-code';
import { quotaAdvice } from './quota-advice.ts';
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

const panes = new Map<string, UsagePaneState>();
const advisorySessions = new Set<string>();

export function forgetUsageSession(session: string) {
  advisorySessions.delete(session);
  panes.delete(session);
}

export const register = (
  on: Parameters<Register>[0],
  _options?: Parameters<Register>[1],
  agentModels: ReadonlyMap<string, string> = new Map(),
) => {
  on('classic.PreToolUse', async ($, event, next) => {
    await attributeToolCall($, event, agentModels);
    // `Task` is the Agent tool's legacy name; a worker's own spawn carries its agentId.
    const tool: string = event.tool;
    if (
      (tool !== 'Agent' && tool !== 'Task') ||
      (event as { agentId?: string }).agentId !== undefined
    ) {
      return next(event);
    }
    const session = await $.session.id();
    if (!advisorySessions.has(session)) {
      return next(event);
    }
    const snapshot = parseDashboard(
      await request($, `/multi/mod/usage?sessionId=${encodeURIComponent(session)}&view=providers`),
    );
    const result = await next(event);
    // Preserve all permission decisions and tool arguments, including on lookup failure.
    if (!advisorySessions.has(session)) {
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
    const response = parseDashboard(
      await request($, `/multi/mod/usage?sessionId=${encodeURIComponent(session)}&view=providers`),
    );
    if (!response) {
      return { text: 'Multi usage is unavailable. Launch this session with claude-multi.' };
    }
    if (textOnly) {
      return { text: renderUsageText(response) };
    }
    if (panes.size >= MAX_PANES) {
      panes.clear();
    }
    panes.set(
      session,
      newPaneState({ ...response, quotaAdviceEnabled: advisorySessions.has(session) }),
    );
    const fallback = await openPane($, session, response);
    if (fallback !== undefined) {
      return { text: fallback };
    }
    $.ui.invalidate('ui.render');
    return {};
  });
  on('ui.render', { component: 'Pane' }, async ($, event, next) => {
    if (event.requestId !== PANE_ID || event.surface !== 'terminal') {
      return next(event);
    }
    const state = panes.get(await $.session.id());
    if (!state) {
      return next(event);
    }
    const elements = await $.ui.resolve(event);
    state.columns = event.props.bodyColumns;
    state.rows = event.props.scroll?.bodyRows ?? state.rows;
    return renderPane(elements, state);
  });
  // The focus ring walks the tabs: where it lands is the provider shown.
  on('ui.focus', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    const result = await next(event);
    const session = await $.session.id();
    const state = panes.get(session);
    const selection = state ? selectionOf(event.element, state.props) : undefined;
    if (state && selection !== undefined && selection !== state.selected && !result?.deny) {
      await selectTab($, session, state, selection);
    }
    return result;
  });
  on('ui.press', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    const session = await $.session.id();
    const state = panes.get(session);
    if (state) {
      await paneAction($, session, state, event.element);
    }
    return next(event);
  });
  on('ui.scroll', { component: 'Pane', requestId: PANE_ID }, async ($, event, next) => {
    const state = panes.get(await $.session.id());
    if (state) {
      state.rows = event.bodyRows;
      state.offset = scrollPane(state, event.by);
      $.ui.invalidate('ui.render');
    }
    return next(event);
  });
  on('ui.close', { id: PANE_ID }, async ($, event, next) => {
    panes.delete(await $.session.id());
    return next(event);
  });
};

const receiptsRoute = (session: string) =>
  `/multi/mod/receipts?sessionId=${encodeURIComponent(session)}`;
const refreshRoute = (session: string) =>
  `/multi/mod/usage?view=providers&refresh=true&sessionId=${encodeURIComponent(session)}`;

/** Shows one tab; the receipts load the first time they are shown, and only then. */
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
  $.ui.invalidate('ui.render');
}

async function loadReceipts($: EngineInterface, session: string, state: UsagePaneState) {
  state.loading = true;
  $.ui.invalidate('ui.render');
  try {
    state.props = updatePane(state.props, 'receipts', await request($, receiptsRoute(session)));
    // A failed load keeps the earlier data and is tried again the next time the tab is shown.
    state.receiptLoaded = state.props.error === undefined;
  } finally {
    state.loading = false;
  }
}

/** Refresh reloads what the page shows: the receipts, or the provider view from the gateway. */
async function refreshPane($: EngineInterface, session: string, state: UsagePaneState) {
  const receipts = state.selected === 'receipts';
  state.loading = true;
  try {
    const response = await request($, receipts ? receiptsRoute(session) : refreshRoute(session));
    state.props = updatePane(state.props, receipts ? 'receipts' : 'refresh', response);
    if (receipts) {
      state.receiptLoaded = state.props.error === undefined;
    }
  } finally {
    state.loading = false;
  }
}

async function closePane($: EngineInterface, session: string) {
  panes.delete(session);
  try {
    await $.ui.close({ id: PANE_ID });
  } catch {
    // A pane that is already gone needs no closing.
  }
}

/** Applies one pressed element of the pane; an element that is not one of ours is left alone. */
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
    const enabled = !advisorySessions.has(session);
    if (enabled) {
      advisorySessions.add(session);
    } else {
      advisorySessions.delete(session);
    }
    state.props = { ...state.props, quotaAdviceEnabled: enabled };
  } else if (element === 'action:page-up' || element === 'action:page-down') {
    state.offset = scrollPane(state, (element === 'action:page-up' ? -1 : 1) * pageLines(state));
  } else {
    return;
  }
  $.ui.invalidate('ui.render');
}
/**
 * Opens the pane. A host may place no pane, or throw; the same data is always readable as
 * text, which is returned instead. An older build returns nothing from `open`, which
 * counts as placed.
 */
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
    panes.delete(session);
    return renderUsageText(response);
  }
  if (opened?.isPlaced !== false) {
    return undefined;
  }
  panes.delete(session);
  try {
    await $.ui.close({ id: 'multi-usage' });
  } catch {
    // The pane only waited undrawn; failing to close it loses nothing.
  }
  return `The usage pane could not be shown (${opened.reason}). Showing text instead.\n\n${renderUsageText(response)}`;
}
/** Props are plain data: a field without a value is left out, never set to undefined. */
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
async function request($: EngineInterface, route: string): Promise<unknown> {
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!base || !token) {
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      $.http.fetch(`${base}${route}`, {
        method: 'GET',
        headers: { 'x-multi-gateway-token': token },
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Usage timeout')), 8500);
      }),
    ]);
    return result.ok ? JSON.parse(result.text) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reviewer attribution for a provider's tool call: the gateway learns the session, call,
 * and workspace it needs to match the reviewer request to it. A Claude loop's tool call
 * is Claude's own and costs no gateway call. The reply never decides the call.
 */
async function attributeToolCall(
  $: EngineInterface,
  event: { tool: string; tool_use_id: string },
  agentModels: ReadonlyMap<string, string>,
) {
  const agentId = (event as { agentId?: string }).agentId;
  const model = agentId === undefined ? await $.session.model() : agentModels.get(agentId);
  const base = await $.env.get('MULTI_MOD_GATEWAY_URL');
  const token = await $.env.get('MULTI_GATEWAY_TOKEN');
  if (!model?.startsWith('multi/') || !base || !token) {
    return;
  }
  const mode = (event as { permission_mode?: unknown }).permission_mode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      $.http.fetch(`${base}/multi/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-multi-gateway-token': token },
        body: JSON.stringify({
          session_id: await $.session.id(),
          tool_use_id: event.tool_use_id,
          tool_name: event.tool,
          cwd: await $.session.cwd(),
          ...(typeof mode === 'string' ? { permission_mode: mode } : {}),
        }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Attribution timeout')), 1500);
      }),
    ]);
  } catch {
    // Attribution is best effort; Claude's own checks decide the call.
  } finally {
    clearTimeout(timer);
  }
}

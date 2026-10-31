import type { Elements } from 'claude-code';
import type { MultiCoreUsagePaneState } from '../types/multi-core.d.ts';
import type { UsagePaneProps } from './usage-format.ts';

// The usage pane drawn straight from hook-held state. Claude Code's own focus ring, press and
// scroll events drive it; nothing here reads a terminal key or depends on a host.

type Terminal = Elements['terminal'];
type Drawn = ReturnType<Terminal['Box']>;

export const PANE_ID = 'multi-usage';
/** Sessions whose pane state is kept at once. */
export const MAX_PANES = 16;

const ALL = 'all';
const RECEIPTS = 'receipts';
const FALLBACK_ROWS = 20;
const FALLBACK_COLUMNS = 80;
/** Rows the pane spends on tabs, buttons and the footer around the scrolling text. */
const CHROME_ROWS = 8;

export type UsagePaneState = MultiCoreUsagePaneState;

export function newPaneState(props: UsagePaneProps): UsagePaneState {
  return {
    props,
    selected: ALL,
    offset: 0,
    open: true,
    loading: false,
    receiptLoaded: false,
    columns: FALLBACK_COLUMNS,
    rows: FALLBACK_ROWS,
  };
}

/** The stable address of a tab's button; it is also the `element` a focus or press names. */
export function tabKey(id: string): string {
  if (id === ALL || id === RECEIPTS) {
    return `tab:${id}`;
  }
  return `provider:${id}`;
}

/** The tab a button key stands for, or nothing for a key that is not a tab. */
export function selectionOf(key: string | undefined, props: UsagePaneProps): string | undefined {
  if (key === tabKey(ALL)) {
    return ALL;
  }
  if (key === tabKey(RECEIPTS)) {
    return RECEIPTS;
  }
  const provider = props.providers.find((item) => tabKey(item.id) === key);
  return provider?.id;
}

function viewLines(state: UsagePaneState): string[] {
  const { props, selected } = state;
  if (selected === RECEIPTS) {
    if (state.loading) {
      return ['Loading receipts…'];
    }
    if (!state.receiptLoaded) {
      return ['Receipts load when this tab is selected.'];
    }
    return props.receiptLines?.length
      ? props.receiptLines
      : ['No completed receipts in this session.'];
  }
  const provider = props.providers.find((item) => item.id === selected);
  if (provider) {
    return [
      provider.name,
      provider.summary,
      ...provider.details,
      ...(provider.url ? [provider.url] : []),
    ];
  }
  return props.providers.flatMap((item) => [item.name, `  ${item.summary}`, '']);
}

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) {
    return [line];
  }
  const result: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const space = remaining.lastIndexOf(' ', width);
    const end = space > 0 ? space : width;
    result.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining) {
    result.push(remaining);
  }
  return result;
}

/** The selected page wrapped to the pane's width. */
export function paneLines(state: UsagePaneState): string[] {
  const width = Math.max(10, state.columns);
  return viewLines(state).flatMap((line) => wrapLine(line, width));
}

/** The body lines that fit beside the pane's own controls. */
export function visibleLines(state: UsagePaneState): number {
  return Math.max(3, state.rows - CHROME_ROWS);
}

export function maxOffset(state: UsagePaneState): number {
  return Math.max(0, paneLines(state).length - visibleLines(state));
}

/** Moves the window by `by` lines and keeps it within the page. */
export function scrollPane(state: UsagePaneState, by: number): number {
  return Math.max(0, Math.min(state.offset + by, maxOffset(state)));
}

export function pageLines(state: UsagePaneState): number {
  return Math.max(1, visibleLines(state) - 1);
}

function tabs(props: UsagePaneProps): Array<{ id: string; name: string }> {
  return [
    { id: ALL, name: 'All' },
    ...props.providers.map((provider) => ({ id: provider.id, name: provider.name })),
    { id: RECEIPTS, name: 'Receipts' },
  ];
}

/** A press is answered by the hook on ui.press, which names the element; the closure has nothing to add. */
const pressed = () => {};

/** The pane as an element tree. The selected tab asks for the focus ring; the rest do not. */
export function renderPane(elements: Terminal, state: UsagePaneState): Drawn {
  const { Box, Text, Button } = elements;
  const all = paneLines(state);
  const height = visibleLines(state);
  const offset = Math.max(0, Math.min(state.offset, Math.max(0, all.length - height)));
  const shown = all.slice(offset, offset + height);
  const { props } = state;
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: tabs(props).map((tab) =>
          Button({
            key: tabKey(tab.id),
            label: tab.id === state.selected ? `[${tab.name}]` : tab.name,
            // `autoFocus` is typed `true | absent`; passing `false` fails tree validation.
            ...(tab.id === state.selected ? { autoFocus: true as const } : {}),
            onPress: pressed,
          }),
        ),
      }),
      Text({ dimColor: true, children: `Account data checked ${props.updatedAt}` }),
      Button({
        key: 'action:quota-advice',
        label: `Quota-aware model selection: ${props.quotaAdviceEnabled ? 'On' : 'Off'}`,
        onPress: pressed,
      }),
      ...(props.error ? [Text({ color: 'yellow', children: props.error })] : []),
      ...shown.map((line) => Text({ children: line })),
      Text({
        dimColor: true,
        children: `${all.length === 0 ? 0 : offset + 1}–${Math.min(all.length, offset + height)} of ${all.length} · Tab moves between controls`,
      }),
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 1,
        children: [
          Button({
            key: 'action:page-up',
            label: 'Page Up',
            onPress: pressed,
          }),
          Button({
            key: 'action:page-down',
            label: 'Page Down',
            onPress: pressed,
          }),
          Button({ key: 'action:refresh', label: 'Refresh', onPress: pressed }),
          Button({ key: 'action:close', label: 'Close', onPress: pressed }),
        ],
      }),
    ],
  });
}

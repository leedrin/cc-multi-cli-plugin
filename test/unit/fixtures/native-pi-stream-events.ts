import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

// pi-ai 1.4.0 openai-completions.js: 203, 276-294, thinking deltas 408-413,
// text deltas 434-439, tool calls 441-474, done 490, and error 493-515.
export function interleavedPiEvents(
  base: AssistantMessage,
  thinkingSignature = 'reasoning_content',
): AssistantMessageEvent[] {
  const partial = base;
  // Queued events share the same mutable output, already finalized when consumed.
  partial.content = [
    { type: 'thinking', thinking: 'why because again', thinkingSignature },
    { type: 'text', text: 'answer' },
  ];
  return [
    { type: 'start', partial },
    { type: 'thinking_start', contentIndex: 0, partial },
    { type: 'thinking_delta', contentIndex: 0, delta: 'why', partial },
    { type: 'thinking_delta', contentIndex: 0, delta: ' because', partial },
    { type: 'text_start', contentIndex: 1, partial },
    { type: 'text_delta', contentIndex: 1, delta: 'a', partial },
    { type: 'text_delta', contentIndex: 1, delta: 'n', partial },
    { type: 'thinking_delta', contentIndex: 0, delta: ' again', partial },
    { type: 'text_delta', contentIndex: 1, delta: 'swer', partial },
    { type: 'thinking_end', contentIndex: 0, content: 'why because again', partial },
    { type: 'text_end', contentIndex: 1, content: 'answer', partial },
    { type: 'done', reason: 'stop', message: partial },
  ];
}

export const nativePiStreamEvents = [
  'start',
  'thinking_start',
  'thinking_delta',
  'thinking_delta',
  'text_start',
  'text_delta',
  'text_delta',
  'thinking_delta',
  'text_delta',
  'thinking_end',
  'text_end',
  'done',
] as const;

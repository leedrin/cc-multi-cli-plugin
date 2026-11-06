// Hand-built offline chunks following pi-ai openai-completions.js parsing; not a real recording.
const frames = [
  { id: 'glm-offline', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
  {
    id: 'glm-offline',
    choices: [{ delta: { reasoning_content: 'considering' }, finish_reason: null }],
  },
  { id: 'glm-offline', choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
  {
    id: 'glm-offline',
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'glm-offline',
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: '":"x"}' } }] },
        finish_reason: null,
      },
    ],
  },
  { id: 'glm-offline', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  {
    id: 'glm-offline',
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 7, prompt_cache_hit_tokens: 4 },
  },
];

const plainFrames = [
  ...frames.slice(0, 3),
  { id: 'glm-offline', choices: [{ delta: {}, finish_reason: 'stop' }] },
  {
    id: 'glm-offline',
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 7, prompt_cache_hit_tokens: 4 },
  },
];

function encodeFrames(items: typeof frames): string {
  return `${items.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
}

export const nativePiGlmSse = encodeFrames(frames);
export const nativePiGlmPlainSse = encodeFrames(plainFrames);

import type {
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  Tool,
} from '@earendil-works/pi-ai';
import type { OpenAICompletionsOptions } from '@earendil-works/pi-ai/api/openai-completions';
import { isDirectToolAvailable } from '../../multi-core/src/gateway/direct-tools.ts';
import type {
  ContentBlock,
  MessagesRequest,
  RequestMessage,
} from '../../multi-core/src/gateway/messages.ts';
import { isRecord } from '../../multi-core/src/gateway/record.ts';
import { callId, originalToolNames, toolName } from '../../multi-core/src/gateway/tools.ts';
import type { PiCatalogModel } from './catalog.ts';
import { decodePiSignature } from './signature.ts';

type PiRequestOptions = Pick<OpenAICompletionsOptions, 'maxTokens' | 'toolChoice'>;

export interface PiTranslation {
  context: Context;
  options: PiRequestOptions;
}

const FIXED_TIMESTAMP = 0;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function badRequest(message: string): never {
  throw new Error(message);
}

function blocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  if (!Array.isArray(value)) {
    return badRequest('Expected text or content blocks');
  }
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      return badRequest('Invalid content block');
    }
  }
  return value as ContentBlock[];
}

function readText(value: unknown): string {
  return blocks(value)
    .map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        return badRequest(`Unsupported content block: ${block.type}`);
      }
      return block.text;
    })
    .join('\n');
}

function image(block: ContentBlock): ImageContent {
  const source = block.source;
  if (
    source?.type !== 'base64' ||
    typeof source.media_type !== 'string' ||
    !IMAGE_TYPES.has(source.media_type) ||
    typeof source.data !== 'string' ||
    !source.data ||
    Buffer.from(source.data, 'base64').toString('base64') !== source.data
  ) {
    return badRequest('Unsupported image source');
  }
  return { type: 'image', data: source.data, mimeType: source.media_type };
}

function userContent(
  value: unknown,
  model: PiCatalogModel,
): string | (TextContent | ImageContent)[] {
  const content = blocks(value);
  if (content.every((block) => block.type === 'text')) {
    return content
      .map((block) =>
        typeof block.text === 'string' ? block.text : badRequest('Invalid text content'),
      )
      .join('\n');
  }
  const output: Array<{ type: 'text'; text: string } | ImageContent> = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      output.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      if (!model.input.includes('image')) {
        return badRequest('Model does not support image input');
      }
      output.push(image(block));
    } else if (block.type === 'document') {
      return badRequest('Document blocks are not supported');
    } else {
      return badRequest(`Unsupported user content: ${block.type}`);
    }
  }
  return output;
}

function toolResultContent(
  value: unknown,
  model: PiCatalogModel,
): Array<{ type: 'text'; text: string } | ImageContent> {
  const result: Array<{ type: 'text'; text: string } | ImageContent> = [];
  for (const item of blocks(value)) {
    if (item.type === 'text' && typeof item.text === 'string') {
      result.push({ type: 'text', text: item.text });
    } else if (item.type === 'image') {
      if (!model.input.includes('image')) {
        return badRequest('Model does not support image input');
      }
      result.push(image(item));
    } else if (item.type === 'tool_reference' && typeof item.tool_name === 'string') {
      result.push({ type: 'text', text: `Available tool: ${toolName(item.tool_name)}` });
    } else if (item.type === 'document') {
      return badRequest('Document blocks are not supported');
    } else {
      return badRequest(`Unsupported tool result content: ${item.type}`);
    }
  }
  return result;
}

function toolResult(
  block: ContentBlock,
  callNames: ReadonlyMap<string, string>,
  model: PiCatalogModel,
): Message {
  if (!block.tool_use_id) {
    return badRequest('Missing tool result ID');
  }
  const original = callNames.get(block.tool_use_id);
  if (!original) {
    return badRequest('Tool result references an unknown tool call');
  }
  const result = toolResultContent(block.content ?? '', model);
  return {
    role: 'toolResult',
    toolCallId: callId(block.tool_use_id),
    toolName: toolName(original),
    content: result,
    isError: block.is_error === true,
    timestamp: FIXED_TIMESTAMP,
  };
}

type PiAssistantContent =
  | TextContent
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }
  | { type: 'toolCall'; id: string; name: string; arguments: JsonObject };

function assistantBlock(
  block: ContentBlock,
  routeId: string,
  declared: ReadonlyMap<string, string>,
  callNames: Map<string, string>,
): PiAssistantContent | undefined {
  if (block.type === 'text') {
    if (typeof block.text !== 'string') {
      return badRequest('Invalid assistant text');
    }
    return { type: 'text', text: block.text };
  }
  if (block.type === 'thinking') {
    if (typeof block.signature !== 'string') {
      return undefined;
    }
    const decoded = decodePiSignature(block.signature, routeId);
    if (decoded.kind === 'foreign') {
      return undefined;
    }
    if (decoded.payload.redacted === true || decoded.payload.thinking !== block.thinking) {
      return badRequest('Invalid Pi thinking signature');
    }
    return { type: 'thinking', ...decoded.payload };
  }
  if (block.type === 'tool_use') {
    return assistantToolCall(block, declared, callNames);
  }
  if (block.type === 'redacted_thinking') {
    return badRequest('Unsupported redacted thinking block');
  }
  return badRequest(`Unsupported assistant content: ${block.type}`);
}

function assistantToolCall(
  block: ContentBlock,
  declared: ReadonlyMap<string, string>,
  callNames: Map<string, string>,
): PiAssistantContent {
  if (typeof block.id !== 'string' || typeof block.name !== 'string' || !isRecord(block.input)) {
    return badRequest('Invalid tool_use');
  }
  const alias = toolName(block.name);
  if (declared.get(alias) !== block.name) {
    return badRequest('Tool call references an undeclared tool');
  }
  if (callNames.has(block.id)) {
    return badRequest('Duplicate tool call ID');
  }
  callNames.set(block.id, block.name);
  return {
    type: 'toolCall',
    id: callId(block.id),
    name: alias,
    arguments: block.input as JsonObject,
  };
}

function mergeThinking(content: PiAssistantContent[], item: PiAssistantContent | undefined): void {
  if (!item) {
    return;
  }
  const previous = content.at(-1);
  if (
    item.type === 'thinking' &&
    previous?.type === 'thinking' &&
    previous.thinkingSignature === item.thinkingSignature &&
    previous.redacted === item.redacted
  ) {
    previous.thinking += item.thinking;
  } else {
    content.push(item);
  }
}

function addAssistant(
  message: RequestMessage,
  routeId: string,
  model: PiCatalogModel,
  declared: ReadonlyMap<string, string>,
  callNames: Map<string, string>,
  providerId: string,
): Message | undefined {
  const content: PiAssistantContent[] = [];
  for (const block of blocks(message.content)) {
    mergeThinking(content, assistantBlock(block, routeId, declared, callNames));
  }
  if (!content.length) {
    return undefined;
  }
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: providerId,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: FIXED_TIMESTAMP,
  };
}

function requestOptions(
  body: MessagesRequest,
  model: PiCatalogModel,
  declared: Set<string>,
): PiRequestOptions {
  const maxTokens =
    body.max_tokens === undefined ? Math.min(32000, model.maxTokens) : body.max_tokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > model.maxTokens) {
    return badRequest('Invalid max_tokens');
  }
  const options: PiRequestOptions = { maxTokens };
  const choice = body.tool_choice;
  if (choice) {
    if (choice.type === 'auto' || choice.type === 'none') {
      options.toolChoice = choice.type;
    } else if (choice.type === 'any') {
      options.toolChoice = 'required';
    } else if (
      choice.type === 'tool' &&
      typeof choice.name === 'string' &&
      declared.has(choice.name)
    ) {
      options.toolChoice = { type: 'function', function: { name: toolName(choice.name) } };
    } else {
      return badRequest('Invalid tool choice');
    }
  }
  return options;
}

function appendMessage(
  item: RequestMessage,
  messages: Message[],
  declared: ReadonlyMap<string, string>,
  callNames: Map<string, string>,
  routeId: string,
  model: PiCatalogModel,
  providerId: string,
): void {
  if (item.role === 'assistant') {
    const assistant = addAssistant(item, routeId, model, declared, callNames, providerId);
    if (assistant) {
      messages.push(assistant);
    }
    return;
  }
  if (item.role !== 'user') {
    badRequest(`Unsupported message role: ${item.role}`);
  }
  const content = blocks(item.content);
  for (const block of content.filter((part) => part.type === 'tool_result')) {
    messages.push(toolResult(block, callNames, model));
  }
  const userBlocks = content.filter((part) => part.type !== 'tool_result');
  if (userBlocks.length) {
    messages.push({
      role: 'user',
      content: userContent(userBlocks, model),
      timestamp: FIXED_TIMESTAMP,
    });
  }
}

function translateTools(body: MessagesRequest): Tool[] {
  return (body.tools ?? [])
    .filter(
      (tool) =>
        !(tool as { defer_loading?: boolean }).defer_loading ||
        isDirectToolAvailable(body, tool.name ?? ''),
    )
    .map((tool) => {
      if (typeof tool.name !== 'string' || !tool.name.trim() || !isRecord(tool.input_schema)) {
        return badRequest('Invalid tool');
      }
      return {
        name: toolName(tool.name),
        description: tool.description ?? '',
        parameters: tool.input_schema as Tool['parameters'],
      };
    });
}

export function toPiContext(
  body: MessagesRequest,
  model: PiCatalogModel,
  routeId: string,
  providerId = model.providerId ?? 'deepseek',
): PiTranslation {
  if (
    body.stop_sequences !== undefined &&
    (!Array.isArray(body.stop_sequences) || body.stop_sequences.length > 0)
  ) {
    return badRequest('stop_sequences are not supported');
  }
  if (!Array.isArray(body.messages)) {
    return badRequest('messages must be an array');
  }
  const declared = originalToolNames(body);
  const declaredNames = new Set(
    body.tools?.flatMap((tool) => (typeof tool.name === 'string' ? [tool.name] : [])) ?? [],
  );
  const callNames = new Map<string, string>();
  const messages: Message[] = [];
  for (const item of body.messages) {
    appendMessage(item, messages, declared, callNames, routeId, model, providerId);
  }
  const tools = translateTools(body);
  const systemPrompt = body.system === undefined ? undefined : readText(body.system);
  const context: Context = {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
    ...(tools.length ? { tools } : {}),
  };
  return { context, options: requestOptions(body, model, declaredNames) };
}

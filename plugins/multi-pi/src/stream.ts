import { randomUUID } from 'node:crypto';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type {
  Emit,
  MessagesRequest,
  MessagesResponse,
  ResponseContentBlock,
} from '../../multi-core/src/gateway/messages.ts';
import {
  openAIProtocolUsage,
  responseUsageMetadata,
} from '../../multi-core/src/gateway/response-usage.ts';
import { originalToolNames } from '../../multi-core/src/gateway/tools.ts';
import type { CanonicalTokenUsage } from '../../multi-core/src/gateway/usage-accounting.ts';
import { stripWorkerModel } from '../../multi-core/src/gateway/worker-models.ts';
import { encodePiSignature } from './signature.ts';

export interface PiStreamInput {
  first: AssistantMessageEvent;
  stream: AsyncIterable<AssistantMessageEvent>;
}

export interface PiStreamOptions {
  routeId: string;
  label: string;
  model: string;
  request: MessagesRequest;
  rememberWorkerModel?: (id: string, type: string, model: string) => void;
  usage?: () => CanonicalTokenUsage;
  inputTokens?: number;
  notice?: string;
}

interface OpenBlock {
  kind: 'thinking' | 'text';
  index: number;
  text: string;
  thinkingSignature?: string;
}

class PiStreamTranslator {
  private started = false;
  private readonly messageId = `msg_${randomUUID()}`;
  private block: OpenBlock | undefined;
  private nextIndex = 0;
  private readonly content: ResponseContentBlock[] = [];
  private readonly signatures = new Map<number, string | undefined>();
  private readonly safeErrors = new WeakSet<Error>();
  private readonly names: Map<string, string>;
  private readonly options: PiStreamOptions;
  private readonly emit: Emit;

  constructor(options: PiStreamOptions, emit: Emit) {
    this.options = options;
    this.emit = emit;
    this.names = originalToolNames(options.request);
  }

  async translate(input: PiStreamInput): Promise<MessagesResponse> {
    try {
      const result = this.consume(input.first);
      if (result) {
        return result;
      }
      for await (const event of input.stream) {
        const completed = this.consume(event);
        if (completed) {
          return completed;
        }
      }
    } catch (error) {
      if (error instanceof Error && this.safeErrors.has(error)) {
        throw error;
      }
      throw this.fail();
    }
    throw this.fail();
  }

  private fail(message = 'stream failed'): Error {
    const error = new Error(`${this.options.label} ${message}.`);
    this.safeErrors.add(error);
    return error;
  }

  private consume(event: AssistantMessageEvent): MessagesResponse | undefined {
    switch (event.type) {
      case 'start':
        this.start();
        return;
      case 'text_delta':
        this.assertStarted();
        this.assertNoTextSignature(event.partial);
        this.addDelta('text', event.delta);
        return;
      case 'thinking_delta':
        this.assertStarted();
        this.addThinkingDelta(event);
        return;
      case 'thinking_end':
        this.assertStarted();
        this.checkThinkingEnd(event);
        return;
      case 'text_end':
        this.assertStarted();
        this.assertNoTextSignature(event.partial);
        return;
      case 'toolcall_end':
        this.assertStarted();
        this.addTool(event);
        return;
      case 'done':
        this.assertStarted();
        this.assertNoTextSignature(event.message);
        return this.finish(event);
      case 'error':
        throw this.fail();
      default:
        this.assertStarted();
        return;
    }
  }

  private start(): void {
    if (this.started) {
      throw this.fail();
    }
    this.started = true;
    this.emit('message_start', {
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.options.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.options.inputTokens ?? 0, output_tokens: 0 },
      },
    });
    if (this.options.notice) {
      const index = this.nextIndex++;
      const text = `[${this.options.label}] ${this.options.notice}`;
      this.emit('content_block_start', { index, content_block: { type: 'text', text: '' } });
      this.emit('content_block_delta', { index, delta: { type: 'text_delta', text } });
      this.emit('content_block_stop', { index });
      this.content.push({ type: 'text', text });
    }
  }

  private assertStarted(): void {
    if (!this.started) {
      throw this.fail();
    }
  }

  private assertNoTextSignature(message: AssistantMessage): void {
    for (const item of message.content) {
      if (item.type === 'text' && 'textSignature' in item) {
        throw this.fail();
      }
    }
  }

  private addThinkingDelta(
    event: Extract<AssistantMessageEvent, { type: 'thinking_delta' }>,
  ): void {
    const item = event.partial.content[event.contentIndex];
    const signature = item?.type === 'thinking' ? item.thinkingSignature : undefined;
    this.observeSignature(event.contentIndex, signature);
    this.addDelta('thinking', event.delta, signature);
  }

  private addDelta(kind: 'thinking' | 'text', delta: string, signature?: string): void {
    if (this.block?.kind !== kind) {
      this.closeBlock();
      this.block = {
        kind,
        index: this.nextIndex++,
        text: '',
        ...(signature === undefined ? {} : { thinkingSignature: signature }),
      };
      this.emit('content_block_start', {
        index: this.block.index,
        content_block:
          kind === 'thinking'
            ? { type: 'thinking', thinking: '', signature: '' }
            : { type: 'text', text: '' },
      });
    }
    this.block.text += delta;
    this.emit('content_block_delta', {
      index: this.block.index,
      delta:
        kind === 'thinking'
          ? { type: 'thinking_delta', thinking: delta }
          : { type: 'text_delta', text: delta },
    });
  }

  private observeSignature(index: number, signature: string | undefined): void {
    if (signature !== undefined && signature !== 'reasoning_content') {
      throw this.fail();
    }
    if (this.signatures.has(index) && this.signatures.get(index) !== signature) {
      throw this.fail();
    }
    this.signatures.set(index, signature);
  }

  private checkThinkingEnd(event: Extract<AssistantMessageEvent, { type: 'thinking_end' }>): void {
    const item = event.partial.content[event.contentIndex];
    const signature = item?.type === 'thinking' ? item.thinkingSignature : undefined;
    this.observeSignature(event.contentIndex, signature);
  }

  private addTool(event: Extract<AssistantMessageEvent, { type: 'toolcall_end' }>): void {
    const call = event.toolCall;
    if (call.argumentsError !== undefined) {
      throw this.fail('returned a tool call with invalid arguments');
    }
    if (call.thoughtSignature !== undefined) {
      throw this.fail();
    }
    const name = this.names.get(call.name);
    if (name === undefined) {
      throw this.fail();
    }
    this.closeBlock();
    const toolBlock: ResponseContentBlock = {
      type: 'tool_use',
      id: call.id,
      name,
      input: structuredClone(call.arguments),
    };
    stripWorkerModel(toolBlock, this.options.rememberWorkerModel ?? (() => {}));
    const index = this.nextIndex++;
    this.emit('content_block_start', {
      index,
      content_block: { type: 'tool_use', id: call.id, name, input: {} },
    });
    this.emit('content_block_delta', {
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolBlock.input) },
    });
    this.emit('content_block_stop', { index });
    this.content.push(toolBlock);
  }

  private closeBlock(): void {
    const block = this.block;
    if (!block) {
      return;
    }
    if (block.kind === 'thinking') {
      const signature = encodePiSignature(this.options.routeId, {
        thinking: block.text,
        ...(block.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: block.thinkingSignature }),
      });
      this.content.push({ type: 'thinking', thinking: block.text, signature });
      this.emit('content_block_delta', {
        index: block.index,
        delta: { type: 'signature_delta', signature },
      });
    } else {
      this.content.push({ type: 'text', text: block.text });
    }
    this.emit('content_block_stop', { index: block.index });
    this.block = undefined;
  }

  private finish(event: Extract<AssistantMessageEvent, { type: 'done' }>): MessagesResponse {
    this.closeBlock();
    const canonical = this.options.usage?.() ?? { source: 'unavailable' };
    const stop_reason = this.stopReason(event.reason);
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      model: this.options.model,
      content: this.content,
      stop_reason,
      stop_sequence: null,
      usage: openAIProtocolUsage(canonical),
      multi_usage: responseUsageMetadata(canonical, this.options.model),
    };
  }

  private stopReason(
    reason: Extract<AssistantMessageEvent, { type: 'done' }>['reason'],
  ): 'end_turn' | 'max_tokens' | 'tool_use' {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'toolUse':
        return 'tool_use';
      default:
        throw this.fail();
    }
  }
}

export function translatePiStream(
  input: PiStreamInput,
  options: PiStreamOptions,
  emit?: Emit,
): Promise<MessagesResponse> {
  return new PiStreamTranslator(options, emit ?? (() => {})).translate(input);
}

// Opt-in live Pi provider canary. This file is intentionally never run by npm test/check.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBuiltinRegistry } from '../../plugins/multi-core/src/gateway/builtin-providers.ts';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import {
  type ProviderRegistry,
  ProviderRuntime,
} from '../../plugins/multi-core/src/gateway/provider-registry.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { createPiLiveReport } from './native-pi-report.ts';

export type PiLiveProvider = 'deepseek' | 'zai-coding-cn' | 'strata';

interface ProviderConfig {
  id: PiLiveProvider;
  model: string;
  key?: string;
  strataBaseUrl?: string;
  effort?: 'low';
  supportsThinking: boolean;
}

export interface PiLiveSelection {
  model: string;
  route: string;
}

export function resolvePiLiveSelection(provider: PiLiveProvider): PiLiveSelection {
  const modelByProvider: Record<PiLiveProvider, string> = {
    deepseek: 'deepseek-flash',
    'zai-coding-cn': 'glm-5.3-flash',
    strata: 'qwen3.8-flash-next',
  };
  const model = modelByProvider[provider];
  return { model, route: `multi/${provider}/${model}` };
}

function parseProvider(args: string[]): PiLiveProvider {
  const index = args.indexOf('--provider');
  if (index < 0) {
    return 'deepseek';
  }
  const provider = args[index + 1];
  if (
    args.length !== 2 ||
    index !== 0 ||
    (provider !== 'deepseek' && provider !== 'zai-coding-cn' && provider !== 'strata')
  ) {
    throw new Error(
      'Usage: node test/live/native-pi.ts [--provider deepseek|zai-coding-cn|strata]',
    );
  }
  return provider;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Set ${name} before running the Pi live check.`);
  }
  return value;
}

async function runPiLive(): Promise<void> {
  const providerId = parseProvider(process.argv.slice(2));
  const selection = resolvePiLiveSelection(providerId);
  let config: ProviderConfig;
  let registry: ProviderRegistry;
  if (providerId === 'deepseek') {
    const key = requiredEnv('DEEPSEEK_API_KEY');
    config = {
      id: providerId,
      model: selection.model,
      key,
      effort: 'low',
      supportsThinking: true,
    };
    registry = createBuiltinRegistry({ piKeys: { deepseek: key } });
  } else if (providerId === 'zai-coding-cn') {
    const key = requiredEnv('ZAI_CODING_CN_API_KEY');
    config = {
      id: providerId,
      model: selection.model,
      key,
      effort: 'low',
      supportsThinking: true,
    };
    registry = createBuiltinRegistry({ piKeys: { 'zai-coding-cn': key } });
  } else {
    const strataBaseUrl = requiredEnv('MULTI_STRATA_BASE_URL');
    const key = process.env.STRATA_API_KEY;
    config = {
      id: providerId,
      model: selection.model,
      ...(key ? { key } : {}),
      strataBaseUrl,
      supportsThinking: false,
    };
    registry = createBuiltinRegistry({
      ...(key ? { piKeys: { strata: key } } : {}),
      strataBaseUrl,
    });
  }

  const canary = `PI_LIVE_CANARY_${randomBytes(16).toString('hex')}`;
  const gatewayToken = randomBytes(32).toString('hex');
  const session = randomUUID();
  const maxUpstreamRequests = 10;
  const events: GatewayEvent[] = [];
  const descriptor = registry.get(providerId);
  assert(
    descriptor?.kind === 'direct' && descriptor.direct,
    `${providerId} Direct provider is registered`,
  );
  const runtime = new ProviderRuntime([{ descriptor, models: [] }], { registry });
  const server = createNativeGateway({
    token: gatewayToken,
    runtime,
    onEvent: (event) => events.push(event),
  });
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'native-pi-'));
  const reportPath = path.join(artifacts, 'report.json');
  const scenarios: Record<string, string> = {
    multiTurnToolCall: '未完成',
    thinkingRoundTrip: config.supportsThinking
      ? '未完成'
      : '不适用：Strata 模型不支持 thinking/effort',
    usage: '未完成',
  };

  function scanned(value: string, label: string): string {
    if (config.key) {
      assert(!value.includes(config.key), `${label} contains the configured key; output withheld`);
    }
    assert(!value.includes(canary), `${label} contains the canary; output withheld`);
    return value;
  }

  const report = createPiLiveReport({
    events,
    maxUpstreamRequests,
    provider: providerId,
    model: selection.model,
    scenarios,
    scan: scanned,
    write: (value) => writeFile(reportPath, value, 'utf8'),
  });

  async function listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object', 'Gateway did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  async function request(
    url: string,
    messages: unknown[],
    tools: unknown[],
  ): Promise<MessagesResponse> {
    return report.request(() => {
      const body = {
        model: selection.route,
        max_tokens: 1024,
        stream: false,
        ...(config.supportsThinking
          ? {
              thinking: { type: 'adaptive', budget_tokens: 1024 },
              output_config: { effort: config.effort },
            }
          : {}),
        messages,
        tools,
      };
      return fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-multi-gateway-token': gatewayToken,
          'x-claude-code-session-id': session,
        },
        body: JSON.stringify(body),
      });
    });
  }

  try {
    await report.run(async () => {
      const url = await listen();
      const tools = [
        {
          name: 'echo',
          description: 'Return the supplied text unchanged.',
          input_schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ];
      const first = await request(
        url,
        [{ role: 'user', content: 'Use the echo tool once with the text "pi-canary-live".' }],
        tools,
      );
      assert.equal(
        first.stop_reason,
        'tool_use',
        'First response was truncated or did not finish the tool-call turn',
      );
      const toolCall = first.content.find((block) => block.type === 'tool_use');
      assert(toolCall?.type === 'tool_use', 'Tool-call scenario incomplete: no tool_use returned');
      assert(
        first.usage.input_tokens + first.usage.output_tokens > 0,
        'First response has no usage',
      );
      if (config.supportsThinking) {
        const thinking = first.content.filter((block) => block.type === 'thinking');
        assert(
          thinking.length > 0,
          'Thinking scenario incomplete: no signed thinking block returned',
        );
        assert(
          thinking.every((block) => typeof block.signature === 'string'),
          'Thinking blocks must retain signatures',
        );
      }
      const second = await request(
        url,
        [
          { role: 'user', content: 'Use the echo tool once with the text "pi-canary-live".' },
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: 'pi-canary-live' }],
          },
        ],
        tools,
      );
      assert.notEqual(second.stop_reason, 'max_tokens', 'Follow-up response was truncated');
      assert.equal(
        second.stop_reason,
        'end_turn',
        'Tool result did not complete with a final answer',
      );
      const finalText = second.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      assert(finalText.trim().length > 0, 'Follow-up response has no final text');
      assert(
        second.usage.input_tokens + second.usage.output_tokens > 0,
        'Follow-up response has no usage',
      );
      scenarios.multiTurnToolCall = 'passed';
      if (config.supportsThinking) {
        scenarios.thinkingRoundTrip = 'passed';
      }
      scenarios.usage = 'passed';
    });
    console.log(
      scanned(
        `PASS: Pi ${providerId} live scenarios finished; report: ${reportPath}`,
        'console output',
      ),
    );
  } finally {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href) {
  await runPiLive();
}

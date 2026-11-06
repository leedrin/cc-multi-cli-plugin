// Side-effect-free lifecycle shared by the opt-in live script and offline tests.
import assert from 'node:assert/strict';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';

interface ReportOptions {
  events: ReadonlyArray<{ route: string }>;
  maxUpstreamRequests: number;
  provider?: string;
  model: string;
  effort?: string;
  scenarios: Record<string, string>;
  scan: (value: string, label: string) => string;
  write: (value: string) => Promise<void>;
}

export function createPiLiveReport(options: ReportOptions) {
  const usage: Array<MessagesResponse['usage']> = [];
  const provider = options.provider ?? 'deepseek';
  const upstreamRequests = () =>
    options.events.filter(({ route }) => route === `${provider}-request`).length;

  async function writeReport(status: 'passed' | '未完成'): Promise<void> {
    const value = JSON.stringify(
      {
        status,
        provider,
        model: options.model,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        upstreamRequests: upstreamRequests(),
        maxUpstreamRequests: options.maxUpstreamRequests,
        scenarios: options.scenarios,
        usage,
      },
      null,
      2,
    );
    await options.write(options.scan(value, 'report'));
  }

  async function request(
    send: () => Promise<{ status: number; text: () => Promise<string> }>,
  ): Promise<MessagesResponse> {
    assert(upstreamRequests() < options.maxUpstreamRequests, 'Upstream request budget exhausted');
    const response = await send();
    const body = await response.text();
    options.scan(body, 'gateway response');
    assert(upstreamRequests() <= options.maxUpstreamRequests, 'Upstream request budget exceeded');
    assert.equal(response.status, 200, `Gateway request failed with HTTP ${response.status}`);
    const result = JSON.parse(body) as MessagesResponse;
    usage.push(result.usage);
    assert.notEqual(result.stop_reason, 'max_tokens', 'Response was truncated');
    return result;
  }

  async function run(scenarios: () => Promise<void>): Promise<void> {
    try {
      await scenarios();
      assert(upstreamRequests() > 0, 'No upstream request events captured');
      assert(upstreamRequests() <= options.maxUpstreamRequests, 'Upstream request budget exceeded');
    } catch {
      await writeReport('未完成');
      // Never copy exception text: transport/body errors can contain credentials.
      throw new Error('Pi live check failed; scenario incomplete');
    }
    await writeReport('passed');
  }

  return { request, run };
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPiLiveReport } from '../live/native-pi-report.ts';

const key = 'fake-pi-key-canary';
const canary = 'fake-pi-content-canary';
const usage = { input_tokens: 2, output_tokens: 1 };

for (const scenario of ['scan', 'body', 'budget', 'truncated', 'exception']) {
  test(`Pi live ${scenario} preserves consumed requests in a secret-free incomplete report`, async () => {
    const events = [{ route: 'deepseek-request' }, { route: 'deepseek-complete' }];
    if (scenario === 'budget') {
      events.push({ route: 'deepseek-request' });
    }
    const reports: string[] = [];
    let calls = 0;
    const report = createPiLiveReport({
      events,
      maxUpstreamRequests: 2,
      model: 'deepseek-flash',
      scenarios: { tool: '未完成' },
      scan(value) {
        assert(!value.includes(key), 'key output withheld');
        assert(!value.includes(canary), 'canary output withheld');
        return value;
      },
      async write(value) {
        reports.push(value);
      },
    });
    await assert.rejects(
      report.run(async () => {
        await report.request(async () => {
          calls++;
          events.push({ route: 'deepseek-request' });
          if (scenario === 'exception') {
            throw new Error(`${key} ${canary}`);
          }
          return {
            status: 200,
            async text() {
              if (scenario === 'body') {
                throw new Error(`${key} ${canary}`);
              }
              if (scenario === 'scan') {
                return `${key} ${canary}`;
              }
              return JSON.stringify({ stop_reason: 'max_tokens', usage, content: [] });
            },
          };
        });
      }),
      /Pi live check failed; scenario incomplete/,
    );
    assert.equal(calls, scenario === 'budget' ? 0 : 1, 'failure must not retry');
    assert.equal(reports.length, 1, 'exactly one terminal report');
    const saved = JSON.parse(reports[0]);
    assert.equal(saved.status, '未完成');
    assert.equal(saved.scenarios.tool, '未完成');
    assert.equal(saved.upstreamRequests, 2, 'all consumed request events must be counted');
    assert.equal(saved.maxUpstreamRequests, 2);
    assert.deepEqual(saved.usage, scenario === 'truncated' ? [usage] : []);
    assert(!reports[0].includes(key), 'report must not contain key');
    assert(!reports[0].includes(canary), 'report must not contain canary');
  });
}

test('Pi live successful report shares event accounting and retains usage', async () => {
  const events: Array<{ route: string }> = [];
  const reports: string[] = [];
  const scenarios = { tool: '未完成' };
  const report = createPiLiveReport({
    events,
    maxUpstreamRequests: 2,
    model: 'deepseek-flash',
    scenarios,
    scan: (value) => value,
    write: async (value) => {
      reports.push(value);
    },
  });
  await report.run(async () => {
    await report.request(async () => {
      events.push({ route: 'deepseek-request' });
      return { status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', usage }) };
    });
    scenarios.tool = 'passed';
  });
  assert.equal(reports.length, 1);
  assert.deepEqual(JSON.parse(reports[0]), {
    status: 'passed',
    provider: 'deepseek',
    model: 'deepseek-flash',
    upstreamRequests: 1,
    maxUpstreamRequests: 2,
    scenarios: { tool: 'passed' },
    usage: [usage],
  });
});

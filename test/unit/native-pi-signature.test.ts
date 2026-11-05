import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePiSignature,
  encodePiSignature,
  PI_SIGNATURE_PREFIX,
} from '../../plugins/multi-pi/src/signature.ts';

test('Pi signature round-trips route-scoped thinking payloads', () => {
  const signature = encodePiSignature('multi/deepseek/deepseek-v4-pro', {
    thinking: 'reasoning',
    thinkingSignature: 'reasoning_content',
    redacted: false,
  });
  assert.equal(signature.startsWith(PI_SIGNATURE_PREFIX), true);
  assert.equal(
    signature,
    `multipi:v1:multi%2Fdeepseek%2Fdeepseek-v4-pro:${Buffer.from(JSON.stringify({ thinking: 'reasoning', thinkingSignature: 'reasoning_content', redacted: false })).toString('base64url')}`,
  );
  assert.deepEqual(decodePiSignature(signature, 'multi/deepseek/deepseek-v4-pro'), {
    kind: 'owned',
    payload: { thinking: 'reasoning', thinkingSignature: 'reasoning_content', redacted: false },
  });
});

test('foreign or other-route Pi signatures are discarded', () => {
  assert.deepEqual(decodePiSignature('other:opaque', 'route'), { kind: 'foreign' });
  const signature = encodePiSignature('route-a', { thinking: 'secret' });
  assert.deepEqual(decodePiSignature(signature, 'route-b'), { kind: 'foreign' });
});

test('parseable owned Pi signatures reject every invalid payload shape without leaking bytes', () => {
  const payloads = [
    'null',
    '[]',
    '{}',
    '{"thinking":1}',
    '{"thinking":"x","thinkingSignature":1}',
    '{"thinking":"x","redacted":"false"}',
  ];
  for (const payload of payloads) {
    const encoded = Buffer.from(payload).toString('base64url');
    const signature = `${PI_SIGNATURE_PREFIX}route:${encoded}`;
    assert.throws(
      () => decodePiSignature(signature, 'route'),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'Invalid Pi thinking signature' &&
        !error.message.includes(signature),
    );
  }
});

for (const redacted of ['false', 0, null, {}, []]) {
  test(`owned Pi signature rejects redacted type ${JSON.stringify(redacted)}`, () => {
    const payload = JSON.stringify({ thinking: 'private reasoning', redacted });
    const signature = `${PI_SIGNATURE_PREFIX}route:${Buffer.from(payload).toString('base64url')}`;
    assert.throws(() => decodePiSignature(signature, 'route'), {
      message: 'Invalid Pi thinking signature',
    });
  });
}

test('malformed owned Pi signatures fail without leaking signature bytes', () => {
  const signature = `${PI_SIGNATURE_PREFIX}route:canary-payload`;
  assert.throws(
    () => decodePiSignature(signature, 'route'),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'Invalid Pi thinking signature' &&
      !error.message.includes(signature),
  );
});

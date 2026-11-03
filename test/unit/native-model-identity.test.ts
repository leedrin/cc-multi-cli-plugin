import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeModelRoute,
  encodeModelRoute,
} from '../../plugins/multi-core/src/gateway/model-identity.ts';

test('encodes and decodes provider and model identities', () => {
  for (const [providerId, modelId] of [
    ['deepseek', 'deepseek-v4-pro'],
    ['deepseek', 'org/model@v1'],
    ['provider.example', 'model'],
    ['zai-coding-cn', 'org/model@v1'],
  ]) {
    const route = encodeModelRoute(providerId, modelId);
    const identity = decodeModelRoute(route);
    assert.equal(identity?.providerId, providerId);
    assert.equal(identity?.modelId, modelId);
    assert.equal(identity?.routeId, route);
    assert.equal(identity?.preset, undefined);
    assert.equal(identity?.oneMillionContext, false);
  }
  assert.equal(
    encodeModelRoute('zai-coding-cn', 'org/model@v1'),
    'multi/zai-coding-cn/org%2Fmodel%40v1',
  );
  assert.equal(decodeModelRoute('multi/vendor/org%2Fmodel%40v1')?.modelId, 'org/model@v1');
});

test('preserves legacy tags and raw preset suffixes', () => {
  assert.deepEqual(decodeModelRoute('multi/openai/gpt-x[1m]'), {
    providerId: 'openai',
    modelId: 'gpt-x',
    routeId: 'multi/openai/gpt-x',
    oneMillionContext: true,
  });
  assert.deepEqual(decodeModelRoute('multi/cursor/composer-2.5/effort=high,mode=fast[1m]'), {
    providerId: 'cursor',
    modelId: 'composer-2.5',
    routeId: 'multi/cursor/composer-2.5/effort=high,mode=fast',
    preset: 'effort=high,mode=fast',
    oneMillionContext: true,
  });
  assert.equal(decodeModelRoute('multi/zai/glm-5.3')?.providerId, 'zai');
});

test('rejects malformed route identities', () => {
  for (const route of [
    'openai/gpt-x',
    'multi//x',
    'multi/core/x',
    'multi/OpenAI/x',
    `multi/${'a'.repeat(65)}/x`,
    'multi/openai/',
    'multi/openai/%ZZ',
  ]) {
    assert.equal(decodeModelRoute(route), undefined, route);
  }
});

test('rejects invalid values when encoding', () => {
  for (const providerId of ['', 'core', 'OpenAI', 'a'.repeat(65), '-bad']) {
    assert.throws(() => encodeModelRoute(providerId, 'model'), Error);
  }
  assert.throws(() => encodeModelRoute('openai', ''), Error);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayFetch } from '../../plugins/multi-core/src/gateway/fetch.ts';
import type { Emit, MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { httpUpstream } from '../../plugins/multi-core/src/gateway/provider-request.ts';
import type { RememberWorkerModel } from '../../plugins/multi-core/src/gateway/worker-models.ts';

const rememberWorkerModel: RememberWorkerModel = () => {};
const responseResult = { id: 'msg_1', type: 'message' } as MessagesResponse;

function bodyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
}

test('httpUpstream translates a successful response and forwards the signal to fetch', async () => {
  const signal = new AbortController().signal;
  let receivedSignal: AbortSignal | undefined;
  let responseBody: ReadableStream<Uint8Array> | undefined;
  const fetchImpl: GatewayFetch = async (_url, init) => {
    receivedSignal = init.signal;
    const response = new Response(bodyStream(), { status: 200 });
    responseBody = response.body ?? undefined;
    return response;
  };
  let translatedBody: ReadableStream<Uint8Array> | undefined;
  let translatedEmit: Emit | undefined;
  let translatedRememberWorkerModel: RememberWorkerModel | undefined;
  const emit: Emit = () => {};
  const opened = await httpUpstream(
    () =>
      fetchImpl('https://example.test/upstream', {
        method: 'POST',
        headers: {},
        signal,
        redirect: 'error',
      }),
    async (body, receivedEmit, receivedRememberWorkerModel) => {
      translatedBody = body;
      translatedEmit = receivedEmit;
      translatedRememberWorkerModel = receivedRememberWorkerModel;
      return responseResult;
    },
  );

  assert.equal(receivedSignal, signal);
  assert.equal(opened.ok, true);
  if (!opened.ok) {
    throw new Error('Expected upstream success');
  }
  assert.equal(translatedBody, undefined);
  assert.equal(await opened.translate(emit, rememberWorkerModel), responseResult);
  assert.equal(translatedBody, responseBody);
  assert.equal(translatedEmit, emit);
  assert.equal(translatedRememberWorkerModel, rememberWorkerModel);
});

test('httpUpstream returns status and retry-after for a non-2xx response', async () => {
  let bodyCancelled = false;
  const responseBody = new ReadableStream<Uint8Array>({
    cancel() {
      bodyCancelled = true;
    },
  });
  const opened = await httpUpstream(
    async () =>
      new Response(responseBody, {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    async () => responseResult,
  );

  assert.deepEqual(opened, { ok: false, status: 429, retryAfter: '7' });
  assert.equal(bodyCancelled, true);
});

test('httpUpstream propagates network errors', async () => {
  const networkError = new Error('network unavailable');
  await assert.rejects(
    httpUpstream(
      async () => {
        throw networkError;
      },
      async () => responseResult,
    ),
    (error: unknown) => error === networkError,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../js/script.js';

function isAbortError(error) {
  return error?.name === 'AbortError' && error?.code === 'ABORT_ERR';
}

test('issue #4798 - abort racing with listener registration is not swallowed', async () => {
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener() {
      aborted = true;
    },
    removeEventListener() {},
  };
  let cancelCount = 0;
  const request = Promise.resolve({ found: true, bytes: new Uint8Array([1]) });
  request.cancel = () => { cancelCount += 1; };
  const app = { backend: { readAt: () => request } };
  const { api } = createApi(app, () => {});

  await assert.rejects(api.bytes(0n, 1, { signal }), isAbortError);
  assert.equal(cancelCount, 1, 'cancellable request must be cancelled exactly once');
});

test('issue #4798 - already-aborted signal keeps rejecting before awaiting', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  let readCount = 0;
  const app = { backend: { readAt: () => { readCount += 1; return Promise.resolve({ found: true, bytes: new Uint8Array([1]) }); } } };
  const { api } = createApi(app, () => {});

  await assert.rejects(api.bytes(0n, 1, { signal: controller.signal }), isAbortError);
  assert.equal(readCount, 1);
});

test('issue #4798 - mid-flight abort on a live signal rejects and cleans up', async () => {
  const controller = new AbortController();
  let cancelCount = 0;
  const pending = new Promise(() => {});
  pending.cancel = () => { cancelCount += 1; };
  const app = { backend: { readAt: () => pending } };
  const { api } = createApi(app, () => {});

  const running = api.bytes(0n, 1, { signal: controller.signal });
  await Promise.resolve();
  controller.abort('stop');
  controller.abort('again');

  await assert.rejects(running, isAbortError);
  assert.equal(cancelCount, 1, 'duplicate abort events must not double-settle or double-cancel');
});

test('issue #4798 - non-aborted request resolves normally', async () => {
  const controller = new AbortController();
  const expected = new Uint8Array([1, 2, 3]);
  const app = { backend: { readAt: () => Promise.resolve({ found: true, bytes: expected }) } };
  const { api } = createApi(app, () => {});

  const bytes = await api.bytes(0n, 3, { signal: controller.signal });
  assert.equal(bytes, expected);
});

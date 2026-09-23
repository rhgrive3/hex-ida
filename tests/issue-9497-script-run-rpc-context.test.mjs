import assert from 'node:assert/strict';
import test from 'node:test';
import { createApi } from '../js/script.js';

function api() {
  return createApi({
    store: { get: () => null },
    codeRegion: () => null,
  }, () => {}).api;
}

test('#9497 run treats second-argument RPC execution context as context, not args', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('stopped', 'AbortError'));
  await assert.rejects(
    () => api().run(0x1000n, { signal: controller.signal }),
    (error) => error?.name === 'AbortError' && !/args\.map/.test(String(error?.message)),
  );
});

test('#9497 malformed explicit args fail with a stable validation error', async () => {
  await assert.rejects(() => api().run(0x1000n, { nope: true }), /run args must be an array/);
});

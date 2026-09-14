import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../js/script.js';

test('issue #5898 - patch forwards the execution AbortSignal to the byte read', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, fileOffset: 0n, exec: true };
  let cancelled = false;
  const read = new Promise(() => {});
  read.cancel = () => { cancelled = true; };
  const app = {
    store: {
      get(key) {
        if (key === 'architecture') return 'arm64';
        if (key === 'regions') return [region];
        if (key === 'file') return { size: 0x1000 };
        return null;
      },
    },
    codeRegion: () => region,
    backend: { readAt: () => read },
    patches: { add() { throw new Error('patch must not be registered after cancellation'); } },
  };
  const { api } = createApi(app, () => {});
  const controller = new AbortController();
  const pending = api.patch(0x1000n, '00', { signal: controller.signal });

  await Promise.resolve();
  controller.abort('stop');

  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.equal(cancelled, true);
});

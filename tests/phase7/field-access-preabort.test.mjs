import assert from 'node:assert/strict';
import test from 'node:test';

import { fieldAccessRegion } from '../../js/analysis/field-access-artifact.js';

test('pre-aborted field-access consumer does not start a backend producer', async () => {
  const controller = new AbortController();
  controller.abort();

  let calls = 0;
  const backend = {
    fieldAccess() {
      calls++;
      return Promise.resolve({ results: [], complete: true });
    },
  };

  await assert.rejects(
    fieldAccessRegion(backend, { id: 'R', exec: true }, 0n, 4, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
  assert.equal(calls, 0);
});

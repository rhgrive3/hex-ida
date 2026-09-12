// Regression for #4596: FunctionSandbox.setup() silently converted an
// explicit watch size into a different valid read width (`Math.max(1,
// Number(w.size || 8))`): 0 became the default 8, -1 clamped to 1, numeric
// strings / arrays / booleans coerced. watch drives the before/after memory
// snapshots and touchedFields ranges, so observation must not stray from the
// caller-specified width; only an omitted/nullish size may default to 8 and
// any explicit non-positive-safe-integer must fail closed before the first
// snapshot read.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFunctionSandbox } from '../js/symbolic/function-sandbox.js';

function retIo() {
  return {
    fetch: async (pc) => (pc === 4096n || pc === 0x1000n ? { mn: 'ret', ops: '' } : null),
    read: async () => null,
    isExecutable: () => true,
  };
}

async function normalizedWatchSize(size) {
  const sandbox = createFunctionSandbox({}, {});
  const watch = size === undefined ? [{ offset: 0 }] : [{ offset: 0, size }];
  await sandbox.setup(0x1000n, { watch });
  return sandbox.watch[0].size;
}

test('#4596 an omitted watch size still defaults to 8', async () => {
  assert.equal(await normalizedWatchSize(undefined), 8);
});

test('#4596 a null watch size defaults to 8', async () => {
  assert.equal(await normalizedWatchSize(null), 8);
});

test('#4596 explicit positive safe-integer sizes are kept verbatim', async () => {
  for (const size of [1, 2, 4, 8, 16]) {
    assert.equal(await normalizedWatchSize(size), size, `watch size ${size} must be kept`);
  }
});

test('#4596 an explicit size of 0 is rejected instead of becoming 8', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, { watch: [{ offset: 0, size: 0 }] }),
    (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
  );
});

test('#4596 a negative size is rejected instead of clamped to 1', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, { watch: [{ offset: 0, size: -1 }] }),
    (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
  );
});

test('#4596 numeric strings, arrays, booleans and objects are not coerced', async () => {
  for (const badSize of ['16', [4], true, {}, 8.5, NaN, Infinity, 2 ** 53]) {
    const sandbox = createFunctionSandbox({}, {});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { watch: [{ offset: 0, size: badSize }] }),
      (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
      `watch size ${String(badSize)} must be rejected`,
    );
  }
});

test('#4596 an invalid watch size does not start the memory snapshot', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, { watch: [{ offset: 0, size: 0 }] }),
    TypeError,
  );
  assert.deepEqual(sandbox.watch, []);
  assert.deepEqual(sandbox.before, []);
});

test('#4596 valid watch before/after/touchedFields range semantics are unchanged', async () => {
  const sandbox = createFunctionSandbox(retIo(), {});
  await sandbox.setup(0x1000n, {
    args: [0n],
    objectAsArg0: false,
    watch: [{ name: 'head', offset: 0, size: 4 }, { name: 'wide', offset: 8, size: 8 }],
  });
  assert.deepEqual(sandbox.watch.map((w) => w.size), [4, 8]);
  assert.deepEqual(sandbox.before.map((w) => w.size), [4, 8]);
  const result = await sandbox.run({ maxSteps: 10 });
  assert.deepEqual(result.before.map((w) => w.size), [4, 8]);
  assert.deepEqual(result.after.map((w) => w.size), [4, 8]);
  assert.deepEqual(result.touchedFields, []);
});

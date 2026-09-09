// Issue #5318 regression: FunctionSandbox.setup() accepted objectMemory
// initializers at offsets beyond maxObjectSize. The initializer write fell
// through into the synthetic heap backing next to the object region and
// succeeded, escaping the boundary that mapZero()/modifiedRanges() enforce.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSandbox, DEFAULT_OBJECT_BASE } from '../js/symbolic/function-sandbox.js';

test('#5318 an objectMemory offset beyond maxObjectSize is rejected', async () => {
  const sandbox = createFunctionSandbox({}, { maxObjectSize: 0x10000 });
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      objectAsArg0: false,
      objectMemory: [{ offset: 0x20000, size: 8, value: 0x1234n }],
    }),
    (error) => error instanceof RangeError && /outside the sandbox object region/.test(error.message),
  );
});

test('#5318 an initializer write partially crossing the object end is rejected', async () => {
  const sandbox = createFunctionSandbox({}, { maxObjectSize: 0x10000 });
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      objectAsArg0: false,
      objectMemory: [{ offset: 0xfffc, size: 8, value: 0n }],
    }),
    RangeError,
  );
});

test('#5318 in-bounds objectMemory initializers keep working', async () => {
  const sandbox = createFunctionSandbox({}, { maxObjectSize: 0x10000 });
  await sandbox.setup(0x1000n, {
    objectAsArg0: false,
    objectMemory: [{ offset: 0xfff8, size: 8, value: 0x1234n }],
  });
  const read = await sandbox.emulator.load(DEFAULT_OBJECT_BASE + 0xfff8n, 8);
  assert.equal(read, 0x1234n);
});

test('#5318 the object-keyed form is bounds-checked too', async () => {
  const sandbox = createFunctionSandbox({}, { maxObjectSize: 0x10000 });
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      objectAsArg0: false,
      objectMemory: { '0x20000': 0x1234n },
    }),
    RangeError,
  );
});

// Regression for #4609: FunctionSandbox.setup() coerced the explicit size of
// objectMemory/stackMemory initializers with `Number(item.size || 8)` before
// Emulator.store(), so size 0 became an 8-byte write and numeric strings /
// arrays / booleans became valid write widths, bypassing the strict
// normalizeMemorySize() check downstream. Only an omitted/nullish size may
// default to 8; an explicit size must be a primitive positive safe integer on
// both the objectMemory and the stackMemory path. (The objectMemory path
// gained its guard via #5318; the stackMemory path must match it.)
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFunctionSandbox, DEFAULT_OBJECT_BASE } from '../js/symbolic/function-sandbox.js';

const BAD_SIZES = [0, -1, '4', ['4'], true, {}, 8.5, NaN, Infinity, 2 ** 53];

test('#4609 stackMemory with an omitted size still writes the default 8 bytes', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await sandbox.setup(0x1000n, {
    stackMemory: [{ offset: 0, value: 0x1122334455667788n }],
  });
  assert.equal(await sandbox.emulator.load(sandbox.emulator.sp, 8), 0x1122334455667788n);
});

test('#4609 stackMemory keeps primitive explicit sizes', async () => {
  const cases = [[1, 0x42n], [2, 0x1234n], [4, 0xaabbccddn], [8, 0x1122334455667788n]];
  for (const [size, value] of cases) {
    const sandbox = createFunctionSandbox({}, {});
    await sandbox.setup(0x1000n, { stackMemory: [{ offset: 0, size, value }] });
    assert.equal(await sandbox.emulator.load(sandbox.emulator.sp, size), value, `stack size ${size}`);
  }
});

test('#4609 stackMemory size 0 is rejected instead of becoming an 8-byte write', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      stackMemory: [{ offset: 0, size: 0, value: 0x1122334455667788n }],
    }),
    (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
  );
  assert.equal(await sandbox.emulator.load(sandbox.emulator.sp, 8), 0n);
});

test('#4609 stackMemory does not coerce structured sizes into valid writes', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      stackMemory: [{ offset: 0, size: ['4'], value: 0xaabbccddn }],
    }),
    (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
  );
  assert.equal(await sandbox.emulator.load(sandbox.emulator.sp, 4), 0n);
});

test('#4609 every invalid explicit size is rejected on the stackMemory path', async () => {
  for (const size of BAD_SIZES) {
    const sandbox = createFunctionSandbox({}, {});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { stackMemory: [{ offset: 0, size, value: 0n }] }),
      (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
      `stackMemory size ${String(size)} must be rejected`,
    );
  }
});

test('#4609 every invalid explicit size is rejected on the objectMemory path', async () => {
  for (const size of BAD_SIZES) {
    const sandbox = createFunctionSandbox({}, {});
    await assert.rejects(
      () => sandbox.setup(0x1000n, {
        objectAsArg0: false,
        objectMemory: [{ offset: 0, size, value: 0n }],
      }),
      (error) => error instanceof TypeError && /positive safe integer/.test(error.message),
      `objectMemory size ${String(size)} must be rejected`,
    );
  }
});

test('#4609 objectMemory with an omitted size still writes the default 8 bytes', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await sandbox.setup(0x1000n, {
    objectAsArg0: false,
    objectMemory: [{ offset: 0, value: 0x1122334455667788n }],
  });
  assert.equal(await sandbox.emulator.load(DEFAULT_OBJECT_BASE, 8), 0x1122334455667788n);
});

test('#4609 objectMemory keeps primitive explicit sizes', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await sandbox.setup(0x1000n, {
    objectAsArg0: false,
    objectMemory: [{ offset: 0, size: 4, value: 0xaabbccddn }],
  });
  assert.equal(await sandbox.emulator.load(DEFAULT_OBJECT_BASE, 4), 0xaabbccddn);
});

test('#4609 an invalid objectMemory size leaves no memory write', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      objectAsArg0: false,
      objectMemory: [{ offset: 0x10, size: '8', value: 0xdeadbeefn }],
    }),
    TypeError,
  );
  assert.equal(await sandbox.emulator.load(DEFAULT_OBJECT_BASE + 0x10n, 8), 0n);
});

test('#4609 an invalid stackMemory size leaves no memory write', async () => {
  const sandbox = createFunctionSandbox({}, {});
  await assert.rejects(
    () => sandbox.setup(0x1000n, {
      stackMemory: [{ offset: 0x20, size: 0, value: 0xfeedfacfn }],
    }),
    TypeError,
  );
  assert.equal(await sandbox.emulator.load(sandbox.emulator.sp + 0x20n, 8), 0n);
});

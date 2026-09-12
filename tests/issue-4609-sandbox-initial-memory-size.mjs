import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSandbox, DEFAULT_OBJECT_BASE } from '../js/symbolic/function-sandbox.js';

const INVALID_SIZES = [0, -1, -8, 1.5, 2 ** 53, NaN, Infinity, '4', '', ['4'], [], true, false, {}, 4n];

function newSandbox() {
  return createFunctionSandbox({}, { maxObjectSize: 0x10000 });
}

async function objectWrite(sandbox, item) {
  return sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: [item] });
}

async function stackWrite(sandbox, item) {
  return sandbox.setup(0x1000n, { objectAsArg0: false, stackMemory: [item] });
}

function isSizeTypeError(error) {
  return error instanceof TypeError && /size must be a positive safe integer/.test(error.message);
}

test('#4609 an omitted initial-write size still defaults to 8 bytes on both paths', async () => {
  const object = newSandbox();
  await objectWrite(object, { offset: 0, value: 0x1122334455667788n });
  assert.equal(await object.emulator.load(DEFAULT_OBJECT_BASE, 8), 0x1122334455667788n);

  const stack = newSandbox();
  await stackWrite(stack, { offset: 0, value: 0x1122334455667788n });
  assert.equal(await stack.emulator.load(stack.emulator.sp, 8), 0x1122334455667788n);
});

test('#4609 primitive sizes 1/2/4/8 write exactly the requested width on both paths', async () => {
  for (const size of [1, 2, 4, 8]) {
    const object = newSandbox();
    await objectWrite(object, { offset: 0x40, size, value: 0x1122334455667788n });
    const objectMasked = 0x1122334455667788n & ((1n << BigInt(size * 8)) - 1n);
    assert.equal(await object.emulator.load(DEFAULT_OBJECT_BASE + 0x40n, size), objectMasked);
    if (size < 8) assert.equal(await object.emulator.load(DEFAULT_OBJECT_BASE + 0x40n + BigInt(size), 8 - size), 0n);

    const stack = newSandbox();
    await stackWrite(stack, { offset: 0x40, size, value: 0x1122334455667788n });
    assert.equal(await stack.emulator.load(stack.emulator.sp + 0x40n, size), objectMasked);
    if (size < 8) assert.equal(await stack.emulator.load(stack.emulator.sp + 0x40n + BigInt(size), 8 - size), 0n);
  }
});

test('#4609 explicit size 0 is rejected on both paths instead of becoming an 8-byte write', async () => {
  const object = newSandbox();
  await assert.rejects(
    () => objectWrite(object, { offset: 0, size: 0, value: 0x1122334455667788n }),
    isSizeTypeError,
  );
  assert.equal(await object.emulator.load(DEFAULT_OBJECT_BASE, 8), 0n);

  const stack = newSandbox();
  await assert.rejects(
    () => stackWrite(stack, { offset: 0, size: 0, value: 0x1122334455667788n }),
    isSizeTypeError,
  );
  assert.equal(await stack.emulator.load(stack.emulator.sp, 8), 0n);
});

test('#4609 invalid sizes are rejected on both paths without leaving a memory write', async () => {
  for (const size of INVALID_SIZES) {
    const object = newSandbox();
    await assert.rejects(
      () => objectWrite(object, { offset: 0, size, value: 0x1122334455667788n }),
      isSizeTypeError,
      `objectMemory size ${String(size)} must be rejected`,
    );
    assert.equal(await object.emulator.load(DEFAULT_OBJECT_BASE, 8), 0n, `objectMemory size ${String(size)} must not leave a write`);

    const stack = newSandbox();
    await assert.rejects(
      () => stackWrite(stack, { offset: 0, size, value: 0x1122334455667788n }),
      isSizeTypeError,
      `stackMemory size ${String(size)} must be rejected`,
    );
    assert.equal(await stack.emulator.load(stack.emulator.sp, 8), 0n, `stackMemory size ${String(size)} must not leave a write`);
  }
});

test('#4609 coercible sizes do not launder the downstream store validation', async () => {
  const stack = newSandbox();
  await assert.rejects(
    () => stackWrite(stack, { offset: 0, size: ['4'], value: 0xAABBCCDDn }),
    isSizeTypeError,
  );
  assert.equal(await stack.emulator.load(stack.emulator.sp, 4), 0n);
});

// Issue #4269 regression: FunctionSandbox.asBig() ran every concrete input
// through BigInt(v || 0), so Array/boolean/object values were promoted to
// legitimate machine addresses/registers/values via ToPrimitive coercion,
// and falsy values were silently rewritten to 0.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFunctionSandbox } from '../js/symbolic/function-sandbox.js';

const STRUCTURED = [[1], ['4096'], true, false, {}, { valueOf: () => 1n }, () => 1n, NaN, 1.5, Infinity, null, '', ' ', '1.5', '1e3', '0x1g', '-0x1', ' 0x10n '];

test('#4269 structured/boolean args are rejected, not coerced into machine values', async () => {
  for (const bad of STRUCTURED) {
    const sandbox = createFunctionSandbox({});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, args: [bad] }),
      (error) => error instanceof TypeError,
      `args ${String(bad)} must be rejected`,
    );
  }
});

test('#4269 structured register values are rejected', async () => {
  for (const bad of STRUCTURED) {
    const sandbox = createFunctionSandbox({});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, registers: { x1: bad } }),
      (error) => error instanceof TypeError,
      `register ${String(bad)} must be rejected`,
    );
    assert.throws(() => sandbox.setRegister('x0', bad), TypeError);
  }
});

test('#4269 structured breakpoint addresses are rejected', async () => {
  for (const bad of STRUCTURED) {
    const sandbox = createFunctionSandbox({});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, breakpoints: [bad] }),
      (error) => error instanceof TypeError,
      `breakpoint ${String(bad)} must be rejected`,
    );
    assert.throws(() => sandbox.addBreakpoint(bad), TypeError);
    assert.throws(() => sandbox.removeBreakpoint(bad), TypeError);
  }
});

test('#4269 structured setup address / objectBase are rejected', async () => {
  for (const bad of STRUCTURED) {
    if (bad !== null) {
      assert.throws(
        () => createFunctionSandbox({}, { objectBase: bad }),
        (error) => error instanceof TypeError || error instanceof RangeError,
        `constructor objectBase ${String(bad)} must be rejected`,
      );
    }
    const sandbox = createFunctionSandbox({});
    await assert.rejects(
      () => sandbox.setup(bad, { objectAsArg0: false }),
      (error) => error instanceof TypeError || error instanceof RangeError,
      `address ${String(bad)} must be rejected`,
    );
    if (bad !== null) {
      await assert.rejects(
        () => sandbox.setup(0x1000n, { objectAsArg0: false, objectBase: bad }),
        (error) => error instanceof TypeError || error instanceof RangeError,
        `objectBase ${String(bad)} must be rejected`,
      );
    }
  }
});

test('#4269 structured object/stack memory offset and value are rejected', async () => {
  for (const bad of STRUCTURED) {
    const sandbox = createFunctionSandbox({});
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: [{ offset: bad, size: 8, value: 0n }] }),
      (error) => error instanceof TypeError || error instanceof RangeError,
      `objectMemory offset ${String(bad)} must be rejected`,
    );
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: [{ offset: 0, size: 8, value: bad }] }),
      (error) => error instanceof TypeError,
      `objectMemory value ${String(bad)} must be rejected`,
    );
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, stackMemory: [{ offset: bad, size: 8, value: 0n }] }),
      (error) => error instanceof TypeError,
      `stackMemory offset ${String(bad)} must be rejected`,
    );
    await assert.rejects(
      () => sandbox.setup(0x1000n, { objectAsArg0: false, stackMemory: [{ offset: 0, size: 8, value: bad }] }),
      (error) => error instanceof TypeError,
      `stackMemory value ${String(bad)} must be rejected`,
    );
  }
});

test('#4269 negative addresses are rejected for address uses', async () => {
  const sandbox = createFunctionSandbox({});
  await assert.rejects(() => sandbox.setup(-1n, { objectAsArg0: false }), RangeError);
  await assert.rejects(() => sandbox.setup(0x1000n, { objectAsArg0: false, objectBase: -1n }), RangeError);
  await assert.rejects(() => sandbox.setup(0x1000n, { objectAsArg0: false, breakpoints: [-1] }), RangeError);
  await assert.rejects(() => sandbox.setup(0x1000n, { objectAsArg0: false, breakpoints: ['-1'] }), RangeError);
  assert.throws(() => sandbox.addBreakpoint('-1'), RangeError);
  assert.throws(() => sandbox.setRegister('x0', [1]), TypeError);
  await assert.rejects(
    () => sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: [{ offset: -1, size: 8, value: 0n }] }),
    RangeError,
  );
  await assert.rejects(
    () => sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: [{ offset: '-1', size: 8, value: 0n }] }),
    RangeError,
  );
});

test('#4269 canonical bigint / safe-integer semantics are preserved', async () => {
  const sandbox = createFunctionSandbox({});
  const state = await sandbox.setup(0x1000n, {
    objectAsArg0: false,
    args: [0x10n, -9n, 7],
    registers: { x2: '0x20', x3: 12 },
    objectMemory: [{ offset: 0, size: 8, value: -3n }, { offset: '8', size: 8, value: 4096 }],
    stackMemory: [{ offset: -16n, size: 8, value: 5n }],
    breakpoints: [0x2000n, '0x3000', 8200],
    watch: [{ name: 'w', offset: 0, size: 8 }],
  });
  assert.equal(state.registers.x0, 0x10n);
  assert.equal(state.registers.x2, 0x20n);
  assert.equal(state.registers.x3, 12n);
  assert.equal(sandbox.emulator.breakpoints.has('8192'), true);
  assert.equal(sandbox.emulator.breakpoints.has('12288'), true);
  assert.equal(sandbox.emulator.breakpoints.has('8200'), true);
  sandbox.setRegister('x4', '0xff');
  assert.equal(sandbox.getRegister('x4'), 0xffn);
  sandbox.removeBreakpoint('0x2000');
  assert.equal(sandbox.emulator.breakpoints.has('8192'), false);
  const defaults = createFunctionSandbox({});
  await defaults.setup(0x1000n, { objectAsArg0: false, objectMemory: [{ size: 8, value: 0x77n }], stackMemory: [{ size: 8, value: 0x78n }] });
  assert.equal(await defaults.emulator.load(defaults.objectBase, 8), 0x77n);
  assert.equal(await defaults.emulator.load(defaults.emulator.sp, 8), 0x78n);
});

test('#4269 object-keyed objectMemory keeps canonical numeric-string keys', async () => {
  const sandbox = createFunctionSandbox({});
  await sandbox.setup(0x1000n, { objectAsArg0: false, objectMemory: { '0x10': 1n } });
  const read = await sandbox.emulator.load(sandbox.objectBase + 0x10n, 8);
  assert.equal(read, 1n);
});

test('#4269 rejected input produces no concrete machine state or evidence', async () => {
  const sandbox = createFunctionSandbox({});
  await assert.rejects(() => sandbox.setup(0x1000n, { objectAsArg0: false, args: [true] }), TypeError);
  assert.equal(sandbox.emulator.breakpoints.size, 0);
  assert.equal(sandbox.watch.length, 0);
  assert.equal(sandbox.emulator.get('x0'), 0n);
});

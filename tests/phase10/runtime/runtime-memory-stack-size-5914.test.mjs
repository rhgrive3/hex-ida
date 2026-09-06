import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MemoryAccessError,
  createSandboxMemoryMap,
} from '../../../js/runtime/memory.js';

const baseOptions = Object.freeze({
  objectBase: 0x10000n,
  objectSize: 0x1000,
  heapBase: 0x20000n,
  heapSize: 0x1000,
  stackTop: 0x50000n,
});

function memoryError(code) {
  return (error) => error instanceof MemoryAccessError && error.code === code;
}

test('P10 sandbox memory validates stackSize before address arithmetic (#5914)', () => {
  for (const stackSize of [1.5, {}, true]) {
    assert.throws(
      () => createSandboxMemoryMap({ ...baseOptions, stackSize }),
      memoryError('invalid-size'),
    );
  }
});

test('P10 sandbox memory does not invoke stackSize coercion hooks (#5914)', () => {
  let coercions = 0;
  const stackSize = {
    valueOf() { coercions++; return 0x1000; },
    toString() { coercions++; return '4096'; },
  };

  assert.throws(
    () => createSandboxMemoryMap({ ...baseOptions, stackSize }),
    memoryError('invalid-size'),
  );
  assert.equal(coercions, 0);
});

test('P10 sandbox memory preserves valid stack geometry and canonical size limits (#5914)', () => {
  const map = createSandboxMemoryMap({ ...baseOptions, stackSize: '8192' });
  const stack = map.snapshot().find((region) => region.kind === 'stack');

  assert.ok(stack);
  assert.equal(stack.size, 8192);
  assert.equal(stack.start, 0x4e000n);
  assert.equal(stack.start + BigInt(stack.size), baseOptions.stackTop);

  assert.throws(
    () => createSandboxMemoryMap({ ...baseOptions, stackSize: 64 * 1024 * 1024 + 1 }),
    memoryError('too-large'),
  );
});

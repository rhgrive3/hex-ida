import test from 'node:test';
import assert from 'node:assert/strict';

import { X86_64_ARCHITECTURE } from '../../../../js/targets/architecture/index.js';

test('x86_64 profile advertises only the memory endianness implemented by MachineEffects', () => {
  assert.deepEqual(X86_64_ARCHITECTURE.supportedMemoryEndianness, ['little']);
  assert.equal(X86_64_ARCHITECTURE.supportedMemoryEndianness.includes('big'), false);
  assert.equal(Object.isFrozen(X86_64_ARCHITECTURE.supportedMemoryEndianness), true);
});

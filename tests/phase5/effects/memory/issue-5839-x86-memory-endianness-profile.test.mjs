import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeDecodedSemanticFunction } from '../../../../js/analysis/semantic-function-base.js';
import { ARM64_ARCHITECTURE, RISCV64_ARCHITECTURE, X86_64_ARCHITECTURE } from '../../../../js/targets/architecture/index.js';
import { liftX86MachineEffects } from '../../../../js/targets/architecture/x86_64/effects/index.js';
import { decoded, mem, operations, reg } from './helpers.mjs';

test('x86_64 profile advertises only the memory endianness implemented by MachineEffects', () => {
  assert.deepEqual(X86_64_ARCHITECTURE.supportedMemoryEndianness, ['little']);
  assert.equal(X86_64_ARCHITECTURE.supportedMemoryEndianness.includes('big'), false);
  assert.equal(Object.isFrozen(X86_64_ARCHITECTURE.supportedMemoryEndianness), true);
  assert.deepEqual(RISCV64_ARCHITECTURE.supportedMemoryEndianness, ['little']);
  assert.deepEqual(ARM64_ARCHITECTURE.supportedMemoryEndianness, []);
});

test('x86_64 semantic-function gate rejects a contradictory big-endian memory request', () => {
  assert.throws(
    () => analyzeDecodedSemanticFunction({ architecture:'x86_64', instructions:[], dataEndianness:'big' }),
    /semantic-function-unsupported-memory-endianness:big/,
  );
});

test('x86_64 semantic-function gate accepts little-endian memory before downstream validation', () => {
  let error = null;
  try {
    analyzeDecodedSemanticFunction({ architecture:'x86_64', instructions:[], dataEndianness:'little' });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'minimal request should fail a downstream requirement');
  assert.doesNotMatch(String(error?.message || error), /semantic-function-unsupported-memory-endianness/);
});

test('accepted x86_64 profile and MachineEffects memory access agree on little endian', () => {
  const instruction = decoded({
    family:'mov',
    operands:[reg('rax', 64, 'write'), mem({ base:'rbx', displacement:8n, widthBits:64, access:'read' })],
  });
  const bundle = liftX86MachineEffects(instruction);
  assert.ok(bundle);
  assert.equal(bundle.completeness, 'exact');
  const reads = operations(bundle, 'memory-read');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].access.endian, 'little');
  assert.equal(X86_64_ARCHITECTURE.supportedMemoryEndianness.includes(reads[0].access.endian), true);
});

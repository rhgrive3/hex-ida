import assert from 'node:assert/strict';
import test from 'node:test';
import { dynamicRelocationResolutionMetadata } from '../../../js/binary/elf-dynamic.js';

const RISCV = { metadata: { machine: 243 } };

test('6051: R_RISCV_IRELATIVE is a runtime resolver', () => {
  const out = dynamicRelocationResolutionMetadata(RISCV, { symIndex: 0, type: 58, addend: 0x1234n }, null);
  assert.equal(out.requiresRuntimeResolution, true);
  assert.equal(out.resolution, 'irelative-resolver');
  assert.equal(out.resolverAddend, 0x1234n);
});

test('6051: symIndex!=0 is not IRELATIVE', () => {
  const out = dynamicRelocationResolutionMetadata(RISCV, { symIndex: 1, type: 58, addend: 0n }, null);
  assert.deepEqual(out, {});
});

test('6051: other RISC-V types are not IRELATIVE', () => {
  assert.deepEqual(dynamicRelocationResolutionMetadata(RISCV, { symIndex: 0, type: 5, addend: 0n }, null), {});
  assert.deepEqual(dynamicRelocationResolutionMetadata(RISCV, { symIndex: 0, type: 1, addend: 0n }, null), {});
});

test('6051: existing x86/x86_64/aarch64 IRELATIVE preserved', () => {
  assert.equal(dynamicRelocationResolutionMetadata({ metadata: { machine: 3 } }, { symIndex: 0, type: 42, addend: 1n }, null).resolution, 'irelative-resolver');
  assert.equal(dynamicRelocationResolutionMetadata({ metadata: { machine: 62 } }, { symIndex: 0, type: 37, addend: 1n }, null).resolution, 'irelative-resolver');
  assert.equal(dynamicRelocationResolutionMetadata({ metadata: { machine: 183 } }, { symIndex: 0, type: 1032, addend: 1n }, null).resolution, 'irelative-resolver');
});

test('6051: IFUNC symbol path preserved', () => {
  const out = dynamicRelocationResolutionMetadata(RISCV, { symIndex: 2, type: 5 }, { kind: 'indirect-function', address: 0x1000n });
  assert.equal(out.resolution, 'ifunc-resolver-return');
  assert.equal(out.requiresRuntimeResolution, true);
});

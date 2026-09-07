import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';

const CODE_OFFSET = 0x120;

function lift(bytes) {
  return liftJvmMethod(0, {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 1,
        bytecode: Uint8Array.from(bytes),
        exceptionTable: [],
        offset: CODE_OFFSET,
      },
    }],
  });
}

function offsets(fn) {
  return fn.bundles.map((bundle) => bundle.bytecodeOffset);
}

function assertUnknownSpan(fn, expectedEnd) {
  const unknown = fn.bundles[0];
  assert.equal(unknown.completeness, 'partial');
  assert.equal(unknown.origin.byteRanges.length, 1);
  assert.equal(unknown.origin.byteRanges[0].start, String(CODE_OFFSET));
  assert.equal(unknown.origin.byteRanges[0].end, String(CODE_OFFSET + expectedEnd));
}

// goto_w occupies five bytes. Its four-byte operand must never be re-lifted as exact opcodes.
{
  const fn = lift([0xc8, 0x00, 0x00, 0x00, 0x05, 0xb1]);
  assert.deepEqual(offsets(fn), [0, 5]);
  assert.equal(fn.bundles[0].mnemonic, 'jvm_op_0xc8');
  assert.equal(fn.bundles[1].mnemonic, 'return');
  assert.equal(fn.aggregateCompleteness, 'partial');
  assertUnknownSpan(fn, 5);
}

// Unsupported fixed-width instructions still advance to the next real opcode.
{
  const fn = lift([0xbc, 0x0a, 0xb1]); // newarray int; return
  assert.deepEqual(offsets(fn), [0, 2]);
  assert.equal(fn.bundles[1].mnemonic, 'return');
  assertUnknownSpan(fn, 2);
}

// tableswitch at pc=0: opcode + 3 pad + default + low + high + one jump = 20 bytes.
{
  const fn = lift([
    0xaa, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x14,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x14,
    0xb1,
  ]);
  assert.deepEqual(offsets(fn), [0, 20]);
  assert.equal(fn.bundles[1].mnemonic, 'return');
  assertUnknownSpan(fn, 20);
}

// lookupswitch at pc=0 with zero pairs consumes 12 bytes.
{
  const fn = lift([
    0xab, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x0c,
    0x00, 0x00, 0x00, 0x00,
    0xb1,
  ]);
  assert.deepEqual(offsets(fn), [0, 12]);
  assert.equal(fn.bundles[1].mnemonic, 'return');
  assertUnknownSpan(fn, 12);
}

// wide has two legal boundary shapes: normal local op (4 bytes) and iinc (6 bytes).
{
  const load = lift([0xc4, 0x15, 0x00, 0x01, 0xb1]);
  assert.deepEqual(offsets(load), [0, 4]);
  assertUnknownSpan(load, 4);

  const iinc = lift([0xc4, 0x84, 0x00, 0x01, 0x00, 0x01, 0xb1]);
  assert.deepEqual(offsets(iinc), [0, 6]);
  assertUnknownSpan(iinc, 6);
}

// If the boundary cannot be proven, stop at method end rather than laundering suffix bytes into fake ops.
{
  const truncated = lift([0xc8, 0x00, 0x00, 0xb1]);
  assert.deepEqual(offsets(truncated), [0]);
  assert.match(truncated.bundles[0].unknownEffects[0].reason, /malformed-boundary$/);
  assertUnknownSpan(truncated, 4);

  const reserved = lift([0xcb, 0x00, 0xb1]);
  assert.deepEqual(offsets(reserved), [0]);
  assert.match(reserved.bundles[0].unknownEffects[0].reason, /malformed-boundary$/);
  assertUnknownSpan(reserved, 3);
}

console.log('ok issue #3912 JVM unsupported instruction boundaries');

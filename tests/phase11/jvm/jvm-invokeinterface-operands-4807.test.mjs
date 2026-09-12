import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { decodeJvmInstructionBoundary } from '../../../js/managed/jvm/instruction-boundary.js';

function makeClass(bytes) {
  return {
    moduleId: 'managed-mod:test:jvm:4807',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 1,
        offset: 0x200,
        bytecode: Uint8Array.from(bytes),
        exceptionTable: [],
      },
    }],
  };
}

function assertMalformed(bytes) {
  const bytecode = Uint8Array.from(bytes);
  const boundary = decodeJvmInstructionBoundary(bytecode, 0);
  assert.equal(boundary.complete, false);
  assert.ok(boundary.end <= bytecode.length);

  const fn = liftJvmMethod(0, makeClass(bytes));
  assert.equal(fn.aggregateCompleteness, 'partial');
  assert.equal(fn.bundles.length, 1);
  const invoke = fn.bundles[0];
  assert.equal(invoke.opcode, 0xb9);
  assert.equal(invoke.completeness, 'partial');
  assert.deepEqual(invoke.callEffects, []);
  assert.match(invoke.unknownEffects[0].reason, /malformed-boundary$/);
  assert.ok(Number(invoke.origin.byteRanges[0].end) <= 0x200 + bytes.length);
}

// Both trailing bytes are mandatory and value-constrained by JVMS 6.5.
assertMalformed([0xb9, 0x00, 0x01]);
assertMalformed([0xb9, 0x00, 0x01, 0x01]);
assertMalformed([0xb9, 0x00, 0x01, 0x00, 0x00]);
assertMalformed([0xb9, 0x00, 0x01, 0x01, 0xff]);

// Invalid full-width encodings must not desynchronise into subsequent bytes or
// mint an exact interface call before validation rejects the instruction.
assertMalformed([0xb9, 0x00, 0x01, 0x00, 0x00, 0xb1]);
assertMalformed([0xb9, 0x00, 0x01, 0x01, 0xff, 0xb1]);

// A structurally valid encoding keeps the established call semantics. Count
// is an unsigned u1 here; descriptor/count agreement remains verifier-owned.
for (const count of [1, 0xff]) {
  const bytes = [0xb9, 0x00, 0x01, count, 0x00, 0xb1];
  const boundary = decodeJvmInstructionBoundary(Uint8Array.from(bytes), 0);
  assert.deepEqual(boundary, { end: 5, complete: true, start: 0 });

  const fn = liftJvmMethod(0, makeClass(bytes));
  assert.equal(fn.bundles.length, 2);
  const invoke = fn.bundles[0];
  assert.equal(invoke.mnemonic, 'invokeinterface');
  assert.equal(invoke.completeness, 'exact');
  assert.deepEqual(invoke.callEffects, [{ cpIndex: 1, dispatchKind: 'interface' }]);
  assert.equal(Number(invoke.origin.byteRanges[0].end), 0x205);
  assert.equal(fn.bundles[1].mnemonic, 'return');
}

console.log('ok issue #4807 JVM invokeinterface operands');

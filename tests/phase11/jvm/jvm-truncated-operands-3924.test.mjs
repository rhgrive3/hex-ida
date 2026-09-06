import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { liftJvmMethod as liftJvmMethodCore } from '../../../js/managed/jvm/lifter-core.js';

const CODE_OFFSET = 0x180;

function makeClass(bytes, { offset = CODE_OFFSET } = {}) {
  const code = {
    maxStack: 4,
    maxLocals: 2,
    bytecode: Uint8Array.from(bytes),
    exceptionTable: [],
  };
  if (offset !== undefined) code.offset = offset;
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code,
    }],
  };
}

function lift(bytes) {
  return liftJvmMethod(0, makeClass(bytes));
}

function assertMalformed(bytes, opcode) {
  const fn = lift(bytes);
  assert.equal(fn.bundles.length, 1);
  assert.equal(fn.aggregateCompleteness, 'partial');

  const bundle = fn.bundles[0];
  assert.equal(bundle.opcode, opcode);
  assert.equal(bundle.completeness, 'partial');
  assert.match(bundle.unknownEffects[0].reason, /malformed-boundary$/);
  assert.deepEqual(bundle.producedValues, []);
  assert.deepEqual(bundle.locationReads, []);
  assert.deepEqual(bundle.locationWrites, []);
  assert.equal(bundle.origin.byteRanges.length, 1);
  assert.equal(bundle.origin.byteRanges[0].start, String(CODE_OFFSET));
  assert.equal(bundle.origin.byteRanges[0].end, String(CODE_OFFSET + bytes.length));
}

// One-byte operands must not read past code and mint exact effects.
assertMalformed([0x10], 0x10);       // bipush
assertMalformed([0x12], 0x12);       // ldc
assertMalformed([0x15], 0x15);       // iload
assertMalformed([0x36], 0x36);       // istore
assertMalformed([0x84], 0x84);       // iinc: index and immediate missing
assertMalformed([0x84, 0x00], 0x84); // iinc: immediate missing

// DataView-backed fixed-width operands use the same fail-closed boundary.
assertMalformed([0x11, 0x00], 0x11);             // sipush
assertMalformed([0x13, 0x00], 0x13);             // ldc_w
assertMalformed([0x99, 0x00], 0x99);             // ifeq
assertMalformed([0xb2, 0x00], 0xb2);             // getstatic
assertMalformed([0xb9, 0x00, 0x01, 0x01], 0xb9); // invokeinterface

// Valid fixed-width instructions keep their existing exact semantics and offsets.
{
  const fn = lift([0x10, 0x7f, 0x84, 0x00, 0xff, 0xb1]);
  assert.deepEqual(fn.bundles.map((bundle) => bundle.bytecodeOffset), [0, 2, 5]);
  assert.equal(fn.bundles[0].mnemonic, 'bipush');
  assert.equal(fn.bundles[0].completeness, 'exact');
  assert.equal(fn.bundles[0].producedValues[0].constant, 127);
  assert.equal(fn.bundles[1].mnemonic, 'iinc');
  assert.equal(fn.bundles[1].completeness, 'exact');
  assert.equal(fn.bundles[1].producedValues[0].constant, -1);
  assert.equal(fn.bundles[2].mnemonic, 'return');
  assert.equal(fn.bundles[2].completeness, 'exact');
}

// The core lifter follows the wrapper's default when Code.offset is omitted.
{
  const fn = liftJvmMethodCore(0, makeClass([0xb1], { offset: undefined }));
  assert.equal(fn.bundles[0].origin.byteRanges[0].start, '0');
  assert.equal(fn.bundles[0].origin.byteRanges[0].end, '1');
}

console.log('ok issue #3924 JVM truncated operands');

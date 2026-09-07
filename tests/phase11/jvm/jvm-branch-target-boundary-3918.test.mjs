import assert from 'node:assert/strict';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';

const CODE_OFFSET = 0x180;

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

function branchBundle(bytes) {
  return lift(bytes).bundles[0];
}

function assertInvalidTarget(bytes) {
  const bundle = branchBundle(bytes);
  assert.equal(bundle.completeness, 'partial');
  assert.deepEqual(bundle.controlEffects, []);
  assert.equal(bundle.unknownEffects.length, 1);
  assert.equal(bundle.unknownEffects[0].reason, 'invalid-jvm-branch-target');
}

// The issue counterexample: a target outside code_length must not become an exact edge.
assertInvalidTarget([0xa7, 0x7f, 0xff, 0xb1]);

// A target into the current goto's operand bytes is not an instruction start.
assertInvalidTarget([0xa7, 0x00, 0x01, 0xb1]);

// code_length itself is outside the legal target range.
assertInvalidTarget([0xa7, 0x00, 0x04, 0xb1]);

// Conditional branches use the same boundary authority.
assertInvalidTarget([0x99, 0x00, 0x01, 0xb1]);
assertInvalidTarget([0x9f, 0x00, 0x02, 0xb1]);

// A canonical forward target remains exact.
{
  const bundle = branchBundle([0xa7, 0x00, 0x03, 0xb1]);
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.controlEffects, [{ kind: 'branch', targetOffset: 3 }]);
  assert.deepEqual(bundle.unknownEffects, []);
}

// Valid backward targets remain exact.
{
  const fn = lift([0x00, 0x99, 0xff, 0xff, 0xb1]);
  const bundle = fn.bundles[1];
  assert.equal(bundle.mnemonic, 'ifeq');
  assert.equal(bundle.completeness, 'exact');
  assert.deepEqual(bundle.controlEffects, [{ kind: 'conditional-branch', targetOffset: 0 }]);
}

// A branch may target an instruction whose semantics are unsupported when its boundary is proven.
{
  const fn = lift([0xa7, 0x00, 0x03, 0xbc, 0x0a, 0xb1]);
  assert.deepEqual(fn.bundles.map((bundle) => bundle.bytecodeOffset), [0, 3, 5]);
  assert.deepEqual(fn.bundles[0].controlEffects, [{ kind: 'branch', targetOffset: 3 }]);
  assert.equal(fn.bundles[1].completeness, 'partial');
}

// If the target instruction's boundary itself cannot be proven, do not mint an exact edge.
assertInvalidTarget([0xa7, 0x00, 0x03, 0xcb, 0x00, 0xb1]);

console.log('ok issue #3918 JVM branch target boundaries');

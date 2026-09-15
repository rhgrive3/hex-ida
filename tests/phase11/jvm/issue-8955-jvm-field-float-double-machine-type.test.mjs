// Regression for #8955: `getstatic` / `getfield` / `putstatic` / `putfield`
// must publish a canonical IEEE-754 `machineType` for resolved `F`/`D` field
// values so the shared managed bridge cannot launder them into a plain
// integer bitvector while the whole Semantic IR still claims `complete`.
//
// Counterexamples reproduced here:
//   A) `getstatic F; freturn` -> canonical was `{kind:'bitvector', widthBits:32}`,
//      IR `complete` with no unknown.
//   B) `getstatic D; dreturn` -> canonical was `{kind:'bitvector', widthBits:64}`.
//   C) `getfield F/D` on an instance field -> same failure as A/B, this time via
//      `aload_0; getfield; *return`.
//   D) Control: after #7971, `fload_0`/`dload_0` already preserve the correct
//      `float` type. This test asserts the field path now agrees.
import assert from 'node:assert/strict';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

const FLOAT32 = Object.freeze({ kind: 'float', widthBits: 32, format: 'binary32' });
const FLOAT64 = Object.freeze({ kind: 'float', widthBits: 64, format: 'binary64' });
const BIT32 = Object.freeze({ kind: 'bitvector', widthBits: 32 });
const BIT64 = Object.freeze({ kind: 'bitvector', widthBits: 64 });

// Field-ref CP slot #6, method `m` runs the supplied bytecode. The `isStatic`
// flag selects `getstatic`/`putstatic` vs `getfield`/`putfield` (a receiver
// `aload_0` prefaces the instance reads); `isWrite` selects the store form.
// `descriptor` is the resolved field descriptor.
function buildImage({ descriptor, isStatic, isWrite = false, extraPrologue = [], returnOpcode }) {
  const fieldref = {
    tag: 9,
    classIndex: 2,
    nameAndTypeIndex: 5,
  };
  const opcode = isWrite
    ? (isStatic ? 0xb3 : 0xb5)
    : (isStatic ? 0xb2 : 0xb4);
  return {
    moduleId: 'managed-mod:issue-8955',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'pkg/Test',
    fields: [{ accessFlags: isStatic ? 0x0008 : 0x0000, name: 'value', descriptor }],
    constantPool: [
      null,
      { tag: 1, value: 'pkg/Test' },
      { tag: 7, nameIndex: 1 },
      { tag: 1, value: 'value' },
      { tag: 1, value: descriptor },
      { tag: 12, nameIndex: 3, descriptorIndex: 4 },
      fieldref,
    ],
    methods: [{
      accessFlags: 0x0009,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 4,
        maxLocals: 2,
        offset: 0,
        exceptionTable: [],
        bytecode: Uint8Array.from([
          ...extraPrologue,
          opcode,
          0x00, 0x06,
          returnOpcode,
        ]),
      },
    }],
  };
}
function build(options) {
  const image = buildImage(options);
  return { image, lowered: lowerVMEffectsToSemanticIr(liftJvmMethod(0, image)) };
}

function readMachineType(lowered) {
  const load = lowered.semanticIr.nodes.find((candidate) => candidate.kind === 'load');
  assert.ok(load, 'expected a canonical load node');
  const valueId = load.outputs[0];
  const value = lowered.semanticIr.values.find((candidate) => candidate.id === valueId);
  assert.ok(value, 'expected the canonical load to publish a value');
  return value.machineType;
}

// A) getstatic F — the resolved descriptor proves `float`.
{
  const { lowered } = build({ descriptor: 'F', isStatic: true, returnOpcode: 0xae });
  assert.deepEqual(readMachineType(lowered), FLOAT32);
}
// B) getstatic D.
{
  const { lowered } = build({ descriptor: 'D', isStatic: true, returnOpcode: 0xaf });
  assert.deepEqual(readMachineType(lowered), FLOAT64);
}
// C) getfield F / D — instance forms must behave identically.
{
  const { lowered } = build({ descriptor: 'F', isStatic: false, extraPrologue: [0x2a], returnOpcode: 0xae });
  assert.deepEqual(readMachineType(lowered), FLOAT32);
}
{
  const { lowered } = build({ descriptor: 'D', isStatic: false, extraPrologue: [0x2a], returnOpcode: 0xaf });
  assert.deepEqual(readMachineType(lowered), FLOAT64);
}
// D) putstatic F / D — write side must carry the same authority so the store
//    consumes a `float` value rather than laundering to a same-width bitvector.
//    Asserted at the lifter boundary only: a bare `putstatic; return` in a
//    `()V` method underflows in the shared lowering (no fconst/dconst opcode is
//    currently implemented in this lifter), so the write-form VMEffect is
//    checked pre-lowering.
{
  const image = buildImage({ descriptor: 'F', isStatic: true, isWrite: true, returnOpcode: 0xb1 });
  const bundleF = liftJvmMethod(0, image).bundles[0];
  assert.deepEqual(bundleF.consumedValues[0]?.type, FLOAT32);
}
{
  const image = buildImage({ descriptor: 'D', isStatic: true, isWrite: true, returnOpcode: 0xb1 });
  const bundleD = liftJvmMethod(0, image).bundles[0];
  assert.deepEqual(bundleD.consumedValues[0]?.type, FLOAT64);
}
// E) Integer / long field controls stay bitvectors — this fix is float-domain
//    only, and must not accidentally attach a `float` type to an `I`/`J` field.
{
  const bundleI = liftJvmMethod(0, build({ descriptor: 'I', isStatic: true, returnOpcode: 0xac }).image).bundles[0];
  assert.equal(bundleI.producedValues[0]?.type, undefined);
  const { lowered } = build({ descriptor: 'I', isStatic: true, returnOpcode: 0xac });
  assert.deepEqual(readMachineType(lowered), BIT32);
}
{
  const bundleJ = liftJvmMethod(0, build({ descriptor: 'J', isStatic: true, returnOpcode: 0xad }).image).bundles[0];
  assert.equal(bundleJ.producedValues[0]?.type, undefined);
  const { lowered } = build({ descriptor: 'J', isStatic: true, returnOpcode: 0xad });
  assert.deepEqual(readMachineType(lowered), BIT64);
}
// F) Reference field also keeps `undefined` (this issue is only about the F/D
//    domain; #8836 owns managed-heap reference typing separately).
{
  const bundleRef = liftJvmMethod(0, build({ descriptor: 'Ljava/lang/String;', isStatic: false, extraPrologue: [0x2a], returnOpcode: 0xb0 }).image).bundles[0];
  assert.equal(bundleRef.producedValues[0]?.type, undefined);
}

console.log('issue-8955 jvm field float/double machine type: PASS');

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

// #8028 — CIL `ldnull` and JVM `aconst_null` publish a definite-null fact in
// VMEffects (`producedValues:[{isNull:true}]`) and the shared bridge preserves
// it as a first-class fact. Without a proven CIL target pointer width (#7775),
// the IR correctly retains a machine-type unknown. ECMA-335 III.3.45 keeps
// `ldnull` distinct from `ldc.i4.0`, and the JVMS defines `aconst_null` as
// the null reference — the definite-null authority must survive the
// VMEffects -> canonical Semantic IR boundary as a first-class fact.

const loweredOutput = (fn, mnemonic) => {
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const bundle = fn.bundles.find((b) => b.mnemonic === mnemonic);
  assert.ok(bundle, `${mnemonic} bundle required`);
  const node = lowered.semanticIr.nodes.find((n) => n.sourceEffectIds?.includes(bundle.operationId));
  assert.ok(node, `${mnemonic} node required`);
  return {
    lowered,
    value: lowered.semanticIr.values.find((v) => node.outputs.includes(v.id)),
  };
};

test('#8028 CIL ldnull keeps its definite-null authority in the final Semantic IR', () => {
  const image = parseCil(buildCil({
    methods: [{ name: 'Run', body: [0x14, 0x26, 0x2a] }], // ldnull; pop; ret
  }).bytes, { binaryId: 'cil-null' });
  const fn = liftCilMethod(0, image);
  const ldnull = fn.bundles.find((b) => b.mnemonic === 'ldnull');
  assert.equal(ldnull.completeness, 'exact');
  assert.deepEqual(ldnull.producedValues, [{ isNull: true }]);

  const { lowered, value } = loweredOutput(fn, 'ldnull');
  assert.ok(value, 'ldnull output value required');
  assert.equal(value.metadata.isNull, true);
  assert.equal(value.metadata.reason, 'machine-type-unresolved');
  assert.equal(lowered.semanticIr.completeness, 'partial');
  assert.ok(lowered.semanticIr.unknowns.some((unknown) => unknown.reason === 'machine-type-unresolved'));
});

test('#8028 JVM aconst_null keeps its definite-null authority in the final Semantic IR', () => {
  const fn = liftJvmMethod(0, {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 1,
        maxLocals: 0,
        bytecode: Uint8Array.from([0x01, 0x57, 0xb1]), // aconst_null; pop; ret
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  });
  const aconstNull = fn.bundles.find((b) => b.mnemonic === 'aconst_null');
  assert.equal(aconstNull.completeness, 'exact');
  // #8028: the definite-null fact must be published; #8836: a `aconst_null` is
  // additionally the null objectref and must carry canonical managed-heap
  // reference authority (previously a bare 64-bit bitvector dropped it).
  const produced = aconstNull.producedValues[0];
  assert.equal(produced.isNull, true);
  assert.equal(produced.type?.kind, 'address');
  assert.equal(produced.type?.addressSpace, 'managed-heap');

  const { value } = loweredOutput(fn, 'aconst_null');
  assert.ok(value, 'aconst_null output value required');
  assert.deepEqual(value.metadata, { isNull: true });
});

test('#8028 managed null is distinguishable from integer zero without mnemonic metadata', () => {
  // CIL ldc.i4.0 pushes integer zero — constant metadata, not null.
  const image = parseCil(buildCil({
    methods: [{ name: 'Run', body: [0x16, 0x26, 0x2a] }], // ldc.i4.0; pop; ret
  }).bytes, { binaryId: 'cil-zero' });
  const zeroFn = liftCilMethod(0, image);
  const { value: zeroValue } = loweredOutput(zeroFn, 'ldc.i4.0');
  assert.deepEqual(zeroValue.metadata, { constant: '0' });

  // JVM iconst_0 likewise.
  const jvmZeroFn = liftJvmMethod(0, {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'T',
    methods: [{
      accessFlags: 0x0008,
      name: 'm',
      descriptor: '()V',
      code: {
        maxStack: 1,
        maxLocals: 0,
        bytecode: Uint8Array.from([0x03, 0x57, 0xb1]), // iconst_0; pop; ret
        exceptionTable: [],
        offset: 0x180,
      },
    }],
  });
  const { value: jvmZeroValue } = loweredOutput(jvmZeroFn, 'iconst_0');
  assert.deepEqual(jvmZeroValue.metadata, { constant: '0' });

  const imageNull = parseCil(buildCil({
    methods: [{ name: 'Run', body: [0x14, 0x26, 0x2a] }],
  }).bytes, { binaryId: 'cil-null-2' });
  const { value: nullValue } = loweredOutput(liftCilMethod(0, imageNull), 'ldnull');
  assert.notDeepEqual(nullValue.metadata, zeroValue.metadata);
  assert.equal(nullValue.metadata.isNull, true);
  assert.equal(nullValue.metadata.constant, undefined);
});

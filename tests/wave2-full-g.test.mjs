import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCil } from '../js/managed/cil/parser.js';
import { liftCilMethod } from '../js/managed/cil/lifter.js';
import { validateCilEffectFunction } from '../js/managed/cil/validation.js';
import { createCilFieldSignatureResolver } from '../js/managed/cil/call-signatures.js';
import { buildCil } from './phase11/fixtures/medium-cil.mjs';

// 1. [P1] js/managed/cil/validation.js: brfalse / brfalse.s falseTargetOffset validation & dataflow enqueue
test('Wave2-G #1 [P1]: validateCilEffectFunction checks brfalse.s negative falseTargetOffset as invalid branch target', () => {
  // 0: ldc.i4.0 (0x16)
  // 1: brfalse.s -10 (0x2c, 0xf6) -> targetOffset = 3, falseTargetOffset = -7
  // 3: ret (0x2a)
  const image = buildCil({
    methods: [{ name: 'BadNeg', body: [0x16, 0x2c, 0xf6, 0x2a], signature: [0x00, 0x00, 0x01] }],
  }).bytes;
  const decoded = liftCilMethod(0, parseCil(image));
  const report = validateCilEffectFunction(decoded, { maxStack: 2, returnStackSlots: 0 });
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((e) => e.code === 'cil-invalid-branch-target' && e.targetOffset === -7),
    `Expected cil-invalid-branch-target for falseTargetOffset=-7, got ${JSON.stringify(report.errors)}`,
  );
});

test('Wave2-G #1 [P1]: validateCilEffectFunction checks brfalse out-of-bounds positive falseTargetOffset', () => {
  // 0: ldc.i4.0 (0x16)
  // 1: brfalse +50 (0x39, 50,0,0,0) -> targetOffset = 6, falseTargetOffset = 56
  // 6: ret (0x2a)
  const image = buildCil({
    methods: [{ name: 'BadPos', body: [0x16, 0x39, 50, 0, 0, 0, 0x2a], signature: [0x00, 0x00, 0x01] }],
  }).bytes;
  const decoded = liftCilMethod(0, parseCil(image));
  const report = validateCilEffectFunction(decoded, { maxStack: 2, returnStackSlots: 0 });
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((e) => e.code === 'cil-invalid-branch-target' && e.targetOffset === 56),
    `Expected cil-invalid-branch-target for falseTargetOffset=56, got ${JSON.stringify(report.errors)}`,
  );
});

test('Wave2-G #1 [P1]: validateCilEffectFunction detects brfalse.s falseTargetOffset crossing protected exception region', () => {
  // 0: ldc.i4.0 (0x16)
  // 1: brfalse.s +2 (0x2c, 0x02) -> targetOffset = 3, falseTargetOffset = 5 (inside try region!)
  // 3: ret (0x2a)
  // 4: nop (0x00)
  // 5: nop (0x00) [try: 5..7]
  // 6: endfinally (0xdc)
  const decoded = {
    methodId: 'm-region',
    entryState: { maxStack: 2, returnStackSlots: 0 },
    exceptionRegions: [{ id: 'eh0', startOffset: 5, endOffset: 7, handlerOffset: 5, handlerEndOffset: 7, handlerKind: 'finally' }],
    bundles: [
      { operationId: 'op0', bytecodeOffset: 0, consumedValues: [], producedValues: [{ bits: 32, stackType: 'int32' }], controlEffects: [] },
      { operationId: 'op1', bytecodeOffset: 1, consumedValues: [{ id: 'cond' }], producedValues: [], controlEffects: [{ kind: 'conditional-branch', targetOffset: 3, falseTargetOffset: 5 }] },
      { operationId: 'op2', bytecodeOffset: 3, consumedValues: [], producedValues: [], controlEffects: [{ kind: 'return' }] },
      { operationId: 'op3', bytecodeOffset: 5, consumedValues: [], producedValues: [], controlEffects: [{ kind: 'endfinally' }] },
    ],
  };
  const report = validateCilEffectFunction(decoded);
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((e) => e.code === 'cil-branch-crosses-protected-region' && e.targetOffset === 5),
    `Expected cil-branch-crosses-protected-region for falseTargetOffset=5, got ${JSON.stringify(report.errors)}`,
  );
});

test('Wave2-G #1 [P1]: validateCilEffectFunction enqueues falseTargetOffset into dataflow queue', () => {
  // 0: ldc.i4.0 (0x16)
  // 1: brfalse.s +2 (0x2c, 0x02) -> targetOffset = 3, falseTargetOffset = 5
  // 3: ldc.i4.1 (0x17)
  // 4: ret (0x2a)
  // 5: ret (0x2a) -> stack height is 0, but returnStackSlots is 1 => must be reached & flagged!
  const image = buildCil({
    methods: [{ name: 'ReachFalse', body: [0x16, 0x2c, 0x02, 0x17, 0x2a, 0x2a], signature: [0x00, 0x00, 0x08] }],
  }).bytes;
  const decoded = liftCilMethod(0, parseCil(image));
  const report = validateCilEffectFunction(decoded, { maxStack: 2, returnStackSlots: 1 });
  assert.equal(report.status, 'invalid');
  assert.ok(
    report.errors.some((e) => e.code === 'cil-stack-underflow' && e.bytecodeOffset === 5),
    `Expected cil-stack-underflow at falseTargetOffset=5, got ${JSON.stringify(report.errors)}`,
  );
  const fact = report.verifierFacts.find((f) => f.code === 'cil-stack-dataflow-validated');
  assert.equal(fact.reachedBlocks, 5);
});

// 2. [P1] js/managed/cil/lifter-core.js: ceq / cgt / clt emit bits: operandBits on consumedValues
test('Wave2-G #2 [P1]: 64-bit integer ceq/cgt/clt emit bits: 64 on consumedValues and validate cleanly', () => {
  const cases = [
    { name: 'Ceq64', op: [0xfe, 0x01], mnemonic: 'ceq' },
    { name: 'Cgt64', op: [0xfe, 0x02], mnemonic: 'cgt' },
    { name: 'Clt64', op: [0xfe, 0x04], mnemonic: 'clt' },
  ];
  for (const { name, op, mnemonic } of cases) {
    // ldc.i8 1; ldc.i8 2; <cmp>; ret
    const body = [
      0x21, 1, 0, 0, 0, 0, 0, 0, 0,
      0x21, 2, 0, 0, 0, 0, 0, 0, 0,
      ...op,
      0x2a,
    ];
    const image = buildCil({
      methods: [{ name, body, signature: [0x00, 0x00, 0x08] }],
    }).bytes;
    const decoded = liftCilMethod(0, parseCil(image));
    const cmpBundle = decoded.bundles.find((b) => b.mnemonic === mnemonic);
    assert.ok(cmpBundle, `${mnemonic} bundle present`);
    assert.equal(cmpBundle.completeness, 'exact');
    assert.deepEqual(cmpBundle.consumedValues, [
      { id: 'rhs', bits: 64 },
      { id: 'lhs', bits: 64 },
    ]);
    assert.deepEqual(cmpBundle.producedValues, [{ bits: 32, stackType: 'int32' }]);

    const report = validateCilEffectFunction(decoded, { maxStack: 4, returnStackSlots: 1 });
    assert.equal(report.status, 'valid', `Expected valid report for ${name}, got ${JSON.stringify(report.errors)}`);
  }
});

test('Wave2-G #2 [P1]: 32-bit integer ceq still emits bits: 32 and unresolved operands do not fabricate bits: 32', () => {
  // 32-bit: ldc.i4.1; ldc.i4.2; ceq; ret
  const img32 = buildCil({
    methods: [{ name: 'Ceq32', body: [0x17, 0x18, 0xfe, 0x01, 0x2a], signature: [0x00, 0x00, 0x08] }],
  }).bytes;
  const dec32 = liftCilMethod(0, parseCil(img32));
  const b32 = dec32.bundles.find((b) => b.mnemonic === 'ceq');
  assert.deepEqual(b32.consumedValues, [{ id: 'rhs', bits: 32 }, { id: 'lhs', bits: 32 }]);
  assert.equal(validateCilEffectFunction(dec32, { maxStack: 4, returnStackSlots: 1 }).status, 'valid');

  // Unresolved: ldarg.0 (object-ref); ldarg.1 (object-ref); ceq; ret -> signature (object, object) -> int32
  const imgObj = buildCil({
    methods: [{ name: 'CeqObj', body: [0x02, 0x03, 0xfe, 0x01, 0x2a], signature: [0x00, 0x02, 0x08, 0x1c, 0x1c] }],
  }).bytes;
  const decObj = liftCilMethod(0, parseCil(imgObj));
  const bObj = decObj.bundles.find((b) => b.mnemonic === 'ceq');
  assert.equal(bObj.completeness, 'partial');
  assert.deepEqual(bObj.consumedValues, [{ id: 'rhs' }, { id: 'lhs' }]);
  assert.equal(validateCilEffectFunction(decObj, { maxStack: 4, returnStackSlots: 1 }).errors.length, 0);
});

// 3. [P2] js/managed/cil/call-signatures.js: resolveFieldIndexed supports MemberRefParent TypeSpec (parentTag === 4)
test('Wave2-G #3 [P2]: createCilFieldSignatureResolver resolves MemberRef with TypeSpec parent (parentTag === 4)', () => {
  // Blob 1 (offset 8): FieldSig int64 -> [0x06, 0x0a]
  // Blob 2 (offset 11): TypeSpec GENERICINST CLASS TypeDef(1) [0x04] 1 arg int64 [0x0a] -> [0x15, 0x12, 0x04, 0x01, 0x0a]
  // MemberRef row 1: parent = (1 << 3) | 4 = 12 (TypeSpec rid 1), name = 1 ('Value'), sig = 8
  const memberRefRow = new Uint8Array(6);
  const mrv = new DataView(memberRefRow.buffer);
  mrv.setUint16(0, (1 << 3) | 4, true);
  mrv.setUint16(2, 1, true);
  mrv.setUint16(4, 8, true);

  // TypeSpec row 1: signature = 11
  const typeSpecRow = new Uint8Array(2);
  new DataView(typeSpecRow.buffer).setUint16(0, 11, true);

  const image = buildCil({
    leadingStrings: ['Value'],
    blobs: [
      [0x06, 0x0a],
      [0x15, 0x12, 0x04, 0x01, 0x0a],
    ],
    // ldarg.0; ldfld MemberRef(1) [0x0a000001]; ret
    methods: [{ name: 'GetVal', flags: 0x06, body: [0x02, 0x7b, 0x01, 0x00, 0x00, 0x0a, 0x2a], signature: [0x20, 0x00, 0x0a] }],
    extraRows: [
      [0x0a, { count: 1, bytes: memberRefRow }],
      [0x1b, { count: 1, bytes: typeSpecRow }],
    ],
  }).bytes;

  const resolveField = createCilFieldSignatureResolver({ rawBytes: image });
  const res = resolveField(0x0a000001);
  assert.equal(res.complete, true, `Expected complete field resolution, got ${JSON.stringify(res)}`);
  assert.equal(res.fieldName, 'Value');
  assert.equal(res.fieldType.bits, 64);
  assert.equal(res.fieldType.stackType, 'int64');
  assert.equal(res.declaringType, 'Example.Widget');
  assert.equal(res.provenance.table, 'MemberRef');
  assert.equal(res.provenance.declaringTypeToken, 0x1b000001);

  const lifted = liftCilMethod(0, parseCil(image));
  const ldfld = lifted.bundles.find((b) => b.mnemonic === 'ldfld');
  assert.ok(ldfld);
  assert.equal(ldfld.completeness, 'exact');
  assert.equal(ldfld.producedValues[0].bits, 64);
  assert.equal(ldfld.memoryEffects[0].fieldName, 'Value');
  assert.equal(ldfld.memoryEffects[0].declaringType, 'Example.Widget');
});

test('Wave2-G #3 [P2]: resolveFieldIndexed still rejects MethodDef parent (parentTag === 3) and out-of-range TypeSpec', () => {
  const makeMemberRef = (parentEncoded, typeSpecCount) => {
    const memberRefRow = new Uint8Array(6);
    const mrv = new DataView(memberRefRow.buffer);
    mrv.setUint16(0, parentEncoded, true);
    mrv.setUint16(2, 1, true);
    mrv.setUint16(4, 8, true);

    const extraRows = [[0x0a, { count: 1, bytes: memberRefRow }]];
    if (typeSpecCount > 0) {
      const typeSpecRow = new Uint8Array(2);
      new DataView(typeSpecRow.buffer).setUint16(0, 11, true);
      extraRows.push([0x1b, { count: typeSpecCount, bytes: typeSpecRow }]);
    }
    return buildCil({
      leadingStrings: ['Value'],
      blobs: [
        [0x06, 0x08],
        [0x15, 0x12, 0x04, 0x01, 0x08],
      ],
      extraRows,
    }).bytes;
  };

  // parentTag === 3 (MethodDef) -> cil-memberref-parent-invalid
  const badMethodParent = createCilFieldSignatureResolver({ rawBytes: makeMemberRef((1 << 3) | 3, 1) })(0x0a000001);
  assert.equal(badMethodParent.complete, false);
  assert.equal(badMethodParent.reason, 'cil-memberref-parent-invalid');

  // parentTag === 4 (TypeSpec) with rid=2 when typeSpecs.length=1 -> cil-memberref-parent-out-of-range
  const outOfRangeTypeSpec = createCilFieldSignatureResolver({ rawBytes: makeMemberRef((2 << 3) | 4, 1) })(0x0a000001);
  assert.equal(outOfRangeTypeSpec.complete, false);
  assert.equal(outOfRangeTypeSpec.reason, 'cil-memberref-parent-out-of-range');
});

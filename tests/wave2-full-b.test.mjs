import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimsConflict,
  createHardConstraint,
  createTypeClaim,
} from '../js/analysis/types/constraints.js';
import { TypeConstraintGraph } from '../js/analysis/types/graph.js';
import {
  createPointsToSet,
  createPointsToTarget,
  exactRange,
  joinPointsTo,
  pointsToEqual,
} from '../js/analysis/pointsto/lattice.js';
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates, findValueUpdatesLegacy } from '../js/dataflow.js';
import { createX86DecodedInstruction } from '../js/targets/architecture/x86_64/decoded-instruction.js';
import {
  liftX86SimdEffects,
  x86VectorFamilyEncodingMatches,
} from '../js/targets/architecture/x86_64/effects/simd.js';

// ---------------------------------------------------------------------------
// 1. [P1] graph.js + constraints.js — array totalSizeBytes/sizeBytes & stride*length
// ---------------------------------------------------------------------------
test('1. [P1] graph.js & constraints.js handle array totalSizeBytes/sizeBytes normalization and stride*length conflicts', () => {
  const claim = (descriptor) => createTypeClaim({ layer: 'structural', entityId: 'ent:arr', descriptor });

  // Compatible: totalSizeBytes vs sizeBytes with different numeric representations
  const graphCompat = new TypeConstraintGraph();
  graphCompat.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', totalSizeBytes: 32 }),
    evidenceIds: ['ev-arr-total'],
  }));
  graphCompat.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', sizeBytes: '32', strideBytes: 4, length: 8 }),
    evidenceIds: ['ev-arr-stride'],
  }));
  const compatDecision = graphCompat.solveEntity('ent:arr').layers.structural;
  assert.equal(compatDecision.confidence, 'certain');
  assert.equal(compatDecision.contradictions.length, 0);
  assert.equal(compatDecision.selected.descriptor.totalSizeBytes, 32);
  assert.equal(compatDecision.selected.descriptor.sizeBytes, 32);

  // Compatible: totalSizeBytes on one claim and strideBytes+length on another
  const graphDerived = new TypeConstraintGraph();
  graphDerived.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', totalSizeBytes: 64 }),
    evidenceIds: ['ev-arr-64'],
  }));
  graphDerived.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', strideBytes: 8, length: 8 }),
    evidenceIds: ['ev-arr-8x8'],
  }));
  const derivedDecision = graphDerived.solveEntity('ent:arr').layers.structural;
  assert.equal(derivedDecision.confidence, 'certain');
  assert.equal(derivedDecision.selected.descriptor.sizeBytes, 64);
  assert.equal(derivedDecision.selected.descriptor.totalSizeBytes, 64);

  // Conflict: claimsConflict catches stride*length !== totalSizeBytes across claims
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 4, length: 8 }),
      claim({ kind: 'array', totalSizeBytes: 16 }),
    ),
    true,
    'stride*length=32 must conflict with totalSizeBytes=16',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 4 }),
      claim({ kind: 'array', length: 8, sizeBytes: 16 }),
    ),
    true,
    'split stride=4 and length=8, sizeBytes=16 must conflict',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 4, length: 8 }),
      claim({ kind: 'array', totalSizeBytes: 32 }),
    ),
    false,
    'stride*length=32 and totalSizeBytes=32 must be compatible',
  );

  // Graph solve with conflicting stride*length vs totalSizeBytes must contradict, never throw TypeError
  const graphConflict = new TypeConstraintGraph();
  graphConflict.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', strideBytes: 4, length: 8 }),
    evidenceIds: ['ev-c1'],
  }));
  graphConflict.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', totalSizeBytes: 16 }),
    evidenceIds: ['ev-c2'],
  }));
  const conflictDecision = graphConflict.solveEntity('ent:arr').layers.structural;
  assert.equal(conflictDecision.confidence, 'unknown');
  assert.ok(conflictDecision.contradictions.length > 0);

  // 3-way split conflict (pairwise compatible, globally inconsistent) must return unknown without throwing
  const graphThreeWay = new TypeConstraintGraph();
  graphThreeWay.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', strideBytes: 4 }),
    evidenceIds: ['ev-3a'],
  }));
  graphThreeWay.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', length: 8 }),
    evidenceIds: ['ev-3b'],
  }));
  graphThreeWay.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', totalSizeBytes: 16 }),
    evidenceIds: ['ev-3c'],
  }));
  const threeWayDecision = graphThreeWay.solveEntity('ent:arr').layers.structural;
  assert.equal(threeWayDecision.confidence, 'unknown');
  assert.equal(threeWayDecision.selected, null);
});

// ---------------------------------------------------------------------------
// 2. [P2] lattice.js — joinPointsTo fast path checks canonicalRootStorageClass
// ---------------------------------------------------------------------------
test('2. [P2] lattice.js joinPointsTo fast path preserves commutativity and canonicalRootStorageClass', () => {
  const makeSet = (storageClass) => createPointsToSet({
    targets: [
      createPointsToTarget({
        addressSpace: 'ram',
        rootKind: 'stack',
        rootIdentity: 'frame:0',
        rootEntityId: 'ent:stack0',
        offsetRange: exactRange(16),
        widthBits: 64,
        evidenceIds: ['ev-1'],
        ...(storageClass != null ? { canonicalRootStorageClass: storageClass } : {}),
      }),
    ],
  });

  const withoutStorage = makeSet(null);
  const stackStorage = makeSet('stack');
  const heapStorage = makeSet('heap');

  assert.equal(pointsToEqual(withoutStorage, stackStorage), true);
  assert.equal(pointsToEqual(stackStorage, heapStorage), true);

  // One-sided canonicalRootStorageClass must be preserved regardless of argument order
  const lr = joinPointsTo(withoutStorage, stackStorage);
  const rl = joinPointsTo(stackStorage, withoutStorage);
  assert.equal(lr.targets[0].canonicalRootStorageClass, 'stack');
  assert.equal(rl.targets[0].canonicalRootStorageClass, 'stack');

  // Conflicting canonicalRootStorageClass must be dropped regardless of argument order
  const sh = joinPointsTo(stackStorage, heapStorage);
  const hs = joinPointsTo(heapStorage, stackStorage);
  assert.equal(sh.targets[0].canonicalRootStorageClass, undefined);
  assert.equal(hs.targets[0].canonicalRootStorageClass, undefined);

  // Matching canonicalRootStorageClass can still take the fast path and preserve it
  const same = joinPointsTo(stackStorage, makeSet('stack'));
  assert.equal(same.targets[0].canonicalRootStorageClass, 'stack');
});

// ---------------------------------------------------------------------------
// 3. [P1] dataflow-semantic.js + dataflow-legacy.js — 4-arg vs 6-arg objc_setProperty ABI
// ---------------------------------------------------------------------------
function modelWithInstructions(lines, symbol) {
  const base = 0x100000000n;
  const target = 0x100000200n;
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  return buildSemanticModel(rows, {
    startRow: 0,
    endRow: rows.length - 1,
    symbolFor: (address) => (address === target ? symbol : null),
    rowOfAddress: (address) => {
      const delta = address - base;
      return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
    },
  });
}

test('3. [P1] dataflow-semantic.js and dataflow-legacy.js use x3 offset / x2 value for 4-arg objc_setProperty variants', () => {
  const lines4ArgImm = [
    'mov x3, #0x28',
    'b #0x100000200',
  ];
  const lines4ArgGlobal = [
    'adrp x8, #0x100004000',
    'ldrsw x3, [x8, #0x20]',
    'b #0x100000200',
  ];
  const lines6ArgImm = [
    'mov x2, #0x30',
    'b #0x100000200',
  ];

  const fourArgSymbols = [
    'objc_setProperty_atomic',
    '_objc_setProperty_atomic',
    'objc_setProperty_nonatomic',
    '_objc_setProperty_nonatomic',
    'objc_setProperty_atomic_copy',
    '_objc_setProperty_atomic_copy',
    'objc_setProperty_nonatomic_copy',
    '_objc_setProperty_nonatomic_copy',
  ];

  for (const symbol of fourArgSymbols) {
    // Semantic IR engine (immediate offset in x3)
    const semImm = findValueUpdates(modelWithInstructions(lines4ArgImm, symbol));
    assert.equal(semImm.length, 1, `semantic imm ${symbol}`);
    assert.equal(semImm[0].kind, 'write', symbol);
    assert.equal(semImm[0].register, 'x2', symbol);
    assert.equal(semImm[0].store.reg, 'x2', symbol);
    assert.equal(semImm[0].location.disp, 0x28n, symbol);

    // Semantic IR engine (global ivar offset in x3)
    const semGlobal = findValueUpdates(modelWithInstructions(lines4ArgGlobal, symbol));
    assert.equal(semGlobal.length, 1, `semantic global ${symbol}`);
    assert.equal(semGlobal[0].kind, 'write', symbol);
    assert.equal(semGlobal[0].register, 'x2', symbol);
    assert.equal(semGlobal[0].store.reg, 'x2', symbol);
    assert.equal(semGlobal[0].location.indexAddr, 0x100004020n, symbol);

    // Legacy engine (immediate offset in x3)
    const legImm = findValueUpdatesLegacy(modelWithInstructions(lines4ArgImm, symbol));
    assert.equal(legImm.length, 1, `legacy imm ${symbol}`);
    assert.equal(legImm[0].kind, 'write', symbol);
    assert.equal(legImm[0].register, 'x2', symbol);
    assert.equal(legImm[0].store.reg, 'x2', symbol);
    assert.equal(legImm[0].location.disp, 0x28n, symbol);
  }

  // 6-arg objc_setProperty retains x2 offset / x3 value
  for (const symbol of ['objc_setProperty', '_objc_setProperty']) {
    const sem6 = findValueUpdates(modelWithInstructions(lines6ArgImm, symbol));
    assert.equal(sem6.length, 1, `semantic 6-arg ${symbol}`);
    assert.equal(sem6[0].kind, 'write', symbol);
    assert.equal(sem6[0].register, 'x3', symbol);
    assert.equal(sem6[0].location.disp, 0x30n, symbol);

    const leg6 = findValueUpdatesLegacy(modelWithInstructions(lines6ArgImm, symbol));
    assert.equal(leg6.length, 1, `legacy 6-arg ${symbol}`);
    assert.equal(leg6[0].kind, 'write', symbol);
    assert.equal(leg6[0].register, 'x3', symbol);
    assert.equal(leg6[0].location.disp, 0x30n, symbol);
  }
});

// ---------------------------------------------------------------------------
// 4. [P2] simd.js — vmovq permits pp=2 (0xF3) alongside pp=1 (0x66)
// ---------------------------------------------------------------------------
test('4. [P2] simd.js accepts VEX.128.F3.0F.WIG 7E vmovq (pp=2) and still rejects invalid pp', () => {
  const makeVmovq = (rawBytes, vector, operands) => createX86DecodedInstruction({
    address: 0x401000n,
    length: rawBytes.length,
    rawBytes: Uint8Array.from(rawBytes),
    mode: 'long-64',
    instructionId: 'test-vmovq',
    instructionCode: 1,
    instructionFamily: 'vmovq',
    mnemonic: 'vmovq',
    detailAvailable: true,
    detailStatus: 'complete',
    detail: {
      abiContractVersion: 'capstone-5-wasm32-x86-detail/v1',
      operandCount: operands.length,
      operands,
      implicitReads: [],
      implicitWrites: [],
      prefixes: { legacy: [], rex: null, vector },
    },
  });

  // VEX.128.F3.0F.WIG 7E /r: vmovq xmm1, xmm2 (pp=2)
  const vmovqF3 = makeVmovq(
    [0xc5, 0xfa, 0x7e, 0xca],
    { kind: 'vex2', bytes: [0xc5, 0xfa] },
    [
      { type: 'register', registerId: 'xmm1', registerCode: 1, widthBits: 128, access: 'write' },
      { type: 'register', registerId: 'xmm2', registerCode: 2, widthBits: 128, access: 'read' },
    ],
  );
  assert.equal(x86VectorFamilyEncodingMatches(vmovqF3, 'vmovq'), true);
  const f3Result = liftX86SimdEffects(vmovqF3);
  assert.equal(f3Result.completeness, 'exact');

  // VEX.128.66.0F.W1 6E /r: vmovq xmm1, rax (pp=1)
  const vmovq66 = makeVmovq(
    [0xc4, 0xe1, 0xf9, 0x6e, 0xc8],
    { kind: 'vex3', bytes: [0xc4, 0xe1, 0xf9] },
    [
      { type: 'register', registerId: 'xmm1', registerCode: 1, widthBits: 128, access: 'write' },
      { type: 'register', registerId: 'rax', registerCode: 0, widthBits: 64, access: 'read' },
    ],
  );
  assert.equal(x86VectorFamilyEncodingMatches(vmovq66, 'vmovq'), true);
  const p66Result = liftX86SimdEffects(vmovq66);
  assert.equal(p66Result.completeness, 'exact');

  // Invalid pp=0 (0x0F) and pp=3 (0xF2) must still be rejected
  for (const ppByte of [0xf8, 0xfb]) {
    const bad = makeVmovq(
      [0xc5, ppByte, 0x7e, 0xca],
      { kind: 'vex2', bytes: [0xc5, ppByte] },
      [
        { type: 'register', registerId: 'xmm1', registerCode: 1, widthBits: 128, access: 'write' },
        { type: 'register', registerId: 'xmm2', registerCode: 2, widthBits: 128, access: 'read' },
      ],
    );
    assert.equal(x86VectorFamilyEncodingMatches(bad, 'vmovq'), false);
    const badResult = liftX86SimdEffects(bad);
    assert.equal(badResult.completeness, 'partial');
    assert.equal(badResult.unknownEffects?.reason, 'x86-vector-prefix-family-mismatch');
  }
});

// ---------------------------------------------------------------------------
// 5. [P2] graph.js + constraints.js — array strideBytes < elementType.totalSizeBytes
// ---------------------------------------------------------------------------
test('5. [P2] graph.js & constraints.js enforce strideBytes >= elementType.totalSizeBytes', () => {
  const claim = (descriptor) => createTypeClaim({ layer: 'structural', entityId: 'ent:arr-elem-total', descriptor });

  // claimsConflict must catch strideBytes < elementType.totalSizeBytes across claims
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 8 }),
      claim({ kind: 'array', elementType: { kind: 'struct', totalSizeBytes: 16 } }),
    ),
    true,
    'strideBytes=8 must conflict with elementType.totalSizeBytes=16',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: '8' }),
      claim({ kind: 'array', elementType: { kind: 'struct', totalSizeBytes: '16' } }),
    ),
    true,
    'string numeric strideBytes=8 must conflict with elementType.totalSizeBytes=16',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 16, elementType: { kind: 'struct', sizeBytes: 8 } }),
      claim({ kind: 'array', strideBytes: 16, elementType: { kind: 'struct', totalSizeBytes: 16 } }),
    ),
    true,
    'conflicting elementType.sizeBytes vs elementType.totalSizeBytes across claims must conflict',
  );
  assert.equal(
    claimsConflict(
      claim({ kind: 'array', strideBytes: 16 }),
      claim({ kind: 'array', elementType: { kind: 'struct', totalSizeBytes: 16 } }),
    ),
    false,
    'strideBytes=16 and elementType.totalSizeBytes=16 must be compatible',
  );

  // TypeConstraintGraph must reject strideBytes < elementType.totalSizeBytes
  const graphConflict = new TypeConstraintGraph();
  graphConflict.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', strideBytes: 8 }),
    evidenceIds: ['ev-elem-stride'],
  }));
  graphConflict.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', elementType: { kind: 'struct', totalSizeBytes: 16 } }),
    evidenceIds: ['ev-elem-total'],
  }));
  const conflictDecision = graphConflict.solveEntity('ent:arr-elem-total').layers.structural;
  assert.equal(conflictDecision.confidence, 'unknown');
  assert.ok(conflictDecision.contradictions.length > 0);

  // TypeConstraintGraph must accept strideBytes >= elementType.totalSizeBytes
  const graphCompat = new TypeConstraintGraph();
  graphCompat.addHardConstraint(createHardConstraint({
    kind: 'array-stride',
    origin: 'binary-evidence',
    claim: claim({ kind: 'array', strideBytes: 16, length: 4 }),
    evidenceIds: ['ev-elem-ok-stride'],
  }));
  graphCompat.addHardConstraint(createHardConstraint({
    kind: 'debug-type',
    origin: 'debug-matched',
    claim: claim({ kind: 'array', elementType: { kind: 'struct', totalSizeBytes: 16 } }),
    evidenceIds: ['ev-elem-ok-total'],
  }));
  const compatDecision = graphCompat.solveEntity('ent:arr-elem-total').layers.structural;
  assert.equal(compatDecision.confidence, 'certain');
  assert.equal(compatDecision.contradictions.length, 0);
  assert.equal(compatDecision.selected.descriptor.totalSizeBytes, 64);
});

test('6. [P1/P2] constraints.js validates single-claim elementType.totalSizeBytes and offset-less union member bounds', () => {
  assert.throws(
    () => createTypeClaim({
      entityId: 'entity:w3-arr',
      layer: 'structural',
      descriptor: { kind: 'array', strideBytes: 8, elementType: { kind: 'struct', totalSizeBytes: 16 } },
    }),
    /structural-array-stride-conflict/,
  );

  const c1 = createTypeClaim({
    entityId: 'entity:w3-union',
    layer: 'structural',
    descriptor: { kind: 'union', sizeBytes: 8 },
  });
  const c2 = createTypeClaim({
    entityId: 'entity:w3-union',
    layer: 'structural',
    descriptor: { kind: 'union', members: [{ fieldName: 'big', sizeBytes: 16 }] },
  });
  assert.equal(claimsConflict(c1, c2), true, 'offset-less union member exceeding aggregate size must conflict');
});

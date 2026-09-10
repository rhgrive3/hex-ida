// Regression for #7924: CIL relational/equality branch opcodes (bge, blt.un, ...)
// consume two values and branch on a specific signed/unsigned comparison
// predicate. The lifter kept the mnemonic but emitted a bare
// `kind:'conditional-branch'` control effect, and the shared bridge lowered
// every comparison branch to the same canonical node — no predicate, no
// signedness — while still publishing exact/complete semantics.
//
// Review blocker (unordered authority): the `.un` relational variants are
// unsigned-OR-unordered. For floating operands the unordered/NaN case also
// takes the branch (ECMA-335 III.1.5 / III.3.32-III.3.35), and this bridge has
// no authoritative operand-type evidence to assume the integer-only reading.
// `attributes.unordered` records that authority first-class; where the
// canonical condition vocabulary cannot represent the disjunction the bridge
// fails closed instead of fabricating an ordered/unsigned condition code.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';

// Exactly representable: `eq`/`ne` are signedness-free and IEEE `ne` already
// includes the unordered case, so one condition code covers every operand
// domain. These branches stay `complete`.
const COMPLETE_TABLE = [
  [0x2e, 'beq', { conditionCode: 'eq', predicate: 'eq', signed: null, unordered: undefined }],
  [0x2f, 'bge', { conditionCode: 'ge', predicate: 'ge', signed: true, unordered: undefined }],
  [0x30, 'bgt', { conditionCode: 'gt', predicate: 'gt', signed: true, unordered: undefined }],
  [0x31, 'ble', { conditionCode: 'le', predicate: 'le', signed: true, unordered: undefined }],
  [0x32, 'blt', { conditionCode: 'lt', predicate: 'lt', signed: true, unordered: undefined }],
  [0x33, 'bne.un', { conditionCode: 'ne', predicate: 'ne', signed: false, unordered: true }],
];

// Not representable by a single condition code: `bge.un` means "unsigned >=
// OR unordered". The bridge keeps `{predicate, signed:false, unordered:true}`
// as first-class attributes and fails closed: node `partial` with an explicit
// unknown and NO fabricated ordered condition code.
const UNREPRESENTABLE_TABLE = [
  [0x34, 'bge.un', 'ge'],
  [0x35, 'bgt.un', 'gt'],
  [0x36, 'ble.un', 'le'],
  [0x37, 'blt.un', 'lt'],
];

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-7924',
    vmSpecEdition: 'ecma-335',
    methodBodies: [{
      bytecode,
      codeOffset: 0,
      headerOffset: 0,
      maxStack: 2,
      isTiny: false,
      exceptionClauses: [],
    }],
  };
}

function branchFor(opcode, shortForm) {
  const suffix = shortForm ? [0x01] : [0x00, 0x01];
  const bytecode = Uint8Array.from([0x17, 0x16, opcode, ...suffix, 0x2a, 0x2a]);
  const effects = liftCilMethod(0, cilImage(bytecode), {}, {
    complete: true,
    methodToken: 0x06000001,
    signature: { returnValue: null },
  });
  return lowerVMEffectsToSemanticIr(effects);
}

function branchNode(opcode) {
  return branchFor(opcode, true).semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
}

test('#7924 every exactly-representable CIL comparison branch carries its predicate, signedness and condition code', () => {
  for (const [opcode, expectedMnemonic, expected] of COMPLETE_TABLE) {
    const node = branchNode(opcode);
    assert.ok(node, `conditional-branch node exists for ${expectedMnemonic}`);
    assert.equal(node.metadata?.mnemonic, `${expectedMnemonic}.s`, `mnemonic preserved for ${expectedMnemonic}`);
    assert.equal(node.attributes.conditionCode, expected.conditionCode, `${expectedMnemonic} conditionCode`);
    assert.equal(node.attributes.predicate, expected.predicate, `${expectedMnemonic} predicate`);
    assert.equal(node.attributes.signed, expected.signed ?? null, `${expectedMnemonic} signedness`);
    if (expected.unordered === undefined) {
      assert.equal(node.attributes.unordered, undefined, `${expectedMnemonic} must not claim unordered authority`);
    } else {
      assert.equal(node.attributes.unordered, true, `${expectedMnemonic} unordered authority`);
    }
    assert.equal(node.completeness, 'complete', `${expectedMnemonic} stays complete`);
  }
});

test('#7924 unordered CIL relational branches fail closed instead of fabricating an ordered condition', () => {
  for (const [opcode, expectedMnemonic, predicate] of UNREPRESENTABLE_TABLE) {
    const node = branchNode(opcode);
    assert.ok(node, `conditional-branch node exists for ${expectedMnemonic}`);
    assert.equal(node.metadata?.mnemonic, `${expectedMnemonic}.s`, `mnemonic preserved for ${expectedMnemonic}`);
    assert.equal(node.attributes.predicate, predicate, `${expectedMnemonic} predicate`);
    assert.equal(node.attributes.signed, false, `${expectedMnemonic} unsigned-or-unordered signedness`);
    assert.equal(node.attributes.unordered, true, `${expectedMnemonic} first-class unordered authority`);
    assert.equal(node.attributes.conditionCode, undefined, `${expectedMnemonic} must not fabricate an ordered condition code`);
    assert.equal(node.completeness, 'partial', `${expectedMnemonic} degrades to partial`);
    assert.ok(node.unknown, `${expectedMnemonic} carries the fail-closed unknown`);
    assert.equal(node.unknown.reason, 'cil-unordered-branch-condition-unrepresented');
    assert.ok(node.unknown.categories.includes('control'), `${expectedMnemonic} unknown is control-category`);
  }
});

test('#7924 signed and unordered variants are canonically distinguishable', () => {
  // NaN orientation: for floating operands `bge.un` takes the branch on the
  // unordered case (unordered:true), `bge` never does (ordered >= only). The
  // canonical records must differ on more than the integer signedness bit.
  const signed = branchNode(0x2f);
  const unordered = branchNode(0x34);
  assert.equal(signed.attributes.conditionCode, 'ge');
  assert.equal(signed.attributes.signed, true);
  assert.equal(signed.attributes.unordered, undefined);
  assert.equal(signed.completeness, 'complete');
  assert.equal(unordered.attributes.conditionCode, undefined);
  assert.equal(unordered.attributes.signed, false);
  assert.equal(unordered.attributes.unordered, true);
  assert.equal(unordered.completeness, 'partial');
  assert.notDeepEqual(signed.attributes, unordered.attributes);
  assert.notDeepEqual({ ...signed.attributes, completeness: signed.completeness }, { ...unordered.attributes, completeness: unordered.completeness });
});

test('#7924 the v2->v1 projection projects distinct condition codes without ordered fabrication for unordered branches', () => {
  const condFor = (opcode) => {
    const lowered = branchFor(opcode, true);
    const node = lowered.semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
    const legacy = projectSemanticIrV2ToLegacyV1(lowered.semanticIr, { cfg: lowered.cfg, ssa: lowered.ssa });
    const inst = legacy.instructions.find((i) => i.semanticNodeId === node.id);
    return inst?.cond ?? null;
  };
  assert.equal(condFor(0x2f), 'ge');
  assert.equal(condFor(0x2e), 'eq');
  assert.equal(condFor(0x33), 'ne');
  // The unordered/NaN-taking branches must not reach v1 dressed as ordinary
  // unsigned integer conditions (`hs`/`hi`/`ls`/`lo`): an unrepresented
  // condition projects as absent, never as a fabricated ordered code.
  for (const [opcode, expectedMnemonic] of UNREPRESENTABLE_TABLE) {
    assert.equal(condFor(opcode), null, `${expectedMnemonic} must not project a fabricated condition code`);
  }
});

test('#7924 non-predicate conditional branches receive no fabricated attributes', () => {
  for (const [opcode, mnemonic] of [[0x2d, 'brtrue.s'], [0x2c, 'brfalse.s']]) {
    const lowered = branchFor(opcode, true);
    const node = lowered.semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
    assert.ok(node, `conditional-branch node exists for ${mnemonic}`);
    assert.equal(node.metadata?.mnemonic, mnemonic);
    assert.deepEqual(node.attributes, {}, `${mnemonic} must not fabricate a two-operand predicate`);
  }
});

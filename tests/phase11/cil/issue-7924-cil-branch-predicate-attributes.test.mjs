// Regression for #7924: CIL relational/equality branch opcodes (bge, blt.un, ...)
// consume two values and branch on a specific signed/unsigned comparison
// predicate. The lifter kept the mnemonic but emitted a bare
// `kind:'conditional-branch'` control effect, and the shared bridge lowered
// every comparison branch to the same canonical node — no predicate, no
// signedness — while still publishing exact/complete semantics.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';

const BRANCH_TABLE = [
  [0x2e, 'beq', { conditionCode: 'eq', predicate: 'eq' }],
  [0x2f, 'bge', { conditionCode: 'ge', predicate: 'ge', signed: true }],
  [0x30, 'bgt', { conditionCode: 'gt', predicate: 'gt', signed: true }],
  [0x31, 'ble', { conditionCode: 'le', predicate: 'le', signed: true }],
  [0x32, 'blt', { conditionCode: 'lt', predicate: 'lt', signed: true }],
  [0x33, 'bne.un', { conditionCode: 'ne', predicate: 'ne', signed: false }],
  [0x34, 'bge.un', { conditionCode: 'hs', predicate: 'ge', signed: false }],
  [0x35, 'bgt.un', { conditionCode: 'hi', predicate: 'gt', signed: false }],
  [0x36, 'ble.un', { conditionCode: 'ls', predicate: 'le', signed: false }],
  [0x37, 'blt.un', { conditionCode: 'lo', predicate: 'lt', signed: false }],
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

test('#7924 every CIL comparison branch carries its predicate, signedness and condition code', () => {
  for (const [opcode, expectedMnemonic, expected] of BRANCH_TABLE) {
    const lowered = branchFor(opcode, true);
    const node = lowered.semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
    assert.ok(node, `conditional-branch node exists for ${expectedMnemonic}`);
    assert.equal(node.metadata?.mnemonic, `${expectedMnemonic}.s`, `mnemonic preserved for ${expectedMnemonic}`);
    assert.equal(node.attributes.conditionCode, expected.conditionCode, `${expectedMnemonic} conditionCode`);
    assert.equal(node.attributes.predicate, expected.predicate, `${expectedMnemonic} predicate`);
    assert.equal(node.attributes.signed, expected.signed ?? null, `${expectedMnemonic} signedness`);
    assert.equal(node.completeness, 'complete', `${expectedMnemonic} stays complete`);
  }
});

test('#7924 signed and unsigned variants are canonically distinguishable', () => {
  const signed = branchFor(0x2f, true).semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
  const unsigned = branchFor(0x34, true).semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
  assert.equal(signed.attributes.conditionCode, 'ge');
  assert.equal(unsigned.attributes.conditionCode, 'hs');
  assert.equal(signed.attributes.signed, true);
  assert.equal(unsigned.attributes.signed, false);
  assert.notDeepEqual(signed.attributes, unsigned.attributes);
});

test('#7924 the v2->v1 projection projects distinct branch condition codes', () => {
  const condFor = (opcode) => {
    const lowered = branchFor(opcode, true);
    const node = lowered.semanticIr.nodes.find((n) => n.kind === 'conditional-branch');
    const legacy = projectSemanticIrV2ToLegacyV1(lowered.semanticIr, { cfg: lowered.cfg, ssa: lowered.ssa });
    const inst = legacy.instructions.find((i) => i.semanticNodeId === node.id);
    return inst?.cond ?? null;
  };
  assert.equal(condFor(0x2f), 'ge');
  assert.equal(condFor(0x34), 'hs');
  assert.equal(condFor(0x37), 'lo');
  assert.equal(condFor(0x2e), 'eq');
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

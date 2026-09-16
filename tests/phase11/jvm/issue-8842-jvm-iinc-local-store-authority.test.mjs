import assert from 'node:assert/strict';
import test from 'node:test';

import { liftJvmMethod } from '../../../js/managed/jvm/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/shared/bridge-v2.js';

// #8842 — JVM local-state opcodes must not collapse in the canonical Semantic IR:
//   * `iinc index,const` must model `local = local + const` (an `add` of the old
//     local read and the immediate), never a `copy` of the immediate constant.
//   * the `istore/lstore/fstore/dstore/astore` family must lower to just the
//     local `state-write`; the mnemonic-substring classifier in the core used to
//     match the "or" inside "*store" and emit a spurious complete binary `or`.
// A genuine `ior`/`lor` bit-wise OR must still survive as a real binary node.

function intMethod(bytecode, name, maxLocals = 4) {
  return {
    moduleId: 'managed-mod:test:jvm',
    vmSpecEdition: 'java-se-17',
    thisClassName: 'IncFixture',
    constantPool: [null, { tag: 1, value: 'IncFixture' }, { tag: 7, nameIndex: 1 }],
    fields: [],
    methods: [{
      accessFlags: 0x0000,
      name,
      descriptor: '(II)I',
      code: { maxStack: 4, maxLocals, bytecode: Uint8Array.from(bytecode), exceptionTable: [], offset: 0x180 },
    }],
  };
}

function lower(name, bytecode, maxLocals) {
  const fn = liftJvmMethod(0, intMethod(bytecode, name, maxLocals));
  const lowered = lowerVMEffectsToSemanticIr(fn);
  const valueById = new Map(lowered.semanticIr.values.map((v) => [v.id, v]));
  const nodeById = new Map(lowered.semanticIr.nodes.map((n) => [n.id, n]));
  const definingNodeOf = (valueId) => nodeById.get(valueById.get(valueId)?.definitionNodeId);
  const nodesFor = (mnemonic) => {
    const ids = new Set(fn.bundles.filter((b) => b.mnemonic === mnemonic).map((b) => b.operationId));
    return lowered.semanticIr.nodes.filter((n) => (n.sourceEffectIds || []).some((id) => ids.has(id)));
  };
  return { fn, lowered, definingNodeOf, nodesFor };
}

test('#8842 iinc lowers to local + const, not a copy of the immediate', () => {
  // int m(){ int i = 5; i++; return i; }  -> 6
  const { lowered, definingNodeOf, nodesFor } = lower('iinc', [
    0x10, 0x05,        // bipush 5
    0x3c,              // istore_1
    0x84, 0x01, 0x01,  // iinc 1, 1
    0x1b,              // iload_1
    0xac,              // ireturn
  ]);

  const iincNodes = nodesFor('iinc');
  assert.ok(!iincNodes.some((n) => n.kind === 'copy'), 'iinc must not lower to a copy of the constant');
  const add = iincNodes.find((n) => n.kind === 'binary' && n.operator === 'add');
  assert.ok(add, 'iinc must lower to a binary add');
  assert.equal(add.outputs.length, 1);

  const operandNodes = add.inputs.map((id) => definingNodeOf(id));
  assert.ok(operandNodes.some((n) => n?.kind === 'state-read'), 'one add operand must read the old local value');
  const constOperand = operandNodes.find((n) => n?.kind === 'const');
  assert.ok(constOperand, 'the other add operand must be the immediate constant');
  assert.equal(String(constOperand.attributes?.value), '1', 'the immediate must be preserved as the add operand');

  // No local store for this method may emit a spurious complete binary `or`.
  assert.ok(!lowered.semanticIr.nodes.some((n) => n.kind === 'binary' && n.operator === 'or' && n.outputs.length === 0),
    'no spurious zero-output binary `or` node is allowed');
});

test('#8842 istore emits only the local state-write (no binary `or`)', () => {
  // int m(){ int i = 5; return i; }  -> 5
  const { lowered, nodesFor } = lower('istore', [
    0x10, 0x05,        // bipush 5
    0x3c,              // istore_1
    0x1b,              // iload_1
    0xac,              // ireturn
  ]);

  const storeNodes = nodesFor('istore_1');
  assert.equal(storeNodes.filter((n) => n.kind === 'binary').length, 0, 'istore must not create a binary node');
  const writes = storeNodes.filter((n) => n.kind === 'state-write');
  assert.equal(writes.length, 1, 'istore lowers to exactly one state-write');
  assert.equal(writes[0].variable.key, 'vm:jvm:local:1');
  assert.ok(!lowered.semanticIr.nodes.some((n) => n.kind === 'binary' && n.operator === 'or'),
    'no binary `or` node for an istore-only method');
});

test('#8842 a genuine ior still lowers to a real binary `or` (regression guard)', () => {
  // int m(int a, int b){ return a | b; }
  const { lowered } = lower('ior', [
    0x1b,              // iload_1 (a)
    0x1c,              // iload_2 (b)
    0x80,              // ior
    0xac,              // ireturn
  ], 3);

  const ors = lowered.semanticIr.nodes.filter((n) => n.kind === 'binary' && n.operator === 'or');
  assert.equal(ors.length, 1, 'a real ior must survive as exactly one binary or');
  assert.equal(ors[0].inputs.length, 2);
  assert.equal(ors[0].outputs.length, 1);
});

test('#8842 iinc/istore functions decompile without IR invariant failure', () => {
  for (const [name, bytecode, maxLocals] of [
    ['decomp_iinc', [0x10, 0x05, 0x3c, 0x84, 0x01, 0x01, 0x1b, 0xac], 4],
    ['decomp_istore', [0x10, 0x05, 0x3b, 0x1a, 0xac], 4],
  ]) {
    const fn = liftJvmMethod(0, intMethod(bytecode, name, maxLocals));
    const lowered = lowerVMEffectsToSemanticIr(fn);
    assert.doesNotThrow(() => decompileManagedMethod(lowered), `${name} must decompile against the fixed IR`);
  }
});

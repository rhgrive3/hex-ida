// Regression for #1136: Dalvik 23x integer binops (add-int / sub-int / mul-int /
// and-int / or-int / xor-int / shl-int / shr-int / ushr-int / div-int / rem-int)
// are register-machine arithmetic: they read two source registers and write the
// destination register. The shared bridge lowers a `binary` Semantic IR node and
// binds the destination `locationWrite` to the operation's produced result value.
// Previously the 23x bundles emitted no `producedValues`, so the bridge had no
// result identity and bound the destination to an *operand* read value — so
// `add-int v0,v1,v2` left v0 semantically equal to v2 instead of v1+v2.
//
// The fix emits exactly one produced value per 23x binop. This test proves both
// the VMEffect shape (a result identity exists) and the semantic consequence
// (the destination register's state-write is bound to the binary node's output,
// never to a source-register read). 2addr/lit8 encodings carry placeholder
// mnemonics and are a separate operator-modeling concern outside #1136.
import assert from 'node:assert/strict';

import { buildDex } from '../fixtures/medium-dex.mjs';
import { DexFrontend } from '../../../js/managed/dex/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';

console.log('[phase11] running dex 23x arithmetic produced-value authority regression #1136...');

async function lift(words) {
  const { bytes } = buildDex({
    fields: [],
    methods: [{
      classType: 'LTest;', name: 'arith', returnType: 'I', params: [],
      flags: 9, registers: 4, ins: 0, outs: 0, words,
    }],
  });
  const frontend = new DexFrontend();
  const image = await frontend.open(bytes, { binaryId: 'dex-1136-arithmetic-authority' });
  const methods = [];
  for await (const method of frontend.enumerateMethods(image)) methods.push(method);
  const method = methods.find((m) => m.name === 'arith');
  return frontend.decodeMethod(method, { image });
}

// const/4 v0,#1; const/4 v1,#1; <op> v2,v0,v1; return v2.
// 23x word form: op | (AA<<8)  then  (CC<<8)|BB  => op vAA,vBB,vCC.
function methodWords(opcode) {
  return [0x1012, 0x1112, 0x0200 | opcode, 0x0100, 0x020f];
}

const NAMES = {
  0x90: 'add-int', 0x91: 'sub-int', 0x92: 'mul-int', 0x95: 'and-int',
  0x96: 'or-int', 0x97: 'xor-int', 0x98: 'shl-int', 0x99: 'shr-int', 0x9a: 'ushr-int',
};

// 1) VMEffect shape: the arithmetic result identity exists, distinct from a
//    constant and distinct from the operand reads.
for (const [opcode, name] of Object.entries(NAMES)) {
  const decoded = await lift(methodWords(Number(opcode)));
  const bundle = decoded.bundles.find((b) => b.mnemonic === name);
  assert.ok(bundle, `${name} bundle present`);
  assert.equal(bundle.completeness, 'exact', `${name} stays exact`);
  assert.deepEqual(
    bundle.locationReads.map((r) => r.index),
    [0, 1],
    `${name} reads both source registers`,
  );
  assert.deepEqual(
    bundle.locationWrites.map((w) => w.index),
    [2],
    `${name} writes only the destination register`,
  );
  assert.equal(bundle.producedValues.length, 1, `${name} produces exactly one result value`);
  assert.equal(bundle.producedValues[0].constant, undefined, `${name} result is not a constant`);
  assert.equal(bundle.producedValues[0].bits, 32, `${name} result is a 32-bit integer`);
  assert.equal(decoded.aggregateCompleteness, 'exact', `${name} method aggregate stays exact`);
}

// 2) Semantic consequence through the real shared bridge: the destination
//    register's state-write must bind to the binary node's output, never to a
//    source-register read. This is the exact behavior #1136 reported.
for (const [opcode, name] of Object.entries(NAMES)) {
  const decoded = await lift(methodWords(Number(opcode)));
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const nodes = lowered.semanticIr.nodes;
  const opNode = nodes.find((n) => n.metadata?.mnemonic === name && n.kind === 'binary');
  assert.ok(opNode, `${name} lowers to a binary node`);
  assert.equal(opNode.outputs.length, 1, `${name} binary node has one result output`);
  assert.equal(opNode.inputs.length, 2, `${name} binary node consumes two operands`);

  const destWrite = nodes.find((n) => n.kind === 'state-write' && n.variable?.key === 'vm:dex:register:2');
  assert.ok(destWrite, `${name} destination register:2 state-write present`);
  assert.equal(
    destWrite.inputs[0],
    opNode.outputs[0],
    `${name}: destination register binds to the arithmetic result, not an operand`,
  );

  // The result must not be identical to either source-register value identity.
  assert.ok(
    !opNode.inputs.includes(opNode.outputs[0]),
    `${name}: result identity is not one of the operand identities`,
  );
}

// 3) The specific counterexample from the report: add-int v2,v0,v1 lowers with
//    operator 'add' and a single result, proving the operand-copy defect is gone.
{
  const decoded = await lift(methodWords(0x90));
  const lowered = lowerVMEffectsToSemanticIr(decoded);
  const addNode = lowered.semanticIr.nodes.find((n) => n.metadata?.mnemonic === 'add-int');
  assert.equal(addNode.operator, 'add', 'add-int preserves the add operator');
  assert.equal(lowered.semanticIr.completeness, 'complete', 'add-int method lowers complete');
}

console.log('[phase11] dex 23x arithmetic produced-value authority regression #1136 passed');

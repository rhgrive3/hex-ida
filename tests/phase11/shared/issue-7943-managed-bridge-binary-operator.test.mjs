// Regression for #7943: the managed bridge classified arithmetic mnemonics
// (`i32.add`, `i32.sub`, ...) as Semantic IR `kind:'binary'` but never wrote
// the canonical `operator` field. The v2->v1 projection therefore projected
// every binary operation as `op:'bin', sub:'unknown'`, making add/sub canonically
// indistinguishable while the node (and function) stayed `complete`.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liftCilMethod } from '../../../js/managed/cil/lifter-core.js';
import { WasmFrontend } from '../../../js/managed/wasm/frontend.js';
import { lowerVMEffectsToSemanticIr } from '../../../js/managed/shared/bridge-v2.js';
import { projectSemanticIrV2ToLegacyV1 } from '../../../js/semantics/compat/semantic-ir-v2-to-v1.js';

function cilImage(bytecode) {
  return {
    moduleId: 'managed-mod:managed-image:bin:test-7943',
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

function cilBinaryNode(mnemonicByte) {
  const effects = liftCilMethod(0, cilImage(Uint8Array.from([0x17, 0x16, mnemonicByte, 0x26, 0x2a])), {}, {
    complete: true,
    methodToken: 0x06000001,
    signature: { returnValue: null },
  });
  const lowered = lowerVMEffectsToSemanticIr(effects);
  return lowered.semanticIr.nodes.find((n) => n.kind === 'binary');
}

async function wasmBinaryNode(opcode) {
  const wasmBytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0,
    0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x08, 0x01, 0x04, 0x74, 0x65, 0x73, 0x74, 0x00, 0x00,
    0x0a, 0x09, 0x01, 0x07, 0x00,
    0x20, 0x00, 0x20, 0x01, opcode, 0x0b,
  ]);
  const frontend = new WasmFrontend();
  const image = await frontend.open(wasmBytes);
  const methods = [];
  for await (const m of frontend.enumerateMethods(image)) methods.push(m);
  const decoded = await frontend.decodeMethod(methods[0], { image });
  const validation = await frontend.validateMethod(decoded);
  const lifted = await frontend.liftMethod(decoded, validation);
  const bridged = lowerVMEffectsToSemanticIr(lifted);
  return { bridged, node: bridged.semanticIr.nodes.find((n) => n.kind === 'binary') };
}

test('#7943 wasm i32.add carries the canonical binary operator', async () => {
  const { node } = await wasmBinaryNode(0x6a);
  assert.ok(node, 'binary node exists');
  assert.equal(node.operator, 'add');
  assert.equal(node.completeness, 'complete');
});

test('#7943 wasm add and sub are canonically distinguishable through the v1 projection', async () => {
  const add = await wasmBinaryNode(0x6a);
  const sub = await wasmBinaryNode(0x6b);
  const projected = (bridged, node) => {
    const legacy = projectSemanticIrV2ToLegacyV1(bridged.semanticIr, { cfg: bridged.cfg, ssa: bridged.ssa });
    return legacy.instructions.find((i) => i.semanticNodeId === node.id);
  };
  const addInst = projected(add.bridged, add.node);
  const subInst = projected(sub.bridged, sub.node);
  assert.equal(addInst.sub, 'add');
  assert.equal(subInst.sub, 'sub');
  assert.notEqual(addInst.sub, subInst.sub);
});

test('#7943 cil binary mnemonics carry the operator matching the kind classifier', () => {
  const expectations = [
    [0x58, 'add'], [0x59, 'sub'], [0x5a, 'mul'], [0x5f, 'and'],
    [0x60, 'or'], [0x61, 'xor'], [0x62, 'shl'], [0x63, 'shr'], [0x5d, 'rem'],
  ];
  for (const [opcode, expected] of expectations) {
    const node = cilBinaryNode(opcode);
    assert.ok(node, `binary node exists for opcode 0x${opcode.toString(16)}`);
    assert.equal(node.operator, expected, `opcode 0x${opcode.toString(16)} operator`);
    assert.equal(node.completeness, 'complete');
  }
});

test('#7943 cil div keeps its operator while main #7937 fails closed on exception authority', () => {
  // #7937 (merged on main after this branch was cut) makes the CIL lifter
  // fail closed on integral `div`: without typed operand-stack authority the
  // integral-vs-floating exception contract cannot be resolved losslessly.
  // The node stays `partial` with the unresolved-exception-authority unknown,
  // and — the #7943 contract — the canonical `operator` is still written.
  const node = cilBinaryNode(0x5b);
  assert.ok(node, 'binary node exists for opcode 0x5b (div)');
  assert.equal(node.operator, 'div');
  assert.equal(node.completeness, 'partial');
  assert.ok(node.unknown, 'div node carries the fail-closed unknown');
  assert.equal(node.unknown.reason, 'cil-div-exception-authority-unresolved');
});

// #7943 review blocker: `i32.div_s`/`i32.div_u`, `i32.rem_s`/`i32.rem_u` and
// `i32.shr_s`/`i32.shr_u` are semantically distinct exact operations — the
// review's counterexamples are `0xffffffff / 2` => 0 signed but 2147483647
// unsigned, and `0x80000000 >> 1` => 0xc0000000 arithmetic but 0x40000000
// logical — so the bridge must not collapse either pair into one complete
// `div`/`rem`/`shr` operator without signedness authority.
test('#7943 wasm signed/unsigned binary variants stay canonically distinguishable', async () => {
  const pairs = [
    [0x6d, 0x6e, 'div-s', 'div-u'],
    [0x6f, 0x70, 'rem-s', 'rem-u'],
    [0x75, 0x76, 'shr-s', 'shr-u'],
  ];
  for (const [signedOpcode, unsignedOpcode, signedOperator, unsignedOperator] of pairs) {
    const signed = await wasmBinaryNode(signedOpcode);
    const unsigned = await wasmBinaryNode(unsignedOpcode);
    assert.ok(signed.node, `binary node exists for opcode 0x${signedOpcode.toString(16)}`);
    assert.ok(unsigned.node, `binary node exists for opcode 0x${unsignedOpcode.toString(16)}`);
    assert.equal(signed.node.operator, signedOperator);
    assert.equal(unsigned.node.operator, unsignedOperator);
    assert.notEqual(signed.node.operator, unsigned.node.operator);
    assert.equal(signed.node.attributes.signed, true, `opcode 0x${signedOpcode.toString(16)} signed attribute`);
    assert.equal(unsigned.node.attributes.signed, false, `opcode 0x${unsignedOpcode.toString(16)} signed attribute`);
    assert.equal(signed.node.completeness, 'complete');
    assert.equal(unsigned.node.completeness, 'complete');
  }
});

test('#7943 wasm signed/unsigned binary variants project distinct v1 sub spellings', async () => {
  const v1Sub = async (opcode) => {
    const { bridged, node } = await wasmBinaryNode(opcode);
    const legacy = projectSemanticIrV2ToLegacyV1(bridged.semanticIr, { cfg: bridged.cfg, ssa: bridged.ssa });
    return legacy.instructions.find((i) => i.semanticNodeId === node.id)?.sub ?? null;
  };
  assert.equal(await v1Sub(0x6d), 'div-s');
  assert.equal(await v1Sub(0x6e), 'div-u');
  assert.equal(await v1Sub(0x6f), 'rem-s');
  assert.equal(await v1Sub(0x70), 'rem-u');
  assert.equal(await v1Sub(0x75), 'shr-s');
  assert.equal(await v1Sub(0x76), 'shr-u');
});

test('#7943 non-suffixed binary mnemonics keep their bare operator spelling', () => {
  // CIL `shr` (0x63) is the arithmetic shift itself and `rem` (0x5d) has no
  // signedness suffix in the lifted mnemonic: neither may gain a fabricated
  // `-s`/`-u` operator spelling.
  assert.equal(cilBinaryNode(0x63).operator, 'shr');
  assert.equal(cilBinaryNode(0x5d).operator, 'rem');
  assert.equal(cilBinaryNode(0x62).operator, 'shl');
  assert.deepEqual(cilBinaryNode(0x63).attributes, {});
});
